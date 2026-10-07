"""Command-line entry point to moss_core, for testing without the browser or server.

  python backend/cli.py tts "Hello there." --voice my-voice -n 2 --seed 7
  python backend/cli.py sfx "rain on a window" --seconds 4
  python backend/cli.py dialogue "[S1] Hi. [S2] Hello." --voice a --voice b
  python backend/cli.py voices

Voices come from the app's library (<data_dir>/voices/<id>/). Outputs go to <data_dir>/outputs/<workflow>/
with the same naming as the server (no JSON sidecar, so CLI takes don't show up in History). Run it with mlx-audio's Python (see ../moss-ui).
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import moss_core as core  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def data_dir(arg: str | None) -> Path:
    if arg:
        return Path(arg).expanduser().resolve()
    cfg = ROOT / "config.json"
    d = json.loads(cfg.read_text()).get("data_dir", "./data") if cfg.is_file() else "./data"
    p = Path(d).expanduser()
    return (p if p.is_absolute() else ROOT / p).resolve()


def main():
    p = argparse.ArgumentParser(prog="cli.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("workflow", choices=[*core.WORKFLOW_MODELS, "voices"])
    p.add_argument("text", nargs="?", help="text, script ([S1] …) or sound description")
    p.add_argument("--model", help="model key (default: the workflow's first model)")
    p.add_argument("--voice", action="append", help="library voice id (repeat once per speaker for dialogue)")
    p.add_argument("--mode", choices=["clone", "continue"], default="clone")
    p.add_argument("--language")
    p.add_argument("--instruction")
    p.add_argument("--seconds", type=float, help="target length (tts) / sound length (sfx)")
    p.add_argument("--max-seconds", type=float)
    p.add_argument("--temperature", type=float)
    p.add_argument("--lines", action="store_true", help="one job per line of text")
    p.add_argument("--pack", action="store_true", help="sfx: 'seconds | prompt' lines")
    p.add_argument("-n", type=int, default=1, help="variations")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--stream", action="store_true", help="fast only: stream (reports first-audio latency)")
    p.add_argument("--data-dir")
    a = p.parse_args()

    root = data_dir(a.data_dir)
    vdir = root / "voices"
    if a.workflow == "voices":
        for d in sorted(vdir.glob("*/voice.json")):
            meta = json.loads(d.read_text())
            print(f"{d.parent.name:20s} {meta.get('name', '')}: {meta.get('description', '')[:60]}")
        return

    def resolve(vid):
        ref = vdir / vid / "reference.wav"
        if not ref.is_file():
            raise core.RequestError(f"no voice '{vid}' in {vdir}")
        txt = vdir / vid / "transcript.txt"
        return core.Voice(id=vid, audio=str(ref), transcript=txt.read_text().strip() if txt.is_file() else None)

    model_key = a.model or core.WORKFLOW_MODELS[a.workflow][0]
    params = dict(text=a.text, prompt=a.text, script=a.text, mode=a.mode, language=a.language,
                  instruction=a.instruction, seconds=a.seconds, max_seconds=a.max_seconds,
                  temperature=a.temperature, lines=a.lines, pack=a.pack)
    if a.workflow == "dialogue":
        params["voices"] = a.voice or []
    else:
        params["voice"] = (a.voice or [None])[0]
    try:
        items = core.build_items(a.workflow, model_key, params, resolve)
    except core.RequestError as e:
        sys.exit(f"error: {e}")

    t0 = time.perf_counter()
    print(f"Loading {core.MODELS[model_key]}…", flush=True)
    model = core.load_model(model_key)
    print(f"   loaded in {time.perf_counter() - t0:.1f}s", flush=True)
    folder = root / "outputs" / a.workflow
    for item in items:
        kw = dict(item.kwargs)
        if item.voices:
            codes = [core.encode_reference(model, model_key, v.audio) for v in item.voices]
            kw["prompt_audio_codes"] = codes if a.workflow == "dialogue" else codes[0]
        print(f"→ {item.label[:80]}", flush=True)
        for i in range(a.n):
            take = core.render(model, kw, seed=a.seed + i, stream=a.stream)
            if take is None:
                print("   (no audio generated)")
                continue
            path = folder / f"{core.output_base(item.label, i, a.n, datetime.now())}.wav"
            core.write_audio(path, take.audio, take.sample_rate)
            extra = f", first audio after {take.first_audio_s:.2f}s" if a.stream else ""
            print(f"✅ {path}  ({take.duration_s:.1f}s audio in {take.wall_s:.1f}s, "
                  f"peak {take.peak_gb:.1f} GB{extra})", flush=True)


if __name__ == "__main__":
    main()
