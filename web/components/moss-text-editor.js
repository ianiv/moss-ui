// <moss-text-editor>: form-associated textarea with a small toolbar and a live counter.
//
// Attributes: name, label, placeholder, rows (default 5), required, disabled, hint,
//   pause-button  show "Insert pause" + a seconds select (0.5/1.0/1.5/2.0, default 1.0) that inserts
//                 "[pause 1.0s]" at the caret with surrounding spaces,
//   count-lines   show "N lines → N jobs" in the footer while prop linesMode is true.
// Props: value (get/set), linesMode (bool), focus(), form, name, validity, validationMessage,
//   willValidate, checkValidity(), reportValidity().
// Form value: the text. Validity: valueMissing when required and blank (anchored on the textarea).
// Events: "input" and "change" re-dispatched from the host (bubbling, composed). Cmd/Ctrl+Enter is
//   left alone (the app shell handles it globally).
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, estimateSeconds } from "../lib/dom.js";

const styles = css`
  :host { display: block; }
  .head { display: flex; align-items: end; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: 6px; }
  .head label { margin: 0; }
  .tools { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  .tools select { width: auto; padding: 3px 6px; font-size: var(--fs-xs); }
  textarea { display: block; }
  .foot { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-2); margin-top: 4px; flex-wrap: wrap; }
  .count { font-size: var(--fs-xs); color: var(--text-3); margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .lines { color: var(--accent); font-weight: 500; }
`;

const PAUSES = ["0.5", "1.0", "1.5", "2.0"];

class MossTextEditor extends MossElement {
  static styles = [styles];
  static formAssociated = true;
  static delegatesFocus = true;
  static observedAttributes = ["label", "placeholder", "rows", "required", "disabled", "hint", "pause-button", "count-lines"];

  constructor() {
    super();
    this.internals = this.attachInternals();
    this._value = "";
    this._linesMode = false;
    this._formDisabled = false;
    this._sync();
  }

  render() {
    this.setHTML(html`
      <div class="head">
        <label for="ta" id="lbl"></label>
        <div class="tools" id="tools" hidden>
          <button type="button" class="small ghost" id="pause" title="Insert a pause at the cursor">${icon("pauseMark", 14)} Insert pause</button>
          <select id="pause-s" aria-label="Pause length in seconds">
            ${PAUSES.map((p) => html`<option value="${p}" ${p === "1.0" ? "selected" : ""}>${p} s</option>`)}
          </select>
        </div>
      </div>
      <textarea id="ta" spellcheck="true" aria-describedby="hint count"></textarea>
      <div class="foot">
        <span class="hint" id="hint"></span>
        <span class="count" id="count" aria-live="polite"></span>
      </div>
    `);
    const ta = this.$("#ta");
    ta.value = this._value;
    ta.addEventListener("input", (e) => {
      e.stopPropagation(); // replaced by a host-level event below
      this._value = ta.value;
      this._sync();
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    });
    ta.addEventListener("change", () => this.dispatchEvent(new Event("change", { bubbles: true, composed: true })));
    this.$("#pause").addEventListener("click", () => this.insertPause(this.$("#pause-s").value));
    this._applyAttrs();
    this._sync();
  }

  attributeChangedCallback() {
    if (this._rendered && this.shadowRoot.firstChild) this._applyAttrs();
    this._sync();
  }

  _applyAttrs() {
    const ta = this.$("#ta");
    if (!ta) return;
    const label = this.getAttribute("label");
    const lbl = this.$("#lbl");
    lbl.textContent = label || "";
    lbl.hidden = !label;
    if (!label) ta.setAttribute("aria-label", this.getAttribute("aria-label") || "Text");
    else ta.removeAttribute("aria-label");
    ta.placeholder = this.getAttribute("placeholder") || "";
    ta.rows = Math.max(1, parseInt(this.getAttribute("rows"), 10) || 5);
    ta.required = this.hasAttribute("required");
    ta.disabled = this.hasAttribute("disabled") || this._formDisabled;
    this.$("#tools").hidden = !this.hasAttribute("pause-button");
    this.$("#pause").disabled = ta.disabled;
    this.$("#pause-s").disabled = ta.disabled;
    this.$("#hint").textContent = this.getAttribute("hint") || "";
  }

  /** Update counter, form value and validity from the current text. */
  _sync() {
    const v = this._value;
    this.internals.setFormValue(v, v);
    const ta = this.$("#ta");
    if (this.hasAttribute("required") && !v.trim()) {
      this.internals.setValidity({ valueMissing: true }, "Please enter some text.", ta || undefined);
    } else {
      this.internals.setValidity({});
    }
    const count = this.$("#count");
    if (!count) return;
    const secs = estimateSeconds(v);
    let text = `${v.length} chars · ≈ ${secs.toFixed(1)} s`;
    count.textContent = text;
    if (this.hasAttribute("count-lines") && this._linesMode) {
      const n = this.lineCount;
      const span = document.createElement("span");
      span.className = "lines";
      span.textContent = `${n} line${n === 1 ? "" : "s"} → ${n} job${n === 1 ? "" : "s"}`;
      count.replaceChildren(span, document.createTextNode(` · ${text}`));
    }
  }

  /** Non-empty lines that don't start with "#" (what "one job per line" submits). */
  get lineCount() {
    return this._value.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  }

  /** Insert "[pause Ns]" at the caret, padded with spaces where needed. */
  insertPause(seconds = "1.0") {
    const ta = this.$("#ta");
    if (!ta || ta.disabled) return;
    const s = Number(seconds).toFixed(1);
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const pre = before && !/\s$/.test(before) ? " " : "";
    const post = after && /^\s/.test(after) ? "" : " ";
    const insert = `${pre}[pause ${s}s]${post}`;
    ta.focus();
    ta.setSelectionRange(start, end);
    // execCommand keeps the native undo stack and fires "input"; fall back to setRangeText.
    let ok = false;
    try { ok = document.execCommand("insertText", false, insert); } catch { ok = false; }
    if (!ok) {
      ta.setRangeText(insert, start, end, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  get value() {
    return this._value;
  }
  set value(v) {
    this._value = v == null ? "" : String(v);
    const ta = this.$("#ta");
    if (ta && ta.value !== this._value) ta.value = this._value;
    this._sync();
  }

  get linesMode() {
    return this._linesMode;
  }
  set linesMode(v) {
    this._linesMode = !!v;
    this._sync();
  }

  focus(opts) {
    const ta = this.$("#ta");
    if (ta) ta.focus(opts);
    else super.focus(opts);
  }

  // Form-associated plumbing.
  get form() { return this.internals.form; }
  get name() { return this.getAttribute("name"); }
  set name(v) { this.setAttribute("name", v); }
  get type() { return "textarea"; }
  get validity() { return this.internals.validity; }
  get validationMessage() { return this.internals.validationMessage; }
  get willValidate() { return this.internals.willValidate; }
  checkValidity() { return this.internals.checkValidity(); }
  reportValidity() { return this.internals.reportValidity(); }

  formResetCallback() {
    this.value = "";
  }
  formStateRestoreCallback(state) {
    if (typeof state === "string") this.value = state;
  }
  formDisabledCallback(disabled) {
    this._formDisabled = disabled;
    if (this.shadowRoot.firstChild) this._applyAttrs();
  }
}

define("moss-text-editor", MossTextEditor);
