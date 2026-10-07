// <moss-waveform-player>: canvas waveform around a hidden <audio>, with seek, optional selectable
// region and loop.
//
// Attributes (reflected props): src (URL or blob: URL), compact (shorter), selectable (drag to select a
//   region; a plain click seeks; drag a region edge to adjust it; Escape clears it), loop (loop the region,
//   or the whole clip when there is no region), label (aria label).
// Props: region {start, end} in seconds or null (get/set; setting does not fire region-change),
//   duration (s), currentTime (get/set; a set before metadata is loaded is applied once it is), paused.
// Methods: play() -> Promise, pause(), toggle(), stop() (pause + back to the start / region start).
// Events (composed): region-change {region} (CustomEvent, after a drag), play, pause, ended (plain Events).
// Only one player plays at a time: on play it broadcasts window "moss-play" (detail = the player) and
// every other player pauses. Keyboard (host is focusable): Space / K toggles, ←/→ seek 1 s (Shift: 5 s),
// Home goes to the start. CSS: --wave-height sets the waveform height (56px, compact 32px).
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, fmtClock, emit } from "../lib/dom.js";
import { decodeUrl, mono, peaks, drawWave } from "../lib/audio.js";

const styles = css`
  :host { display: block; --wave-height: 56px; border-radius: var(--radius); outline: none; min-width: 0; }
  :host([compact]) { --wave-height: 32px; }
  :host(:focus-visible) { box-shadow: var(--focus); }
  .wrap { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  button.play {
    flex: none; width: 34px; height: 34px; padding: 0; border-radius: 50%;
    background: var(--accent); border-color: var(--accent); color: var(--accent-text);
  }
  button.play:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
  :host([compact]) button.play { width: 28px; height: 28px; }
  .wave { position: relative; flex: 1 1 auto; min-width: 0; height: var(--wave-height); cursor: pointer; touch-action: none; user-select: none; }
  :host([selectable]) .wave { cursor: crosshair; }
  .wave.edge { cursor: ew-resize; }
  canvas { display: block; width: 100%; height: 100%; }
  .hover { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--text-3); opacity: .55; pointer-events: none; }
  .msg { position: absolute; inset: 0; display: grid; place-items: center; font-size: var(--fs-xs); color: var(--text-3); pointer-events: none; }
  .msg.err { color: var(--danger); }
  .loading { position: absolute; left: 0; right: 0; top: 50%; height: 2px; translate: 0 -50%; border-radius: 1px; background: var(--wave); animation: pulse 1.2s ease-in-out infinite; }
  .time { flex: none; font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .time .total { color: var(--text-3); }
  .loopmark { flex: none; color: var(--accent); display: inline-flex; }
`;

class MossWaveformPlayer extends MossElement {
  static styles = [styles];
  static observedAttributes = ["src", "label", "loop"];

  constructor() {
    super();
    this._region = null;
    this._buffer = null;
    this._mono = null;
    this._peaks = null;
    this._peakCount = 0;
    this._pendingSeek = null;
    this._raf = 0;
    this._loadToken = 0;
    this._lastTime = 0;
    this._drag = null;
  }

  // ---- attributes / props ----------------------------------------------------------------------

  get src() { return this.getAttribute("src") || ""; }
  set src(v) { v ? this.setAttribute("src", v) : this.removeAttribute("src"); }
  get label() { return this.getAttribute("label") || ""; }
  set label(v) { v ? this.setAttribute("label", v) : this.removeAttribute("label"); }
  get loop() { return this.hasAttribute("loop"); }
  set loop(v) { this.toggleAttribute("loop", !!v); }
  get compact() { return this.hasAttribute("compact"); }
  set compact(v) { this.toggleAttribute("compact", !!v); }
  get selectable() { return this.hasAttribute("selectable"); }
  set selectable(v) { this.toggleAttribute("selectable", !!v); }

  get region() {
    return this._region ? { ...this._region } : null;
  }
  set region(r) {
    this._region = this._normRegion(r);
    this._syncLoop();
    this.draw();
  }

  get duration() {
    const d = this.audio?.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return this._buffer?.duration || 0;
  }

  get currentTime() {
    if (this._pendingSeek != null) return this._pendingSeek;
    return this.audio?.currentTime || 0;
  }
  set currentTime(t) {
    t = Math.max(0, +t || 0);
    const d = this.duration;
    if (d) t = Math.min(t, d);
    if (!this.audio || this.audio.readyState < 1) {
      this._pendingSeek = t;
    } else {
      this.audio.currentTime = t;
      this._pendingSeek = null;
    }
    this._lastTime = t;
    this.draw();
  }

  get paused() {
    return this.audio ? this.audio.paused : true;
  }

  attributeChangedCallback(name, oldV, newV) {
    if (!this._rendered || oldV === newV) return;
    if (name === "src") this._load();
    else if (name === "label") this._applyLabel();
    else if (name === "loop") this._syncLoop();
  }

  // ---- rendering --------------------------------------------------------------------------------

  render() {
    this.setHTML(html`
      <div class="wrap">
        <button class="play" type="button" aria-label="Play">${icon("play", 16)}</button>
        <div class="wave" part="wave">
          <canvas aria-hidden="true"></canvas>
          <div class="hover" hidden></div>
          <div class="loading" hidden></div>
          <div class="msg" hidden></div>
        </div>
        <span class="loopmark" hidden title="Looping">${icon("loop", 14)}</span>
        <span class="time" aria-live="off"><span class="cur">0:00</span> <span class="total">/ 0:00</span></span>
      </div>
      <audio preload="metadata" hidden></audio>
    `);
    this.audio = this.$("audio");
    this.canvas = this.$("canvas");
    this.waveEl = this.$(".wave");
    this.btn = this.$("button.play");

    const a = this.audio;
    a.addEventListener("loadedmetadata", () => {
      if (this._pendingSeek != null) {
        a.currentTime = Math.min(this._pendingSeek, a.duration || this._pendingSeek);
        this._pendingSeek = null;
      }
      this._updateTime();
      this.draw();
    });
    a.addEventListener("play", () => {
      this._setPlayingUI(true);
      this._lastTime = a.currentTime;
      this._loopFrame();
      this.dispatchEvent(new Event("play", { bubbles: true, composed: true }));
    });
    a.addEventListener("pause", () => {
      this._setPlayingUI(false);
      cancelAnimationFrame(this._raf);
      this.draw();
      this.dispatchEvent(new Event("pause", { bubbles: true, composed: true }));
    });
    a.addEventListener("ended", () => {
      this.draw();
      this.dispatchEvent(new Event("ended", { bubbles: true, composed: true }));
    });
    a.addEventListener("seeked", () => this.draw());
    a.addEventListener("error", () => {
      if (!this.src) return;
      this._showMessage("Couldn't load audio", true);
      this.btn.disabled = true;
    });

    this.btn.addEventListener("click", () => this.toggle());

    const w = this.waveEl;
    w.addEventListener("pointerdown", (e) => this._onDown(e));
    w.addEventListener("pointermove", (e) => this._onMove(e));
    w.addEventListener("pointerup", (e) => this._onUp(e));
    w.addEventListener("pointercancel", () => (this._drag = null));
    w.addEventListener("pointerleave", () => {
      this.$(".hover").hidden = true;
      w.classList.remove("edge");
    });

    this.addEventListener("keydown", (e) => this._onKey(e));

    this._ro = new ResizeObserver(() => this._onResize());
    this._ro.observe(this.waveEl);

    this._applyLabel();
    this._syncLoop();
    this._load();
  }

  connected() {
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    if (!this.hasAttribute("role")) this.setAttribute("role", "group");
    this.on(window, "moss-play", (e) => {
      if (e.detail !== this && !this.paused) this.pause();
    });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    this.on(mq, "change", () => this.draw());
    this.draw();
  }

  disconnected() {
    cancelAnimationFrame(this._raf);
    // Moving the element (e.g. regrouping take cards) disconnects and reconnects it in the same task:
    // only stop playback when it really left the document.
    queueMicrotask(() => {
      if (!this.isConnected) this.audio?.pause();
    });
  }

  _applyLabel() {
    this.setAttribute("aria-label", this.label || "Audio player");
    this.btn?.setAttribute("aria-label", this.label ? `Play ${this.label}` : "Play");
  }

  _setPlayingUI(playing) {
    this.btn.innerHTML = String(icon(playing ? "pause" : "play", 16));
    const what = this.label ? ` ${this.label}` : "";
    this.btn.setAttribute("aria-label", `${playing ? "Pause" : "Play"}${what}`);
  }

  _showMessage(text, isError = false) {
    const m = this.$(".msg");
    m.hidden = !text;
    m.textContent = text || "";
    m.classList.toggle("err", isError);
    this.$(".loading").hidden = true;
  }

  // ---- loading ----------------------------------------------------------------------------------

  async _load() {
    const token = ++this._loadToken;
    const src = this.src;
    this.audio.pause();
    this._buffer = this._mono = this._peaks = null;
    this._peakCount = 0;
    this._pendingSeek = null;
    this._lastTime = 0;
    this.btn.disabled = !src;
    this._showMessage("");
    if (!src) {
      this.audio.removeAttribute("src");
      this.audio.load();
      this._updateTime();
      this.draw();
      return;
    }
    this.audio.src = src;
    this.$(".loading").hidden = false;
    this._updateTime();
    this.draw();
    try {
      const buf = await decodeUrl(src);
      if (token !== this._loadToken) return;
      this._buffer = buf;
      this._mono = mono(buf);
      this.$(".loading").hidden = true;
      if (this._region) this._region = this._normRegion(this._region);
      this._computePeaks(true);
      this._updateTime();
      this.draw();
    } catch (err) {
      if (token !== this._loadToken) return;
      console.warn("moss-waveform-player: decode failed", src, err);
      this._showMessage("Couldn't load audio", true);
    }
  }

  _computePeaks(force = false) {
    if (!this._mono) return;
    const w = this.waveEl.clientWidth;
    if (!w) return;
    const count = Math.max(24, Math.min(2000, Math.floor(w / 3)));
    if (!force && count === this._peakCount) return;
    this._peakCount = count;
    this._peaks = peaks(this._mono, count);
  }

  _onResize() {
    cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => {
      this._computePeaks();
      this.draw();
    });
  }

  // ---- drawing ----------------------------------------------------------------------------------

  draw() {
    this._updateTime();
    if (!this.canvas || !this.canvas.clientWidth) return; // hidden: the ResizeObserver redraws on show
    const d = this.duration;
    const region = this._region && d ? { start: this._region.start / d, end: this._region.end / d } : null;
    drawWave(this.canvas, this._peaks, { progress: d ? this.currentTime / d : 0, region });
  }

  _updateTime() {
    if (!this.btn) return;
    this.$(".cur").textContent = fmtClock(this.currentTime);
    this.$(".total").textContent = `/ ${fmtClock(this.duration)}`;
  }

  _loopFrame() {
    cancelAnimationFrame(this._raf);
    const step = () => {
      const a = this.audio;
      const r = this._region;
      const t = a.currentTime;
      if (r && this._lastTime < r.end && t >= r.end) {
        if (this.loop) a.currentTime = r.start;
        else {
          a.pause();
          a.currentTime = r.end;
        }
      }
      this._lastTime = a.currentTime;
      this.draw();
      if (!a.paused) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  _syncLoop() {
    if (!this.audio) return;
    this.audio.loop = this.loop && !this._region;
    const mark = this.$(".loopmark");
    if (mark) mark.hidden = !this.loop;
  }

  _normRegion(r) {
    if (!r || r.start == null || r.end == null) return null;
    let s = Math.max(0, Math.min(+r.start, +r.end));
    let e = Math.max(+r.start, +r.end);
    const d = this.duration;
    if (d) {
      s = Math.min(s, d);
      e = Math.min(e, d);
    }
    if (!(e - s > 0.01)) return null;
    return { start: s, end: e };
  }

  // ---- playback ---------------------------------------------------------------------------------

  play() {
    const a = this.audio;
    if (!a || !this.src) return Promise.resolve();
    if (this._pendingSeek != null && a.readyState >= 1) {
      a.currentTime = this._pendingSeek;
      this._pendingSeek = null;
    }
    const r = this._region;
    if (r && (a.currentTime < r.start - 0.001 || a.currentTime >= r.end - 0.01)) a.currentTime = r.start;
    else if (!r && a.ended) a.currentTime = 0;
    window.dispatchEvent(new CustomEvent("moss-play", { detail: this }));
    return a.play().catch((err) => {
      if (err.name !== "AbortError") {
        console.warn("moss-waveform-player: play failed", err);
        this._showMessage("Can't play this audio", true);
      }
    });
  }

  pause() {
    this.audio?.pause();
  }

  toggle() {
    return this.paused ? this.play() : this.pause();
  }

  stop() {
    this.pause();
    this.currentTime = this._region ? this._region.start : 0;
  }

  // ---- pointer / keyboard -----------------------------------------------------------------------

  _timeAt(e) {
    const rect = this.waveEl.getBoundingClientRect();
    const f = rect.width ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
    return f * this.duration;
  }

  _edgeAt(e) {
    if (!this.selectable || !this._region || !this.duration) return null;
    const rect = this.waveEl.getBoundingClientRect();
    const px = (t) => rect.left + (t / this.duration) * rect.width;
    if (Math.abs(e.clientX - px(this._region.start)) <= 6) return "start";
    if (Math.abs(e.clientX - px(this._region.end)) <= 6) return "end";
    return null;
  }

  _onDown(e) {
    if (e.button !== 0 || !this.duration) return;
    e.preventDefault();
    this.focus({ preventScroll: true });
    this.waveEl.setPointerCapture(e.pointerId);
    this._drag = { x0: e.clientX, t0: this._timeAt(e), edge: this._edgeAt(e), moved: false };
  }

  _onMove(e) {
    const hover = this.$(".hover");
    const rect = this.waveEl.getBoundingClientRect();
    hover.hidden = !this.duration;
    hover.style.left = `${Math.min(rect.width - 1, Math.max(0, e.clientX - rect.left))}px`;
    this.waveEl.classList.toggle("edge", !this._drag && !!this._edgeAt(e));
    const d = this._drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (!d.moved || !this.selectable) return;
    const t = this._timeAt(e);
    const r = this._region;
    if (d.edge === "start" && r) this._region = { start: Math.min(t, r.end - 0.02), end: r.end };
    else if (d.edge === "end" && r) this._region = { start: r.start, end: Math.max(t, r.start + 0.02) };
    else this._region = { start: Math.min(d.t0, t), end: Math.max(d.t0, t) };
    this._syncLoop();
    this.draw();
  }

  _onUp(e) {
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (this.waveEl.hasPointerCapture(e.pointerId)) this.waveEl.releasePointerCapture(e.pointerId);
    if (d.moved && this.selectable) {
      this._region = this._normRegion(this._region);
      this._syncLoop();
      const r = this._region;
      // keep the playhead inside the new region
      if (r && (this.currentTime < r.start || this.currentTime > r.end)) this.currentTime = r.start;
      this.draw();
      emit(this, "region-change", { region: this.region });
    } else if (!d.moved) {
      this.currentTime = this._timeAt(e);
      this._lastTime = this.currentTime;
    }
  }

  _onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const origin = e.composedPath()[0];
    const onButton = origin instanceof HTMLButtonElement;
    const d = this.duration;
    switch (e.key) {
      case " ":
      case "k":
        if (onButton && e.key === " ") return; // the button activates itself
        e.preventDefault();
        this.toggle();
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        if (!d) return;
        e.preventDefault();
        const step = (e.shiftKey ? 5 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        this.currentTime = Math.min(d, Math.max(0, this.currentTime + step));
        this._lastTime = this.currentTime;
        break;
      }
      case "Home":
        e.preventDefault();
        this.currentTime = this._region ? this._region.start : 0;
        break;
      case "Escape":
        if (this.selectable && this._region) {
          e.preventDefault();
          this._region = null;
          this._syncLoop();
          this.draw();
          emit(this, "region-change", { region: null });
        }
        break;
    }
  }
}

define("moss-waveform-player", MossWaveformPlayer);
