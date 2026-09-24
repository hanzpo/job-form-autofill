// Runs in every frame. Scans form controls into plain descriptors and applies fill plans.
// Never submits forms or clicks anything other than the control being filled.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // A copy left over from before an extension update can't talk to the new background;
  // only skip loading when the existing copy is still connected.
  if (window.__jafLoaded && window.__jafAlive?.()) return;
  window.__jafLoaded = true;
  window.__jafAlive = () => {
    try { return Boolean(api.runtime?.id); } catch { return false; }
  };

  const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "password", "range", "color", "search"]);
  const CONTROL_SELECTOR = "input, textarea, select, [role=combobox], button[aria-haspopup=listbox], [role=radio]";
  const PLACEHOLDER_OPTION = /^\s*(select|choose|please select|pick|--|—|-)\b|^\s*$/i;

  let nextId = 1;
  const idOf = new WeakMap();
  /** id → {kind, el, options: [{label, value, el?, index?}]} from the latest scan. */
  let registry = new Map();
  /** id → field descriptor from the latest scan. */
  let fieldsById = new Map();
  /** Anchor element → {initial, display, key, status}: survives rescans (multi-step forms). */
  const memory = new WeakMap();
  let busy = false;

  // ------------------------------------------------------------------ helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clean(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\s*[*✱]\s*$/, "")
      .replace(/\s*\(?\s*required\s*\)?\s*$/i, "")
      .trim();
  }

  function idFor(el) {
    if (!idOf.has(el)) idOf.set(el, String(nextId++));
    return idOf.get(el);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  }

  /** All elements matching selector, descending into open shadow roots. */
  function deepQueryAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.shadowRoot) out.push(...deepQueryAll(selector, node.shadowRoot));
    }
    return out;
  }

  /** Text of an element, ignoring form controls, option lists, and hidden bits. */
  function textWithoutControls(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, option, button, script, style, svg, [role=listbox], [role=option], [aria-hidden=true]")
      .forEach((n) => n.remove());
    return clean(clone.textContent);
  }

  function textOfIds(ids, doc) {
    return clean(String(ids || "").split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join(" "));
  }

  function ownLabel(el) {
    const doc = el.ownerDocument;
    const labelled = textOfIds(el.getAttribute("aria-labelledby"), doc);
    if (labelled) return labelled;
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const labels = el.labels ? [...el.labels] : [];
    const fromLabels = clean(labels.map(textWithoutControls).join(" "));
    if (fromLabels) return fromLabels;
    return "";
  }

  /** Nearby text for controls without a proper <label>: walk up while this is the only control. */
  function contextualLabel(el, stopAt) {
    let node = el;
    for (let depth = 0; depth < 6 && node.parentElement; depth++) {
      const parent = node.parentElement;
      if (parent === stopAt || parent === document.body || parent.tagName === "FORM") break;
      // Preceding siblings of the current node often hold the question text.
      let sib = node.previousElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.previousElementSibling) {
        if (sib.matches("input, select, textarea") || sib.querySelector("input, select, textarea")) break;
        const t = textWithoutControls(sib);
        if (t && t.length <= 300) return t;
      }
      const controls = parent.querySelectorAll("input:not([type=hidden]), select, textarea");
      if (controls.length > 1) break;
      node = parent;
    }
    return "";
  }

  function describedBy(el) {
    const t = textOfIds(el.getAttribute("aria-describedby"), el.ownerDocument);
    return t.length > 200 ? t.slice(0, 200) + "…" : t;
  }

  function isRequired(el, label) {
    return Boolean(el.required || el.getAttribute("aria-required") === "true" || /[*✱]\s*$/.test(label || ""));
  }

  function sectionHeadingFinder() {
    const headings = deepQueryAll("h1, h2, h3, h4, legend, [role=heading]")
      .filter((h) => clean(h.textContent).length > 0 && clean(h.textContent).length < 120);
    return (el) => {
      let found = "";
      for (const h of headings) {
        if (h.contains(el)) continue;
        if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = clean(h.textContent);
        else break;
      }
      return found;
    };
  }

  // ------------------------------------------------------------------ scanning

  function fieldBase(el, label, sectionOf) {
    return {
      id: idFor(el),
      label,
      name: el.getAttribute("name") || "",
      htmlId: el.id || "",
      placeholder: clean(el.getAttribute("placeholder")),
      autocomplete: el.getAttribute("autocomplete") || "",
      section: sectionOf(el),
      hint: describedBy(el),
      required: isRequired(el, label),
      ...(el.maxLength > 0 ? { maxLength: el.maxLength } : {}),
    };
  }

  /** Phone inputs that start out holding only a dial code ("+1") are effectively empty. */
  function isDialCodeOnly(el) {
    return /^\+\d{1,4}[\s-]*$/.test(el.value || "");
  }

  function textHasValue(el) {
    return el.value.trim() !== "" && !isDialCodeOnly(el);
  }

  function labelFor(el) {
    const own = ownLabel(el);
    if (own) return own;
    const ctx = contextualLabel(el);
    if (ctx) return ctx;
    return clean(el.getAttribute("title") || el.getAttribute("placeholder") || "");
  }

  function selectOptions(select) {
    const options = [];
    [...select.options].forEach((o, index) => {
      const label = clean(o.textContent);
      if (o.disabled || (PLACEHOLDER_OPTION.test(label) && !o.value) || (index === 0 && !o.value)) return;
      options.push({ label, value: o.value, index });
    });
    return options;
  }

  function selectHasValue(select) {
    const o = select.options[select.selectedIndex];
    return Boolean(o && o.value && !PLACEHOLDER_OPTION.test(clean(o.textContent)));
  }

  function groupQuestion(members, container) {
    if (container?.tagName === "FIELDSET") {
      const legend = container.querySelector(":scope > legend");
      if (legend) return clean(legend.textContent);
    }
    const labelled = container && (textOfIds(container.getAttribute("aria-labelledby"), container.ownerDocument)
      || clean(container.getAttribute("aria-label")));
    if (labelled) return labelled;
    // Text around the group, minus the option labels themselves.
    const optionTexts = new Set(members.map((m) => m.label));
    let node = container;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      let sib = node.previousElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.previousElementSibling) {
        if (sib.querySelector("input, select, textarea")) break;
        const t = textWithoutControls(sib);
        if (t && !optionTexts.has(t) && t.length <= 400) return t;
      }
      const own = textWithoutControls(node);
      let remaining = own;
      for (const o of optionTexts) remaining = remaining.replace(o, " ");
      remaining = clean(remaining);
      if (remaining.length >= 3 && remaining.length <= 400) return remaining;
    }
    return "";
  }

  function commonAncestor(els) {
    let anc = els[0].parentElement;
    while (anc && !els.every((e) => anc.contains(e))) anc = anc.parentElement;
    return anc;
  }

  function optionLabelForChoice(el) {
    const own = ownLabel(el);
    if (own) return own;
    const next = el.nextSibling?.textContent || el.nextElementSibling?.textContent;
    if (clean(next)) return clean(next);
    return clean(el.parentElement?.textContent) || el.value || "";
  }

  function comboboxTarget(el) {
    // ARIA 1.1 pattern: role=combobox on a wrapper that contains the text input.
    if (el.matches("input, button")) return el;
    return el.querySelector("input:not([type=hidden])") || el;
  }

  function comboboxValue(el) {
    if (el.matches("input") && el.value.trim()) return el.value.trim();
    if (el.matches("button")) {
      const t = clean(el.textContent);
      return t && !PLACEHOLDER_OPTION.test(t) ? t : "";
    }
    // react-select and similar show the current value in a sibling element.
    let node = el;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      const single = node.querySelector("[class*=single-value], [class*=singleValue], [class*=multi-value], [class*=multiValue]");
      if (single && clean(single.textContent)) return clean(single.textContent);
    }
    return "";
  }

  function comboboxHasValue(el) {
    return Boolean(comboboxValue(el));
  }

  function visibleOptions(root) {
    const scope = root || document;
    let found = [...scope.querySelectorAll("[role=option]")].filter(isVisible);
    if (!found.length && !root) {
      found = [...document.querySelectorAll("[class*=menu] [class*=option]")].filter(isVisible);
    }
    return found;
  }

  function listboxFor(target) {
    const ids = `${target.getAttribute("aria-controls") || ""} ${target.getAttribute("aria-owns") || ""}`.trim();
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      const lb = target.ownerDocument.getElementById(id);
      if (lb && isVisible(lb)) return lb;
    }
    return null;
  }

  async function openCombobox(target) {
    const before = new Set(visibleOptions());
    target.focus();
    if (target.matches("button")) {
      target.click();
    } else {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown", code: "ArrowDown", keyCode: 40 }));
    }
    return waitForOptions(target, before, 450);
  }

  async function waitForOptions(target, before, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(40);
      const lb = listboxFor(target);
      const opts = lb ? visibleOptions(lb) : visibleOptions().filter((o) => !before.has(o));
      if (opts.length) return opts;
    }
    return [];
  }

  function closeCombobox(target) {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", code: "Escape", keyCode: 27 }));
    if (target.matches("button") && target.getAttribute("aria-expanded") === "true") target.click();
    target.blur();
  }

  async function scan() {
    busy = true;
    try {
      return await scanInner();
    } finally {
      busy = false;
    }
  }

  async function scanInner() {
    registry = new Map();
    fieldsById = new Map();
    const sectionOf = sectionHeadingFinder();
    const fields = [];
    const radioGroups = new Map();
    const checkboxGroups = new Map();
    const comboboxes = [];
    const consumed = new Set();

    for (const el of deepQueryAll(CONTROL_SELECTOR)) {
      if (consumed.has(el)) continue;
      if (el.closest("[data-jaf-ui]")) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;

      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();

      if (el.getAttribute("role") === "radio" && tag !== "INPUT") {
        const group = el.closest("[role=radiogroup]") || el.parentElement;
        if (!radioGroups.has(group)) radioGroups.set(group, []);
        radioGroups.get(group).push(el);
        continue;
      }

      const isCombo = el.getAttribute("role") === "combobox" || (tag === "BUTTON" && el.getAttribute("aria-haspopup") === "listbox")
        || (tag === "INPUT" && el.getAttribute("aria-autocomplete") === "list");
      if (isCombo && tag !== "SELECT") {
        const target = comboboxTarget(el);
        consumed.add(target);
        if (!isVisible(el)) continue;
        comboboxes.push({ el, target });
        continue;
      }

      if (tag === "INPUT") {
        if (SKIP_INPUT_TYPES.has(type)) continue;
        if (type === "radio") {
          const key = el.name ? `${el.form ? idFor(el.form) : "doc"}:${el.name}` : el.closest("fieldset, [role=radiogroup]") || el.parentElement;
          if (!radioGroups.has(key)) radioGroups.set(key, []);
          radioGroups.get(key).push(el);
          continue;
        }
        if (type === "checkbox") {
          const key = el.name ? `${el.form ? idFor(el.form) : "doc"}:${el.name}` : el.closest("fieldset, [role=group]") || el;
          if (!checkboxGroups.has(key)) checkboxGroups.set(key, []);
          checkboxGroups.get(key).push(el);
          continue;
        }
        if (type === "file") {
          const label = labelFor(el) || textWithoutControls(el.closest("div, section, fieldset")?.parentElement);
          fields.push({ ...fieldBase(el, clean(label).slice(0, 200), sectionOf), kind: "file", hasValue: el.files?.length > 0 });
          registry.set(idFor(el), { kind: "file", el });
          continue;
        }
        if (el.readOnly || !isVisible(el)) continue;
        const label = labelFor(el);
        fields.push({ ...fieldBase(el, label, sectionOf), kind: "text", inputType: type || "text", hasValue: textHasValue(el) });
        registry.set(idFor(el), { kind: "text", el });
        continue;
      }

      if (tag === "TEXTAREA") {
        if (el.readOnly || !isVisible(el)) continue;
        const label = labelFor(el);
        fields.push({ ...fieldBase(el, label, sectionOf), kind: "textarea", hasValue: el.value.trim() !== "" });
        registry.set(idFor(el), { kind: "text", el });
        continue;
      }

      if (tag === "SELECT") {
        if (!isVisible(el)) continue;
        const options = selectOptions(el);
        if (!options.length) continue;
        const label = labelFor(el);
        fields.push({
          ...fieldBase(el, label, sectionOf), kind: "select", multiple: el.multiple,
          options: options.map(({ label: l, value }) => ({ label: l, value })), hasValue: selectHasValue(el),
        });
        registry.set(idFor(el), { kind: "select", el, options });
      }
    }

    for (const members of radioGroups.values()) {
      const visible = members.filter((m) => isVisible(m) || (m.labels && [...m.labels].some(isVisible)) || isVisible(m.parentElement));
      if (!visible.length) continue;
      const opts = visible.map((el) => ({ el, label: optionLabelForChoice(el), value: el.value || "" }));
      const container = members[0].closest("fieldset, [role=radiogroup]") || commonAncestor(visible);
      const label = groupQuestion(opts, container);
      const first = visible[0];
      const checked = (el) => el.checked || el.getAttribute("aria-checked") === "true";
      fields.push({
        ...fieldBase(first, label, sectionOf), kind: "radio", name: first.getAttribute("name") || "",
        required: visible.some((m) => m.required) || /[*✱]\s*$/.test(label),
        options: opts.map(({ label: l, value }) => ({ label: l, value })), hasValue: visible.some(checked),
      });
      registry.set(idFor(first), { kind: "radio", options: opts });
    }

    for (const members of checkboxGroups.values()) {
      if (members.length < 2) continue; // Single checkboxes are consents/acknowledgements: leave to the user.
      const visible = members.filter((m) => isVisible(m) || (m.labels && [...m.labels].some(isVisible)));
      if (visible.length < 2) continue;
      const opts = visible.map((el) => ({ el, label: optionLabelForChoice(el), value: el.value || "" }));
      const label = groupQuestion(opts, members[0].closest("fieldset, [role=group]") || commonAncestor(visible));
      fields.push({
        ...fieldBase(visible[0], label, sectionOf), kind: "checkboxes",
        options: opts.map(({ label: l, value }) => ({ label: l, value })), hasValue: visible.some((m) => m.checked),
      });
      registry.set(idFor(visible[0]), { kind: "checkboxes", options: opts });
    }

    // Comboboxes last: probing opens each dropdown briefly to read its options.
    const active = document.activeElement;
    for (const { el, target } of comboboxes) {
      const label = labelFor(el) || labelFor(target);
      const hasValue = comboboxHasValue(target);
      let options = [];
      if (!hasValue) {
        try {
          options = (await openCombobox(target)).map((o) => ({ label: clean(o.textContent), value: o.getAttribute("data-value") || "" }))
            .filter((o) => o.label && !/^no options\b|^loading\b/i.test(o.label));
        } finally {
          closeCombobox(target);
        }
      }
      fields.push({ ...fieldBase(target, label, sectionOf), kind: "combobox", options, hasValue });
      registry.set(idFor(target), { kind: "combobox", el: target, options });
    }
    if (active && active !== document.body && active.focus) active.focus();

    for (const f of fields) {
      fieldsById.set(f.id, f);
      const entry = registry.get(f.id);
      const anchor = anchorOf(entry);
      if (anchor && !memory.has(anchor)) memory.set(anchor, { initial: readCurrent(entry) });
    }
    return { fields, job: jobContext() };
  }

  function anchorOf(entry) {
    return entry?.el || entry?.options?.[0]?.el || null;
  }

  function readCurrent(entry) {
    switch (entry?.kind) {
      case "text": return isDialCodeOnly(entry.el) ? "" : entry.el.value.trim();
      case "select": return selectHasValue(entry.el) ? clean(entry.el.options[entry.el.selectedIndex].textContent) : "";
      case "radio": {
        const o = entry.options.find((x) => x.el.checked || x.el.getAttribute("aria-checked") === "true");
        return o ? o.label : "";
      }
      case "checkboxes": {
        const checked = entry.options.filter((x) => x.el.checked);
        return checked.length === 1 ? checked[0].label : "";
      }
      case "combobox": return comboboxValue(entry.el);
      default: return "";
    }
  }

  // ------------------------------------------------------------------ job context

  const ATS_BRANDS = /greenhouse|lever|workday|ashby|smartrecruiters|icims|jobvite|linkedin|indeed|glassdoor|bamboohr|workable|recruitee|teamtailor|breezy|careers? (page|site)/i;
  const COMPANY_FROM_URL = [
    /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_app\?(?:.*&)?for=)?([\w-]+)/,
    /jobs\.(?:eu\.)?lever\.co\/([\w-]+)/,
    /jobs\.ashbyhq\.com\/([\w.%-]+)/,
    /\/\/([\w-]+)\.wd\d+\.myworkdayjobs\.com/,
    /apply\.workable\.com\/([\w-]+)/,
    /jobs\.smartrecruiters\.com\/([\w-]+)/,
    /\/\/([\w-]+)\.(?:bamboohr\.com|recruitee\.com|teamtailor\.com|breezy\.hr|applytojob\.com)/,
    /jobs\.jobvite\.com\/([\w-]+)/,
    /careers-([\w-]+)\.icims\.com/,
  ];

  function prettySlug(slug) {
    return decodeURIComponent(slug).replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  /** Best-effort job title / company / location for the posting this form belongs to. */
  function jobContext() {
    const title = clean(document.title);
    const h1 = clean(document.querySelector("h1")?.textContent).slice(0, 150);
    let company = "";
    let jobTitle = h1;
    const at = /^(?:job application for |application for |apply for |apply to )?(.+?) at (.+?)(?:\s+[|–—-]\s+.*)?$/i.exec(title);
    if (at) { jobTitle = jobTitle || at[1]; company = at[2]; }
    const site = document.querySelector('meta[property="og:site_name"]')?.content || "";
    if (!company && site && !ATS_BRANDS.test(site)) company = clean(site);
    if (!company) {
      for (const re of COMPANY_FROM_URL) {
        const m = re.exec(location.href);
        if (m) { company = prettySlug(m[1]); break; }
      }
    }
    if (!company && /lever\.co/.test(location.hostname)) company = title.split(" - ")[0];
    let loc = "";
    for (const el of document.querySelectorAll('[class*="location" i], [data-qa*="location" i], [data-automation-id*="location" i], [id*="location" i]')) {
      if (el.closest("form, label") || el.matches("input, select, textarea") || el.querySelector("input, select, textarea")) continue;
      const t = clean(el.textContent);
      if (t.length >= 2 && t.length <= 100 && isVisible(el)) { loc = t.replace(/^location:?\s*/i, ""); break; }
    }
    return { title: jobTitle || title, company: clean(company), location: loc, url: location.href, top: window === window.top };
  }

  // ------------------------------------------------------------------ filling

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function insertText(el, value) {
    // Real editing command: frameworks that ignore synthetic events still see this.
    el.focus();
    try { el.select(); } catch {}
    try { return document.execCommand("insertText", false, value); } catch { return false; }
  }

  /** Keep a prefilled dial code ("+1") and type the national number after it. */
  function textValueFor(el, value, key) {
    if (!isDialCodeOnly(el) || !(key === "phone" || el.type === "tel")) return value;
    const prefix = el.value.trim();
    let digits = String(value).replace(/\D/g, "");
    const code = prefix.replace(/\D/g, "");
    if (digits.startsWith(code) && digits.length > 10) digits = digits.slice(code.length);
    return `${prefix} ${digits}`;
  }

  function sameText(actual, expected) {
    if (actual === expected) return true;
    const a = String(actual).replace(/\D/g, "");
    const b = String(expected).replace(/\D/g, "");
    return /\d{4}/.test(b) && a.length > 0 && (a === b || a.endsWith(b) || b.endsWith(a));
  }

  async function fillText(el, value) {
    const stuck = () => sameText(el.value, value);
    el.focus();
    setNativeValue(el, value);
    fire(el, "input");
    fire(el, "change");
    if (!stuck()) insertText(el, value);
    el.blur();
    fire(el, "focusout");
    // Controlled inputs that didn't register the change revert on the next render.
    await sleep(30);
    if (!stuck()) {
      insertText(el, value);
      el.blur();
      await sleep(30);
    }
    return stuck();
  }

  function fillSelect(entry, optionIndex) {
    const el = entry.el;
    const opt = entry.options[optionIndex];
    if (!opt) return false;
    el.focus();
    setNativeValue(el, el.options[opt.index].value);
    el.selectedIndex = opt.index;
    fire(el, "input");
    fire(el, "change");
    el.blur();
    return el.selectedIndex === opt.index;
  }

  function fillChoice(entry, optionIndex) {
    const opt = entry.options[optionIndex];
    if (!opt) return false;
    const el = opt.el;
    const isChecked = () => el.checked || el.getAttribute("aria-checked") === "true";
    if (!isChecked()) el.click();
    if (!isChecked() && el.labels?.[0]) el.labels[0].click();
    return isChecked();
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function fillFile(el, file) {
    if (!file?.data) return false;
    const blob = new File([base64ToBytes(file.data)], file.name || "resume.pdf", { type: file.type || "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(blob);
    el.files = dt.files;
    fire(el, "input");
    fire(el, "change");
    return el.files.length === 1;
  }

  function clickOption(option) {
    option.scrollIntoView({ block: "nearest" });
    for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      option.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0 }));
    }
    option.click();
  }

  async function fillCombobox(entry, plan) {
    const target = entry.el;
    const norm = (s) => clean(s).toLowerCase();
    if (plan.action === "option") {
      const wanted = norm(entry.options[plan.optionIndex]?.label);
      const find = (options) => options.find((o) => norm(o.textContent) === wanted)
        || options.find((o) => norm(o.textContent).startsWith(wanted));
      let match = find(await openCombobox(target));
      if (!match && target.matches("input")) {
        // Long or lazily rendered menus: type to filter, then look again.
        const before = new Set(visibleOptions());
        setNativeValue(target, entry.options[plan.optionIndex].label);
        fire(target, "input");
        match = find(await waitForOptions(target, before, 1500)) || find(visibleOptions());
      }
      if (!match) { closeCombobox(target); return false; }
      clickOption(match);
      await sleep(60);
      target.blur();
      return comboboxHasValue(target) || norm(target.value || target.textContent).includes(wanted);
    }
    // Free-text combobox (autocomplete): type the value, then pick the best suggestion.
    const value = plan.value;
    const before = new Set(visibleOptions());
    target.focus();
    setNativeValue(target, value);
    fire(target, "input");
    const options = await waitForOptions(target, before, 2500);
    if (!options.length) {
      fire(target, "change");
      return target.value === value;
    }
    const wantedTokens = new Set(norm(value).split(/[\s,]+/).filter(Boolean));
    const score = (o) => norm(o.textContent).split(/[\s,]+/).filter((t) => wantedTokens.has(t)).length;
    const best = options.reduce((a, b) => (score(b) > score(a) ? b : a), options[0]);
    clickOption(best);
    await sleep(60);
    target.blur();
    return true;
  }

  const HIGHLIGHT = { filled: "#22c55e", uncertain: "#f59e0b", failed: "#ef4444", needs: "#3b82f6" };

  function highlight(el, status, title) {
    if (!el || !HIGHLIGHT[status]) return;
    const tiny = el.getBoundingClientRect().width < 4;
    const visual = el.type === "file" || tiny || !isVisible(el) ? el.parentElement?.closest("label, div, li") || el : el;
    if (!visual.dataset.jafOutline) visual.dataset.jafOutline = visual.style.outline || "none";
    visual.style.outline = `2px solid ${HIGHLIGHT[status]}`;
    visual.style.outlineOffset = "2px";
    if (title) visual.setAttribute("data-jaf-title", title);
  }

  function clearHighlights() {
    document.querySelectorAll("[data-jaf-outline]").forEach((el) => {
      el.style.outline = el.dataset.jafOutline === "none" ? "" : el.dataset.jafOutline;
      el.style.outlineOffset = "";
      delete el.dataset.jafOutline;
      el.removeAttribute("data-jaf-title");
    });
  }

  function toast(text, ms = 4000) {
    if (window !== window.top) return;
    const host = document.createElement("div");
    host.setAttribute("data-jaf-ui", "");
    host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      div{font:13px/1.4 -apple-system,system-ui,sans-serif;background:#111827;color:#f9fafb;padding:10px 14px;border-radius:10px;
      box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:320px;transition:opacity .3s}
    </style><div></div>`;
    shadow.querySelector("div").textContent = text;
    document.documentElement.appendChild(host);
    setTimeout(() => { host.style.opacity = "0"; }, ms - 500);
    setTimeout(() => host.remove(), ms);
  }

  async function fill(items) {
    busy = true;
    try {
      return await fillInner(items);
    } finally {
      markAllSeen();
      busy = false;
    }
  }

  async function fillInner(items) {
    clearHighlights();
    const results = [];
    // Files first: some ATSs (Lever, Greenhouse) parse the resume and prefill fields.
    const ordered = [...items].sort((a, b) => (b.plan?.action === "file") - (a.plan?.action === "file"));
    for (const item of ordered) {
      const entry = registry.get(item.id);
      if (!entry) { results.push({ id: item.id, ok: false, error: "field disappeared" }); continue; }
      const anchor = anchorOf(entry);
      const mem = memory.get(anchor) || {};
      memory.set(anchor, { ...mem, key: item.key, status: item.status });
      if (item.status === "uncertain") {
        highlight(anchor, "uncertain", `Autofill unsure: ${item.keyLabel || ""} → ${item.plan?.display || ""}`);
        continue;
      }
      if (item.status === "skip" && item.required && item.reason !== "already filled") {
        highlight(anchor, "needs", "Needs your answer");
        continue;
      }
      if (item.status !== "fill" || !item.plan) continue;
      let ok = false;
      let error = "";
      try {
        const plan = item.plan;
        if (plan.action === "file") ok = fillFile(entry.el, item.file);
        else if (entry.kind === "combobox") ok = await fillCombobox(entry, plan);
        else if (entry.kind === "select") ok = fillSelect(entry, plan.optionIndex);
        else if (entry.kind === "radio" || entry.kind === "checkboxes") ok = fillChoice(entry, plan.optionIndex);
        else if (plan.action === "text") {
          item.expected = textValueFor(entry.el, plan.value, item.key);
          ok = await fillText(entry.el, item.expected);
        }
        if (!ok) error = "value didn't stick";
      } catch (e) {
        error = e.message;
      }
      memory.set(anchor, { ...memory.get(anchor), done: true, ...(ok ? { display: readCurrent(entry) || item.plan.display } : {}) });
      highlight(anchor, ok ? "filled" : "failed", item.keyLabel);
      results.push({ id: item.id, ok, error, item });
    }
    await verifyTextFills(results);
    return results.map(({ item, ...r }) => r);
  }

  /**
   * Some widgets (masked/phone inputs, forms that re-render from their own state) accept a
   * value and then drop it on a later render. Re-check text fills once the page settles,
   * retype lost values keystroke by keystroke, and report anything still lost as failed.
   */
  async function verifyTextFills(results) {
    const texts = results.filter((r) => r.ok && r.item.plan?.action === "text" && registry.get(r.id)?.kind === "text");
    if (!texts.length) return;
    await sleep(400);
    const lost = texts.filter((r) => !sameText(registry.get(r.id).el.value, expectedFor(r)));
    if (!lost.length) return;
    for (const r of lost) {
      const el = registry.get(r.id).el;
      const value = expectedFor(r);
      const keep = isDialCodeOnly(el) && value.startsWith(el.value.trim()) ? el.value : "";
      el.focus();
      if (!keep) {
        try { el.select(); } catch {}
        document.execCommand("delete");
      }
      insertTextTyped(el, keep ? value.slice(keep.length).trimStart() : value);
      el.blur();
      fire(el, "focusout");
    }
    await sleep(300);
    for (const r of lost) {
      const el = registry.get(r.id).el;
      const ok = sameText(el.value, expectedFor(r));
      r.ok = ok;
      r.error = ok ? "" : "the page cleared the value";
      highlight(el, ok ? "filled" : "failed", r.item.keyLabel);
      const mem = { ...memory.get(el) };
      if (ok) mem.display = el.value.trim(); else delete mem.display;
      memory.set(el, mem);
    }
  }

  function expectedFor(r) {
    return r.item.expected ?? r.item.plan.value;
  }

  /** Type character by character, for inputs that only react to keystroke-shaped edits. */
  function insertTextTyped(el, text) {
    el.focus();
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      if (!document.execCommand("insertText", false, ch)) {
        setNativeValue(el, el.value + ch);
        fire(el, "input");
      }
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    }
    fire(el, "change");
  }

  // ------------------------------------------------------------------ learning
  // When the applicant submits (or moves to the next step), answers they typed or corrected
  // themselves are sent to the background and saved for future applications.

  const SENSITIVE = /password|\bssn\b|social security|date of birth|birth ?date|\bdob\b|credit card|card number|bank|routing|passport number|driver'?s license number/i;
  const loose = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, "");

  function collectLearned() {
    const out = [];
    for (const [id, entry] of registry) {
      const field = fieldsById.get(id);
      if (!field || field.kind === "file" || field.kind === "textarea") continue;
      const label = field.label || "";
      if (label.length < 4 || label.length > 300 || SENSITIVE.test(label)) continue;
      const current = readCurrent(entry);
      if (!current || current.length > 200) continue;
      const mem = memory.get(anchorOf(entry)) || {};
      if (mem.status === "fill" && !mem.done) continue; // still being filled by us
      if (loose(current) === loose(mem.initial)) continue; // untouched since the page loaded
      if (mem.display && loose(current) === loose(mem.display)) continue; // our own answer, kept
      // A profile-backed text field that was merely reformatted isn't new knowledge.
      if (mem.display && field.kind === "text" && mem.key && !mem.key.startsWith("custom:")) continue;
      out.push({ question: label, answer: current, kind: field.kind, corrected: Boolean(mem.display) });
    }
    return out;
  }

  function learnNow() {
    if (!registry.size) return;
    const items = collectLearned(); // synchronously, before the page moves on
    if (items.length) api.runtime.sendMessage({ type: "jaf:learn", items, job: jobContext() }).catch(() => {});
  }

  document.addEventListener("submit", learnNow, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("button, input[type=submit], [role=button], a");
    if (!b) return;
    const text = clean(b.textContent || b.value || b.getAttribute("aria-label"));
    if (text.length < 40 && /\b(submit|apply|continue|next|save|review)\b/i.test(text)) learnNow();
  }, true);

  // ------------------------------------------------------------------ form detection
  // When an application form appears (and again when a new step with new fields shows up),
  // either offer an "Autofill" button in the page (default) or fill right away (fillWithoutClicking).

  const ATS_HOST = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkday\.com|smartrecruiters\.com|icims\.com|jobvite\.com|bamboohr\.com|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr|applytojob\.com|taleo\.net|successfactors|dover\.com|rippling\.com|paylocity\.com|ultipro\.com|adp\.com|oraclecloud\.com|eightfold\.ai|pinpointhq\.com|comeet\.com|polymer\.co|homerun\.co|gem\.com/i;
  const AUTO_SELECTOR = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]):not([type=password]), select, textarea, [role=combobox]";
  let seen = new WeakSet();
  let everTriggered = false;
  let autoTimer = null;
  let autoMode = "button";

  function autoCandidates() {
    return deepQueryAll(AUTO_SELECTOR).filter((el) => !el.closest("[data-jaf-ui]") && (el.type === "file" || isVisible(el)));
  }

  function markAllSeen() {
    for (const el of autoCandidates()) seen.add(el);
  }

  function looksLikeApplication(controls) {
    if (controls.length < 3) return false;
    if (ATS_HOST.test(location.hostname)) return true;
    const text = (el) => `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${labelFor(el)}`;
    const hasResume = controls.some((el) => el.type === "file" && /resume|\bcv\b|curriculum/i.test(`${text(el)} ${textWithoutControls(el.parentElement?.parentElement)}`));
    if (hasResume) return true;
    const hasEmail = controls.some((el) => el.type === "email" || /e-?mail/i.test(text(el)));
    return hasEmail && /apply|application|career|jobs?\b/i.test(`${location.href} ${document.title}`);
  }

  function checkAuto() {
    if (busy) { autoTimer = setTimeout(checkAuto, 700); return; }
    const controls = autoCandidates();
    const fresh = controls.filter((el) => !seen.has(el) && !(el.value && el.type !== "file" && el.tagName !== "SELECT"));
    if (fresh.length < (everTriggered ? 2 : 3)) return;
    if (!looksLikeApplication(controls)) return;
    controls.forEach((el) => seen.add(el));
    everTriggered = true;
    // The background decides where the button goes (top frame, even for embedded forms).
    api.runtime.sendMessage({ type: autoMode === "auto" ? "jaf:autoTrigger" : "jaf:formDetected" }).catch(() => {});
  }

  let buttonHost = null;

  function showButton() {
    if (window !== window.top || buttonHost?.isConnected) return;
    const host = document.createElement("div");
    host.setAttribute("data-jaf-ui", "");
    host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      .bar{display:flex;align-items:center;gap:2px;font:600 13.5px/1 -apple-system,system-ui,sans-serif;
        background:#2f5bea;border-radius:999px;box-shadow:0 8px 24px rgba(20,30,80,.28);overflow:hidden}
      button{font:inherit;color:#fff;background:none;border:0;cursor:pointer;padding:11px 14px}
      .go{padding-left:16px}
      .go:hover,.x:hover{background:rgba(255,255,255,.12)}
      .go:disabled{cursor:default;opacity:.85}
      .x{padding:11px 12px 11px 8px;opacity:.75;font-weight:400}
    </style><div class="bar"><button class="go" id="jaf-autofill">⚡ Autofill application</button><button class="x" title="Dismiss" aria-label="Dismiss">✕</button></div>`;
    const go = shadow.querySelector(".go");
    go.addEventListener("click", async () => {
      go.disabled = true;
      go.textContent = "Filling…";
      shadow.querySelector(".x").hidden = true;
      try {
        await api.runtime.sendMessage({ type: "jaf:fillNow" });
      } finally {
        host.remove();
      }
    });
    shadow.querySelector(".x").addEventListener("click", () => host.remove());
    document.documentElement.appendChild(host);
    buttonHost = host;
  }

  async function initAuto() {
    let settings = {};
    try { ({ settings = {} } = await api.storage.local.get("settings")); } catch {}
    if (settings.fillWithoutClicking) autoMode = "auto";
    else if (settings.showButton === false) return;
    checkAuto();
    new MutationObserver(() => {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(checkAuto, 700);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "jaf:scan") {
      scan().then((res) => sendResponse({ ...res, url: location.href }), (e) => sendResponse({ fields: [], error: e.message }));
      return true;
    }
    if (message?.type === "jaf:fill") {
      fill(message.items).then((results) => sendResponse({ results }), (e) => sendResponse({ results: [], error: e.message }));
      return true;
    }
    if (message?.type === "jaf:showButton") {
      showButton();
      return false;
    }
    if (message?.type === "jaf:toast") {
      toast(message.text, message.ms);
      return false;
    }
    return false;
  });

  initAuto();
})();
