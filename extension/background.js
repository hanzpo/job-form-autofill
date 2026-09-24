// Orchestrates an autofill run: scan every frame → classify (Jev + heuristics) → fill.
// Also runs automatically when a content script reports an application form, and saves
// answers the applicant typed themselves ("learning") for future applications.
importScripts("shared/schema.js", "shared/values.js", "shared/classify.js");

const api = globalThis.browser ?? globalThis.chrome;
const { buildJevRequests, parseJevResponse, decide } = globalThis.JAF_CLASSIFY;
const { countryFromText, normalize, similarity } = globalThis.JAF_VALUES;

const DEFAULT_API_BASE = "https://api.typesafe.ai";
const DEFAULT_SETTINGS = { useJev: true, model: "jev-latest", minConfidence: 0.75, overwrite: false, fillWithoutClicking: false, showButton: true, learn: true };

async function loadData() {
  const data = await api.storage.local.get(["profile", "customAnswers", "files", "settings", "workAuth"]);
  return {
    profile: data.profile || {},
    customAnswers: data.customAnswers || [],
    files: data.files || {},
    workAuth: data.workAuth || [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
  };
}

function hasProfile(data) {
  return Object.values(data.profile).some((v) => String(v || "").trim()) || Boolean(data.files.resume);
}

// ------------------------------------------------------------------ TypeSafe

async function postJev(path, body, settings) {
  const base = (settings.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Couldn't reach TypeSafe. Allow the extension to access api.typesafe.ai (Profile → Test key).");
    }
    if ([429, 503, 529].includes(response.status) && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      let detail = "";
      try { detail = JSON.stringify(await response.json()).slice(0, 300); } catch {}
      throw new Error(`TypeSafe HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  }
}

async function classifyWithJev(fields, data, page, job) {
  const requests = buildJevRequests(fields, data, page, job);
  const answers = {};
  let usage = 0;
  const results = await Promise.allSettled(requests.map((req) => postJev("/v1/systemone", req.body, data.settings)));
  const errors = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      Object.assign(answers, parseJevResponse(requests[i], result.value));
      usage += result.value?.usage?.input_tokens || 0;
    } else {
      errors.push(result.reason?.message || String(result.reason));
    }
  });
  return { answers, usage, requests: requests.length, errors };
}

// ------------------------------------------------------------------ frames

async function framesFor(tabId) {
  try {
    const frames = await api.webNavigation.getAllFrames({ tabId });
    if (frames?.length) return frames.map((f) => f.frameId);
  } catch {}
  return [0];
}

async function sendToFrame(tabId, frameId, message) {
  try {
    return await api.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return null; // Frame without our content script (about:blank, restricted pages…).
  }
}

async function scanFrames(tabId) {
  const frameIds = await framesFor(tabId);
  return Promise.all(frameIds.map((frameId) =>
    sendToFrame(tabId, frameId, { type: "jaf:scan" }).then((scan) => ({ frameId, scan }))));
}

async function injectContentScript(tabId) {
  try {
    await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch {}
}

/** Combine per-frame job info: top frame first, embedded ATS frames fill the gaps. */
function mergeJob(scans, tab) {
  const jobs = scans.map((s) => s.scan?.job).filter(Boolean).sort((a, b) => Number(b.top) - Number(a.top));
  const job = { title: "", company: "", location: "" };
  for (const j of jobs) {
    for (const k of ["title", "company", "location"]) if (!job[k] && j[k]) job[k] = j[k];
  }
  if (!job.title) job.title = tab.title || "";
  job.country = countryFromText(job.location) || countryFromText(job.title) || null;
  return job;
}

// ------------------------------------------------------------------ autofill

// One run per tab at a time: concurrent runs would interleave dropdown clicks.
const tabLocks = new Map();

function autofillTab(tabId, opts = {}) {
  const previous = tabLocks.get(tabId) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => autofillTabUnlocked(tabId, opts));
  tabLocks.set(tabId, run);
  run.finally(() => { if (tabLocks.get(tabId) === run) tabLocks.delete(tabId); }).catch(() => {});
  return run;
}

async function autofillTabUnlocked(tabId, { auto = false } = {}) {
  const started = Date.now();
  const data = await loadData();
  const tab = await api.tabs.get(tabId);
  if (auto && !hasProfile(data)) return { ok: false, error: "No profile yet." };

  let scans = await scanFrames(tabId);
  if (!scans.some((s) => s.scan)) {
    // Tabs opened before the extension was installed/updated have no (live) content script.
    await injectContentScript(tabId);
    scans = await scanFrames(tabId);
  }
  if (!scans.some((s) => s.scan)) {
    return { ok: false, error: "Couldn't reach this page. Reload it, and make sure the extension is allowed on this site (Safari → Settings → Extensions)." };
  }

  const fields = [];
  for (const { frameId, scan } of scans) {
    for (const field of scan?.fields || []) fields.push({ ...field, frameId, uid: `${frameId}_${field.id}` });
  }
  const job = mergeJob(scans, tab);

  let jev = null;
  const useJev = data.settings.useJev && data.settings.apiKey;
  const pending = fields.filter((f) => !f.hasValue || data.settings.overwrite);
  if (useJev && pending.length) {
    try {
      jev = await classifyWithJev(pending, data, { title: tab.title, url: tab.url }, job);
    } catch (e) {
      jev = { answers: null, errors: [e.message] };
    }
  }

  const decisions = decide(fields, data, jev?.answers && Object.keys(jev.answers).length ? jev.answers : null, job);
  const byUid = Object.fromEntries(fields.map((f) => [f.uid, f]));

  const perFrame = new Map();
  for (const d of decisions) {
    const field = byUid[d.uid];
    if (!perFrame.has(field.frameId)) perFrame.set(field.frameId, []);
    const item = {
      id: field.id, status: d.status, reason: d.reason, key: d.key, keyLabel: d.keyLabel,
      confidence: d.confidence, plan: d.plan, required: field.required,
    };
    if (d.plan?.action === "file") item.file = data.files[d.plan.fileKey];
    perFrame.get(field.frameId).push(item);
  }
  const fillResults = {};
  await Promise.all([...perFrame].map(async ([frameId, items]) => {
    const res = await sendToFrame(tabId, frameId, { type: "jaf:fill", items });
    for (const r of res?.results || []) fillResults[`${frameId}_${r.id}`] = r;
  }));

  const rows = decisions.map((d) => {
    const field = byUid[d.uid];
    const fr = fillResults[d.uid];
    let status = d.status;
    if (status === "fill") status = fr?.ok ? "filled" : "failed";
    return {
      label: field.label || field.placeholder || field.name || "(unlabeled field)",
      kind: field.kind,
      required: field.required,
      status,
      key: d.keyLabel || "",
      value: d.plan?.display ?? "",
      confidence: d.confidence ?? null,
      source: d.source || "",
      reason: fr && !fr.ok ? fr.error : d.reason || "",
    };
  });

  const result = {
    ok: true,
    auto,
    at: Date.now(),
    ms: Date.now() - started,
    job,
    classifier: useJev ? (jev?.answers && Object.keys(jev.answers).length ? "jev" : "heuristic (Jev failed)") : "heuristic",
    jevErrors: jev?.errors || [],
    jevRequests: jev?.requests || 0,
    jevTokens: jev?.usage || 0,
    rows,
  };

  const filled = rows.filter((r) => r.status === "filled").length;
  const check = rows.filter((r) => r.status === "uncertain" || r.status === "failed").length;
  const needs = rows.filter((r) => r.status === "skip" && r.required && r.reason !== "already filled").length;
  if (filled || check || needs) {
    const parts = [`Autofilled ${filled} field${filled === 1 ? "" : "s"}`];
    if (check) parts.push(`${check} to double-check (amber)`);
    if (needs) parts.push(`${needs} need${needs === 1 ? "s" : ""} you (blue)`);
    sendToFrame(tabId, 0, { type: "jaf:toast", text: `${parts.join(" · ")}.`, ms: needs || check ? 6000 : 4000 });
  }
  await saveLastResult(tabId, result);
  return result;
}

// ------------------------------------------------------------------ last result (popup)

const lastResults = new Map();

async function saveLastResult(tabId, result) {
  lastResults.set(tabId, result);
  try { await api.storage.session?.set({ [`last_${tabId}`]: result }); } catch {}
}

async function getLastResult(tabId) {
  if (lastResults.has(tabId)) return lastResults.get(tabId);
  try {
    const stored = await api.storage.session?.get(`last_${tabId}`);
    return stored?.[`last_${tabId}`] || null;
  } catch {
    return null;
  }
}

api.tabs.onRemoved?.addListener((tabId) => {
  lastResults.delete(tabId);
  api.storage.session?.remove(`last_${tabId}`).catch?.(() => {});
});

// ------------------------------------------------------------------ auto-run queue

const runs = new Map(); // tabId → {running: Promise, again: boolean}

function autoTrigger(tabId) {
  const state = runs.get(tabId);
  if (state) { state.again = true; return; }
  const entry = { again: false };
  runs.set(tabId, entry);
  (async () => {
    try {
      do {
        entry.again = false;
        await new Promise((r) => setTimeout(r, 300)); // let the new step finish rendering
        await autofillTab(tabId, { auto: true }).catch(() => {});
      } while (entry.again);
    } finally {
      runs.delete(tabId);
    }
  })();
}

// ------------------------------------------------------------------ learning

async function learn(items, job) {
  const { customAnswers = [], settings = {} } = await api.storage.local.get(["customAnswers", "settings"]);
  if (settings.learn === false) return 0;
  const company = normalize(job?.company || "");
  let host = "";
  try { host = new URL(job?.url || "").hostname; } catch {}
  let changed = 0;
  for (const item of items || []) {
    const q = String(item.question || "").trim();
    const a = String(item.answer || "").trim();
    if (!q || !a) continue;
    // Company-specific questions/answers ("Why Acme?", "Have you worked at Acme?") don't generalize.
    if (company.length >= 3 && (normalize(q).includes(company) || normalize(a).includes(company))) continue;
    const i = customAnswers.findIndex((c) => normalize(c.question) === normalize(q) || similarity(c.question, q) >= 0.9);
    const entry = { question: q, answer: a, learned: true, learnedAt: Date.now(), from: host };
    if (i >= 0) {
      if (customAnswers[i].answer === a) continue;
      customAnswers[i] = { ...customAnswers[i], answer: a, learned: true, learnedAt: entry.learnedAt, from: host };
    } else {
      customAnswers.push(entry);
    }
    changed++;
  }
  if (changed) await api.storage.local.set({ customAnswers });
  return changed;
}

// ------------------------------------------------------------------ messages

async function testKey(settings) {
  const res = await postJev("/v1/models", null, settings);
  const list = Array.isArray(res) ? res : res.models || res.data || [];
  return list.map((m) => m.name || m.id || String(m));
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "jaf:autofill":
      autofillTab(message.tabId).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case "jaf:autoTrigger":
      if (sender.tab?.id != null) autoTrigger(sender.tab.id);
      return false;
    case "jaf:formDetected":
      if (sender.tab?.id != null) sendToFrame(sender.tab.id, 0, { type: "jaf:showButton" });
      return false;
    case "jaf:fillNow":
      if (sender.tab?.id == null) return false;
      autofillTab(sender.tab.id, { auto: true }).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case "jaf:learn":
      learn(message.items, message.job).then((n) => sendResponse({ ok: true, learned: n }), (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case "jaf:lastResult":
      getLastResult(message.tabId).then(sendResponse);
      return true;
    case "jaf:testKey":
      testKey(message.settings).then(
        (models) => sendResponse({ ok: true, models }),
        (e) => sendResponse({ ok: false, error: e.message }),
      );
      return true;
    default:
      return false;
  }
});

api.commands?.onCommand.addListener(async (command) => {
  if (command !== "autofill") return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await autofillTab(tab.id);
});

// Exposed for tests (service worker global).
globalThis.autofillTab = autofillTab;
globalThis.getLastResult = getLastResult;
