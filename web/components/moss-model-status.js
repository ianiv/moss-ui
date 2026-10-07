// <moss-model-status>: pill showing the resident model and its state (loading / warming / ready /
// idle-unloaded / error), with a popover for details, memory note, warm and unload actions.
import { MossElement, define } from "../lib/element.js";
import { css, html, esc } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { api } from "../lib/api.js";

const styles = css`
  :host { display: inline-block; position: relative; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px 5px 10px; border-radius: var(--radius-pill);
    border: 1px solid var(--border); background: var(--surface); font-size: var(--fs-sm); cursor: pointer; color: var(--text);
    max-width: 320px;
  }
  .pill:hover { background: var(--surface-2); }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: none; }
  [data-state=ready] .dot { background: var(--ok); }
  [data-state=loading] .dot, [data-state=warming] .dot { background: var(--warn); animation: pulse 1s infinite; }
  [data-state=error] .dot { background: var(--danger); }
  [data-busy] .dot { background: var(--accent); animation: pulse 1s infinite; }
  #pop { position: fixed; inset: 56px auto auto auto; margin: 0; width: min(360px, calc(100vw - 32px)); padding: var(--sp-4); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: var(--sp-3) 0; font-size: var(--fs-sm); }
  dt { color: var(--text-2); }
  dd { margin: 0; }
`;

const STATE_TEXT = {
  empty: "No model loaded",
  loading: "Loading",
  warming: "Warming up",
  ready: "Ready",
  "idle-unloaded": "Unloaded (idle)",
  error: "Error",
};

class MossModelStatus extends MossElement {
  static styles = [styles];

  render() {
    this.setHTML(html`
      <button class="pill" popovertarget="pop" aria-label="Model status"><span class="dot"></span><span class="label">Connecting…</span></button>
      <div id="pop" popover>
        <h4>Model</h4>
        <div class="body"></div>
        <div class="row">
          <select id="warm-key" aria-label="Model to load"></select>
          <button id="warm" class="small">Load &amp; warm</button>
          <button id="unload" class="small danger">Unload</button>
        </div>
      </div>
    `);
    this.$("#warm").addEventListener("click", () => api.warm(this.$("#warm-key").value).catch((e) => this.fail(e)));
    this.$("#unload").addEventListener("click", () => api.unload().catch((e) => this.fail(e)));
    this.$("#pop").addEventListener("toggle", () => this.update());
  }

  connected() {
    store.on("status", () => {
      this._statusAt = Date.now() / 1000;
      this.update();
    }, this.signal);
    store.on("models", () => this.fillSelect(), this.signal);
    store.on("jobs", () => this.update(), this.signal);
    this.fillSelect();
    this.update();
    this.timer = setInterval(() => this.$("#pop").matches(":popover-open") && this.update(), 1000);
  }

  disconnected() {
    clearInterval(this.timer);
  }

  fail(e) {
    window.dispatchEvent(new CustomEvent("moss-toast", { detail: { message: e.message, kind: "error" } }));
  }

  fillSelect() {
    const sel = this.$("#warm-key");
    sel.innerHTML = store.models.map((m) => `<option value="${esc(m.key)}">${esc(m.key)} · ${esc(m.label)}</option>`).join("");
    if (store.status.key) sel.value = store.status.key;
  }

  update() {
    const s = store.status || {};
    const m = s.key ? store.model(s.key) : null;
    const pill = this.$(".pill");
    pill.dataset.state = s.state || "empty";
    pill.toggleAttribute("data-busy", !!s.busy && s.state === "ready");
    let text = STATE_TEXT[s.state] || s.state || "…";
    if (s.state === "ready" && s.busy) text = { transcribe: "Transcribing", warm: "Preparing voice", unload: "Unloading" }[s.task] || "Generating";
    const name = m ? m.key : "";
    this.$(".label").textContent = !store.connected && !s.state ? "Connecting…" : name && s.state !== "empty" ? `${name} · ${text}` : text;
    pill.title = m ? `${m.label}: ${text}` : text;

    const idleMin = +s.idle_unload_minutes || 0;
    const idleLeft = idleMin > 0 && s.state === "ready" && !s.busy ? Math.max(0, idleMin * 60 - (s.idle_for || 0) - (Date.now() / 1000 - (this._statusAt || Date.now() / 1000))) : null;
    this.$(".body").innerHTML = String(html`
      <dl>
        <dt>Resident</dt><dd>${m ? m.label : "none"}</dd>
        <dt>State</dt><dd>${text}${s.error ? html` <span class="badge danger">${s.error}</span>` : ""}</dd>
        ${s.load_s != null && m ? html`<dt>Last load</dt><dd>${s.load_s}s load + ${s.warm_s ?? "–"}s warm-up</dd>` : ""}
        ${m ? html`<dt>Memory</dt><dd>~${m.peak_gb} GB peak while generating</dd>` : ""}
        <dt>Queue</dt><dd>${store.activeJobs.length} active job(s)</dd>
        <dt>Idle unload</dt><dd>${idleMin > 0 ? `after ${idleMin} min idle` : "off"}${idleLeft != null && m ? ` (in ~${Math.ceil(idleLeft / 60)} min)` : ""}</dd>
      </dl>
      <p class="hint">Only one MOSS model fits in memory at a time; switching unloads the current one. Change idle unload in Settings.</p>
    `);
    this.$("#unload").disabled = !m || s.state === "empty" || s.state === "idle-unloaded";
  }
}

define("moss-model-status", MossModelStatus);
