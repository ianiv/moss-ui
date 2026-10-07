// <moss-voice-picker>: form-associated picker for a library voice, with a searchable popover list.
//
// Attributes: name, label, required, disabled, compact,
//   allow-none          adds a "Model voice (none)" choice (value ""); none-label overrides its text,
//   none-label,
//   require-transcript  voices without a transcript get a warning badge and can't be picked.
// Props: value (voice id or ""), voice (the store voice object or null), form, name, validity,
//   validationMessage, willValidate, checkValidity(), reportValidity(), open(), close().
// Form value: the voice id. Validity: valueMissing when required and empty; customError when
//   require-transcript and the chosen voice has no transcript. Anchor: the trigger button.
// Events: "change" (bubbling, composed) when the user picks, or when the selected voice disappears from the
//   library (value cleared).
// UI: trigger button -> popover with a search box (filters name/description/transcript), voice rows (name,
//   one-line description, duration, "no transcript" badge, preview ▶ via one shared Audio element) and a
//   "Manage voices" link. Keys: ArrowUp/Down move, Home/End, Enter picks, Escape closes.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, fmtSeconds } from "../lib/dom.js";
import { store } from "../lib/store.js";

const styles = css`
  :host { display: block; }
  .trigger { width: 100%; justify-content: space-between; text-align: left; padding: 8px 10px; font-size: var(--fs-md); font-weight: 400; }
  :host([compact]) .trigger { padding: 4px 8px; font-size: var(--fs-sm); }
  .trigger .cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .trigger .none { color: var(--text-2); }
  .trigger .caret { color: var(--text-3); flex: none; }
  .trigger .badge { flex: none; }
  #lbl { margin-bottom: 6px; }
  #pop { position: fixed; inset: auto; margin: 0; padding: 0; width: 360px; max-width: calc(100vw - 16px); overflow: hidden; }
  #pop:popover-open { display: flex; flex-direction: column; }
  .search { padding: var(--sp-2); border-bottom: 1px solid var(--border); }
  ul { list-style: none; margin: 0; padding: 4px; overflow: auto; flex: 1 1 auto; min-height: 0; }
  li { display: flex; align-items: stretch; gap: 2px; border-radius: var(--radius-sm); }
  li.cur { background: var(--accent-soft); }
  .pick {
    flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; justify-items: start; text-align: left; border: 0; background: transparent;
    padding: 6px 8px; font-weight: 400; white-space: normal;
  }
  .pick:hover:not([aria-disabled=true]) { background: var(--surface-2); }
  .pick[aria-disabled=true] { cursor: not-allowed; opacity: .7; }
  .name { font-weight: 600; font-size: var(--fs-sm); display: flex; gap: 6px; align-items: center; width: 100%; }
  .name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .desc { font-size: var(--fs-xs); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; }
  .dur { margin-left: auto; font-size: var(--fs-xs); color: var(--text-3); font-weight: 400; font-variant-numeric: tabular-nums; }
  .play { align-self: center; flex: none; }
  .empty-list { padding: var(--sp-4); text-align: center; color: var(--text-3); font-size: var(--fs-sm); }
  .foot { border-top: 1px solid var(--border); padding: var(--sp-2) var(--sp-3); display: flex; justify-content: space-between; align-items: center; font-size: var(--fs-sm); }
`;

// One preview <audio> shared by every picker; it plays nicely with <moss-waveform-player>'s "moss-play" broadcast.
const preview = new Audio();
preview.preload = "none";
let previewId = null;
const previewEvents = new EventTarget();
function stopPreview() {
  preview.pause();
  if (previewId != null) {
    previewId = null;
    previewEvents.dispatchEvent(new Event("change"));
  }
}
function togglePreview(voice) {
  if (previewId === voice.id && !preview.paused) {
    stopPreview();
    return;
  }
  if (!voice.audio_url) return;
  previewId = voice.id;
  preview.src = voice.audio_url;
  preview.currentTime = 0;
  window.dispatchEvent(new CustomEvent("moss-play", { detail: preview }));
  preview.play().catch(() => stopPreview());
  previewEvents.dispatchEvent(new Event("change"));
}
preview.addEventListener("ended", stopPreview);
preview.addEventListener("pause", () => {
  if (previewId != null) {
    previewId = null;
    previewEvents.dispatchEvent(new Event("change"));
  }
});
window.addEventListener("moss-play", (e) => {
  if (e.detail !== preview) stopPreview();
});

const hasTranscript = (v) => !!(v?.transcript && String(v.transcript).trim());

class MossVoicePicker extends MossElement {
  static styles = [styles];
  static formAssociated = true;
  static delegatesFocus = true;
  static observedAttributes = ["label", "required", "disabled", "allow-none", "none-label", "require-transcript"];

  constructor() {
    super();
    this.internals = this.attachInternals();
    this._value = "";
    this._query = "";
    this._formDisabled = false;
    this._sync();
  }

  render() {
    this.setHTML(html`
      <label id="lbl" for="trigger"></label>
      <button type="button" class="trigger" id="trigger" popovertarget="pop" aria-haspopup="dialog" aria-expanded="false"
        aria-labelledby="lbl cur">
        <span class="cur" id="cur"></span>
        <span class="badge warn" id="warn" hidden>no transcript</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
      <div id="pop" popover role="dialog" aria-label="Choose a voice">
        <div class="search">
          <input type="search" id="q" placeholder="Search voices" aria-label="Search voices" autocomplete="off" aria-controls="list">
        </div>
        <ul id="list" aria-label="Voices"></ul>
        <div class="foot">
          <span class="hint" id="n"></span>
          <a href="#/library?tab=voices" id="manage">Manage voices</a>
        </div>
      </div>
    `);
    const pop = this.$("#pop");
    const trigger = this.$("#trigger");
    pop.addEventListener("beforetoggle", (e) => {
      if (e.newState === "open") {
        this._renderList();
        this._position();
      }
    });
    pop.addEventListener("toggle", (e) => {
      const open = e.newState === "open";
      trigger.setAttribute("aria-expanded", String(open));
      if (open) {
        const q = this.$("#q");
        q.focus();
        q.select();
      } else {
        stopPreview();
      }
    });

    this.$("#q").addEventListener("input", (e) => {
      e.stopPropagation();
      this._query = e.target.value;
      this._renderList();
    });
    this.$("#q").addEventListener("change", (e) => e.stopPropagation());
    pop.addEventListener("keydown", (e) => this._onKey(e));
    this.$("#list").addEventListener("click", (e) => {
      const play = e.target.closest("button.play");
      if (play) {
        const v = store.voice(play.dataset.id);
        if (v) togglePreview(v);
        return;
      }
      const pick = e.target.closest("button.pick");
      if (pick) this._pick(pick);
    });
    this.$("#manage").addEventListener("click", () => this.close());
    this._applyAttrs();
    this._sync();
  }

  connected() {
    store.on("voices", () => this._onVoices(true), this.signal);
    this.on(window, "resize", () => this._isOpen() && this._position());
    this.on(window, "scroll", () => this._isOpen() && this._position(), { capture: true, passive: true });

    previewEvents.addEventListener("change", () => this._isOpen() && this._updatePlayButtons(), { signal: this.signal });
    this._onVoices(store.voices.length > 0);
  }

  attributeChangedCallback() {
    if (this.shadowRoot.firstChild) {
      this._applyAttrs();
      if (this._isOpen()) this._renderList();
    }
    this._sync();
  }

  // ---- state ------------------------------------------------------------------------------------

  get noneLabel() {
    return this.getAttribute("none-label") || "Model voice (none)";
  }

  /** loaded: the store's voice list is authoritative (a "voices" event, or a non-empty list). */
  _onVoices(loaded = true) {
    if (loaded && this._value && !store.voice(this._value)) {
      // The selected voice was deleted: clear it.
      this._value = "";
      this._sync();
      this._fire("change");
    } else {
      this._sync();
    }
    if (this._isOpen()) this._renderList();
  }

  _fire(type) {
    this.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  _applyAttrs() {
    const lbl = this.$("#lbl");
    const label = this.getAttribute("label");
    lbl.textContent = label || "";
    lbl.hidden = !label;
    const trigger = this.$("#trigger");
    trigger.setAttribute("aria-labelledby", label ? "lbl cur" : "cur");
    trigger.disabled = this.hasAttribute("disabled") || this._formDisabled;
    if (trigger.disabled) this.close();
  }

  /** Form value, validity, trigger text. */
  _sync() {
    const v = this.voice;
    this.internals.setFormValue(this._value, this._value);
    const anchor = this.$("#trigger") || undefined;
    if (this.hasAttribute("required") && !this._value) {
      this.internals.setValidity({ valueMissing: true }, "Choose a voice.", anchor);
    } else if (this._value && !v && store.voices.length) {
      this.internals.setValidity({ customError: true }, `Voice "${this._value}" is not in the library.`, anchor);
    } else if (this._value && v && this.hasAttribute("require-transcript") && !hasTranscript(v)) {
      this.internals.setValidity({ customError: true }, `"${v.name}" has no transcript; add one in the voice library.`, anchor);
    } else {
      this.internals.setValidity({});
    }
    const cur = this.$("#cur");
    if (!cur) return;
    if (this._value) {
      cur.textContent = v ? v.name : `${this._value} (not found)`;
      cur.classList.remove("none");
      this.$("#trigger").title = v?.description || "";
    } else {
      cur.textContent = this.hasAttribute("allow-none") ? this.noneLabel : "Choose a voice…";
      cur.classList.add("none");
      this.$("#trigger").title = "";
    }
    this.$("#warn").hidden = !(v && this.hasAttribute("require-transcript") && !hasTranscript(v));
  }

  // ---- popover ------------------------------------------------------------------------------------

  _isOpen() {
    return !!this.$("#pop")?.matches(":popover-open");
  }

  open() {
    const pop = this.$("#pop");
    if (pop && !this._isOpen() && !this.$("#trigger").disabled) pop.showPopover();
  }

  close() {
    const pop = this.$("#pop");
    if (pop && this._isOpen()) pop.hidePopover();
  }

  /** Place the popover under (or above) the trigger; fixed positioning, no anchor positioning needed. */
  _position() {
    const pop = this.$("#pop");
    const r = this.$("#trigger").getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 320), vw - 16);
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 260 && above > below;
    const maxH = Math.max(160, Math.min(420, (up ? above : below) - 4));
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${maxH}px`;
    pop.style.left = `${Math.min(Math.max(8, r.left), vw - width - 8)}px`;
    if (up) {
      pop.style.top = "auto";
      pop.style.bottom = `${vh - r.top + 4}px`;
    } else {
      pop.style.bottom = "auto";
      pop.style.top = `${r.bottom + 4}px`;
    }
  }

  _filtered() {
    const q = this._query.trim().toLowerCase();
    const voices = store.voices || [];
    if (!q) return voices;
    return voices.filter((v) => [v.name, v.description, v.transcript, v.id].some((s) => s && String(s).toLowerCase().includes(q)));
  }

  _renderList() {
    const list = this.$("#list");
    if (!list) return;
    const needT = this.hasAttribute("require-transcript");
    const voices = this._filtered();
    const rows = [];
    if (this.hasAttribute("allow-none") && !this._query.trim()) {
      rows.push(html`
        <li class="${this._value ? "" : "cur"}">
          <button type="button" class="pick" data-id="" aria-current="${this._value ? "false" : "true"}">
            <span class="name"><span>${this.noneLabel}</span></span>
            <span class="desc">The model picks a voice for each take</span>
          </button>
        </li>`);
    }
    for (const v of voices) {
      const noT = !hasTranscript(v);
      const blocked = needT && noT;
      rows.push(html`
        <li class="${v.id === this._value ? "cur" : ""}">
          <button type="button" class="pick" data-id="${v.id}" aria-current="${v.id === this._value ? "true" : "false"}"
            aria-disabled="${blocked ? "true" : "false"}" title="${blocked ? "Needs a transcript: add one in the voice library" : v.description || ""}">
            <span class="name">
              <span>${v.name || v.id}</span>
              ${noT ? html`<span class="badge warn">no transcript</span>` : ""}
              <span class="dur">${v.duration_s ? fmtSeconds(v.duration_s) : ""}</span>
            </span>
            ${v.description ? html`<span class="desc">${v.description}</span>` : ""}
          </button>
          ${v.has_audio !== false && v.audio_url
            ? html`<button type="button" class="icon ghost play" data-id="${v.id}" aria-label="Preview ${v.name || v.id}" aria-pressed="false">${icon("play", 14)}</button>`
            : ""}
        </li>`);
    }
    if (!rows.length) {
      const msg = store.voices.length ? "No voices match." : "No voices yet. Record, upload or design one in the library.";
      list.innerHTML = String(html`<li class="empty-list">${msg}</li>`);
    } else {
      list.innerHTML = rows.map(String).join("");
    }
    const n = voices.length;
    this.$("#n").textContent = `${n} voice${n === 1 ? "" : "s"}`;
    this._updatePlayButtons();
  }

  _updatePlayButtons() {
    for (const b of this.$$("button.play")) {
      const on = previewId === b.dataset.id;
      b.setAttribute("aria-pressed", String(on));
      b.innerHTML = String(icon(on ? "pause" : "play", 14));
    }
  }

  _pick(btn) {
    if (btn.getAttribute("aria-disabled") === "true") return;
    const id = btn.dataset.id || "";
    const changed = id !== this._value;
    this._value = id;
    this._sync();
    this.close();
    this.$("#trigger").focus();
    if (changed) this._fire("change");
  }

  _onKey(e) {
    const picks = this.$$("button.pick");
    const i = picks.indexOf(this.shadowRoot.activeElement);
    const inSearch = this.shadowRoot.activeElement === this.$("#q");
    const move = (n) => {
      e.preventDefault();
      if (!picks.length) return;
      const j = Math.max(0, Math.min(picks.length - 1, n));
      picks[j].focus();
      picks[j].scrollIntoView({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown":
        move(inSearch || i < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
        if (i <= 0) {
          e.preventDefault();
          this.$("#q").focus();
        } else move(i - 1);
        break;
      case "Home":
        if (!inSearch) move(0);
        break;
      case "End":
        if (!inSearch) move(picks.length - 1);
        break;
      case "Enter":
        if (inSearch) {
          e.preventDefault();
          const first = picks.find((p) => p.getAttribute("aria-disabled") !== "true");
          if (first) this._pick(first);
        } else if (i >= 0) {
          e.preventDefault();
          this._pick(picks[i]);
        }
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.close();
        this.$("#trigger").focus();
        break;
    }
  }

  // ---- public API -------------------------------------------------------------------------------

  get value() {
    return this._value;
  }
  set value(id) {
    this._value = id == null ? "" : String(id);
    this._sync();
    if (this._isOpen()) this._renderList();
  }

  get voice() {
    return this._value ? store.voice(this._value) || null : null;
  }

  // ---- form-associated plumbing ---------------------------------------------------------------

  get form() { return this.internals.form; }
  get name() { return this.getAttribute("name"); }
  set name(v) { this.setAttribute("name", v); }
  get type() { return "moss-voice-picker"; }
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

define("moss-voice-picker", MossVoicePicker);
