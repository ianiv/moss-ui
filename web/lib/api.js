// Thin wrapper over the moss-ui server API (see backend/server.py). All methods return parsed JSON
// or throw ApiError with the server's message.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, { json, body, type, signal } = {}) {
  const init = { method, signal, headers: {} };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    init.body = body;
    init.headers["Content-Type"] = type || body.type || "application/octet-stream";
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the moss-ui server. Is it still running?");
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `${res.status} ${res.statusText}`);
  return data;
}

const enc = encodeURIComponent;
const tid = (id) => String(id).split("/").map(enc).join("/");
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, v === true ? "1" : v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  // models
  models: () => request("GET", "/api/models"),
  /** Load + warm a model (optionally pre-encode a voice for it). */
  warm: (key, voice) => request("POST", `/api/models/${enc(key)}/warm`, { json: voice ? { voice } : {} }),
  unload: () => request("DELETE", "/api/models/loaded"),

  // settings
  settings: () => request("GET", "/api/settings"),
  saveSettings: (patch) => request("PATCH", "/api/settings", { json: patch }),

  // transcripts: a Blob (audio body) or {voice} / {take}
  transcribe: (what) =>
    what instanceof Blob
      ? request("POST", "/api/transcribe", { body: what, type: what.type || "audio/wav" })
      : request("POST", "/api/transcribe", { json: what }),

  // voices
  voices: () => request("GET", "/api/voices").then((d) => d.voices),
  voice: (id) => request("GET", `/api/voices/${enc(id)}`),
  /** {name, description?, transcript?, source?, model?} -> voice */
  createVoice: (meta) => request("POST", "/api/voices", { json: meta }),
  /** Raw audio body; the server converts to mono WAV (ffmpeg for webm/opus). */
  uploadVoiceAudio: (id, blob) => request("PUT", `/api/voices/${enc(id)}/audio`, { body: blob, type: blob.type || "audio/wav" }),
  /** {name?, description?, transcript?} */
  updateVoice: (id, patch) => request("PATCH", `/api/voices/${enc(id)}`, { json: patch }),
  deleteVoice: (id) => request("DELETE", `/api/voices/${enc(id)}`),
  /** Promote a take to a voice: {take: "<workflow>/<stem>", name?, description?, transcript?} */
  voiceFromOutput: (id, body) => request("POST", `/api/voices/${enc(id)}/from-output`, { json: body }),

  // jobs
  /** {workflow, model, params, variations, seed, formats, stream} -> job */
  createJob: (req) => request("POST", "/api/jobs", { json: req }),
  jobs: () => request("GET", "/api/jobs"),
  job: (id) => request("GET", `/api/jobs/${enc(id)}`),
  cancelJob: (id) => request("DELETE", `/api/jobs/${enc(id)}`),

  /**
   * Per-job Server-Sent Events. handlers: {snapshot, queued, loading, warming, started, chunk,
   * variation_done, done, error, cancelled, any}. Closes itself after a terminal event.
   * Returns a close() function.
   */
  jobEvents(id, handlers = {}) {
    const es = new EventSource(`/api/jobs/${enc(id)}/events`);
    const types = ["snapshot", "queued", "loading", "warming", "started", "chunk", "variation_done", "done", "error", "cancelled"];
    for (const t of types) {
      es.addEventListener(t, (ev) => {
        let data = {};
        try { data = JSON.parse(ev.data); } catch {}
        handlers[t]?.(data);
        handlers.any?.(t, data);
        if (t === "done" || t === "error" || t === "cancelled") es.close();
        if (t === "snapshot" && ["done", "error", "cancelled"].includes(data.status)) es.close();
      });
    }
    return () => es.close();
  },

  /** Live PCM for a streaming (fast) job: fetch Response whose body is little-endian float32 mono. */
  pcm: (id, signal) => fetch(`/api/jobs/${enc(id)}/pcm`, { signal }),

  // history
  /** {workflow?, q?, starred?, limit?} -> takes (newest first) */
  history: (filter = {}) => request("GET", `/api/history${qs(filter)}`).then((d) => d.items),
  take: (id) => request("GET", `/api/history/${tid(id)}`),
  /** {starred?, note?} */
  patchTake: (id, patch) => request("PATCH", `/api/history/${tid(id)}`, { json: patch }),
  deleteTake: (id) => request("DELETE", `/api/history/${tid(id)}`),

  /** URL that downloads a take (format "wav" | "mp3"; mp3 is made on first request). */
  downloadUrl: (take, format = "wav") => `${format === "mp3" ? take.mp3_url : take.url}?download`,
};
