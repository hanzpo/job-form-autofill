// Decides what to put in each scanned form field.
//
// Two classifiers:
//  - Jev (TypeSafe System One): one Choice question per field, all fields sent in a few
//    parallel requests. Text/file fields choose *which profile item* fits; option fields
//    (select, radio, combobox) choose *which option* the applicant's profile implies.
//  - Heuristics: regex over labels/name/id/autocomplete. Used without an API key, when a
//    request fails, and as a tie-breaker for low-confidence Jev answers.
(function (root) {
  const { FIELDS, HEURISTIC_ORDER, HEURISTIC_EXCLUDE } = root.JAF_SCHEMA;
  const { normalize, similarity, resolve, formatForField, pickOption } = root.JAF_VALUES;
  const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

  const NONE = "none";
  const OPTION_KINDS = new Set(["select", "radio", "checkboxes", "combobox"]);
  const MAX_CHOICE_OPTIONS = 254; // API allows 255; one slot is reserved for "none".
  const MAX_QUESTIONS_PER_REQUEST = 25;
  const MAX_REQUEST_CHARS = 120000; // ~30k tokens, well under the 64k context budget.

  const AUTOCOMPLETE = {
    "given-name": "first_name", "family-name": "last_name", name: "full_name", nickname: "preferred_name",
    email: "email", tel: "phone", "tel-national": "phone",
    "street-address": "address_line1", "address-line1": "address_line1", "address-line2": "address_line2",
    "address-level2": "city", "address-level1": "state", "postal-code": "postal_code",
    country: "country", "country-name": "country",
    organization: "current_company", "organization-title": "current_title", url: "website",
  };

  // Dial-code pickers next to phone inputs already default to the right country.
  const PHONE_COUNTRY_PICKER = /\bcountry (selector|code)\b|\bdial(ing)? code\b|\bphone (number )?country\b/i;

  function isOptionField(field) {
    return OPTION_KINDS.has(field.kind) && field.options?.length > 0;
  }

  // Keys whose values can fit an input of this type: a month picker can't take "May".
  const DATE_KEYS = ["graduation_date", "start_date", "today"];
  const URL_KEYS = ["linkedin", "github", "website", "twitter"];
  const TYPE_KEYS = { month: DATE_KEYS, date: DATE_KEYS, email: ["email"], tel: ["phone"], url: URL_KEYS };

  function keysForKind(field) {
    if (field.kind === "file") return ["resume", "cover_letter"];
    const only = field.kind === "text" && TYPE_KEYS[field.inputType];
    return FIELDS.filter((f) => f.input !== "file" && (!only || only.includes(f.key))).map((f) => f.key);
  }

  // ---------------------------------------------------------------- heuristics

  function customKeys(data) {
    return (data.customAnswers || [])
      .map((a, i) => ({ key: `custom:${i}`, question: a.question, answer: a.answer, learned: Boolean(a.learned) }))
      .filter((a) => String(a.question || "").trim() && String(a.answer || "").trim());
  }

  /** Saved answers plausibly about this field, most similar first (keeps Choice option lists small). */
  function relevantCustom(field, data, limit = 12) {
    return customKeys(data)
      .map((c) => ({ ...c, sim: similarity(`${field.label} ${field.hint || ""}`, c.question) }))
      .filter((c) => c.sim >= 0.3)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit);
  }

  function heuristicKey(field, data) {
    const label = normalize(field.label);
    const secondary = normalize([field.name, field.htmlId, field.placeholder].filter(Boolean).join(" "));

    if (field.kind === "file") {
      const text = `${label} ${secondary}`;
      if (BY_KEY.cover_letter.match.test(text)) return { key: "cover_letter", confidence: 0.8 };
      if (BY_KEY.resume.match.test(text)) return { key: "resume", confidence: 0.8 };
      if (/\btranscript\b|\bportfolio\b|\bwriting sample\b|\bother\b|\badditional\b|\bphoto\b|\bheadshot\b/.test(text)) return null;
      return { key: "resume", confidence: 0.5 };
    }

    const ac = String(field.autocomplete || "").toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) return { key: AUTOCOMPLETE[ac], confidence: 0.9 };

    if (HEURISTIC_EXCLUDE.test(label)) return null;

    // Saved answers must match (nearly) the same question: "Python experience?" and "Rust
    // experience?" differ by one word. Learned questions are held to a stricter bar.
    let bestCustom = null;
    for (const c of customKeys(data)) {
      const s = similarity(field.label, c.question);
      if (s >= (c.learned ? 0.9 : 0.75) && (!bestCustom || s > bestCustom.confidence)) bestCustom = { key: c.key, confidence: s };
    }
    if (bestCustom) return bestCustom;

    for (const key of HEURISTIC_ORDER) {
      if (BY_KEY[key].input === "file") continue;
      if (label && BY_KEY[key].match.test(label)) return { key, confidence: 0.8 };
    }
    if (HEURISTIC_EXCLUDE.test(secondary)) return null;
    for (const key of HEURISTIC_ORDER) {
      if (BY_KEY[key].input === "file") continue;
      if (secondary && BY_KEY[key].match.test(secondary)) return { key, confidence: 0.6 };
    }
    return null;
  }

  // ---------------------------------------------------------------- Jev requests

  function describeField(field) {
    const d = { label: field.label || "(no visible label)" };
    if (field.kind === "file") d.type = "file upload";
    else if (field.kind === "textarea") d.type = "multi-line text";
    else if (field.kind === "combobox" && !field.options?.length) d.type = "text with autocomplete";
    else if (field.kind === "text") d.type = field.inputType || "text";
    else d.type = field.kind === "checkboxes" ? "checkbox group" : field.kind;
    if (field.placeholder && field.placeholder !== field.label) d.placeholder = field.placeholder;
    if (field.name && !/^[\w-]*\d{3,}[\w-]*$/.test(field.name)) d.name = field.name;
    if (field.section) d.section = field.section;
    if (field.hint) d.nearby_text = field.hint;
    if (field.required) d.required = true;
    return d;
  }

  // Answers that depend on the question's country or the company are given to Jev as facts
  // (per-country table, employers) rather than pre-resolved, so it can't misapply them.
  const CONTEXTUAL_KEYS = new Set(["work_authorization", "sponsorship", "is_citizen", "previously_employed", "today"]);

  function applicantState(data, page, job, fields = []) {
    const profile = {};
    for (const f of FIELDS) {
      if (f.input === "file") {
        if (data.files?.[f.key]?.name) profile[f.label] = `(file on hand: ${data.files[f.key].name})`;
        continue;
      }
      if (CONTEXTUAL_KEYS.has(f.key)) continue;
      const v = resolve(f.key, data, { job });
      if (v) profile[f.label] = v;
    }
    const eligibility = {};
    const auth = (data.workAuth || []).filter((r) => String(r.country || "").trim());
    if (auth.length) {
      eligibility.countries_authorized_to_work_in = auth.map((r) => ({
        country: r.country,
        needs_visa_sponsorship: r.sponsorship === "Yes" ? "yes (now or in the future)" : "no",
      }));
      eligibility.all_other_countries = "not authorized to work; would need visa sponsorship";
    }
    if (data.profile?.citizenship) eligibility.citizenship = data.profile.citizenship;
    const prev = resolve("previously_employed", data, { job });
    if (prev) eligibility[`has_worked_for_${job.company}`] = prev;
    eligibility.todays_date = resolve("today", data);
    const relevant = new Map();
    for (const f of fields) for (const c of relevantCustom(f, data, 5)) relevant.set(c.key, c);
    const saved = [...relevant.values()].slice(0, 40).map((c) => ({ question: c.question, answer: c.answer }));
    const jobInfo = {};
    for (const k of ["title", "company", "location", "country"]) if (job?.[k]) jobInfo[k] = job[k];
    return {
      page: { title: page?.title || "", url: page?.url || "" },
      ...(Object.keys(jobInfo).length ? { job: jobInfo } : {}),
      applicant_profile: profile,
      applicant_eligibility: eligibility,
      ...(saved.length ? { saved_answers: saved } : {}),
    };
  }

  function keyQuestion(field, data) {
    const criteria = {};
    for (const key of keysForKind(field)) criteria[key] = BY_KEY[key].describe;
    if (field.kind !== "file") {
      for (const c of relevantCustom(field, data)) criteria[c.key] = `The applicant's saved answer to the question: "${c.question}"`;
    }
    criteria[NONE] = field.kind === "file"
      ? "Some other document (transcript, portfolio, writing sample, photo…) or not an upload the applicant has on file"
      : "None of the above fits exactly: e.g. an open-ended essay or cover-letter text, a referrer or emergency contact, a middle name, a question about a different person, or information not listed";
    return {
      type: "choice",
      instructions: {
        form_field: describeField(field),
        question: field.kind === "file"
          ? "A job application form has the file upload `form_field`. Which of the applicant's documents should be uploaded to it?"
          : "A job application form has the input `form_field`. Which item of the applicant's saved data should be entered into it? Match the field's meaning exactly; prefer none over a loose fit.",
      },
      criteria,
    };
  }

  function optionQuestion(field) {
    const criteria = {};
    field.options.forEach((opt, i) => {
      criteria[`opt_${i}`] = opt.label || opt.value || `(option ${i + 1})`;
    });
    criteria[NONE] = "Leave it unanswered: the applicant profile and saved answers do not determine this answer";
    return {
      type: "choice",
      instructions: {
        form_field: describeField(field),
        question: "A job application form asks `form_field`. Using only `applicant_profile`, `applicant_eligibility`, `saved_answers`, and `job` in the state, which option should the applicant select? For work authorization, sponsorship, or citizenship, answer for the country the question names (else the job's country) using `applicant_eligibility`. For voluntary self-identification questions, follow the profile exactly (including declining to answer). If the applicant's exact answer is not listed, pick the option that means the same thing (e.g. LinkedIn → a job board / social media option). Choose none if the applicant's data does not determine the answer.",
      },
      criteria,
    };
  }

  /** Build one or more TypeSafe request bodies; returns [{body, fieldIds}]. */
  function buildJevRequests(fields, data, page, job) {
    const state = applicantState(data, page, job, fields);
    const model = data.settings?.model || "jev-latest";
    const base = JSON.stringify(state).length;
    const requests = [];
    let current = null;
    for (const field of fields) {
      if (PHONE_COUNTRY_PICKER.test(field.label || "")) continue;
      // Very long option lists (countries, schools) are matched in code instead.
      if (isOptionField(field) && field.options.length > MAX_CHOICE_OPTIONS) continue;
      const qid = `f${field.uid}`;
      const question = isOptionField(field) ? optionQuestion(field) : keyQuestion(field, data);
      const size = JSON.stringify(question).length;
      if (!current || current.fieldIds.length >= MAX_QUESTIONS_PER_REQUEST || current.size + size > MAX_REQUEST_CHARS) {
        current = { body: { model, state, questions: {} }, fieldIds: [], size: base };
        requests.push(current);
      }
      current.body.questions[qid] = question;
      current.fieldIds.push(field.uid);
      current.size += size;
    }
    return requests.map(({ body, fieldIds }) => ({ body, fieldIds }));
  }

  function validChoice(answer, question) {
    if (!answer || typeof answer !== "object") return false;
    const ids = Object.keys(question.criteria);
    const probs = answer.probabilities || {};
    return ids.includes(answer.choice)
      && typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
      && ids.every((id) => typeof probs[id] === "number");
  }

  /** Map a TypeSafe response back to {uid: {choice, confidence, probability}}. */
  function parseJevResponse(request, response) {
    const out = {};
    for (const uid of request.fieldIds) {
      const qid = `f${uid}`;
      const answer = response?.answers?.[qid];
      const question = request.body.questions[qid];
      if (validChoice(answer, question)) {
        out[uid] = {
          choice: answer.choice,
          confidence: answer.confidence,
          probability: answer.probabilities[answer.choice],
        };
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- decisions

  // When the applicant's own source isn't an option, these equivalents are tried in order.
  const SOURCE_FALLBACKS = ["LinkedIn", "Job Board", "Online Job Board", "Job Posting", "Online Job Posting", "Internet", "Job Search Website", "Company Website", "Careers Website", "Career Site", "Website"];

  /** Build a fill instruction for a field given a profile key (text-like) or option index. */
  function planForKey(field, key, data, job) {
    if (field.kind === "file") {
      const file = data.files?.[key];
      return file?.data ? { action: "file", fileKey: key, display: file.name } : null;
    }
    const raw = resolve(key, data, { field, job });
    if (!raw) return null;
    if (isOptionField(field)) {
      const candidates = key === "how_heard" ? [raw, ...SOURCE_FALLBACKS] : [raw];
      for (const candidate of candidates) {
        const pick = pickOption(field.options, candidate, key);
        if (pick) return { action: "option", optionIndex: pick.index, display: field.options[pick.index].label };
      }
      // "Yes – citizen" / "Yes – green card" / "Yes – visa": a citizen of the country picks the
      // citizen variant; anyone else abstains (status beyond citizenship isn't on file).
      if (key === "work_authorization" && raw === "Yes" && resolve("is_citizen", data, { field, job }) === "Yes") {
        const citizen = field.options
          .map((o, index) => ({ index, label: String(o.label || "") }))
          .filter((o) => /^\s*yes\b/i.test(o.label) && /\bcitizen/i.test(o.label));
        if (citizen.length === 1) return { action: "option", optionIndex: citizen[0].index, display: citizen[0].label };
      }
      return null;
    }
    const value = formatForField(key, raw, field, data);
    return { action: "text", value, display: value };
  }

  function keyLabel(key) {
    if (!key) return "";
    if (key.startsWith("custom:")) return "Saved answer";
    return BY_KEY[key]?.label || key;
  }

  /**
   * Combine Jev answers (may be null) and heuristics into per-field plans.
   * Returns [{uid, status, key, keyLabel, source, confidence, plan?, reason?}]
   *   status: "fill" | "skip" | "uncertain"
   */
  function decide(fields, data, jevAnswers, job) {
    // Jev alone must clear minConfidence; when the deterministic rules agree, a lower bar is fine.
    const minConfidence = Number(data.settings?.minConfidence ?? 0.75);
    const AGREE_FLOOR = 0; // agreement between two independent methods is the evidence
    const OVERRIDE = 0.9; // Jev overriding a confident, different pattern match on a text field
    const WEAK = 0.5; // below this, a Jev answer that contradicts a confident rule is ignored
    const overwrite = Boolean(data.settings?.overwrite);

    return fields.map((field) => {
      const base = { uid: field.uid };
      if (field.hasValue && !overwrite) return { ...base, status: "skip", reason: "already filled" };
      if (PHONE_COUNTRY_PICKER.test(field.label || "")) return { ...base, status: "skip", reason: "phone country picker (left as is)" };

      const h = heuristicKey(field, data);
      const j = jevAnswers ? jevAnswers[field.uid] : undefined;

      // Option fields answered by Jev pick an option index directly. The pattern matcher's
      // answer (computed deterministically from the profile) acts as a cross-check: a confident
      // label match that lands on a different option means one of them is wrong, so abstain.
      if (j && isOptionField(field)) {
        const hp = h ? planForKey(field, h.key, data, job) : null;
        const strongH = h && h.confidence >= 0.8 && hp;
        if (j.choice === NONE) {
          if (strongH) return { ...base, status: "uncertain", key: h.key, keyLabel: keyLabel(h.key), source: "heuristic", confidence: j.confidence, plan: hp, reason: "Jev found no answer; pattern match did" };
          return { ...base, status: "skip", source: "jev", confidence: j.confidence, reason: "not answerable from profile" };
        }
        const index = Number(j.choice.slice(4));
        const agrees = hp?.optionIndex === index;
        const plan = { action: "option", optionIndex: index, display: field.options[index].label };
        const key = h?.key;
        if (strongH && !agrees) {
          // A weak dissent doesn't block the deterministic answer; a confident one does.
          if (j.confidence < WEAK) return { ...base, status: "fill", key, keyLabel: keyLabel(key), source: "heuristic", confidence: j.confidence, plan: hp, reason: "" };
          return { ...base, status: "uncertain", key, keyLabel: keyLabel(key), source: "jev", confidence: j.confidence, plan, reason: `Jev and pattern match disagree (pattern: ${hp.display})` };
        }
        if (j.confidence >= minConfidence || (agrees && j.confidence >= AGREE_FLOOR)) {
          return { ...base, status: "fill", key, keyLabel: keyLabel(key), source: agrees ? "jev+heuristic" : "jev", confidence: j.confidence, plan };
        }
        return { ...base, status: "uncertain", key, keyLabel: keyLabel(key), source: "jev", confidence: j.confidence, plan, reason: "low confidence" };
      }

      if (j) {
        if (j.choice === NONE) {
          // Deterministic keys (dates, per-country answers) the rules resolved with a strong
          // label match are kept when Jev is merely unsure.
          if (!(h && h.confidence >= 0.8 && j.confidence < 0.9)) {
            return { ...base, status: "skip", source: "jev", confidence: j.confidence, reason: "no matching profile item" };
          }
        } else {
          const plan = planForKey(field, j.choice, data, job);
          const hPlan = h && h.key !== j.choice ? planForKey(field, h.key, data, job) : null;
          // Different keys that produce the same text (e.g. two name variants) still agree.
          const agrees = h?.key === j.choice || (plan && hPlan && plan.display === hPlan.display);
          const conflict = !agrees && h?.confidence >= 0.8 && hPlan;
          const info = { key: j.choice, keyLabel: keyLabel(j.choice), confidence: j.confidence, source: agrees ? "jev+heuristic" : "jev" };
          if (!plan) return { ...base, ...info, status: "skip", reason: "profile value missing" };
          if (agrees && j.confidence >= AGREE_FLOOR) return { ...base, ...info, status: "fill", plan };
          if (conflict && j.confidence < WEAK) return { ...base, key: h.key, keyLabel: keyLabel(h.key), confidence: j.confidence, source: "heuristic", status: "fill", plan: hPlan };
          if (conflict && j.confidence < OVERRIDE) {
            return { ...base, ...info, status: "uncertain", plan, reason: `Jev and pattern match disagree (pattern: ${hPlan.display})` };
          }
          if (j.confidence >= minConfidence) return { ...base, ...info, status: "fill", plan };
          return { ...base, ...info, status: "uncertain", plan, reason: "low confidence" };
        }
      }

      if (!h) return { ...base, status: "skip", source: j ? "jev" : "heuristic", reason: "unrecognized field" };
      const plan = planForKey(field, h.key, data, job);
      const info = { key: h.key, keyLabel: keyLabel(h.key), confidence: h.confidence, source: "heuristic" };
      if (!plan) return { ...base, ...info, status: "skip", reason: isOptionField(field) ? "no matching option" : "profile value missing" };
      return { ...base, ...info, status: h.confidence >= 0.5 ? "fill" : "uncertain", plan };
    });
  }

  root.JAF_CLASSIFY = { heuristicKey, buildJevRequests, parseJevResponse, decide, describeField, isOptionField, NONE };
})(typeof globalThis !== "undefined" ? globalThis : this);
