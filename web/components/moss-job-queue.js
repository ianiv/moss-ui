// <moss-job-queue>: live list of jobs (active first, then recent), with cancel and "show" (jump to
// the workflow view, which then tracks the job's takes). Used as a popover drawer by <moss-app>.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, fmtSeconds } from "../lib/dom.js";
import { store } from "../lib/store.js";

const styles = css`
  /* no display on :host: it would override the popover's hidden state */
  :host(:popover-open) { display: block; }
  .head { display: flex; justify-content: space-between; align-items: center; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); }
  ul { list-style: none; margin: 0; padding: var(--sp-2); display: grid; gap: var(--sp-2); }
  li { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-2) var(--sp-3); display: grid; gap: 4px; background: var(--surface); }
  li[data-status=running], li[data-status=loading], li[data-status=warming] { border-color: var(--accent); }
  .top { display: flex; gap: var(--sp-2); align-items: center; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); font-weight: 500; }
  .meta { font-size: var(--fs-xs); color: var(--text-3); display: flex; gap: var(--sp-2); flex-wrap: wrap; }
  progress { width: 100%; height: 4px; accent-color: var(--accent); }
  .empty { margin: var(--sp-3); padding: var(--sp-5); }
`;

const STATUS = {
  queued: (j) => (j.position > 1 ? `Queued · #${j.position}` : "Up next"),
  loading: () => "Loading model",
  warming: () => "Warming up",
  running: () => "Generating",
  done: () => "Done",
  error: () => "Failed",
  cancelled: () => "Cancelled",
};
const BADGE = { done: "accent", error: "danger", cancelled: "", queued: "", loading: "warn", warming: "warn", running: "accent" };

class MossJobQueue extends MossElement {
  static styles = [styles];

  render() {
    this.setHTML(html`
      <div class="head"><h4>Jobs</h4><button class="ghost small" id="clear" title="Hide finished jobs">Clear finished</button></div>
      <ul></ul>
    `);
    this.hiddenIds = new Set();
    this.$("#clear").addEventListener("click", () => {
      for (const j of store.jobs) if (["done", "error", "cancelled"].includes(j.status)) this.hiddenIds.add(j.id);
      this.update();
    });
    this.$("ul").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const id = b.closest("li").dataset.id;
      const job = store.job(id);
      if (b.dataset.act === "cancel") store.cancel(id).catch((err) => window.dispatchEvent(new CustomEvent("moss-toast", { detail: { message: err.message, kind: "error" } })));
      if (b.dataset.act === "show" && job) {
        location.hash = `#/${job.workflow}`;
        setTimeout(() => store.emit("show-job", { job }), 50);
        this.hidePopover?.();
      }
    });
  }

  connected() {
    store.on("jobs", () => this.update(), this.signal);
    this.timer = setInterval(() => this.matches(":popover-open") && this.update(), 1000);
    this.update();
  }

  disconnected() {
    clearInterval(this.timer);
  }

  update() {
    const active = store.activeJobs;
    const recent = store.jobs.filter((j) => !active.includes(j) && !this.hiddenIds.has(j.id)).slice(0, 20);
    const jobs = [...active.slice().reverse(), ...recent];
    const ul = this.$("ul");
    if (!jobs.length) {
      ul.innerHTML = `<li class="empty">No jobs yet. Generated takes show up here while they run.</li>`;
      return;
    }
    ul.innerHTML = jobs.map((j) => String(this.item(j))).join("");
  }

  item(j) {
    const live = ["running", "loading", "warming"].includes(j.status);
    const elapsed = j.started ? (j.finished || Date.now() / 1000) - j.started : 0;
    const total = j.items * j.variations;
    const doneN = j.outputs?.length || 0;
    return html`
      <li data-id="${j.id}" data-status="${j.status}">
        <div class="top">
          <span class="label" title="${j.label}">${j.label || j.workflow}</span>
          <span class="badge ${BADGE[j.status] || ""}">${(STATUS[j.status] || (() => j.status))(j)}</span>
        </div>
        <div class="meta">
          <span>${j.workflow} · ${j.model}</span>
          <span>${doneN}/${total} take${total === 1 ? "" : "s"}</span>
          ${j.stream ? html`<span>live</span>` : ""}
          ${elapsed ? html`<span>${fmtSeconds(elapsed)}${j.estimate_s && live ? html` of ~${fmtSeconds(j.estimate_s)}` : ""}</span>` : ""}
          <span>seed ${j.seed}</span>
        </div>
        ${live ? (j.estimate_s ? html`<progress max="1" value="${Math.min(0.97, elapsed / j.estimate_s)}"></progress>` : html`<progress></progress>`) : ""}
        ${j.error ? html`<div class="error">${j.error}</div>` : ""}
        <div class="row end">
          ${!["done", "error", "cancelled"].includes(j.status) ? html`<button class="small danger" data-act="cancel">${icon("x", 14)} Cancel</button>` : ""}
          <button class="small ghost" data-act="show">${icon("open", 14)} Show</button>
        </div>
      </li>`;
  }
}

define("moss-job-queue", MossJobQueue);
