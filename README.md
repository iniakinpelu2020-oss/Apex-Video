# Apex Video

A slide-to-video generator for the Apex suite. Write one line of text per slide, give each slide a
duration, pick a frame shape and a theme, then render: the slides are drawn on a canvas and captured
by `MediaRecorder` into a file you can download. Everything runs in the tab — no upload, no key, no
build step, relative `./` paths for `/apps/video/`.

**The take is silent unless you ask for the voice-over.** Each slide can carry its own narration,
which the device reads aloud as that slide appears. A `canvas.captureStream()` carries video frames
only, and no browser lets a page tap speech synthesis directly, so the one honest route into the file
is recording the tab's own audio: Generate asks you to share this tab and tick "share audio". Decline,
and the take is recorded silently with a toast saying why. Captions are still the content: the text is
baked into every frame.

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
- **Voice-over** per slide: a separate line of up to 400 characters, read by the device's own speech
  synthesis with a chosen voice and a 0.6×–1.6× speed. ▶ auditions a single slide and "Test voice"
  auditions the selected one. The voice list is grouped by language, refreshes on `voiceschanged`, and
  the choice is saved with the project. Nothing leaves the tab.
- **Spoken length**: each slide's `≈Ns` button estimates the read time at 2.7 words per second and
  turns amber when the narration outlasts the slide; clicking it sets the slide to that length, so
  speech is not cut off mid-sentence.
- **Capturing the voice**: with "Record the voice-over into the file" ticked, Generate calls
  `getDisplayMedia({ audio: true, preferCurrentTab: true })`, adds the captured audio track to the
  canvas stream and records `video/webm;codecs=vp9,opus` at 128 kbps audio. A declined share, a share
  with no audio, or a browser without tab capture falls back to a silent take and says so in a toast.
- **No recorder** (no `MediaRecorder`, no `captureStream`, or no supported mime type): the Generate
  button is disabled with a title explaining why, and Preview still works.
- Project autosaves to `localStorage` under `apex.video.v1` (debounced 250 ms) and is restored on load.

## Storage

```json
{
  "ratio": "16:9",
  "theme": "aurora",
  "slides": [
    {
      "id": "…",
      "text": "Apex Video",
      "duration": 3,
      "narration": "This video was written and read on this device."
    }
  ],
  "vo": { "voiceURI": "…", "rate": 1, "capture": false }
}
```

Durations are clamped to 1–15, narration to 400 characters, the speech rate to 0.6–1.6 and malformed
records are dropped on load, so an old or hand-edited value cannot break the renderer. A project saved
before voice-over existed still loads: `narration` comes back empty and `vo` gets defaults.

## Which format you get

`MediaRecorder.isTypeSupported` decides. Chrome and Firefox record WebM (VP9 or VP8); Safari 17+
records MP4 where it advertises support. The take's meta line names the actual container and codec, and
the download extension follows it. Opening a WebM in QuickTime needs extra codecs; MP4 is the safer
share in Safari.

## Offline

`sw.js` precaches the shell (`apex-video-v2`). Rendering and recording are local, so the app works
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
blocking a second take.

The voice-over was exercised in the same build: Preview spoke the first slide's line and Stop cut it
off, ▶ auditioned a slide, the `≈Ns` estimate flagged an over-long slide and its click moved that
slide from 4 s to 6 s, and the default project's first slide showed `≈4s` at 2.7 words per second.
With `getDisplayMedia` replaced by a stub returning a synthetic audio track, the take came back as
`video/webm;codecs=vp9,opus` and its decoded audio byte count was non-zero, so the mux path carries
real audio; a stub that rejected produced the toast and a silent take. Not verified: a real Chrome
tab-share picker (whether tab audio is offered in this VM), Safari's MP4 path, playback of the take
inside the app's own player, and text fitting at the 1:1 and 9:16 sizes.
