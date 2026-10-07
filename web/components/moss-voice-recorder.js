// <moss-voice-recorder>: create a reference voice for the library.
//
// Flow: record from the microphone (MediaRecorder, level meter + timer) or drop/choose an audio file ->
// decode into an AudioBuffer -> pick the region to keep in a selectable <moss-waveform-player> (defaults
// to the whole clip, or the first 15 s of a long one) -> optional loudness normalize -> name, description,
// transcript ("Transcribe" runs Whisper on the trimmed audio) -> "Save voice" creates the voice and uploads
// the trimmed WAV.
//
// Public API
//   Attributes: `compact` (tighter layout for inline use, e.g. in the cloning view).
//   Methods:    reset()        stop any recording, discard the take and clear the form.
//   Props:      hasContent     (read-only) true while recording or while a take is loaded (used by hosts to
//                              confirm before discarding).
//   Events:     `voice-saved` {voice} (bubbling, composed) after the voice was created and its audio uploaded.
//
// What gets uploaded is always a 16-bit mono WAV of the selected region (trimBuffer via OfflineAudioContext,
// then normalize(-1 dBFS) when checked, then encodeWav), never the raw recording.
import { MossElement, define } from "../lib/element.js";
import { css, html, icon, emit, toast, fmtClock } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { audioContext, decodeBlob, trimBuffer, normalize, encodeWav } from "../lib/audio.js";
import "./moss-waveform-player.js";

const MAX_RECORD_S = 120;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

const styles = css`
  :host { display: block; }
  .drop {
    border: 1.5px dashed var(--border-strong); border-radius: var(--radius-lg); padding: var(--sp-5) var(--sp-4);
    display: grid; gap: var(--sp-3); justify-items: center; text-align: center; background: var(--surface);
    transition: background var(--dur), border-color var(--dur);
  }
  .drop.over { border-color: var(--accent); background: var(--accent-soft); }
  :host([compact]) .drop { padding: var(--sp-3); gap: var(--sp-2); }
  .recording { border: 1px solid var(--accent); border-radius: var(--radius-lg); padding: var(--sp-3) var(--sp-4); background: var(--surface); display: grid; gap: var(--sp-2); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); animation: pulse 1s infinite; flex: none; }
  .time { font-variant-numeric: tabular-nums; min-width: 3.5em; font-weight: 600; }
  .meter { flex: 1 1 120px; min-width: 80px; height: 8px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
  .level { height: 100%; width: 100%; background: var(--ok); transform-origin: left center; transform: scaleX(0); transition: transform 60ms linear; }
  .level.hot { background: var(--danger); }
  .sel { font-variant-numeric: tabular-nums; }
  form.edit { display: grid; gap: var(--sp-3); }
  :host([compact]) form.edit { gap: var(--sp-2); }
  .opt { font-weight: 400; color: var(--text-3); }
  .busy { display: inline-flex; gap: 6px; align-items: center; }
`;

/** Friendly message for getUserMedia / MediaRecorder failures. */
function micError(e) {
  switch (e?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was blocked. Allow the microphone for this site in your browser's settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone found. Connect one, or upload a file instead.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is busy or unavailable (another app may be using it).";
    default:
      return `Couldn't start recording: ${e?.message || e}`;
  }
}

class MossVoiceRecorder extends MossElement {
  static styles = [styles];

  render() {
    this.setHTML(html`
      <div class="pick">
        <div class="drop" id="drop">
          <div class="row" style="justify-content:center">
            <button type="button" class="primary" id="rec">${icon("mic")} Record</button>
            <span class="faint small">or</span>
            <button type="button" id="choose">${icon("upload")} Choose a file</button>
            <input type="file" id="file" accept="audio/*" hidden>
          </div>
          <p class="hint">Or drop an audio file here. 5–15 s of clean speech from a single speaker works best.</p>
        </div>
      </div>
      <div class="recording" hidden role="group" aria-label="Recording">
        <div class="row">
          <span class="dot" aria-hidden="true"></span>
          <span class="time mono" role="timer" aria-live="off">0:00</span>
          <div class="meter" role="meter" aria-label="Input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="level"></div></div>
          <button type="button" class="danger" id="stop">${icon("stop", 14)} Stop</button>
          <button type="button" class="ghost" id="cancel-rec">Cancel</button>
        </div>
        <p class="hint">Speak naturally in a quiet room, mouth about a hand's width from the mic. Stops automatically at ${fmtClock(MAX_RECORD_S)}.</p>
      </div>
      <p class="muted small decoding" hidden><span class="spinner"></span> Decoding audio…</p>
      <form class="edit" hidden novalidate>
        <moss-waveform-player selectable label="Reference take"></moss-waveform-player>
        <div class="row between">
          <span class="small sel muted"></span>
          <span class="row">
            <span class="badge guide"></span>
            <button type="button" class="ghost small" id="whole">Use whole clip</button>
          </span>
        </div>
        <p class="hint">Drag across the waveform to choose the part to keep.</p>
        <label class="check"><input type="checkbox" id="normalize" checked> Normalize loudness (peak at −1 dBFS)</label>
        <div class="field">
          <label for="name">Name</label>
          <input id="name" required autocomplete="off" placeholder="e.g. Ana, warm narrator">
        </div>
        <div class="field">
          <label for="desc">Description <span class="opt">(optional)</span></label>
          <input id="desc" autocomplete="off" placeholder="e.g. Calm female voice, slight Spanish accent">
        </div>
        <div class="field">
          <div class="row between">
            <label for="transcript">Transcript</label>
            <button type="button" class="small" id="transcribe">${icon("wave", 14)} Transcribe</button>
          </div>
          <textarea id="transcript" rows="3" placeholder="Exactly what is said in the selected part"></textarea>
          <p class="hint">Whisper large-v3-turbo; check and correct it. Needed for Continue mode, nano and dialogue.</p>
        </div>
        <div class="error form-error" role="alert" hidden></div>
        <div class="row end">
          <button type="button" class="ghost" id="restart">Start over</button>
          <button type="submit" class="primary" id="save">${icon("save", 14)} Save voice</button>
        </div>
      </form>
      <div class="error pick-error" role="alert" hidden></div>
    `);

    this.player = this.$("moss-waveform-player");
    this.state = "pick";
    this.buffer = null;
    this.region = null;
    this.source = "upload";
    this._wavCache = null;

    const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    if (!canRecord) {
      this.$("#rec").disabled = true;
      this.$("#rec").title = "Recording needs a browser with MediaRecorder on localhost or HTTPS";
    }

    this.$("#rec").addEventListener("click", () => this.startRecording());
    this.$("#stop").addEventListener("click", () => this.stopRecording());
    this.$("#cancel-rec").addEventListener("click", () => this.stopRecording(true));
    this.$("#choose").addEventListener("click", () => this.$("#file").click());
    this.$("#file").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (f) this.loadFile(f);
    });

    const drop = this.$("#drop");
    drop.addEventListener("dragover", (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", (e) => {
      if (!drop.contains(e.relatedTarget)) drop.classList.remove("over");
    });
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer?.files?.[0];
      if (f) this.loadFile(f);
    });

    this.player.addEventListener("region-change", (e) => {
      const r = e.detail?.region;
      this.setRegion(r && r.end > r.start ? r : null, false);
    });
    this.$("#whole").addEventListener("click", () => this.setRegion(null, true));
    this.$("#normalize").addEventListener("change", () => (this._wavCache = null));
    this.$("#transcribe").addEventListener("click", () => this.transcribe());
    this.$("#restart").addEventListener("click", () => this.reset());
    this.$("form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.save();
    });
    this.$("#name").addEventListener("input", () => this.showError(""));
  }

  disconnected() {
    // Never leave the microphone open when the element leaves the page.
    this.stopRecording(true);
  }

  get hasContent() {
    return this.state === "recording" || this.state === "decoding" || this.state === "edit";
  }

  // ----- UI state -----

  setState(state) {
    this.state = state;
    this.$(".pick").hidden = state !== "pick";
    this.$(".recording").hidden = state !== "recording";
    this.$(".decoding").hidden = state !== "decoding";
    this.$("form").hidden = state !== "edit";
    if (state !== "pick") this.$(".pick-error").hidden = true;
  }

  pickError(msg) {
    const el = this.$(".pick-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  showError(msg) {
    const el = this.$(".form-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  /** Stop recording, discard everything and go back to the record/upload choice. */
  reset() {
    this.stopRecording(true);
    this._decodeToken = (this._decodeToken || 0) + 1;
    try {
      this.player.stop?.();
    } catch {}
    this.player.removeAttribute("src");
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = null;
    clearInterval(this._regionPoll);
    this.buffer = null;
    this.region = null;
    this._wavCache = null;
    for (const id of ["#name", "#desc", "#transcript"]) this.$(id).value = "";
    this.$("#normalize").checked = true;
    this.showError("");
    this.pickError("");
    this.setState("pick");
  }

  // ----- recording -----

  async startRecording() {
    if (this.state === "recording") return;
    this.pickError("");
    // Create/resume the shared AudioContext synchronously inside the click (user-gesture rule).
    let ctx = null;
    try {
      ctx = audioContext();
    } catch {}
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      this.pickError(micError(e));
      return;
    }
    const mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
    let rec;
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      this.pickError(micError(e));
      return;
    }
    const chunks = [];
    const r = (this.rec = { stream, recorder: rec, chunks, discard: false, started: performance.now() });
    rec.addEventListener("dataavailable", (e) => e.data?.size && chunks.push(e.data));
    rec.addEventListener("stop", () => this.onRecorderStop(r));
    rec.addEventListener("error", (e) => {
      this.pickError(micError(e.error || e));
      this.stopRecording(true);
    });

    // Level meter: analyser on the shared context (not connected to the speakers).
    if (ctx) {
      try {
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        this.rec.src = src;
        this.rec.analyser = analyser;
        this.rec.data = new Float32Array(analyser.fftSize);
      } catch {}
    }

    rec.start(250);
    this.setState("recording");
    this.$(".time").textContent = "0:00";
    this.$("#stop").focus();
    this.tick();
  }

  tick() {
    const r = this.rec;
    if (!r) return;
    const elapsed = (performance.now() - r.started) / 1000;
    this.$(".time").textContent = fmtClock(elapsed);
    if (r.analyser) {
      r.analyser.getFloatTimeDomainData(r.data);
      let peak = 0;
      for (const v of r.data) peak = Math.max(peak, Math.abs(v));
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      const level = Math.max(0, Math.min(1, (db + 60) / 60)); // -60..0 dBFS -> 0..1
      const bar = this.$(".level");
      bar.style.transform = `scaleX(${level})`;
      bar.classList.toggle("hot", peak > 0.98);
      this.$(".meter").setAttribute("aria-valuenow", Math.round(level * 100));
    }
    if (elapsed >= MAX_RECORD_S) {
      this.stopRecording();
      return;
    }
    r.raf = requestAnimationFrame(() => this.tick());
  }

  /** Stop the recorder and release the mic. discard=true throws the audio away. */
  stopRecording(discard = false) {
    const r = this.rec;
    if (!r) return;
    r.discard = r.discard || discard;
    cancelAnimationFrame(r.raf);
    try {
      r.src?.disconnect();
    } catch {}
    if (r.recorder.state !== "inactive") {
      try {
        r.recorder.stop(); // the "stop" handler builds the blob and releases the tracks
        if (discard) {
          // Release the mic right away; a later Record must not be confused with this one.
          r.done = true;
          r.stream.getTracks().forEach((t) => t.stop());
          this.rec = null;
          if (this.state === "recording") this.setState("pick");
        }
        return;
      } catch {}
    }
    this.onRecorderStop(r);
  }

  onRecorderStop(r) {
    if (!r || r.done) return;
    r.done = true;
    if (this.rec === r) this.rec = null;
    r.stream.getTracks().forEach((t) => t.stop());
    if (r.discard) {
      if (this.state === "recording") this.setState("pick");
      return;
    }
    const blob = new Blob(r.chunks, { type: r.recorder.mimeType || r.chunks[0]?.type || "audio/webm" });
    if (!blob.size) {
      this.setState("pick");
      this.pickError("Nothing was recorded. Check that the right microphone is selected.");
      return;
    }
    this.loadBlob(blob, "record");
  }

  // ----- loading a take -----

  loadFile(file) {
    if (this.state === "recording") return;
    if (file.type && !/^(audio|video)\//.test(file.type)) {
      this.pickError(`"${file.name}" doesn't look like an audio file.`);
      return;
    }
    const base = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    this.loadBlob(file, "upload", base);
  }

  async loadBlob(blob, source, suggestedName = "") {
    const token = (this._decodeToken = (this._decodeToken || 0) + 1);
    this.pickError("");
    this.setState("decoding");
    let buffer;
    try {
      buffer = await decodeBlob(blob);
    } catch (e) {
      if (token !== this._decodeToken) return;
      this.setState("pick");
      this.pickError(
        source === "record"
          ? `Couldn't decode the recording (${e.message || e}). Try again, or upload a file.`
          : "Couldn't decode this file. Try WAV, MP3, M4A, FLAC or OGG.",
      );
      return;
    }
    if (token !== this._decodeToken) return;
    if (!buffer.duration || buffer.duration < 0.3) {
      this.setState("pick");
      this.pickError("That clip is too short to use as a reference.");
      return;
    }
    this.buffer = buffer;
    this.source = source;
    this._wavCache = null;
    if (suggestedName && !this.$("#name").value) this.$("#name").value = suggestedName;

    // The player gets a WAV of the full decoded take: reliable duration/seeking (MediaRecorder webm has none).
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = URL.createObjectURL(encodeWav(buffer));
    this.player.setAttribute("src", this._url);
    this.setState("edit");

    const d = buffer.duration;
    this.setRegion(d <= 20 ? null : { start: 0, end: 15 }, true);
    // Re-apply the default region once the player knows the clip's duration (it decodes asynchronously).
    clearInterval(this._regionPoll);
    let tries = 0;
    this._regionPoll = setInterval(() => {
      if (++tries > 100 || token !== this._decodeToken) return clearInterval(this._regionPoll);
      if (this.player.duration > 0) {
        clearInterval(this._regionPoll);
        if (this.region && (this.region.start > 0 || this.region.end < d - 0.01)) this.player.region = { ...this.region };
      }
    }, 100);
    (this.$("#name").value ? this.$("#transcribe") : this.$("#name")).focus?.();
  }

  /** region null = whole clip. push=true also sends it to the player. */
  setRegion(region, push) {
    if (!this.buffer) return;
    const d = this.buffer.duration;
    const r = region ? { start: Math.max(0, region.start), end: Math.min(d, region.end) } : { start: 0, end: d };
    this.region = r;
    this._wavCache = null;
    if (push) {
      try {
        this.player.region = region ? { ...r } : null;
      } catch {}
    }
    const len = r.end - r.start;
    const whole = r.start <= 0.01 && r.end >= d - 0.01;
    this.$(".sel").textContent = whole
      ? `Whole clip · ${len.toFixed(1)} s`
      : `Selection ${r.start.toFixed(1)}–${r.end.toFixed(1)} s · ${len.toFixed(1)} s of ${d.toFixed(1)} s`;
    const guide = this.$(".guide");
    const ok = len >= 5 && len <= 15;
    guide.className = `badge guide ${ok ? "accent" : "warn"}`;
    guide.textContent = ok ? "5–15 s works best ✓" : len < 5 ? "Short: 5–15 s works best" : len > 30 ? "Long: trim to 5–15 s" : "5–15 s works best";
    this.$("#whole").hidden = whole;
  }

  /** Trimmed (and optionally normalized) WAV of the current selection, cached per settings. */
  async wav() {
    const r = this.region || { start: 0, end: this.buffer.duration };
    const norm = this.$("#normalize").checked;
    const key = `${r.start.toFixed(3)}:${r.end.toFixed(3)}:${norm}`;
    if (this._wavCache?.key === key) return this._wavCache.blob;
    let buf = await trimBuffer(this.buffer, r.start, r.end);
    if (norm) buf = normalize(buf, -1);
    const blob = encodeWav(buf);
    this._wavCache = { key, blob };
    return blob;
  }

  // ----- transcribe / save -----

  async transcribe() {
    if (!this.buffer || this._transcribing) return;
    const btn = this.$("#transcribe");
    const label = btn.innerHTML;
    this._transcribing = true;
    btn.disabled = true;
    btn.innerHTML = `<span class="busy"><span class="spinner"></span> Transcribing…</span>`;
    this.showError("");
    try {
      const res = await api.transcribe(await this.wav());
      const text = (res?.text || "").trim();
      if (!text) toast("Whisper heard no speech in the selection", "info");
      else this.$("#transcript").value = text;
    } catch (e) {
      this.showError(`Transcription failed: ${e.message}`);
    } finally {
      this._transcribing = false;
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  async save() {
    if (!this.buffer || this._saving) return;
    const name = this.$("#name").value.trim();
    if (!name) {
      this.showError("Give the voice a name.");
      this.$("#name").focus();
      return;
    }
    const btn = this.$("#save");
    const label = btn.innerHTML;
    this._saving = true;
    btn.disabled = true;
    btn.innerHTML = `<span class="busy"><span class="spinner"></span> Saving…</span>`;
    this.showError("");
    let created = null;
    try {
      const blob = await this.wav();
      created = await api.createVoice({
        name,
        description: this.$("#desc").value.trim(),
        transcript: this.$("#transcript").value.trim(),
        source: this.source,
      });
      const voice = await api.uploadVoiceAudio(created.id, blob);
      toast(`Saved voice "${voice.name || name}"`, "ok");
      emit(this, "voice-saved", { voice });
      this.reset();
    } catch (e) {
      // Don't leave a voice without audio behind when the upload failed.
      if (created?.id) api.deleteVoice(created.id).catch(() => {});
      this.showError(`Couldn't save the voice: ${e.message}`);
    } finally {
      this._saving = false;
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
}

define("moss-voice-recorder", MossVoiceRecorder);
