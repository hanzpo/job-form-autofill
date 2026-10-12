// The current Greenhouse application form (job-boards.greenhouse.io): every dropdown is a
// react-select that opens only on a click (not on a bare mousedown or ArrowDown), with a hidden
// "required" proxy input; the school field searches remotely and shows only a first page of
// results; the resume input is labelled "Attach" inside a labelled upload group.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Select from "react-select";
import AsyncSelect from "react-select/async";

const SCHOOLS = ["Aalto University", "Abilene Christian University", "Academy of Art University", "Adelphi University",
  "Stanford University", "Stanford Online High School", "University of California, Berkeley"];
const CITIES = ["San Francisco, California, United States", "San Francisco de Macorís, Duarte, Dominican Republic", "South San Francisco, California, United States"];
const opts = (list) => list.map((o) => ({ label: o, value: o }));

/** react-select whose menu is opened by click only, like Greenhouse's. */
function ClickSelect({ id, label, required, onChange, Component = Select, ...rest }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="field">
      <label id={`${id}-label`} htmlFor={id}>{label}{required && <span aria-hidden="true">*</span>}</label>
      <div onClick={() => setOpen(true)}>
        <Component inputId={id} aria-labelledby={`${id}-label`} classNamePrefix="select" required={required}
          menuIsOpen={open} onMenuOpen={() => {}} onMenuClose={() => setOpen(false)}
          onChange={(o) => { onChange(o?.value); setOpen(false); }} {...rest} />
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState({});
  const set = (k) => (v) => setState((s) => ({ ...s, [k]: v }));
  const text = (k, label) => (
    <div className="field">
      <label htmlFor={k}>{label}</label>
      <input id={k} value={state[k] || ""} onChange={(e) => set(k)(e.target.value)} />
    </div>
  );
  const select = (k, label, options, required) => (
    <ClickSelect id={k} label={label} options={opts(options)} required={required} onChange={set(k)} />
  );
  const search = (list, limit) => (input) => new Promise((r) => setTimeout(() => r(opts(list
    .filter((s) => !input || s.toLowerCase().includes(input.toLowerCase().split(",")[0].trim())).slice(0, limit))), 120));
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <h2>Apply for this job</h2>
      {text("first_name", "First Name*")}
      {text("last_name", "Last Name*")}
      {text("email", "Email*")}
      <ClickSelect id="candidate-location" label="Location (City)" required Component={AsyncSelect}
        loadOptions={search(CITIES, 10)} onChange={set("location")} />
      <div role="group" aria-labelledby="upload-label-resume" className="file-upload">
        <div id="upload-label-resume">Resume/CV<span>*</span></div>
        <button type="button">Attach</button>
        <label className="visually-hidden" htmlFor="resume">Attach</label>
        <input id="resume" className="visually-hidden" type="file" onChange={(e) => set("resume")(e.target.files[0]?.name)} />
      </div>
      <h3>Education</h3>
      <ClickSelect id="school--0" label="School" Component={AsyncSelect} defaultOptions
        loadOptions={search(SCHOOLS, 4)} onChange={set("school")} />
      {select("degree--0", "Degree", ["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree"])}
      {select("q_sponsorship", "Will you now or in the future require visa sponsorship?", ["Yes", "No"], true)}
      {select("q_worked", "Have you ever worked for Acme as an employee or contractor?",
        ["I currently work at Acme", "I have previously worked at Acme", "I have never worked at Acme"], true)}
      {select("q_pronouns", "What gender pronouns do you prefer?", ["He / Him", "She / Her", "Them / They", "I don’t wish to answer"])}
      <h2>Voluntary Self-Identification</h2>
      {select("gender", "Gender", ["Male", "Female", "Decline To Self Identify"])}
      {select("hispanic_ethnicity", "Are you Hispanic/Latino?", ["Yes", "No", "Decline To Self Identify"])}
      {select("veteran_status", "Veteran Status", ["I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", "I don't wish to answer"])}
      <pre id="state">{JSON.stringify(state)}</pre>
    </form>
  );
}

createRoot(document.getElementById("root")).render(<App />);
