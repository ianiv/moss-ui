# MOSS UI: plan

A local web app for making audio with the MOSS models through mlx-audio. Plain modern web platform on the front (custom elements, ES modules, no framework, no build step) and a thin Python bridge on the back. The bridge runs in mlx-audio's Python and is built from its own copy of the `../moss/moss` CLI. The app is self-contained in `moss-ui/`, and `companion_voices` is not used.

## 1. What the installed stack actually supports

Checked against mlx-audio **0.5.6** installed as a uv tool (`~/.local/share/uv/tools/mlx-audio`), `../moss/moss.py`, and the measurements in `../moss_tests/results.jsonl`. All five models below are already in the Hugging Face cache. So is `mlx-community/whisper-large-v3-turbo`, which handles transcripts, and `mlx_audio.audio_io.write` can write MP3 directly.

| Key | Model | What it does | Out | Peak mem | Speed (RTF) |
|---|---|---|---|---|---|
| `tts` | `OpenMOSS-Team/MOSS-TTS-v1.5` (8B) | Best quality TTS, cloning, continuation, `instruction`, `language`, `[pause 1.5s]`, `tokens` (length), `ambient_sound` under speech | 24 kHz | ~25.7 GB | 0.8–1.9 |
| `fast` | `OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5` | Fast TTS + cloning, **the only model that streams** (`stream=True`) | 48 kHz | ~18.6 GB | 0.6–1.0 |
| `nano` | `mlx-community/MOSS-TTS-Nano-100M` | Tiny cloner, needs a reference voice, no streaming | 48 kHz | ~1.6 GB | 0.15–0.9 |
| `dialogue` | `OpenMOSS-Team/MOSS-TTSD-v1.0` | Multi-speaker `[S1] … [S2] …` scripts, one reference per speaker (lists of `ref_audio`/`ref_text`) | 24 kHz | ~25.5 GB | ~0.8–0.9 |
| `sfx` | `OpenMOSS-Team/MOSS-SoundEffect` | Sound effects / ambience from `ambient_sound` text; length via `tokens` (12.5 per second); model-card sampling (temp 1.5, top_p 0.6, top_k 50, rep 1.2) | 24 kHz | ~25 GB | ~0.5 |

The v1.5 prompt builder (`moss_tts/processor.py: build_user_message`) also accepts `quality`, `sound_event` and `scene`. None of these have been tested here yet.

Two findings shape the architecture:

- **The built-in `mlx_audio.server` can't drive these workflows.** Its `SpeechRequest` sends `instruct` (MOSS reads `instruction`) and has no fields for `language`, `tokens`, `ambient_sound`, `mode="continuation"`, or several references for dialogue. It also expects a reference audio *path on the server*. FastAPI/uvicorn aren't installed in the uv tool env either.
- **The 8B models need about 25 GB each**, so only one big model can be loaded at a time. Switching models costs a load (seconds when cached). The backend has to own model lifetime and run jobs one at a time.

## 2. Architecture

```
browser (custom elements, ES modules)
   │  fetch JSON / raw audio bodies, EventSource for progress, ReadableStream for live PCM
   ▼
server.py  (Python stdlib ThreadingHTTPServer, run with mlx-audio's Python like ./moss does)
   ├── static file handler        → ./web/*
   ├── REST API                   → /api/*
   ├── job queue (1 worker thread, FIFO; MLX work only happens here)
   ├── model manager (one resident model, swap on demand, mx.clear_cache on unload)
   ├── warm-up + idle-unload timer
   ├── whisper (transcripts, loaded briefly)
   └── moss_core.py               → own copy of the moss CLI logic
          ▼
       mlx_audio.tts.load(...).generate(...)
```

### 2.1 Backend bridge

- **Runtime.** A `./moss-ui` launcher script finds mlx-audio's Python the same way `../moss/moss` does and runs `server.py`. It **always binds to `127.0.0.1`** (localhost only; the port is configurable, default 8765). No new Python dependencies: stdlib `http.server`, `json`, `threading`, `queue`, plus `numpy`/`mlx`/`mlx_audio`, which are already there.
- **Core.** `moss-ui/backend/moss_core.py` starts as a **copy** of `../moss/moss.py` and is ours to change. It keeps `MODELS`, `SFX_SAMPLING`, `FRAMES_PER_SECOND`, and the kwargs assembly from `run_speech`/`run_dialogue`/`run_sfx`, turned into pure functions (`build_kwargs(workflow, params, voice) -> dict`). The `companion_voices` lookup, `afplay` and the fx hook are dropped. A small `moss-ui/backend/cli.py` keeps a command-line entry point for testing without the browser. `../moss` is left untouched.
- **Model manager.** `get(key)` returns the loaded model, or unloads the current one, runs `mx.clear_cache()`, and loads the new one. It reports `loading` / `warming` / `ready` / `idle-unloaded` states to the UI. It caches encoded reference codes per (model, voice) so repeat clones skip re-encoding. `moss.py` already does this for `fast`, using `encode_reference_audio` → `prompt_audio_codes`.
- **Warm-up.** On startup the server loads the configured default model (`warm_model`, default `tts`) and runs a tiny throwaway generation (a few words, `max_tokens` ≈ 25, not saved). This compiles the MLX kernels and initializes the audio tokenizer, so the first real job starts at full speed. The same warm-up runs after every model switch, before the queued job. For `fast` it also pre-encodes the selected voice. The UI can trigger warm-up ahead of time: picking a model in a view sends `POST /api/models/{key}/warm` when the queue is empty, so the load happens while you type.
- **Idle unload.** A timer unloads the resident model after `idle_unload_minutes` (default 15, `0` disables) with no jobs, then calls `mx.clear_cache()` to free the ~25 GB. The next job, or a model pick in the UI, loads and warms it again.
- **Jobs.** `POST /api/jobs` validates the request, enqueues it, and returns `{id}`. The worker runs `model.generate(...)` once per variation (seed + i), writes WAV with `mlx_audio.audio_io.write`, and saves a JSON sidecar next to it with the full request, model, seed, durations, RTF and peak memory. A cancel flag is checked between yielded chunks, and between variations for non-streaming models.
- **Progress.** `GET /api/jobs/{id}/events` is Server-Sent Events: `queued(position)`, `loading(model)`, `started`, `chunk(seconds_so_far)`, `variation_done(file)`, `done`, `error`. The non-streaming models yield once at the end, so the UI shows elapsed time and an estimate from past RTF instead of a fake progress bar.
- **Live streaming (`fast` only).** `GET /api/jobs/{id}/pcm` is a chunked response of raw float32 PCM frames as `generate(stream=True)` yields them. The browser plays them gaplessly through an AudioWorklet. The same job still writes the full WAV at the end.
- **Uploads.** Python 3.13 removed `cgi`, so uploads skip multipart. The browser sends the audio file as the raw request body (`PUT /api/voices/{id}/audio`, `Content-Type: audio/*`) and metadata as JSON in a separate call. The server converts to mono WAV with `mlx_audio.audio_io`, falling back to ffmpeg (installed via Homebrew) for formats it can't read, such as the browser's `webm/opus` recordings.
- **Transcripts.** `POST /api/transcribe` runs `mlx-community/whisper-large-v3-turbo` (already cached) through `mlx_audio.stt` on an uploaded reference and returns the text for review. Whisper is small, so it loads next to the resident TTS model, runs on the same worker queue, and unloads right away.
- **Formats.** Masters are always WAV. MP3 is produced with `audio_io.write(..., format="mp3")`, either at generation time when the job asks for it (`formats: ["wav","mp3"]`) or lazily the first time `/files/…/x.mp3` is requested, then cached next to the WAV.
- **Files.** Everything lives under a configurable **data directory** (default `moss-ui/data/`): `outputs/<workflow>/` with the CLI's naming scheme (`HHMMSS_slug_v1.wav`), and `voices/<id>/` holding `reference.wav`, `transcript.txt` and `voice.json` (description, source, model it was designed with). They're served read-only under `/files/…` and support `Range` requests so `<audio>` can seek.

### 2.2 API sketch

| Method & path | Purpose |
|---|---|
| `GET /api/models` | Model table above + which one is loaded + state + capability flags (streaming, cloning, needs voice, sample rate) |
| `POST /api/models/{key}/warm` / `DELETE /api/models/loaded` | Pre-load and warm a model / unload now |
| `GET` / `PATCH /api/settings` | Data directory, warm model, idle-unload minutes, default download format |
| `POST /api/transcribe` | Raw audio body → Whisper transcript |
| `GET /api/voices` | Voice library (ID, transcript, description, source, duration) |
| `POST /api/voices` / `PUT …/{id}/audio` / `PATCH` / `DELETE` | Create/edit voices; `POST /api/voices/{id}/from-output` promotes a generated take to a voice |
| `POST /api/jobs` | `{workflow, model, params, variations, seed}` → `{id}` |
| `GET /api/jobs`, `GET /api/jobs/{id}`, `DELETE /api/jobs/{id}` | Queue, status, cancel |
| `GET /api/jobs/{id}/events` | SSE progress |
| `GET /api/jobs/{id}/pcm` | Live PCM stream (`fast` + `stream`) |
| `GET /api/history?workflow=&q=` | Past outputs from sidecar JSON |

### 2.3 Frontend

No build step: `web/index.html` loads `web/app.js` as a module, and each component is its own file under `web/components/`. Each component is a custom element with Shadow DOM and shared `adoptedStyleSheets` (tokens, base, forms). Light and dark themes come from CSS custom properties and `prefers-color-scheme`. Layout uses CSS grid, container queries and `@layer`.

**Platform pieces used:** custom elements and `ElementInternals` (so form-associated inputs work in a real `<form>`), `<template>`, `<dialog>`, Popover API, `EventSource`, `fetch` + `ReadableStream`, Web Audio (`AudioWorklet` for streaming playback, `OfflineAudioContext` for trimming), `MediaRecorder` + `getUserMedia` for recording references, `<canvas>` for waveforms, `navigation`/hash routing, `localStorage` for drafts only.

**State.** A tiny `store.js` built on an `EventTarget` holds models, voices, the job queue and history. Components subscribe to it, and the server stays the source of truth. `api.js` wraps fetch, SSE and PCM streams.

**Component tree**

```
<moss-app>                      shell: nav, routing, global queue drawer, model status pill
  <moss-model-status>           which model is loaded / loading, memory note
  <moss-job-queue>              live list of jobs, cancel, jump to result
  views (one per workflow):
    <moss-tts-view>
    <moss-design-view>
    <moss-clone-view>
    <moss-dialogue-view>
    <moss-sfx-view>
    <moss-library-view>         history + voices
    <moss-settings-view>        data dir, warm model, idle unload, download format
  shared:
    <moss-text-editor>          textarea with [pause Ns] insert, char/est-seconds counter
    <moss-voice-picker>         searchable voice list, preview button, "none / model voice"
    <moss-voice-recorder>       record or drop a file, trim, normalize, transcript field
    <moss-gen-controls>         model select, variations, seed + lock, temperature, max seconds
    <moss-advanced>             <details>: language, instruction, tokens/seconds, ambient_sound
    <moss-take-list>            variations side by side, A/B, star, save-as-voice, download WAV/MP3
    <moss-waveform-player>      canvas waveform + seek + loop region, wraps <audio>
    <moss-stream-player>        AudioWorklet player for live PCM
    <moss-script-editor>        dialogue line rows → [S1]… script
```

## 3. Workflows

Each workflow is a view that compiles its form into one `POST /api/jobs`. The table shows exactly which `generate()` arguments each one sends, so every screen maps onto a call that has already worked here.

### 3.1 Text to speech
- **Model:** `tts` (default), `fast`, or `nano` (only with a voice).
- **Inputs:** text, optional voice, language (default auto for `tts`, English for `fast`), instruction (`tts`), target seconds (`tokens`), max seconds, temperature, variations, seed.
- **Extras:** a pause button inserts `[pause 1.0s]`, and a "one job per line" toggle mirrors `--file` batch mode. The model loads once for the whole batch.
- **Calls:** `text`, `ref_audio` or cached `prompt_audio_codes`, `language`, `instruction`, `tokens`, `max_tokens`, `audio_temperature`.
- **Live mode:** with `fast`, a "Play while generating" switch uses the PCM stream.

### 3.2 Voice design
Voice design uses **`OpenMOSS-Team/MOSS-VoiceGenerator`** (1.7B, same MossTTSDelay architecture, loads with mlx-audio's `moss_tts`, about 12 GB peak) with its model-card sampling (temp 1.5, top_p 0.6, top_k 50, rep 1.1). It replaced the original v1.5-with-`instruction` approach, which barely followed descriptions. v1.5 is still selectable for comparison.
- **Inputs:** voice description, an audition line, and a variation count (default 4).
- **Flow:** generate N takes, compare them in `<moss-take-list>`, then **Save as voice**. That writes the take as a reference WAV, its text as the transcript, and the description into the voice library. From then on the voice is used through cloning, which gives a consistent identity. You've confirmed this approach.
- **Calls:** `text`, `instruction`, optional `language`, seeds `seed+i`.

### 3.3 Voice cloning
- **Inputs:** record (`MediaRecorder`) or drop a file, trim to about 5–15 s in the waveform, then **Transcribe** fills the transcript with Whisper so you can correct it. The transcript is needed for continuation mode, for `nano`, and for TTSD references.
- **Modes:** *Clone* (`ref_audio`, all three TTS models) and *Continue* (`mode="continuation"`, `ref_text`, text prefixed with a space; `tts` only, one reference).
- **Save:** the reference and transcript go into the voice library so every other workflow can pick the voice.

### 3.4 Multi-speaker dialogue
- **Model:** `dialogue` (TTSD v1.0).
- **Editor:** rows of (speaker, line). Speakers are named chips mapped to S1…Sn, each with a voice picker or "model voice". You can also paste a raw `[S1] …` script, and it's parsed back into rows.
- **Validation (same as the CLI):** you either pick a voice for every speaker or for none, and voices with reference audio need a transcript.
- **Calls:** one `text` script, `ref_audio=[…]`, `ref_text=[…]`, `max_tokens` (default 600 s).
- **Later:** per-line regeneration by rendering lines separately and stitching them. This is less natural than a single pass, so it's an optional mode.

### 3.5 Sound effects
- **Model:** `sfx`.
- **Inputs:** a description (English or Chinese) and seconds (default 8, always bounded, because unbounded runs went past 5 minutes). The model-card sampling preset is locked, with a "custom" override.
- **Pack mode:** a list of `seconds | prompt` rows like `../moss/examples/sfx_pack.txt`, run as one batch.
- **Calls:** `text=None`, `ambient_sound`, `tokens = seconds × 12.5`, `max_tokens = tokens + 50`, plus sampling.

### 3.6 Additional capabilities worth exposing
- **Speech over ambience:** v1.5 `ambient_sound` together with `text` (tested: `ambient_rain`). This lives as a field under Advanced in TTS.
- **Variations and A/B:** every workflow shares `n` + seed, the take list, star/keep, and "regenerate with this seed".
- **Library and history:** every output with its full recipe, plus "re-open in editor" to tweak and rerun.
- **Untested prompt fields:** `quality`, `sound_event`, `scene`. They stay hidden behind an "Experimental" toggle until a quick test shows they do something.

## 4. Delivery phases

1. **Bridge:** copy the CLI into `backend/moss_core.py`, write `server.py` with config, model manager, warm-up, idle unload, job queue, SSE, WAV/MP3 output and static serving. Check that it matches the CLI outputs.
2. **Shell and TTS:** app shell, design tokens, the shared components, and the TTS view end to end.
3. **Voices:** voice library, recorder/trim, Whisper transcripts, cloning, and voice design with save-as-voice.
4. **Dialogue and SFX:** script editor and SFX pack mode.
5. **Streaming and polish:** `fast` live playback, settings view, history search, keyboard shortcuts, empty/error states.

## 5. Configuration

`moss-ui/config.json`, created with defaults on first run. It can be edited in the Settings view (`PATCH /api/settings`), and `--data-dir` / `--port` flags override it.

| Key | Default | Notes |
|---|---|---|
| `data_dir` | `./data` | Outputs and voice library. Changing it takes effect for new files; nothing is moved. |
| `port` | `8765` | Host is always `127.0.0.1`. |
| `warm_model` | `tts` | Model loaded and warmed at startup. `none` skips startup warm-up. |
| `idle_unload_minutes` | `15` | `0` keeps the model loaded forever. |
| `download_format` | `wav` | `wav` or `mp3`. Both are always available per take. |
| `transcribe_model` | `mlx-community/whisper-large-v3-turbo` | |

## 6. Decisions

1. `companion_voices` is not used. The app has its own configurable data directory and voice library.
2. The backend starts from a copy of `../moss/moss.py` that the app owns. The original stays untouched.
3. The server is localhost only.
4. Reference transcripts come from Whisper (large-v3-turbo, already cached).
5. Voice design uses v1.5 instruction-based takes, saved as voices (3.2).
6. The server warms models at startup, after each switch, and when a model is picked in the UI.
7. Downloads are available as WAV and MP3.
8. Idle unload is configurable, with a default of 15 minutes.

## 7. Remaining assumptions

None of these block the build. I picked defaults that are easy to change later.
- The startup warm model is `tts` (the 8B), because it's the default for TTS and voice design. Switch it to `fast` if you mostly stream.
- The `fast` streaming latency (17 s logged vs about 0.2 s claimed) gets measured in phase 1 with warm-up in place.
- The untested `quality` / `sound_event` / `scene` fields stay behind an Experimental toggle.
