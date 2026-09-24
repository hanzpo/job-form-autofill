const api = globalThis.browser ?? globalThis.chrome;
const $ = (sel) => document.querySelector(sel);

function openOptions() {
  api.runtime.openOptionsPage();
  window.close();
}
$("#settings").addEventListener("click", openOptions);
$("#setup-link").addEventListener("click", openOptions);

async function init() {
  const { profile = {}, settings = {}, files = {} } = await api.storage.local.get(["profile", "settings", "files"]);
  const hasProfile = Object.values(profile).some((v) => String(v || "").trim());
  $("#setup").hidden = hasProfile || Boolean(files.resume);
  const jev = (settings.useJev ?? true) && settings.apiKey;
  const auto = settings.fillWithoutClicking ? "fills automatically" : settings.showButton === false ? "manual" : "in-page button";
  $("#mode").textContent = `${jev ? "Jev" : "Pattern matching (add a TypeSafe key for Jev)"} · ${auto}`;

  // Show what the automatic run already did on this tab.
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const last = tab && await api.runtime.sendMessage({ type: "jaf:lastResult", tabId: tab.id }).catch(() => null);
  if (last?.ok) {
    render(last);
    $("#run").textContent = "Autofill again";
  }
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function pct(c) {
  return c == null ? "" : `${Math.round(c * 100)}%`;
}

function itemEl(row, { showValue = true } = {}) {
  const el = document.createElement("div");
  el.className = "item";
  const label = document.createElement("div");
  label.className = "label";
  label.title = row.label;
  label.textContent = row.label;
  if (row.required) {
    const star = document.createElement("span");
    star.className = "required";
    star.textContent = " *";
    label.appendChild(star);
  }
  const meta = document.createElement("div");
  meta.className = "muted";
  // Heuristic confidences are fixed priors, not measurements: only show Jev's.
  const isJev = row.source.startsWith("jev");
  meta.textContent = [isJev ? row.source.replace("jev+heuristic", "jev ✓ pattern") : row.source && "pattern", isJev && pct(row.confidence)]
    .filter(Boolean).join(" · ");
  el.append(label, meta);
  const detail = row.value && showValue
    ? `${row.key ? `${row.key}: ` : ""}<b></b>`
    : row.reason || row.key;
  if (detail) {
    const value = document.createElement("div");
    value.className = "value";
    if (row.value && showValue) {
      value.innerHTML = detail;
      value.querySelector("b").textContent = row.value;
    } else {
      value.textContent = detail;
    }
    el.appendChild(value);
  }
  return el;
}

function group(title, rows, { collapsed = false, ...opts } = {}) {
  if (!rows.length) return null;
  const g = document.createElement(collapsed ? "details" : "section");
  g.className = "group";
  const h = document.createElement(collapsed ? "summary" : "h2");
  h.textContent = `${title} (${rows.length})`;
  g.appendChild(h);
  const list = document.createElement("div");
  list.className = "rows";
  rows.forEach((r) => list.appendChild(itemEl(r, opts)));
  g.appendChild(list);
  return g;
}

function render(result) {
  const results = $("#results");
  results.innerHTML = "";
  const status = $("#status");
  status.classList.toggle("error", !result.ok);
  if (!result.ok) {
    status.textContent = result.error || "Something went wrong.";
    return;
  }
  const rows = result.rows;
  const filled = rows.filter((r) => r.status === "filled");
  const uncertain = rows.filter((r) => r.status === "uncertain");
  const failed = rows.filter((r) => r.status === "failed");
  const needsYou = rows.filter((r) => r.status === "skip" && r.required && r.reason !== "already filled");
  const skipped = rows.filter((r) => r.status === "skip" && !needsYou.includes(r));

  const parts = [`Filled ${filled.length} of ${rows.length} fields in ${(result.ms / 1000).toFixed(1)}s`];
  if (result.auto && result.at) parts[0] = `Filled ${ago(result.at)}: ${filled.length} of ${rows.length} fields`;
  if (result.job?.company) parts.push(`${result.job.company}${result.job.country ? ` (${result.job.country})` : ""}`);
  if (result.classifier !== "heuristic") parts.push(result.classifier === "jev" ? `Jev, ${result.jevRequests} request${result.jevRequests === 1 ? "" : "s"}` : result.classifier);
  status.textContent = rows.length ? parts.join(" · ") : "No form fields found on this page.";
  if (result.jevErrors?.length) {
    status.textContent += ` · Jev error: ${result.jevErrors[0]}`;
    status.classList.add("error");
  }

  [
    group("Double-check", uncertain),
    group("Couldn't fill", failed),
    group("Needs you", needsYou, { showValue: false }),
    group("Filled", filled),
    group("Skipped", skipped, { collapsed: true, showValue: false }),
  ].filter(Boolean).forEach((g) => results.appendChild(g));
}

$("#run").addEventListener("click", async () => {
  const button = $("#run");
  button.disabled = true;
  button.textContent = "Reading the form…";
  $("#status").textContent = "";
  $("#status").classList.remove("error");
  $("#results").innerHTML = "";
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const result = await api.runtime.sendMessage({ type: "jaf:autofill", tabId: tab.id });
    render(result || { ok: false, error: "No response from the extension." });
  } catch (e) {
    render({ ok: false, error: e.message });
  } finally {
    button.disabled = false;
    button.textContent = "Autofill again";
  }
});

init();
