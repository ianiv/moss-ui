"""MOSS generation core for moss-ui.

Started as a copy of ../moss/moss.py and owned by this app. It keeps the model table, the SFX
sampling preset, the frame rate and the kwargs assembly from run_speech / run_dialogue / run_sfx,
turned into pure functions. The companion_voices lookup, afplay and the fx hook are gone: voices
come from the app's own library and are passed in as (audio path, transcript) pairs.

Nothing here touches HTTP. server.py and cli.py both build on it.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable

FRAMES_PER_SECOND = 12.5  # MOSS audio tokenizer frame rate; `tokens` and max_tokens count these

MODELS = {
    "tts": "OpenMOSS-Team/MOSS-TTS-v1.5",
    "fast": "OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5",
    "nano": "mlx-community/MOSS-TTS-Nano-100M",
    "dialogue": "OpenMOSS-Team/MOSS-TTSD-v1.0",
    "sfx2": "OpenMOSS-Team/MOSS-SoundEffect-v2.0",
    "sfx": "OpenMOSS-Team/MOSS-SoundEffect",
    "voicegen": "OpenMOSS-Team/MOSS-VoiceGenerator",
}
# Model-card recommended decoding for MOSS-SoundEffect.
SFX_SAMPLING = dict(audio_temperature=1.5, audio_top_p=0.6, audio_top_k=50, audio_repetition_penalty=1.2)
# Model-card defaults for MOSS-SoundEffect v2.0 (flow-matching DiT; sfx_v2.py).
SFX2_SAMPLING = dict(steps=100, cfg_scale=4.0, shift=5.0)
SFX2_MAX_SECONDS = 30
# Model-card recommended decoding for MOSS-VoiceGenerator.
VOICEGEN_SAMPLING = dict(audio_temperature=1.5, audio_top_p=0.6, audio_top_k=50, audio_repetition_penalty=1.1)

# Capabilities and measured numbers (../moss_tests/results.jsonl) shown in the UI.
MODEL_INFO = {
    "tts": dict(label="MOSS-TTS v1.5 (8B)", short="Best quality", sample_rate=24000, peak_gb=25.7, rtf=1.2,
                streaming=False, cloning=True, needs_voice=False, continuation=True, instruction=True,
                workflows=["tts", "design", "clone"]),
    "fast": dict(label="MOSS-TTS Local-Transformer v1.5", short="Fast, streams", sample_rate=48000, peak_gb=18.6,
                 rtf=0.8, streaming=True, cloning=True, needs_voice=False, continuation=False, instruction=False,
                 workflows=["tts", "clone"]),
    "nano": dict(label="MOSS-TTS-Nano 100M", short="Tiny cloner, needs a voice", sample_rate=48000, peak_gb=1.6,
                 rtf=0.5, streaming=False, cloning=True, needs_voice=True, continuation=False, instruction=False,
                 workflows=["tts", "clone"]),
    "dialogue": dict(label="MOSS-TTSD v1.0", short="Multi-speaker dialogue", sample_rate=24000, peak_gb=25.5,
                     rtf=0.85, streaming=False, cloning=True, needs_voice=False, continuation=False,
                     instruction=False, workflows=["dialogue"]),
    # Flow-matching DiT + DAC VAE + Qwen3 encoder, ported to MLX in sfx_v2.py. Always denoises a 30 s latent.
    "sfx2": dict(label="MOSS-SoundEffect v2.0 (1.3B DiT)", short="Sound effects, 48 kHz, up to 30 s",
                 sample_rate=48000, peak_gb=13.0, rtf=3.0, streaming=False, cloning=False, needs_voice=False,
                 continuation=False, instruction=False, workflows=["sfx"]),
    "sfx": dict(label="MOSS-SoundEffect v1", short="Sound effects and ambience", sample_rate=24000, peak_gb=25.0,
                rtf=0.5, streaming=False, cloning=False, needs_voice=False, continuation=False, instruction=False,
                workflows=["sfx"]),
    # Same MossTTSDelay architecture on a 1.7B backbone, trained to build a voice from a description.
    "voicegen": dict(label="MOSS-VoiceGenerator (1.7B)", short="Voice from a description", sample_rate=24000,
                     peak_gb=11.9, rtf=0.3, streaming=False, cloning=False, needs_voice=False, continuation=False,
                     instruction=True, workflows=["design"]),
}

# Which models each workflow may use (first is the default).
WORKFLOW_MODELS = {
    "tts": ["tts", "fast", "nano"],
    "design": ["voicegen", "tts"],
    "clone": ["tts", "fast", "nano"],
    "dialogue": ["dialogue"],
    "sfx": ["sfx2", "sfx"],
}

DEFAULT_MAX_SECONDS = {"tts": 120, "fast": 120, "nano": 30, "dialogue": 600, "sfx": 60, "sfx2": SFX2_MAX_SECONDS,
                      "voicegen": 60}

# Tiny throwaway generations that compile kernels and initialize the audio tokenizer.
WARMUP_TEXT = "Hello there."
WARMUP_MAX_TOKENS = 25


class RequestError(ValueError):
    """A request that can't be turned into generate() calls (shown to the user as-is)."""


@dataclass
class Voice:
    """A resolved library voice: reference audio path + transcript."""
    id: str
    audio: str
    transcript: str | None = None


@dataclass
class Item:
    """One generate() call (repeated once per variation)."""
    label: str  # used for the file name slug and history
    kwargs: dict
    voices: list[Voice] = field(default_factory=list)  # references to encode (and cache) before generating
    continuation: bool = False
    seconds_hint: float | None = None  # expected audio length, for ETA


# ---------- naming ----------

def slug(text: str, limit: int = 40) -> str:
    s = re.sub(r"\[[^\]]*\]", " ", text or "")
    s = re.sub(r"[^\w]+", "_", s, flags=re.UNICODE).strip("_").lower()
    return s[:limit].rstrip("_") or "audio"


def output_base(label: str, index: int, total: int, when: datetime | None = None) -> str:
    """CLI naming scheme: HHMMSS_slug[_vN]."""
    base = f"{(when or datetime.now()):%H%M%S}_{slug(label)}"
    if total > 1:
        base += f"_v{index + 1}"
    return base


def estimate_seconds(text: str | None) -> float:
    """Rough spoken length: ~15 characters per second plus explicit pauses."""
    if not text:
        return 0.0
    pauses = sum(float(x) for x in re.findall(r"\[pause\s+([\d.]+)\s*s?\]", text))
    plain = re.sub(r"\[[^\]]*\]", " ", text)
    return round(len(plain.strip()) / 15.0 + pauses, 1)


# ---------- request -> generate() kwargs ----------

def _float(params: dict, key: str, default=None):
    v = params.get(key)
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        raise RequestError(f"{key} must be a number")


def _str(params: dict, key: str) -> str | None:
    v = params.get(key)
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def text_lines(text: str) -> list[str]:
    """One job per line (like --file): skip blanks and # comments."""
    return [l.strip() for l in (text or "").splitlines() if l.strip() and not l.lstrip().startswith("#")]


def sampling(params: dict) -> dict:
    kw = {}
    t = _float(params, "temperature")
    if t is not None:
        kw["audio_temperature"] = t
    return kw


def speech_items(model_key: str, params: dict, voice: Voice | None) -> list[Item]:
    """tts / fast / nano (workflows tts, design, clone). Mirrors run_speech."""
    text = params.get("text") or ""
    items_text = text_lines(text) if params.get("lines") else [text.strip()]
    items_text = [t for t in items_text if t]
    if not items_text:
        raise RequestError("text is empty")
    continuation = params.get("mode") == "continue"
    if model_key == "nano" and not voice:
        raise RequestError("nano needs a voice (it only clones)")
    if continuation:
        if model_key != "tts":
            raise RequestError("continue mode only works with the tts model")
        if not voice:
            raise RequestError("continue mode needs a voice")
        if not voice.transcript:
            raise RequestError("continue mode needs the voice's transcript")
    max_seconds = _float(params, "max_seconds", DEFAULT_MAX_SECONDS[model_key])
    seconds = _float(params, "seconds")
    language = _str(params, "language")
    if model_key == "fast" and not language:
        language = "English"
    instruction = _str(params, "instruction")
    ambient = _str(params, "ambient_sound")
    experimental = {k: _str(params, k) for k in ("quality", "sound_event", "scene")}

    items = []
    base = dict(VOICEGEN_SAMPLING) if model_key == "voicegen" else {}
    for t in items_text:
        kw = {**base, "text": t, **sampling(params)}
        if model_key == "nano":
            kw["max_tokens"] = round(max_seconds * FRAMES_PER_SECOND)
            if voice.transcript:
                kw["ref_text"] = voice.transcript
        else:
            if continuation:
                kw.update(mode="continuation", ref_text=voice.transcript, text=" " + t)
            if language:
                kw["language"] = language
            if instruction:
                kw["instruction"] = instruction
            if ambient:
                kw["ambient_sound"] = ambient
            for k, v in experimental.items():  # untested fields, behind the UI's Experimental toggle
                if v:
                    kw[k] = v
            if seconds:
                kw["tokens"] = round(seconds * FRAMES_PER_SECOND)
            kw["max_tokens"] = round(max_seconds * FRAMES_PER_SECOND)
        items.append(Item(label=t, kwargs=kw, voices=[voice] if voice else [], continuation=continuation,
                          seconds_hint=seconds or estimate_seconds(t)))
    return items


def parse_speakers(script: str) -> list[str]:
    return sorted(set(re.findall(r"\[S(\d+)\]", script)), key=int)


def dialogue_items(params: dict, voices: list[Voice | None]) -> list[Item]:
    """Mirrors run_dialogue: one script, all speakers voiced or none."""
    script = " ".join(l.strip() for l in (params.get("script") or params.get("text") or "").splitlines() if l.strip())
    speakers = parse_speakers(script)
    if not speakers:
        raise RequestError('tag each turn with [S1], [S2], … e.g. "[S1] Hi! [S2] Hello."')
    if speakers != [str(i + 1) for i in range(len(speakers))]:
        raise RequestError(f"speakers must be numbered S1…S{len(speakers)} without gaps")
    picked = [v for v in voices if v]
    if picked and len(picked) != len(speakers):
        raise RequestError(f"pick a voice for every speaker ({len(speakers)}) or for none")
    missing = [v.id for v in picked if not v.transcript]
    if missing:
        raise RequestError(f"voices need a transcript for dialogue: {', '.join(missing)}")
    max_seconds = _float(params, "max_seconds", DEFAULT_MAX_SECONDS["dialogue"])
    kw = dict(text=script, max_tokens=round(max_seconds * FRAMES_PER_SECOND), **sampling(params))
    if picked:
        kw["ref_text"] = [v.transcript for v in picked]
    label = _str(params, "name") or script
    return [Item(label=label, kwargs=kw, voices=picked, seconds_hint=estimate_seconds(script))]


def sfx_items(params: dict, model_key: str = "sfx") -> list[Item]:
    """Mirrors run_sfx. `pack` text uses 'seconds | prompt' lines; seconds always bounded.

    v1 (sfx) takes token counts and sampling; v2 (sfx2) takes seconds, steps, cfg_scale and shift."""
    v2 = model_key == "sfx2"
    max_s = SFX2_MAX_SECONDS if v2 else 60
    default_seconds = _float(params, "seconds", 8.0)
    if params.get("pack"):
        lines = text_lines(params.get("prompt") or params.get("text") or "")
    else:
        p = (params.get("prompt") or params.get("text") or "").strip()
        lines = [p] if p else []
    if not lines:
        raise RequestError("describe the sound")
    custom = params.get("sampling") if isinstance(params.get("sampling"), dict) else None
    items = []
    for line in lines:
        seconds, prompt = default_seconds, line
        if m := re.match(r"^\s*(\d+(?:\.\d+)?)\s*\|\s*(.+)$", line):
            seconds, prompt = float(m.group(1)), m.group(2).strip()
        if not 0.5 <= seconds <= max_s:
            raise RequestError(f"sound length must be between 0.5 and {max_s} seconds")
        if v2:
            kw = dict(prompt=prompt, seconds=seconds, **SFX2_SAMPLING)
            for src, dst, cast in (("steps", "steps", int), ("cfg_scale", "cfg_scale", float),
                                   ("shift", "shift", float)):
                v = _float(custom or {}, src)
                if v is not None:
                    kw[dst] = cast(v)
            if not 1 <= kw["steps"] <= 500:
                raise RequestError("steps must be between 1 and 500")
            items.append(Item(label=prompt, kwargs=kw, seconds_hint=seconds))
            continue
        tokens = round(seconds * FRAMES_PER_SECOND)
        kw = dict(text=None, ambient_sound=prompt, tokens=tokens, max_tokens=tokens + 50, **SFX_SAMPLING)
        if custom:
            for src, dst in (("temperature", "audio_temperature"), ("top_p", "audio_top_p"),
                             ("top_k", "audio_top_k"), ("repetition_penalty", "audio_repetition_penalty")):
                v = _float(custom, src)
                if v is not None:
                    kw[dst] = int(v) if dst == "audio_top_k" else v
        else:
            kw.update(sampling(params))
        items.append(Item(label=prompt, kwargs=kw, seconds_hint=seconds))
    return items


def build_items(workflow: str, model_key: str, params: dict, resolve_voice: Callable[[str], Voice]) -> list[Item]:
    """Validate a job request and turn it into generate() calls."""
    if workflow not in WORKFLOW_MODELS:
        raise RequestError(f"unknown workflow '{workflow}'")
    if model_key not in WORKFLOW_MODELS[workflow]:
        raise RequestError(f"workflow '{workflow}' can't use model '{model_key}' "
                           f"(use one of: {', '.join(WORKFLOW_MODELS[workflow])})")
    if workflow == "dialogue":
        ids = params.get("voices") or []
        return dialogue_items(params, [resolve_voice(v) if v else None for v in ids])
    if workflow == "sfx":
        return sfx_items(params, model_key)
    if workflow == "design":
        if not _str(params, "instruction"):
            raise RequestError("describe the voice (instruction)")
        params = {**params, "voice": None, "mode": None}
    if workflow == "clone" and not params.get("voice"):
        raise RequestError("pick or record a reference voice")
    voice = resolve_voice(params["voice"]) if params.get("voice") else None
    return speech_items(model_key, params, voice)


def warmup_kwargs(model_key: str, ref_audio: str | None = None) -> dict:
    """A few words with a tiny max_tokens; output is thrown away."""
    if model_key == "sfx2":  # 2 steps over the full 30 s latent: compiles the DiT and VAE kernels
        return dict(prompt="A single soft click.", seconds=1.0, steps=2, cfg_scale=SFX2_SAMPLING["cfg_scale"])
    if model_key == "sfx":
        return dict(text=None, ambient_sound="A single soft click.", tokens=12, max_tokens=WARMUP_MAX_TOKENS,
                    **SFX_SAMPLING)
    if model_key == "dialogue":
        return dict(text="[S1] Hi. [S2] Hello.", max_tokens=WARMUP_MAX_TOKENS)
    if model_key == "nano":
        return dict(text=WARMUP_TEXT, ref_audio=ref_audio, max_tokens=WARMUP_MAX_TOKENS)
    if model_key == "voicegen":
        return dict(text=WARMUP_TEXT, instruction="A calm adult voice.", max_tokens=WARMUP_MAX_TOKENS,
                    **VOICEGEN_SAMPLING)
    kw = dict(text=WARMUP_TEXT, max_tokens=WARMUP_MAX_TOKENS)
    if model_key == "fast":
        kw["language"] = "English"
    return kw


# ---------- models and generation ----------

def load_model(model_key: str, override: str | None = None):
    if model_key == "sfx2":
        import sfx_v2

        return sfx_v2.load(override or MODELS[model_key])
    from mlx_audio.tts import load

    return load(override or MODELS[model_key], lazy=True)


def encode_reference(model, model_key: str, audio_path: str):
    """Encode a reference once so repeat clones skip it (moss.py did this for fast)."""
    return model.encode_reference_audio(audio_path, num_quantizers=model.config.n_vq)


class Cancelled(Exception):
    pass


@dataclass
class Take:
    audio: "object"  # numpy float32 array
    sample_rate: int
    wall_s: float
    first_audio_s: float | None
    peak_gb: float

    @property
    def duration_s(self) -> float:
        return len(self.audio) / self.sample_rate if self.sample_rate else 0.0


def to_mono(a):
    """Downmix to 1-D. The fast model's MOSS-Audio-Tokenizer-v2 decodes stereo as (samples, 2); flattening that
    interleaves the channels into a mono track twice as long, which plays at half speed."""
    if a.ndim == 2:
        if a.shape[0] <= 8 and a.shape[0] < a.shape[1]:  # (channels, samples)
            a = a.T
        a = a.mean(axis=1)
    return a.reshape(-1)


def render(model, kwargs: dict, *, seed: int | None = None, stream: bool = False,
           on_chunk: Callable[["object", int, float], None] | None = None,
           should_cancel: Callable[[], bool] | None = None) -> Take | None:
    """One variation: seed, run generate(), collect chunks. Returns None when no audio came out."""
    import mlx.core as mx
    import numpy as np

    if seed is not None:
        mx.random.seed(seed)
    mx.reset_peak_memory()
    t0 = time.perf_counter()
    first = None
    chunks, sr, total = [], None, 0
    if getattr(model, "step_callbacks", False):  # diffusion models: cancel between denoising steps
        kwargs = dict(kwargs, should_cancel=should_cancel)
    for r in model.generate(stream=stream, **kwargs):
        if first is None:
            first = time.perf_counter() - t0
        a = to_mono(np.asarray(r.audio, dtype=np.float32))
        chunks.append(a)
        sr = r.sample_rate
        total += len(a)
        if on_chunk:
            on_chunk(a, sr, total / sr)
        if should_cancel and should_cancel():
            raise Cancelled()
    if not chunks:
        return None
    return Take(audio=np.concatenate(chunks), sample_rate=sr, wall_s=time.perf_counter() - t0,
                first_audio_s=first, peak_gb=mx.get_peak_memory() / 1e9)


def write_audio(path: Path, audio, sample_rate: int, fmt: str = "wav"):
    from mlx_audio.audio_io import write as audio_write

    path.parent.mkdir(parents=True, exist_ok=True)
    audio_write(str(path), audio, sample_rate, format=fmt)


def items_summary(items: Iterable[Item]) -> str:
    items = list(items)
    return f"{len(items)} item(s): " + "; ".join(i.label[:40] for i in items[:3])
