// <moss-tts-view> (route #/tts): plain text to speech with tts / fast / nano.
//
// View contract (called by <moss-app>): activated(), generate(), loadRecipe(request).
// Also follows store "show-job" {job} for this workflow and resubmits on take-list "regenerate".
//
// This module also exports SpeechView, the small base class shared by the speech-style views
// (tts, design, clone): form + results layout, submit with inline errors, drafts in localStorage,
// recent takes from history, recipes, "same seed" regeneration and live streaming playback.
// Subclasses implement: template(), setup(), validate() -> error string|"", buildRequest(),
// fillFromRecipe(request), draft() -> {field: string}, restoreDraft(obj), and optionally
// onModelChange(model), voiceId() (for warming), and set static workflow.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, toast, esc } from "../lib/dom.js";
import { viewLayout } from "../lib/styles.js";
import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import "./moss-text-editor.js";
import "./moss-gen-controls.js";
import "./moss-advanced.js";
import "./moss-voice-picker.js";
import "./moss-take-list.js";
import "./moss-stream-player.js";

export const speechStyles = css`
  .model-note { font-size: var(--fs-xs); color: var(--text-2); background: var(--surface-2); border-radius: var(--radius); padding: var(--sp-2) var(--sp-3); line-height: 1.45; }
  .model-note:empty { display: none; }
  .model-note strong { color: var(--text); font-weight: 600; }
  .results { display: grid; gap: var(--sp-3); align-content: start; min-width: 0; }
  .actions .error { flex: 1 1 100%; }
  .actions .kbd-hint { margin-left: auto; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips button { border-radius: var(--radius-pill); font-weight: 400; color: var(--text-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .seg-row { display: flex; flex-direction: column; gap: 6px; }
`;

/** Pick the non-empty keys of obj. */
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export class SpeechView extends MossElement {
  static styles = [viewLayout, speechStyles];
  static workflow = "tts";

  get workflow() {
    return this.constructor.workflow;
  }

  /** Common chrome around the subclass's form fields. */
  frame({ title, intro, fields, results = "", generateLabel = "Generate", emptyText = "", saveAsVoice = false }) {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
    return html`
      <div class="view-head">
        <h2>${title}</h2>
        <p>${intro}</p>
      </div>
      <div class="layout">
        <form class="stack" novalidate>
          ${fields}
          <div class="actions">
            <button type="submit" class="primary big" id="generate">${icon("wave", 18)} ${generateLabel}</button>
            <span class="faint xs kbd-hint"><kbd>${mod}</kbd> <kbd>Enter</kbd></span>
            <div class="error form-error" role="alert" hidden></div>
          </div>
        </form>
        <section class="results" aria-label="Takes">
          ${results}
          <moss-take-list ${saveAsVoice ? html`save-as-voice` : ""} empty-text="${emptyText || "Takes will appear here."}"></moss-take-list>
        </section>
      </div>`;
  }

  render() {
    this.setHTML(this.template());
    this.form = this.$("form");
    this.controls = this.$("moss-gen-controls");
    this.takeList = this.$("moss-take-list");
    this.streamPlayer = this.$("moss-stream-player");
    this.errorEl = this.$(".form-error");
    this.genButton = this.$("#generate");

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.generate();
    });
    this.takeList.addEventListener("regenerate", (e) => this.regenerate(e.detail.take));
    this.controls.addEventListener("model-change", (e) => this.modelChanged(e.detail.model));
    // Drafts: text edits anywhere in the form (inputs from shadow children arrive retargeted).
    for (const t of ["input", "change"]) this.form.addEventListener(t, () => this.queueDraft());
    // Any edit clears a stale submit error.
    this.form.addEventListener("input", () => this.showError(""));

    this.setup();
    this.loadDraft();
    this.modelChanged(this.controls.model);
    this.loadRecent();
  }

  connected() {
    store.on("show-job", ({ job }) => job?.workflow === this.workflow && this.takeList.trackJob(job.id), this.signal);
    store.on("models", () => this.modelChanged(this.controls.model), this.signal);
    // "Open in editor" while this view is already showing (the hash doesn't change, so no activated()).
    store.on("recipe", ({ workflow }) => {
      if (workflow !== this.workflow || !this.hasAttribute("active")) return;
      const r = store.takeRecipe(workflow);
      if (r) this.loadRecipe(r);
    }, this.signal);
  }

  activated() {
    const r = store.takeRecipe(this.workflow);
    if (r) this.loadRecipe(r);
    store.warmIfIdle(this.controls.model, this.warmVoice());
  }

  // ---- hooks (overridden) ----
  template() { return ""; }
  setup() {}
  validate() { return ""; }
  buildRequest() { return null; }
  fillFromRecipe() {}
  draft() { return {}; }
  restoreDraft() {}
  onModelChange() {}
  voiceId() { return null; }

  /** Voice id worth pre-encoding when warming (only fast caches encoded references). */
  warmVoice() {
    return this.controls.model === "fast" ? this.voiceId() || undefined : undefined;
  }

  get modelInfo() {
    return store.model(this.controls.model);
  }

  modelChanged(model) {
    if (!model) return;
    this.onModelChange(model, store.model(model));
  }

  // ---- generate ----

  generate() {
    if (this._submitting) return;
    this.showError("");
    if (!this.form.reportValidity()) return;
    const err = this.validate();
    if (err) {
      this.showError(err);
      return;
    }
    let req;
    try {
      req = this.buildRequest();
    } catch (e) {
      this.showError(e.message);
      return;
    }
    if (!req) return;
    // Streaming: the AudioContext must be created inside the user gesture, i.e. before any await.
    const streaming = !!(req.stream && this.streamPlayer);
    const rate = store.model(req.model)?.sample_rate;
    if (streaming) {
      try {
        this.streamPlayer.prime(rate);
      } catch (e) {
        console.warn("stream prime failed", e);
      }
    }
    this.submit(req, streaming, rate);
  }

  async submit(req, streaming, rate) {
    this._submitting = true;
    this.genButton.disabled = true;
    try {
      const job = await store.submit(req);
      this.takeList.trackJob(job.id);
      this.controls.noteRun(job);
      if (streaming) {
        Promise.resolve(this.streamPlayer.play(job.id, rate)).catch((e) => toast(`Live playback failed: ${e.message}`, "error"));
      }
    } catch (e) {
      this.showError(e.message || String(e));
      toast(e.message || String(e), "error");
      if (streaming) this.streamPlayer.stop?.();
    } finally {
      this._submitting = false;
      this.genButton.disabled = false;
    }
  }

  /** Take-list "Same seed": load that take's recipe, pin its seed, one variation, run. */
  regenerate(take) {
    if (!take) return;
    if (take.request) this.loadRecipe(take.request);
    this.controls.useSeed(take.seed);
    this.controls.setValues({ variations: 1 });
    this.generate();
  }

  loadRecipe(request) {
    if (!request) return;
    const { model, variations, seed, stream } = request;
    const p = request.params || {};
    const cv = pick({ model, variations, temperature: p.temperature, max_seconds: p.max_seconds }, ["model", "variations", "temperature", "max_seconds"]);
    if (typeof stream === "boolean") cv.stream = stream;
    // A full recipe (it has text) replaces the sampling fields; partial ones ("use this voice") don't.
    if (p.text !== undefined) {
      if (!("temperature" in cv)) cv.temperature = null;
      if (!("max_seconds" in cv)) cv.max_seconds = null;
    }
    this.controls.setValues(cv);
    if (seed !== undefined && seed !== null) this.controls.useSeed(seed);
    this.modelChanged(this.controls.model);
    this.fillFromRecipe(request, p);
    this.modelChanged(this.controls.model);
    this.showError("");
    this.queueDraft();
  }

  showError(msg) {
    this.errorEl.textContent = msg || "";
    this.errorEl.hidden = !msg;
  }

  // ---- drafts ----

  get draftKey() {
    return `moss-draft:${this.workflow}`;
  }

  loadDraft() {
    let d = null;
    try {
      d = JSON.parse(localStorage.getItem(this.draftKey) || "null");
    } catch {}
    if (d && typeof d === "object") this.restoreDraft(d);
  }

  queueDraft() {
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(this.draftKey, JSON.stringify(this.draft()));
      } catch {}
    }, 400);
  }

  // ---- history ----

  async loadRecent() {
    try {
      const takes = await api.history({ workflow: this.workflow, limit: 6 });
      if (takes?.length && !this.takeList.takes?.length) this.takeList.setTakes(takes);
    } catch {
      // Not fatal: the list just starts empty.
    }
  }
}

// ---------------------------------------------------------------------------------------------

const ADV_KEYS = ["language", "instruction", "seconds", "ambient_sound", "quality", "sound_event", "scene"];

class MossTtsView extends SpeechView {
  static workflow = "tts";

  template() {
    return this.frame({
      title: "Speech",
      intro: "Type text and hear it spoken. Use a library voice to clone it, or leave the voice empty for the model's own voice.",
      fields: html`
        <moss-text-editor name="text" label="Text" rows="7" required pause-button count-lines
          placeholder="What should be said? Add [pause 1.0s] for a beat of silence."></moss-text-editor>
        <label class="check"><input type="checkbox" id="lines"> One job per line</label>
        <p class="hint" id="lines-hint" hidden>Each non-empty line becomes its own take (lines starting with # are skipped). The model loads once for the whole batch.</p>
        <moss-voice-picker name="voice" label="Voice" allow-none none-label="Model voice (none)"></moss-voice-picker>
        <p class="hint" id="voice-hint"></p>
        <moss-gen-controls name="controls" workflow="tts" show-temperature show-max-seconds show-stream></moss-gen-controls>
        <p class="model-note" id="model-note"></p>
        <moss-advanced name="advanced" experimental></moss-advanced>
      `,
      results: html`<moss-stream-player></moss-stream-player>`,
      emptyText: "Takes will appear here. Try a sentence or two first; long texts take a while.",
    });
  }

  setup() {
    this.editor = this.$("moss-text-editor");
    this.picker = this.$("moss-voice-picker");
    this.advanced = this.$("moss-advanced");
    this.linesBox = this.$("#lines");
    this.linesBox.addEventListener("change", () => this.syncLines());
    this.picker.addEventListener("change", () => {
      this.updateVoiceHint();
      if (this.controls.model === "fast" && this.picker.value) store.warmIfIdle("fast", this.picker.value);
    });
    store.on("voices", () => this.updateVoiceHint(), this.signal);
  }

  syncLines() {
    this.editor.linesMode = this.linesBox.checked;
    this.$("#lines-hint").hidden = !this.linesBox.checked;
  }

  voiceId() {
    return this.picker.value || null;
  }

  onModelChange(model, info) {
    this.advanced.model = model;
    const nano = model === "nano";
    this.picker.toggleAttribute("required", nano);
    const notes = {
      tts: html`<strong>Best quality.</strong> Follows an instruction (Advanced) for tone, speaks many languages and can add ambient sound. Slowest of the three.`,
      fast: html`<strong>Quick and can stream</strong> (play while generating). No instructions; language defaults to English.`,
      nano: html`<strong>Smallest and lightest.</strong> Clones only, so pick a voice; a voice with a transcript works best. Advanced fields don't apply.`,
    };
    const note = this.$("#model-note");
    note.innerHTML = String(notes[model] ?? esc(info?.short || ""));
    this.updateVoiceHint();
  }

  updateVoiceHint() {
    const hint = this.$("#voice-hint");
    const model = this.controls.model;
    const v = this.picker.value ? store.voice(this.picker.value) : null;
    let msg = "";
    if (model === "nano" && !v) msg = "Nano needs a voice to clone.";
    else if (model === "nano" && v && !v.transcript) msg = "This voice has no transcript; nano clones better with one (add it in Library → Voices).";
    else if (!v) msg = "No voice: the model picks its own (it can change from take to take). Pick a voice for a consistent identity.";
    hint.textContent = msg;
    hint.hidden = !msg;
  }

  validate() {
    if (this.controls.model === "nano" && !this.picker.value) {
      this.picker.focus?.();
      return "Nano only clones: pick a voice, or switch to the tts or fast model.";
    }
    if (this.linesBox.checked && !this.editor.value.split("\n").some((l) => l.trim() && !l.trim().startsWith("#"))) {
      return "No lines to speak (blank lines and # comments are skipped).";
    }
    return "";
  }

  buildRequest() {
    const c = this.controls.values;
    const model = c.model;
    let adv = { ...(this.advanced.values || {}) };
    if (model === "nano") adv = {};
    if (model === "fast") delete adv.instruction;
    const params = {
      text: this.editor.value,
      lines: this.linesBox.checked,
      voice: this.picker.value || null,
      mode: "clone",
      ...pick(adv, ADV_KEYS),
      ...pick(c, ["max_seconds", "temperature"]),
    };
    const req = { workflow: "tts", model, params, variations: c.variations, seed: c.seed ?? null };
    if (c.stream && store.model(model)?.streaming) req.stream = true;
    return req;
  }

  fillFromRecipe(req, p) {
    if (p.text !== undefined) {
      this.editor.value = p.text;
      this.advanced.reset?.();
    }
    if (typeof p.lines === "boolean") {
      this.linesBox.checked = p.lines;
      this.syncLines();
    }
    if (p.voice !== undefined) this.picker.value = p.voice || "";
    const adv = pick(p, ADV_KEYS);
    if (Object.keys(adv).length) this.advanced.values = adv;
    this.updateVoiceHint();
  }

  draft() {
    return { text: this.editor.value };
  }

  restoreDraft(d) {
    if (typeof d.text === "string") this.editor.value = d.text;
  }
}

define("moss-tts-view", MossTtsView);
