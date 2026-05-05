# Audio Reactive Video Tool — Claude Code Handoff

## What this is
A browser-based audio-reactive video tool built as a single HTML file. Music drives video playback position, depth compositing, and visual effects in real time. Built for live performance and creative video work.

## Current state
Two HTML files in this package:
- `audio-video-scrub.html` — main tool (two tabs: scrub + depth composite)
- `daisy-audio-reactive.html` — earlier prototype (image layers toggled by audio)

---

## Feature inventory

### Tab 1: Scrub
- Load video + audio (mp3, mic, or system audio capture)
- **Beat tracker** — live BPM detection via spectral flux onset detection, locks within ~8 beats, auto-tunes every 4 beats
- **Auto-tune** — silently updates gain, gate, compression, attack, release based on current signal every 4 beats
- **Signal chain** — gate → gain → compress → attack/release envelope
- **Frequency band selector** — all / sub / bass / mids / highs drives the amplitude reading
- **Beat sync slider** — 0=pure amplitude position, 10=pure beat phase position, blend in between
- **Three scrub modes** — scrub (amplitude→position), ping-pong (drives forward/back), freeze (loud=advance)
- **Keep alive system** — LFO oscillation, minimum drift, stuck detector, wall bounce so video never truly freezes
- **Flicker at peak** — when amplitude holds at max for 400ms, rapidly alternates between neighbouring frames for glitch effect
- **Video range** — in/out points to restrict which portion of the video is used
- **Timeline** — interactive waveform display, scroll to zoom, drag in/out markers
- **Bake** — MediaRecorder captures canvas + audio as WebM, auto-downloads
- **Volume control** — GainNode in Web Audio chain
- **Hide/show sidebar** — H hotkey
- **Fullscreen** — F hotkey
- **Hotkeys** — H, F, Space, M, P, Z, ←, →, 1, 2

### Tab 2: Depth Composite
- Three video inputs: background, overlay, depth map
- Per-pixel depth compositing on canvas using ImageData
- **Depth controls** — threshold, feather (smoothstep), mix, audio drive amount
- **Three modes** — reveal (loud=more overlay), hide (loud=less), pulse (oscillates with beat phase)
- **Scrub lock** — all three videos scrub together or independently at own ranges
- **Bake** — records depth composite canvas as WebM
- Shares the same audio engine as tab 1

### Shared audio engine
- Web Audio API: source → gainNode → analyser → destination
- Supports: mp3 file, microphone, system audio (getDisplayMedia)
- Beat tracker runs continuously once audio starts, no manual scan needed
- VU meter mirrors to both tabs

---

## Architecture

```
Audio source (mp3 / mic / system)
  └── GainNode (volume)
      └── AnalyserNode (FFT 2048)
          ├── Beat detector (spectral flux, 16-beat rolling average)
          │   ├── BPM estimator
          │   ├── Beat phase tracker (0→1 per beat)
          │   └── Auto-tune (every 4 beats)
          └── Amplitude envelope (gate → gain → compress → attack/release)
              ├── Tab 1: video.currentTime = f(amplitude, beatPhase, LFO, alive system)
              └── Tab 2: canvas depth composite threshold = f(amplitude)
```

---

## What to build next

### Priority 1 — Video preprocessing (the main blocker)
Problem: clips with variable frame rate or long GOP intervals freeze during scrubbing.
Solution: ffmpeg preprocessing to force all-keyframe H.264.

```bash
ffmpeg -i input.mov -vf fps=30 -c:v libx264 -preset fast -crf 18 -g 1 -keyint_min 1 -an output.mp4
```

Approach: Flask server with /preprocess endpoint. Browser uploads file, server runs ffmpeg, returns processed mp4. Show progress via SSE or polling.

### Priority 2 — Multi-clip pool
- Load up to 10 video clips into a pool
- Spotify API triggers clip change on track change
- Random selection with no-repeat logic
- Crossfade between clips (canvas blend)

### Priority 3 — Spotify API integration
- OAuth flow (need Client ID from developer.spotify.com)
- Poll /me/player/currently-playing every 2s
- On track change swap to new random clip from pool
- Use Audio Features endpoint for BPM, energy, valence to auto-set controls
- System audio capture still handles actual audio reactivity

### Priority 4 — SRT export
- Pre-scan audio buffer offline (OfflineAudioContext)
- Chunk into beat-aligned segments
- Classify each segment: SILENT / LOW / MID / BUILDING / PEAK / DROP
- Export as .srt with timecodes + energy label + BPM
- Use as editing guide for clip selection

### Priority 5 — Better bake
- Current: realtime WebM via MediaRecorder (1:1 render time)
- Better: OfflineAudioContext pre-renders amplitude envelope, then render video frames to canvas at controlled speed
- Output proper MP4 via server-side ffmpeg

---

## Known issues
- Clips freeze if VFR or long GOP — needs ffmpeg preprocessing (Priority 1)
- Beat sync at low BPM (< 60) can cause video to snap to same position repeatedly — reduce beat sync slider
- System audio capture requires Chrome + "Share audio" checkbox, does not work in Safari
- ffmpeg.wasm fails from local file:// due to Worker CORS restrictions — needs proper HTTP server

## Tech stack
- Vanilla JS, no frameworks
- Web Audio API (AnalyserNode, GainNode, MediaRecorder, getDisplayMedia)
- Canvas 2D (depth composite, VU meter, waveform, beat ring, timeline)
- MediaRecorder API (bake/export)

## File structure to build toward
```
/
├── server.py          # Flask server
├── static/
│   ├── index.html     # current HTML tool
│   └── assets/
├── uploads/           # temp video storage
├── processed/         # ffmpeg output cache
├── requirements.txt   # flask, ffmpeg-python
└── CLAUDE.md          # this file
```
