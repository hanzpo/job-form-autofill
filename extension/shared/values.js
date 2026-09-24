// Turns stored profile data into the concrete string a given form field should receive,
// and matches a desired answer against a field's options. Pure functions, no browser APIs.
(function (root) {
  const { FIELDS, MONTHS, DECLINE } = root.JAF_SCHEMA;
  const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

  const US_STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
    KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
    MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
    NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
    NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
    TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
  };

  // Country detection for per-country answers (work authorization, citizenship).
  // Normalized aliases; bare "us" is excluded (matches "work for us") and handled case-sensitively.
  const COUNTRY_ALIASES = {
    "United States": ["united states", "united states of america", "usa", "u s a"],
    "Canada": ["canada", "canadian", "ontario", "quebec", "british columbia", "alberta", "manitoba", "nova scotia", "saskatchewan", "new brunswick", "toronto", "vancouver", "montreal", "ottawa", "calgary", "waterloo"],
    "United Kingdom": ["united kingdom", "uk", "u k", "great britain", "britain", "england", "scotland", "wales", "northern ireland", "london", "manchester", "edinburgh", "cambridge uk"],
    "Ireland": ["ireland", "dublin"],
    "Germany": ["germany", "berlin", "munich"],
    "France": ["france", "paris"],
    "Netherlands": ["netherlands", "amsterdam"],
    "Spain": ["spain", "madrid", "barcelona"],
    "Italy": ["italy", "milan"],
    "Switzerland": ["switzerland", "zurich", "geneva"],
    "Sweden": ["sweden", "stockholm"],
    "Denmark": ["denmark", "copenhagen"],
    "Norway": ["norway", "oslo"],
    "Finland": ["finland", "helsinki"],
    "Poland": ["poland", "warsaw", "krakow"],
    "Portugal": ["portugal", "lisbon"],
    "Austria": ["austria", "vienna"],
    "Belgium": ["belgium", "brussels"],
    "Australia": ["australia", "sydney", "melbourne"],
    "New Zealand": ["new zealand", "auckland"],
    "India": ["india", "bangalore", "bengaluru", "hyderabad", "mumbai", "delhi", "pune"],
    "Singapore": ["singapore"],
    "Japan": ["japan", "tokyo"],
    "China": ["china", "shanghai", "beijing", "shenzhen"],
    "Hong Kong": ["hong kong"],
    "South Korea": ["south korea", "korea", "seoul"],
    "Taiwan": ["taiwan", "taipei"],
    "Israel": ["israel", "tel aviv"],
    "Mexico": ["mexico", "mexico city"],
    "Brazil": ["brazil", "sao paulo"],
    "Argentina": ["argentina", "buenos aires"],
    "United Arab Emirates": ["united arab emirates", "uae", "dubai"],
    "Philippines": ["philippines", "manila"],
  };
  const US_CITIES = ["san francisco", "new york", "nyc", "seattle", "boston", "austin", "chicago", "los angeles", "palo alto", "mountain view", "menlo park", "sunnyvale", "san jose", "bay area", "silicon valley", "denver", "atlanta", "miami"];
  const CA_PROVINCE_CODES = new Set(["ON", "QC", "BC", "AB", "MB", "NS", "SK", "NB", "NL", "PE"]);

  /** Earliest country mentioned in free text (labels, job locations), or null. */
  function countryFromText(text) {
    if (!text) return null;
    const raw = String(text);
    const padded = ` ${normalize(raw)} `;
    let best = null;
    const consider = (country, index) => {
      if (index >= 0 && (!best || index < best.index)) best = { country, index };
    };
    for (const [country, aliases] of Object.entries(COUNTRY_ALIASES)) {
      for (const a of aliases) consider(country, padded.indexOf(` ${a} `));
    }
    for (const name of Object.values(US_STATES)) consider("United States", padded.indexOf(` ${normalize(name)} `));
    for (const city of US_CITIES) consider("United States", padded.indexOf(` ${city} `));
    // Case-sensitive abbreviations on the raw text: "U.S.", "US", ", CA", ", ON".
    const us = /\bU\.?S\.?(A\.?)?(?![a-z])/.exec(raw);
    if (us) consider("United States", normalize(raw.slice(0, us.index)).length);
    const code = /,\s*([A-Z]{2})\b/.exec(raw);
    if (code) {
      const at = normalize(raw.slice(0, code.index)).length;
      if (US_STATES[code[1]]) consider("United States", at);
      else if (CA_PROVINCE_CODES.has(code[1])) consider("Canada", at);
    }
    return best ? best.country : null;
  }

  const WITHOUT_SPONSOR_RE = /\bwithout (the )?(need (for|of) |needing |requiring |requirement (for|of) |require )?(current or future |future )?(visa |employer |employment |immigration )?sponsor/;

  // Groups of interchangeable normalized strings.
  const SYNONYMS = [
    ["united states", "united states of america", "usa", "us", "u s", "u s a", "america"],
    ["united kingdom", "uk", "u k", "great britain", "england"],
    ["male", "man"],
    ["female", "woman"],
    ["non binary", "nonbinary", "non-binary"],
  ];

  const DECLINE_RE = /\bdecline\b|\bprefer not\b|\b(don ?t|do not) (wish|want)\b|\bchoose not\b|\bnot to (answer|disclose|say|specify)\b|\bwish not\b|\bnot (to )?self identify\b/;

  // Degree names vary wildly ("BS", "Bachelor of Science", "Bachelor's Degree"): compare levels.
  function degreeLevel(s) {
    const n = normalize(s);
    if (/\bph ?d\b|\bdoctor|\bdphil\b/.test(n)) return "doctorate";
    if (/\bmaster|\bm ?s\b|\bmba\b|\bm ?eng\b|\bm ?a\b|\bmsc\b/.test(n)) return "master";
    if (/\bbachelor|\bb ?s\b|\bb ?a\b|\bbsc\b|\bb ?eng\b|\bundergrad/.test(n)) return "bachelor";
    if (/\bassociate/.test(n)) return "associate";
    if (/\bhigh school\b|\bged\b|\bsecondary\b/.test(n)) return "high school";
    return null;
  }

  function normalize(s) {
    return String(s ?? "")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[_\-./:,;()[\]{}'"’*?!|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(s) {
    return normalize(s).split(" ").filter((t) => t.length > 1 || /\d/.test(t));
  }

  function similarity(a, b) {
    const ta = new Set(tokens(a));
    const tb = new Set(tokens(b));
    if (!ta.size || !tb.size) return 0;
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    return (2 * shared) / (ta.size + tb.size);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function monthNumber(month) {
    if (month == null || month === "") return null;
    const n = Number(month);
    if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
    const i = MONTHS.findIndex((m) => normalize(m).startsWith(normalize(month).slice(0, 3)));
    return i >= 0 ? i + 1 : null;
  }

  function splitList(s) {
    return String(s || "").split(/\s*(?:,|;|\/|\band\b|\n)\s*/i).map((x) => x.trim()).filter(Boolean);
  }

  function companyMatches(a, b) {
    const x = normalize(a).replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs)\b/g, "").trim();
    const y = normalize(b).replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs)\b/g, "").trim();
    return x.length >= 2 && y.length >= 2 && (x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `));
  }

  /**
   * The country a question is about: named in the question itself, else the job's country,
   * else the applicant's home country.
   */
  function targetCountry(data, ctx) {
    const f = ctx.field || {};
    return countryFromText(`${f.label || ""} ${f.hint || ""}`) || ctx.job?.country || countryFromText(data.profile?.country) || null;
  }

  /** {authorized, sponsorship} for a country from the work-authorization table, or null if unset. */
  function workAuthFor(country, data) {
    const rows = (data.workAuth || []).filter((r) => String(r.country || "").trim());
    if (!rows.length || !country) return null;
    const row = rows.find((r) => countryFromText(r.country) === country || normalize(r.country) === normalize(country));
    // Countries not in the table: not authorized, would need sponsorship.
    return row ? { authorized: "Yes", sponsorship: row.sponsorship === "Yes" ? "Yes" : "No" } : { authorized: "No", sponsorship: "Yes" };
  }

  function isYesNoField(field) {
    const opts = (field?.options || []).map((o) => normalize(o.label));
    return opts.some((o) => /^yes\b/.test(o)) && opts.some((o) => /^no\b/.test(o));
  }

  function isoToday() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /**
   * Raw profile value for a key (derived fields and defaults applied); "" when unknown.
   * ctx: {field, job} lets per-question answers depend on the question and the posting.
   */
  function resolve(key, data, ctx = {}) {
    const p = data.profile || {};
    if (key.startsWith("custom:")) {
      const answer = (data.customAnswers || [])[Number(key.slice(7))];
      return answer ? String(answer.answer ?? "").trim() : "";
    }
    const label = normalize(ctx.field?.label || "");
    switch (key) {
      case "work_authorization":
      case "sponsorship": {
        const auth = workAuthFor(targetCountry(data, ctx), data);
        if (!auth) return "";
        // "Authorized to work … without sponsorship?" is yes only if both hold.
        if (WITHOUT_SPONSOR_RE.test(label)) return auth.authorized === "Yes" && auth.sponsorship === "No" ? "Yes" : "No";
        return key === "sponsorship" ? auth.sponsorship : auth.authorized;
      }
      case "is_citizen": {
        const citizenships = splitList(p.citizenship).map(countryFromText).filter(Boolean);
        const country = targetCountry(data, ctx);
        if (!citizenships.length || !country) return "";
        return citizenships.includes(country) ? "Yes" : "No";
      }
      case "previously_employed": {
        const company = ctx.job?.company;
        if (!company) return "";
        const employers = [p.current_company, ...splitList(p.past_employers)].filter(Boolean);
        return employers.some((e) => companyMatches(e, company)) ? "Yes" : "No";
      }
      case "today":
        return isoToday();
      case "security_clearance": {
        const v = String(p.security_clearance || "").trim();
        if (v && isYesNoField(ctx.field)) return normalize(v) === "none" ? "No" : "Yes";
        return v;
      }
    }
    const own = String(p[key] ?? "").trim();
    if (own) return own;
    switch (key) {
      case "full_name":
        return [p.first_name, p.last_name].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
      case "preferred_name":
        return String(p.first_name ?? "").trim();
      case "location":
        return [p.city, p.state].map((s) => String(s ?? "").trim()).filter(Boolean).join(", ");
      case "graduation_date": {
        const m = monthNumber(p.graduation_month);
        const y = String(p.graduation_year ?? "").trim();
        if (!y) return "";
        return m ? `${MONTHS[m - 1]} ${y}` : y;
      }
      default:
        return BY_KEY[key]?.defaultValue ?? "";
    }
  }

  /** Format a resolved text value for a specific form field (date/month inputs, placeholders). */
  function formatForField(key, value, field, data) {
    if (!value) return value;
    const p = data.profile || {};
    const type = field.inputType || "";
    const hint = normalize(`${field.placeholder || ""} ${field.label || ""}`);

    if (key === "phone") {
      const max = Number(field.maxLength) || 0;
      if (max > 0 && value.length > max) {
        let digits = value.replace(/\D/g, "");
        if (digits.length > max && digits.startsWith("1")) digits = digits.slice(1);
        return digits;
      }
      return value;
    }

    if (key === "graduation_date" || key === "start_date" || key === "today") {
      let m, y, d = 1;
      if (key === "today") {
        [y, m, d] = value.split("-").map(Number);
        y = String(y);
        const iso = `${y}-${pad2(m)}-${pad2(d)}`;
        if (type === "date") return iso;
        if (/\bdd mm yyyy\b/.test(hint)) return `${pad2(d)}/${pad2(m)}/${y}`;
        if (/\byyyy mm dd\b/.test(hint)) return iso;
        return `${pad2(m)}/${pad2(d)}/${y}`;
      }
      if (key === "graduation_date") {
        m = monthNumber(p.graduation_month) || 5;
        y = String(p.graduation_year || "").trim();
      } else {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return value;
        m = parsed.getMonth() + 1; y = String(parsed.getFullYear()); d = parsed.getDate();
      }
      if (!/^\d{4}$/.test(y)) return value;
      if (type === "month") return `${y}-${pad2(m)}`;
      if (type === "date") return `${y}-${pad2(m)}-${pad2(d)}`;
      if (/\bmm dd yyyy\b/.test(hint)) return `${pad2(m)}/${pad2(d)}/${y}`;
      if (/\bdd mm yyyy\b/.test(hint)) return `${pad2(d)}/${pad2(m)}/${y}`;
      if (/\byyyy mm\b/.test(hint)) return `${y}-${pad2(m)}`;
      if (/\bmm yyyy\b/.test(hint)) return `${pad2(m)}/${y}`;
      if (/\bmm yy\b/.test(hint)) return `${pad2(m)}/${y.slice(2)}`;
      if (/^yyyy$/.test(hint) || type === "number") return y;
      return value;
    }
    if (key === "graduation_month") {
      const m = monthNumber(value);
      if (!m) return value;
      if (type === "number" || /\bmm\b/.test(hint)) return pad2(m);
      return MONTHS[m - 1];
    }
    if (type === "number") {
      const n = String(value).replace(/[^\d.]/g, "");
      return n || value;
    }
    return value;
  }

  function equivalents(value) {
    const n = normalize(value);
    const out = new Set([n]);
    for (const group of SYNONYMS) if (group.includes(n)) group.forEach((g) => out.add(g));
    const upper = String(value).trim().toUpperCase();
    if (US_STATES[upper]) out.add(normalize(US_STATES[upper]));
    for (const [abbr, name] of Object.entries(US_STATES)) if (normalize(name) === n) out.add(abbr.toLowerCase());
    const m = monthNumber(value);
    if (m && /^[a-z]+$/i.test(String(value).trim())) {
      out.add(String(m)); out.add(pad2(m)); out.add(normalize(MONTHS[m - 1]));
      out.add(normalize(MONTHS[m - 1]).slice(0, 3));
    }
    return out;
  }

  /**
   * Pick the option best matching a desired answer.
   * options: [{label, value}] → returns {index, score} or null.
   */
  function pickOption(options, desired, key) {
    if (!desired || !options?.length) return null;
    const wantedDegree = key === "degree" ? degreeLevel(desired) : null;
    const wanted = equivalents(desired);
    const nd = normalize(desired);
    const isYes = nd === "yes" || nd === "true";
    const isNo = nd === "no" || nd === "false";
    const isDecline = DECLINE_RE.test(nd) || nd === normalize(DECLINE);
    const scored = [];
    options.forEach((opt, index) => {
      const label = normalize(opt.label);
      const value = normalize(opt.value);
      if (!label && !value) return;
      if (/^(select|choose|please select|none selected|--)/.test(label) && !value) return;
      let score = 0;
      if (wanted.has(label) || (value && wanted.has(value))) score = 1;
      else if (isYes && /^yes\b/.test(label)) score = 0.9;
      else if (isNo && /^no\b/.test(label)) score = 0.9;
      else if (isDecline && DECLINE_RE.test(label)) score = 0.9;
      else if (!isDecline && DECLINE_RE.test(label)) score = 0;
      else if (wantedDegree && degreeLevel(opt.label) === wantedDegree) score = 0.85;
      else {
        score = Math.max(similarity(label, desired), value ? similarity(value, desired) : 0);
        if (nd.length >= 3 && label.length >= 3 && (label.includes(nd) || nd.includes(label))) {
          score = Math.max(score, 0.75);
        }
      }
      scored.push({ index, score, label });
    });
    scored.sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    if (!best || best.score < 0.5) return null;
    // Two different options matching equally well is a guess, not an answer: abstain.
    // (Several decline-to-answer variants are equivalent, so ties among them are fine.)
    if (second && best.score < 1 && second.score >= best.score - 0.001 && second.label !== best.label
      && !(isDecline && DECLINE_RE.test(best.label) && DECLINE_RE.test(second.label))) {
      return null;
    }
    return { index: best.index, score: best.score };
  }

  root.JAF_VALUES = { normalize, tokens, similarity, resolve, formatForField, pickOption, monthNumber, countryFromText, companyMatches, US_STATES };
})(typeof globalThis !== "undefined" ? globalThis : this);
