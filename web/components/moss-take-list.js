// <moss-take-list>: results area for a workflow view. Progress blocks for tracked jobs, then take cards
// grouped by job (variations side by side), with star, A/B compare, "Same seed", "Save as voice",
// downloads and the recipe JSON.
//
// Attributes: save-as-voice (show "Save as voice" on takes), empty-text (empty-state text).
// Methods:
//   trackJob(jobId)  show live progress for a job (queued / loading / warming / generating, elapsed,
//                    ~estimate, audio seconds so far, Cancel) and add its takes as they finish.
//                    Duplicate ids are ignored. Error -> message in the block (dismissable); cancel -> removed.
//   setTakes(takes)  replace all takes (newest first).
//   addTakes(takes)  prepend takes (newest first); a take whose id is already listed is updated in place.
//   clear()          remove all takes (tracked-job progress blocks stay).
//   get takes        copy of the current takes, newest first.
// Events (composed): regenerate {take} ("Same seed"), voice-saved {voice}.
// Within a job group, takes are ordered by item then variation so v1, v2, … sit side by side.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, fmtSeconds, fmtClock, fmtWhen, emit, toast } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import "./moss-waveform-player.js";

const styles = css`
  :host { display: block; container-type: inline-size; }
  .root { display: grid; gap: var(--sp-3); }

  /* A/B bar */
  .ab {
    position: sticky; top: var(--sp-2); z-index: 2; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
    padding: var(--sp-2) var(--sp-3); border-radius: var(--radius-lg); border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px); box-shadow: var(--shadow);
  }
  .ab .title { font-weight: 600; font-size: var(--fs-sm); color: var(--accent); }
  .ab button.slot { max-width: 220px; justify-content: flex-start; }
  .ab button.slot .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .ab .tag { font-family: var(--mono); font-weight: 700; }

  /* job progress */
  .job { border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius); padding: var(--sp-2) var(--sp-3); background: var(--surface); display: grid; gap: 6px; }
  .job[data-status=error] { border-left-color: var(--danger); }
  .job[data-status=queued] { border-left-color: var(--border-strong); }
  .job .top { display: flex; align-items: center; gap: var(--sp-2); }
  .job .what { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .job .meta { display: flex; gap: var(--sp-3); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
  .job .meta .status { color: var(--text-2); font-weight: 500; }
  .job progress { width: 100%; height: 4px; accent-color: var(--accent); }
  .job .error { display: flex; gap: var(--sp-2); align-items: start; }
  .job .error span { flex: 1; }

  /* groups + cards */
  .group { display: grid; gap: var(--sp-2); }
  .ghead { display: flex; align-items: baseline; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-3); padding: 0 2px; min-width: 0; }
  .ghead .gl { color: var(--text-2); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
  .ghead > :not(.gl, .line) { white-space: nowrap; flex: none; }
  .ghead .line { flex: 1 1 24px; height: 1px; background: var(--border); align-self: center; }
  .grid { display: grid; gap: var(--sp-2); grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }

  .take {
    position: relative; display: grid; gap: 6px; padding: var(--sp-2) var(--sp-3) var(--sp-2); min-width: 0;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
    transition: border-color var(--dur), box-shadow var(--dur);
  }
  .take:hover { border-color: var(--border-strong); }
  .take[data-playing] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .take[data-starred] { background: color-mix(in srgb, var(--warn-soft) 35%, var(--surface)); }
  .take[data-ab] { border-color: var(--accent); }
  .take .head { display: flex; align-items: center; gap: var(--sp-1); min-width: 0; }
  .take .label { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .abtag { flex: none; font-family: var(--mono); font-size: var(--fs-xs); font-weight: 700; color: var(--accent-text); background: var(--accent); border-radius: var(--radius-sm); padding: 1px 6px; }
  .badges { display: flex; gap: 4px; flex-wrap: wrap; }
  .badges .badge { font-variant-numeric: tabular-nums; }
  .take moss-waveform-player { --wave-height: 44px; }
  .acts { display: flex; gap: 2px; align-items: center; flex-wrap: wrap; margin: 0 -4px; }
  .acts .sp { flex: 1 1 auto; }
  .acts button, .acts .btn { padding: 4px 7px; font-size: var(--fs-xs); }
  button.star { color: var(--text-3); }
  button.star[aria-pressed=true] { color: var(--warn); background: transparent; border-color: transparent; }
  button.star:hover:not(:disabled) { color: var(--warn); }

  .empty { padding: var(--sp-5) var(--sp-4); font-size: var(--fs-sm); }

  /* recipe popover + dialog */
  #recipe { inset: auto; margin: 0; width: min(460px, calc(100vw - 24px)); max-height: min(70vh, 520px); overflow: auto; padding: var(--sp-3); }
  #recipe pre { margin: var(--sp-2) 0 0; font-family: var(--mono); font-size: var(--fs-xs); white-space: pre-wrap; word-break: break-word; background: var(--surface-2); border-radius: var(--radius-sm); padding: var(--sp-2); }
  dialog form { display: grid; gap: var(--sp-3); }
  dialog .idline { font-size: var(--fs-xs); color: var(--text-3); }
`;

const TERMINAL = ["done", "error", "cancelled"];

/** "Warm Narrator #2" -> "warm-narrator-2" (server rule: ^[a-z0-9][a-z0-9_-]{0,63}$). */
function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "");
}

class MossTakeList extends MossElement {
  static styles = [styles];
  static observedAttributes = ["empty-text", "save-as-voice"];

  constructor() {
    super();
    this._takes = []; // newest first
    this._cards = new Map(); // take id -> <article>
    this._jobs = new Map(); // job id -> {el, seen: Set<take id>, dismissed}
    this._ab = []; // [takeIdA, takeIdB]
    this._abActive = null; // take id currently "on" in A/B mode
    this._timer = 0;
  }

  attributeChangedCallback(name, oldV, newV) {
    if (!this._rendered || oldV === newV) return;
    if (name === "save-as-voice") this._rebuildCards();
    else this._updateEmpty();
  }

  // ---- public API -------------------------------------------------------------------------------

  get takes() {
    return [...this._takes];
  }

  setTakes(takes) {
    this._takes = this._dedupe(takes || []);
    this._pruneAB();
    this._renderTakes();
  }

  addTakes(takes) {
    if (!takes?.length) return;
    const incoming = this._dedupe(takes);
    const byId = new Map(incoming.map((t) => [t.id, t]));
    const kept = [];
    for (const t of this._takes) {
      if (byId.has(t.id)) {
        // already listed: update in place (keep its position)
        kept.push({ ...t, ...byId.get(t.id) });
        this._cards.get(t.id)?.remove();
        this._cards.delete(t.id);
        byId.delete(t.id);
      } else kept.push(t);
    }
    this._takes = [...incoming.filter((t) => byId.has(t.id)), ...kept];
    this._renderTakes();
  }

  clear() {
    this._takes = [];
    this._pruneAB();
    this._renderTakes();
  }

  trackJob(jobId) {
    if (!jobId || this._jobs.has(jobId)) return;
    const entry = { el: null, seen: new Set(), dismissed: false };
    this._jobs.set(jobId, entry);
    const job = store.job(jobId);
    if (job) this._onJob(job);
    else {
      // not in the store yet (e.g. from a deep link): fetch it once; SSE "job" events take over after.
      this._renderJobBlock(jobId, null);
      api.job(jobId).then((j) => this._onJob(j)).catch(() => {});
    }
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  render() {
    this.setHTML(html`
      <div class="root">
        <div class="ab" hidden role="region" aria-label="A/B comparison">
          <span class="title">A/B</span>
          <button type="button" class="slot small" data-slot="0" title="Play A (keeps the playhead position)"><span class="tag">A</span><span class="name"></span></button>
          <button type="button" class="slot small" data-slot="1" title="Play B (keeps the playhead position)"><span class="tag">B</span><span class="name"></span></button>
          <span class="grow"></span>
          <button type="button" class="small ghost" data-act="ab-exit">${icon("x", 14)} Exit A/B</button>
        </div>
        <div class="jobs stack tight"></div>
        <div class="takes stack loose"></div>
        <div class="empty" hidden></div>
      </div>
      <div id="recipe" popover>
        <div class="row between">
          <strong class="small">Recipe</strong>
          <span class="row">
            <button type="button" class="small" data-act="recipe-copy">Copy</button>
            <button type="button" class="small ghost icon" data-act="recipe-close" aria-label="Close recipe">${icon("x", 14)}</button>
          </span>
        </div>
        <pre></pre>
      </div>
      <dialog id="save" aria-labelledby="save-title">
        <form method="dialog">
          <h3 id="save-title">Save as voice</h3>
          <p class="small muted">The take becomes a reference voice in your library; cloning then reuses this identity.</p>
          <div class="field">
            <label for="sv-name">Name</label>
            <input id="sv-name" name="name" required autocomplete="off" maxlength="80">
            <span class="idline"></span>
          </div>
          <div class="field">
            <label for="sv-desc">Description</label>
            <input id="sv-desc" name="description" autocomplete="off">
          </div>
          <div class="field">
            <label for="sv-tr">Transcript</label>
            <textarea id="sv-tr" name="transcript" rows="3"></textarea>
            <span class="hint">What is said in the take. Needed for continuation and dialogue references.</span>
          </div>
          <div class="error" hidden></div>
          <div class="row end">
            <button type="button" value="cancel" data-act="save-cancel">Cancel</button>
            <button type="submit" class="primary" value="save">${icon("save", 14)} Save voice</button>
          </div>
        </form>
      </dialog>
    `);

    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    // highlight the card that is playing; remember the active A/B side
    this.shadowRoot.addEventListener("play", (e) => this._onPlayState(e, true), true);
    this.shadowRoot.addEventListener("pause", (e) => this._onPlayState(e, false), true);

    const dlg = this.$("#save");
    dlg.querySelector("form").addEventListener("submit", (e) => this._onSaveVoice(e));
    this.$("#sv-name").addEventListener("input", () => this._updateSlug());

    this._renderTakes();
  }

  connected() {
    store.on("job", ({ job }) => {
      if (this._jobs.has(job.id)) this._onJob(job);
    }, this.signal);
    this._dlFormat = store.settings?.download_format;
    store.on("settings", ({ settings }) => {
      // download links are ordered by the preferred format
      if (settings?.download_format === this._dlFormat) return;
      this._dlFormat = settings?.download_format;
      this._rebuildCards();
    }, this.signal);
    // resync jobs we were tracking while disconnected
    for (const id of this._jobs.keys()) {
      const j = store.job(id);
      if (j) this._onJob(j);
    }
    this._ensureTimer();
  }

  disconnected() {
    clearInterval(this._timer);
    this._timer = 0;
  }

  // ---- jobs -------------------------------------------------------------------------------------

  _onJob(job) {
    const entry = this._jobs.get(job.id);
    if (!entry) return;
    entry.job = job;
    const fresh = (job.outputs || []).filter((t) => t?.id && !entry.seen.has(t.id));
    for (const t of fresh) entry.seen.add(t.id);
    if (fresh.length) this.addTakes([...fresh].reverse());

    if (job.status === "done" || job.status === "cancelled") {
      this._removeJob(job.id);
      return;
    }
    if (job.status === "error" && entry.dismissed) return;
    this._renderJobBlock(job.id, job);
    this._ensureTimer();
  }

  _removeJob(id) {
    // the id stays in the map so later trackJob(id) calls remain no-ops; it just stops rendering
    const entry = this._jobs.get(id);
    if (!entry) return;
    entry.el?.remove();
    entry.el = null;
    entry.finished = true;
    this._updateEmpty();
  }

  _renderJobBlock(id, job) {
    const entry = this._jobs.get(id);
    if (!entry || entry.finished) return;
    if (!entry.el) {
      entry.el = document.createElement("div");
      entry.el.className = "job";
      entry.el.dataset.id = id;
      this.$(".jobs").prepend(entry.el);
    }
    const el = entry.el;
    if (!job) {
      el.innerHTML = String(html`<div class="top"><span class="spinner"></span><span class="what">Starting…</span></div>`);
      this._updateEmpty();
      return;
    }
    el.dataset.status = job.status;
    const now = Date.now() / 1000;
    const total = Math.max(1, (job.items || 1) * (job.variations || 1));
    const doneN = job.outputs?.length || 0;
    const live = ["loading", "warming", "running"].includes(job.status);
    const since = job.started || job.created || now;
    const elapsed = Math.max(0, (job.finished || now) - since);
    const model = store.model(job.model);
    let status;
    switch (job.status) {
      case "queued": status = job.position > 1 ? `#${job.position} in queue` : "Next in queue"; break;
      case "loading": status = `Loading ${model?.label || job.model}`; break;
      case "warming": status = "Warming up"; break;
      case "running": status = `Generating take ${Math.min(total, doneN + 1)}/${total}`; break;
      case "error": status = "Failed"; break;
      default: status = job.status;
    }
    const audioS = job.progress?.seconds;
    let bar = "";
    if (job.status !== "error") {
      bar = live && job.estimate_s
        ? html`<progress max="1" value="${Math.min(0.97, elapsed / job.estimate_s).toFixed(3)}" aria-label="Progress"></progress>`
        : html`<progress aria-label="Progress"></progress>`;
    }
    el.innerHTML = String(html`
      <div class="top">
        ${job.status === "error" ? icon("x", 14) : html`<span class="spinner" style="color: var(--accent)"></span>`}
        <span class="what" title="${job.label || ""}">${job.label || job.workflow}</span>
        ${job.status !== "error" ? html`<button type="button" class="small danger" data-act="cancel">${icon("x", 12)} Cancel</button>` : ""}
      </div>
      <div class="meta">
        <span class="status">${status}</span>
        ${job.status !== "queued" && job.status !== "error" ? html`<span>${fmtClock(elapsed)}${job.estimate_s ? html` / ~${fmtClock(job.estimate_s)}` : ""}</span>` : ""}
        ${audioS ? html`<span>${fmtSeconds(audioS)} of audio</span>` : ""}
        ${total > 1 ? html`<span>${doneN}/${total} takes</span>` : ""}
        <span>${job.model}${job.seed != null ? ` · seed ${job.seed}` : ""}</span>
      </div>
      ${bar}
      ${job.status === "error"
        ? html`<div class="error"><span>${job.error || "The job failed."}</span><button type="button" class="ghost icon small" data-act="dismiss" aria-label="Dismiss error">${icon("x", 14)}</button></div>`
        : ""}
    `);
    this._updateEmpty();
  }

  _ensureTimer() {
    const anyLive = [...this._jobs.values()].some((e) => e.el && e.job && !TERMINAL.includes(e.job.status));
    if (anyLive && !this._timer && this.isConnected) {
      this._timer = setInterval(() => {
        let live = false;
        for (const [id, e] of this._jobs) {
          if (e.el && e.job && !TERMINAL.includes(e.job.status)) {
            live = true;
            this._renderJobBlock(id, store.job(id) || e.job);
          }
        }
        if (!live) {
          clearInterval(this._timer);
          this._timer = 0;
        }
      }, 1000);
    }
  }

  // ---- takes ------------------------------------------------------------------------------------

  _dedupe(takes) {
    const seen = new Set();
    return takes.filter((t) => t && t.id && !seen.has(t.id) && seen.add(t.id));
  }

  _take(id) {
    return this._takes.find((t) => t.id === id);
  }

  _renderTakes() {
    const box = this.$(".takes");
    if (!box) return;
    // group by job, newest job first; within a job order by item then variation
    const groups = new Map();
    for (const t of this._takes) {
      const key = t.job_id || `take:${t.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const live = new Set(this._takes.map((t) => t.id));
    for (const [id, card] of this._cards) {
      if (!live.has(id)) {
        card.remove();
        this._cards.delete(id);
      }
    }
    const frag = document.createDocumentFragment();
    for (const [key, list] of groups) {
      list.sort((a, b) => (a.item ?? 0) - (b.item ?? 0) || (a.variation ?? 0) - (b.variation ?? 0));
      const g = document.createElement("section");
      g.className = "group";
      g.dataset.job = key;
      g.innerHTML = String(this._groupHead(list));
      const grid = document.createElement("div");
      grid.className = "grid";
      for (const t of list) grid.append(this._card(t));
      g.append(grid);
      frag.append(g);
    }
    // move existing cards (players keep playing: they only pause when really removed)
    box.replaceChildren(frag);
    this._updateAB();
    this._updateEmpty();
  }

  _groupHead(list) {
    const t = list[0];
    const job = t.job_id ? store.job(t.job_id) : null;
    const label = job?.label || (list.length === 1 || (t.items || 1) === 1 ? "" : t.label);
    const model = store.model(t.model);
    const n = list.length;
    return html`
      <header class="ghead">
        ${label ? html`<span class="gl" title="${label}">${label}</span>` : ""}
        <span>${model?.label || t.model || t.workflow}</span>
        ${t.created ? html`<span>· ${fmtWhen(t.created)}</span>` : ""}
        <span>· ${n} take${n === 1 ? "" : "s"}</span>
        <span class="line"></span>
      </header>`;
  }

  _rebuildCards() {
    for (const c of this._cards.values()) c.remove();
    this._cards.clear();
    this._renderTakes();
  }

  _card(t) {
    let card = this._cards.get(t.id);
    if (card) {
      this._syncCard(card, t);
      return card;
    }
    card = document.createElement("article");
    card.className = "take";
    card.dataset.id = t.id;
    const fmt = store.settings?.download_format === "mp3" ? ["mp3", "wav"] : ["wav", "mp3"];
    const downloads = fmt
      .filter((f) => (f === "mp3" ? t.mp3_url : t.url))
      .map((f) => html`<a class="btn ghost" href="${api.downloadUrl(t, f)}" download title="Download ${f.toUpperCase()}${f === "mp3" && !t.has_mp3 ? " (converted on first download)" : ""}">${icon("download", 13)} ${f.toUpperCase()}</a>`);
    const label = t.label || t.params?.text || t.params?.prompt || t.id;
    const rtf = Number.isFinite(+t.rtf) && t.rtf != null ? `RTF ${(+t.rtf).toFixed(2)}` : "";
    card.innerHTML = String(html`
      <div class="head">
        <span class="abtag" hidden></span>
        <span class="label" title="${label}">${label}</span>
        <button type="button" class="ghost icon small star" data-act="star" aria-pressed="false" aria-label="Star take" title="Star (keep)">${icon("star", 16)}</button>
      </div>
      <div class="badges">
        ${(t.items || 1) > 1 ? html`<span class="badge" title="Line ${(t.item ?? 0) + 1} of ${t.items}">#${(t.item ?? 0) + 1}</span>` : ""}
        <span class="badge accent" title="Variation ${(t.variation ?? 0) + 1} of ${t.variations || 1}">v${(t.variation ?? 0) + 1}</span>
        ${t.seed != null ? html`<span class="badge mono" title="Seed">seed ${t.seed}</span>` : ""}
        ${t.duration_s != null ? html`<span class="badge" title="Duration">${fmtSeconds(t.duration_s)}</span>` : ""}
        ${rtf ? html`<span class="badge" title="Real-time factor: generation time / audio length${t.wall_s != null ? ` (${fmtSeconds(t.wall_s)} wall)` : ""}">${rtf}</span>` : ""}
        ${t.model ? html`<span class="badge" title="${t.model_repo || t.model}">${t.model}</span>` : ""}
      </div>
      <moss-waveform-player src="${t.url || ""}" label="${label}"></moss-waveform-player>
      <div class="acts">
        <button type="button" class="ghost" data-act="ab" aria-pressed="false" title="Compare two takes A/B">A/B</button>
        ${t.seed != null && t.request ? html`<button type="button" class="ghost" data-act="regen" title="Load this recipe and generate again with seed ${t.seed}">${icon("refresh", 13)} Same seed</button>` : ""}
        ${this.hasAttribute("save-as-voice") ? html`<button type="button" class="ghost" data-act="save" title="Save this take as a library voice">${icon("save", 13)} Save as voice</button>` : ""}
        <span class="sp"></span>
        ${downloads}
        <button type="button" class="ghost" data-act="recipe" title="Show the request that made this take" aria-haspopup="dialog">{ } Recipe</button>
      </div>
    `);
    this._cards.set(t.id, card);
    this._syncCard(card, t);
    return card;
  }

  /** Update the mutable bits of a card (star, A/B marker). */
  _syncCard(card, t) {
    const star = card.querySelector("[data-act=star]");
    star.setAttribute("aria-pressed", String(!!t.starred));
    star.setAttribute("aria-label", t.starred ? "Unstar take" : "Star take");
    star.innerHTML = String(icon(t.starred ? "starFill" : "star", 16));
    card.toggleAttribute("data-starred", !!t.starred);
    const abIdx = this._ab.indexOf(t.id);
    const tag = card.querySelector(".abtag");
    tag.hidden = abIdx < 0;
    tag.textContent = abIdx === 0 ? "A" : abIdx === 1 ? "B" : "";
    card.toggleAttribute("data-ab", abIdx >= 0);
    card.querySelector("[data-act=ab]").setAttribute("aria-pressed", String(abIdx >= 0));
  }

  _updateEmpty() {
    const empty = this.$(".empty");
    if (!empty) return;
    const anyJob = [...this._jobs.values()].some((e) => e.el);
    empty.hidden = this._takes.length > 0 || anyJob;
    empty.textContent = this.getAttribute("empty-text") || "Takes will appear here.";
  }

  _player(id) {
    return this._cards.get(id)?.querySelector("moss-waveform-player");
  }

  // ---- events -----------------------------------------------------------------------------------

  _onPlayState(e, playing) {
    const card = e.target.closest?.("article.take");
    if (!card) return;
    card.toggleAttribute("data-playing", playing);
    if (playing && this._ab.includes(card.dataset.id)) {
      this._abActive = card.dataset.id;
      this._updateAB();
    }
  }

  _onClick(e) {
    const b = e.target.closest("[data-act], button[data-slot]");
    if (!b) return;
    if (b.dataset.slot != null) return this._abSwitch(+b.dataset.slot);
    const act = b.dataset.act;
    const card = b.closest("article.take");
    const take = card ? this._take(card.dataset.id) : null;
    switch (act) {
      case "cancel": {
        const id = b.closest(".job")?.dataset.id;
        if (id) {
          b.disabled = true;
          store.cancel(id).catch((err) => {
            b.disabled = false;
            toast(err.message, "error");
          });
        }
        break;
      }
      case "dismiss": {
        const id = b.closest(".job")?.dataset.id;
        const entry = this._jobs.get(id);
        if (entry) {
          entry.dismissed = true;
          entry.el?.remove();
          entry.el = null;
          this._updateEmpty();
        }
        break;
      }
      case "star": return take && this._toggleStar(take, card);
      case "ab": return take && this._abToggle(take.id);
      case "ab-exit": return this._abExit();
      case "regen": return take && emit(this, "regenerate", { take });
      case "save": return take && this._openSave(take);
      case "save-cancel": return this.$("#save").close();
      case "recipe": return take && this._openRecipe(take, b);
      case "recipe-close": return this.$("#recipe").hidePopover();
      case "recipe-copy": {
        const text = this.$("#recipe pre").textContent;
        navigator.clipboard?.writeText(text).then(() => toast("Recipe copied", "ok"), () => toast("Couldn't copy", "error"));
        break;
      }
    }
  }

  async _toggleStar(take, card) {
    const starred = !take.starred;
    take.starred = starred;
    this._syncCard(card, take);
    try {
      const updated = await api.patchTake(take.id, { starred });
      if (updated && typeof updated === "object" && updated.id === take.id) Object.assign(take, updated);
    } catch (err) {
      take.starred = !starred;
      toast(err.message, "error");
    }
    if (this._cards.get(take.id) === card) this._syncCard(card, take);
  }

  // ---- A/B --------------------------------------------------------------------------------------

  _abToggle(id) {
    const i = this._ab.indexOf(id);
    if (i >= 0) this._ab.splice(i, 1);
    else {
      this._ab.push(id);
      if (this._ab.length > 2) this._ab.shift();
    }
    if (!this._ab.includes(this._abActive)) this._abActive = null;
    if (this._ab.length === 2 && !this._abActive) {
      // start from whichever of the two is already playing, else A
      this._abActive = this._ab.find((x) => this._player(x) && !this._player(x).paused) || this._ab[0];
    }
    this._updateAB();
  }

  _abExit() {
    this._ab = [];
    this._abActive = null;
    this._updateAB();
  }

  _pruneAB() {
    const ids = new Set(this._takes.map((t) => t.id));
    this._ab = this._ab.filter((id) => ids.has(id));
    if (!this._ab.includes(this._abActive)) this._abActive = null;
  }

  _abSwitch(slot) {
    const targetId = this._ab[slot];
    const target = this._player(targetId);
    if (!target) return;
    const fromId = this._abActive && this._abActive !== targetId ? this._abActive : null;
    const from = fromId ? this._player(fromId) : null;
    if (!from) {
      // pressing the active side toggles it
      this._abActive = targetId;
      target.toggle();
      this._updateAB();
      return;
    }
    const pos = from.currentTime;
    from.pause();
    const d = target.duration;
    target.currentTime = d ? Math.min(pos, Math.max(0, d - 0.05)) : pos;
    this._abActive = targetId;
    target.play();
    this._updateAB();
  }

  _updateAB() {
    for (const [id, card] of this._cards) {
      const t = this._take(id);
      if (t) this._syncCard(card, t);
    }
    const bar = this.$(".ab");
    if (!bar) return;
    const on = this._ab.length === 2;
    bar.hidden = !on;
    if (!on) return;
    bar.querySelectorAll("button[data-slot]").forEach((b) => {
      const id = this._ab[+b.dataset.slot];
      const t = this._take(id);
      const name = t ? `v${(t.variation ?? 0) + 1}${t.seed != null ? ` · seed ${t.seed}` : ""}` : "";
      b.querySelector(".name").textContent = name;
      b.setAttribute("aria-label", `Play ${b.dataset.slot === "0" ? "A" : "B"}: ${t?.label || name}`);
      b.setAttribute("aria-pressed", String(id === this._abActive));
    });
  }

  // ---- recipe -----------------------------------------------------------------------------------

  _openRecipe(take, anchor) {
    const pop = this.$("#recipe");
    pop.querySelector("pre").textContent = JSON.stringify(take.request ?? { params: take.params, seed: take.seed, model: take.model }, null, 2);
    if (pop.matches(":popover-open")) pop.hidePopover();
    pop.showPopover();
    // place next to the button, clamped to the viewport (no anchor positioning in Safari 17)
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.right - pw, innerWidth - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.position = "fixed";
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  // ---- save as voice ----------------------------------------------------------------------------

  _openSave(take) {
    this._saving = take;
    const dlg = this.$("#save");
    const p = take.params || {};
    this.$("#sv-name").value = "";
    this.$("#sv-desc").value = p.instruction || "";
    this.$("#sv-tr").value = take.kwargs?.text ?? p.text ?? take.label ?? "";
    dlg.querySelector(".error").hidden = true;
    this._updateSlug();
    dlg.showModal();
    this.$("#sv-name").focus();
  }

  _voiceId(name) {
    const base = slugify(name) || `voice-${Math.random().toString(36).slice(2, 7)}`;
    let id = base;
    for (let n = 2; store.voice(id); n++) id = `${base}-${n}`;
    return id;
  }

  _updateSlug() {
    const name = this.$("#sv-name").value.trim();
    this.$("#save .idline").textContent = name ? `Voice id: ${this._voiceId(name)}` : "";
  }

  async _onSaveVoice(e) {
    e.preventDefault();
    const take = this._saving;
    const dlg = this.$("#save");
    const form = dlg.querySelector("form");
    if (!take || !form.reportValidity()) return;
    const name = this.$("#sv-name").value.trim();
    const description = this.$("#sv-desc").value.trim();
    const transcript = this.$("#sv-tr").value.trim();
    const id = this._voiceId(name);
    const btn = form.querySelector("button[type=submit]");
    const err = form.querySelector(".error");
    btn.disabled = true;
    err.hidden = true;
    try {
      const body = { take: take.id, name };
      if (description) body.description = description;
      if (transcript) body.transcript = transcript;
      const voice = await api.voiceFromOutput(id, body);
      dlg.close();
      toast(`Saved voice “${voice?.name || name}”`, "ok");
      emit(this, "voice-saved", { voice });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }
}

define("moss-take-list", MossTakeList);
