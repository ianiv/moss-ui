"""moss-ui server: static files + REST/SSE API around moss_core, on 127.0.0.1 only.

Run through ../moss-ui (the launcher finds mlx-audio's Python). Stdlib only, plus numpy/mlx/mlx_audio.

Threads:
  - HTTP: one thread per request (ThreadingHTTPServer). Never touches MLX.
  - worker: the only thread that loads models or runs generate(). Tasks run FIFO.
  - idle monitor: asks the worker to unload after `idle_unload_minutes` without work.
"""
from __future__ import annotations

import argparse
import gc
import json
import random
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections import deque
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import moss_core as core  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CONFIG_PATH = ROOT / "config.json"
HOST = "127.0.0.1"  # localhost only, never configurable

DEFAULT_CONFIG = {
    "data_dir": "./data",
    "port": 8765,
    "warm_model": "tts",
    "idle_unload_minutes": 15,
    "download_format": "wav",
    "transcribe_model": "mlx-community/whisper-large-v3-turbo",
}
WHISPER_PROCESSOR_FALLBACK = "openai/whisper-large-v3-turbo"
MAX_UPLOAD = 200 * 1024 * 1024
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


def log(*a):
    print(f"[{datetime.now():%H:%M:%S}]", *a, file=sys.stderr, flush=True)


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------- config ----------

class Config:
    def __init__(self, overrides: dict):
        self.lock = threading.Lock()
        data = dict(DEFAULT_CONFIG)
        if CONFIG_PATH.is_file():
            try:
                data.update(json.loads(CONFIG_PATH.read_text()))
            except json.JSONDecodeError as e:
                log(f"config.json is invalid ({e}); using defaults")
        else:
            CONFIG_PATH.write_text(json.dumps(data, indent=2) + "\n")
        self.data = data
        self.overrides = {k: v for k, v in overrides.items() if v is not None}

    def get(self, key):
        with self.lock:
            return self.overrides.get(key, self.data.get(key))

    def snapshot(self) -> dict:
        with self.lock:
            out = {**self.data, **self.overrides}
        out["data_dir_resolved"] = str(self.data_dir)
        out["host"] = HOST
        out["overridden"] = sorted(self.overrides)
        return out

    @property
    def data_dir(self) -> Path:
        p = Path(str(self.get("data_dir"))).expanduser()
        return (p if p.is_absolute() else ROOT / p).resolve()

    def update(self, patch: dict) -> dict:
        allowed = {"data_dir", "port", "warm_model", "idle_unload_minutes", "download_format", "transcribe_model"}
        unknown = set(patch) - allowed
        if unknown:
            raise ApiError(400, f"unknown settings: {', '.join(sorted(unknown))}")
        clean = {}
        for k, v in patch.items():
            if k == "port":
                if not isinstance(v, int) or not 1024 <= v <= 65535:
                    raise ApiError(400, "port must be an integer between 1024 and 65535")
            elif k == "warm_model":
                if v not in (*core.MODELS, "none"):
                    raise ApiError(400, f"warm_model must be one of: {', '.join(core.MODELS)}, none")
            elif k == "idle_unload_minutes":
                if not isinstance(v, (int, float)) or v < 0:
                    raise ApiError(400, "idle_unload_minutes must be a number ≥ 0")
            elif k == "download_format":
                if v not in ("wav", "mp3"):
                    raise ApiError(400, "download_format must be wav or mp3")
            elif not isinstance(v, str) or not v.strip():
                raise ApiError(400, f"{k} must be a non-empty string")
            clean[k] = v.strip() if isinstance(v, str) else v
        with self.lock:
            self.data.update(clean)
            for k in clean:  # an explicit edit wins over a launch flag from now on
                self.overrides.pop(k, None)
            CONFIG_PATH.write_text(json.dumps(self.data, indent=2) + "\n")
        ensure_dirs()
        return self.snapshot()


CONFIG: Config  # set in main()


def data_dir() -> Path:
    return CONFIG.data_dir


def ensure_dirs():
    d = data_dir()
    for sub in ("outputs", "voices", "tmp"):
        (d / sub).mkdir(parents=True, exist_ok=True)


# ---------- event hub (global SSE) ----------

class Hub:
    """Broadcasts app-wide changes (model state, queue, voices, history) to /api/events listeners."""

    def __init__(self):
        self.cond = threading.Condition()
        self.events: deque = deque(maxlen=500)
        self.seq = 0

    def emit(self, type_: str, data):
        with self.cond:
            self.seq += 1
            self.events.append((self.seq, type_, data))
            self.cond.notify_all()

    def wait(self, after: int, timeout: float = 15.0) -> list:
        with self.cond:
            if self.seq <= after:
                self.cond.wait(timeout)
            return [e for e in self.events if e[0] > after]


HUB = Hub()


# ---------- voices ----------

VOICE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def voices_dir() -> Path:
    return data_dir() / "voices"


def voice_path(vid: str) -> Path:
    if not VOICE_ID.match(vid or ""):
        raise ApiError(400, f"invalid voice id '{vid}'")
    return voices_dir() / vid


def read_voice(vid: str) -> dict:
    d = voice_path(vid)
    meta_p = d / "voice.json"
    if not meta_p.is_file():
        raise ApiError(404, f"no voice '{vid}'")
    meta = json.loads(meta_p.read_text())
    txt = d / "transcript.txt"
    ref = d / "reference.wav"
    meta["id"] = vid
    meta["transcript"] = txt.read_text().strip() if txt.is_file() else ""
    meta["has_audio"] = ref.is_file()
    if ref.is_file():
        meta["audio_url"] = f"/files/voices/{vid}/reference.wav?v={int(ref.stat().st_mtime)}"
    else:
        meta["audio_url"] = None
    return meta


def list_voices() -> list[dict]:
    out = []
    if voices_dir().is_dir():
        for d in sorted(voices_dir().iterdir()):
            if (d / "voice.json").is_file():
                try:
                    out.append(read_voice(d.name))
                except Exception as e:  # noqa: BLE001
                    log(f"skipping voice {d.name}: {e}")
    out.sort(key=lambda v: v.get("name", v["id"]).lower())
    return out


def new_voice_id(name: str) -> str:
    base = core.slug(name, 40).replace("_", "-") or "voice"
    base = re.sub(r"[^a-z0-9-]", "", base) or "voice"
    vid, n = base, 2
    while (voices_dir() / vid).exists():
        vid = f"{base}-{n}"
        n += 1
    return vid


def write_voice_meta(vid: str, meta: dict):
    d = voice_path(vid)
    d.mkdir(parents=True, exist_ok=True)
    keep = {k: v for k, v in meta.items() if k not in ("id", "transcript", "has_audio", "audio_url")}
    (d / "voice.json").write_text(json.dumps(keep, indent=2) + "\n")


def set_transcript(vid: str, text: str | None):
    if text is None:
        return
    (voice_path(vid) / "transcript.txt").write_text(text.strip() + "\n")


def resolve_voice(vid: str) -> core.Voice:
    v = read_voice(vid)
    if not v["has_audio"]:
        raise core.RequestError(f"voice '{vid}' has no reference audio yet")
    return core.Voice(id=vid, audio=str(voice_path(vid) / "reference.wav"), transcript=v["transcript"] or None)


def to_mono_wav(src: Path, dst: Path) -> tuple[float, int]:
    """Convert any audio to mono WAV. Tries mlx_audio.audio_io, then ffmpeg (browser webm/opus etc.)."""
    import numpy as np
    from mlx_audio.audio_io import read as audio_read, write as audio_write

    try:
        audio, sr = audio_read(str(src), dtype="float32")
    except Exception as e:  # noqa: BLE001
        log(f"audio_io couldn't read {src.name} ({e}); trying ffmpeg")
        tmp = src.with_suffix(".conv.wav")
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", str(tmp)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise ApiError(415, f"couldn't decode audio: {r.stderr.strip()[-300:]}")
        audio, sr = audio_read(str(tmp), dtype="float32")
        tmp.unlink(missing_ok=True)
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if len(audio) == 0:
        raise ApiError(415, "the audio is empty")
    dst.parent.mkdir(parents=True, exist_ok=True)
    audio_write(str(dst), audio, sr, format="wav")
    return len(audio) / sr, sr


def wav_info(path: Path) -> tuple[float, int]:
    import wave

    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate(), w.getframerate()


# ---------- outputs / history ----------

def outputs_dir() -> Path:
    return data_dir() / "outputs"


def unique_base(folder: Path, base: str) -> str:
    name, n = base, 2
    while (folder / f"{name}.wav").exists() or (folder / f"{name}.json").exists():
        name = f"{base}-{n}"
        n += 1
    return name


def take_urls(rec: dict) -> dict:
    rel = rec["file"]
    rec["url"] = "/files/" + rel
    rec["mp3_url"] = "/files/" + rel[:-4] + ".mp3"
    rec["id"] = rel[len("outputs/"):-4]
    return rec


def list_history(workflow: str | None = None, q: str | None = None, starred: bool = False, limit: int = 200) -> list:
    out = []
    root = outputs_dir()
    if not root.is_dir():
        return out
    q = (q or "").lower().strip()
    for side in root.glob("*/*.json"):
        if workflow and side.parent.name != workflow:
            continue
        try:
            rec = json.loads(side.read_text())
        except Exception:  # noqa: BLE001
            continue
        if not (side.with_suffix(".wav")).is_file():
            continue
        if starred and not rec.get("starred"):
            continue
        if q:
            params = rec.get("params") or {}
            hay = " ".join(str(x or "") for x in (
                rec.get("label"), rec.get("model"), rec.get("workflow"), rec.get("note"), rec.get("seed"),
                params.get("instruction"), params.get("language"), params.get("ambient_sound"),
                " ".join(rec.get("voices") or [])))
            if not all(w in hay.lower() for w in q.split()):
                continue
        rec["file"] = side.with_suffix(".wav").relative_to(data_dir()).as_posix()
        rec["has_mp3"] = side.with_suffix(".mp3").is_file()
        out.append(take_urls(rec))
    out.sort(key=lambda r: r.get("created", ""), reverse=True)
    return out[:limit]


def history_paths(take_id: str) -> Path:
    """take_id is '<workflow>/<stem>'; returns the sidecar path."""
    m = re.match(r"^([a-z]+)/([^/]+)$", take_id or "")
    if not m or m.group(1) not in core.WORKFLOW_MODELS:
        raise ApiError(400, "invalid take id")
    side = (outputs_dir() / m.group(1) / f"{m.group(2)}.json").resolve()
    if not side.is_relative_to(outputs_dir().resolve()) or not side.is_file():
        raise ApiError(404, f"no take '{take_id}'")
    return side


def ensure_mp3(wav: Path) -> Path:
    mp3 = wav.with_suffix(".mp3")
    if not mp3.is_file() or mp3.stat().st_mtime < wav.stat().st_mtime:
        from mlx_audio.audio_io import read as audio_read

        audio, sr = audio_read(str(wav), dtype="float32")
        tmp = mp3.with_name(mp3.stem + f".{secrets.token_hex(3)}.tmp.mp3")
        core.write_audio(tmp, audio, sr, "mp3")
        tmp.replace(mp3)
    return mp3


# ---------- jobs ----------

class Job:
    def __init__(self, req: dict, items: list[core.Item]):
        self.id = "j" + secrets.token_hex(4)
        self.workflow = req["workflow"]
        self.model = req["model"]
        self.params = req.get("params") or {}
        self.variations = req["variations"]
        self.seed = req["seed"]
        self.formats = req["formats"]
        self.stream = bool(req.get("stream"))
        self.items = items
        self.created = time.time()
        self.started = None
        self.finished = None
        self.status = "queued"
        self.position = 0
        self.error = None
        self.outputs: list[dict] = []
        self.progress = {"item": 0, "variation": 0, "seconds": 0.0}
        self.estimate_s = None
        self.cancel = threading.Event()
        self.cond = threading.Condition()
        self.events: list = []
        self.pcm: list[bytes] = []
        self.pcm_done = False
        self.sample_rate = core.MODEL_INFO[self.model]["sample_rate"]

    @property
    def terminal(self) -> bool:
        return self.status in ("done", "error", "cancelled")

    def emit(self, type_: str, **data):
        with self.cond:
            self.events.append((len(self.events) + 1, type_, {**data, "job": self.id, "status": self.status}))
            if type_ in ("done", "error", "cancelled"):
                self.pcm_done = True
            self.cond.notify_all()
        HUB.emit("job", self.to_dict())

    def push_pcm(self, data: bytes):
        with self.cond:
            self.pcm.append(data)
            self.cond.notify_all()

    def to_dict(self) -> dict:
        return dict(
            id=self.id, workflow=self.workflow, model=self.model, status=self.status, position=self.position,
            created=self.created, started=self.started, finished=self.finished, variations=self.variations,
            seed=self.seed, formats=self.formats, stream=self.stream, params=self.params,
            label=self.items[0].label[:120] if self.items else "", items=len(self.items),
            progress=dict(self.progress, items=len(self.items), variations=self.variations,
                          elapsed=round(time.time() - self.started, 1) if self.started and not self.finished else None),
            estimate_s=self.estimate_s, outputs=self.outputs, error=self.error,
        )


class Worker:
    """Single thread that owns MLX: model lifetime, warm-up, jobs, transcripts."""

    def __init__(self):
        self.cond = threading.Condition()
        self.pending: deque = deque()  # tasks: dicts with kind
        self.jobs: dict[str, Job] = {}
        self.job_order: deque = deque(maxlen=100)
        self.current: dict | None = None
        self.last_activity = time.time()
        # model state
        self.key: str | None = None
        self.model = None
        self.state = "empty"
        self.state_since = time.time()
        self.load_s = None
        self.warm_s = None
        self.model_error = None
        self.codes: dict = {}
        self.rtf = {k: v["rtf"] for k, v in core.MODEL_INFO.items()}
        self.thread = threading.Thread(target=self.loop, name="mlx-worker", daemon=True)

    # ----- state reporting -----
    def snapshot(self) -> dict:
        cur = self.current
        return dict(key=self.key, state=self.state, since=self.state_since, load_s=self.load_s, warm_s=self.warm_s,
                    error=self.model_error, busy=cur is not None, task=cur["kind"] if cur else None,
                    pending=len(self.pending), rtf=self.rtf,
                    idle_unload_minutes=CONFIG.get("idle_unload_minutes"),
                    idle_for=round(time.time() - self.last_activity) if cur is None else 0)

    def set_state(self, state: str, key: str | None = None, error: str | None = None):
        self.state = state
        if key is not None or state in ("empty", "idle-unloaded"):
            self.key = key if state not in ("empty",) else None
        self.model_error = error
        self.state_since = time.time()
        HUB.emit("model", self.snapshot())

    def queue_summary(self) -> list[dict]:
        return [self.jobs[j].to_dict() for j in reversed(self.job_order) if j in self.jobs]

    # ----- task queue -----
    def submit(self, task: dict):
        with self.cond:
            if task["kind"] == "warm":  # drop duplicate pending warm-ups for the same model
                for t in self.pending:
                    if t["kind"] == "warm" and t["key"] == task["key"] and t.get("voice") == task.get("voice"):
                        return False
            self.pending.append(task)
            if task["kind"] == "job":
                self.jobs[task["job"].id] = task["job"]
                self.job_order.append(task["job"].id)
            self._renumber()
            self.cond.notify_all()
        HUB.emit("model", self.snapshot())
        return True

    def _renumber(self):
        pos = 1 if self.current else 0
        for t in self.pending:
            if t["kind"] == "job":
                pos += 1
                job = t["job"]
                if job.position != pos:
                    job.position = pos
                    job.emit("queued", position=pos)

    def cancel_job(self, job: Job):
        with self.cond:
            if job.terminal:
                return
            job.cancel.set()
            for t in list(self.pending):
                if t["kind"] == "job" and t["job"] is job:
                    self.pending.remove(t)
                    job.status = "cancelled"
                    job.finished = time.time()
                    job.emit("cancelled")
                    self._renumber()
                    break

    def loop(self):
        while True:
            with self.cond:
                while not self.pending:
                    self.cond.wait()
                task = self.pending.popleft()
                self.current = task
                self._renumber()
            HUB.emit("model", self.snapshot())
            try:
                kind = task["kind"]
                if kind == "job":
                    self.run_job(task["job"])
                elif kind == "warm":
                    self.ensure(task["key"], warm_voice=task.get("voice"))
                elif kind == "unload":
                    self.unload(reason=task.get("reason", "manual"))
                elif kind == "transcribe":
                    self.run_transcribe(task)
            except Exception as e:  # noqa: BLE001
                log(f"task {task['kind']} failed: {e}")
                traceback.print_exc()
                if task["kind"] in ("transcribe",):
                    task["error"] = str(e)
                    task["done"].set()
            finally:
                with self.cond:
                    self.current = None
                    self.last_activity = time.time()
                    self._renumber()
                HUB.emit("model", self.snapshot())

    # ----- model lifetime -----
    def unload(self, reason: str = "manual"):
        if self.model is None:
            if reason == "manual" and self.state not in ("empty",):
                self.set_state("empty")
            return
        import mlx.core as mx

        key = self.key
        self.model = None
        self.codes.clear()
        gc.collect()
        mx.clear_cache()
        log(f"unloaded {key} ({reason})")
        if reason == "idle":
            self.set_state("idle-unloaded", key=key)
        else:
            self.set_state("empty")

    def ensure(self, key: str, job: Job | None = None, warm_voice: str | None = None):
        """Return the loaded model for `key`, swapping and warming as needed."""
        if self.model is not None and self.key == key and self.state == "ready":
            if warm_voice:
                self.codes_for(resolve_voice(warm_voice))
            return self.model
        if self.model is not None:
            self.unload(reason="switch")
        import mlx.core as mx

        try:
            if job:
                job.status = "loading"
                job.emit("loading", model=key)
            self.set_state("loading", key=key)
            t0 = time.perf_counter()
            log(f"loading {core.MODELS[key]}…")
            model = core.load_model(key)
            self.load_s = round(time.perf_counter() - t0, 2)
            self.key, self.model = key, model
            if job:
                job.status = "warming"
                job.emit("warming", model=key)
            self.set_state("warming", key=key)
            t0 = time.perf_counter()
            kw = core.warmup_kwargs(key, ref_audio=self.warm_reference() if key == "nano" else None)
            core.render(model, kw, seed=0, stream=(key == "fast"))
            if key == "fast":
                core.render(model, kw, seed=0, stream=False)
            self.warm_s = round(time.perf_counter() - t0, 2)
            mx.clear_cache()
            log(f"{key} ready: load {self.load_s}s, warm-up {self.warm_s}s")
            self.set_state("ready", key=key)
        except Exception as e:
            self.model = None
            gc.collect()
            mx.clear_cache()
            self.set_state("error", key=key, error=str(e))
            raise
        if warm_voice:
            self.codes_for(resolve_voice(warm_voice))
        return self.model

    def warm_reference(self) -> str:
        """nano can't speak without a reference: use the first library voice, else a synthetic hum."""
        for v in list_voices():
            if v["has_audio"]:
                return str(voice_path(v["id"]) / "reference.wav")
        import numpy as np

        p = data_dir() / "tmp" / "warm_reference.wav"
        if not p.is_file():
            sr = 24000
            t = np.arange(int(sr * 1.5)) / sr
            sig = (0.1 * np.sin(2 * np.pi * 140 * t) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t))).astype(np.float32)
            core.write_audio(p, sig, sr)
        return str(p)

    def codes_for(self, voice: core.Voice):
        ref = Path(voice.audio)
        k = (self.key, voice.id, ref.stat().st_mtime_ns)
        if k not in self.codes:
            t0 = time.perf_counter()
            self.codes[k] = core.encode_reference(self.model, self.key, voice.audio)
            log(f"encoded reference '{voice.id}' for {self.key} in {time.perf_counter() - t0:.2f}s")
        return self.codes[k]

    # ----- jobs -----
    def run_job(self, job: Job):
        if job.cancel.is_set():
            return
        try:
            model = self.ensure(job.model, job=job)
            job.status = "running"
            job.position = 0
            job.started = time.time()
            job.emit("started", items=len(job.items), variations=job.variations)
            folder = outputs_dir() / job.workflow
            for ii, item in enumerate(job.items):
                item_started = datetime.now()
                kw = dict(item.kwargs)
                if item.voices:
                    codes = [self.codes_for(v) for v in item.voices]
                    kw["prompt_audio_codes"] = codes if job.workflow == "dialogue" else codes[0]
                for vi in range(job.variations):
                    if job.cancel.is_set():
                        raise core.Cancelled()
                    job.progress.update(item=ii, variation=vi, seconds=0.0)
                    seed = job.seed + vi
                    last_emit = [0.0]

                    def on_chunk(audio, sr, so_far, ii=ii, vi=vi):
                        job.progress["seconds"] = round(so_far, 2)
                        if job.stream:
                            job.push_pcm(audio.astype("<f4").tobytes())
                        t = time.time()
                        if t - last_emit[0] > 0.25:
                            last_emit[0] = t
                            job.emit("chunk", seconds=round(so_far, 2), item=ii, variation=vi)

                    take = core.render(model, kw, seed=seed, stream=job.stream, on_chunk=on_chunk,
                                       should_cancel=job.cancel.is_set)
                    if take is None:
                        job.emit("variation_done", item=ii, variation=vi, file=None, note="no audio generated")
                        continue
                    rec = self.save_take(job, folder, item, ii, vi, seed, take, kw, item_started)
                    job.outputs.append(rec)
                    job.emit("variation_done", item=ii, variation=vi, file=rec["file"], take=rec)
                    HUB.emit("history", {"added": rec["id"]})
            job.status = "done"
            job.finished = time.time()
            job.emit("done", outputs=len(job.outputs))
        except core.Cancelled:
            job.status = "cancelled"
            job.finished = time.time()
            job.emit("cancelled")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job.status = "error"
            job.error = f"{type(e).__name__}: {e}"
            job.finished = time.time()
            job.emit("error", message=job.error)

    def save_take(self, job: Job, folder: Path, item: core.Item, ii: int, vi: int, seed: int,
                  take: core.Take, kw: dict, when: datetime) -> dict:
        folder.mkdir(parents=True, exist_ok=True)
        base = core.output_base(item.label, vi, job.variations, when)
        if len(job.items) > 1 and job.params.get("name"):
            base = f"{core.slug(job.params['name'])}_{ii + 1:02d}" + (f"_v{vi + 1}" if job.variations > 1 else "")
        base = unique_base(folder, base)
        wav = folder / f"{base}.wav"
        core.write_audio(wav, take.audio, take.sample_rate, "wav")
        has_mp3 = False
        if "mp3" in job.formats:
            try:
                core.write_audio(wav.with_suffix(".mp3"), take.audio, take.sample_rate, "mp3")
                has_mp3 = True
            except Exception as e:  # noqa: BLE001
                log(f"mp3 failed: {e}")
        dur = take.duration_s
        rtf = take.wall_s / dur if dur else None
        if rtf:
            self.rtf[job.model] = round(0.7 * self.rtf[job.model] + 0.3 * rtf, 3)
        safe_kw = {k: v for k, v in kw.items() if k not in ("prompt_audio_codes", "ref_audio")}
        rec = dict(
            workflow=job.workflow, model=job.model, model_repo=core.MODELS[job.model], job_id=job.id,
            file=wav.relative_to(data_dir()).as_posix(), label=item.label, item=ii, items=len(job.items),
            variation=vi, variations=job.variations, seed=seed, sample_rate=take.sample_rate,
            duration_s=round(dur, 2), wall_s=round(take.wall_s, 2), rtf=round(rtf, 3) if rtf else None,
            first_audio_s=round(take.first_audio_s, 2) if job.stream and take.first_audio_s else None,
            peak_gb=round(take.peak_gb, 1), stream=job.stream,
            voices=[v.id for v in item.voices], params=job.params, kwargs=safe_kw,
            request=dict(workflow=job.workflow, model=job.model, params=job.params, variations=job.variations,
                         seed=job.seed, formats=job.formats, stream=job.stream),
            created=now_iso(), starred=False, has_mp3=has_mp3,
        )
        wav.with_suffix(".json").write_text(json.dumps(rec, indent=2, ensure_ascii=False) + "\n")
        log(f"saved {rec['file']} ({dur:.1f}s audio in {take.wall_s:.1f}s, peak {take.peak_gb:.1f} GB)")
        return take_urls(rec)

    # ----- transcripts -----
    def run_transcribe(self, task: dict):
        import mlx.core as mx
        from mlx_audio.stt import load as stt_load

        repo = CONFIG.get("transcribe_model")
        t0 = time.perf_counter()
        model = stt_load(repo)
        if getattr(model, "_processor", "n/a") is None:
            # mlx-community/whisper-large-v3-turbo ships weights only; its tokenizer/feature extractor are the
            # same as openai/whisper-large-v3-turbo (also in the HF cache).
            from transformers import WhisperProcessor

            model._processor = WhisperProcessor.from_pretrained(WHISPER_PROCESSOR_FALLBACK)
        load_s = time.perf_counter() - t0
        try:
            res = model.generate(task["path"])
            task["result"] = dict(text=(res.text or "").strip(), language=getattr(res, "language", None),
                                  load_s=round(load_s, 2), seconds=round(time.perf_counter() - t0, 2), model=repo)
        finally:
            del model
            gc.collect()
            mx.clear_cache()
        log(f"transcribed in {time.perf_counter() - t0:.1f}s")
        task["done"].set()


WORKER: Worker  # set in main()


def idle_monitor():
    """Unload the resident model after idle_unload_minutes without work (0 disables)."""
    asked_at = 0.0
    while True:
        time.sleep(1)
        try:
            minutes = float(CONFIG.get("idle_unload_minutes") or 0)
        except (TypeError, ValueError):
            minutes = 0
        if minutes <= 0 or WORKER.model is None:
            continue
        with WORKER.cond:
            busy = WORKER.current is not None or bool(WORKER.pending)
            idle = time.time() - WORKER.last_activity
        if not busy and idle >= minutes * 60 and asked_at < WORKER.last_activity:
            asked_at = time.time()
            log(f"idle for {idle:.0f}s, unloading {WORKER.key}")
            WORKER.submit({"kind": "unload", "reason": "idle"})


# ---------- HTTP ----------

def parse_job_request(body: dict) -> tuple[dict, list[core.Item]]:
    workflow = body.get("workflow")
    if workflow not in core.WORKFLOW_MODELS:
        raise ApiError(400, f"workflow must be one of: {', '.join(core.WORKFLOW_MODELS)}")
    model = body.get("model") or core.WORKFLOW_MODELS[workflow][0]
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise ApiError(400, "params must be an object")
    try:
        variations = int(body.get("variations") or 1)
    except (TypeError, ValueError):
        raise ApiError(400, "variations must be an integer")
    if not 1 <= variations <= 16:
        raise ApiError(400, "variations must be between 1 and 16")
    seed = body.get("seed")
    if seed in (None, ""):
        seed = random.randint(0, 2**31 - 1)
    try:
        seed = int(seed)
    except (TypeError, ValueError):
        raise ApiError(400, "seed must be an integer")
    formats = body.get("formats") or ["wav"]
    if not isinstance(formats, list) or not set(formats) <= {"wav", "mp3"}:
        raise ApiError(400, "formats must be a list of wav/mp3")
    if "wav" not in formats:
        formats = ["wav", *formats]
    stream = bool(body.get("stream"))
    if stream and not core.MODEL_INFO[model]["streaming"]:
        raise ApiError(400, f"model '{model}' can't stream (only fast can)")
    try:
        items = core.build_items(workflow, model, params, resolve_voice)
    except core.RequestError as e:
        raise ApiError(400, str(e))
    req = dict(workflow=workflow, model=model, params=params, variations=variations, seed=seed,
               formats=formats, stream=stream)
    return req, items


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "moss-ui"

    def log_message(self, fmt, *args):
        if "/api/events" in self.path or self.command == "GET" and not self.path.startswith("/api/"):
            return
        log(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")

    # ----- helpers -----
    def send_json(self, data, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error_json(self, status: int, message: str):
        self.send_json({"error": message}, status)

    def read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ApiError(413, "upload too large (200 MB max)")
        return self.rfile.read(n) if n else b""

    def read_json(self) -> dict:
        raw = self.read_body()
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ApiError(400, f"invalid JSON: {e}")
        if not isinstance(data, dict):
            raise ApiError(400, "expected a JSON object")
        return data

    def serve_file(self, path: Path, cache: str = "no-cache", download: str | None = None):
        size = path.stat().st_size
        ctype = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng and (m := re.match(r"bytes=(\d*)-(\d*)$", rng.strip())):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            elif m.group(2):
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 16, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def start_stream(self, ctype: str, extra: dict | None = None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.close_connection = True

    # ----- dispatch -----
    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method: str):
        url = urlparse(self.path)
        self.query = {k: v[-1] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        path = unquote(url.path)
        try:
            for m, pattern, fn in ROUTES:
                if m != method:
                    continue
                mt = pattern.match(path)
                if mt:
                    return fn(self, *mt.groups())
            if method == "GET":
                return self.static(path)
            raise ApiError(404, f"no route for {method} {path}")
        except ApiError as e:
            self.send_error_json(e.status, e.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            try:
                self.send_error_json(500, f"{type(e).__name__}: {e}")
            except Exception:  # noqa: BLE001
                pass

    def static(self, path: str):
        if path == "/" or not Path(path).suffix:
            target = WEB / "index.html"
        else:
            target = (WEB / path.lstrip("/")).resolve()
            if not target.is_relative_to(WEB.resolve()):
                raise ApiError(403, "forbidden")
        if not target.is_file():
            raise ApiError(404, f"not found: {path}")
        self.serve_file(target)


ROUTES: list = []


def route(method: str, pattern: str):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
        return fn
    return deco


# ----- models -----

@route("GET", r"/api/models")
def api_models(h: Handler):
    models = [dict(key=k, repo=core.MODELS[k], **info) for k, info in core.MODEL_INFO.items()]
    h.send_json(dict(models=models, status=WORKER.snapshot(), workflows=core.WORKFLOW_MODELS,
                     frames_per_second=core.FRAMES_PER_SECOND, default_max_seconds=core.DEFAULT_MAX_SECONDS,
                     sfx_sampling=core.SFX_SAMPLING))


@route("POST", r"/api/models/([a-z]+)/warm")
def api_warm(h: Handler, key: str):
    if key not in core.MODELS:
        raise ApiError(404, f"no model '{key}'")
    body = h.read_json()
    voice = body.get("voice") or None
    if voice:
        read_voice(voice)
    queued = WORKER.submit({"kind": "warm", "key": key, "voice": voice})
    h.send_json(dict(queued=queued, status=WORKER.snapshot()), 202)


@route("DELETE", r"/api/models/loaded")
def api_unload(h: Handler):
    WORKER.submit({"kind": "unload", "reason": "manual"})
    h.send_json(dict(queued=True, status=WORKER.snapshot()), 202)


# ----- settings -----

@route("GET", r"/api/settings")
def api_settings(h: Handler):
    h.send_json(CONFIG.snapshot())


@route("PATCH", r"/api/settings")
def api_settings_patch(h: Handler):
    before_port = CONFIG.get("port")
    snap = CONFIG.update(h.read_json())
    snap["restart_required"] = snap["port"] != before_port
    HUB.emit("settings", snap)
    h.send_json(snap)


# ----- global events -----

@route("GET", r"/api/events")
def api_events(h: Handler):
    h.start_stream("text/event-stream")
    last = HUB.seq
    h.wfile.write(f"event: hello\ndata: {json.dumps(dict(model=WORKER.snapshot(), jobs=WORKER.queue_summary()))}\n\n".encode())
    h.wfile.flush()
    while True:
        evs = HUB.wait(last)
        if not evs:
            h.wfile.write(b": ping\n\n")
        for seq, type_, data in evs:
            last = seq
            h.wfile.write(f"event: {type_}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
        h.wfile.flush()


# ----- jobs -----

@route("POST", r"/api/jobs")
def api_job_create(h: Handler):
    req, items = parse_job_request(h.read_json())
    job = Job(req, items)
    switching = WORKER.key != job.model or WORKER.state != "ready"
    est_audio = sum(i.seconds_hint or 0 for i in items) * job.variations
    job.estimate_s = round(est_audio * WORKER.rtf[job.model] + (15 if switching else 0), 1)
    WORKER.submit({"kind": "job", "job": job})
    if job.position == 0:
        job.emit("queued", position=0)
    h.send_json(job.to_dict(), 201)


@route("GET", r"/api/jobs")
def api_jobs(h: Handler):
    h.send_json(dict(jobs=WORKER.queue_summary(), status=WORKER.snapshot()))


def get_job(jid: str) -> Job:
    job = WORKER.jobs.get(jid)
    if not job:
        raise ApiError(404, f"no job '{jid}'")
    return job


@route("GET", r"/api/jobs/([\w]+)")
def api_job(h: Handler, jid: str):
    h.send_json(get_job(jid).to_dict())


@route("DELETE", r"/api/jobs/([\w]+)")
def api_job_cancel(h: Handler, jid: str):
    job = get_job(jid)
    WORKER.cancel_job(job)
    h.send_json(job.to_dict())


@route("GET", r"/api/jobs/([\w]+)/events")
def api_job_events(h: Handler, jid: str):
    job = get_job(jid)
    h.start_stream("text/event-stream")
    h.wfile.write(f"event: snapshot\ndata: {json.dumps(job.to_dict(), ensure_ascii=False)}\n\n".encode())
    h.wfile.flush()
    sent = 0
    while True:
        with job.cond:
            if len(job.events) <= sent and not job.terminal:
                job.cond.wait(15)
            evs = job.events[sent:]
            finished = job.terminal
        if not evs and not finished:
            h.wfile.write(b": ping\n\n")
        for seq, type_, data in evs:
            sent = seq
            h.wfile.write(f"id: {seq}\nevent: {type_}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
        h.wfile.flush()
        if finished and sent >= len(job.events):
            return


@route("GET", r"/api/jobs/([\w]+)/pcm")
def api_job_pcm(h: Handler, jid: str):
    """Raw little-endian float32 mono PCM as the fast model yields it. Ends when the job does."""
    job = get_job(jid)
    if not job.stream:
        raise ApiError(400, "this job isn't streaming (POST it with stream: true)")
    h.start_stream("application/octet-stream", {"X-Sample-Rate": job.sample_rate, "X-Channels": 1,
                                                "X-Sample-Format": "f32le"})
    sent = 0
    while True:
        with job.cond:
            if len(job.pcm) <= sent and not job.pcm_done:
                job.cond.wait(15)
            chunks = job.pcm[sent:]
            done = job.pcm_done
        for c in chunks:
            h.wfile.write(c)
            sent += 1
        h.wfile.flush()
        if done and sent >= len(job.pcm):
            return


# ----- history -----

@route("GET", r"/api/history")
def api_history(h: Handler):
    q = h.query
    items = list_history(q.get("workflow") or None, q.get("q"), q.get("starred") in ("1", "true"),
                         int(q.get("limit") or 200))
    h.send_json(dict(items=items))


@route("GET", r"/api/history/([a-z]+/[^/]+)")
def api_history_item(h: Handler, tid: str):
    side = history_paths(tid)
    rec = json.loads(side.read_text())
    rec["file"] = side.with_suffix(".wav").relative_to(data_dir()).as_posix()
    h.send_json(take_urls(rec))


@route("PATCH", r"/api/history/([a-z]+/[^/]+)")
def api_history_patch(h: Handler, tid: str):
    side = history_paths(tid)
    body = h.read_json()
    rec = json.loads(side.read_text())
    for k in ("starred", "note"):
        if k in body:
            rec[k] = body[k]
    side.write_text(json.dumps(rec, indent=2, ensure_ascii=False) + "\n")
    HUB.emit("history", {"changed": tid})
    rec["file"] = side.with_suffix(".wav").relative_to(data_dir()).as_posix()
    h.send_json(take_urls(rec))


@route("DELETE", r"/api/history/([a-z]+/[^/]+)")
def api_history_delete(h: Handler, tid: str):
    side = history_paths(tid)
    for ext in (".wav", ".mp3", ".json"):
        side.with_suffix(ext).unlink(missing_ok=True)
    HUB.emit("history", {"removed": tid})
    h.send_json(dict(removed=tid))


# ----- voices -----

@route("GET", r"/api/voices")
def api_voices(h: Handler):
    h.send_json(dict(voices=list_voices()))


@route("GET", r"/api/voices/([\w-]+)")
def api_voice(h: Handler, vid: str):
    h.send_json(read_voice(vid))


@route("POST", r"/api/voices")
def api_voice_create(h: Handler):
    body = h.read_json()
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "name is required")
    vid = body.get("id") or new_voice_id(name)
    if (voices_dir() / vid).exists():
        raise ApiError(409, f"voice '{vid}' already exists")
    meta = dict(name=name, description=(body.get("description") or "").strip(), source=body.get("source") or "upload",
                model=body.get("model"), created=now_iso(), duration_s=None, sample_rate=None)
    write_voice_meta(vid, meta)
    set_transcript(vid, body.get("transcript") or "")
    HUB.emit("voices", {"added": vid})
    h.send_json(read_voice(vid), 201)


@route("PUT", r"/api/voices/([\w-]+)/audio")
def api_voice_audio(h: Handler, vid: str):
    meta = read_voice(vid)
    raw = h.read_body()
    if not raw:
        raise ApiError(400, "send the audio file as the request body")
    ctype = (h.headers.get("Content-Type") or "").split(";")[0].strip()
    ext = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
           "audio/x-m4a": ".m4a", "audio/flac": ".flac", "audio/aac": ".aac"}.get(ctype, ".wav")
    tmpdir = data_dir() / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    src = tmpdir / f"upload_{secrets.token_hex(4)}{ext}"
    src.write_bytes(raw)
    try:
        dur, sr = to_mono_wav(src, voice_path(vid) / "reference.wav")
    finally:
        src.unlink(missing_ok=True)
    meta.update(duration_s=round(dur, 2), sample_rate=sr, updated=now_iso())
    write_voice_meta(vid, meta)
    HUB.emit("voices", {"changed": vid})
    h.send_json(read_voice(vid))


@route("PATCH", r"/api/voices/([\w-]+)")
def api_voice_patch(h: Handler, vid: str):
    meta = read_voice(vid)
    body = h.read_json()
    for k in ("name", "description"):
        if k in body:
            meta[k] = (body[k] or "").strip()
    meta["updated"] = now_iso()
    write_voice_meta(vid, meta)
    if "transcript" in body:
        set_transcript(vid, body["transcript"] or "")
    HUB.emit("voices", {"changed": vid})
    h.send_json(read_voice(vid))


@route("DELETE", r"/api/voices/([\w-]+)")
def api_voice_delete(h: Handler, vid: str):
    read_voice(vid)
    shutil.rmtree(voice_path(vid))
    HUB.emit("voices", {"removed": vid})
    h.send_json(dict(removed=vid))


@route("POST", r"/api/voices/([\w-]+)/from-output")
def api_voice_from_output(h: Handler, vid: str):
    """Promote a generated take to a library voice. Body: {take | file, name?, description?, transcript?}."""
    body = h.read_json()
    tid = body.get("take")
    if not tid and body.get("file"):
        f = str(body["file"]).removeprefix("/files/").removeprefix("outputs/")
        tid = f.removesuffix(".wav")
    side = history_paths(tid or "")
    rec = json.loads(side.read_text())
    if not VOICE_ID.match(vid):
        raise ApiError(400, "invalid voice id (lowercase letters, digits, - and _)")
    exists = (voices_dir() / vid / "voice.json").is_file()
    meta = read_voice(vid) if exists else dict(created=now_iso())
    params = rec.get("params") or {}
    meta.update(
        name=(body.get("name") or meta.get("name") or vid).strip(),
        description=(body.get("description") or params.get("instruction") or meta.get("description") or "").strip(),
        source="design" if rec.get("workflow") == "design" else "output",
        model=rec.get("model"), from_take=tid, seed=rec.get("seed"),
    )
    d = voice_path(vid)
    d.mkdir(parents=True, exist_ok=True)
    dur, sr = to_mono_wav(side.with_suffix(".wav"), d / "reference.wav")
    meta.update(duration_s=round(dur, 2), sample_rate=sr)
    write_voice_meta(vid, meta)
    transcript = body.get("transcript")
    if transcript is None:
        transcript = (rec.get("kwargs") or {}).get("text") or rec.get("label") or ""
        transcript = re.sub(r"\[pause[^\]]*\]", " ", transcript).strip()
    set_transcript(vid, transcript)
    HUB.emit("voices", {"added": vid})
    h.send_json(read_voice(vid), 200 if exists else 201)


# ----- transcribe -----

@route("POST", r"/api/transcribe")
def api_transcribe(h: Handler):
    ctype = (h.headers.get("Content-Type") or "").split(";")[0].strip()
    tmpdir = data_dir() / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    cleanup = []
    if ctype == "application/json":
        body = h.read_json()
        if body.get("voice"):
            path = voice_path(body["voice"]) / "reference.wav"
        elif body.get("take"):
            path = history_paths(body["take"]).with_suffix(".wav")
        else:
            raise ApiError(400, "give {voice} or {take}, or send audio as the body")
        if not path.is_file():
            raise ApiError(404, "no audio to transcribe")
    else:
        raw = h.read_body()
        if not raw:
            raise ApiError(400, "send the audio as the request body")
        src = tmpdir / f"tr_{secrets.token_hex(4)}.bin"
        src.write_bytes(raw)
        path = tmpdir / f"tr_{secrets.token_hex(4)}.wav"
        cleanup += [src, path]
        try:
            to_mono_wav(src, path)
        except ApiError:
            for p in cleanup:
                p.unlink(missing_ok=True)
            raise
    task = {"kind": "transcribe", "path": str(path), "done": threading.Event()}
    WORKER.submit(task)
    ok = task["done"].wait(900)
    for p in cleanup:
        p.unlink(missing_ok=True)
    if not ok:
        raise ApiError(504, "transcription timed out")
    if task.get("error"):
        raise ApiError(500, f"transcription failed: {task['error']}")
    h.send_json(task["result"])


# ----- files -----

@route("GET", r"/files/(.+)")
def files(h: Handler, rel: str):
    root = data_dir().resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root) or target.is_relative_to(root / "tmp"):
        raise ApiError(403, "forbidden")
    if target.suffix == ".mp3" and not target.is_file() and target.with_suffix(".wav").is_file():
        ensure_mp3(target.with_suffix(".wav"))
    if not target.is_file():
        raise ApiError(404, f"not found: {rel}")
    h.serve_file(target, download=target.name if "download" in h.query else None)


# ---------- main ----------

def main():
    global CONFIG, WORKER
    p = argparse.ArgumentParser(description="moss-ui server (always on 127.0.0.1)")
    p.add_argument("--port", type=int, help="port (default from config.json, 8765)")
    p.add_argument("--data-dir", help="data directory (default from config.json, ./data)")
    p.add_argument("--warm-model", choices=[*core.MODELS, "none"], help="model to load and warm at startup")
    p.add_argument("--idle-unload-minutes", type=float, help="unload the model after this many idle minutes (0 = never)")
    args = p.parse_args()
    CONFIG = Config(dict(port=args.port, data_dir=args.data_dir, warm_model=args.warm_model,
                         idle_unload_minutes=args.idle_unload_minutes))
    ensure_dirs()
    for f in (data_dir() / "tmp").glob("*"):
        if f.is_file():
            f.unlink(missing_ok=True)
    WORKER = Worker()
    WORKER.thread.start()
    threading.Thread(target=idle_monitor, name="idle-monitor", daemon=True).start()
    warm = CONFIG.get("warm_model")
    if warm and warm != "none":
        WORKER.submit({"kind": "warm", "key": warm})
    port = int(CONFIG.get("port"))
    httpd = ThreadingHTTPServer((HOST, port), Handler)
    httpd.daemon_threads = True
    log(f"moss-ui on http://{HOST}:{port}  (data: {data_dir()})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("bye")


if __name__ == "__main__":
    main()
