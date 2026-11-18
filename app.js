/* Apex Video - text slides rendered on a canvas and recorded to a video file,
 * with a voice-over read by the device's own speech synthesis.
 *
 *   canvas frames -> captureStream -> MediaRecorder
 *   narration text -> SpeechSynthesisUtterance, started as each slide begins
 *
 * A canvas stream carries pictures only, and no browser lets a page tap speech
 * synthesis directly. The one route into the file is recording the tab's own
 * audio, which the browser grants only when the user shares this tab. Without
 * that share the take is silent and the narration just plays alongside.
 *
 *   localStorage  apex.video.v1  { ratio, theme, slides, vo }
 */
(function () {
  'use strict';

  var KEY = 'apex.video.v1';
  var RATIOS = {
    '16:9': { w: 1280, h: 720 },
    '1:1': { w: 1080, h: 1080 },
    '9:16': { w: 720, h: 1280 }
  };
  var THEMES = {
    aurora: { a: '#08192b', b: '#12405f', glow: '#22d3ee', ink: '#f2f9ff' },
    ember: { a: '#1a0c07', b: '#4d1f10', glow: '#fb923c', ink: '#fff5ec' },
    grove: { a: '#07130e', b: '#154531', glow: '#34d399', ink: '#effcf5' },
    slate: { a: '#0a0d15', b: '#1e2534', glow: '#a5b4fc', ink: '#eef2ff' }
  };
  var MIMES = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4'
  ];
  /* Same containers, but a track pair that can hold the voice-over. */
  var AUDIO_MIMES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=opus',
    'video/webm',
    'video/mp4'
  ];
  var MIN_DUR = 1;
  var MAX_DUR = 15;
  var FADE_MS = 420;
  var FONT = '700 %spx ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var MAX_SLIDES = 24;
  var MAX_VO = 400;
  var WORDS_PER_SEC = 2.7;

  var canvas = document.getElementById('preview');
  var ctx = canvas.getContext('2d');

  var el = {
    statLine: document.getElementById('statLine'),
    stageMeta: document.getElementById('stageMeta'),
    recPct: document.getElementById('recPct'),
    recTrack: document.getElementById('recTrack'),
    recBar: document.getElementById('recBar'),
    playBtn: document.getElementById('playBtn'),
    recordBtn: document.getElementById('recordBtn'),
    downloadLink: document.getElementById('downloadLink'),
    take: document.getElementById('take'),
    player: document.getElementById('player'),
    takeMeta: document.getElementById('takeMeta'),
    ratioSelect: document.getElementById('ratioSelect'),
    themeSelect: document.getElementById('themeSelect'),
    voiceSelect: document.getElementById('voiceSelect'),
    rateRange: document.getElementById('rateRange'),
    rateVal: document.getElementById('rateVal'),
    voiceTestBtn: document.getElementById('voiceTestBtn'),
    captureVoice: document.getElementById('captureVoice'),
    voHint: document.getElementById('voHint'),
    addSlideBtn: document.getElementById('addSlideBtn'),
    slideList: document.getElementById('slideList'),
    slidesEmpty: document.getElementById('slidesEmpty'),
    toast: document.getElementById('toast')
  };

  var state = {
    ratio: '16:9',
    theme: 'aurora',
    slides: [],
    vo: { voiceURI: '', rate: 1, capture: false }
  };
  var selected = 0;
  var rows = [];
  var mode = null;            // null | 'preview' | 'record'
  var rafId = 0;
  var startedAt = 0;
  var recorder = null;
  var chunks = [];
  var takeUrl = '';
  var saveTimer = 0;

  /* ---------- storage ---------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function normalizeSlide(raw) {
    var text = raw && typeof raw.text === 'string' ? raw.text : '';
    var vo = raw && typeof raw.narration === 'string' ? raw.narration : '';
    var dur = Number(raw && raw.duration);
    return {
      id: raw && raw.id ? String(raw.id) : uid(),
      text: text,
      narration: vo.slice(0, MAX_VO),
      duration: clamp(Number.isFinite(dur) && dur ? dur : 3, MIN_DUR, MAX_DUR)
    };
  }

  function load() {
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (err) {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') raw = {};

    state.ratio = RATIOS[raw.ratio] ? raw.ratio : '16:9';
    state.theme = THEMES[raw.theme] ? raw.theme : 'aurora';
    state.slides = (Array.isArray(raw.slides) ? raw.slides : []).slice(0, MAX_SLIDES).map(normalizeSlide);

    var vo = raw.vo && typeof raw.vo === 'object' ? raw.vo : {};
    var rate = Number(vo.rate);
    state.vo = {
      voiceURI: typeof vo.voiceURI === 'string' ? vo.voiceURI : '',
      rate: clamp(Number.isFinite(rate) && rate ? rate : 1, 0.6, 1.6),
      capture: Boolean(vo.capture)
    };

    if (!state.slides.length) {
      state.slides = [
        normalizeSlide({ text: 'Apex Video', duration: 3, narration: 'This video was written and read on this device.' }),
        normalizeSlide({ text: 'Write a slide, add its voice-over, then generate the file.', duration: 4 })
      ];
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (err) {
        toast('Could not save - device storage may be full');
      }
    }, 250);
  }

  /* ---------- helpers ---------- */

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.toast.hidden = true; }, 3400);
  }

  function fmt(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function totalMs() {
    return state.slides.reduce(function (sum, s) { return sum + s.duration * 1000; }, 0);
  }

  function size() {
    return RATIOS[state.ratio] || RATIOS['16:9'];
  }

  function theme() {
    return THEMES[state.theme] || THEMES.aurora;
  }

  function rgba(hex, alpha) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var num = parseInt(h, 16);
    return 'rgba(' + ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255) + ',' + alpha + ')';
  }

  function setProgress(pct) {
    var value = clamp(Math.round(pct), 0, 100);
    el.recBar.style.width = value + '%';
    el.recTrack.setAttribute('aria-valuenow', String(value));
  }

  function refreshMeta() {
    var s = size();
    var n = state.slides.length;
    el.stageMeta.textContent = s.w + ' \u00D7 ' + s.h + ' \u00B7 ' +
      n + (n === 1 ? ' slide' : ' slides') + ' \u00B7 ' + fmt(totalMs());
  }

  /* ---------- voice-over ---------- */

  var voices = [];
  var spoken = null;          // the utterance currently playing
  var spokenIndex = -1;       // slide whose narration has started
  var captureStream = null;   // tab capture while narration is being recorded

  function synth() {
    return window.speechSynthesis || null;
  }

  function fillVoices() {
    var s = synth();
    voices = s ? s.getVoices() : [];
    if (!el.voiceSelect) return;
    el.voiceSelect.textContent = '';

    var list = voices.slice().sort(function (a, b) {
      return String(a.lang || '').localeCompare(String(b.lang || '')) || String(a.name).localeCompare(String(b.name));
    });

    if (!list.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = 'No voices on this device';
      el.voiceSelect.appendChild(none);
      el.voiceSelect.disabled = true;
      return;
    }

    el.voiceSelect.disabled = false;
    var groups = {};
    list.forEach(function (voice) {
      var lang = voice.lang || 'other';
      if (!groups[lang]) {
        groups[lang] = document.createElement('optgroup');
        groups[lang].label = lang;
        el.voiceSelect.appendChild(groups[lang]);
      }
      var option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = voice.name;
      groups[lang].appendChild(option);
    });

    var match = list.filter(function (v) { return v.voiceURI === state.vo.voiceURI; })[0];
    if (!match) match = list.filter(function (v) { return /^en/i.test(v.lang || ''); })[0] || list[0];
    state.vo.voiceURI = match.voiceURI;
    el.voiceSelect.value = match.voiceURI;
  }

  function voiceFor() {
    return voices.filter(function (v) { return v.voiceURI === state.vo.voiceURI; })[0] || null;
  }

  function stopVoice() {
    var s = synth();
    spoken = null;
    if (s && (s.speaking || s.pending)) s.cancel();
  }

  function speak(text) {
    var s = synth();
    var body = String(text || '').trim();
    if (!s || !body) return;

    stopVoice();
    var u = new SpeechSynthesisUtterance(body);
    var voice = voiceFor();
    if (voice) u.voice = voice;
    u.rate = state.vo.rate;
    u.pitch = 1;
    u.volume = 1;

    u.onend = function () { if (spoken === u) spoken = null; };
    u.onerror = function (event) {
      if (spoken !== u) return;
      if (event && (event.error === 'interrupted' || event.error === 'canceled')) return;
      spoken = null;
      toast('The voice stopped: ' + ((event && event.error) || 'unknown error'));
    };

    /* Chrome drops an utterance queued in the same task as cancel(). */
    spoken = u;
    setTimeout(function () {
      if (spoken !== u) return;
      s.speak(u);
    }, 60);
  }

  function narrationOf(slide) {
    return String((slide && slide.narration) || '').trim();
  }

  function narrationCount() {
    return state.slides.filter(function (s) { return narrationOf(s); }).length;
  }

  function estimate(text) {
    var words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    if (!words) return 0;
    return words / (WORDS_PER_SEC * state.vo.rate);
  }

  function wantsAudio() {
    return state.vo.capture && !!synth() && narrationCount() > 0;
  }

  function paintVoHint() {
    if (!el.voHint) return;
    var n = narrationCount();
    if (!synth()) {
      el.voHint.textContent = 'This browser has no speech synthesis, so the voice-over cannot be read here. The slides still render.';
    } else if (!n) {
      el.voHint.textContent = 'Write a voice-over under a slide and the device reads it as that slide appears. Nothing leaves the tab.';
    } else if (state.vo.capture) {
      el.voHint.textContent = n + ' of ' + state.slides.length +
        ' slides have a voice-over. Generating asks you to share this tab: pick it and tick \u201Cshare audio\u201D to catch the voice in the file.';
    } else {
      el.voHint.textContent = n + ' of ' + state.slides.length +
        ' slides have a voice-over. It plays live while the slides run; tick the box above to catch it in the file.';
    }
  }

  /* Must be called from the click itself: the browser only shows the share
     picker while the user gesture is still live. */
  function openCapture() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      toast('This browser cannot capture tab audio - recording silent');
      return Promise.resolve(false);
    }

    return navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: 'include'
    }).then(function (stream) {
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        toast('That share carried no audio - recording silent');
        return false;
      }
      captureStream = stream;
      return true;
    }).catch(function (err) {
      toast('Voice-over not captured (' + ((err && err.name) || 'not shared') + ') - recording silent');
      return false;
    });
  }

  function releaseCapture() {
    if (!captureStream) return;
    captureStream.getTracks().forEach(function (track) { track.stop(); });
    captureStream = null;
  }

  /* ---------- painting ---------- */

  function wrapLines(text, maxWidth) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean);
      if (!words.length) {
        out.push('');
        return;
      }
      var line = '';
      words.forEach(function (word) {
        var test = line ? line + ' ' + word : word;
        if (!line || ctx.measureText(test).width <= maxWidth) {
          line = test;
        } else {
          out.push(line);
          line = word;
        }
      });
      out.push(line);
    });
    return out.length ? out : [''];
  }

  function layoutText(text, maxWidth, maxHeight) {
    var start = Math.round(canvas.height * 0.11);
    var min = Math.round(canvas.height * 0.032);
    var step = Math.max(2, Math.round(canvas.height * 0.005));
    var best = null;

    for (var px = start; px >= min; px -= step) {
      ctx.font = FONT.replace('%s', String(px));
      var lines = wrapLines(text, maxWidth);
      var lh = px * 1.16;
      best = { px: px, lines: lines, lh: lh };
      if (lines.length * lh <= maxHeight) break;
    }
    ctx.font = FONT.replace('%s', String(best.px));
    return best;
  }

  function paint(index, elapsed) {
    var w = canvas.width;
    var h = canvas.height;
    var t = theme();
    var slide = state.slides[index] || state.slides[0] || { text: '', duration: 3 };
    var time = Number.isFinite(elapsed) ? elapsed : 9999;

    var bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, t.a);
    bg.addColorStop(1, t.b);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    /* A slow drifting glow keeps a static slide from looking frozen. */
    var cx = w * (0.5 + 0.14 * Math.sin(time / 2400));
    var cy = h * (0.36 + 0.1 * Math.cos(time / 2900));
    var glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.68);
    glow.addColorStop(0, rgba(t.glow, 0.3));
    glow.addColorStop(0.55, rgba(t.glow, 0.08));
    glow.addColorStop(1, rgba(t.glow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    /* Faint top rule with the accent colour. */
    ctx.fillStyle = rgba(t.glow, 0.55);
    ctx.fillRect(w * 0.5 - w * 0.03, h * 0.1, w * 0.06, Math.max(2, h * 0.005));

    var fade = clamp(time / FADE_MS, 0, 1);
    var eased = 1 - Math.pow(1 - fade, 3);
    var maxWidth = w * 0.82;
    var maxHeight = h * 0.62;
    var text = String(slide.text || '').trim();
    var box = layoutText(text || 'Empty slide', maxWidth, maxHeight);

    ctx.save();
    ctx.globalAlpha = eased;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = box.px * 0.35;
    ctx.shadowOffsetY = box.px * 0.05;
    ctx.fillStyle = text ? t.ink : rgba(t.ink, 0.45);

    var blockH = box.lines.length * box.lh;
    var startY = h * 0.53 - blockH / 2 + box.lh / 2 + (1 - eased) * h * 0.03;
    box.lines.forEach(function (line, i) {
      ctx.fillText(line, w / 2, startY + i * box.lh);
    });
    ctx.restore();

    /* Slide dots. */
    var n = state.slides.length;
    if (n > 1) {
      var gap = Math.max(14, w * 0.026);
      var dotY = h * 0.9;
      var dotR = Math.max(3, h * 0.008);
      var totalW = (n - 1) * gap;
      for (var i = 0; i < n; i++) {
        var x = w / 2 - totalW / 2 + i * gap;
        if (i === index) {
          ctx.fillStyle = rgba(t.glow, 0.95);
          var pillW = dotR * 3.4;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(x - pillW / 2, dotY - dotR, pillW, dotR * 2, dotR);
          } else {
            ctx.rect(x - pillW / 2, dotY - dotR, pillW, dotR * 2);
          }
          ctx.fill();
        } else {
          ctx.fillStyle = rgba(t.ink, 0.28);
          ctx.beginPath();
          ctx.arc(x, dotY, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function paintIdle() {
    selected = clamp(selected, 0, Math.max(0, state.slides.length - 1));
    paint(selected, FADE_MS);
  }

  function resizeCanvas() {
    var s = size();
    canvas.width = s.w;
    canvas.height = s.h;
    refreshMeta();
  }

  /* ---------- playback ---------- */

  function indexAt(ms) {
    var acc = 0;
    for (var i = 0; i < state.slides.length; i++) {
      acc += state.slides[i].duration * 1000;
      if (ms < acc) return { index: i, local: ms - (acc - state.slides[i].duration * 1000) };
    }
    var last = state.slides.length - 1;
    return { index: last, local: state.slides[last].duration * 1000 };
  }

  function tick(now) {
    if (!mode) return;
    var t = now - startedAt;
    var total = totalMs();
    if (t >= total) {
      paint(state.slides.length - 1, 9999);
      stopVoice();
      setProgress(100);
      el.recPct.textContent = mode === 'record' ? 'Finishing\u2026' : 'Done';
      if (mode === 'record') {
        mode = null;
        el.playBtn.disabled = false;
        el.playBtn.textContent = 'Preview';
        el.recordBtn.textContent = 'Generate video';
        el.statLine.textContent = 'Encoding the take\u2026';
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } else {
        mode = null;
        el.playBtn.disabled = false;
        el.playBtn.textContent = 'Preview';
        el.recordBtn.disabled = false;
        el.statLine.textContent = 'Text slides, recorded on this device.';
      }
      return;
    }

    var at = indexAt(t);
    paint(at.index, at.local);

    /* Each slide gets its own line; the previous one is cut off at the change. */
    if (at.index !== spokenIndex) {
      spokenIndex = at.index;
      var line = narrationOf(state.slides[at.index]);
      if (line) speak(line);
    }

    setProgress((t / total) * 100);
    el.recPct.textContent = 'Slide ' + (at.index + 1) + ' of ' + state.slides.length +
      ' \u00B7 ' + fmt(t) + ' / ' + fmt(total);
    rafId = requestAnimationFrame(tick);
  }

  function begin(next, withAudio) {
    if (mode) return false;
    if (!state.slides.length) {
      toast('Add a slide first');
      return false;
    }
    if (next === 'record' && !canRecord(withAudio)) return false;
    if (next === 'record' && !startRecorder(withAudio)) return false;

    mode = next;
    spokenIndex = -1;
    selected = 0;
    paintIdle();
    setProgress(0);
    el.playBtn.disabled = next === 'record';
    el.playBtn.textContent = next === 'preview' ? 'Stop' : 'Preview';
    el.recordBtn.disabled = false;
    el.recordBtn.textContent = next === 'record' ? 'Stop' : 'Generate video';
    el.statLine.textContent = next === 'record'
      ? (withAudio ? 'Recording with the voice-over\u2026' : 'Recording\u2026')
      : 'Previewing\u2026';

    startedAt = performance.now();
    rafId = requestAnimationFrame(tick);
    return true;
  }

  function stopPlayback(silent) {
    if (!mode) return;
    var was = mode;
    mode = null;
    spokenIndex = -1;
    stopVoice();
    cancelAnimationFrame(rafId);
    el.playBtn.disabled = false;
    el.playBtn.textContent = 'Preview';
    el.recordBtn.disabled = false;
    el.recordBtn.textContent = 'Generate video';
    el.statLine.textContent = 'Text slides, recorded on this device.';
    setProgress(0);
    el.recPct.textContent = 'Ready';
    paintIdle();

    if (was === 'record' && !silent) {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }
  }

  /* ---------- recording ---------- */

  function canRecord(withAudio) {
    if (!window.MediaRecorder || typeof canvas.captureStream !== 'function') {
      toast('This browser cannot record a canvas - no MediaRecorder support');
      return false;
    }
    if (!pickMime(withAudio)) {
      toast('This browser has no supported video format to record');
      return false;
    }
    return true;
  }

  function pickMime(withAudio) {
    if (!window.MediaRecorder) return '';
    var list = withAudio ? AUDIO_MIMES : MIMES;
    for (var i = 0; i < list.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(list[i])) return list[i];
      } catch (err) {
        /* ignore and try the next candidate */
      }
    }
    return '';
  }

  function startRecorder(withAudio) {
    var mime = pickMime(withAudio);
    if (!mime) return false;
    var stream;
    var muxed = false;
    try {
      stream = canvas.captureStream(30);
      if (withAudio && captureStream) {
        captureStream.getAudioTracks().forEach(function (track) { stream.addTrack(track); });
        muxed = true;
      }
      chunks = [];
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 6000000,
        audioBitsPerSecond: 128000
      });
    } catch (err) {
      toast('Could not start the recorder: ' + (err && err.message ? err.message : 'unknown error'));
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      releaseCapture();
      recorder = null;
      return false;
    }

    var active = recorder;

    recorder.ondataavailable = function (event) {
      if (event.data && event.data.size) chunks.push(event.data);
    };

    recorder.onstop = function () {
      stream.getTracks().forEach(function (track) { track.stop(); });
      releaseCapture();
      var type = active.mimeType || mime;
      finalize(new Blob(chunks, { type: type }), type, muxed);
      recorder = null;
    };

    recorder.onerror = function (event) {
      toast('Recording failed: ' + ((event && event.error && event.error.name) || 'unknown error'));
    };

    recorder.start(250);
    return true;
  }

  function finalize(blob, type, withAudio) {
    el.recordBtn.textContent = 'Generate video';
    el.recordBtn.disabled = false;
    el.playBtn.disabled = false;
    el.playBtn.textContent = 'Preview';
    el.statLine.textContent = 'Text slides, recorded on this device.';
    el.recPct.textContent = 'Ready';

    if (!blob.size) {
      toast('The recorder produced an empty file - try again');
      return;
    }

    if (takeUrl) URL.revokeObjectURL(takeUrl);
    takeUrl = URL.createObjectURL(blob);

    var ext = /mp4/i.test(type) ? 'mp4' : 'webm';
    var stamp = new Date();
    var name = 'apex-video-' + stamp.getFullYear() +
      pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' +
      pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + '.' + ext;

    el.player.src = takeUrl;
    el.downloadLink.href = takeUrl;
    el.downloadLink.download = name;
    el.downloadLink.hidden = false;
    el.take.hidden = false;

    var label = /mp4/i.test(type) ? 'MP4' : /vp9/i.test(type) ? 'WebM \u00B7 VP9' : /vp8/i.test(type) ? 'WebM \u00B7 VP8' : 'WebM';
    el.takeMeta.textContent = label + ' \u00B7 ' + size().w + ' \u00D7 ' + size().h + ' \u00B7 ' +
      fmt(totalMs()) + ' \u00B7 ' + kb(blob.size) + ' \u00B7 ' + (withAudio ? 'voice-over audio' : 'silent');

    toast('Video ready - ' + name);
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function kb(bytes) {
    return bytes >= 1024 * 1024
      ? (bytes / (1024 * 1024)).toFixed(1) + ' MB'
      : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  /* ---------- slide editor ---------- */

  function setActive(index) {
    selected = index;
    rows.forEach(function (row, i) {
      row.classList.toggle('active', i === index);
    });
  }

  function buildRows() {
    el.slideList.textContent = '';
    rows = [];
    el.slidesEmpty.hidden = state.slides.length !== 0;
    el.addSlideBtn.disabled = state.slides.length >= MAX_SLIDES;

    state.slides.forEach(function (slide, index) {
      var li = document.createElement('li');
      li.className = 'slide';

      var area = document.createElement('textarea');
      area.value = slide.text;
      area.rows = 2;
      area.maxLength = 240;
      area.setAttribute('aria-label', 'Slide ' + (index + 1) + ' text');
      area.addEventListener('input', function () {
        slide.text = area.value;
        if (selected === index) paintIdle();
        save();
      });
      area.addEventListener('focus', function () { setActive(index); paintIdle(); });
      area.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          begin('preview');
        }
      });

      var side = document.createElement('div');
      side.className = 'slide-side';

      var durWrap = document.createElement('label');
      durWrap.className = 'dur';
      durWrap.textContent = 'sec';
      var dur = document.createElement('input');
      dur.type = 'number';
      dur.min = String(MIN_DUR);
      dur.max = String(MAX_DUR);
      dur.step = '1';
      dur.value = String(slide.duration);
      dur.setAttribute('aria-label', 'Slide ' + (index + 1) + ' seconds');
      dur.addEventListener('input', function () {
        var value = Number(dur.value);
        if (!Number.isFinite(value)) return;
        slide.duration = clamp(Math.round(value), MIN_DUR, MAX_DUR);
        refreshMeta();
        syncEst();
        save();
      });
      dur.addEventListener('blur', function () {
        dur.value = String(slide.duration);
      });
      durWrap.insertBefore(dur, durWrap.firstChild);

      var tools = document.createElement('div');
      tools.className = 'slide-tools';

      var up = document.createElement('button');
      up.type = 'button';
      up.textContent = '\u2191';
      up.title = 'Move up';
      up.setAttribute('aria-label', 'Move slide ' + (index + 1) + ' up');
      up.disabled = index === 0;
      up.addEventListener('click', function () { move(index, -1); });

      var down = document.createElement('button');
      down.type = 'button';
      down.textContent = '\u2193';
      down.title = 'Move down';
      down.setAttribute('aria-label', 'Move slide ' + (index + 1) + ' down');
      down.disabled = index === state.slides.length - 1;
      down.addEventListener('click', function () { move(index, 1); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '\u00D7';
      del.title = 'Delete slide';
      del.setAttribute('aria-label', 'Delete slide ' + (index + 1));
      del.disabled = state.slides.length <= 1;
      del.addEventListener('click', function () { remove(index); });

      tools.appendChild(up);
      tools.appendChild(down);
      tools.appendChild(del);

      side.appendChild(durWrap);
      side.appendChild(tools);

      /* The voice-over line: what this slide says, read by the chosen voice. */
      var voLine = document.createElement('div');
      voLine.className = 'vo-line';

      var voField = document.createElement('textarea');
      voField.className = 'vo-text';
      voField.rows = 1;
      voField.maxLength = MAX_VO;
      voField.placeholder = 'Voice-over for this slide (optional)';
      voField.value = slide.narration || '';
      voField.setAttribute('aria-label', 'Slide ' + (index + 1) + ' voice-over');
      voField.addEventListener('focus', function () { setActive(index); });
      voField.addEventListener('input', function () {
        slide.narration = voField.value;
        syncEst();
        paintVoHint();
        save();
      });

      var say = document.createElement('button');
      say.type = 'button';
      say.className = 'say';
      say.textContent = '\u25B6';
      say.title = 'Read this voice-over';
      say.setAttribute('aria-label', 'Read slide ' + (index + 1) + ' voice-over');
      say.addEventListener('click', function () {
        setActive(index);
        paintIdle();
        if (!narrationOf(slide)) {
          toast('No voice-over on this slide yet');
          return;
        }
        speak(slide.narration);
      });

      var est = document.createElement('button');
      est.type = 'button';
      est.className = 'est';
      est.addEventListener('click', function () {
        var secs = estimate(slide.narration);
        if (!secs) return;
        slide.duration = clamp(Math.round(secs), MIN_DUR, MAX_DUR);
        dur.value = String(slide.duration);
        refreshMeta();
        syncEst();
        save();
      });

      function syncEst() {
        var secs = estimate(slide.narration);
        var over = secs > slide.duration;
        est.hidden = !secs;
        est.textContent = secs ? '\u2248' + Math.ceil(secs) + 's' : '';
        est.classList.toggle('over', over);
        est.title = over
          ? 'About ' + Math.ceil(secs) + 's of speech in a ' + slide.duration + 's slide - click to fit the slide to it'
          : 'About ' + Math.ceil(secs) + 's of speech - click to set the slide to that length';
      }

      syncEst();

      voLine.appendChild(voField);
      voLine.appendChild(say);
      voLine.appendChild(est);

      li.appendChild(area);
      li.appendChild(side);
      li.appendChild(voLine);
      el.slideList.appendChild(li);
      rows.push(li);
    });

    setActive(clamp(selected, 0, Math.max(0, state.slides.length - 1)));
  }

  function addSlide() {
    if (state.slides.length >= MAX_SLIDES) {
      toast('That is the most slides this app keeps');
      return;
    }
    state.slides.push(normalizeSlide({ text: 'New slide', duration: 3 }));
    selected = state.slides.length - 1;
    buildRows();
    paintIdle();
    save();
    var area = el.slideList.querySelectorAll('textarea')[selected];
    if (area) {
      area.focus();
      area.select();
    }
  }

  function move(index, delta) {
    var to = index + delta;
    if (to < 0 || to >= state.slides.length) return;
    var item = state.slides.splice(index, 1)[0];
    state.slides.splice(to, 0, item);
    selected = to;
    buildRows();
    paintIdle();
    save();
  }

  function remove(index) {
    if (state.slides.length <= 1) {
      toast('Keep at least one slide');
      return;
    }
    state.slides.splice(index, 1);
    selected = clamp(index, 0, state.slides.length - 1);
    buildRows();
    paintIdle();
    save();
  }

  /* ---------- wiring ---------- */

  el.playBtn.addEventListener('click', function () {
    if (mode === 'preview') {
      stopPlayback(true);
      return;
    }
    begin('preview');
  });

  el.recordBtn.addEventListener('click', function () {
    if (mode === 'record') {
      stopPlayback(false);
      return;
    }

    if (!wantsAudio()) {
      begin('record', false);
      return;
    }

    /* Ask for the tab first, while the click is still a live gesture. */
    el.recordBtn.disabled = true;
    el.statLine.textContent = 'Waiting for the tab to be shared\u2026';
    openCapture().then(function (ok) {
      el.recordBtn.disabled = false;
      begin('record', ok);
    });
  });

  el.ratioSelect.addEventListener('change', function () {
    state.ratio = RATIOS[el.ratioSelect.value] ? el.ratioSelect.value : '16:9';
    resizeCanvas();
    paintIdle();
    save();
  });

  el.themeSelect.addEventListener('change', function () {
    state.theme = THEMES[el.themeSelect.value] ? el.themeSelect.value : 'aurora';
    paintIdle();
    save();
  });

  el.addSlideBtn.addEventListener('click', addSlide);

  if (el.voiceSelect) {
    el.voiceSelect.addEventListener('change', function () {
      state.vo.voiceURI = el.voiceSelect.value;
      save();
    });
  }

  if (el.rateRange) {
    el.rateRange.addEventListener('input', function () {
      var value = Number(el.rateRange.value);
      state.vo.rate = clamp(Number.isFinite(value) ? value : 1, 0.6, 1.6);
      if (el.rateVal) el.rateVal.textContent = rateLabel();
      save();
    });
    /* Rebuilding the rows is what refreshes every slide's spoken estimate. */
    el.rateRange.addEventListener('change', function () { buildRows(); });
  }

  if (el.captureVoice) {
    el.captureVoice.addEventListener('change', function () {
      state.vo.capture = el.captureVoice.checked;
      paintVoHint();
      save();
    });
  }

  if (el.voiceTestBtn) {
    el.voiceTestBtn.addEventListener('click', function () {
      if (!synth()) {
        toast('This browser has no speech synthesis');
        return;
      }
      speak(narrationOf(state.slides[selected]) || 'Apex Video. This is how the voice-over will sound.');
    });
  }

  el.player.addEventListener('play', function () {
    if (mode === null) el.statLine.textContent = 'Playing the take';
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (mode) stopPlayback(false);
    else stopVoice();
  });

  function rateLabel() {
    return (Math.round(state.vo.rate * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + '\u00D7';
  }

  window.addEventListener('pagehide', function () {
    mode = null;
    cancelAnimationFrame(rafId);
    stopVoice();
    releaseCapture();
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (err) { /* the page is going away */ }
    }
    if (takeUrl) URL.revokeObjectURL(takeUrl);
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  /* ---------- boot ---------- */

  load();
  el.ratioSelect.value = state.ratio;
  el.themeSelect.value = state.theme;

  fillVoices();
  if (synth()) {
    var s = synth();
    if (typeof s.addEventListener === 'function') {
      s.addEventListener('voiceschanged', fillVoices);
    } else {
      s.onvoiceschanged = fillVoices;
    }
  }
  if (el.captureVoice) el.captureVoice.checked = state.vo.capture;
  if (el.rateRange) el.rateRange.value = String(state.vo.rate);
  if (el.rateVal) el.rateVal.textContent = rateLabel();
  paintVoHint();

  resizeCanvas();
  buildRows();
  paintIdle();
  setProgress(0);
  el.recPct.textContent = 'Ready';

  if (!window.MediaRecorder || typeof canvas.captureStream !== 'function' || !pickMime()) {
    el.recordBtn.disabled = true;
    el.recordBtn.title = 'This browser cannot record a canvas to a video file';
  }
})();
