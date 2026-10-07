// <moss-settings-view> (route #/settings): app settings bound to store.settings, the model table
// with load/warm/unload controls, and an About card.
//
// View contract (called by <moss-app>): activated() refreshes settings from the server (unless the
// form has unsaved edits); generate() saves the form (so Cmd/Ctrl+Enter saves here).
// Save sends only the changed fields to store.saveSettings(patch) (PATCH /api/settings); client-side
// validation mirrors the server's, and errors (client or ApiError) show inline next to the field / Save.
import { MossElement, define } from "../lib/element.js";
import { css, html, esc, icon, toast } from "../lib/dom.js";
import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import { viewLayout } from "../lib/styles.js";

const styles = css`
  .grid { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
  @container (min-width: 900px) { .grid { grid-template-columns: minmax(320px, 5fr) minmax(0, 6fr); } }
  .card h3 { margin-bottom: var(--sp-3); }
  .field-error { color: var(--danger); font-size: var(--fs-xs); }
  input[aria-invalid=true] { border-color: var(--danger); }
  .over { font-size: var(--fs-xs); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { font-weight: 500; color: var(--text-2); font-size: var(--fs-xs); white-space: nowrap; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr[data-resident] td:first-child { font-weight: 600; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); margin-right: 6px; vertical-align: 0; }
  .dot[data-state=ready] { background: var(--ok); }
  .dot[data-state=loading], .dot[data-state=warming] { background: var(--warn); animation: pulse 1s infinite; }
  .dot[data-state=error] { background: var(--danger); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; font-size: var(--fs-sm); }
  dt { color: var(--text-2); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .side { display: grid; gap: var(--sp-5); }
`;

const FIELDS = ["data_dir", "port", "warm_model", "idle_unload_minutes", "download_format", "transcribe_model"];

const STATE_TEXT = {
  empty: "No model loaded",
  loading: "Loading",
  warming: "Warming up",
  ready: "Ready",
  "idle-unloaded": "Unloaded (idle)",
  error: "Error",
};

class MossSettingsView extends MossElement {
  static styles = [viewLayout, styles];

  render() {
    this.dirty = false;
    this.setHTML(html`
      <div class="view-head">
        <h2>Settings</h2>
        <p>Stored in <code>config.json</code> next to the app. Models are loaded one at a time; manage them here.</p>
      </div>
      <div class="grid">
        <form class="card stack" novalidate>
          <h3>General</h3>
          <div class="field">
            <label for="data_dir">Data directory</label>
            <input id="data_dir" name="data_dir" autocomplete="off" spellcheck="false" required>
            <span class="hint">Outputs and the voice library. Applies to new files only; nothing is moved.</span>
            <span class="field-error" data-for="data_dir" hidden></span>
          </div>
          <div class="field">
            <label for="port">Port</label>
            <input id="port" name="port" type="number" min="1024" max="65535" step="1" required>
            <span class="hint">The host is always 127.0.0.1. Restart required.</span>
            <span class="field-error" data-for="port" hidden></span>
          </div>
          <div class="field">
            <label for="warm_model">Model to load at startup</label>
            <select id="warm_model" name="warm_model"></select>
            <span class="hint">Loaded and warmed when the server starts so the first job is fast.</span>
            <span class="field-error" data-for="warm_model" hidden></span>
          </div>
          <div class="field">
            <label for="idle_unload_minutes">Unload after idle (minutes)</label>
            <input id="idle_unload_minutes" name="idle_unload_minutes" type="number" min="0" step="1" required>
            <span class="hint">Frees memory when nothing has run for this long. 0 = never.</span>
            <span class="field-error" data-for="idle_unload_minutes" hidden></span>
          </div>
          <div class="field">
            <span class="label" id="fmt-label">Default download format</span>
            <div class="seg" role="radiogroup" aria-labelledby="fmt-label">
              <label><input type="radio" name="download_format" value="wav"><span>WAV</span></label>
              <label><input type="radio" name="download_format" value="mp3"><span>MP3</span></label>
            </div>
            <span class="hint">Both formats stay available for every take.</span>
          </div>
          <div class="field">
            <label for="transcribe_model">Transcription model</label>
            <input id="transcribe_model" name="transcribe_model" autocomplete="off" spellcheck="false" required>
            <span class="hint">Hugging Face repo used for reference transcripts.</span>
            <span class="field-error" data-for="transcribe_model" hidden></span>
          </div>
          <div class="notice" id="overridden" hidden></div>
          <div class="notice" id="restart" role="status" hidden></div>
          <div class="error" id="error" role="alert" hidden></div>
          <div class="actions">
            <button class="primary" type="submit" id="save">${icon("save")} Save</button>
            <button type="button" class="ghost" id="revert" disabled>Revert</button>
          </div>
        </form>

        <div class="side">
          <section class="card stack" aria-labelledby="models-title">
            <div class="row between">
              <h3 id="models-title">Models</h3>
              <button class="danger small" type="button" id="unload">${icon("x", 14)} Unload now</button>
            </div>
            <p class="small" id="resident" role="status" aria-live="polite"></p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Model</th><th>Rate</th><th>Peak</th><th>Features</th><th>RTF</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
            <p class="hint">RTF = generation time ÷ audio length (lower is faster), measured on this machine. Only one model fits in memory at a time.</p>
          </section>

          <section class="card stack" aria-labelledby="about-title">
            <h3 id="about-title">About</h3>
            <dl>
              <dt>Address</dt><dd id="addr"></dd>
              <dt>Data directory</dt><dd class="mono small" id="resolved"></dd>
            </dl>
            <p class="small muted">The server only listens on 127.0.0.1, so it isn't reachable from other machines.
              Press <kbd>?</kbd> for keyboard shortcuts.</p>
          </section>
        </div>
      </div>
    `);

    const form = this.$("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.save();
    });
    form.addEventListener("input", (e) => {
      this.dirty = true;
      this.$("#revert").disabled = false;
      if (e.target.name) this.fieldError(e.target.name, "");
    });
    this.$("#revert").addEventListener("click", () => {
      this.fill(store.settings, true);
      this.clearErrors();
    });
    this.$("#unload").addEventListener("click", () => api.unload().catch((e) => toast(e.message, "error")));
    this.$("tbody").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-warm]");
      if (!b) return;
      api.warm(b.dataset.warm).then(
        () => toast(`Loading ${b.dataset.warm}…`),
        (err) => toast(err.message, "error"),
      );
    });
  }

  connected() {
    store.on("settings", ({ settings }) => this.fill(settings), this.signal);
    store.on("models", () => {
      this.fillModels();
      this.fill(store.settings, !this.dirty);
    }, this.signal);
    store.on("status", () => this.updateModels(), this.signal);
    store.on("jobs", () => this.updateModels(), this.signal);
    this.fillModels();
    this.fill(store.settings, true);
  }

  activated() {
    if (!this.dirty) store.refreshSettings?.().catch(() => {});
    this.updateModels();
  }

  generate() {
    this.save();
  }

  // ----- settings form -----

  /** Fill the form from settings. Unsaved edits are kept unless force. */
  fill(s, force = false) {
    s = s || {};
    this.$("#addr").textContent = s.port ? `http://${s.host || "127.0.0.1"}:${s.port}` : "–";
    this.$("#resolved").textContent = s.data_dir_resolved || "–";
    const over = (s.overridden || []).filter((k) => FIELDS.includes(k));
    const ov = this.$("#overridden");
    ov.hidden = !over.length;
    ov.textContent = over.length ? `Set by a launch flag for this run: ${over.join(", ")}. Saving a new value here replaces it.` : "";
    if (this.dirty && !force) return;

    this.fillWarmSelect(s.warm_model);
    const f = this.$("form").elements;
    f.data_dir.value = s.data_dir ?? "";
    f.port.value = s.port ?? "";
    f.idle_unload_minutes.value = s.idle_unload_minutes ?? "";
    f.transcribe_model.value = s.transcribe_model ?? "";
    for (const r of this.$$("input[name=download_format]")) r.checked = r.value === (s.download_format || "wav");
    this.dirty = false;
    this.$("#revert").disabled = true;
  }

  fillWarmSelect(value) {
    const sel = this.$("#warm_model");
    const keys = store.models.map((m) => m.key);
    if (value && value !== "none" && !keys.includes(value)) keys.push(value);
    sel.innerHTML = String(html`
      ${keys.map((k) => html`<option value="${k}">${k}${store.model(k) ? ` · ${store.model(k).label}` : ""}</option>`)}
      <option value="none">None (don't load at startup)</option>
    `);
    sel.value = value || "none";
  }

  /** Read + validate the form. Returns {values, errors}. */
  read() {
    const f = this.$("form").elements;
    const errors = {};
    const values = {};
    const str = (k, label) => {
      const v = f[k].value.trim();
      if (!v) errors[k] = `${label} can't be empty.`;
      values[k] = v;
    };
    str("data_dir", "Data directory");
    str("transcribe_model", "Transcription model");
    const port = f.port.value.trim();
    if (!/^\d+$/.test(port) || +port < 1024 || +port > 65535) errors.port = "Use a whole number between 1024 and 65535.";
    else values.port = +port;
    const idle = f.idle_unload_minutes.value.trim();
    if (idle === "" || !Number.isFinite(+idle) || +idle < 0) errors.idle_unload_minutes = "Use a number of minutes ≥ 0 (0 = never).";
    else values.idle_unload_minutes = +idle;
    values.warm_model = f.warm_model.value;
    values.download_format = this.$("input[name=download_format]:checked")?.value || "wav";
    return { values, errors };
  }

  async save() {
    this.clearErrors();
    const { values, errors } = this.read();
    const bad = Object.keys(errors);
    if (bad.length) {
      for (const k of bad) this.fieldError(k, errors[k]);
      this.$(`[name=${bad[0]}]`)?.focus();
      return;
    }
    const cur = store.settings || {};
    const patch = {};
    for (const k of FIELDS) if (values[k] !== undefined && values[k] !== cur[k]) patch[k] = values[k];
    if (!Object.keys(patch).length) {
      this.dirty = false;
      this.$("#revert").disabled = true;
      toast("Nothing changed");
      return;
    }
    const btn = this.$("#save");
    btn.disabled = true;
    try {
      const res = await store.saveSettings(patch);
      this.dirty = false;
      this.fill(res, true);
      const restart = this.$("#restart");
      if (res.restart_required) {
        restart.textContent = `Restart moss-ui for the new port to take effect; it will then be at http://127.0.0.1:${res.port}.`;
        restart.hidden = false;
      }
      toast("Saved", "ok");
    } catch (e) {
      const msg = e?.message || String(e);
      const err = this.$("#error");
      err.textContent = msg;
      err.hidden = false;
      const field = FIELDS.find((k) => msg.startsWith(k));
      if (field) this.fieldError(field, msg);
      toast(msg, "error");
    } finally {
      btn.disabled = false;
    }
  }

  fieldError(name, msg) {
    const el = this.$(`.field-error[data-for="${name}"]`);
    const input = this.$(`[name="${name}"]`);
    if (el) {
      el.textContent = msg;
      el.hidden = !msg;
      el.id = `err-${name}`;
    }
    if (input && input.type !== "radio") {
      if (msg) {
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", `err-${name}`);
      } else {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    }
  }

  clearErrors() {
    for (const k of FIELDS) this.fieldError(k, "");
    this.$("#error").hidden = true;
  }

  // ----- models -----

  fillModels() {
    const tbody = this.$("tbody");
    if (!store.models.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading model list…</td></tr>`;
      return;
    }
    tbody.innerHTML = store.models
      .map((m) => String(html`
        <tr data-key="${m.key}">
          <td><span class="dot" aria-hidden="true"></span><span title="${m.repo}">${m.key}</span> <span class="muted small">${m.label}</span></td>
          <td class="num">${m.sample_rate ? `${(m.sample_rate / 1000).toFixed(m.sample_rate % 1000 ? 1 : 0)} kHz` : "–"}</td>
          <td class="num">${m.peak_gb != null ? `~${m.peak_gb} GB` : "–"}</td>
          <td>${m.streaming ? html`<span class="badge accent">streaming</span> ` : ""}${m.cloning ? html`<span class="badge">cloning</span>` : ""}</td>
          <td class="num" data-rtf></td>
          <td><button class="small" type="button" data-warm="${m.key}" aria-label="Load and warm ${m.label}">Load &amp; warm</button></td>
        </tr>`))
      .join("");
    this.updateModels();
  }

  updateModels() {
    const s = store.status || {};
    const m = s.key ? store.model(s.key) : null;
    let text = STATE_TEXT[s.state] || s.state || "Unknown";
    if (s.state === "ready" && s.busy) text = s.task === "transcribe" ? "Transcribing" : "Generating";
    this.$("#resident").innerHTML = m && s.state !== "empty"
      ? `Resident: <strong>${esc(m.label)}</strong> · ${esc(text)}${s.error ? ` <span class="badge danger">${esc(s.error)}</span>` : ""}`
      : `${esc(text)}${s.error ? ` <span class="badge danger">${esc(s.error)}</span>` : ""}`;
    const busy = !!s.busy || !!s.pending || store.activeJobs.length > 0;
    for (const tr of this.$$("tbody tr[data-key]")) {
      const key = tr.dataset.key;
      const resident = key === s.key && s.state !== "empty";
      tr.toggleAttribute("data-resident", resident);
      const dot = tr.querySelector(".dot");
      dot.dataset.state = resident ? s.state : "";
      const rtf = s.rtf?.[key] ?? store.model(key)?.rtf;
      tr.querySelector("[data-rtf]").textContent = rtf != null && Number.isFinite(+rtf) ? (+rtf).toFixed(2) : "–";
      const b = tr.querySelector("button[data-warm]");
      const ready = resident && ["ready", "loading", "warming"].includes(s.state);
      b.disabled = ready;
      b.title = ready ? "Already loaded" : busy ? "Runs after the queued jobs" : "";
    }
    this.$("#unload").disabled = !m || ["empty", "idle-unloaded"].includes(s.state);
  }
}

define("moss-settings-view", MossSettingsView);
