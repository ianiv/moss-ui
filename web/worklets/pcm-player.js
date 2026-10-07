// AudioWorkletProcessor "pcm-player": gapless playback of mono float32 PCM pushed from the main
// thread (used by <moss-stream-player> for live streaming jobs).
//
// The context runs at the stream's sample rate, so no resampling happens here.
//
// Messages in (port.postMessage):
//   {type: "push", samples: Float32Array}  append samples (send the buffer as a transferable)
//   {type: "end"}                          the server stream is finished; drain what's buffered
//   {type: "reset"}                        drop everything buffered
// Messages out:
//   {type: "first", frame}                 first real sample was just output (frame = currentFrame)
//   {type: "stats", played, buffered, received, peak, playing, underruns}  ~10x per second
//   {type: "drained", played, underruns}   after "end", once the buffer is empty (sent once)
// processorOptions: {prebuffer: frames to collect before (re)starting, default 0.15 s}

class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.prebuffer = Math.max(0, opts.prebuffer ?? Math.round(sampleRate * 0.15));
    // Growable ring buffer.
    this.buf = new Float32Array(Math.max(1 << 16, this.prebuffer * 4));
    this.read = 0;
    this.write = 0;
    this.count = 0;

    this.received = 0;
    this.played = 0;
    this.ended = false;
    this.waiting = true; // jitter buffer: hold output until `prebuffer` frames are queued
    this.started = false;
    this.drained = false;
    this.underruns = 0;
    this.peak = 0;
    this.statsEvery = Math.round(sampleRate / 10);
    this.sinceStats = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.type === "push" && msg.samples?.length) this.push(msg.samples);
    else if (msg.type === "end") this.ended = true;
    else if (msg.type === "reset") {
      this.read = this.write = this.count = 0;
      this.waiting = true;
    }
  }

  push(samples) {
    const n = samples.length;
    if (this.count + n > this.buf.length) this.grow(this.count + n);
    const cap = this.buf.length;
    const first = Math.min(n, cap - this.write);
    this.buf.set(samples.subarray(0, first), this.write);
    if (first < n) this.buf.set(samples.subarray(first), 0);
    this.write = (this.write + n) % cap;
    this.count += n;
    this.received += n;
  }

  grow(min) {
    let cap = this.buf.length * 2;
    while (cap < min) cap *= 2;
    const next = new Float32Array(cap);
    // Unroll the ring into the start of the new buffer.
    const first = Math.min(this.count, this.buf.length - this.read);
    next.set(this.buf.subarray(this.read, this.read + first), 0);
    if (first < this.count) next.set(this.buf.subarray(0, this.count - first), first);
    this.buf = next;
    this.read = 0;
    this.write = this.count;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    if (!ch0) return true;
    const frames = ch0.length;

    if (this.waiting && (this.count >= this.prebuffer || (this.ended && this.count > 0))) this.waiting = false;

    let n = 0;
    if (!this.waiting) {
      n = Math.min(frames, this.count);
      const cap = this.buf.length;
      const first = Math.min(n, cap - this.read);
      ch0.set(this.buf.subarray(this.read, this.read + first), 0);
      if (first < n) ch0.set(this.buf.subarray(0, n - first), first);
      this.read = (this.read + n) % cap;
      this.count -= n;
      for (let i = 0; i < n; i++) {
        const v = ch0[i] < 0 ? -ch0[i] : ch0[i];
        if (v > this.peak) this.peak = v;
      }
      if (n > 0 && !this.started) {
        this.started = true;
        this.port.postMessage({ type: "first", frame: currentFrame });
      }
      this.played += n;
      if (n < frames && !this.ended) {
        // Starved mid-stream: output silence and re-collect a small cushion before resuming.
        this.underruns++;
        this.waiting = true;
      }
    }
    if (n < frames) ch0.fill(0, n);
    for (let c = 1; c < out.length; c++) out[c].set(ch0);

    this.sinceStats += frames;
    if (this.sinceStats >= this.statsEvery) {
      this.sinceStats = 0;
      this.port.postMessage({
        type: "stats",
        played: this.played,
        buffered: this.count,
        received: this.received,
        peak: this.peak,
        playing: !this.waiting && this.count > 0,
        underruns: this.underruns,
      });
      this.peak = 0;
    }

    if (this.ended && this.count === 0 && !this.drained) {
      this.drained = true;
      this.port.postMessage({ type: "drained", played: this.played, underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);
