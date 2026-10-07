# MOSS Studio (moss-ui)

A local web app for the MOSS speech models in mlx-audio: text to speech, voice design, voice cloning,
multi-speaker dialogue and sound effects, with a voice library and history. See `PLAN.md` for the design.

## Run

```sh
./moss-ui                      # http://127.0.0.1:8765/
./moss-ui --port 9000 --data-dir ~/moss-data --warm-model fast --idle-unload-minutes 5
```

The launcher finds mlx-audio's Python (the `uv tool install mlx-audio` env) the same way `../moss/moss` does.
Nothing else needs installing: the server is Python stdlib plus mlx/mlx_audio/numpy, and the frontend is plain
ES modules and custom elements with no build step. `ffmpeg` (Homebrew) is used for MP3 and for decoding browser
recordings. The server only ever binds to `127.0.0.1`.

On startup it loads and warms `warm_model` (default `tts`, the 8B model, about 25 GB). Only one MOSS model is
resident at a time; switching workflows swaps it. The resident model is unloaded after `idle_unload_minutes`
without work (default 15, `0` = never).

## Files

- `config.json`: created on first run (data dir, port, warm model, idle unload, download format, Whisper model).
  Editable in Settings. Command-line flags override it for that run.
- `data/outputs/<workflow>/HHMMSS_slug[_vN].wav` plus a `.json` sidecar with the full recipe (and `.mp3` when
  asked for). `data/voices/<id>/reference.wav`, `transcript.txt`, `voice.json`.
- `backend/server.py`: HTTP API, job queue, model manager. `backend/moss_core.py`: the app's own copy of the
  `../moss` CLI logic. `backend/cli.py`: command line without the browser, e.g.
  `…/mlx-audio/bin/python backend/cli.py clone "Hi there" --model nano --voice my-voice`.
- `web/`: `index.html`, `app.js`, `lib/` (styles, store, api, audio helpers), `components/` (one custom element
  per file), `worklets/pcm-player.js` (live playback for the streaming `fast` model).

## Keyboard

`⌘/Ctrl+Enter` generate · `Alt+1…7` switch view · `Alt+Q` job queue · `Alt+.` cancel running job · `?` help.
