# Job Form Autofill

A Safari web extension that detects the fields on a job application and fills them from a profile you set up once: name, contact info, links, location, education and graduation date, work history, eligibility questions, EEO self-identification, and your resume and cover letter files.

Field detection can use **[Jev](https://docs.typesafe.ai/introduction)**, TypeSafe's typed-decision model. Without an API key it falls back to built-in pattern matching.

When it detects an application form, an **⚡ Autofill application** button appears in the bottom-right corner. Click it to fill the form. It reappears for each new step of multi-page forms like Workday. (Profile → Settings has an option to fill without clicking.) It never submits. Outlines show what happened:

- **green:** filled
- **amber:** unsure, left empty
- **blue:** required, and only you can answer

When you answer a question yourself and submit, that answer is saved for the next application.

The rule throughout is **abstain rather than guess**. A field is left for you when:

- two options match equally well
- Jev and the deterministic rules disagree
- the answer depends on data you haven't provided (a clearance level, the company name for “have you worked here before?”)

## Install (Safari on macOS)

1. Build and run the app:
   - **Xcode:** open `safari/Job Form Autofill/Job Form Autofill.xcodeproj`, pick your team under *Signing & Capabilities* for both targets (or leave *Sign to Run Locally*), and press ⌘R.
   - **CLI:**
     ```bash
     cd "safari/Job Form Autofill"
     xcodebuild -scheme "Job Form Autofill" -configuration Debug -derivedDataPath ../../build \
       CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" build
     open "../../build/Build/Products/Debug/Job Form Autofill.app"
     ```
2. A locally signed build needs Safari to allow unsigned extensions. Turn on **Safari → Settings → Advanced → Show features for web developers**, then **Develop → Allow Unsigned Extensions**. Safari resets this each time it quits.
3. In **Safari → Settings → Extensions**, enable **Job Form Autofill** and set it to **Always Allow on Every Website**. Many applications (Greenhouse embeds, for example) live in cross-origin iframes, and Jev calls go to `api.typesafe.ai`.
4. Click the toolbar button, then **Profile**, and fill in your details and resume.

The Xcode project references the files in `extension/` rather than copying them. After editing the extension, rebuild the app (⌘R) and Safari picks up the change.

## Use it

Open an application and click **⚡ Autofill application** (or the toolbar button, or **⌥⇧F**). The toolbar popup shows what was filled. The popup groups the results:

| Group | Meaning |
| --- | --- |
| Double-check | Jev wasn't confident enough (below your threshold). Outlined amber and left empty. |
| Couldn't fill | A value was chosen but the page rejected it. |
| Needs you | Required fields it had no answer for, such as essays. |
| Filled | What was entered and where it came from. |
| Skipped | Unrecognized fields, fields that already had a value, and so on. |

**Saved answers** (on the Profile page) handle recurring questions. Answers you type yourself are added automatically when you submit or click Next. Questions that mention the company are skipped, since those don't carry over to other applications.

- **Pattern matching** reuses a learned answer only when the question is nearly identical (“Python experience?” ≠ “Rust experience?”).
- **Jev** judges whether a saved answer truly applies to the question.

**Per-country answers.** Work authorization, sponsorship, and citizenship questions are answered for the country the question names (“…to work in the UK?”). If it names none, they're answered for the job's country (from the posting's location, e.g. “Toronto, ON” → Canada), and failing that for your home country. The work-authorization table on the Profile page lists every country where you can work. For any country not listed, the answers are “not authorized” and “needs sponsorship”. “Authorized … *without* sponsorship?” is answered yes only if both hold.

**Job context.** The company comes from the page title (“… at Acme”), `og:site_name`, or the ATS URL (Greenhouse, Lever, Ashby, Workday, …). It's used for “Have you previously worked for Acme?” (checked against your current and past employers) and is sent to Jev along with the title and location.

## How detection works

`content.js` runs in every frame and turns the page's controls into plain descriptors. It covers:

- text inputs and textareas
- native selects
- radio groups and multi-checkbox groups
- file inputs
- ARIA comboboxes: react-select, Workday-style listbox buttons, and async autocompletes

Each descriptor carries the label (resolved from `aria-labelledby`, `aria-label`, `<label>`, or nearby text), the section heading, help text, and the options. Comboboxes are opened briefly to read their options.

`background.js` classifies all fields from all frames together:

- **Jev** gets one Choice question per field. All questions go in one request, split into chunks of 25 that run in parallel.
  - **Text and file fields:** "Which of the applicant's saved data items belongs in this field?" The options are the profile keys (e.g. `first_name`, `graduation_date`, `linkedin`), your saved answers, and `none`.
  - **Dropdowns, radios, and comboboxes:** "Given the applicant profile in `state`, which option should be selected?" The options are the field's own choices plus `none`.

  Answers are validated, and each is gated on Jev's `confidence` (0.5 by default, adjustable). A low-confidence answer is still filled if the pattern matcher independently agrees. The field is left for you instead when:
  - a confident pattern match on a dropdown or radio lands on a different option than Jev picked
  - Jev says “none” but the rules found an answer
- **Pattern matching** (`shared/schema.js`) uses ordered regexes over the label, `name`, `id`, and `autocomplete`, with exclusions for emergency contacts, referrers, middle names, and so on. It handles everything when there's no API key, if Jev errors, and for option lists too long for a Choice question (over 254 options).

The code, not the model, produces every value. `shared/values.js` formats dates for the field (`2026-05` for `type=month`, `05/2026` for an `MM/YYYY` placeholder). It also matches desired answers to option text, including yes/no variants, decline-to-answer phrasings, state abbreviations, country and gender synonyms, and degree levels.

Filling is written to work with React and other frameworks:

- Text values go through the native value setter, followed by `input`, `change`, and `blur` events.
- Files are attached through `DataTransfer`.
- Comboboxes are opened and the matching option is clicked.
- Files are filled first, because some ATSs parse the resume and prefill other fields from it.

**Privacy:** everything is stored in `browser.storage.local`. With Jev on, your profile values and the page title and URL go to TypeSafe on each autofill. Your files are never sent.

## Tests

```bash
npm install
npm test                                   # unit tests + end-to-end tests
TYPESAFE_API_KEY=… npm test                # also runs live Jev against the fixtures
```

The end-to-end tests load the same extension into headless Chromium, which runs the WebExtension APIs Safari does. They fill fixtures in `test/fixtures/`, and they also cover auto-run, multi-step forms, and learning:

- a Greenhouse-style form
- a Lever-style form
- a real React + react-select app, including an async location autocomplete and a Workday-style listbox
- a Greenhouse form embedded in a cross-origin iframe
- a Canada-based posting with country-specific eligibility questions

They run in heuristic mode and against a mock TypeSafe server.

## Limitations

- It won't write essays or free-form answers. Those land in **Needs you**.
- Repeating sections ("Add another job/school") are not expanded. Only the entries already shown are filled.
- Single consent checkboxes are deliberately left alone.
- Closed shadow roots and canvas-based forms can't be read.
