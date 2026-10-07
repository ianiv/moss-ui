// <moss-sfx-view>: route #/sfx. Sound effects with MOSS-SoundEffect.
//
// Modes (segmented): Single = one description + length (0.5–60 s, quick chips 2/5/8/15);
// Pack = "seconds | prompt" lines (# comments and blank lines skipped; lines without a length use the
// default length) with a live parsed preview: count, total seconds, invalid lines flagged (Generate is
// blocked until they're fixed). Sampling: the model-card preset is on by default; unchecking reveals
// temperature / top_p / top_k / repetition_penalty prefilled with the preset.
// Request: {workflow: "sfx", model: "sfx", params: {prompt, seconds, pack, sampling?}, variations, seed}.
//
// View contract (called by <moss-app>): activated(), generate(), loadRecipe(request), showJob(job).
// Also follows store "show-job" and "recipe" events, handles take-list `regenerate` {take}, keeps a draft
// in localStorage "moss-draft:sfx" and shows the last 6 takes.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, toast, fmtSeconds } from "../lib/dom.js";
import { viewLayout } from "../lib/styles.js";
import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import "./moss-gen-controls.js";
import "./moss-take-list.js";

const WORKFLOW = "sfx";
const DRAFT_KEY = `moss-draft:${WORKFLOW}`;
const MIN_S = 0.5;
const MAX_S = 60;
const DEFAULT_S = 8;
const PRESET_FALLBACK = { audio_temperature: 1.5, audio_top_p: 0.6, audio_top_k: 50, audio_repetition_penalty: 1.2 };
const EXAMPLE_PACK = `10 | Steady rain pattering on a window, distant soft thunder.
10 | Busy coffee shop ambience, cups clinking, espresso machine hissing, murmured chatter.
10 | A crackling campfire at night with crickets in the background.
6 | Clear footsteps echoing on concrete at a steady rhythm.
5 | A heavy wooden door creaks open slowly, then slams shut.
3 | A glass bottle shattering on a tile floor.`;
const SINGLE_EXAMPLES = [
  "Steady rain pattering on a window, distant soft thunder.",
  "A heavy wooden door creaks open slowly, then slams shut.",
  "A crackling campfire at night with crickets in the background.",
  "A glass bottle shattering on a tile floor.",
];

const styles = css`
  .error:empty { display: none; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chips button { border-radius: var(--radius-pill); }
  .secs { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
  .secs input { width: 7em; }
  #pack-text { font-family: var(--mono); font-size: var(--fs-sm); min-height: 12em; }
  .preview { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
  .preview .sum { display: flex; justify-content: space-between; gap: var(--sp-2); padding: 6px 10px; background: var(--surface-2); font-size: var(--fs-sm); flex-wrap: wrap; }
  .preview ol { list-style: none; margin: 0; padding: 0; max-height: 16em; overflow: auto; font-size: var(--fs-sm); }
  .preview li { display: grid; grid-template-columns: 3.5em 5em minmax(0, 1fr); gap: var(--sp-2); padding: 4px 10px; border-top: 1px solid var(--border); align-items: baseline; }
  .preview li .n { color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); }
  .preview li .s { font-family: var(--mono); }
  .preview li .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview li[data-bad] { background: var(--danger-soft); color: var(--danger); }
  .preview li[data-bad] .p { white-space: normal; }
  .preview li .why { grid-column: 3; font-size: var(--fs-xs); }
  .preview .none { padding: var(--sp-3); color: var(--text-3); font-size: var(--fs-sm); }
  .custom { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--sp-3); }
`;

/**
 * Parse pack text like the server (moss_core.sfx_items): skip blanks and "#" lines; "N | prompt" sets the
 * length, other lines use defaultSeconds. Stricter than the server: a line with "|" that isn't
 * "number | prompt" is flagged instead of being sent whole as a prompt.
 * -> {items: [{line, seconds, prompt, error}], valid, invalid, total}
 */
export function parsePack(text, defaultSeconds) {
  const items = [];
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(/^(\d+(?:\.\d+)?)\s*\|\s*(.+)$/);
    let seconds = defaultSeconds;
    let prompt = line;
    let error = "";
    if (m) {
      seconds = parseFloat(m[1]);
      prompt = m[2].trim();
    } else if (line.includes("|")) {
      error = 'Use "seconds | description", e.g. "5 | A door slams".';
    }
    if (!error && !(seconds >= MIN_S && seconds <= MAX_S)) {
      error = Number.isFinite(seconds) ? `Length must be ${MIN_S}–${MAX_S} s.` : "No valid default length.";
    }
    items.push({ line: i + 1, seconds, prompt, error });
  });
  const ok = items.filter((x) => !x.error);
  return { items, valid: ok.length, invalid: items.length - ok.length, total: ok.reduce((a, x) => a + x.seconds, 0) };
}

class MossSfxView extends MossElement {
  static styles = [viewLayout, styles];

  render() {
    const preset = this.preset();
    this.setHTML(html`
      <div class="view-head">
        <h2>Sound effects</h2>
        <p>Describe a sound (English or Chinese) and pick its length; every run is bounded to ${MIN_S}–${MAX_S} s.
          Pack mode renders a list of sounds in one batch.</p>
      </div>
      <div class="layout">
        <form class="stack" novalidate>
          <div class="seg" role="radiogroup" aria-label="Mode">
            <label><input type="radio" name="mode" value="single" checked><span>Single</span></label>
            <label><input type="radio" name="mode" value="pack"><span>Pack</span></label>
          </div>

          <div class="stack" id="single">
            <div class="field">
              <label for="prompt">Sound description</label>
              <textarea id="prompt" rows="4" placeholder="A heavy wooden door creaks open slowly, then slams shut."></textarea>
              <div class="chips" aria-label="Examples">
                ${SINGLE_EXAMPLES.map((t) => html`<button type="button" class="small" data-example="${t}">${t.split(/[,.]/)[0]}</button>`)}
              </div>
            </div>
          </div>

          <div class="stack" id="pack" hidden>
            <div class="field">
              <div class="row between">
                <label for="pack-text">Sounds, one per line: <code>seconds | description</code></label>
                <button type="button" class="small ghost" id="example">${icon("open", 14)} Load example</button>
              </div>
              <textarea id="pack-text" rows="8" spellcheck="false" placeholder="${"10 | Steady rain on a window\n3 | A glass bottle shattering\n# comments are skipped"}"></textarea>
            </div>
            <div class="preview" id="preview" aria-live="polite"></div>
          </div>

          <div class="field">
            <label for="seconds" id="seconds-label">Length (seconds)</label>
            <div class="secs">
              <input id="seconds" type="number" min="${MIN_S}" max="${MAX_S}" step="0.5" value="${DEFAULT_S}" inputmode="decimal">
              <div class="chips" role="group" aria-label="Quick lengths">
                ${[2, 5, 8, 15].map((s) => html`<button type="button" class="small" data-secs="${s}" aria-label="${s} seconds">${s} s</button>`)}
              </div>
            </div>
            <span class="hint" id="seconds-hint">${MIN_S}–${MAX_S} s.</span>
          </div>

          <fieldset class="stack tight">
            <legend>Sampling</legend>
            <label class="check"><input type="checkbox" id="preset" checked>
              Model-card preset (temp ${preset.audio_temperature}, top-p ${preset.audio_top_p}, top-k ${preset.audio_top_k}, repetition ${preset.audio_repetition_penalty})</label>
            <div class="custom" id="custom" hidden>
              <div class="field"><label for="s-temp">Temperature</label><input id="s-temp" type="number" step="0.05" min="0" value="${preset.audio_temperature}"></div>
              <div class="field"><label for="s-topp">Top-p</label><input id="s-topp" type="number" step="0.05" min="0" max="1" value="${preset.audio_top_p}"></div>
              <div class="field"><label for="s-topk">Top-k</label><input id="s-topk" type="number" step="1" min="1" value="${preset.audio_top_k}"></div>
              <div class="field"><label for="s-rep">Repetition penalty</label><input id="s-rep" type="number" step="0.05" min="0" value="${preset.audio_repetition_penalty}"></div>
            </div>
          </fieldset>

          <moss-gen-controls id="controls" name="controls" workflow="${WORKFLOW}" hide-model></moss-gen-controls>

          <div class="stack tight">
            <div class="actions">
              <button type="submit" class="primary big" id="go">${icon("wave", 18)} Generate</button>
              <span class="hint">or <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>Enter</kbd></span>
            </div>
            <div class="error" id="error" role="alert"></div>
          </div>
        </form>
        <div class="results">
          <moss-take-list id="takes" empty-text="Sounds will appear here."></moss-take-list>
        </div>
      </div>
    `);
    this.controls = this.$("#controls");
    this.takeList = this.$("#takes");

    const form = this.$("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.generate();
    });
    form.addEventListener("input", () => {
      this.clearError();
      this.updatePreview();
      this.saveDraft();
    });
    form.addEventListener("change", (e) => {
      if (e.target.name === "mode") this.setMode(e.target.value);
      if (e.target.id === "preset") this.$("#custom").hidden = e.target.checked;
    });
    form.addEventListener("click", (e) => {
      const chip = e.target.closest("button[data-secs]");
      if (chip) this.setSeconds(+chip.dataset.secs);
      const ex = e.target.closest("button[data-example]");
      if (ex) {
        this.$("#prompt").value = ex.dataset.example;
        this.$("#prompt").focus();
        this.saveDraft();
      }
    });
    this.$("#example").addEventListener("click", () => {
      const t = this.$("#pack-text");
      if (t.value.trim() && t.value.trim() !== EXAMPLE_PACK && !confirm("Replace the current pack with the example?")) return;
      t.value = EXAMPLE_PACK;
      this.updatePreview();
      this.saveDraft();
    });
    this.takeList.addEventListener("regenerate", (e) => this.regenerate(e.detail?.take));

    this.restoreDraft();
    this.setMode(this.mode);
    this.loadRecent();
  }

  connected() {
    store.on("show-job", ({ job }) => this.showJob(job), this.signal);
    store.on("recipe", ({ workflow }) => {
      if (workflow === WORKFLOW && this.hasAttribute("active")) this.takePendingRecipe();
    }, this.signal);
    // The preset comes from the server; refresh the labels/defaults once models load.
    store.on("models", () => this.applyPresetText(), this.signal);
  }

  // ---------- view contract ----------

  activated() {
    this.takePendingRecipe();
    store.warmIfIdle(this.controls.model || WORKFLOW);
  }

  showJob(job) {
    if (job?.workflow === WORKFLOW) this.takeList.trackJob(job.id);
  }

  loadRecipe(request) {
    if (!request) return;
    const p = request.params || {};
    const pack = !!p.pack;
    this.setMode(pack ? "pack" : "single");
    const text = p.prompt ?? p.text ?? "";
    if (pack) this.$("#pack-text").value = text;
    else this.$("#prompt").value = text;
    this.$("#seconds").value = p.seconds ?? DEFAULT_S;
    const s = p.sampling && typeof p.sampling === "object" ? p.sampling : null;
    this.$("#preset").checked = !s;
    this.$("#custom").hidden = !s;
    const preset = this.preset();
    this.$("#s-temp").value = s?.temperature ?? preset.audio_temperature;
    this.$("#s-topp").value = s?.top_p ?? preset.audio_top_p;
    this.$("#s-topk").value = s?.top_k ?? preset.audio_top_k;
    this.$("#s-rep").value = s?.repetition_penalty ?? preset.audio_repetition_penalty;
    const v = {};
    if (request.model) v.model = request.model;
    if (request.variations) v.variations = request.variations;
    this.controls.setValues(v);
    if (request.seed !== undefined && request.seed !== null) this.controls.useSeed(request.seed);
    this.clearError();
    this.updatePreview();
    this.saveDraft();
  }

  async generate() {
    if (this.busy) return;
    this.clearError();
    const built = this.buildParams();
    if (built.error) return this.showError(built.error);
    const c = this.controls.values;
    const req = {
      workflow: WORKFLOW,
      model: c.model || WORKFLOW,
      params: built.params,
      variations: c.variations || 1,
      seed: c.seed ?? null,
    };
    this.setBusy(true);
    try {
      const job = await store.submit(req);
      this.takeList.trackJob(job.id);
      this.controls.noteRun(job);
    } catch (e) {
      this.showError(e.message || String(e));
      toast(e.message || String(e), "error");
    } finally {
      this.setBusy(false);
    }
  }

  // ---------- internals ----------

  get mode() {
    return this.$("input[name=mode]:checked")?.value || "single";
  }

  setMode(mode) {
    const pack = mode === "pack";
    const radio = this.$(`input[name=mode][value=${pack ? "pack" : "single"}]`);
    if (radio) radio.checked = true;
    this.$("#single").hidden = pack;
    this.$("#pack").hidden = !pack;
    this.$("#seconds-label").textContent = pack ? "Default length (seconds)" : "Length (seconds)";
    this.$("#seconds-hint").textContent = pack
      ? `Used for lines without "seconds |". ${MIN_S}–${MAX_S} s.`
      : `${MIN_S}–${MAX_S} s.`;
    this.updatePreview();
    this.saveDraft();
  }

  setSeconds(s) {
    this.$("#seconds").value = s;
    this.clearError();
    this.updatePreview();
    this.saveDraft();
  }

  /** Preset from the server (store.info.sfx_sampling) with the model-card values as a fallback. */
  preset() {
    return { ...PRESET_FALLBACK, ...(store.info?.sfx_sampling || {}) };
  }

  applyPresetText() {
    const p = this.preset();
    const label = this.$("#preset")?.parentElement;
    if (label?.lastChild) {
      label.lastChild.textContent = ` Model-card preset (temp ${p.audio_temperature}, top-p ${p.audio_top_p}, top-k ${p.audio_top_k}, repetition ${p.audio_repetition_penalty})`;
    }
    if (this.$("#preset")?.checked) {
      this.$("#s-temp").value = p.audio_temperature;
      this.$("#s-topp").value = p.audio_top_p;
      this.$("#s-topk").value = p.audio_top_k;
      this.$("#s-rep").value = p.audio_repetition_penalty;
    }
  }

  seconds() {
    const raw = this.$("#seconds").value.trim();
    return raw === "" ? DEFAULT_S : parseFloat(raw);
  }

  updatePreview() {
    const box = this.$("#preview");
    if (!box || this.mode !== "pack") return;
    const def = this.seconds();
    const r = parsePack(this.$("#pack-text").value, def);
    if (!r.items.length) {
      box.innerHTML = String(html`<div class="none">Add lines like <code>5 | A door slams</code>, or load the example.</div>`);
      return;
    }
    box.innerHTML = String(html`
      <div class="sum">
        <strong>${r.valid} sound${r.valid === 1 ? "" : "s"}, ${fmtTotal(r.total)} total</strong>
        ${r.invalid ? html`<span class="badge danger">${r.invalid} invalid line${r.invalid === 1 ? "" : "s"}</span>` : ""}
      </div>
      <ol>
        ${r.items.map((x) => html`
          <li ${x.error ? "data-bad" : ""}>
            <span class="n">L${x.line}</span>
            <span class="s">${Number.isFinite(x.seconds) ? `${x.seconds} s` : "?"}</span>
            <span class="p" title="${x.prompt}">${x.prompt}</span>
            ${x.error ? html`<span class="why">${x.error}</span>` : ""}
          </li>`)}
      </ol>
    `);
  }

  /** -> {params} or {error} */
  buildParams() {
    const seconds = this.seconds();
    const pack = this.mode === "pack";
    if (!(seconds >= MIN_S && seconds <= MAX_S)) {
      return { error: `${pack ? "Default length" : "Length"} must be between ${MIN_S} and ${MAX_S} seconds.` };
    }
    let prompt;
    if (pack) {
      prompt = this.$("#pack-text").value;
      const r = parsePack(prompt, seconds);
      if (!r.items.length) return { error: 'Add at least one "seconds | description" line.' };
      const bad = r.items.find((x) => x.error);
      if (bad) return { error: `Line ${bad.line}: ${bad.error}` };
    } else {
      prompt = this.$("#prompt").value.trim();
      if (!prompt) return { error: "Describe the sound." };
    }
    const params = { prompt, seconds, pack };
    if (!this.$("#preset").checked) {
      const num = (id) => {
        const v = this.$(id).value.trim();
        return v === "" ? null : parseFloat(v);
      };
      const s = {
        temperature: num("#s-temp"),
        top_p: num("#s-topp"),
        top_k: num("#s-topk"),
        repetition_penalty: num("#s-rep"),
      };
      for (const [k, v] of Object.entries(s)) {
        if (v === null) delete s[k];
        else if (!Number.isFinite(v) || v < 0) return { error: `Sampling ${k.replace("_", " ")} must be a non-negative number.` };
      }
      if (s.top_p !== undefined && s.top_p > 1) return { error: "Sampling top-p must be between 0 and 1." };
      if (s.top_k !== undefined) s.top_k = Math.max(1, Math.round(s.top_k));
      params.sampling = s;
    }
    return { params };
  }

  takePendingRecipe() {
    const r = store.takeRecipe(WORKFLOW);
    if (r) this.loadRecipe(r);
  }

  regenerate(take) {
    if (!take) return;
    this.loadRecipe(take.request);
    if (take.seed !== undefined && take.seed !== null) this.controls.useSeed(take.seed);
    this.controls.setValues({ variations: 1 });
    this.generate();
  }

  async loadRecent() {
    try {
      const takes = await api.history({ workflow: WORKFLOW, limit: 6 });
      if (takes?.length && !this.takeList.takes?.length) this.takeList.setTakes(takes);
    } catch {
      // Not fatal: the list just starts empty.
    }
  }

  setBusy(on) {
    this.busy = on;
    this.$("#go").disabled = on;
  }

  showError(msg) {
    this.$("#error").textContent = msg;
  }

  clearError() {
    this.$("#error").textContent = "";
  }

  saveDraft() {
    if (this._restoring) return;
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          mode: this.mode,
          prompt: this.$("#prompt").value,
          pack: this.$("#pack-text").value,
          seconds: this.$("#seconds").value,
        }));
      } catch {}
    }, 400);
  }

  restoreDraft() {
    let d = null;
    try {
      d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    } catch {}
    if (!d) return;
    this._restoring = true;
    if (typeof d.prompt === "string") this.$("#prompt").value = d.prompt;
    if (typeof d.pack === "string") this.$("#pack-text").value = d.pack;
    if (d.seconds !== undefined && d.seconds !== "") this.$("#seconds").value = d.seconds;
    if (d.mode === "pack" || d.mode === "single") this.$(`input[name=mode][value=${d.mode}]`).checked = true;
    this._restoring = false;
  }
}

function fmtTotal(s) {
  const r = Math.round(s * 10) / 10;
  return r < 60 ? `${r} s` : fmtSeconds(r);
}

define("moss-sfx-view", MossSfxView);
