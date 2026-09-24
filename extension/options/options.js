const api = globalThis.browser ?? globalThis.chrome;
const { FIELDS } = globalThis.JAF_SCHEMA;

// Derived-only fields are computed from others and not edited directly.
const HIDDEN = new Set(["full_name", "graduation_date"]);
const DEFAULT_SETTINGS = { useJev: true, model: "jev-latest", minConfidence: 0.75, overwrite: false, apiKey: "", fillWithoutClicking: false, showButton: true, learn: true };

let state = { profile: {}, customAnswers: [], files: {}, workAuth: [], settings: { ...DEFAULT_SETTINGS } };
const $ = (sel, root = document) => root.querySelector(sel);

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ------------------------------------------------------------------ persistence

let saveTimer;
function save(immediate = false) {
  clearTimeout(saveTimer);
  const run = async () => {
    await api.storage.local.set(state);
    const el = $("#saved");
    el.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  };
  if (immediate) return run();
  $("#saved").textContent = "Saving…";
  saveTimer = setTimeout(run, 300);
}

async function load() {
  const data = await api.storage.local.get(["profile", "customAnswers", "files", "settings", "workAuth"]);
  state = fromStored(data);
}

function fromStored(data) {
  // "autoRun" (fill on load) was the old default-on setting; it's replaced by the opt-in
  // fillWithoutClicking, so drop the stale value.
  if (data.settings) delete data.settings.autoRun;
  return {
    profile: data.profile || {},
    customAnswers: data.customAnswers || [],
    files: data.files || {},
    workAuth: data.workAuth || [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
  };
}

// Learned answers arrive from the background while this page is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.customAnswers) return;
  const incoming = changes.customAnswers.newValue || [];
  if (JSON.stringify(incoming) === JSON.stringify(state.customAnswers)) return;
  state.customAnswers = incoming;
  if (!document.activeElement?.closest?.("#custom-list")) renderCustom();
});

// ------------------------------------------------------------------ profile sections

function renderProfile() {
  const sections = new Map();
  for (const f of FIELDS) {
    if (f.input === "file" || f.hidden || HIDDEN.has(f.key)) continue;
    if (!sections.has(f.section)) sections.set(f.section, []);
    sections.get(f.section).push(f);
  }
  const container = $("#sections");
  container.innerHTML = "";
  for (const [name, fields] of sections) {
    const card = document.createElement("section");
    card.className = "card";
    card.id = `section-${slug(name)}`;
    card.innerHTML = `<h2></h2>${name === "Voluntary self-identification" ? '<p class="muted">Used for optional EEO questions. Defaults to declining.</p>' : ""}<div class="grid"></div>`;
    $("h2", card).textContent = name;
    const grid = $(".grid", card);
    for (const f of fields) grid.appendChild(renderField(f));
    container.appendChild(card);
  }

  const toc = $("#toc");
  toc.innerHTML = "";
  const entries = [...sections.keys()].map((n) => [n, `section-${slug(n)}`])
    .concat([["Work authorization", "section-work-authorization"], ["Documents", "section-documents"], ["Saved answers", "section-saved-answers"], ["Settings", "section-jev"]]);
  for (const [label, id] of entries) {
    const a = document.createElement("a");
    a.href = `#${id}`;
    a.textContent = label === "Voluntary self-identification" ? "Self-identification" : label;
    toc.appendChild(a);
  }
}

function renderField(f) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const title = document.createElement("span");
  title.textContent = f.label;
  wrap.appendChild(title);

  let control;
  if (f.input === "select") {
    control = document.createElement("select");
    const blank = new Option(f.defaultValue ? `Default: ${f.defaultValue}` : "—", "");
    control.appendChild(blank);
    for (const o of f.options) control.appendChild(new Option(o, o));
  } else {
    control = document.createElement("input");
    control.type = f.input === "number" ? "text" : f.input || "text";
    if (f.input === "number") control.inputMode = "decimal";
    if (f.placeholder) control.placeholder = f.placeholder;
  }
  control.id = `p-${f.key}`;
  control.value = state.profile[f.key] ?? "";
  control.addEventListener("input", () => {
    state.profile[f.key] = control.value.trim();
    save();
  });
  wrap.appendChild(control);
  return wrap;
}

// ------------------------------------------------------------------ saved answers

function renderCustom() {
  const list = $("#custom-list");
  list.innerHTML = "";
  state.customAnswers.forEach((item, i) => {
    const row = $("#custom-row").content.firstElementChild.cloneNode(true);
    const q = $(".q", row);
    const a = $(".a", row);
    q.value = item.question || "";
    a.value = item.answer || "";
    q.addEventListener("input", () => { state.customAnswers[i].question = q.value; save(); });
    a.addEventListener("input", () => { state.customAnswers[i].answer = a.value; save(); });
    $(".remove", row).addEventListener("click", () => {
      state.customAnswers.splice(i, 1);
      renderCustom();
      save();
    });
    if (item.learned) {
      const when = item.learnedAt ? new Date(item.learnedAt).toLocaleDateString() : "";
      $(".origin", row).innerHTML = '<span class="tag">learned</span> ';
      $(".origin", row).append(`${item.from ? `from ${item.from} ` : ""}${when ? `on ${when}` : ""}`);
    }
    list.appendChild(row);
  });
}

// ------------------------------------------------------------------ work authorization

function renderAuth() {
  const list = $("#auth-list");
  list.innerHTML = "";
  state.workAuth.forEach((item, i) => {
    const row = $("#auth-row").content.firstElementChild.cloneNode(true);
    const country = $(".country", row);
    const sp = $(".sponsorship", row);
    country.value = item.country || "";
    sp.value = item.sponsorship === "Yes" ? "Yes" : "No";
    country.addEventListener("input", () => { state.workAuth[i].country = country.value.trim(); save(); });
    sp.addEventListener("change", () => { state.workAuth[i].sponsorship = sp.value; save(); });
    $(".remove", row).addEventListener("click", () => {
      state.workAuth.splice(i, 1);
      renderAuth();
      save();
    });
    list.appendChild(row);
  });
}

$("#add-auth").addEventListener("click", () => {
  state.workAuth.push({ country: state.workAuth.length ? "" : state.profile.country || "United States", sponsorship: "No" });
  renderAuth();
  save();
  $("#auth-list .auth-row:last-child .country").focus();
});

$("#add-custom").addEventListener("click", () => {
  state.customAnswers.push({ question: "", answer: "" });
  renderCustom();
  $("#custom-list .custom-row:last-child .q").focus();
});

// ------------------------------------------------------------------ files

function formatSize(bytes) {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function renderFiles() {
  document.querySelectorAll(".file-row").forEach((row) => {
    const key = row.dataset.file;
    const file = state.files[key];
    row.classList.toggle("has-file", Boolean(file));
    $(".file-name", row).textContent = file ? `${file.name} · ${formatSize(file.size || 0)}` : "No file";
    $(".remove", row).hidden = !file;
  });
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

document.querySelectorAll(".file-row").forEach((row) => {
  const key = row.dataset.file;
  $("input[type=file]", row).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 15e6) {
      alert("That file is over 15 MB. Most application forms reject files that large.");
      return;
    }
    state.files[key] = { name: file.name, type: file.type || "application/pdf", size: file.size, data: await readAsBase64(file) };
    e.target.value = "";
    renderFiles();
    save(true);
  });
  $(".remove", row).addEventListener("click", () => {
    delete state.files[key];
    renderFiles();
    save(true);
  });
});

// ------------------------------------------------------------------ settings

function renderSettings() {
  const s = state.settings;
  $("#apiKey").value = s.apiKey || "";
  $("#useJev").checked = Boolean(s.useJev);
  $("#showButton").checked = s.showButton !== false;
  $("#fillWithoutClicking").checked = Boolean(s.fillWithoutClicking);
  $("#learn").checked = s.learn !== false;
  $("#overwrite").checked = Boolean(s.overwrite);
  $("#minConfidence").value = s.minConfidence;
  $("#minConfidenceValue").textContent = Number(s.minConfidence).toFixed(2);
  $("#model").value = s.model || "";
}

$("#apiKey").addEventListener("input", (e) => { state.settings.apiKey = e.target.value.trim(); $("#key-status").textContent = ""; save(); });
$("#useJev").addEventListener("change", (e) => { state.settings.useJev = e.target.checked; save(); });
$("#showButton").addEventListener("change", (e) => { state.settings.showButton = e.target.checked; save(); });
$("#fillWithoutClicking").addEventListener("change", (e) => { state.settings.fillWithoutClicking = e.target.checked; save(); });
$("#learn").addEventListener("change", (e) => { state.settings.learn = e.target.checked; save(); });
$("#overwrite").addEventListener("change", (e) => { state.settings.overwrite = e.target.checked; save(); });
$("#model").addEventListener("input", (e) => { state.settings.model = e.target.value.trim() || "jev-latest"; save(); });
$("#minConfidence").addEventListener("input", (e) => {
  state.settings.minConfidence = Number(e.target.value);
  $("#minConfidenceValue").textContent = state.settings.minConfidence.toFixed(2);
  save();
});

$("#test-key").addEventListener("click", async () => {
  const status = $("#key-status");
  if (!state.settings.apiKey) { status.textContent = "Enter a key first."; return; }
  // Safari grants host access per site; the API rejects extension origins via CORS, so the
  // extension needs explicit access to api.typesafe.ai. Must run inside the click gesture.
  try {
    const granted = await api.permissions?.request?.({ origins: ["https://api.typesafe.ai/*"] });
    if (granted === false) { status.textContent = "Allow access to api.typesafe.ai to use Jev."; return; }
  } catch {}
  status.textContent = "Checking…";
  const res = await api.runtime.sendMessage({ type: "jaf:testKey", settings: state.settings });
  status.textContent = res?.ok ? `Key works. Models: ${res.models.join(", ") || "(none listed)"}` : `Didn't work: ${res?.error || "no response"}`;
});

// ------------------------------------------------------------------ backup

$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "job-autofill-profile.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("#import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state = fromStored(JSON.parse(await file.text()));
    await save(true);
    renderAll();
  } catch (err) {
    alert(`Couldn't import that file: ${err.message}`);
  }
  e.target.value = "";
});

function renderAll() {
  renderProfile();
  renderAuth();
  renderCustom();
  renderFiles();
  renderSettings();
}

load().then(renderAll);
