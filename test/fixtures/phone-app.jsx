// Phone inputs with a separate country picker, as used by Ashby/Greenhouse-style forms.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import PhoneInput from "react-phone-number-input";
import { PhoneInput as IntlPhoneInput } from "react-international-phone";
import PhoneInput2 from "react-phone-input-2";
import { IMaskInput } from "react-imask";

function App() {
  const [a, setA] = useState();
  const [b, setB] = useState("");
  const [c, setC] = useState("");
  const [d, setD] = useState("");
  const [country, setCountry] = useState("+1 US");
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="email">Email</label><input id="email" type="email" />
      <label htmlFor="first">First name</label><input id="first" />
      <div>
        <label htmlFor="phone_a">Phone number*</label>
        <PhoneInput id="phone_a" defaultCountry="US" value={a} onChange={setA} placeholder="Phone number" />
      </div>
      <div>
        <label htmlFor="phone_b">Mobile phone</label>
        <IntlPhoneInput defaultCountry="us" value={b} onChange={setB} inputProps={{ id: "phone_b" }} />
      </div>
      <div>
        <label htmlFor="phone_c">Phone</label>
        <PhoneInput2 country="us" value={c} onChange={setC} inputProps={{ id: "phone_c" }} />
      </div>
      <div>
        <label htmlFor="phone_d">Contact phone number*</label>
        <select aria-label="Country code" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option>+1 US</option><option>+44 GB</option>
        </select>
        <IMaskInput id="phone_d" mask="(000) 000-0000" value={d} unmask={true} onAccept={(v) => setD(v)} placeholder="Phone number" />
      </div>
      <pre id="state">{JSON.stringify({ a: a || "", b, c, d })}</pre>
    </form>
  );
}
createRoot(document.getElementById("root")).render(<App />);
