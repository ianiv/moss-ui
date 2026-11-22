// App state on an EventTarget. The server is the source of truth; the store mirrors it from
// REST calls plus the global /api/events stream, and components subscribe to change events.
//
// Events (CustomEvent, detail shown):
//   "models"     {models}               model table loaded
//   "status"     {status}               resident model / worker state changed
//   "jobs"       {jobs}                 queue list changed (any job)
//   "job"        {job}                  one job changed (full job dict)
//   "voices"     {voices}               voice library changed
//   "history"    {change}               outputs added / starred / removed (refetch what you show)
//   "settings"   {settings}
//   "connection" {connected}
//   "recipe"     {workflow, request}    "open in editor" was requested for a workflow view
import { api } from "./api.js";

class Store extends EventTarget {
  constructor() {
    super();
    this.models = []; // [{key, repo, label, short, sample_rate, streaming, cloning, needs_voice, continuation, instruction, peak_gb, rtf, workflows}]
    this.workflows = {}; // workflow -> [model keys]
    this.info = {}; // {frames_per_second, default_max_seconds, sfx_sampling, sfx2_sampling}
    this.status = {}; // {key, state, since, load_s, warm_s, error, busy, task, pending, rtf, idle_unload_minutes}
    this.jobs = []; // newest first
    this.voices = [];
    this.settings = {};
    this.connected = false;
    this.pendingRecipe = null;
    this._es = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Subscribe; pass an AbortSignal (e.g. component.signal) to auto-remove. */
  on(type, fn, signal) {
    const h = (e) => fn(e.detail, e);
    this.addEventListener(type, h, { signal });
    return () => this.removeEventListener(type, h);
  }

  model(key) {
    return this.models.find((m) => m.key === key);
  }

  voice(id) {
    return this.voices.find((v) => v.id === id);
  }

  async init() {
    const [m, voices, settings, jobs] = await Promise.all([api.models(), api.voices(), api.settings(), api.jobs()]);
    this.models = m.models;
    this.workflows = m.workflows;
    this.info = { frames_per_second: m.frames_per_second, default_max_seconds: m.default_max_seconds, sfx_sampling: m.sfx_sampling, sfx2_sampling: m.sfx2_sampling };
    this.status = m.status;
    this.voices = voices;
    this.settings = settings;
    this.jobs = jobs.jobs;
    this.emit("models", { models: this.models });
    this.emit("status", { status: this.status });
    this.emit("voices", { voices: this.voices });
    this.emit("settings", { settings: this.settings });
    this.emit("jobs", { jobs: this.jobs });
    this.connect();
  }

  connect() {
    this._es?.close();
    const es = new EventSource("/api/events");
    this._es = es;
    const parse = (ev) => {
      try { return JSON.parse(ev.data); } catch { return {}; }
    };
    es.addEventListener("hello", (ev) => {
      const d = parse(ev);
      this.setConnected(true);
      this.setStatus(d.model);
      this.jobs = d.jobs || [];
      this.emit("jobs", { jobs: this.jobs });
    });
    es.addEventListener("model", (ev) => this.setStatus(parse(ev)));
    es.addEventListener("job", (ev) => this.upsertJob(parse(ev)));
    es.addEventListener("voices", () => this.refreshVoices());
    es.addEventListener("history", (ev) => this.emit("history", { change: parse(ev) }));
    es.addEventListener("settings", (ev) => {
      this.settings = parse(ev);
      this.emit("settings", { settings: this.settings });
    });
    es.onerror = () => {
      this.setConnected(false);
      // EventSource retries by itself; when it reconnects "hello" resyncs everything.
    };
  }

  setConnected(v) {
    if (this.connected === v) return;
    this.connected = v;
    this.emit("connection", { connected: v });
    if (v) this.refreshVoices().catch(() => {});
  }

  setStatus(s) {
    if (!s) return;
    this.status = s;
    this.emit("status", { status: s });
  }

  upsertJob(job) {
    if (!job?.id) return;
    const i = this.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) this.jobs[i] = job;
    else this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, 100);
    this.emit("job", { job });
    this.emit("jobs", { jobs: this.jobs });
  }

  job(id) {
    return this.jobs.find((j) => j.id === id);
  }

  get activeJobs() {
    return this.jobs.filter((j) => !["done", "error", "cancelled"].includes(j.status));
  }

  /** True when nothing is queued or running (used to decide whether to warm a model on pick). */
  get idle() {
    return !this.status.busy && !this.status.pending && this.activeJobs.length === 0;
  }

  async refreshVoices() {
    this.voices = await api.voices();
    this.emit("voices", { voices: this.voices });
    return this.voices;
  }

  async refreshSettings() {
    this.settings = await api.settings();
    this.emit("settings", { settings: this.settings });
    return this.settings;
  }

  async saveSettings(patch) {
    this.settings = await api.saveSettings(patch);
    this.emit("settings", { settings: this.settings });
    return this.settings;
  }

  /** Submit a job request; returns the created job (also tracked in this.jobs). */
  async submit(req) {
    const formats = req.formats || (this.settings.download_format === "mp3" ? ["wav", "mp3"] : ["wav"]);
    const job = await api.createJob({ ...req, formats });
    this.upsertJob(job);
    return job;
  }

  cancel(id) {
    return api.cancelJob(id).then((job) => this.upsertJob(job));
  }

  /**
   * Picking a model in a view pre-loads and warms it, but only when the queue is empty and it isn't
   * already the resident model. voice: optional voice id to pre-encode (fast).
   */
  warmIfIdle(key, voice) {
    // Debounced: flipping through views or models quickly only warms the last pick, instead of
    // loading (and evicting) a 25 GB model per click.
    clearTimeout(this._warmTimer);
    this._warmTimer = setTimeout(() => {
      if (!key || !this.idle) return;
      if (this.status.key === key && this.status.state === "ready" && !voice) return;
      api.warm(key, voice).catch(() => {});
    }, 1200);
  }

  /**
   * Ask the workflow view to load a saved request ("open in editor" / "regenerate with this seed").
   * The view picks it up from the "recipe" event or from takeRecipe() when it activates.
   */
  openRecipe(workflow, request) {
    this.pendingRecipe = { workflow, request };
    location.hash = `#/${workflow}`;
    this.emit("recipe", this.pendingRecipe);
  }

  takeRecipe(workflow) {
    if (this.pendingRecipe?.workflow !== workflow) return null;
    const r = this.pendingRecipe.request;
    this.pendingRecipe = null;
    return r;
  }
}

export const store = new Store();
