// <moss-app>: shell with navigation, hash routing, model status pill, job queue drawer, toasts and
// global keyboard shortcuts. Views are loaded on first visit (dynamic import) and kept alive so
// their forms keep state while you switch.
//
// View contract (all optional): activated(), generate(), loadRecipe(request), showJob(job).
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, esc } from "../lib/dom.js";
import { store } from "../lib/store.js";
import "./moss-model-status.js";
import "./moss-job-queue.js";

export const VIEWS = [
  { route: "tts", tag: "moss-tts-view", label: "Speech", module: "./moss-tts-view.js", key: "1" },
  { route: "design", tag: "moss-design-view", label: "Voice design", module: "./moss-design-view.js", key: "2" },
  { route: "clone", tag: "moss-clone-view", label: "Cloning", module: "./moss-clone-view.js", key: "3" },
  { route: "dialogue", tag: "moss-dialogue-view", label: "Dialogue", module: "./moss-dialogue-view.js", key: "4" },
  { route: "sfx", tag: "moss-sfx-view", label: "Sound effects", module: "./moss-sfx-view.js", key: "5" },
  { route: "library", tag: "moss-library-view", label: "Library", module: "./moss-library-view.js", key: "6" },
  { route: "settings", tag: "moss-settings-view", label: "Settings", module: "./moss-settings-view.js", key: "7" },
];

const styles = css`
  :host { display: grid; grid-template-rows: auto auto 1fr; min-height: 100vh; background: var(--bg); }
  header {
    position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: var(--sp-4);
    padding: var(--sp-2) var(--sp-5); background: color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: .02em; color: var(--accent); text-decoration: none; font-size: var(--fs-lg); }
  .brand span { color: var(--text); font-weight: 600; }
  nav { display: flex; gap: 2px; flex-wrap: wrap; flex: 1 1 auto; }
  nav a {
    padding: 6px 12px; border-radius: var(--radius-pill); color: var(--text-2); text-decoration: none;
    font-size: var(--fs-sm); font-weight: 500; transition: background var(--dur), color var(--dur);
  }
  nav a:hover { background: var(--surface-2); color: var(--text); }
  nav a[aria-current=page] { background: var(--accent-soft); color: var(--accent); }
  .tools { display: flex; align-items: center; gap: var(--sp-2); }
  .count { min-width: 18px; height: 18px; border-radius: 9px; background: var(--accent); color: var(--accent-text); font-size: 11px; display: inline-grid; place-items: center; padding: 0 5px; }
  .count:empty, .count[data-n="0"] { display: none; }
  .offline { background: var(--danger-soft); color: var(--danger); padding: var(--sp-2) var(--sp-5); font-size: var(--fs-sm); }
  main { padding: var(--sp-5); max-width: 1440px; width: 100%; margin: 0 auto; }
  main > * { display: none; }
  main > [active] { display: block; }
  .view-error { max-width: 640px; }
  #queue { position: fixed; inset: 56px var(--sp-4) auto auto; margin: 0; width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 80px); overflow: auto; padding: 0; }
  .toasts { position: fixed; bottom: var(--sp-4); left: 50%; translate: -50% 0; display: grid; gap: var(--sp-2); z-index: 100; justify-items: center; pointer-events: none; }
  .toast { pointer-events: auto; background: var(--text); color: var(--bg); padding: 10px 16px; border-radius: var(--radius); box-shadow: var(--shadow-lg); font-size: var(--fs-sm); max-width: min(560px, 90vw); animation: rise .18s ease-out; }
  .toast.error { background: var(--danger); color: #fff; }
  .toast.ok { background: var(--accent); color: var(--accent-text); }
  @keyframes rise { from { opacity: 0; translate: 0 8px; } }
  dl.keys { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: var(--sp-4) 0; font-size: var(--fs-sm); }
  dl.keys dt { text-align: right; white-space: nowrap; }
  dl.keys dd { margin: 0; color: var(--text-2); }
  @media (max-width: 720px) { header { padding: var(--sp-2) var(--sp-3); } main { padding: var(--sp-3); } }
`;

class MossApp extends MossElement {
  static styles = [styles];

  render() {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    this.mod = mac ? "⌘" : "Ctrl";
    this.setHTML(html`
      <header>
        <a class="brand" href="#/tts" title="MOSS Studio">${icon("wave", 20)} MOSS <span>Studio</span></a>
        <nav aria-label="Workflows">
          ${VIEWS.map((v) => html`<a href="#/${v.route}" data-route="${v.route}" title="${v.label} (Alt+${v.key})">${v.label}</a>`)}
        </nav>
        <div class="tools">
          <moss-model-status></moss-model-status>
          <button class="ghost" popovertarget="queue" title="Job queue (Alt+Q)">${icon("queue")} Queue <span class="count" data-n="0"></span></button>
          <button class="ghost icon" id="help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">${icon("keyboard")}</button>
        </div>
      </header>
      <div class="offline" hidden role="status">Lost connection to the moss-ui server. Retrying…</div>
      <main></main>
      <moss-job-queue id="queue" popover></moss-job-queue>
      <div class="toasts" role="status" aria-live="polite"></div>
      <dialog id="keys" aria-labelledby="keys-title">
        <h3 id="keys-title">Keyboard shortcuts</h3>
        <dl class="keys">
          <dt><kbd>${this.mod}</kbd> <kbd>Enter</kbd></dt><dd>Generate in the current view</dd>
          <dt><kbd>Alt</kbd> <kbd>1</kbd>–<kbd>7</kbd></dt><dd>Switch view (${VIEWS.map((v) => v.label).join(", ")})</dd>
          <dt><kbd>Alt</kbd> <kbd>Q</kbd></dt><dd>Show or hide the job queue</dd>
          <dt><kbd>Alt</kbd> <kbd>.</kbd></dt><dd>Cancel the running job</dd>
          <dt><kbd>Space</kbd></dt><dd>Play / pause the focused take</dd>
          <dt><kbd>?</kbd></dt><dd>This list</dd>
        </dl>
        <form method="dialog" class="row end"><button class="primary">Close</button></form>
      </dialog>
    `);
  }

  connected() {
    this.on(window, "hashchange", () => this.route());
    this.on(window, "moss-toast", (e) => this.toast(e.detail.message, e.detail.kind));
    this.on(window, "keydown", (e) => this.onKey(e));
    this.$("#help").addEventListener("click", () => this.$("#keys").showModal());
    store.on("jobs", ({ jobs }) => this.updateCount(jobs), this.signal);
    store.on("connection", ({ connected }) => (this.$(".offline").hidden = connected), this.signal);
    store.on("job", ({ job }) => this.notifyJob(job), this.signal);
    this.seen = new Map();
    this.route();
  }

  updateCount(jobs) {
    const n = jobs.filter((j) => !["done", "error", "cancelled"].includes(j.status)).length;
    const c = this.$(".count");
    c.dataset.n = n;
    c.textContent = n || "";
  }

  notifyJob(job) {
    // Toast a job's outcome once, when it finishes while you're on another view.
    const prev = this.seen.get(job.id);
    this.seen.set(job.id, job.status);
    if (prev === job.status || !["done", "error"].includes(job.status)) return;
    if (prev === undefined) return;
    const here = this.current === job.workflow;
    if (job.status === "error") this.toast(`Job failed: ${job.error}`, "error");
    else if (!here) this.toast(`${job.outputs.length} take${job.outputs.length === 1 ? "" : "s"} ready in ${VIEWS.find((v) => v.route === job.workflow)?.label || job.workflow}`, "ok");
  }

  async route() {
    const name = (location.hash.match(/^#\/([\w-]+)/) || [])[1] || "tts";
    const view = VIEWS.find((v) => v.route === name) || VIEWS[0];
    this.current = view.route;
    for (const a of this.$$("nav a")) {
      if (a.dataset.route === view.route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    document.title = `${view.label} · MOSS Studio`;
    const main = this.$("main");
    let el = main.querySelector(`[data-route="${view.route}"]`);
    if (!el) {
      try {
        await import(view.module);
        el = document.createElement(view.tag);
      } catch (e) {
        console.error(e);
        el = document.createElement("div");
        el.className = "view-error";
        el.innerHTML = `<div class="error">Couldn't load the ${esc(view.label)} view: ${esc(e.message)}</div>`;
      }
      el.dataset.route = view.route;
      main.append(el);
    }
    if (this.current !== view.route) return; // a newer navigation won
    for (const c of main.children) c.toggleAttribute("active", c === el);
    el.activated?.();
  }

  get activeView() {
    return this.$("main > [active]");
  }

  onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    const typing = e.composedPath().some((n) => n instanceof HTMLElement && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)));
    if (mod && e.key === "Enter") {
      e.preventDefault();
      this.activeView?.generate?.();
      return;
    }
    if (e.altKey && !mod) {
      const v = VIEWS.find((x) => e.code === `Digit${x.key}`);
      if (v) {
        e.preventDefault();
        location.hash = `#/${v.route}`;
        return;
      }
      if (e.code === "KeyQ") {
        e.preventDefault();
        this.$("#queue").togglePopover();
        return;
      }
      if (e.code === "Period") {
        e.preventDefault();
        const running = store.jobs.find((j) => ["running", "loading", "warming"].includes(j.status));
        if (running) store.cancel(running.id).then(() => this.toast("Cancelled the running job"));
        return;
      }
    }
    if (!typing && !mod && (e.key === "?" || (e.shiftKey && e.code === "Slash"))) {
      e.preventDefault();
      this.$("#keys").showModal();
    }
  }

  toast(message, kind = "info") {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = message;
    this.$(".toasts").append(t);
    setTimeout(() => t.remove(), kind === "error" ? 7000 : 3500);
  }
}

define("moss-app", MossApp);
