// <moss-dialogue-view>: route #/dialogue. Multi-speaker dialogue with the TTSD model.
//
// Form: <moss-script-editor> (speakers + lines -> "[S1] … [S2] …", voices per speaker or none),
// optional output name, <moss-gen-controls workflow=dialogue hide-model show-temperature show-max-seconds>.
// Results: <moss-take-list>. Request: {workflow: "dialogue", model, params: {script, voices, max_seconds,
// temperature?, name?}, variations, seed}.
//
// View contract (called by <moss-app>): activated(), generate(), loadRecipe(request), showJob(job).
// Also follows store "show-job" and "recipe" events, handles take-list `regenerate` {take}, keeps a draft
// (script, speaker names, output name) in localStorage "moss-draft:dialogue" and shows the last 6 takes.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, toast } from "../lib/dom.js";
import { viewLayout } from "../lib/styles.js";
import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import "./moss-script-editor.js";
import "./moss-gen-controls.js";
import "./moss-take-list.js";

const WORKFLOW = "dialogue";
const DRAFT_KEY = `moss-draft:${WORKFLOW}`;

const styles = css`
  .error:empty { display: none; }
`;

class MossDialogueView extends MossElement {
  static styles = [viewLayout, styles];

  render() {
    this.setHTML(html`
      <div class="view-head">
        <h2>Dialogue</h2>
        <p>Write a conversation for up to five speakers and render it in one pass with MOSS-TTSD. Give every speaker a
          library voice (with a transcript) or leave them all on model voices.</p>
      </div>
      <div class="layout">
        <form class="stack" novalidate>
          <moss-script-editor name="script" id="script"></moss-script-editor>
          <div class="field">
            <label for="name">Name <span class="faint">(optional)</span></label>
            <input id="name" name="name" type="text" maxlength="80" autocomplete="off" placeholder="Used for the take label and file name">
          </div>
          <moss-gen-controls id="controls" name="controls" workflow="${WORKFLOW}" hide-model show-temperature show-max-seconds max-seconds="600"></moss-gen-controls>
          <div class="stack tight">
            <div class="actions">
              <button type="submit" class="primary big" id="go">${icon("wave", 18)} Generate</button>
              <span class="hint">or <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>Enter</kbd></span>
            </div>
            <div class="error" id="error" role="alert"></div>
          </div>
        </form>
        <div class="results">
          <moss-take-list id="takes" empty-text="Dialogue takes will appear here."></moss-take-list>
        </div>
      </div>
    `);
    this.editor = this.$("#script");
    this.controls = this.$("#controls");
    this.takeList = this.$("#takes");
    this.nameInput = this.$("#name");

    this.$("form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.generate();
    });
    this.editor.addEventListener("change", () => {
      this.clearError();
      this.saveDraft();
    });
    this.nameInput.addEventListener("input", () => this.saveDraft());
    this.takeList.addEventListener("regenerate", (e) => this.regenerate(e.detail?.take));

    this.restoreDraft();
    this.loadRecent();
  }

  connected() {
    store.on("show-job", ({ job }) => this.showJob(job), this.signal);
    store.on("recipe", ({ workflow }) => {
      if (workflow === WORKFLOW && this.hasAttribute("active")) this.takePendingRecipe();
    }, this.signal);
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
    this.editor.setValues({
      ...(p.script !== undefined || p.text !== undefined ? { script: p.script ?? p.text } : {}),
      voices: Array.isArray(p.voices) ? p.voices : [],
    });
    this.nameInput.value = p.name || "";
    const v = {};
    if (request.model) v.model = request.model;
    if (request.variations) v.variations = request.variations;
    if (p.max_seconds !== undefined) v.max_seconds = p.max_seconds ?? null;
    v.temperature = p.temperature ?? null;
    this.controls.setValues(v);
    if (request.seed !== undefined && request.seed !== null) this.controls.useSeed(request.seed);
    this.clearError();
    this.saveDraft();
  }

  async generate() {
    if (this.busy) return;
    this.clearError();
    const problem = this.editor.validate();
    if (problem) return this.showError(problem);
    const c = this.controls.values;
    const params = { ...this.editor.values };
    if (c.max_seconds != null) params.max_seconds = c.max_seconds;
    if (c.temperature != null) params.temperature = c.temperature;
    const name = this.nameInput.value.trim();
    if (name) params.name = name;
    const req = {
      workflow: WORKFLOW,
      model: c.model || WORKFLOW,
      params,
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
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          script: this.editor.script,
          names: this.editor.speakers.map((s) => s.name),
          name: this.nameInput.value,
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
    const v = {};
    if (d.script) v.script = d.script;
    if (Array.isArray(d.names)) v.names = d.names;
    if (Object.keys(v).length) this.editor.setValues(v);
    if (typeof d.name === "string") this.nameInput.value = d.name;
  }
}

define("moss-dialogue-view", MossDialogueView);
