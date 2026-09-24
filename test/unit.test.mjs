import test from "node:test";
import assert from "node:assert/strict";
import { PROFILE } from "./profile.mjs";

await import("../extension/shared/schema.js");
await import("../extension/shared/values.js");
await import("../extension/shared/classify.js");
const { resolve, formatForField, pickOption } = globalThis.JAF_VALUES;
const { heuristicKey, buildJevRequests, parseJevResponse, decide } = globalThis.JAF_CLASSIFY;

const opts = (...labels) => labels.map((label) => ({ label, value: label }));
const key = (label, extra = {}) => heuristicKey({ kind: "text", label, ...extra }, PROFILE)?.key;

test("derived values", () => {
  assert.equal(resolve("full_name", PROFILE), "Ada Lovelace");
  assert.equal(resolve("location", PROFILE), "San Francisco, CA");
  assert.equal(resolve("graduation_date", PROFILE), "May 2026");
  assert.equal(resolve("gender", PROFILE), "Female");
  assert.equal(resolve("veteran", PROFILE), "Decline to self-identify");
  assert.equal(resolve("custom:0", PROFILE), "No");
});

test("date formatting follows the field", () => {
  const f = (field) => formatForField("graduation_date", "May 2026", field, PROFILE);
  assert.equal(f({ inputType: "month" }), "2026-05");
  assert.equal(f({ inputType: "date" }), "2026-05-01");
  assert.equal(f({ placeholder: "MM/YYYY" }), "05/2026");
  assert.equal(f({ label: "Graduation (MM/YY)" }), "05/26");
  assert.equal(f({ placeholder: "MM/DD/YYYY" }), "05/01/2026");
  assert.equal(f({ label: "Graduation date" }), "May 2026");
  assert.equal(formatForField("graduation_month", "May", { inputType: "number" }, PROFILE), "05");
});

test("option matching", () => {
  const pick = (options, v, k) => {
    const r = pickOption(options, v, k);
    return r ? options[r.index].label : null;
  };
  assert.equal(pick(opts("Yes", "No"), "No"), "No");
  assert.equal(pick(opts("Yes, I am authorized", "No, I am not"), "Yes"), "Yes, I am authorized");
  assert.equal(pick(opts("Canada", "United States of America"), "United States"), "United States of America");
  assert.equal(pick(opts("Alaska", "California"), "CA"), "California");
  assert.equal(pick(opts("Man", "Woman", "I don't wish to answer"), "Female"), "Woman");
  assert.equal(pick(opts("Male", "Female", "I don't wish to answer"), "Decline to self-identify"), "I don't wish to answer");
  assert.equal(pick(opts("Yes, I have a disability", "No, I do not have a disability", "I do not want to answer"), "Decline to self-identify"), "I do not want to answer");
  assert.equal(pick(opts("I am a veteran", "I am not a veteran", "Decline"), "I am not a protected veteran"), "I am not a veteran");
  assert.equal(pick(opts("High School", "Bachelor's Degree", "Master's Degree"), "Bachelor of Science", "degree"), "Bachelor's Degree");
  assert.equal(pick(opts("01", "02", "05"), "May"), "05");
  assert.equal(pick(opts("Yes", "No"), "Maybe"), null);
  // Decline options are never picked for a real answer.
  assert.equal(pick(opts("Decline to self-identify", "Asian"), "White"), null);
});

test("heuristic field detection", () => {
  assert.equal(key("First Name *"), "first_name");
  assert.equal(key("Legal last name"), "last_name");
  assert.equal(key("Email address"), "email");
  assert.equal(key("Full name"), "full_name");
  assert.equal(key("LinkedIn Profile"), "linkedin");
  assert.equal(key("Current location"), "location");
  assert.equal(key("City"), "city");
  assert.equal(key("Expected graduation date"), "graduation_date");
  assert.equal(key("Graduation year"), "graduation_year");
  assert.equal(key("Will you now or in the future require visa sponsorship?"), "sponsorship");
  assert.equal(key("Are you legally authorized to work in the US?"), "work_authorization");
  assert.equal(key("When can you start?"), "start_date");
  assert.equal(key("Have you previously worked at Acme?"), "custom:0");
  assert.equal(key("", { name: "job_application[first_name]" }), "first_name");
  assert.equal(key("", { autocomplete: "family-name" }), "last_name");
  // Things that must not be filled.
  assert.equal(key("Emergency contact phone"), undefined);
  assert.equal(key("Middle name"), undefined);
  assert.equal(key("Name of employee who referred you"), undefined);
  assert.equal(key("Why do you want to work here?"), undefined);
  assert.equal(heuristicKey({ kind: "file", label: "Cover Letter" }, PROFILE).key, "cover_letter");
  assert.equal(heuristicKey({ kind: "file", label: "Unofficial transcript" }, PROFILE), null);
});

test("Jev requests are well-formed and chunked", () => {
  const fields = Array.from({ length: 30 }, (_, i) => ({ uid: `0_${i}`, kind: "text", label: `Field ${i}` }));
  fields.push({ uid: "0_select", kind: "select", label: "Gender", options: opts("Male", "Female", "Decline") });
  fields.push({ uid: "0_countries", kind: "select", label: "Country", options: opts(...Array.from({ length: 300 }, (_, i) => `C${i}`)) });
  const reqs = buildJevRequests(fields, PROFILE, { title: "Apply", url: "https://x" });
  assert.equal(reqs.length, 2);
  const allIds = reqs.flatMap((r) => r.fieldIds);
  assert.equal(allIds.length, 31, "300-option select is matched in code, not sent");
  for (const r of reqs) {
    assert.equal(r.body.model, "jev-latest");
    assert.ok(r.body.state.applicant_profile["First name"] === "Ada");
    assert.ok(!JSON.stringify(r.body).includes(PROFILE.files.resume.data), "file bytes never sent");
    for (const q of Object.values(r.body.questions)) {
      assert.equal(q.type, "choice");
      assert.ok(Object.keys(q.criteria).length <= 255);
      assert.ok("none" in q.criteria);
    }
  }
  const sel = reqs[1].body.questions.f0_select;
  assert.deepEqual(Object.keys(sel.criteria), ["opt_0", "opt_1", "opt_2", "none"]);
});

test("decide gates on confidence and validates answers", () => {
  const fields = [
    { uid: "a", kind: "text", label: "Given name" },
    { uid: "b", kind: "text", label: "Something odd" },
    { uid: "c", kind: "select", label: "Gender", options: opts("Male", "Female") },
    { uid: "d", kind: "text", label: "Email", hasValue: true },
    { uid: "e", kind: "text", label: "Mystery" },
  ];
  const req = buildJevRequests(fields, PROFILE, {})[0];
  const answer = (choice, confidence, criteria) => ({
    type: "choice", choice, confidence,
    probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === choice ? 0.9 : 0.1 / (Object.keys(criteria).length - 1)])),
  });
  const q = req.body.questions;
  const parsed = parseJevResponse(req, {
    answers: {
      fa: answer("first_name", 0.9, q.fa.criteria),
      fb: answer("github", 0.2, q.fb.criteria),
      fc: answer("opt_1", 0.95, q.fc.criteria),
      fe: { type: "choice", choice: "hacked", confidence: 1, probabilities: {} },
    },
  });
  assert.equal(parsed.fe, undefined, "invalid answer rejected");
  const d = Object.fromEntries(decide(fields, PROFILE, parsed).map((x) => [x.uid, x]));
  assert.equal(d.a.status, "fill");
  assert.equal(d.a.plan.value, "Ada");
  assert.equal(d.b.status, "uncertain");
  assert.equal(d.c.plan.display, "Female");
  assert.equal(d.d.status, "skip");
  assert.equal(d.e.status, "skip");
});

test("per-country work authorization, citizenship, past employers", () => {
  const r = (key, label, job = {}, extra = {}) => resolve(key, PROFILE, { field: { label, ...extra }, job });
  assert.equal(r("work_authorization", "Are you authorized to work in the United States?"), "Yes");
  assert.equal(r("work_authorization", "Are you authorized to work in Canada?"), "No");
  assert.equal(r("sponsorship", "Will you require sponsorship to work in the UK?"), "Yes");
  assert.equal(r("sponsorship", "Will you now or in the future require sponsorship?"), "No", "home country by default");
  assert.equal(r("sponsorship", "Will you require sponsorship?", { country: "Germany" }), "Yes", "job's country");
  assert.equal(r("sponsorship", "Are you authorized to work in the US without visa sponsorship?"), "Yes");
  assert.equal(r("work_authorization", "Can you work in Canada without requiring sponsorship?"), "No");
  assert.equal(r("is_citizen", "Are you a U.S. citizen?"), "Yes");
  assert.equal(r("is_citizen", "Are you a Canadian citizen?"), "No");
  assert.equal(r("is_citizen", "Are you a citizen?"), "Yes", "no country named → home country");
  assert.equal(r("is_citizen", "Are you a citizen of Canada?"), "No");
  assert.equal(r("previously_employed", "Have you worked here before?", { company: "Acme" }), "No");
  assert.equal(r("previously_employed", "Have you worked here before?", { company: "Babbage Labs, Inc." }), "Yes");
  assert.equal(r("previously_employed", "Have you worked here before?", {}), "", "unknown company → abstain");
  assert.equal(r("security_clearance", "Do you have a clearance?", {}, { options: opts("Yes", "No") }), "");
  const cleared = { ...PROFILE, profile: { ...PROFILE.profile, security_clearance: "None" } };
  assert.equal(resolve("security_clearance", cleared, { field: { label: "Clearance?", options: opts("Yes", "No") } }), "No");
  // Nothing on file → abstain rather than guess.
  assert.equal(resolve("work_authorization", { ...PROFILE, workAuth: [] }, { field: { label: "Authorized to work?" } }), "");
});

test("abstains instead of guessing", () => {
  const pick = (options, v) => pickOption(options, v);
  assert.equal(pick(opts("Yes - citizen", "Yes - visa holder", "No"), "Yes"), null, "two Yes variants");
  assert.notEqual(pick(opts("Yes", "Yes - with sponsorship", "No"), "Yes"), null, "exact match still wins");
  assert.notEqual(pick(opts("Decline to self-identify", "I don't wish to answer", "Male"), "Decline to self-identify"), null);

  // Learned answers only apply to (nearly) the same question.
  const data = { ...PROFILE, customAnswers: [{ question: "Do you have professional experience with Python?", answer: "Yes", learned: true }] };
  assert.equal(heuristicKey({ kind: "text", label: "Do you have professional experience with Rust?" }, data), null);
  assert.equal(heuristicKey({ kind: "text", label: "Do you have professional experience with Python?" }, data).key, "custom:0");

  // Jev and the deterministic answer disagree on an option → uncertain, not filled.
  const field = { uid: "x", kind: "select", label: "Are you authorized to work in the United States?", options: opts("Yes", "No") };
  const [d] = decide([field], PROFILE, { x: { choice: "opt_1", confidence: 0.95 } });
  assert.equal(d.status, "uncertain");
  const [agree] = decide([field], PROFILE, { x: { choice: "opt_0", confidence: 0.3 } });
  assert.equal(agree.status, "fill", "low confidence but agrees with the rules");
  const [weak] = decide([field], PROFILE, { x: { choice: "opt_1", confidence: 0.3 } });
  assert.equal(weak.status, "fill", "a weak dissent doesn't block the rules");
  assert.equal(weak.plan.display, "Yes");

  // Status-split yes options: citizens pick the citizen variant, others abstain.
  const split = { uid: "y", kind: "select", label: "Work authorization in the United States", options: opts("Yes - citizen", "Yes - visa holder", "No") };
  assert.equal(decide([split], PROFILE, null)[0].plan.display, "Yes - citizen");
  const nonCitizen = { ...PROFILE, profile: { ...PROFILE.profile, citizenship: "India" } };
  assert.equal(decide([split], nonCitizen, null)[0].status, "skip");
});

test("source falls back to an equivalent option", () => {
  const field = { uid: "s", kind: "select", label: "How did you hear about us?", options: opts("Referral", "Job Board", "Other") };
  const [d] = decide([field], PROFILE, null);
  assert.equal(d.plan.display, "Job Board");
});

test("phone respects maxlength; today's date formats", () => {
  assert.equal(formatForField("phone", "+1 (415) 555-0100", { maxLength: 10 }, PROFILE), "4155550100");
  assert.equal(formatForField("phone", "415-555-0100", {}, PROFILE), "415-555-0100");
  assert.equal(formatForField("today", "2026-09-23", { inputType: "date" }, PROFILE), "2026-09-23");
  assert.equal(formatForField("today", "2026-09-23", { placeholder: "MM/DD/YYYY" }, PROFILE), "09/23/2026");
});
