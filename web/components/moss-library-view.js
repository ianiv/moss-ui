// <moss-library-view>: route #/library, tabs via the hash query: #/library?tab=history (default) | voices.
//
// History tab: search (debounced), workflow filter and "Starred only" -> api.history({workflow, q, starred,
//   limit: 200}). Compact rows (label, badges, waveform player, star, open in editor, download, delete).
//   Rows are keyed by take id and patched in place on refresh (players keep playing); only the first 40 are
//   rendered, "Show more" adds 40 at a time, and each row's <moss-waveform-player> is created only when the
//   row scrolls near the viewport. Refreshes on store "history" events (debounced; deferred while hidden).
// Voices tab: cards for store.voices (name, description, source badge, duration, compact player, inline
//   transcript editor with Save, "Transcribe again", Edit (name/description dialog), Delete (confirm), "Use in
//   Speech"), client-side filter, "New voice" dialog with <moss-voice-recorder>. Cards are keyed by voice id
//   and updated in place on store "voices" events, so unsaved transcript edits survive.
//
// Both tabs: a checkbox on every row/card, "Select all" (shown items) in the toolbar, shift-click for ranges, and a
//   selection bar with "Delete N" (one confirm, then the existing per-item DELETE calls) and "Clear". Esc clears.
//
// View contract: activated() (reads the tab from the hash, refreshes stale data). generate() is not
// applicable here.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, toast, fmtSeconds, fmtWhen } from "../lib/dom.js";
import { viewLayout } from "../lib/styles.js";
import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import "./moss-waveform-player.js";
import "./moss-voice-recorder.js";

const WORKFLOWS = [
  ["tts", "Speech"],
  ["design", "Voice design"],
  ["clone", "Cloning"],
  ["dialogue", "Dialogue"],
  ["sfx", "Sound effects"],
];
const WF_LABEL = Object.fromEntries(WORKFLOWS);
const SOURCE_LABEL = { upload: "Uploaded", record: "Recorded", design: "Designed", output: "From a take" };
const PAGE = 40;

const styles = css`
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: var(--sp-4); }
  .tabs button {
    border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 8px 14px;
    color: var(--text-2); font-size: var(--fs-md);
  }
  .tabs button[aria-selected=true] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .tabs .n { font-size: var(--fs-xs); color: var(--text-3); font-weight: 400; }
  .toolbar { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--sp-3); }
  .toolbar .search { position: relative; flex: 1 1 220px; max-width: 420px; }
  .toolbar .search svg { position: absolute; left: 10px; top: 50%; translate: 0 -50%; color: var(--text-3); pointer-events: none; }
  .toolbar .search input { padding-left: 32px; }
  .toolbar select { width: auto; }
  .count { margin-left: auto; }
  .selall { display: inline-flex; gap: 6px; align-items: center; font-size: var(--fs-sm); color: var(--text-2); cursor: pointer; white-space: nowrap; }
  .selbar {
    display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; margin: calc(-1 * var(--sp-1)) 0 var(--sp-3);
    padding: var(--sp-2) var(--sp-3); border-radius: var(--radius); background: var(--accent-soft, var(--surface-2));
    font-size: var(--fs-sm);
  }
  .selbar .n { font-weight: 600; margin-right: auto; }
  .selbar button.del { background: var(--danger); border-color: var(--danger); color: #fff; }
  .selbar button.del:hover:not(:disabled) { filter: brightness(1.08); background: var(--danger); }
  input.sel { width: 16px; height: 16px; margin: 0; flex: none; cursor: pointer; }
  .lrow { display: flex; gap: var(--sp-2); align-items: center; min-width: 0; }
  li.take.selected, .vcard.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  ul.takes { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-2); }
  li.take {
    display: grid; gap: 6px var(--sp-3); padding: var(--sp-2) var(--sp-3); background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius); grid-template-columns: minmax(0, 1fr);
  }
  @container (min-width: 760px) {
    li.take { grid-template-columns: minmax(0, 2fr) minmax(200px, 3fr) auto; align-items: center; }
  }
  .info { min-width: 0; display: grid; gap: 4px; }
  .label { font-size: var(--fs-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .note { font-size: var(--fs-xs); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slot { min-height: 40px; min-width: 0; }
  .slot .ph { height: 40px; border-radius: var(--radius-sm); background: var(--surface-2); }
  .acts { display: flex; gap: 2px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
  button.star[aria-pressed=true] { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
  .more { display: flex; justify-content: center; margin-top: var(--sp-3); }
  .grid { display: grid; gap: var(--sp-3); grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); align-items: start; }
  .vcard { display: grid; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); }
  .vcard h4 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vcard .desc { font-size: var(--fs-sm); color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .vcard textarea { font-size: var(--fs-sm); min-height: 3.5em; }
  .vcard .noaudio { font-size: var(--fs-sm); }
  .loading { display: flex; gap: 8px; align-items: center; justify-content: center; padding: var(--sp-6); color: var(--text-3); }
  .empty p + p { margin-top: var(--sp-2); }
  .empty .row { justify-content: center; margin-top: var(--sp-3); }
  dialog.rec { max-width: min(640px, calc(100vw - 32px)); }
  dialog h3 { margin-bottom: var(--sp-3); }
  #confirm-ok { background: var(--danger); border-color: var(--danger); color: #fff; }
  #confirm-ok:hover:not(:disabled) { filter: brightness(1.08); background: var(--danger); }
`;

const trimmed = (s) => String(s || "").trim();

/** A set of selected ids with a shift-click anchor. */
class Selection extends Set {
  anchor = null;

  /** Check or uncheck one id; with shift, apply the same state to the range from the last clicked id. */
  toggle(id, on, order, shift) {
    const a = shift && this.anchor != null ? order.indexOf(this.anchor) : -1;
    const b = order.indexOf(id);
    const range = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
    for (const x of range) on ? this.add(x) : this.delete(x);
    this.anchor = id;
  }

  /** Drop ids that no longer exist. */
  keep(ids) {
    const valid = new Set(ids);
    for (const id of this) if (!valid.has(id)) this.delete(id);
    if (this.anchor != null && !valid.has(this.anchor)) this.anchor = null;
  }
}

class MossLibraryView extends MossElement {
  static styles = [viewLayout, styles];

  render() {
    this.setHTML(html`
      <div class="view-head">
        <div>
          <h2>Library</h2>
          <p>Every take you've generated, with its full recipe, and the voices you can clone from.</p>
        </div>
      </div>
      <div class="tabs" role="tablist" aria-label="Library sections">
        <button role="tab" id="tab-history" aria-controls="panel-history" data-tab="history" aria-selected="true">History</button>
        <button role="tab" id="tab-voices" aria-controls="panel-voices" data-tab="voices" aria-selected="false" tabindex="-1">Voices <span class="n" id="voice-n"></span></button>
      </div>

      <section id="panel-history" role="tabpanel" aria-labelledby="tab-history">
        <div class="toolbar">
          <label class="search"><span class="sr-only">Search takes</span>${icon("search")}<input type="search" id="q" placeholder="Search text, instruction, seed, voice…" autocomplete="off"></label>
          <label class="sr-only" for="wf">Workflow</label>
          <select id="wf">
            <option value="">All workflows</option>
            ${WORKFLOWS.map(([k, l]) => html`<option value="${k}">${l}</option>`)}
          </select>
          <button type="button" id="starred" aria-pressed="false">${icon("star", 14)} Starred only</button>
          <button type="button" class="ghost icon" id="reload" aria-label="Refresh history" title="Refresh">${icon("refresh")}</button>
          <label class="selall"><input type="checkbox" class="sel" id="h-all"> Select all</label>
          <span class="count small faint" aria-live="polite"></span>
        </div>
        <div class="selbar" id="h-selbar" hidden>
          <span class="n" aria-live="polite"></span>
          <button type="button" class="small" data-sel="clear">Clear</button>
          <button type="button" class="small del" data-sel="delete">${icon("trash", 14)} <span>Delete</span></button>
        </div>
        <div class="h-error" hidden></div>
        <div class="h-loading loading" hidden><span class="spinner"></span> Loading history…</div>
        <div class="h-empty empty" hidden></div>
        <ul class="takes" aria-label="Takes"></ul>
        <div class="more" hidden><button type="button" id="more">Show more</button></div>
      </section>

      <section id="panel-voices" role="tabpanel" aria-labelledby="tab-voices" hidden>
        <div class="toolbar">
          <button type="button" class="primary" id="new-voice">${icon("plus", 14)} New voice</button>
          <label class="search"><span class="sr-only">Filter voices</span>${icon("search")}<input type="search" id="vq" placeholder="Filter voices…" autocomplete="off"></label>
          <label class="selall"><input type="checkbox" class="sel" id="v-all"> Select all</label>
          <span class="count v-count small faint" aria-live="polite"></span>
        </div>
        <div class="selbar" id="v-selbar" hidden>
          <span class="n" aria-live="polite"></span>
          <button type="button" class="small" data-sel="clear">Clear</button>
          <button type="button" class="small del" data-sel="delete">${icon("trash", 14)} <span>Delete</span></button>
        </div>
        <div class="v-empty empty" hidden></div>
        <div class="grid" aria-label="Voices"></div>
      </section>

      <dialog id="confirm" aria-labelledby="confirm-title">
        <form method="dialog" class="stack">
          <h3 id="confirm-title">Delete?</h3>
          <p class="confirm-text muted small"></p>
          <div class="row end">
            <button value="cancel" autofocus>Cancel</button>
            <button value="ok" class="primary" id="confirm-ok">Delete</button>
          </div>
        </form>
      </dialog>

      <dialog id="edit" aria-labelledby="edit-title">
        <form class="stack" id="edit-form" novalidate>
          <h3 id="edit-title">Edit voice</h3>
          <div class="field"><label for="e-name">Name</label><input id="e-name" required autocomplete="off"></div>
          <div class="field"><label for="e-desc">Description</label><textarea id="e-desc" rows="3"></textarea></div>
          <div class="error e-error" hidden></div>
          <div class="row end">
            <button type="button" id="e-cancel">Cancel</button>
            <button type="submit" class="primary">Save</button>
          </div>
        </form>
      </dialog>

      <dialog id="rec" class="rec" aria-labelledby="rec-title">
        <div class="row between"><h3 id="rec-title">New voice</h3><button type="button" class="ghost icon" id="rec-close" aria-label="Close">${icon("x")}</button></div>
        <moss-voice-recorder></moss-voice-recorder>
      </dialog>
    `);

    this.tab = "history";
    this.takes = [];
    this.rows = new Map(); // take id -> <li>
    this.shown = PAGE;
    this.cards = new Map(); // voice id -> card element
    this.sel = { history: new Selection(), voices: new Selection() };
    this.historyStale = true;
    this.histSeq = 0;
    this.io = new IntersectionObserver((entries) => this.onVisible(entries), { rootMargin: "300px 0px" });

    // tabs
    this.$(".tabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tab]");
      if (b) this.setTab(b.dataset.tab, true);
    });
    this.$(".tabs").addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = this.tab === "history" ? "voices" : "history";
      const t = e.key === "Home" ? "history" : e.key === "End" ? "voices" : next;
      this.setTab(t, true);
      this.$(`#tab-${t}`).focus();
    });

    // history toolbar
    let qTimer;
    this.$("#q").addEventListener("input", () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => this.loadHistory(true), 300);
    });
    this.$("#wf").addEventListener("change", () => this.loadHistory(true));
    this.$("#starred").addEventListener("click", (e) => {
      const b = e.currentTarget;
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      this.loadHistory(true);
    });
    this.$("#reload").addEventListener("click", () => this.loadHistory());
    this.$("#more").addEventListener("click", () => {
      this.shown += PAGE;
      this.renderTakes();
    });
    this.$("ul.takes").addEventListener("click", (e) => this.onTakeAction(e));
    this.$("ul.takes").addEventListener("click", (e) => this.onSelectClick(e, "history"));
    this.$(".grid").addEventListener("click", (e) => this.onSelectClick(e, "voices"));
    this.$("#h-all").addEventListener("change", (e) => this.selectAll("history", e.target.checked));
    this.$("#v-all").addEventListener("change", (e) => this.selectAll("voices", e.target.checked));
    this.$("#h-selbar").addEventListener("click", (e) => this.onSelbar(e, "history"));
    this.$("#v-selbar").addEventListener("click", (e) => this.onSelbar(e, "voices"));
    this.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.sel[this.tab].size) return;
      if (this.shadowRoot.querySelector("dialog[open]")) return;
      e.preventDefault();
      this.sel[this.tab].clear();
      this.syncSelection(this.tab);
    });
    this.$(".h-empty").addEventListener("click", (e) => {
      if (e.target.closest("#clear-filters")) this.clearFilters();
    });
    this.$(".h-error").addEventListener("click", (e) => {
      if (e.target.closest("button")) this.loadHistory();
    });

    // voices
    this.$("#vq").addEventListener("input", () => this.renderVoices());
    this.$("#new-voice").addEventListener("click", () => this.$("#rec").showModal());
    this.$(".v-empty").addEventListener("click", (e) => {
      if (e.target.closest("#empty-new")) this.$("#rec").showModal();
    });
    this.$(".grid").addEventListener("click", (e) => this.onVoiceAction(e));
    this.$(".grid").addEventListener("input", (e) => {
      const ta = e.target.closest("textarea.tr");
      if (ta) this.markDirty(ta.closest(".vcard"));
    });

    // new voice dialog
    const rec = this.$("#rec");
    const recorder = this.$("moss-voice-recorder");
    const closeRec = async () => {
      if (recorder.hasContent && !(await this.confirm("Discard this voice?", "The recording or file you loaded hasn't been saved.", "Discard"))) return;
      rec.close();
    };
    this.$("#rec-close").addEventListener("click", closeRec);
    rec.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeRec();
    });
    rec.addEventListener("close", () => recorder.reset());
    recorder.addEventListener("voice-saved", (e) => {
      rec.close();
      this._highlight = e.detail?.voice?.id;
      store.refreshVoices().catch(() => {});
    });

    // edit dialog
    this.$("#e-cancel").addEventListener("click", () => this.$("#edit").close());
    this.$("#edit-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.saveEdit();
    });
  }

  connected() {
    store.on("history", () => this.onHistoryChange(), this.signal);
    store.on("voices", () => this.renderVoices(), this.signal);
    store.on("settings", () => this.updateDownloadLinks(), this.signal);
    this.on(window, "hashchange", () => {
      if (/^#\/library\b/.test(location.hash)) this.setTab(this.tabFromHash(), false);
    });
    this.renderVoices();
  }

  disconnected() {
    clearTimeout(this._histTimer);
  }

  // ----- view contract -----

  activated() {
    this.setTab(this.tabFromHash(), false);
    if (this.historyStale) this.loadHistory();
    this.renderVoices();
  }

  get isActive() {
    return this.hasAttribute("active");
  }

  tabFromHash() {
    const q = location.hash.split("?")[1] || "";
    return new URLSearchParams(q).get("tab") === "voices" ? "voices" : "history";
  }

  setTab(tab, updateHash) {
    this.tab = tab;
    for (const b of this.$$(".tabs button")) {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.$("#panel-history").hidden = tab !== "history";
    this.$("#panel-voices").hidden = tab !== "voices";
    // replaceState doesn't fire hashchange, so the app shell doesn't re-route.
    if (updateHash) history.replaceState(null, "", `#/library?tab=${tab}`);
    if (tab === "history" && this.historyStale) this.loadHistory();
  }

  // ----- history -----

  get filters() {
    return {
      workflow: this.$("#wf").value || undefined,
      q: this.$("#q").value.trim() || undefined,
      starred: this.$("#starred").getAttribute("aria-pressed") === "true" || undefined,
    };
  }

  onHistoryChange() {
    this.historyStale = true;
    if (!this.isActive || this.tab !== "history") return;
    clearTimeout(this._histTimer);
    this._histTimer = setTimeout(() => this.loadHistory(), 400);
  }

  async loadHistory(resetPaging = false) {
    const seq = ++this.histSeq;
    this.historyStale = false;
    if (resetPaging) this.shown = PAGE;
    const first = !this._histLoaded;
    this.$(".h-loading").hidden = !first;
    this.$("#reload").disabled = true;
    try {
      const items = await api.history({ ...this.filters, limit: 200 });
      if (seq !== this.histSeq) return;
      this._histLoaded = true;
      this.takes = items || [];
      this.$(".h-error").hidden = true;
      this.renderTakes();
    } catch (e) {
      if (seq !== this.histSeq) return;
      this.historyStale = true;
      const err = this.$(".h-error");
      err.hidden = false;
      err.innerHTML = String(html`<div class="error row between"><span>Couldn't load history: ${e.message}</span><button type="button" class="small">Retry</button></div>`);
    } finally {
      if (seq === this.histSeq) {
        this.$(".h-loading").hidden = true;
        this.$("#reload").disabled = false;
      }
    }
  }

  clearFilters() {
    this.$("#q").value = "";
    this.$("#wf").value = "";
    this.$("#starred").setAttribute("aria-pressed", "false");
    this.loadHistory(true);
  }

  renderTakes() {
    const ul = this.$("ul.takes");
    const visible = this.takes.slice(0, this.shown);
    const ids = new Set(visible.map((t) => t.id));
    for (const [id, li] of this.rows) {
      if (!ids.has(id)) {
        this.io.unobserve(li);
        li.querySelector("moss-waveform-player")?.pause?.();
        li.remove();
        this.rows.delete(id);
      }
    }
    // Insert / reorder keyed rows without rebuilding existing ones.
    let prev = null;
    for (const take of visible) {
      let li = this.rows.get(take.id);
      if (!li) {
        li = this.takeRow(take);
        this.rows.set(take.id, li);
        this.io.observe(li);
      } else {
        this.updateTakeRow(li, take);
      }
      const want = prev ? prev.nextSibling : ul.firstChild;
      if (want !== li) ul.insertBefore(li, want);
      prev = li;
    }

    this.sel.history.keep(this.takes.map((t) => t.id));
    this.syncSelection("history");

    const n = this.takes.length;
    const f = this.filters;
    const filtered = !!(f.workflow || f.q || f.starred);
    this.$(".count").textContent = n ? `${n >= 200 ? "200+" : n} take${n === 1 ? "" : "s"}${n > visible.length ? ` · showing ${visible.length}` : ""}` : "";
    this.$(".more").hidden = n <= visible.length;
    this.$("#more").textContent = `Show more (${Math.min(PAGE, n - visible.length)} of ${n - visible.length} more)`;
    const empty = this.$(".h-empty");
    empty.hidden = n > 0;
    if (!n) {
      empty.innerHTML = filtered
        ? String(html`<p>No takes match these filters.</p><div class="row"><button type="button" id="clear-filters">Clear filters</button></div>`)
        : String(html`<p>Nothing generated yet.</p><p class="small">Takes from every workflow land here with their full recipe, so you can star, download or reopen them later.</p>
            <div class="row"><a class="btn" href="#/tts">Speech</a><a class="btn" href="#/design">Voice design</a><a class="btn" href="#/sfx">Sound effects</a></div>`);
    }
  }

  takeRow(take) {
    const li = document.createElement("li");
    li.className = "take";
    li.dataset.id = take.id;
    li.innerHTML = String(html`
      <div class="info">
        <div class="lrow"><input type="checkbox" class="sel" aria-label="Select take"><div class="label"></div></div>
        <div class="meta"></div>
        <div class="note" hidden></div>
      </div>
      <div class="slot"><div class="ph" aria-hidden="true"></div></div>
      <div class="acts">
        <button type="button" class="ghost icon star" data-act="star" aria-pressed="false" aria-label="Star"></button>
        <button type="button" class="ghost small" data-act="open" title="Load this recipe into its workflow view">${icon("open", 14)} Open in editor</button>
        <a class="btn ghost small dl" download>${icon("download", 14)} <span></span></a>
        <button type="button" class="ghost icon danger" data-act="delete" aria-label="Delete take" title="Delete">${icon("trash")}</button>
      </div>
    `);
    this.updateTakeRow(li, take);
    return li;
  }

  updateTakeRow(li, take) {
    li._take = take;
    const label = take.label || take.params?.prompt || take.params?.text || take.id;
    const lab = li.querySelector(".label");
    lab.textContent = label;
    lab.title = label;
    li.querySelector("input.sel").setAttribute("aria-label", `Select "${label}"`);
    const rtf = Number.isFinite(+take.rtf) ? `RTF ${(+take.rtf).toFixed(2)}` : "";
    li.querySelector(".meta").innerHTML = String(html`
      <span class="badge accent">${WF_LABEL[take.workflow] || take.workflow}</span>
      ${take.model ? html`<span class="badge">${take.model}</span>` : ""}
      ${take.variations > 1 ? html`<span class="badge">v${(take.variation ?? 0) + 1}</span>` : ""}
      ${take.seed != null ? html`<span class="badge mono">seed ${take.seed}</span>` : ""}
      <span class="badge">${fmtSeconds(take.duration_s)}</span>
      ${rtf ? html`<span class="badge">${rtf}</span>` : ""}
      ${take.voices?.length ? html`<span class="badge" title="Voices">${take.voices.join(", ")}</span>` : ""}
      <span class="xs faint">${fmtWhen(take.created)}</span>
    `);
    const note = li.querySelector(".note");
    note.hidden = !take.note;
    note.textContent = take.note || "";
    const star = li.querySelector(".star");
    star.setAttribute("aria-pressed", String(!!take.starred));
    star.setAttribute("aria-label", take.starred ? "Unstar" : "Star");
    star.title = take.starred ? "Unstar" : "Star";
    star.innerHTML = String(icon(take.starred ? "starFill" : "star"));
    li.querySelector("[data-act=open]").disabled = !take.request && !take.params;
    this.setDownload(li, take);
    const player = li.querySelector("moss-waveform-player");
    if (player && player.getAttribute("src") !== take.url) player.setAttribute("src", take.url);
  }

  setDownload(li, take) {
    const fmt = store.settings?.download_format === "mp3" ? "mp3" : "wav";
    const a = li.querySelector("a.dl");
    a.href = api.downloadUrl(take, fmt);
    a.querySelector("span").textContent = fmt.toUpperCase();
    a.title = `Download ${fmt.toUpperCase()}`;
  }

  updateDownloadLinks() {
    for (const li of this.rows.values()) this.setDownload(li, li._take);
  }

  /** Create waveform players only for rows near the viewport (decoding 200 clips up front is slow). */
  onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const li = e.target;
      this.io.unobserve(li);
      const take = li._take;
      if (li.classList.contains("vcard")) {
        this.mountVoicePlayer(li);
        continue;
      }
      const p = document.createElement("moss-waveform-player");
      p.setAttribute("compact", "");
      p.setAttribute("label", take.label || take.id);
      p.setAttribute("src", take.url);
      li.querySelector(".slot").replaceChildren(p);
    }
  }

  async onTakeAction(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const li = b.closest("li.take");
    const take = li?._take;
    if (!take) return;
    const act = b.dataset.act;
    if (act === "star") {
      const starred = !take.starred;
      this.updateTakeRow(li, { ...take, starred }); // optimistic
      try {
        const rec = await api.patchTake(take.id, { starred });
        const i = this.takes.findIndex((t) => t.id === take.id);
        if (i >= 0) this.takes[i] = { ...this.takes[i], ...rec };
        this.updateTakeRow(li, i >= 0 ? this.takes[i] : rec);
      } catch (err) {
        this.updateTakeRow(li, take);
        toast(`Couldn't update the star: ${err.message}`, "error");
      }
    } else if (act === "open") {
      const req = take.request || { workflow: take.workflow, model: take.model, params: take.params, variations: 1, seed: take.seed };
      store.openRecipe(take.workflow, req);
    } else if (act === "delete") {
      const ok = await this.confirm("Delete this take?", `"${take.label || take.id}" (WAV, MP3 and recipe) will be removed from disk. This can't be undone.`);
      if (!ok) return;
      try {
        await api.deleteTake(take.id);
        this.sel.history.delete(take.id);
        this.takes = this.takes.filter((t) => t.id !== take.id);
        this.renderTakes();
        toast("Take deleted", "ok");
      } catch (err) {
        toast(`Couldn't delete: ${err.message}`, "error");
      }
    }
  }

  // ----- voices -----

  renderVoices() {
    if (!this._rendered) return;
    const all = [...(store.voices || [])].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: "base" }));
    this.$("#voice-n").textContent = all.length ? `(${all.length})` : "";
    const q = this.$("#vq").value.trim().toLowerCase();
    const list = q
      ? all.filter((v) => [v.name, v.id, v.description, v.transcript].some((s) => String(s || "").toLowerCase().includes(q)))
      : all;
    const grid = this.$(".grid");
    const ids = new Set(list.map((v) => v.id));
    for (const [id, card] of this.cards) {
      if (!ids.has(id)) {
        this.io.unobserve(card);
        card.querySelector("moss-waveform-player")?.pause?.();
        card.remove();
        this.cards.delete(id);
      }
    }
    let prev = null;
    for (const v of list) {
      let card = this.cards.get(v.id);
      if (!card) {
        card = this.voiceCard(v);
        this.cards.set(v.id, card);
        this.io.observe(card);
      } else {
        this.updateVoiceCard(card, v);
      }
      const want = prev ? prev.nextSibling : grid.firstChild;
      if (want !== card) grid.insertBefore(card, want);
      prev = card;
    }
    this.sel.voices.keep(all.map((v) => v.id));
    this._voiceOrder = list.map((v) => v.id);
    this.syncSelection("voices");
    this.$(".v-count").textContent = all.length ? (q ? `${list.length} of ${all.length} voices` : `${all.length} voice${all.length === 1 ? "" : "s"}`) : "";

    const empty = this.$(".v-empty");
    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.innerHTML = all.length
        ? String(html`<p>No voices match "${q}".</p>`)
        : String(html`<p>No voices yet.</p>
            <p class="small">A voice is a short reference recording (5–15 s) plus its transcript. Record one, upload a clip, or design one in
              <a href="#/design">Voice design</a> and use "Save as voice" on the take you like. Voices are then available for cloning, Speech and Dialogue.</p>
            <div class="row"><button type="button" class="primary" id="empty-new">${icon("mic", 14)} Record or upload a voice</button></div>`);
    }

    if (this._highlight && this.cards.has(this._highlight)) {
      const card = this.cards.get(this._highlight);
      this._highlight = null;
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      card.querySelector("textarea.tr")?.focus({ preventScroll: true });
    }
  }

  voiceCard(v) {
    const card = document.createElement("article");
    card.className = "card vcard";
    card.dataset.id = v.id;
    const tid = `tr-${v.id}`;
    card.innerHTML = String(html`
      <div class="row between">
        <input type="checkbox" class="sel" aria-label="Select voice">
        <h4 class="grow name"></h4>
        <span class="row badges"></span>
      </div>
      <p class="desc"></p>
      <div class="slot"><div class="ph" aria-hidden="true"></div></div>
      <div class="field">
        <div class="row between">
          <label for="${tid}">Transcript</label>
          <span class="row">
            <button type="button" class="ghost small" data-act="transcribe">${icon("wave", 14)} Transcribe again</button>
            <button type="button" class="small" data-act="save-tr" disabled>${icon("save", 14)} Save</button>
          </span>
        </div>
        <textarea class="tr" id="${tid}" rows="2" placeholder="No transcript. Needed for Continue mode, nano and dialogue."></textarea>
      </div>
      <div class="row between">
        <button type="button" class="small" data-act="use">${icon("play", 14)} Use in Speech</button>
        <span class="row">
          <button type="button" class="ghost small" data-act="edit">${icon("edit", 14)} Edit</button>
          <button type="button" class="ghost icon danger" data-act="delete" aria-label="Delete voice" title="Delete">${icon("trash")}</button>
        </span>
      </div>
    `);
    this.updateVoiceCard(card, v);
    return card;
  }

  updateVoiceCard(card, v) {
    card._voice = v;
    const name = v.name || v.id;
    card.querySelector(".name").textContent = name;
    card.querySelector(".name").title = v.id !== name ? `${name} (${v.id})` : name;
    card.setAttribute("aria-label", `Voice ${name}`);
    card.querySelector("input.sel").setAttribute("aria-label", `Select voice "${name}"`);
    card.querySelector(".badges").innerHTML = String(html`
      <span class="badge accent">${SOURCE_LABEL[v.source] || v.source || "voice"}</span>
      ${v.duration_s ? html`<span class="badge">${fmtSeconds(v.duration_s)}</span>` : ""}
      ${!v.transcript ? html`<span class="badge warn">no transcript</span>` : ""}
    `);
    const desc = card.querySelector(".desc");
    desc.textContent = v.description || "";
    desc.title = v.description || "";
    desc.hidden = !v.description;
    const ta = card.querySelector("textarea.tr");
    if (!card._dirty) ta.value = v.transcript || "";
    card.querySelector("[data-act=transcribe]").disabled = !v.has_audio || !!card._transcribing;
    card.querySelector("[data-act=use]").disabled = !v.has_audio;
    const slot = card.querySelector(".slot");
    if (!v.has_audio || !v.audio_url) {
      slot.innerHTML = `<p class="notice noaudio">No reference audio yet.</p>`;
    } else {
      const p = slot.querySelector("moss-waveform-player");
      if (p) {
        if (p.getAttribute("src") !== v.audio_url) p.setAttribute("src", v.audio_url);
      } else if (card._mounted) {
        this.mountVoicePlayer(card);
      } else if (!slot.querySelector(".ph")) {
        slot.innerHTML = `<div class="ph" aria-hidden="true"></div>`;
        this.io.observe(card);
      }
    }
  }

  mountVoicePlayer(card) {
    card._mounted = true;
    const v = card._voice;
    if (!v?.has_audio || !v.audio_url) return;
    const p = document.createElement("moss-waveform-player");
    p.setAttribute("compact", "");
    p.setAttribute("label", `Reference audio for ${v.name || v.id}`);
    p.setAttribute("src", v.audio_url);
    card.querySelector(".slot").replaceChildren(p);
  }

  markDirty(card, dirty = true) {
    if (!card) return;
    const ta = card.querySelector("textarea.tr");
    card._dirty = dirty && ta.value.trim() !== (card._voice?.transcript || "").trim();
    card.querySelector("[data-act=save-tr]").disabled = !card._dirty;
  }

  async onVoiceAction(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const card = b.closest(".vcard");
    const v = card?._voice;
    if (!v) return;
    const act = b.dataset.act;
    if (act === "save-tr") {
      const text = card.querySelector("textarea.tr").value.trim();
      b.disabled = true;
      try {
        const updated = await api.updateVoice(v.id, { transcript: text });
        card._dirty = false;
        this.updateVoiceCard(card, updated);
        toast(`Transcript saved for "${v.name || v.id}"`, "ok");
      } catch (err) {
        b.disabled = false;
        toast(`Couldn't save the transcript: ${err.message}`, "error");
      }
    } else if (act === "transcribe") {
      const label = b.innerHTML;
      card._transcribing = true;
      b.disabled = true;
      b.innerHTML = `<span class="spinner"></span> Transcribing…`;
      try {
        const res = await api.transcribe({ voice: v.id });
        const text = (res?.text || "").trim();
        if (!text) toast("Whisper heard no speech in this voice", "info");
        else {
          const ta = card.querySelector("textarea.tr");
          ta.value = text;
          this.markDirty(card);
          if (card._dirty) toast("New transcript filled in: check it, then Save", "info");
          else toast("Transcript unchanged", "info");
          ta.focus();
        }
      } catch (err) {
        toast(`Transcription failed: ${err.message}`, "error");
      } finally {
        card._transcribing = false;
        b.innerHTML = label;
        b.disabled = !card._voice?.has_audio;
      }
    } else if (act === "use") {
      store.openRecipe("tts", { params: { voice: v.id }, model: "tts" });
    } else if (act === "edit") {
      this._editing = v.id;
      this.$("#e-name").value = v.name || "";
      this.$("#e-desc").value = v.description || "";
      this.$(".e-error").hidden = true;
      this.$("#edit").showModal();
      this.$("#e-name").focus();
    } else if (act === "delete") {
      const ok = await this.confirm(`Delete voice "${v.name || v.id}"?`, "Its reference audio and transcript will be removed from disk. Takes made with it are kept. This can't be undone.");
      if (!ok) return;
      try {
        await api.deleteVoice(v.id);
        this.sel.voices.delete(v.id);
        toast(`Deleted voice "${v.name || v.id}"`, "ok");
        store.refreshVoices().catch(() => {});
      } catch (err) {
        toast(`Couldn't delete: ${err.message}`, "error");
      }
    }
  }

  async saveEdit() {
    const id = this._editing;
    const name = trimmed(this.$("#e-name").value);
    const err = this.$(".e-error");
    if (!name) {
      err.textContent = "Name can't be empty.";
      err.hidden = false;
      this.$("#e-name").focus();
      return;
    }
    try {
      const updated = await api.updateVoice(id, { name, description: trimmed(this.$("#e-desc").value) });
      const card = this.cards.get(id);
      if (card) this.updateVoiceCard(card, updated);
      this.$("#edit").close();
      toast("Voice updated", "ok");
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  // ----- multi-select -----

  /** Ids of the items currently shown in a tab, in display order (what "Select all" and ranges cover). */
  shownIds(tab) {
    return tab === "history" ? this.takes.slice(0, this.shown).map((t) => t.id) : this._voiceOrder || [];
  }

  itemEl(tab, id) {
    return (tab === "history" ? this.rows : this.cards).get(id);
  }

  onSelectClick(e, tab) {
    const box = e.target.closest("input.sel");
    if (!box) return;
    const el = box.closest(tab === "history" ? "li.take" : ".vcard");
    if (!el) return;
    this.sel[tab].toggle(el.dataset.id, box.checked, this.shownIds(tab), e.shiftKey);
    this.syncSelection(tab);
  }

  selectAll(tab, on) {
    const sel = this.sel[tab];
    if (on) for (const id of this.shownIds(tab)) sel.add(id);
    else sel.clear();
    this.syncSelection(tab);
  }

  syncSelection(tab) {
    if (!this._rendered) return;
    const sel = this.sel[tab];
    for (const [id, el] of tab === "history" ? this.rows : this.cards) {
      const on = sel.has(id);
      el.classList.toggle("selected", on);
      el.querySelector("input.sel").checked = on;
    }
    const shown = this.shownIds(tab);
    const picked = shown.filter((id) => sel.has(id)).length;
    const all = this.$(tab === "history" ? "#h-all" : "#v-all");
    all.checked = shown.length > 0 && picked === shown.length;
    all.indeterminate = picked > 0 && picked < shown.length;
    all.disabled = !shown.length;
    const bar = this.$(tab === "history" ? "#h-selbar" : "#v-selbar");
    bar.hidden = !sel.size;
    const noun = tab === "history" ? "take" : "voice";
    bar.querySelector(".n").textContent = `${sel.size} ${noun}${sel.size === 1 ? "" : "s"} selected`;
    bar.querySelector(".del span").textContent = `Delete ${sel.size}`;
  }

  async onSelbar(e, tab) {
    const b = e.target.closest("button[data-sel]");
    if (!b) return;
    if (b.dataset.sel === "clear") {
      this.sel[tab].clear();
      this.syncSelection(tab);
      return;
    }
    const ids = [...this.sel[tab]];
    if (!ids.length) return;
    const n = ids.length;
    const ok = tab === "history"
      ? await this.confirm(`Delete ${n} take${n === 1 ? "" : "s"}?`, `Their WAV, MP3 and recipe files will be removed from disk. This can't be undone.`, `Delete ${n}`)
      : await this.confirm(`Delete ${n} voice${n === 1 ? "" : "s"}?`, "Their reference audio and transcripts will be removed from disk. Takes made with them are kept. This can't be undone.", `Delete ${n}`);
    if (!ok) return;
    b.disabled = true;
    const failed = [];
    for (const id of ids) {
      try {
        await (tab === "history" ? api.deleteTake(id) : api.deleteVoice(id));
        this.sel[tab].delete(id);
        if (tab === "history") {
          this.takes = this.takes.filter((t) => t.id !== id);
        } else {
          this.itemEl(tab, id)?.remove();
        }
      } catch (err) {
        failed.push(err.message);
      }
    }
    b.disabled = false;
    if (tab === "history") this.renderTakes();
    else store.refreshVoices().catch(() => {});
    this.syncSelection(tab);
    const done = n - failed.length;
    if (done) toast(`Deleted ${done} ${tab === "history" ? "take" : "voice"}${done === 1 ? "" : "s"}`, "ok");
    if (failed.length) toast(`Couldn't delete ${failed.length}: ${failed[0]}`, "error");
  }

  // ----- confirm dialog -----

  /** Promise<boolean> from the shared confirm <dialog>. */
  confirm(title, text, okLabel = "Delete") {
    const d = this.$("#confirm");
    if (d.open) d.close("cancel");
    this.$("#confirm-title").textContent = title;
    this.$(".confirm-text").textContent = text || "";
    this.$("#confirm-ok").textContent = okLabel;
    d.returnValue = "";
    return new Promise((resolve) => {
      d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true });
      d.showModal();
    });
  }
}

define("moss-library-view", MossLibraryView);
