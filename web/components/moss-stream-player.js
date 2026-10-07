// <moss-stream-player>: live playback of a streaming (fast model) job's PCM through an AudioWorklet.
//
// Public API
//   prime()                 Call synchronously from the Generate click/submit handler, before any await:
//                           creates an AudioContext({sampleRate: 48000, latencyHint: "interactive"}) inside
//                           the user gesture and starts loading the "pcm-player" worklet. Starts the
//                           first-audio clock. Doesn't touch a stream that is already playing.
//   play(jobId, sampleRate?) -> Promise
//                           Stops any current stream, then fetches GET /api/jobs/{id}/pcm and plays it.
//                           sampleRate defaults to the response's X-Sample-Rate header (the header wins when
//                           they differ); the context is recreated when its rate doesn't match. Resolves when
//                           the network stream ends (playback may still be draining).
//   stop()                  Stop playback: aborts the fetch and closes the AudioContext. Does NOT cancel the job.
//   playing (getter)        true while a stream is connected or audio is still draining.
// Events (bubbling, composed): `stream-start` {jobId, sampleRate} when the PCM response connects;
//   `stream-end` {jobId, reason: "drained"|"stopped"|"error", seconds, firstAudio, error?}.
// The element is hidden until play() is called; after the stream ends it shows a summary with a close button.
// Shows a "Live" badge with a pulsing dot, seconds received vs played, a rolling level meter, the
// first-audio latency (prime() -> first sample out) and a Stop button.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, fmtSeconds, emit } from "../lib/dom.js";
import { api } from "../lib/api.js";

const WORKLET_URL = new URL("../worklets/pcm-player.js", import.meta.url);
const DEFAULT_RATE = 48000;
const PREBUFFER_S = 0.15;
const PRIME_TTL_MS = 60_000; // close a primed context nobody used (e.g. the submit failed)
const BARS = 64;

const styles = css`
  :host { display: block; }
  :host(:not([active])) { display: none; }
  .box { display: grid; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
  :host([state=live]) .box, :host([state=buffering]) .box { border-color: var(--accent); }
  .top { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .live { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: var(--fs-sm); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-3); flex: none; }
  :host([state=live]) .dot { background: var(--danger); animation: pulse 1.1s infinite; }
  :host([state=buffering]) .dot, :host([state=connecting]) .dot { background: var(--warn); animation: pulse 1.1s infinite; }
  :host([state=done]) .dot { background: var(--ok); }
  :host([state=error]) .dot { background: var(--danger); }
  canvas { width: 100%; height: 32px; display: block; color: var(--accent); }
  .meta { display: flex; gap: var(--sp-3); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-2); font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
`;

const STATE_TEXT = {
  connecting: "Connecting…",
  buffering: "Buffering…",
  live: "Live",
  done: "Finished",
  stopped: "Stopped",
  error: "Stream failed",
};

class MossStreamPlayer extends MossElement {
  static styles = [styles];

  constructor() {
    super();
    this._primed = null; // {ctx, ready, at, timer}
    this._cur = null; // current playback session
    this._levels = new Float32Array(BARS);
  }

  render() {
    this.setHTML(html`
      <div class="box" role="region" aria-label="Live stream">
        <div class="top">
          <span class="live"><span class="dot"></span><span id="state">Live</span></span>
          <span class="meta" aria-live="off">
            <span id="recv"></span><span id="played"></span><span id="first"></span>
          </span>
          <span class="spacer"></span>
          <button id="stop" class="small" type="button" aria-label="Stop live playback">${icon("stop", 14)} Stop</button>
          <button id="close" class="ghost icon small" type="button" aria-label="Hide live player" hidden>${icon("x", 14)}</button>
        </div>
        <canvas aria-hidden="true"></canvas>
        <div class="error" id="err" hidden></div>
      </div>
    `);
    this.$("#stop").addEventListener("click", () => this.stop());
    this.$("#close").addEventListener("click", () => this.removeAttribute("active"));
  }

  disconnected() {
    this.stop();
    this._closePrimed();
  }

  get playing() {
    return !!this._cur && !this._cur.finished;
  }

  /** Create/resume the AudioContext inside the user gesture and start loading the worklet. Sync. */
  prime(sampleRate = DEFAULT_RATE) {
    this._closePrimed();
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
    } catch (e) {
      console.warn("moss-stream-player: AudioContext failed", e);
      return;
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const ready = ctx.audioWorklet.addModule(WORKLET_URL);
    ready.catch(() => {}); // awaited (and reported) in play()
    const timer = setTimeout(() => {
      if (this._primed?.ctx === ctx) this._closePrimed();
    }, PRIME_TTL_MS);
    this._primed = { ctx, ready, at: performance.now(), timer };
  }

  _closePrimed() {
    const p = this._primed;
    if (!p) return;
    this._primed = null;
    clearTimeout(p.timer);
    p.ctx.close().catch(() => {});
  }

  /** Take the primed context if its rate matches, else make a new one (may start suspended without a gesture). */
  _takeContext(rate) {
    let p = this._primed;
    this._primed = null;
    if (p) clearTimeout(p.timer);
    if (p && p.ctx.sampleRate !== rate) {
      const at = p.at;
      p.ctx.close().catch(() => {});
      p = null;
      this.prime(rate);
      p = this._primed;
      this._primed = null;
      if (p) {
        clearTimeout(p.timer);
        p.at = at; // keep the first-audio clock from the original click
      }
    }
    if (!p) {
      this.prime(rate);
      p = this._primed;
      this._primed = null;
      if (p) clearTimeout(p.timer);
    }
    if (!p) throw new Error("Web Audio isn't available in this browser");
    if (p.ctx.state === "suspended") p.ctx.resume().catch(() => {});
    return p;
  }

  async play(jobId, sampleRate) {
    this.stop();
    const abort = new AbortController();
    const cur = {
      jobId, abort, ctx: null, node: null, finished: false, received: 0, played: 0, rate: sampleRate || DEFAULT_RATE,
      primeAt: this._primed?.at ?? performance.now(), firstAudio: null,
    };
    this._cur = cur;
    this._levels.fill(0);
    this.setAttribute("active", "");
    this.$("#err").hidden = true;
    this.$("#stop").hidden = false;
    this.$("#close").hidden = true;
    this._setState("connecting");
    this._updateMeta();
    this._draw();

    try {
      const res = await api.pcm(jobId, abort.signal);
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          msg = JSON.parse(await res.text()).error || msg;
        } catch {}
        throw new Error(msg);
      }
      const headerRate = parseInt(res.headers.get("X-Sample-Rate"), 10);
      const rate = headerRate > 0 ? headerRate : sampleRate || DEFAULT_RATE;
      cur.rate = rate;
      if (!this._alive(cur)) return;

      const p = this._takeContext(rate);
      cur.ctx = p.ctx;
      cur.primeAt = Math.min(cur.primeAt, p.at);
      await p.ready;
      if (!this._alive(cur)) return;

      const node = new AudioWorkletNode(cur.ctx, "pcm-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { prebuffer: Math.round(rate * PREBUFFER_S) },
      });
      node.port.onmessage = (e) => this._onWorklet(cur, e.data);
      node.connect(cur.ctx.destination);
      cur.node = node;
      this._setState("buffering");
      emit(this, "stream-start", { jobId, sampleRate: rate });

      await this._pump(cur, res.body.getReader());
    } catch (e) {
      if (!this._alive(cur) || e?.name === "AbortError") return;
      this._finish(cur, "error", e?.message || String(e));
    }
  }

  /** Read the close-delimited body, re-aligning to 4-byte float boundaries across network chunks. */
  async _pump(cur, reader) {
    let carry = null; // 0-3 leftover bytes from the previous chunk
    for (;;) {
      const { value, done } = await reader.read();
      if (!this._alive(cur)) {
        reader.cancel().catch(() => {});
        return;
      }
      if (done) break;
      if (!value?.length) continue;
      let bytes = value;
      if (carry) {
        bytes = new Uint8Array(carry.length + value.length);
        bytes.set(carry, 0);
        bytes.set(value, carry.length);
        carry = null;
      }
      const usable = bytes.length - (bytes.length % 4);
      if (usable < bytes.length) carry = bytes.slice(usable);
      if (!usable) continue;
      // Copy into a fresh, aligned buffer we can transfer to the worklet. (Data is little-endian;
      // every platform Safari/Chrome run on here is little-endian too.)
      const samples = new Float32Array(usable / 4);
      new Uint8Array(samples.buffer).set(bytes.subarray(0, usable));
      cur.received += samples.length;
      cur.node.port.postMessage({ type: "push", samples }, [samples.buffer]);
      this._updateMeta();
    }
    if (!this._alive(cur)) return;
    cur.node.port.postMessage({ type: "end" });
    if (cur.received === 0) this._finish(cur, "drained");
  }

  _alive(cur) {
    return this._cur === cur && !cur.finished;
  }

  _onWorklet(cur, msg) {
    if (!this._alive(cur) || !msg) return;
    if (msg.type === "first") {
      cur.firstAudio = (performance.now() - cur.primeAt) / 1000 + (cur.ctx?.outputLatency || cur.ctx?.baseLatency || 0);
      this._setState("live");
      this._updateMeta();
    } else if (msg.type === "stats") {
      cur.played = msg.played;
      cur.underruns = msg.underruns;
      this._levels.copyWithin(0, 1);
      this._levels[BARS - 1] = msg.peak;
      if (cur.firstAudio != null) this._setState(msg.playing || msg.buffered > 0 ? "live" : "buffering");
      this._updateMeta();
      this._draw();
    } else if (msg.type === "drained") {
      cur.played = msg.played;
      this._finish(cur, "drained");
    }
  }

  _finish(cur, reason, error) {
    if (cur.finished) return;
    cur.finished = true;
    cur.abort.abort();
    try {
      cur.node?.disconnect();
    } catch {}
    cur.ctx?.close().catch(() => {});
    this._setState(reason === "drained" ? "done" : reason === "stopped" ? "stopped" : "error");
    this.$("#stop").hidden = true;
    this.$("#close").hidden = false;
    if (error) {
      const err = this.$("#err");
      err.textContent = error;
      err.hidden = false;
    }
    this._updateMeta();
    emit(this, "stream-end", {
      jobId: cur.jobId,
      reason,
      seconds: cur.played / cur.rate,
      firstAudio: cur.firstAudio,
      ...(error ? { error } : {}),
    });
  }

  /** Stop playback (aborts the fetch and closes the context). The job itself keeps running. */
  stop() {
    const cur = this._cur;
    if (cur && !cur.finished) this._finish(cur, "stopped");
  }

  _setState(state) {
    if (this._cur) this._cur.state = state;
    this.setAttribute("state", state);
    this.$("#state").textContent = STATE_TEXT[state] || state;
  }

  _updateMeta() {
    const cur = this._cur;
    if (!cur) return;
    const r = cur.rate || DEFAULT_RATE;
    this.$("#recv").textContent = `Received ${fmtSeconds(cur.received / r)}`;
    this.$("#played").textContent = `played ${fmtSeconds(cur.played / r)}`;
    this.$("#first").textContent = cur.firstAudio != null ? `first audio after ${cur.firstAudio.toFixed(2)} s` : "";
  }

  _draw() {
    const canvas = this.$("canvas");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cs = getComputedStyle(canvas);
    const accent = cs.getPropertyValue("--accent").trim() || "#2f6f5e";
    const faint = cs.getPropertyValue("--border").trim() || "#ddd";
    const bar = w / BARS;
    for (let i = 0; i < BARS; i++) {
      const v = Math.min(1, this._levels[i]);
      const bh = Math.max(1.5, Math.sqrt(v) * (h - 2)); // sqrt: quiet speech still visible
      g.fillStyle = v > 0.001 ? accent : faint;
      g.fillRect(i * bar + bar * 0.15, (h - bh) / 2, Math.max(1, bar * 0.7), bh);
    }
  }
}

define("moss-stream-player", MossStreamPlayer);
