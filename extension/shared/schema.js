// Profile schema shared by the options page, background classifier, and tests.
// Loaded as a classic script (options page <script>, service worker importScripts).
(function (root) {
  const YES_NO = ["Yes", "No"];
  const DECLINE = "Decline to self-identify";

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Each field: key, label (options UI), section, input (options UI control),
  // describe (what Jev sees as the option description), match (heuristic regex over
  // the normalized field descriptor, ordered: first match wins in `HEURISTIC_ORDER`).
  const FIELDS = [
    // Personal
    { key: "first_name", section: "Personal", label: "First name", describe: "Applicant's first / given name", match: /\b(first|given|fore) ?name\b|\bfname\b|^first$/ },
    { key: "last_name", section: "Personal", label: "Last name", describe: "Applicant's last / family name / surname", match: /\b(last|family|sur) ?name\b|\bsurname\b|\blname\b|^last$/ },
    { key: "preferred_name", section: "Personal", label: "Preferred name", describe: "Preferred first name or nickname the applicant goes by", match: /\bpreferred (first )?name\b|\bnick ?name\b|\bgoes by\b/ },
    { key: "full_name", section: "Personal", label: "Full name", derived: true, describe: "Applicant's full name (first and last together), e.g. a 'Name' or 'Full legal name' field or an e-signature", match: /\b(full|legal|your|candidate|applicant) name\b|^name$|\bsignature\b/ },
    { key: "pronouns", section: "Personal", label: "Pronouns", placeholder: "she/her, he/him, they/them…", describe: "Applicant's pronouns", match: /\bpronouns?\b/ },
    { key: "email", section: "Contact", label: "Email", input: "email", describe: "Email address", match: /\be ?mail\b/ },
    { key: "phone", section: "Contact", label: "Phone", input: "tel", describe: "Phone / mobile number", match: /\b(phone|mobile|cell|telephone)\b(?! (type|device))/ },
    { key: "linkedin", section: "Links", label: "LinkedIn URL", input: "url", describe: "LinkedIn profile URL", match: /\blinked ?in\b/ },
    { key: "github", section: "Links", label: "GitHub URL", input: "url", describe: "GitHub profile URL", match: /\bgit ?hub\b/ },
    { key: "website", section: "Links", label: "Website / portfolio", input: "url", describe: "Personal website, portfolio, or other personal URL", match: /\bportfolio\b|\bwebsite\b|\bpersonal (site|url|page)\b|\bblog\b|\bother (url|link|website)\b/ },
    { key: "twitter", section: "Links", label: "X / Twitter URL", input: "url", describe: "X (Twitter) profile URL", match: /\btwitter\b|\bx\.com\b/ },

    // Location
    { key: "location", section: "Location", label: "Current location", derived: true, placeholder: "Defaults to “City, State”", describe: "Where the applicant currently lives, as a single 'City, State' location string", match: /\blocation\b|\bwhere (are|do) you (currently )?(located|live|based|reside)\b|\bcurrent(ly)? (city|residence)\b|\bbased in\b/ },
    { key: "address_line1", section: "Location", label: "Street address", describe: "Street address line 1", match: /\bstreet\b|\baddress( line)? ?1\b|\b(home|mailing|residential|street) address\b|^address$/ },
    { key: "address_line2", section: "Location", label: "Address line 2", describe: "Street address line 2 (apartment, suite, unit)", match: /\baddress( line)? ?2\b|\bapt\b|\bapartment\b|\bsuite\b/ },
    { key: "city", section: "Location", label: "City", describe: "City of residence", match: /\bcity\b|\btown\b/ },
    { key: "state", section: "Location", label: "State / province", describe: "State / province / region of residence", match: /\bstate\b|\bprovince\b|\bregion\b/ },
    { key: "postal_code", section: "Location", label: "ZIP / postal code", describe: "ZIP or postal code", match: /\bzip\b|\bpostal\b|\bpost ?code\b/ },
    { key: "country", section: "Location", label: "Country", placeholder: "United States", describe: "Country of residence", match: /\bcountry\b/ },

    // Education
    { key: "school", section: "Education", label: "School / university", describe: "Name of school, college, or university attended", match: /\bschool\b|\buniversity\b|\bcollege\b|\binstitution\b|\balma mater\b/ },
    { key: "degree", section: "Education", label: "Degree", placeholder: "Bachelor of Science", describe: "Degree earned or pursuing (e.g. Bachelor's, Master's) or highest level of education", match: /\bdegree\b|\b(level of|highest) education\b|\beducation level\b/ },
    { key: "major", section: "Education", label: "Major / field of study", placeholder: "Computer Science", describe: "Major, field of study, discipline, or concentration", match: /\bmajor\b|\bfield of study\b|\bdiscipline\b|\bconcentration\b|\barea of study\b/ },
    { key: "gpa", section: "Education", label: "GPA", describe: "Grade point average (GPA)", match: /\bgpa\b|\bgrade point\b/ },
    { key: "graduation_month", section: "Education", label: "Graduation month", input: "select", options: MONTHS, describe: "Month of graduation only (a month field)", match: /\bgrad(uation)?\b.*\bmonth\b|\bmonth\b.*\bgrad/ },
    { key: "graduation_year", section: "Education", label: "Graduation year", input: "number", placeholder: "2026", describe: "Year of graduation only (a year field), 'class of' year", match: /\bgrad(uation)?\b.*\byear\b|\byear\b.*\bgrad|\bclass of\b/ },
    { key: "graduation_date", section: "Education", label: "Graduation date", derived: true, describe: "Graduation date or expected graduation date (month and year together)", match: /\bgrad(uation|uate|uating)?\b.*\b(date|when)\b|\bexpected grad|\bcompletion date\b|\bwhen\b.*\bgraduat/ },

    // Work
    { key: "current_company", section: "Work", label: "Current / most recent company", describe: "Applicant's current or most recent employer / company name", match: /\bcurrent (company|employer|organi[sz]ation)\b|\b(most recent|latest|present) (company|employer)\b|^(company|employer)( name)?$/ },
    { key: "current_title", section: "Work", label: "Current / most recent title", describe: "Applicant's current or most recent job title", match: /\bcurrent (job )?(title|role|position)\b|\bjob title\b|^title$/ },
    { key: "years_experience", section: "Work", label: "Years of experience", input: "number", describe: "Number of years of professional experience", match: /\byears? of (professional |relevant |work )?experience\b|\bhow many years\b/ },

    { key: "past_employers", section: "Work", label: "Past employers", placeholder: "Comma-separated, e.g. Google, Stripe", describe: "Companies the applicant has worked for in the past", match: /\b(previous|past|former) employers?\b/ },

    // Logistics / eligibility. Work authorization and sponsorship are answered per country
    // from the work-authorization table (see values.js), so they are derived here.
    { key: "work_authorization", section: "Eligibility", label: "Work authorization", derived: true, hidden: true, describe: "Whether the applicant is legally authorized / eligible to work in the country the question or job refers to", match: /\bauthori[sz](ed|ation) to work\b|\blegally (authori[sz]ed|eligible|able|permitted)\b|\bwork authori[sz]ation\b|\beligib\w* to work\b|\bright to work\b|\bwork permit\b|\bpermitted to work\b/ },
    { key: "sponsorship", section: "Eligibility", label: "Sponsorship", derived: true, hidden: true, describe: "Whether the applicant will now or in the future require visa / employment sponsorship for the country the question or job refers to", match: /\bsponsor/ },
    { key: "citizenship", section: "Eligibility", label: "Citizenship", placeholder: "United States", describe: "The applicant's country (or countries) of citizenship / nationality", match: /\bcitizenship\b|\bnationality\b/ },
    { key: "is_citizen", section: "Eligibility", label: "Citizen of country?", derived: true, hidden: true, describe: "Whether the applicant is a citizen of the country named in the question (or the job's country)", match: /\bare you (a |an )?([\w.]+ ){0,3}citizen\b|\bcitizen of\b|\bcitizen or (national|permanent)\b/ },
    { key: "security_clearance", section: "Eligibility", label: "Security clearance", input: "select", options: ["None", "Confidential", "Secret", "Top Secret", "Top Secret/SCI"], describe: "Government security clearance the applicant currently holds (None if none)", match: /\bclearance\b/ },
    { key: "over_18", section: "Eligibility", label: "18 years or older?", input: "select", options: YES_NO, defaultValue: "Yes", describe: "Whether the applicant is at least 18 years old", match: /\b18 years\b|\bover 18\b|\bat least 18\b|\b18 or older\b|\blegal (working )?age\b/ },
    { key: "over_21", section: "Eligibility", label: "21 years or older?", input: "select", options: YES_NO, describe: "Whether the applicant is at least 21 years old", match: /\b21 years\b|\bover 21\b|\bat least 21\b|\b21 or older\b/ },
    { key: "relocate", section: "Eligibility", label: "Willing to relocate?", input: "select", options: YES_NO, describe: "Whether the applicant is willing to relocate", match: /\breloca/ },
    { key: "onsite", section: "Eligibility", label: "Able to work onsite / hybrid?", input: "select", options: YES_NO, describe: "Whether the applicant is able / willing to work onsite, in office, or hybrid at the job's location", match: /\b(on ?site|in ?office|in ?person|hybrid)\b|\bcommut/ },
    { key: "non_compete", section: "Eligibility", label: "Bound by a non-compete / non-solicit?", input: "select", options: YES_NO, describe: "Whether the applicant is bound by a non-compete, non-solicitation, or similar restrictive agreement", match: /\bnon ?compete\b|\bnon ?solicit|\brestrictive covenant/ },
    { key: "felony", section: "Eligibility", label: "Ever convicted of a felony?", input: "select", options: YES_NO, describe: "Whether the applicant has ever been convicted of a felony / crime", match: /\bconvict|\bfelon|\bcriminal (record|history|offen[cs]e)/ },
    { key: "messaging_consent", section: "Eligibility", label: "Receive text / marketing messages?", input: "select", options: YES_NO, defaultValue: "No", describe: "Whether the applicant agrees to receive text messages (SMS), marketing, newsletters, or other optional communications", match: /\btext messages?\b|\bsms\b|\bmarketing\b|\bnewsletters?\b|\bopt ?in\b|\breceive (updates|communications|e ?mails|texts|job alerts)\b|\bjob alerts?\b|\btalent (community|network)\b/ },
    { key: "previously_employed", section: "Eligibility", label: "Previously employed here?", derived: true, hidden: true, describe: "Whether the applicant has previously worked for (been employed by) the hiring company", match: /\b(previously|ever|formerly) (been )?(employed|worked)\b|\bformer employee\b|\bworked (here|for us|for this company) before\b|\bcurrent or former (employee|contractor)\b/ },
    { key: "start_date", section: "Eligibility", label: "Earliest start date / availability", placeholder: "June 2026, or 2 weeks notice", describe: "When the applicant can start / availability / notice period", match: /\bstart date\b|\b(available|able) to start\b|\bwhen can you (start|begin)\b|\bearliest\b.*\bstart\b|\bavailability\b|\bnotice period\b/ },
    { key: "salary", section: "Eligibility", label: "Desired salary", placeholder: "$120,000", describe: "Desired salary / compensation expectations", match: /\bsalary\b|\bcompensation\b|\bpay (expectation|requirement)s?\b|\bdesired pay\b/ },
    { key: "how_heard", section: "Eligibility", label: "How did you hear about us?", placeholder: "LinkedIn", describe: "How the applicant heard about / found the job (source)", match: /\bhow did you (hear|find|learn|come across)\b|\bwhere did you (hear|find|learn)\b|\b(referral|application|lead|candidate) source\b|^source$/ },
    { key: "today", section: "Eligibility", label: "Today's date", derived: true, hidden: true, describe: "Today's date (e.g. the date next to an e-signature)", match: /\btoday'? ?s? date\b|\bdate signed\b|\bsignature date\b|^date$/ },

    // Voluntary self-identification (EEO)
    { key: "gender", section: "Voluntary self-identification", label: "Gender", input: "select", options: ["Male", "Female", "Non-binary", DECLINE], defaultValue: DECLINE, describe: "Applicant's gender (voluntary self-identification)", match: /\bgender\b|^sex$/ },
    { key: "hispanic_latino", section: "Voluntary self-identification", label: "Hispanic or Latino?", input: "select", options: ["Yes", "No", DECLINE], defaultValue: DECLINE, describe: "Whether the applicant is Hispanic or Latino (voluntary self-identification)", match: /\bhispanic\b|\blatin[oax]\b/ },
    { key: "race", section: "Voluntary self-identification", label: "Race / ethnicity", input: "select", options: ["American Indian or Alaska Native", "Asian", "Black or African American", "Hispanic or Latino", "Native Hawaiian or Other Pacific Islander", "White", "Two or More Races", DECLINE], defaultValue: DECLINE, describe: "Applicant's race / ethnicity (voluntary self-identification)", match: /\brace\b|\bethnic/ },
    { key: "veteran", section: "Voluntary self-identification", label: "Veteran status", input: "select", options: ["I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", DECLINE], defaultValue: DECLINE, describe: "Applicant's veteran / military status (voluntary self-identification)", match: /\bveteran\b|\bmilitary\b/ },
    { key: "disability", section: "Voluntary self-identification", label: "Disability status", input: "select", options: ["No, I do not have a disability", "Yes, I have a disability", DECLINE], defaultValue: DECLINE, describe: "Applicant's disability status (voluntary self-identification)", match: /\bdisabilit/ },

    // Files
    { key: "resume", section: "Documents", label: "Resume (PDF)", input: "file", describe: "Upload the applicant's resume / CV file", match: /\bresume\b|\brésumé\b|\bcv\b|\bcurriculum vitae\b/ },
    { key: "cover_letter", section: "Documents", label: "Cover letter (PDF)", input: "file", describe: "Upload the applicant's cover letter file", match: /\bcover ?letter\b/ },
  ];

  // Heuristic match order: specific before generic (e.g. "email address" must not hit address,
  // "company name" must not hit full_name, "graduation year" before plain dates).
  const HEURISTIC_ORDER = [
    "resume", "cover_letter",
    "email", "linkedin", "github", "twitter",
    "preferred_name", "first_name", "last_name",
    "graduation_month", "graduation_year", "graduation_date",
    "messaging_consent", "previously_employed", "is_citizen", "citizenship", "security_clearance", "non_compete", "felony",
    "sponsorship", "work_authorization", "over_21", "over_18", "relocate", "onsite",
    "hispanic_latino", "race", "gender", "veteran", "disability", "pronouns",
    "how_heard", "salary", "start_date", "today", "years_experience",
    "past_employers", "current_company", "current_title",
    "school", "degree", "major", "gpa",
    "address_line2", "address_line1", "postal_code", "country", "location", "city", "state",
    "phone", "website", "full_name",
  ];

  // Fields whose descriptor contains these are never auto-filled by heuristics
  // (emergency contacts, references, referrers, middle names…).
  const HEURISTIC_EXCLUDE = /\bemergency\b|\breference\b|\breferr(ed|er|ing)\b|\breferral name\b|\bmiddle\b|\bmanager\b|\bsupervisor\b|\bparent\b|\bguardian\b|\bcountry (selector|code)\b|\bdial(ing)? code\b/;

  root.JAF_SCHEMA = { FIELDS, HEURISTIC_ORDER, HEURISTIC_EXCLUDE, MONTHS, DECLINE };
})(typeof globalThis !== "undefined" ? globalThis : this);
