"""One CLI for every MOSS model mlx-audio supports. Run through ./moss (it finds mlx-audio's Python).

  ./moss tts       "text"   MOSS-TTS v1.5 8B: best quality, cloning, multilingual, [pause 1.5s] markers
  ./moss fast      "text"   MOSS-TTS Local-Transformer v1.5: 48 kHz, ~3x realtime, live streaming playback
  ./moss nano      "text"   MOSS-TTS-Nano 100M: tiny and fast voice cloning (needs --voice)
  ./moss dialogue  "[S1] … [S2] …"   MOSS-TTSD v1.0: multi-speaker conversation, one --voice per speaker
  ./moss sfx       "prompt" MOSS-SoundEffect: sound effects and ambience from a description
  ./moss voices             list the voice IDs available from ../companion_voices

Every generator takes --file (one job per line, model loaded once), -n (variations), --seed,
--name, --out and --play. Run ./moss <command> -h for the rest.
"""
import argparse
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICES_DIR = HERE.parent / "companion_voices"
FRAMES_PER_SECOND = 12.5  # MOSS audio tokenizer frame rate; `tokens` and max_tokens count these

MODELS = {
    "tts": "OpenMOSS-Team/MOSS-TTS-v1.5",
    "fast": "OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5",
    "nano": "mlx-community/MOSS-TTS-Nano-100M",
    "dialogue": "OpenMOSS-Team/MOSS-TTSD-v1.0",
    "sfx": "OpenMOSS-Team/MOSS-SoundEffect",
}
# Model-card recommended decoding for MOSS-SoundEffect.
SFX_SAMPLING = dict(audio_temperature=1.5, audio_top_p=0.6, audio_top_k=50, audio_repetition_penalty=1.2)


# ---------- voices ----------

def voice_ids() -> list[str]:
    return sorted(p.name.removesuffix("_master.wav") for p in VOICES_DIR.glob("*_master.wav"))


def resolve_voice(voice: str, ref_text: str | None = None) -> tuple[str, str | None, str | None]:
    """Voice ID from companion_voices, or a path to any audio file. Returns (audio, transcript, fx preset)."""
    path = Path(voice).expanduser()
    if path.is_file():
        return str(path), ref_text, None
    audio = VOICES_DIR / f"{voice}_master.wav"
    if not audio.is_file():
        sys.exit(f"unknown voice '{voice}'. Use a file path or one of: {', '.join(voice_ids())}")
    if ref_text is None:
        txt = VOICES_DIR / f"{voice}_reference_text.txt"
        txt = txt if txt.is_file() else VOICES_DIR / "reference_text.txt"
        ref_text = txt.read_text().strip()
    fx = VOICES_DIR / f"{voice}_fx.txt"
    return str(audio), ref_text, fx.read_text().strip() if fx.is_file() else None


# ---------- output ----------

def slug(text: str, limit: int = 40) -> str:
    s = re.sub(r"\[[^\]]*\]", " ", text or "")
    s = re.sub(r"[^\w]+", "_", s, flags=re.UNICODE).strip("_").lower()
    return s[:limit].rstrip("_") or "audio"


def out_path(args, text: str, index: int, total: int) -> Path:
    folder = Path(args.out) if args.out else HERE / "out" / args.command
    folder.mkdir(parents=True, exist_ok=True)
    base = args.name or f"{datetime.now():%H%M%S}_{slug(text)}"
    if args.name and args.jobs_total > 1:
        base += f"_{args.job_index + 1:02d}"
    if total > 1:
        base += f"_v{index + 1}"
    return folder / f"{base}.wav"


def apply_fx(preset: str | None, path: Path):
    """Same post-effect clone.sh applies when <voice>_fx.txt exists: <name>.wav processed, <name>_clean.wav raw."""
    if not preset:
        return
    clean = path.with_name(path.stem + "_clean.wav")
    path.rename(clean)
    subprocess.run([str(VOICES_DIR / "robot_fx.sh"), preset, str(clean), str(path)], check=True)
    print(f"   + effect: {preset}")


def play(path: Path):
    subprocess.run(["afplay", str(path)])


# ---------- generation ----------

def load_model(command: str, override: str | None):
    import mlx.core as mx  # noqa: F401  (import here so -h stays fast)
    from mlx_audio.tts import load

    repo = override or MODELS[command]
    t0 = time.perf_counter()
    print(f"Loading {repo}…", flush=True)
    model = load(repo, lazy=True)
    print(f"   loaded in {time.perf_counter() - t0:.1f}s", flush=True)
    return model


def render(model, args, gen_kwargs: dict, label: str, fx: str | None = None):
    """Generate args.n variations of one job and save each."""
    import mlx.core as mx
    import numpy as np
    from mlx_audio.audio_io import write as audio_write

    for i in range(args.n):
        if args.seed is not None:
            mx.random.seed(args.seed + i)
        path = out_path(args, label, i, args.n)
        stream = getattr(args, "stream", False)
        player = None
        t0 = time.perf_counter()
        first = None
        chunks, sr = [], None
        for r in model.generate(stream=stream, **gen_kwargs):
            if first is None:
                first = time.perf_counter() - t0
            chunks.append(np.array(r.audio))
            sr = r.sample_rate
            if stream:
                if player is None:
                    from mlx_audio.tts.audio_player import AudioPlayer

                    player = AudioPlayer(sample_rate=sr)
                player.queue_audio(r.audio)
        if not chunks:
            print(f"   (no audio generated for: {label[:60]})")
            continue
        audio = np.concatenate(chunks)
        audio_write(str(path), audio, sr)
        wall = time.perf_counter() - t0
        dur = len(audio) / sr
        extra = f", first audio after {first:.2f}s" if stream else ""
        print(f"✅ {path}  ({dur:.1f}s audio in {wall:.1f}s{extra})", flush=True)
        apply_fx(fx, path)
        if player is not None:
            player.wait_for_drain()
            player.stop()
        elif args.play:
            play(path)


def jobs(args) -> list[str]:
    if args.file:
        lines = Path(args.file).read_text().splitlines()
        items = [l.strip() for l in lines if l.strip() and not l.lstrip().startswith("#")]
    elif args.text:
        items = [args.text]
    else:
        sys.exit("give the text as an argument or use --file")
    return items


def sampling(args) -> dict:
    kw = {}
    if getattr(args, "temperature", None) is not None:
        kw["audio_temperature"] = args.temperature
    return kw


def run_speech(args):
    """tts / fast / nano: one or more lines of speech, optionally cloned."""
    model = load_model(args.command, args.model)
    audio, ref_text, fx = (None, None, None)
    if args.voice:
        audio, ref_text, fx = resolve_voice(args.voice, args.ref_text)
    if args.no_fx:
        fx = None
    codes = None
    if audio and args.command == "fast":
        # Encode the reference once: cuts first-audio latency from ~0.6 s to ~0.2 s and avoids re-encoding per line.
        codes = model.encode_reference_audio(audio, num_quantizers=model.config.n_vq)

    items = jobs(args)
    args.jobs_total = len(items)
    for args.job_index, text in enumerate(items):
        kw = dict(text=text, **sampling(args))
        if args.command == "nano":
            if not audio:
                sys.exit("nano needs --voice")
            kw.update(ref_audio=audio, ref_text=ref_text)
        else:
            if codes is not None:
                kw["prompt_audio_codes"] = codes
            elif audio:
                kw["ref_audio"] = audio
            if getattr(args, "continue_", False):
                if not audio:
                    sys.exit("--continue needs --voice")
                kw.update(mode="continuation", ref_text=ref_text, text=" " + text)
            if args.language:
                kw["language"] = args.language
            if getattr(args, "instruction", None):
                kw["instruction"] = args.instruction
            if getattr(args, "seconds", None):
                kw["tokens"] = round(args.seconds * FRAMES_PER_SECOND)
            kw["max_tokens"] = round(args.max_seconds * FRAMES_PER_SECOND)
        print(f"→ {text[:80]}", flush=True)
        render(model, args, kw, text, fx)


def run_dialogue(args):
    if args.file:
        script = " ".join(l.strip() for l in Path(args.file).read_text().splitlines() if l.strip())
    elif args.text:
        script = args.text
    else:
        sys.exit("give the script as an argument or use --file")
    speakers = sorted(set(re.findall(r"\[S(\d+)\]", script)), key=int)
    if not speakers:
        sys.exit("tag each turn with [S1], [S2], … e.g. \"[S1] Hi! [S2] Hello.\"")
    if args.voice and len(args.voice) != len(speakers):
        sys.exit(f"script has {len(speakers)} speakers but {len(args.voice)} --voice given (one per speaker, in order)")
    refs = [resolve_voice(v) for v in args.voice or []]
    model = load_model("dialogue", args.model)
    kw = dict(text=script, max_tokens=round(args.max_seconds * FRAMES_PER_SECOND), **sampling(args))
    if refs:
        kw.update(ref_audio=[r[0] for r in refs], ref_text=[r[1] for r in refs])
    args.jobs_total, args.job_index = 1, 0
    print(f"→ {len(speakers)} speakers, {len(script)} characters", flush=True)
    render(model, args, kw, args.name or script)


def run_sfx(args):
    model = load_model("sfx", args.model)
    items = jobs(args)
    args.jobs_total = len(items)
    for args.job_index, line in enumerate(items):
        seconds, prompt = args.seconds, line
        if m := re.match(r"^\s*(\d+(?:\.\d+)?)\s*\|\s*(.+)$", line):  # "6 | door slams" in --file lines
            seconds, prompt = float(m.group(1)), m.group(2)
        tokens = round(seconds * FRAMES_PER_SECOND)
        kw = dict(text=None, ambient_sound=prompt, tokens=tokens, max_tokens=tokens + 50, **SFX_SAMPLING)
        kw.update(sampling(args))
        print(f"→ {seconds:g}s  {prompt[:80]}", flush=True)
        render(model, args, kw, prompt)


# ---------- CLI ----------

def main():
    p = argparse.ArgumentParser(prog="moss", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp, text_help):
        sp.add_argument("text", nargs="?", help=text_help)
        sp.add_argument("--file", help="text file, one job per line (# comments and blank lines skipped)")
        sp.add_argument("-n", type=int, default=1, help="variations per job (default 1)")
        sp.add_argument("--seed", type=int, help="random seed for repeatable output (variation i uses seed+i)")
        sp.add_argument("--temperature", type=float, help="audio sampling temperature (lower = steadier, higher = livelier)")
        sp.add_argument("--name", help="output file name (default: time + start of text)")
        sp.add_argument("--out", help="output folder (default: moss/out/<command>)")
        sp.add_argument("--play", action="store_true", help="play each result with afplay")
        sp.add_argument("--model", help="override the Hugging Face model repo")

    def speech(sp, voice_required=False):
        sp.add_argument("--voice", required=voice_required,
                        help=f"voice ID from companion_voices ({', '.join(voice_ids())}) or a path to any audio file")
        sp.add_argument("--ref-text", help="transcript of --voice when it's a file path (IDs use their *_reference_text.txt)")
        sp.add_argument("--no-fx", action="store_true", help="skip the voice's *_fx.txt post-effect")

    tts = sub.add_parser("tts", help="MOSS-TTS v1.5 8B: highest quality speech")
    common(tts, "what to say; inline [pause 1.5s] markers become exact silences")
    speech(tts)
    tts.add_argument("--language", help="e.g. English, French, Chinese, Japanese (helps non-English text)")
    tts.add_argument("--instruction", help="free-text delivery/style note, e.g. 'whispering softly'")
    tts.add_argument("--continue", dest="continue_", action="store_true",
                     help="continue on from the voice's reference recording instead of cloning it (needs its transcript)")
    tts.add_argument("--seconds", type=float,
                     help="target length. Too long for the text makes the model fill with babble; leave unset normally")
    tts.add_argument("--max-seconds", type=float, default=120, help="safety cap on output length (default 120)")

    fast = sub.add_parser("fast", help="MOSS-TTS Local-Transformer v1.5: 48 kHz, fast, streams")
    common(fast, "what to say")
    speech(fast)
    fast.add_argument("--language", default="English", help="language of the text (default English)")
    fast.add_argument("--stream", action="store_true", help="play live while generating (first audio in ~0.2 s)")
    fast.add_argument("--max-seconds", type=float, default=120, help="safety cap on output length (default 120)")

    nano = sub.add_parser("nano", help="MOSS-TTS-Nano 100M: tiny voice cloner")
    common(nano, "what to say")
    speech(nano, voice_required=True)

    dlg = sub.add_parser("dialogue", help="MOSS-TTSD v1.0: multi-speaker conversation")
    common(dlg, 'script with speaker tags, e.g. "[S1] Hi! [S2] Hey, you."  (--file: whole file is one script)')
    dlg.add_argument("--voice", action="append",
                     help="voice for each speaker in order: --voice R1 --voice freeman (omit for model-chosen voices)")
    dlg.add_argument("--max-seconds", type=float, default=600, help="safety cap on output length (default 600)")

    sfx = sub.add_parser("sfx", help="MOSS-SoundEffect: sound effects and ambience")
    common(sfx, 'description, e.g. "rain on a window, distant thunder" (English or Chinese)')
    sfx.add_argument("--seconds", type=float, default=8,
                     help="length (default 8). Always bounded: unbounded runs went 5+ minutes. "
                          "--file lines can set their own: '6 | door slams shut'")

    sub.add_parser("voices", help="list voice IDs from companion_voices")

    args = p.parse_args()
    if args.command == "voices":
        for v in voice_ids():
            _, txt, fx = resolve_voice(v)
            print(f"{v:10s} {'[fx: ' + fx + '] ' if fx else ''}{txt[:70]}")
        return
    {"tts": run_speech, "fast": run_speech, "nano": run_speech, "dialogue": run_dialogue, "sfx": run_sfx}[args.command](args)


if __name__ == "__main__":
    main()
