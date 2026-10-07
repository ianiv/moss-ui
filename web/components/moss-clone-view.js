// <moss-clone-view> (route #/clone): speak text in a reference voice (tts / fast / nano), either
// cloning it or (tts only) continuing on from the reference recording.
//
// View contract (called by <moss-app>): activated(), generate(), loadRecipe(request).
// Shared behaviour (drafts, history, errors, same-seed regeneration, streaming) comes from SpeechView.
import { define } from "../lib/element.js";
import { html, toast, fmtSeconds } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { SpeechView, pick } from "./moss-tts-view.js";
import "./moss-text-editor.js";
import "./moss-gen-controls.js";
import "./moss-advanced.js";
import "./moss-voice-picker.js";
import "./moss-voice-recorder.js";
import "./moss-take-list.js";
import "./moss-stream-player.js";

const NOTES = {
  tts: html`<strong>Best quality</strong> and the only model that can <strong>continue</strong> a recording. Slowest of the three.`,
  fast: html`<strong>Quick and can stream</strong> (play while generating). The encoded reference is cached, so repeat runs with the same voice start faster.`,
  nano: html`<strong>Smallest and lightest.</strong> Clone mode only; a reference with a transcript gives the best results.`,
};

class MossCloneView extends SpeechView {
  static workflow = "clone";

  template() {
    return this.frame({
      title: "Cloning",
      intro: "Speak any text in the voice of a short reference recording (5–15 s works best). Pick a library voice or record a new one.",
      saveAsVoice: true,
      emptyText: "Takes will appear here.",
      results: html`<moss-stream-player></moss-stream-player>`,
      fields: html`
        <fieldset class="stack tight">
          <legend>Reference</legend>
          <div class="seg" role="radiogroup" aria-label="Reference source">
            <label><input type="radio" name="ref" value="library" checked><span>Library voice</span></label>
            <label><input type="radio" name="ref" value="record"><span>New recording</span></label>
          </div>
          <div id="ref-library" class="stack tight">
            <moss-voice-picker name="voice" label="Reference voice" required></moss-voice-picker>
            <p class="hint" id="voice-hint" hidden></p>
          </div>
          <div id="ref-record" hidden>
            <moss-voice-recorder compact></moss-voice-recorder>
            <p class="hint">Saved recordings go into your voice library and are selected here automatically.</p>
          </div>
        </fieldset>

        <div class="seg-row">
          <span class="label" id="mode-label">Mode</span>
          <div class="seg" role="radiogroup" aria-labelledby="mode-label">
            <label><input type="radio" name="mode" value="clone" checked><span>Clone</span></label>
            <label><input type="radio" name="mode" value="continue"><span>Continue</span></label>
          </div>
          <p class="hint" id="mode-hint"></p>
        </div>

        <moss-text-editor name="text" label="Text" rows="6" required pause-button
          placeholder="What should the cloned voice say?"></moss-text-editor>
        <moss-gen-controls name="controls" workflow="clone" show-stream show-temperature show-max-seconds></moss-gen-controls>
        <p class="model-note" id="model-note"></p>
        <moss-advanced name="advanced" fields="language,seconds"></moss-advanced>
      `,
    });
  }

  setup() {
    this.picker = this.$("moss-voice-picker");
    this.recorder = this.$("moss-voice-recorder");
    this.editor = this.$("moss-text-editor");
    this.advanced = this.$("moss-advanced");

    for (const r of this.$$("input[name=ref]")) r.addEventListener("change", () => this.syncRef());
    for (const r of this.$$("input[name=mode]")) r.addEventListener("change", () => this.syncMode());
    this.picker.addEventListener("change", () => {
      this.syncMode();
      const v = this.picker.value;
      if (v) store.warmIfIdle(this.controls.model, this.controls.model === "fast" ? v : undefined);
    });
    this.recorder.addEventListener("voice-saved", (e) => this.useNewVoice(e.detail?.voice));
    store.on("voices", () => this.syncMode(), this.signal);
    this.syncMode();
  }

  get refSource() {
    return this.$("input[name=ref]:checked")?.value || "library";
  }

  get mode() {
    return this.$("input[name=mode]:checked")?.value || "clone";
  }

  set mode(m) {
    const r = this.$(`input[name=mode][value="${m === "continue" ? "continue" : "clone"}"]`);
    if (r && !r.disabled) r.checked = true;
    else this.$("input[name=mode][value=clone]").checked = true;
  }

  get voice() {
    return this.picker.value ? store.voice(this.picker.value) || null : null;
  }

  voiceId() {
    return this.picker.value || null;
  }

  syncRef() {
    const rec = this.refSource === "record";
    this.$("#ref-library").hidden = rec;
    this.$("#ref-record").hidden = !rec;
    // A hidden required picker would block reportValidity with nothing to focus.
    this.picker.toggleAttribute("required", !rec);
    this.showError("");
  }

  async useNewVoice(voice) {
    if (!voice?.id) return;
    try {
      if (!store.voice(voice.id)) await store.refreshVoices();
    } catch {}
    this.picker.value = voice.id;
    this.$("input[name=ref][value=library]").checked = true;
    this.syncRef();
    this.syncMode();
    toast(`Using “${voice.name || voice.id}” as the reference`, "ok");
  }

  onModelChange(model, info) {
    this.advanced.model = model;
    this.advanced.hidden = model === "nano";
    this.$("#model-note").innerHTML = String(NOTES[model] ?? "");
    if (!NOTES[model]) this.$("#model-note").textContent = info?.short || "";
    this.syncMode();
  }

  /** Enable Continue only for tts + a voice with a transcript; explain why not otherwise. */
  syncMode() {
    const model = this.controls.model;
    const v = this.voice;
    const cont = this.$("input[name=mode][value=continue]");
    let why = "";
    if (model && model !== "tts") why = "Continue needs the tts model.";
    else if (!v) why = "Continue needs a reference voice with a transcript.";
    else if (!v.transcript) why = "This voice has no transcript, which Continue needs (add one in Library → Voices).";
    cont.disabled = !!why;
    cont.parentElement.title = why;
    if (why && cont.checked) this.mode = "clone";

    const hint = this.$("#mode-hint");
    hint.textContent =
      this.mode === "continue"
        ? "Continue: the model carries on from the end of the reference recording, as if the same speaker kept talking. Closest match in timbre and delivery; your text follows the reference transcript."
        : `Clone: speaks your text in the reference voice.${why ? ` ${why}` : " Switch to Continue for an even closer match."}`;

    const vh = this.$("#voice-hint");
    let msg = "";
    if (v) {
      const parts = [];
      if (v.duration_s) parts.push(fmtSeconds(v.duration_s));
      parts.push(v.transcript ? `“${v.transcript.length > 90 ? v.transcript.slice(0, 90) + "…" : v.transcript}”` : "no transcript");
      msg = parts.join(" · ");
      if (v.duration_s && (v.duration_s < 3 || v.duration_s > 30)) msg += " · 5–15 s references work best";
    }
    vh.textContent = msg;
    vh.hidden = !msg;
  }

  validate() {
    if (this.refSource === "record") return "Save the recording as a voice first (or switch to Library voice).";
    if (!this.picker.value) return "Pick a reference voice.";
    if (this.mode === "continue") {
      if (this.controls.model !== "tts") return "Continue only works with the tts model.";
      if (!this.voice?.transcript) return "Continue needs the voice's transcript. Add it in Library → Voices, or use Clone.";
    }
    return "";
  }

  buildRequest() {
    const c = this.controls.values;
    const model = c.model;
    const adv = model === "nano" ? {} : pick(this.advanced.values || {}, ["language", "seconds"]);
    const params = {
      text: this.editor.value,
      lines: false,
      voice: this.picker.value,
      mode: model === "tts" ? this.mode : "clone",
      ...adv,
      ...pick(c, ["max_seconds", "temperature"]),
    };
    const req = { workflow: "clone", model, params, variations: c.variations, seed: c.seed ?? null };
    if (c.stream && store.model(model)?.streaming) req.stream = true;
    return req;
  }

  fillFromRecipe(req, p) {
    if (p.text !== undefined) {
      this.editor.value = p.text;
      this.advanced.reset?.();
    }
    if (p.voice !== undefined) {
      this.picker.value = p.voice || "";
      this.$("input[name=ref][value=library]").checked = true;
      this.syncRef();
    }
    const adv = pick(p, ["language", "seconds"]);
    if (Object.keys(adv).length) this.advanced.values = adv;
    this.syncMode();
    if (p.mode) this.mode = p.mode;
    this.syncMode();
  }

  draft() {
    return { text: this.editor.value };
  }

  restoreDraft(d) {
    if (typeof d.text === "string") this.editor.value = d.text;
  }
}

define("moss-clone-view", MossCloneView);
