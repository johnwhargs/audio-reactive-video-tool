# Audio Reactive Video Tool

Browser-based audio-reactive video tool. Music drives video playback position, depth compositing, and visual effects in real time.

## Features

- **Scrub mode** — audio amplitude controls video playback position
- **Depth composite** — per-pixel depth-based video compositing driven by audio
- **Beat tracking** — live BPM detection via spectral flux onset detection
- **Multiple audio sources** — mp3 file, microphone, or system audio capture
- **Bake/export** — record output as WebM

## Quick Start

### Static (Netlify / any web server)
Open `static/index.html` in a browser. All core features work client-side.

### With preprocessing server (optional)
Enables ffmpeg video preprocessing for smoother scrubbing:

```bash
pip install -r requirements.txt
python server.py
```

Runs at http://localhost:8080

## Tech Stack
- Vanilla JS, Web Audio API, Canvas 2D
- Flask + ffmpeg for optional video preprocessing
