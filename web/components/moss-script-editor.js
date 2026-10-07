// <moss-script-editor name="script">: dialogue editor for the TTSD model (form-associated).
//
// Speakers are chips S1…Sn (1–5), each with an editable display name (UI only) and a
// <moss-voice-picker allow-none require-transcript> ("Model voice" when none). Rows are
// (speaker, line) pairs: add / remove / move up / down; Enter in a line moves to the next row and adds
// one after the last row (Shift+Enter is ignored, lines are single paragraphs); Backspace in an empty
// row removes it. "Paste script" opens a dialog that parses `[S1] … [S2] …` (one line or many) into rows.
//
// Public API
//   props   script   get: "[S1] line [S2] line …" (empty lines skipped, whitespace collapsed); set: parse
//           voices   voice ids for speakers S1…S<highest used>, or [] when no speaker has a voice
//           speakers [{name, voice}] (get/set)
//           values   {script, voices};  setValues({script, voices, names?})
//           validate() -> error string or "" (lines present, speakers used without gaps,
//                     all voiced or none, voiced speakers have transcripts, no stray [Sn] tags in lines)
//   form    setFormValue(FormData {script, voices: JSON}); valueMissing when `required` and no lines
//   events  `change` (bubbling, composed) after any edit; native `input` events also bubble out
//   static  MossScriptEditor.parse(text) -> {rows: [{speaker, text}], count, error}
//           MossScriptEditor.build(rows) -> script string
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, emit, estimateSeconds, fmtSeconds } from "../lib/dom.js";
import { store } from "../lib/store.js";
import "./moss-voice-picker.js";

const MAX_SPEAKERS = 5;
const HUES = [160, 25, 220, 300, 55];

const styles = css`
  :host { display: block; }
  .speakers { display: grid; gap: var(--sp-2); }
  .spk {
    display: grid; grid-template-columns: auto minmax(90px, 1fr) minmax(150px, 1.4fr) auto; gap: var(--sp-2);
    align-items: center; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface); border-left: 4px solid hsl(var(--h) 50% 50%);
  }
  .tag {
    font-family: var(--mono); font-size: var(--fs-xs); font-weight: 600; padding: 2px 7px; border-radius: var(--radius-pill);
    background: hsl(var(--h) 50% 50% / .16); color: hsl(var(--h) 45% 40%);
  }
  @media (prefers-color-scheme: dark) { .tag { color: hsl(var(--h) 55% 70%); } }
  .spk input { padding: 5px 8px; font-size: var(--fs-sm); }
  @container (max-width: 520px) { .spk { grid-template-columns: auto 1fr auto; } .spk moss-voice-picker { grid-column: 1 / -1; } }
  .spk[data-unused] { opacity: .75; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  li {
    display: grid; grid-template-columns: 130px minmax(0, 1fr) auto; gap: 6px; align-items: start;
    border-left: 4px solid hsl(var(--h) 50% 50%); padding-left: 6px;
  }
  li select { padding: 6px 8px; font-size: var(--fs-sm); }
  li textarea { min-height: 2.4em; padding: 6px 10px; field-sizing: content; max-height: 14em; resize: vertical; }
  .tools { display: flex; gap: 2px; }
  .tools button { min-width: 28px; min-height: 28px; padding: 4px; }
  @container (max-width: 520px) { li { grid-template-columns: 1fr auto; } li textarea { grid-column: 1 / -1; grid-row: 2; } }
  .wrap { container-type: inline-size; display: grid; gap: var(--sp-3); }
  .foot { display: flex; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
  dialog textarea { min-height: 14em; font-family: var(--mono); font-size: var(--fs-sm); }
`;

/** Collapse whitespace so a row is one paragraph. */
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** "[S1] a [S2] b" (any line breaks) -> {rows, count, error}. */
export function parseScript(text) {
  const parts = String(text ?? "").split(/\[S(\d+)\]/i);
  const rows = [];
  if (parts.length === 1) {
    return clean(parts[0])
      ? { rows: [], count: 0, error: 'No speaker tags found. Start each turn with [S1], [S2], … e.g. "[S1] Hi! [S2] Hello."' }
      : { rows: [], count: 0, error: "The script is empty." };
  }
  const pre = clean(parts[0]);
  if (pre) rows.push({ speaker: 1, text: pre });
  let count = pre ? 1 : 0;
  for (let i = 1; i < parts.length; i += 2) {
    const speaker = parseInt(parts[i], 10);
    if (!(speaker >= 1)) return { rows: [], count: 0, error: `[S${parts[i]}] isn't a valid speaker; numbering starts at S1.` };
    if (speaker > MAX_SPEAKERS) return { rows: [], count: 0, error: `At most ${MAX_SPEAKERS} speakers (found [S${speaker}]).` };
    count = Math.max(count, speaker);
    const t = clean(parts[i + 1]);
    if (t) rows.push({ speaker, text: t });
  }
  if (!rows.length) return { rows: [], count, error: "The script has speaker tags but no lines." };
  return { rows, count, error: "" };
}

/** rows -> "[S1] a [S2] b" (empty rows skipped). */
export function buildScript(rows) {
  return rows
    .map((r) => ({ speaker: r.speaker, text: clean(r.text) }))
    .filter((r) => r.text)
    .map((r) => `[S${r.speaker}] ${r.text}`)
    .join(" ");
}

const defaultName = (i) => `Speaker ${i + 1}`;

class MossScriptEditor extends MossElement {
  static styles = [styles];
  static formAssociated = true;
  static parse = parseScript;
  static build = buildScript;

  constructor() {
    super();
    this.internals = this.attachInternals();
    this._speakers = [{ name: defaultName(0), voice: "" }, { name: defaultName(1), voice: "" }];
    this._rows = [{ speaker: 1, text: "" }, { speaker: 2, text: "" }];
  }

  render() {
    this.setHTML(html`
      <div class="wrap">
        <fieldset>
          <legend>Speakers</legend>
          <div class="stack tight">
            <div class="speakers" id="speakers"></div>
            <div class="row between">
              <button type="button" class="small" id="add-speaker">${icon("plus", 14)} Add speaker</button>
              <span class="hint">Give every speaker a voice, or none (model voices). Voices need a transcript.</span>
            </div>
          </div>
        </fieldset>
        <div class="stack tight">
          <div class="row between">
            <span class="label" id="lines-label">Lines</span>
            <button type="button" class="small ghost" id="paste">${icon("edit", 14)} Paste script</button>
          </div>
          <ol id="rows" aria-labelledby="lines-label"></ol>
          <div class="foot">
            <button type="button" class="small" id="add-row">${icon("plus", 14)} Add line</button>
            <span class="hint" id="count" aria-live="polite"></span>
          </div>
        </div>
      </div>
      <dialog id="paste-dlg" aria-labelledby="paste-title">
        <form method="dialog" class="stack">
          <h3 id="paste-title">Paste script</h3>
          <p class="small muted">Tag each turn with <code>[S1]</code>, <code>[S2]</code>, … on one line or one turn per line.
            This replaces the current lines; speaker names and voices are kept.</p>
          <textarea id="paste-text" rows="10" aria-label="Script" spellcheck="false"
            placeholder="[S1] Did you hear that? [S2] Hear what?"></textarea>
          <div class="error" id="paste-error" role="alert" hidden></div>
          <div class="row end">
            <button type="button" value="cancel" id="paste-cancel">Cancel</button>
            <button type="submit" class="primary" id="paste-ok">Replace lines</button>
          </div>
        </form>
      </dialog>
    `);

    this.$("#add-speaker").addEventListener("click", () => this.addSpeaker());
    this.$("#add-row").addEventListener("click", () => {
      const last = this._rows.at(-1);
      this.insertRow(this._rows.length, this.nextSpeaker(last?.speaker));
    });
    this.$("#paste").addEventListener("click", () => this.openPaste());
    this.$("#paste-cancel").addEventListener("click", () => this.$("#paste-dlg").close());
    this.$("#paste-dlg form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.applyPaste();
    });

    // Speakers: names, voices, remove.
    const sp = this.$("#speakers");
    sp.addEventListener("input", (e) => {
      const i = this.indexOf(e.target, ".spk");
      if (i < 0 || !e.target.matches("input.name")) return;
      this._speakers[i].name = e.target.value;
      this.refreshOptions();
      this.changed();
    });
    sp.addEventListener("change", (e) => {
      if (e.target.localName !== "moss-voice-picker") return;
      e.stopPropagation(); // re-emitted as our own change
      const i = this.indexOf(e.target, ".spk");
      if (i < 0) return;
      this._speakers[i].voice = e.target.value || "";
      this.changed();
    });
    sp.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act=remove-speaker]");
      if (b) this.removeSpeaker(this.indexOf(b, ".spk"));
    });

    // Rows: text, speaker, tools, keys.
    const ol = this.$("#rows");
    ol.addEventListener("input", (e) => {
      const i = this.indexOf(e.target, "li");
      if (i < 0 || e.target.localName !== "textarea") return;
      this._rows[i].text = e.target.value;
      this.changed();
    });
    ol.addEventListener("change", (e) => {
      const i = this.indexOf(e.target, "li");
      if (i < 0 || e.target.localName !== "select") return;
      this._rows[i].speaker = +e.target.value;
      e.target.closest("li").style.setProperty("--h", HUES[this._rows[i].speaker - 1]);
      this.changed();
    });
    ol.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const i = this.indexOf(b, "li");
      if (b.dataset.act === "up") this.moveRow(i, -1);
      if (b.dataset.act === "down") this.moveRow(i, 1);
      if (b.dataset.act === "remove") this.removeRow(i);
    });
    ol.addEventListener("keydown", (e) => this.onRowKey(e));

    this.renderSpeakers();
    this.renderRows();
    this.sync();
  }

  // ---------- public API ----------

  get script() {
    return buildScript(this._rows);
  }

  set script(text) {
    this.setValues({ script: text });
  }

  /** Voice ids for S1…S<highest used> (all speakers when no lines), or [] when none is voiced. */
  get voices() {
    const n = this.maxUsed() || this._speakers.length;
    const ids = this._speakers.slice(0, n).map((s) => s.voice || "");
    return ids.some(Boolean) ? ids : [];
  }

  set voices(ids) {
    ids = Array.isArray(ids) ? ids : [];
    this.ensureSpeakers(ids.length);
    this._speakers.forEach((s, i) => (s.voice = ids[i] || ""));
    this.rerender();
  }

  get speakers() {
    return this._speakers.map((s) => ({ ...s }));
  }

  set speakers(list) {
    list = (Array.isArray(list) ? list : []).slice(0, MAX_SPEAKERS);
    if (!list.length) list = [{}];
    this._speakers = list.map((s, i) => ({ name: s?.name || defaultName(i), voice: s?.voice || "" }));
    const n = this._speakers.length;
    for (const r of this._rows) if (r.speaker > n) r.speaker = n;
    this.rerender();
  }

  get values() {
    return { script: this.script, voices: this.voices };
  }

  /** {script, voices, names?}: missing keys untouched. */
  setValues({ script, voices, names } = {}) {
    if (script !== undefined) {
      const r = parseScript(script);
      this._rows = r.rows.length ? r.rows : [{ speaker: 1, text: "" }];
      this.ensureSpeakers(Math.max(r.count, 1));
    }
    if (voices !== undefined) {
      const ids = Array.isArray(voices) ? voices : [];
      this.ensureSpeakers(ids.length);
      this._speakers.forEach((s, i) => (s.voice = ids[i] || ""));
    }
    if (Array.isArray(names)) {
      this.ensureSpeakers(Math.min(names.length, MAX_SPEAKERS));
      names.slice(0, MAX_SPEAKERS).forEach((n, i) => (this._speakers[i].name = n || defaultName(i)));
    }
    this.rerender();
  }

  /** Error message for the current script, or "" when it can be submitted. */
  validate() {
    const rows = this._rows.filter((r) => clean(r.text));
    if (!rows.length) return "Write at least one line.";
    const stray = rows.findIndex((r) => /\[S\d+\]/i.test(r.text));
    if (stray >= 0) return `Line ${this._rows.indexOf(rows[stray]) + 1} contains a speaker tag like [S1]; pick the speaker in the row instead, or use Paste script.`;
    const used = new Set(rows.map((r) => r.speaker));
    const max = Math.max(...used);
    for (let s = 1; s < max; s++) {
      if (!used.has(s)) return `${this.nameOf(s)} (S${s}) has no lines. Give them a line or remove that speaker; speakers must be numbered without gaps.`;
    }
    const sp = this._speakers.slice(0, max);
    const voiced = sp.filter((s) => s.voice);
    if (voiced.length && voiced.length !== sp.length) {
      const missing = sp.map((s, i) => (s.voice ? null : this.nameOf(i + 1))).filter(Boolean);
      return `Pick a voice for every speaker or for none. Missing: ${missing.join(", ")}.`;
    }
    for (const [i, s] of sp.entries()) {
      if (!s.voice) continue;
      const v = store.voice(s.voice);
      if (v && !String(v.transcript || "").trim()) {
        return `${this.nameOf(i + 1)}'s voice "${v.name}" has no transcript; add one in the Library (dialogue needs it).`;
      }
    }
    return "";
  }

  focus(opts) {
    this.$("#rows textarea")?.focus(opts);
  }

  formResetCallback() {
    this._speakers = [{ name: defaultName(0), voice: "" }, { name: defaultName(1), voice: "" }];
    this._rows = [{ speaker: 1, text: "" }, { speaker: 2, text: "" }];
    this.rerender();
  }

  // ---------- internals ----------

  nameOf(n) {
    return clean(this._speakers[n - 1]?.name) || defaultName(n - 1);
  }

  maxUsed() {
    let m = 0;
    for (const r of this._rows) if (clean(r.text)) m = Math.max(m, r.speaker);
    return m;
  }

  ensureSpeakers(n) {
    n = Math.min(Math.max(n, 1), MAX_SPEAKERS);
    while (this._speakers.length < n) this._speakers.push({ name: defaultName(this._speakers.length), voice: "" });
  }

  nextSpeaker(after) {
    const n = this._speakers.length;
    return after ? (after % n) + 1 : 1;
  }

  indexOf(el, sel) {
    const item = el.closest(sel);
    return item ? [...item.parentElement.children].indexOf(item) : -1;
  }

  rerender() {
    if (!this._rendered || !this.shadowRoot.firstChild) {
      this.sync();
      return;
    }
    this.renderSpeakers();
    this.renderRows();
    this.changed();
  }

  renderSpeakers() {
    const box = this.$("#speakers");
    if (!box) return;
    box.replaceChildren();
    const single = this._speakers.length <= 1;
    this._speakers.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "spk";
      row.style.setProperty("--h", HUES[i]);
      row.innerHTML = String(html`
        <span class="tag" title="Sent to the model as [S${i + 1}]">S${i + 1}</span>
        <input class="name" type="text" value="${s.name}" aria-label="Display name for speaker ${i + 1}" maxlength="40">
        <span class="picker-slot"></span>
        <button type="button" class="ghost icon" data-act="remove-speaker" aria-label="Remove speaker ${i + 1}"
          title="Remove speaker" ${single ? "disabled" : ""}>${icon("trash", 15)}</button>
      `);
      // Created programmatically so the element is upgraded before we set its value.
      const picker = document.createElement("moss-voice-picker");
      picker.setAttribute("allow-none", "");
      picker.setAttribute("require-transcript", "");
      picker.setAttribute("compact", "");
      picker.setAttribute("none-label", "Model voice");
      picker.setAttribute("label", `Voice for speaker ${i + 1}`);
      row.querySelector(".picker-slot").replaceWith(picker);
      box.append(row);
      picker.value = s.voice || "";
    });
    this.$("#add-speaker").disabled = this._speakers.length >= MAX_SPEAKERS;
    this.markUnused();
  }

  options(selected) {
    return this._speakers.map((s, i) => html`<option value="${i + 1}" ${i + 1 === selected ? "selected" : ""}>S${i + 1} · ${clean(s.name) || defaultName(i)}</option>`);
  }

  renderRows() {
    const ol = this.$("#rows");
    if (!ol) return;
    const n = this._rows.length;
    ol.innerHTML = this._rows
      .map((r, i) => String(html`
        <li style="--h: ${HUES[r.speaker - 1]}">
          <select aria-label="Speaker for line ${i + 1}">${this.options(r.speaker)}</select>
          <textarea rows="1" aria-label="Line ${i + 1}" placeholder="${i === 0 ? "What do they say?" : ""}"></textarea>
          <div class="tools">
            <button type="button" class="ghost icon" data-act="up" aria-label="Move line ${i + 1} up" title="Move up" ${i === 0 ? "disabled" : ""}>${icon("up", 14)}</button>
            <button type="button" class="ghost icon" data-act="down" aria-label="Move line ${i + 1} down" title="Move down" ${i === n - 1 ? "disabled" : ""}>${icon("down", 14)}</button>
            <button type="button" class="ghost icon" data-act="remove" aria-label="Remove line ${i + 1}" title="Remove line" ${n <= 1 ? "disabled" : ""}>${icon("x", 14)}</button>
          </div>
        </li>`))
      .join("");
    // Set text via property (keeps newlines/quotes exact and avoids re-parsing).
    [...ol.querySelectorAll("textarea")].forEach((t, i) => (t.value = this._rows[i].text));
  }

  refreshOptions() {
    for (const [i, sel] of this.$$("#rows select").entries()) {
      sel.innerHTML = this.options(this._rows[i].speaker).join("");
    }
  }

  markUnused() {
    const used = new Set(this._rows.filter((r) => clean(r.text)).map((r) => r.speaker));
    this.$$(".spk").forEach((el, i) => el.toggleAttribute("data-unused", !used.has(i + 1)));
  }

  addSpeaker() {
    if (this._speakers.length >= MAX_SPEAKERS) return;
    this._speakers.push({ name: defaultName(this._speakers.length), voice: "" });
    this.renderSpeakers();
    this.refreshOptions();
    this.$$(".spk input.name").at(-1)?.focus();
    this.changed();
  }

  removeSpeaker(i) {
    if (i < 0 || this._speakers.length <= 1) return;
    const n = i + 1;
    const lines = this._rows.filter((r) => r.speaker === n && clean(r.text)).length;
    if (lines && !confirm(`Remove ${this.nameOf(n)} and their ${lines} line${lines === 1 ? "" : "s"}?`)) return;
    this._speakers.splice(i, 1);
    this._rows = this._rows.filter((r) => r.speaker !== n).map((r) => (r.speaker > n ? { ...r, speaker: r.speaker - 1 } : r));
    if (!this._rows.length) this._rows = [{ speaker: 1, text: "" }];
    this.renderSpeakers();
    this.renderRows();
    this.changed();
  }

  insertRow(at, speaker, focus = true) {
    this._rows.splice(at, 0, { speaker, text: "" });
    this.renderRows();
    if (focus) this.$$("#rows textarea")[at]?.focus();
    this.changed();
  }

  removeRow(i, focusPrev = false) {
    if (i < 0 || this._rows.length <= 1) return;
    this._rows.splice(i, 1);
    this.renderRows();
    const ts = this.$$("#rows textarea");
    const t = ts[focusPrev ? Math.max(0, i - 1) : Math.min(i, ts.length - 1)];
    if (t) {
      t.focus();
      if (focusPrev) t.setSelectionRange(t.value.length, t.value.length);
    }
    this.changed();
  }

  moveRow(i, d) {
    const j = i + d;
    if (i < 0 || j < 0 || j >= this._rows.length) return;
    [this._rows[i], this._rows[j]] = [this._rows[j], this._rows[i]];
    this.renderRows();
    const li = this.$$("#rows li")[j];
    const btn = li?.querySelector(`button[data-act=${d < 0 ? "up" : "down"}]:not(:disabled)`);
    (btn || li?.querySelector("textarea"))?.focus();
    this.changed();
  }

  onRowKey(e) {
    if (e.target.localName !== "textarea" || e.isComposing) return;
    const i = this.indexOf(e.target, "li");
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (i === this._rows.length - 1) this.insertRow(i + 1, this.nextSpeaker(this._rows[i].speaker));
      else this.$$("#rows textarea")[i + 1]?.focus();
    } else if (e.key === "Backspace" && !e.target.value && this._rows.length > 1) {
      e.preventDefault();
      this.removeRow(i, true);
    }
  }

  openPaste() {
    const rows = this._rows.filter((r) => clean(r.text));
    this.$("#paste-text").value = rows.map((r) => `[S${r.speaker}] ${clean(r.text)}`).join("\n");
    this.$("#paste-error").hidden = true;
    this.$("#paste-dlg").showModal();
    this.$("#paste-text").focus();
  }

  applyPaste() {
    const r = parseScript(this.$("#paste-text").value);
    const err = this.$("#paste-error");
    if (r.error) {
      err.textContent = r.error;
      err.hidden = false;
      return;
    }
    this._rows = r.rows;
    this.ensureSpeakers(r.count);
    this.$("#paste-dlg").close();
    this.renderSpeakers();
    this.renderRows();
    this.changed();
  }

  changed() {
    this.sync();
    emit(this, "change", { script: this.script, voices: this.voices });
  }

  /** Form value, validity, and the footer counter. */
  sync() {
    const script = this.script;
    const fd = new FormData();
    fd.append("script", script);
    fd.append("voices", JSON.stringify(this.voices));
    this.internals.setFormValue(fd);
    const anchor = this.$("#rows textarea") || undefined;
    if (this.hasAttribute("required") && !script) {
      this.internals.setValidity({ valueMissing: true }, "Write at least one line.", anchor);
    } else {
      this.internals.setValidity({});
    }
    const count = this.$("#count");
    if (count) {
      const lines = this._rows.filter((r) => clean(r.text)).length;
      const used = new Set(this._rows.filter((r) => clean(r.text)).map((r) => r.speaker)).size;
      count.textContent = lines
        ? `${lines} line${lines === 1 ? "" : "s"} · ${used} speaker${used === 1 ? "" : "s"} · ≈ ${fmtSeconds(estimateSeconds(script))}`
        : "No lines yet";
    }
    if (this.shadowRoot.firstChild) this.markUnused();
  }
}

define("moss-script-editor", MossScriptEditor);
export { MossScriptEditor };
