// <moss-design-view> (route #/design): voice design = the tts model with an instruction and no
// reference. Generate a few takes of an audition line, pick one, and "Save as voice".
//
// View contract (called by <moss-app>): activated(), generate(), loadRecipe(request).
// Shared behaviour (drafts, history, errors, same-seed regeneration) comes from SpeechView.
import { define } from "../lib/element.js";
import { html } from "../lib/dom.js";
import { SpeechView, pick } from "./moss-tts-view.js";
import "./moss-text-editor.js";
import "./moss-gen-controls.js";
import "./moss-take-list.js";

const DEFAULT_LINE = "Hello! This is how I sound when I read a short line out loud.";

const EXAMPLES = [
  ["Calm narrator", "A warm, low-pitched male narrator in his fifties, calm and unhurried, like a nature documentary."],
  ["Bright and upbeat", "A bright, energetic young woman speaking quickly, with a friendly smile in her voice."],
  ["Bedtime story", "An elderly British gentleman, softly spoken and slightly raspy, reading a bedtime story."],
  ["Newsreader", "A crisp, neutral newsreader with clear diction and a measured, confident pace."],
  ["Whisper", "A hushed, breathy whisper close to the microphone, intimate and slow."],
  ["Noir detective", "A gravelly, world-weary detective with a deep voice and dry humour."],
];

const LANGUAGES = ["English", "Chinese", "Japanese", "Korean", "French", "German", "Spanish", "Italian", "Portuguese", "Russian", "Arabic"];

class MossDesignView extends SpeechView {
  static workflow = "design";

  template() {
    return this.frame({
      title: "Voice design",
      intro: "Describe a voice and audition it. Pick the take you like and save it as a voice; it's then used by cloning for a consistent identity.",
      generateLabel: "Audition",
      saveAsVoice: true,
      emptyText: "Takes will appear here. Compare them, then use “Save as voice” on your favourite.",
      fields: html`
        <div class="field">
          <label for="instruction">Voice description</label>
          <textarea id="instruction" name="instruction" rows="4" required
            placeholder="Who is speaking? Age, gender, accent, pitch, pace, mood…"></textarea>
          <div class="chips" role="group" aria-label="Example descriptions">
            ${EXAMPLES.map(([label, text]) => html`<button type="button" class="small" data-example="${text}" title="${text}">${label}</button>`)}
          </div>
          <p class="hint">Be concrete: age, gender, accent, pitch, pace and mood all help. Each take is a different interpretation.</p>
        </div>
        <moss-text-editor name="text" label="Audition line" rows="3" required pause-button
          hint="What the voice says. A sentence or two is enough; the saved voice uses it as its transcript."></moss-text-editor>
        <div class="field">
          <label for="language">Language <span class="faint">(optional)</span></label>
          <input id="language" name="language" list="languages" placeholder="auto" autocomplete="off">
          <datalist id="languages">${LANGUAGES.map((l) => html`<option value="${l}"></option>`)}</datalist>
        </div>
        <moss-gen-controls name="controls" workflow="design" models="tts" model="tts" hide-model variations="4" show-temperature></moss-gen-controls>
        <p class="model-note">Uses the <strong>tts</strong> model (the only one that follows instructions). Four variations give you a real choice; each uses seed, seed+1, …</p>
      `,
    });
  }

  setup() {
    this.instruction = this.$("#instruction");
    this.language = this.$("#language");
    this.editor = this.$("moss-text-editor");
    this.$(".chips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-example]");
      if (!b) return;
      this.instruction.value = b.dataset.example;
      this.instruction.focus();
      this.showError("");
      this.queueDraft();
    });
    if (!this.editor.value) this.editor.value = DEFAULT_LINE;
  }

  validate() {
    if (!this.instruction.value.trim()) {
      this.instruction.focus();
      return "Describe the voice first (or click one of the examples).";
    }
    return "";
  }

  buildRequest() {
    const c = this.controls.values;
    const params = {
      text: this.editor.value,
      lines: false,
      voice: null,
      instruction: this.instruction.value.trim(),
      ...pick({ language: this.language.value.trim() }, ["language"]),
      ...pick(c, ["temperature", "max_seconds"]),
    };
    return { workflow: "design", model: "tts", params, variations: c.variations, seed: c.seed ?? null };
  }

  fillFromRecipe(req, p) {
    if (p.instruction !== undefined) this.instruction.value = p.instruction || "";
    if (p.text !== undefined) {
      this.editor.value = p.text;
      this.language.value = p.language || "";
    } else if (p.language !== undefined) {
      this.language.value = p.language || "";
    }
  }

  draft() {
    return { instruction: this.instruction.value, text: this.editor.value, language: this.language.value };
  }

  restoreDraft(d) {
    if (typeof d.instruction === "string") this.instruction.value = d.instruction;
    if (typeof d.text === "string" && d.text.trim()) this.editor.value = d.text;
    if (typeof d.language === "string") this.language.value = d.language;
  }
}

define("moss-design-view", MossDesignView);
