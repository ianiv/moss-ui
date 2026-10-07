// <moss-gen-controls>: form-associated model / variations / seed / sampling controls for a workflow view.
//
// Attributes:
//   name, workflow, models (comma list of allowed keys; default store.workflows[workflow], else all models),
//   model (initial key), variations (default 1), max-seconds (default store.info.default_max_seconds[model]),
//   show-temperature, show-max-seconds, show-stream (only visible when the model can stream),
//   hide-model (show the model as text instead of a select; also done automatically with one allowed model),
//   disabled.
// Props: model, variations, seed (number|null; null = random), seedLocked, temperature (number|null),
//   maxSeconds (number|null), stream (bool; false when not streaming-capable),
//   values -> {model, variations, seed, temperature, max_seconds, stream}, setValues(obj) (missing keys untouched),
//   useSeed(n) (set + lock), noteRun(job) (remember job.seed; clear the field unless locked),
//   form, name, validity, validationMessage, willValidate, checkValidity(), reportValidity().
// Form value: FormData {model, variations, seed, temperature, max_seconds, stream} ("" for null).
// Events: "model-change" {model} (bubbling, composed) whenever the effective model changes. store.warmIfIdle(model)
//   is called when the model is changed by the user or by the model/setValues setters (not when the model
//   list first loads).
import { MossElement, define } from "../lib/element.js";
import { css, html, icon } from "../lib/dom.js";
import { store } from "../lib/store.js";

const styles = css`
  :host { display: block; }
  .grid { display: grid; gap: var(--sp-3); grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); align-items: start; }
  .model { grid-column: 1 / -1; }
  .model-text { font-size: var(--fs-md); font-weight: 500; }
  .seed { grid-column: span 2; }
  .seed .row { flex-wrap: nowrap; gap: 4px; }
  .seed input { min-width: 0; }
  .stream { grid-column: 1 / -1; }
  input[type=number] { font-variant-numeric: tabular-nums; }
`;

const intOrNull = (s) => {
  if (s === "" || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const numOrNull = (s) => {
  if (s === "" || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

class MossGenControls extends MossElement {
  static styles = [styles];
  static formAssociated = true;
  static delegatesFocus = true;
  static observedAttributes = ["models", "workflow", "model", "show-temperature", "show-max-seconds", "show-stream", "hide-model", "max-seconds", "disabled"];

  constructor() {
    super();
    this.internals = this.attachInternals();
    this._model = null; // resolved key
    this._variations = null; // null until first render (then attribute default)
    this._seed = null;
    this._seedLocked = false;
    this._lastSeed = null;
    this._temperature = null;
    this._maxSeconds = null;
    this._maxDirty = false; // user edited max seconds: don't replace it with model defaults
    this._stream = false;
    this._formDisabled = false;
  }

  render() {
    this.setHTML(html`
      <div class="grid">
        <div class="field model">
          <label for="model" id="model-lbl">Model</label>
          <select id="model"></select>
          <div class="model-text" id="model-text" hidden></div>
          <div class="hint" id="model-hint"></div>
        </div>
        <div class="field">
          <label for="variations">Variations</label>
          <input id="variations" type="number" min="1" max="8" step="1" inputmode="numeric">
        </div>
        <div class="field seed">
          <label for="seed">Seed</label>
          <div class="row">
            <input id="seed" type="number" min="0" step="1" inputmode="numeric" placeholder="random">
            <button type="button" class="icon" id="lock" aria-pressed="false" aria-label="Keep this seed for the next runs" title="Lock seed">${icon("unlock")}</button>
            <button type="button" class="icon" id="dice" aria-label="Random seed" title="Random seed">${icon("dice")}</button>
          </div>
        </div>
        <div class="field" id="temp-field" hidden>
          <label for="temperature">Temperature</label>
          <input id="temperature" type="number" min="0" max="3" step="0.05" placeholder="default" inputmode="decimal">
        </div>
        <div class="field" id="max-field" hidden>
          <label for="max">Max seconds</label>
          <input id="max" type="number" min="1" step="1" inputmode="numeric">
        </div>
        <label class="check stream" id="stream-field" hidden>
          <input type="checkbox" id="stream"> Play while generating
        </label>
      </div>
    `);
    if (this._variations == null) this._variations = this._clampVariations(this.getAttribute("variations") ?? 1);

    this.$("#model").addEventListener("change", (e) => this._setModel(e.target.value, { user: true }));
    this.$("#variations").addEventListener("input", (e) => {
      const n = intOrNull(e.target.value);
      if (n != null) this._variations = this._clampVariations(n);
      this._update();
    });
    this.$("#variations").addEventListener("change", (e) => {
      this._update(true); // normalise on commit
    });
    this.$("#seed").addEventListener("input", (e) => {
      this._seed = intOrNull(e.target.value);
      this._update();
    });
    this.$("#lock").addEventListener("click", () => {
      this.seedLocked = !this._seedLocked;
      if (this._seedLocked && this._seed == null && this._lastSeed != null) this.seed = this._lastSeed;
    });
    this.$("#dice").addEventListener("click", () => {
      this.seed = randomSeed();
      this._fire("input");
    });
    for (const id of ["#seed", "#temperature", "#max"]) this.$(id).addEventListener("change", () => this._update(true));
    this.$("#temperature").addEventListener("input", (e) => {
      this._temperature = numOrNull(e.target.value);
      this._update();
    });
    this.$("#max").addEventListener("input", (e) => {
      this._maxSeconds = numOrNull(e.target.value);
      this._maxDirty = e.target.value !== "";
      this._update();
    });
    this.$("#stream").addEventListener("change", (e) => {
      this._stream = e.target.checked;
      this._update();
    });
    this._refresh();
  }

  connected() {
    store.on("models", () => this._refresh(), this.signal);
  }

  attributeChangedCallback(name) {
    if (!this._rendered || !this.shadowRoot.firstChild) return;
    if (name === "model") this._setModel(this.getAttribute("model"));
    if (name === "max-seconds") this._maxDirty = false;
    this._refresh();
  }

  // ---- model resolution -------------------------------------------------------------------

  /** Allowed model keys (may be empty before the store has loaded). */
  get allowedModels() {
    const attr = this.getAttribute("models");
    if (attr) return attr.split(",").map((s) => s.trim()).filter(Boolean);
    const wf = this.getAttribute("workflow");
    if (wf && store.workflows?.[wf]) return [...store.workflows[wf]];
    return store.models.map((m) => m.key);
  }

  _defaultMax(key) {
    const attr = this.getAttribute("max-seconds");
    if (attr != null && attr !== "") return numOrNull(attr);
    const d = store.info?.default_max_seconds?.[key];
    return d == null ? null : d;
  }

  _setModel(key, { user = false, programmatic = false } = {}) {
    const allowed = this.allowedModels;
    if (allowed.length && !allowed.includes(key)) key = allowed[0];
    if (!key) return;
    const prev = this._model;
    if (prev === key) return;
    this._model = key;
    if (!this._maxDirty) this._maxSeconds = this._defaultMax(key);
    if (this.selectedModel && !this.selectedModel.streaming) this._stream = false;
    this._refresh();
    if (prev != null || user || programmatic) {
      this.dispatchEvent(new CustomEvent("model-change", { detail: { model: key }, bubbles: true, composed: true }));
      if (user || (programmatic && this.isConnected)) store.warmIfIdle(key);
      if (user) this._fire("change");
    }
  }

  /** The store's model object for the current key (or undefined before load). */
  get selectedModel() {
    return this._model ? store.model(this._model) : undefined;
  }

  /** Rebuild options and visibility from attributes + store, then sync inputs. */
  _refresh() {
    const sel = this.$("#model");
    if (!sel) {
      this._update();
      return;
    }
    const allowed = this.allowedModels;
    if (!this._model || (allowed.length && !allowed.includes(this._model))) {
      const want = this.getAttribute("model");
      const key = allowed.includes(want) ? want : allowed[0] || want || null;
      if (key && key !== this._model) {
        this._model = key;
        if (!this._maxDirty) this._maxSeconds = this._defaultMax(key);
        this.dispatchEvent(new CustomEvent("model-change", { detail: { model: key }, bubbles: true, composed: true }));
      }
    }
    if (!this._maxDirty && this._maxSeconds == null) this._maxSeconds = this._defaultMax(this._model);

    sel.replaceChildren(
      ...(allowed.length ? allowed : [this._model].filter(Boolean)).map((k) => {
        const m = store.model(k);
        const o = document.createElement("option");
        o.value = k;
        o.textContent = m ? m.label : k;
        return o;
      }),
    );
    if (!sel.options.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "Loading models…";
      sel.append(o);
    }
    if (this._model) sel.value = this._model;

    const m = this.selectedModel;
    const asText = this.hasAttribute("hide-model") || allowed.length === 1;
    sel.hidden = asText;
    const text = this.$("#model-text");
    text.hidden = !asText;
    text.textContent = m ? m.label : this._model || "…";
    this.$("#model-lbl").htmlFor = asText ? "" : "model";
    const hint = [];
    if (m) {
      if (m.short) hint.push(m.short);
      if (m.sample_rate) hint.push(`${+(m.sample_rate / 1000).toFixed(1)} kHz`);
      if (m.peak_gb) hint.push(`~${m.peak_gb} GB peak`);
    }
    this.$("#model-hint").textContent = hint.join(" · ");

    this.$("#temp-field").hidden = !this.hasAttribute("show-temperature");
    this.$("#max-field").hidden = !this.hasAttribute("show-max-seconds");
    const canStream = !!m?.streaming;
    if (m && !canStream) this._stream = false; // keep a pending value until the models load
    this.$("#stream-field").hidden = !(this.hasAttribute("show-stream") && canStream);
    this.$("#max").placeholder = this._defaultMax(this._model) != null ? String(this._defaultMax(this._model)) : "";
    this._update();
  }

  /** Push state into the inputs, form value and validity. */
  _update(force = false) {
    const $ = (s) => this.$(s);
    if ($("#variations")) {
      const disabled = this.hasAttribute("disabled") || this._formDisabled;
      for (const el of this.$$("input, select, button")) el.disabled = disabled;
      const setIfIdle = (el, v) => {
        // Don't fight the user while they type (e.g. "0." on the way to "0.7"); "change" normalises.
        if (!force && this.shadowRoot.activeElement === el) return;
        el.value = v == null ? "" : String(v);
      };
      setIfIdle($("#variations"), this._variations);
      setIfIdle($("#seed"), this._seed);
      setIfIdle($("#temperature"), this._temperature);
      setIfIdle($("#max"), this._maxSeconds);
      $("#stream").checked = this._stream;
      const lock = $("#lock");
      lock.setAttribute("aria-pressed", String(this._seedLocked));
      lock.title = this._seedLocked ? "Seed locked: kept for the next runs" : "Lock seed";
      lock.innerHTML = String(icon(this._seedLocked ? "lock" : "unlock"));
      $("#seed").placeholder = this._lastSeed != null ? `random (last ${this._lastSeed})` : "random";
    }

    const v = this.values;
    const fd = new FormData();
    for (const [k, val] of Object.entries(v)) fd.append(k, val == null ? "" : String(val));
    this.internals.setFormValue(fd, JSON.stringify({ ...v, seedLocked: this._seedLocked }));

    // Validity: report the first invalid inner input.
    const bad = this.$$("input").find((el) => !el.closest("[hidden]") && !el.validity.valid);
    if (bad) {
      const flags = {};
      for (const k in bad.validity) if (k !== "valid" && bad.validity[k]) flags[k] = true;
      this.internals.setValidity(flags, bad.validationMessage || "Invalid value.", bad);
    } else {
      this.internals.setValidity({});
    }
  }

  _fire(type) {
    this.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  _clampVariations(n) {
    n = intOrNull(n);
    return Math.min(8, Math.max(1, n ?? 1));
  }

  // ---- public API ---------------------------------------------------------------------------

  get model() {
    return this._model ?? this.getAttribute("model");
  }
  set model(key) {
    if (!this.shadowRoot.firstChild) {
      this._model = key;
      return;
    }
    this._setModel(key, { programmatic: true });
  }

  get variations() {
    return this._variations ?? this._clampVariations(this.getAttribute("variations") ?? 1);
  }
  set variations(n) {
    this._variations = this._clampVariations(n);
    this._update();
  }

  get seed() {
    return this._seed;
  }
  set seed(n) {
    this._seed = n === "" || n == null ? null : intOrNull(n);
    this._update();
  }

  get seedLocked() {
    return this._seedLocked;
  }
  set seedLocked(v) {
    this._seedLocked = !!v;
    this._update();
  }

  get lastSeed() {
    return this._lastSeed;
  }

  get temperature() {
    return this._temperature;
  }
  set temperature(n) {
    this._temperature = numOrNull(n);
    this._update();
  }

  get maxSeconds() {
    return this._maxSeconds;
  }
  set maxSeconds(n) {
    this._maxSeconds = numOrNull(n);
    this._maxDirty = this._maxSeconds != null;
    this._update();
  }

  get stream() {
    return !!this._stream && !!this.selectedModel?.streaming;
  }
  set stream(v) {
    this._stream = !!v;
    this._update();
  }

  get values() {
    return {
      model: this.model,
      variations: this.variations,
      seed: this.seed,
      temperature: this.temperature,
      max_seconds: this.maxSeconds,
      stream: this.stream,
    };
  }

  setValues(obj = {}) {
    if (!obj) return;
    if ("model" in obj && obj.model) this.model = obj.model;
    if ("variations" in obj && obj.variations != null) this._variations = this._clampVariations(obj.variations);
    if ("seed" in obj) this._seed = obj.seed == null || obj.seed === "" ? null : intOrNull(obj.seed);
    if ("temperature" in obj) this._temperature = numOrNull(obj.temperature);
    if ("max_seconds" in obj) {
      this._maxSeconds = numOrNull(obj.max_seconds);
      this._maxDirty = this._maxSeconds != null;
      if (!this._maxDirty) this._maxSeconds = this._defaultMax(this.model);
    }
    if ("stream" in obj) this._stream = !!obj.stream;
    this._update();
  }

  /** Use a specific seed and lock it (e.g. "regenerate with this seed"). */
  useSeed(n) {
    this._seed = intOrNull(n);
    this._seedLocked = this._seed != null;
    this._update();
  }

  /** Call after submitting: remembers the job's seed and clears the field unless locked. */
  noteRun(job) {
    if (job && job.seed != null) this._lastSeed = job.seed;
    if (!this._seedLocked) this._seed = null;
    this._update();
  }

  // ---- form-associated plumbing --------------------------------------------------------------

  get form() { return this.internals.form; }
  get name() { return this.getAttribute("name"); }
  set name(v) { this.setAttribute("name", v); }
  get type() { return "moss-gen-controls"; }
  get validity() { return this.internals.validity; }
  get validationMessage() { return this.internals.validationMessage; }
  get willValidate() { return this.internals.willValidate; }
  checkValidity() { return this.internals.checkValidity(); }
  reportValidity() { return this.internals.reportValidity(); }

  formResetCallback() {
    this._variations = this._clampVariations(this.getAttribute("variations") ?? 1);
    this._seed = null;
    this._seedLocked = false;
    this._temperature = null;
    this._maxDirty = false;
    this._maxSeconds = this._defaultMax(this.model);
    this._stream = false;
    const want = this.getAttribute("model");
    if (want && want !== this._model && this.shadowRoot.firstChild) this._setModel(want);
    this._update();
  }

  formStateRestoreCallback(state) {
    if (typeof state !== "string") return;
    try {
      const s = JSON.parse(state);
      this.setValues(s);
      this._seedLocked = !!s.seedLocked;
      this._update();
    } catch {
      /* ignore */
    }
  }

  formDisabledCallback(disabled) {
    this._formDisabled = disabled;
    this._update();
  }
}

define("moss-gen-controls", MossGenControls);
