// <moss-advanced>: form-associated <details> "Advanced" with optional generation fields.
//
// Attributes: name, disabled,
//   fields        comma list among language, instruction, seconds, ambient_sound (default: all four),
//   experimental  adds an "Experimental" checkbox revealing quality, sound_event, scene,
//   open          open the <details> (reflected both ways).
// Props: model (string; disables fields the model can't use: nano = all, fast = instruction; language
//   placeholder "English" for fast, "auto" otherwise), values (get: object of non-empty usable fields, numbers
//   as numbers; set: fills fields, missing keys cleared), reset(), form, name, validity, validationMessage,
//   willValidate, checkValidity(), reportValidity().
// Form value: FormData with the entries of `values`. Events: "input" / "change" (bubbling, composed).
import { MossElement, define } from "../lib/element.js";
import { css, html } from "../lib/dom.js";

const styles = css`
  :host { display: block; }
  details { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  summary { padding: var(--sp-2) var(--sp-3); display: flex; align-items: center; gap: var(--sp-2); list-style: none; border-radius: var(--radius); }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▸"; font-size: .8em; transition: transform var(--dur); }
  details[open] > summary::before { transform: rotate(90deg); }
  summary:focus-visible { outline: none; box-shadow: var(--focus); }
  .body { padding: 0 var(--sp-3) var(--sp-3); display: grid; gap: var(--sp-3); }
  .exp { border-top: 1px dashed var(--border); padding-top: var(--sp-3); display: grid; gap: var(--sp-3); }
  .field.off label { color: var(--text-3); }
  textarea { min-height: 3em; }
`;

const ALL = ["language", "instruction", "seconds", "ambient_sound"];
const EXPERIMENTAL = ["quality", "sound_event", "scene"];
const NUMERIC = new Set(["seconds"]);
const LANGUAGES = ["English", "Chinese", "Japanese", "Korean", "French", "German", "Spanish", "Italian", "Portuguese", "Russian", "Arabic"];

const FIELD = {
  language: () => html`
    <div class="field" data-key="language">
      <label for="f-language">Language</label>
      <input id="f-language" data-key="language" list="langs" autocomplete="off" placeholder="auto">
      <datalist id="langs">${LANGUAGES.map((l) => html`<option value="${l}"></option>`)}</datalist>
    </div>`,
  instruction: () => html`
    <div class="field" data-key="instruction">
      <label for="f-instruction">Instruction</label>
      <textarea id="f-instruction" data-key="instruction" rows="2" placeholder="e.g. Speak slowly and warmly, like a bedtime story" aria-describedby="h-instruction"></textarea>
      <div class="hint" id="h-instruction">How to say it: tone, pace, emotion.</div>
    </div>`,
  seconds: () => html`
    <div class="field" data-key="seconds">
      <label for="f-seconds">Target length (s)</label>
      <input id="f-seconds" data-key="seconds" type="number" min="0.5" step="0.5" inputmode="decimal" aria-describedby="h-seconds">
      <div class="hint" id="h-seconds">Too long for the text makes the model fill with babble; leave empty normally</div>
    </div>`,
  ambient_sound: () => html`
    <div class="field" data-key="ambient_sound">
      <label for="f-ambient_sound">Ambient sound under speech</label>
      <input id="f-ambient_sound" data-key="ambient_sound" placeholder="e.g. Rain falling on a window">
    </div>`,
  quality: () => html`
    <div class="field" data-key="quality">
      <label for="f-quality">Quality</label>
      <input id="f-quality" data-key="quality" placeholder="e.g. studio quality, clean">
    </div>`,
  sound_event: () => html`
    <div class="field" data-key="sound_event">
      <label for="f-sound_event">Sound event</label>
      <input id="f-sound_event" data-key="sound_event" placeholder="e.g. laughter">
    </div>`,
  scene: () => html`
    <div class="field" data-key="scene">
      <label for="f-scene">Scene</label>
      <input id="f-scene" data-key="scene" placeholder="e.g. a quiet library">
    </div>`,
};

class MossAdvanced extends MossElement {
  static styles = [styles];
  static formAssociated = true;
  static delegatesFocus = true;
  static observedAttributes = ["fields", "experimental", "open", "disabled"];

  constructor() {
    super();
    this.internals = this.attachInternals();
    this._values = {}; // key -> raw string
    this._expOn = false;
    this._model = "";
    this._formDisabled = false;
  }

  render() {
    this.setHTML(html`
      <details>
        <summary><span>Advanced</span><span class="badge accent" id="count" hidden></span></summary>
        <div class="body"></div>
      </details>
    `);
    const details = this.$("details");
    details.open = this.hasAttribute("open");
    details.addEventListener("toggle", () => {
      if (details.open !== this.hasAttribute("open")) this.toggleAttribute("open", details.open);
    });
    const body = this.$(".body");
    body.addEventListener("input", (e) => {
      const key = e.target.dataset?.key;
      if (key) this._values[key] = e.target.value;
      e.stopPropagation();
      this._sync();
      this._fire("input");
    });
    body.addEventListener("change", (e) => {
      if (e.target.id === "exp") {
        this._expOn = e.target.checked;
        this._applyState();
        this._sync();
      }
      this._fire("change");
    });
    this._build();
  }

  attributeChangedCallback(name) {
    if (!this.shadowRoot.firstChild) return;
    if (name === "open") {
      const d = this.$("details");
      if (d.open !== this.hasAttribute("open")) d.open = this.hasAttribute("open");
      return;
    }
    if (name === "disabled") this._applyState();
    else this._build();
  }

  get fields() {
    const attr = this.getAttribute("fields");
    if (!attr) return [...ALL];
    return attr.split(",").map((s) => s.trim()).filter((k) => ALL.includes(k));
  }

  /** (Re)build the field markup from attributes, keeping entered values. */
  _build() {
    const body = this.$(".body");
    if (!body) return;
    const exp = this.hasAttribute("experimental");
    body.innerHTML = String(html`
      ${this.fields.map((k) => FIELD[k]())}
      ${exp ? html`
        <label class="check"><input type="checkbox" id="exp"> Experimental</label>
        <div class="exp" id="exp-body" hidden>
          <p class="notice">Experimental prompt fields: untested with this mlx-audio build.</p>
          ${EXPERIMENTAL.map((k) => FIELD[k]())}
        </div>` : ""}
    `);
    for (const el of this.$$("[data-key]:is(input, textarea)")) el.value = this._values[el.dataset.key] ?? "";
    this._applyState();
    this._sync();
  }

  /** Enable/disable fields for the model and the experimental toggle. */
  _applyState() {
    if (!this.$(".body")) return;
    const all = this.hasAttribute("disabled") || this._formDisabled;
    const m = this._model;
    const exp = this.$("#exp");
    if (exp) {
      exp.checked = this._expOn;
      exp.disabled = all || m === "nano";
      this.$("#exp-body").hidden = !this._expOn;
    }
    for (const field of this.$$(".field[data-key]")) {
      const key = field.dataset.key;
      const el = field.querySelector("input, textarea");
      const off = all || !this._usable(key);
      el.disabled = off;
      field.classList.toggle("off", off);
      field.title = !all && off ? `Not used by the ${m} model` : "";
    }
    const lang = this.$("#f-language");
    if (lang) lang.placeholder = m === "fast" ? "English" : "auto";
  }

  _usable(key) {
    if (this._model === "nano") return false;
    if (this._model === "fast" && key === "instruction") return false;
    return true;
  }

  _fire(type) {
    this.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  /** Update count badge, form value and validity. */
  _sync() {
    const v = this.values;
    const n = Object.keys(v).length;
    const badge = this.$("#count");
    if (badge) {
      badge.hidden = n === 0;
      badge.textContent = String(n);
      badge.title = `${n} field${n === 1 ? "" : "s"} set`;
    }
    const fd = new FormData();
    for (const [k, val] of Object.entries(v)) fd.append(k, String(val));
    this.internals.setFormValue(fd, JSON.stringify({ values: this._values, exp: this._expOn }));
    const bad = this.$$("input, textarea").find((el) => !el.disabled && !el.closest("[hidden]") && !el.validity.valid);
    if (bad) {
      const flags = {};
      for (const k in bad.validity) if (k !== "valid" && bad.validity[k]) flags[k] = true;
      this.internals.setValidity(flags, bad.validationMessage || "Invalid value.", bad);
    } else {
      this.internals.setValidity({});
    }
  }

  // ---- public API -----------------------------------------------------------------------------

  get model() {
    return this._model;
  }
  set model(key) {
    this._model = key || "";
    this._applyState();
    this._sync();
  }

  /** Non-empty fields this model can use; experimental ones only while the checkbox is on. */
  get values() {
    const out = {};
    const keys = [...this.fields, ...(this.hasAttribute("experimental") && this._expOn ? EXPERIMENTAL : [])];
    for (const k of keys) {
      if (!this._usable(k)) continue;
      const raw = String(this._values[k] ?? "").trim();
      if (!raw) continue;
      if (NUMERIC.has(k)) {
        const n = Number(raw);
        if (Number.isFinite(n)) out[k] = n;
      } else {
        out[k] = raw;
      }
    }
    return out;
  }
  set values(obj) {
    this._values = {};
    for (const k of [...ALL, ...EXPERIMENTAL]) {
      const v = obj?.[k];
      if (v != null && v !== "") this._values[k] = String(v);
    }
    if (EXPERIMENTAL.some((k) => this._values[k])) this._expOn = true;
    for (const el of this.$$("[data-key]:is(input, textarea)")) el.value = this._values[el.dataset.key] ?? "";
    this._applyState();
    this._sync();
    if (Object.keys(this.values).length && !this.hasAttribute("open")) this.setAttribute("open", "");
  }

  reset() {
    this._values = {};
    this._expOn = false;
    for (const el of this.$$("[data-key]:is(input, textarea)")) el.value = "";
    this._applyState();
    this._sync();
  }

  // ---- form-associated plumbing ----------------------------------------------------------------

  get form() { return this.internals.form; }
  get name() { return this.getAttribute("name"); }
  set name(v) { this.setAttribute("name", v); }
  get type() { return "moss-advanced"; }
  get validity() { return this.internals.validity; }
  get validationMessage() { return this.internals.validationMessage; }
  get willValidate() { return this.internals.willValidate; }
  checkValidity() { return this.internals.checkValidity(); }
  reportValidity() { return this.internals.reportValidity(); }

  formResetCallback() {
    this.reset();
  }
  formStateRestoreCallback(state) {
    if (typeof state !== "string") return;
    try {
      const s = JSON.parse(state);
      this.values = s.values || {};
      this._expOn = !!s.exp;
      this._applyState();
      this._sync();
    } catch {
      /* ignore */
    }
  }
  formDisabledCallback(disabled) {
    this._formDisabled = disabled;
    this._applyState();
  }
}

define("moss-advanced", MossAdvanced);
