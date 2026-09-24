// Greenhouse/Ashby-style application built with real React + react-select, to exercise
// controlled inputs, comboboxes, async autocompletes, and a Workday-style listbox button.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Select from "react-select";
import AsyncSelect from "react-select/async";

const CITIES = ["San Francisco, California, United States", "San Diego, California, United States", "New York, New York, United States", "Seattle, Washington, United States"];

function ListboxButton({ id, label, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <label id={`${id}-label`}>{label}</label>
      <button type="button" id={id} aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${id}-label ${id}`}
        onClick={() => setOpen(!open)}>{value || "Select One"}</button>
      {open && (
        <ul role="listbox" id={`${id}-list`}>
          {options.map((o) => (
            <li key={o} role="option" aria-selected={o === value} onClick={() => { onChange(o); setOpen(false); }}>{o}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState({});
  const set = (k) => (v) => setState((s) => ({ ...s, [k]: v }));
  const text = (k, label, props = {}) => (
    <div className="field">
      <label htmlFor={k}>{label}</label>
      <input id={k} value={state[k] || ""} onChange={(e) => set(k)(e.target.value)} {...props} />
    </div>
  );
  const select = (k, label, options) => (
    <div className="field">
      <label id={`${k}-label`} htmlFor={k}>{label}</label>
      <Select inputId={k} aria-labelledby={`${k}-label`} options={options.map((o) => ({ label: o, value: o }))}
        onChange={(o) => set(k)(o?.value)} classNamePrefix="select" />
    </div>
  );
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <h2>Personal information</h2>
      {text("first_name", "First Name*")}
      {text("last_name", "Last Name*")}
      {text("email", "Email*", { type: "email" })}
      {text("phone", "Phone", { type: "tel" })}
      <div className="field">
        <label id="location-label" htmlFor="location">Location (City)</label>
        <AsyncSelect inputId="location" aria-labelledby="location-label" classNamePrefix="select" cacheOptions
          loadOptions={(input) => new Promise((r) => setTimeout(() => r(CITIES
            .filter((c) => c.toLowerCase().startsWith(input.toLowerCase().split(",")[0].trim()))
            .map((c) => ({ label: c, value: c }))), 150))}
          onChange={(o) => set("location")(o?.value)} />
      </div>
      <div className="field">
        <label htmlFor="resume">Resume/CV*</label>
        <input id="resume" type="file" onChange={(e) => set("resume")(e.target.files[0]?.name)} />
      </div>
      <h2>Education</h2>
      {text("school", "School")}
      {select("degree", "Degree", ["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctor of Philosophy (Ph.D.)"])}
      {text("grad", "Graduation date", { type: "month" })}
      <h2>Questions</h2>
      {select("authorized", "Are you legally authorized to work in the United States?*", ["Yes", "No"])}
      {select("sponsorship", "Will you now or in the future require visa sponsorship?*", ["Yes", "No"])}
      <ListboxButton id="source" label="How did you hear about us?" options={["LinkedIn", "Company Website", "Referral", "Other"]}
        value={state.source} onChange={set("source")} />
      <h2>Voluntary Self-Identification</h2>
      {select("gender", "Gender", ["Man", "Woman", "Non-binary", "I don't wish to answer"])}
      <pre id="state">{JSON.stringify(state)}</pre>
    </form>
  );
}

createRoot(document.getElementById("root")).render(<App />);
