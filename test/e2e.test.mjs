// Loads the real extension into Chromium (same WebExtension code Safari runs) and autofills
// fixture forms. Covers heuristic mode, a mock TypeSafe server, and — when TYPESAFE_API_KEY
// is set — live Jev.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { PROFILE } from "./profile.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(root, "..", "extension");
const fixtures = path.join(root, "fixtures");

let server, base, context, worker;
const jevRequests = [];

// Mock TypeSafe: answers each Choice from a label → answer table, else "none".
const MOCK = [
  [/first name/i, "first_name"], [/last name/i, "last_name"], [/^email/i, "email"], [/^phone/i, "phone"],
  [/location/i, "location"], [/resume/i, "resume"], [/cover letter/i, "cover_letter"], [/linkedin/i, "linkedin"],
  [/website/i, "website"], [/^school/i, "school"], [/graduation/i, "graduation_date"],
  [/legally authorized/i, "Yes"], [/sponsorship/i, "No"], [/previously worked/i, "No"],
  [/country/i, "United States of America"], [/^gender/i, "Female"], [/hispanic/i, "Decline To Self Identify"],
  [/veteran/i, "I don't wish to answer"], [/disability/i, "I do not want to answer"],
];

function mockAnswer(question) {
  const label = question.instructions.form_field.label;
  const hit = MOCK.find(([re]) => re.test(label));
  const ids = Object.keys(question.criteria);
  let choice = "none";
  if (hit) {
    choice = ids.find((id) => id === hit[1] || question.criteria[id] === hit[1]) || "none";
  }
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === choice ? 0.93 : 0.07 / (ids.length - 1)]));
  return { type: "choice", choice, probabilities, confidence: 0.9 };
}

function serve(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/v1/systemone" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      jevRequests.push({ auth: req.headers.authorization, body: parsed });
      const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, q]) => [id, mockAnswer(q)]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 1234, output_tokens: 0 } }));
    });
    return;
  }
  const file = path.join(fixtures, path.normalize(url.pathname).replace(/^\/+/, ""));
  if (!file.startsWith(fixtures) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" });
  fs.createReadStream(file).pipe(res);
}

before(async () => {
  execFileSync(path.join(root, "..", "node_modules", ".bin", "esbuild"), [
    path.join(fixtures, "react-app.jsx"), "--bundle", `--outfile=${path.join(fixtures, "build", "react-app.js")}`,
    "--define:process.env.NODE_ENV=\"production\"", "--minify", "--log-level=warning",
  ]);
  execFileSync(path.join(root, "..", "node_modules", ".bin", "esbuild"), [
    path.join(fixtures, "phone-app.jsx"), "--bundle", `--outfile=${path.join(fixtures, "build", "phone-app.js")}`,
    "--define:process.env.NODE_ENV=\"production\"", "--minify", "--loader:.css=empty", "--log-level=warning",
  ]);
  server = http.createServer(serve);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${server.address().port}`;
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
});

after(async () => {
  await context?.close();
  server?.close();
});

async function setData(overrides = {}) {
  const data = { ...PROFILE, ...overrides, settings: { ...PROFILE.settings, ...(overrides.settings || {}) } };
  await worker.evaluate((d) => chrome.storage.local.clear().then(() => chrome.storage.local.set(d)), data);
}

async function autofill(page) {
  const url = page.url();
  return worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u.split("#")[0] });
    return globalThis.autofillTab(tab.id);
  }, url);
}

async function open(file) {
  const page = await context.newPage();
  await page.goto(`${base}/${file}`);
  await page.waitForLoadState("networkidle");
  return page;
}

function summarize(result) {
  return result.rows.map((r) => `${r.status.padEnd(9)} ${r.label.slice(0, 50).padEnd(50)} ${r.key} = ${r.value} [${r.source}${r.confidence != null ? ` ${r.confidence.toFixed(2)}` : ""}] ${r.reason}`).join("\n");
}

async function checkGreenhouse(frame, { mode }) {
  const v = (sel) => frame.locator(sel).inputValue();
  const selected = (sel) => frame.locator(sel).evaluate((s) => s.options[s.selectedIndex].text);
  assert.equal(await v("#first_name"), "Ada");
  assert.equal(await v("#last_name"), "Lovelace");
  assert.equal(await v("#email"), "ada@example.com");
  assert.equal(await v("#phone"), "415-555-0100");
  assert.ok(["San Francisco, CA", "San Francisco"].includes(await v("#loc")), "location or city both answer “Location (City)”");
  assert.equal(await frame.locator("#resume").evaluate((i) => i.files[0]?.name), "Ada_Lovelace_Resume.pdf");
  assert.equal(await frame.locator("#cover_letter").evaluate((i) => i.files.length), 0);
  assert.equal(await v("#q1"), "https://www.linkedin.com/in/ada");
  assert.equal(await v("#q2"), "https://ada.dev");
  assert.equal(await v("#q3"), "Stanford University");
  assert.equal(await v("#q4"), "05/2026");
  assert.equal(await v("#q5"), "", `essay left alone (${mode})`);
  assert.equal(await v("#q6"), "", `referrer left alone (${mode})`);
  assert.equal(await selected("#q7"), "Yes");
  assert.equal(await selected("#q8"), "No");
  assert.equal(await selected("#q9"), "No");
  assert.equal(await selected("#q10"), "United States of America");
  assert.equal(await selected("#gender"), "Female");
  assert.equal(await selected("#hispanic"), "Decline To Self Identify");
  assert.equal(await selected("#veteran"), "I don't wish to answer");
  assert.equal(await selected("#disability"), "I do not want to answer");
  assert.equal(await frame.evaluate(() => window.submitted), false, "never submits");
}

test("greenhouse-style form (pattern matching)", async () => {
  await setData();
  const page = await open("greenhouse.html");
  const result = await autofill(page);
  console.log(summarize(result));
  assert.equal(result.classifier, "heuristic");
  await checkGreenhouse(page, { mode: "heuristic" });
  await page.close();
});

test("greenhouse-style form (mock Jev server)", async () => {
  jevRequests.length = 0;
  await setData({ settings: { useJev: true, apiKey: "test-key", apiBase: base } });
  const page = await open("greenhouse.html");
  const result = await autofill(page);
  assert.equal(result.classifier, "jev", JSON.stringify(result.jevErrors));
  assert.equal(jevRequests.length, 1);
  assert.equal(jevRequests[0].auth, "Bearer test-key");
  assert.ok(result.rows.filter((r) => r.status === "filled").every((r) => r.source.startsWith("jev")));
  await checkGreenhouse(page, { mode: "jev" });
  await page.close();
});

test("lever-style form: wrapped labels, radios, checkbox groups", async () => {
  await setData();
  const page = await open("lever.html");
  const result = await autofill(page);
  console.log(summarize(result));
  const v = (name) => page.locator(`[name="${name}"]`).inputValue();
  assert.equal(await page.locator("#resume-upload-input").evaluate((i) => i.files[0]?.name), "Ada_Lovelace_Resume.pdf");
  assert.equal(await v("name"), "Ada Lovelace");
  assert.equal(await v("pronouns"), "she/her");
  assert.equal(await v("email"), "ada@example.com");
  assert.equal(await v("location"), "San Francisco, CA");
  assert.equal(await v("org"), "Analytical Engines Inc");
  assert.equal(await v("urls[GitHub]"), "https://github.com/ada");
  assert.equal(await v("urls[Portfolio]"), "https://ada.dev");
  assert.equal(await v("cards[abc][field1]"), "June 2026");
  assert.equal(await page.locator('[name="cards[abc][field0]"][value="Yes"]').isChecked(), true);
  assert.equal(await page.locator('[name="cards[abc][field2]"]:checked').count(), 0, "unknown checkbox group untouched");
  assert.equal(await page.locator('[name="consent"]').isChecked(), false, "consent left to the user");
  const sel = (name) => page.locator(`[name="${name}"]`).evaluate((s) => s.options[s.selectedIndex].text);
  assert.equal(await sel("eeo[gender]"), "Female");
  assert.equal(await sel("eeo[race]"), "Decline to self-identify");
  assert.equal(await sel("eeo[veteran]"), "Decline to self-identify");
  await page.close();
});

test("react + react-select form: controlled inputs, comboboxes, async autocomplete", async () => {
  await setData();
  const page = await open("react.html");
  const result = await autofill(page);
  console.log(summarize(result));
  const state = JSON.parse(await page.locator("#state").textContent());
  assert.deepEqual(state, {
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.com",
    phone: "415-555-0100",
    location: "San Francisco, California, United States",
    resume: "Ada_Lovelace_Resume.pdf",
    school: "Stanford University",
    degree: "Bachelor's Degree",
    grad: "2026-05",
    authorized: "Yes",
    sponsorship: "No",
    source: "LinkedIn",
    gender: "Woman",
  });
  await page.close();
});

test("cross-origin iframe embed", async () => {
  await setData();
  const page = await open("embed.html");
  const frame = page.frames().find((f) => f.url().includes("greenhouse.html"));
  await frame.waitForLoadState("load");
  const result = await autofill(page);
  assert.ok(result.rows.length > 10, summarize(result));
  await checkGreenhouse(frame, { mode: "iframe" });
  await page.close();
});

test("phone widgets with country pickers (react-phone-number-input, react-international-phone, react-phone-input-2, imask)", async () => {
  await setData();
  const page = await open("phone.html");
  const result = await autofill(page);
  console.log(summarize(result));
  const state = JSON.parse(await page.locator("#state").textContent());
  assert.deepEqual(state, { a: "+14155550100", b: "+14155550100", c: "14155550100", d: "4155550100" });
  assert.ok(!result.rows.some((r) => r.status === "failed"), "no failed fills");
  await page.close();
});

function todayMDY() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

async function waitForValue(page, selector, expected, timeout = 8000) {
  await page.waitForFunction(([sel, want]) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const v = el.tagName === "SELECT" ? el.options[el.selectedIndex]?.text : el.value;
    return v === want;
  }, [selector, expected], { timeout });
}

async function checkEligibility(page, result) {
  const sel = (id) => page.locator(id).evaluate((s) => s.options[s.selectedIndex].text);
  assert.equal(result.job.company, "Acme");
  assert.equal(result.job.country, "Canada");
  assert.equal(await page.locator("#phone").inputValue(), "4155550100", "respects maxlength");
  assert.equal(await sel("#auth_here"), "No", "job is in Canada; only US authorization on file");
  assert.equal(await sel("#auth_us"), "Yes");
  assert.equal(await sel("#auth_us_nosp"), "Yes", "authorized without sponsorship");
  assert.equal(await page.locator('[name="uk_sp"][value="yes"]').isChecked(), true, "UK would need sponsorship");
  assert.equal(await sel("#citizen"), "Yes");
  assert.equal(await sel("#prev"), "No", "Acme isn't a past employer");
  assert.equal(await sel("#clearance"), "Select…", "no clearance info → left alone");
  assert.equal(await sel("#source"), "Job Board", "LinkedIn → closest equivalent");
  assert.equal(await sel("#ambiguous"), "Yes - citizen", "US citizen picks the citizen variant");
  assert.equal(await page.locator("#today").inputValue(), todayMDY());
  assert.equal(await page.locator("#fav").inputValue(), "");
  assert.equal(await page.locator('[name="sms"][value="no"]').isChecked(), true, "messaging opt-ins default to No");
}

test("auto-run on load: per-country eligibility, job context, abstaining, multi-step", async () => {
  await setData({ settings: { fillWithoutClicking: true } });
  const page = await open("eligibility.html");
  await waitForValue(page, "#first_name", "Ada");
  // Wait for the whole run (including the verify pass) to finish, not just the first field.
  let result = null;
  for (let i = 0; i < 100 && !result; i++) {
    result = await worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      return globalThis.getLastResult(tab.id);
    }, page.url());
    if (!result) await page.waitForTimeout(100);
  }
  console.log(summarize(result));
  assert.equal(result.auto, true);
  await checkEligibility(page, result);

  // Next step appears → auto-run fills the new fields.
  await page.click("#next");
  await waitForValue(page, "#gender", "Female");
  await waitForValue(page, "#veteran", "I don't wish to answer");
  assert.equal(await page.evaluate(() => window.submitted), false);
  await page.close();
});

test("default: shows an Autofill button and fills only when clicked", async () => {
  await setData(); // fillWithoutClicking off, button on (default)
  const page = await open("eligibility.html");
  const button = page.locator("#jaf-autofill");
  await button.waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#first_name").inputValue(), "", "nothing filled before clicking");
  await button.click();
  await waitForValue(page, "#first_name", "Ada");
  await button.waitFor({ state: "detached", timeout: 8000 });

  // A new step brings the button back; its fields wait for another click.
  await page.click("#next");
  await button.waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#gender").evaluate((s) => s.value), "");
  await button.click();
  await waitForValue(page, "#gender", "Female");
  await page.close();
});

test("learns answers typed by the user and reuses them", async () => {
  await setData({ settings: { fillWithoutClicking: true } });
  let page = await open("eligibility.html");
  await waitForValue(page, "#first_name", "Ada");
  await page.fill("#fav", "Rust");
  await page.click("#submit");
  await page.waitForTimeout(300);
  const saved = await worker.evaluate(() => chrome.storage.local.get("customAnswers").then((d) => d.customAnswers));
  const learned = saved.filter((a) => a.learned);
  assert.deepEqual(learned.map((a) => [a.question, a.answer]), [["What is your favorite programming language?", "Rust"]],
    "only the user's own answer is learned");
  await page.close();

  page = await open("eligibility.html");
  await waitForValue(page, "#fav", "Rust");
  await page.close();
});

test("live Jev (set TYPESAFE_API_KEY to run)", { skip: !process.env.TYPESAFE_API_KEY }, async () => {
  await setData({ settings: { useJev: true, apiKey: process.env.TYPESAFE_API_KEY } });
  for (const file of ["greenhouse.html", "lever.html", "react.html", "eligibility.html", "phone.html"]) {
    const page = await open(file);
    const result = await autofill(page);
    console.log(`--- ${file} (${result.classifier}, ${result.ms}ms, ${result.jevRequests} requests, ${result.jevTokens} tokens)\n${summarize(result)}`);
    assert.equal(result.classifier, "jev", JSON.stringify(result.jevErrors));
    if (file === "greenhouse.html") await checkGreenhouse(page, { mode: "live" });
    if (file === "eligibility.html") await checkEligibility(page, result);
    await page.close();
  }
});
