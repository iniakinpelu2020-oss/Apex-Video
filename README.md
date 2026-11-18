# Apex Video

A slide-to-video generator for the Apex suite. Write one line of text per slide, give each slide a
duration, pick a frame shape and a theme, then render: the slides are drawn on a canvas and captured
by `MediaRecorder` into a file you can download. Everything runs in the tab — no upload, no key, no
build step, relative `./` paths for `/apps/video/`.

**The file is silent.** A `canvas.captureStream()` carries video frames only, and the Web Speech API
cannot route its output into a media stream, so narration is not muxed into the recording. Pair it
with Apex Voice and play the narration alongside, or add audio in an editor. Captions are the content:
the text is baked into every frame.

```
index.html      canvas stage, transport, slide editor
styles.css      dark studio layout, single column under 900px
app.js          slide state, canvas renderer, MediaRecorder export, localStorage
manifest.json   relative start_url and scope, standalone display
sw.js           offline shell, scoped to this folder
icons/          192, 512 and maskable 512
```

## What it does

- **Slides** with up to 240 characters each, 1–15 s apiece and a 24-slide cap. Add, move up/down and
  delete; the delete button stays disabled while only one slide is left. Clicking or focusing a slide
  previews it on the stage.
- **Frames**: 16:9 (1280 × 720), 1:1 (1080 × 1080) and 9:16 (720 × 1280). The canvas is re-sized, not
  scaled, so exports match the chosen shape exactly.
- **Themes**: Aurora, Ember, Grove, Slate — each a two-stop background, a drifting accent glow, a
  top rule and the slide dots.
- **Text fitting** measures and wraps at the canvas width, then steps the font size down until the
  block fits the safe area, so a long line shrinks instead of running off the frame.
- **Preview** plays the timeline on the canvas (same renderer as the export) with a live progress bar
  and a `slide n of m · 0:04 / 0:12` readout. Preview or Escape stops it.
- **Generate video** records the identical timeline: `captureStream(30)` → `MediaRecorder` at
  6 Mbps, preferring VP9, then VP8, then MP4 where the browser supports it. When the timeline ends the
  recorder stops on its own; the Stop button ends a take early and keeps what was recorded. The take
  appears in a player with a Download link named `apex-video-YYYYMMDD-HHmmss.webm` (or `.mp4`).
- **No recorder** (no `MediaRecorder`, no `captureStream`, or no supported mime type): the Generate
  button is disabled with a title explaining why, and Preview still works.
- Project autosaves to `localStorage` under `apex.video.v1` (debounced 250 ms) and is restored on load.

## Storage

```json
{
  "ratio": "16:9",
  "theme": "aurora",
  "slides": [
    { "id": "…", "text": "Apex Video", "duration": 3 }
  ]
}
```

Durations are clamped to 1–15 and malformed records are dropped on load, so an old or hand-edited
value cannot break the renderer.

## Which format you get

`MediaRecorder.isTypeSupported` decides. Chrome and Firefox record WebM (VP9 or VP8); Safari 17+
records MP4 where it advertises support. The take's meta line names the actual container and codec, and
the download extension follows it. Opening a WebM in QuickTime needs extra codecs; MP4 is the safer
share in Safari.

## Offline

`sw.js` precaches the shell (`apex-video-v1`). Rendering and recording are local, so the app works
with no connection once installed. Bump `CACHE` when shell files change. Recorded blobs are never
cached — they live in the tab until you download them.

## Running it

```bash
python3 -m http.server 8080
# then open http://127.0.0.1:8080/
```

## Bundling into ApexOS

Roster entry `Apex-Video video`, catalogue entry `{ id: 'video', name: 'Apex Video', cat: 'Media',
repo: 'Apex-Video', path: '/apps/video/' }`. The "Open Apex Voice" link is `../voice/`.

## State of this repo

Exercised in Chrome against the bundled build: Generate recorded the two default slides into a
2.9 MB `video/webm;codecs=vp9` at 1280 × 720, the download link appeared, the blob answered with real
video dimensions when loaded into a video element, and Preview toggled to Stop and back without
blocking a second take. Not verified: Safari's MP4 path, playback of the take inside the app's own
player (the export was played back outside it), and text fitting at the 1:1 and 9:16 sizes.
