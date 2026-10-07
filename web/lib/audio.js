// Web Audio helpers: decoding, waveform peaks + drawing, trimming (OfflineAudioContext),
// normalizing and WAV encoding. Shared by the waveform player, recorder and stream player.

let _ctx = null;
/** Shared realtime AudioContext (create/resume only from a user gesture). */
export function audioContext() {
  if (!_ctx) _ctx = new AudioContext({ latencyHint: "interactive" });
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

const decodeCache = new Map(); // url -> Promise<AudioBuffer>

/** Decode an ArrayBuffer without needing a user gesture. */
export function decodeArrayBuffer(ab) {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(ab);
}

export async function decodeBlob(blob) {
  return decodeArrayBuffer(await blob.arrayBuffer());
}

/** Fetch + decode a URL (cached; the cache keeps the last 40 URLs). */
export function decodeUrl(url) {
  if (!decodeCache.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} loading audio`);
        return r.arrayBuffer();
      })
      .then(decodeArrayBuffer);
    p.catch(() => decodeCache.delete(url));
    decodeCache.set(url, p);
    if (decodeCache.size > 40) decodeCache.delete(decodeCache.keys().next().value);
  }
  return decodeCache.get(url);
}

/** Mix to mono Float32Array. */
export function mono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

/** Peak (max |x|) per bucket, `count` buckets. Accepts an AudioBuffer or Float32Array. */
export function peaks(input, count) {
  const data = input instanceof Float32Array ? input : mono(input);
  const out = new Float32Array(count);
  const step = data.length / count;
  for (let i = 0; i < count; i++) {
    let max = 0;
    const end = Math.min(data.length, Math.floor((i + 1) * step));
    for (let j = Math.floor(i * step); j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

/**
 * Draw a bar waveform. opts: {progress 0..1, region: {start, end} as 0..1 fractions, color, playedColor, regionColor}.
 * Colors default to the CSS tokens read from the canvas element.
 */
export function drawWave(canvas, pk, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 56;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const cs = getComputedStyle(canvas);
  const color = opts.color || cs.getPropertyValue("--wave").trim() || "#9db8ae";
  const played = opts.playedColor || cs.getPropertyValue("--wave-played").trim() || "#2f6f5e";
  const regionColor = opts.regionColor || cs.getPropertyValue("--region").trim() || "rgba(47,111,94,.16)";
  if (opts.region && opts.region.end > opts.region.start) {
    g.fillStyle = regionColor;
    g.fillRect(opts.region.start * w, 0, (opts.region.end - opts.region.start) * w, h);
  }
  if (!pk || !pk.length) return;
  let max = 0;
  for (const v of pk) max = Math.max(max, v);
  const scale = max > 0 ? 1 / max : 1;
  const bar = w / pk.length;
  const progressX = (opts.progress || 0) * w;
  for (let i = 0; i < pk.length; i++) {
    const x = i * bar;
    const bh = Math.max(1.5, pk[i] * scale * (h - 4));
    g.fillStyle = x < progressX ? played : color;
    g.fillRect(x + bar * 0.15, (h - bh) / 2, Math.max(1, bar * 0.7), bh);
  }
  if (opts.progress > 0 && opts.progress < 1) {
    g.fillStyle = played;
    g.fillRect(progressX - 0.5, 0, 1, h);
  }
}

/** Cut [start, end] seconds out of a buffer (rendered through an OfflineAudioContext). Mono output. */
export async function trimBuffer(buffer, start, end) {
  start = Math.max(0, start || 0);
  end = Math.min(buffer.duration, end ?? buffer.duration);
  const length = Math.max(1, Math.round((end - start) * buffer.sampleRate));
  const ctx = new OfflineAudioContext(1, length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0, start, end - start);
  return ctx.startRendering();
}

/** Scale so the peak sits at `peakDb` dBFS (default -1). Returns a new mono AudioBuffer. */
export function normalize(buffer, peakDb = -1) {
  const data = mono(buffer);
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  const gain = max > 0 ? Math.pow(10, peakDb / 20) / max : 1;
  const out = new AudioBuffer({ length: data.length, sampleRate: buffer.sampleRate, numberOfChannels: 1 });
  const o = out.getChannelData(0);
  for (let i = 0; i < data.length; i++) o[i] = data[i] * gain;
  return out;
}

/** 16-bit PCM mono WAV Blob from an AudioBuffer or Float32Array (+ sampleRate). */
export function encodeWav(input, sampleRate) {
  const data = input instanceof Float32Array ? input : mono(input);
  const sr = input instanceof Float32Array ? sampleRate : input.sampleRate;
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
