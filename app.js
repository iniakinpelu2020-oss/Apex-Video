/* Apex Video - text slides rendered on a canvas and recorded to a video file.
 *
 * The whole pipeline is local: canvas frames -> captureStream -> MediaRecorder.
 * The file has no audio track, because speech synthesis cannot be captured into
 * a media stream; that is a browser limit, not a setting here.
 *
 *   localStorage  apex.video.v1  { ratio, theme, slides }
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
  var MIN_DUR = 1;
  var MAX_DUR = 15;
  var FADE_MS = 420;
  var FONT = '700 %spx ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var MAX_SLIDES = 24;

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
    addSlideBtn: document.getElementById('addSlideBtn'),
    slideList: document.getElementById('slideList'),
    slidesEmpty: document.getElementById('slidesEmpty'),
    toast: document.getElementById('toast')
  };

  var state = { ratio: '16:9', theme: 'aurora', slides: [] };
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
    var dur = Number(raw && raw.duration);
    return {
      id: raw && raw.id ? String(raw.id) : uid(),
      text: text,
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

    if (!state.slides.length) {
      state.slides = [
        normalizeSlide({ text: 'Apex Video', duration: 3 }),
        normalizeSlide({ text: 'Write a slide, set how long it shows, then generate the file.', duration: 4 })
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
    setProgress((t / total) * 100);
    el.recPct.textContent = 'Slide ' + (at.index + 1) + ' of ' + state.slides.length +
      ' \u00B7 ' + fmt(t) + ' / ' + fmt(total);
    rafId = requestAnimationFrame(tick);
  }

  function begin(next) {
    if (mode) return;
    if (!state.slides.length) {
      toast('Add a slide first');
      return;
    }
    if (next === 'record' && !canRecord()) return;
    if (next === 'record' && !startRecorder()) return;

    mode = next;
    selected = 0;
    paintIdle();
    setProgress(0);
    el.playBtn.disabled = next === 'record';
    el.playBtn.textContent = next === 'preview' ? 'Stop' : 'Preview';
    el.recordBtn.disabled = false;
    el.recordBtn.textContent = next === 'record' ? 'Stop' : 'Generate video';
    el.statLine.textContent = next === 'record' ? 'Recording\u2026' : 'Previewing\u2026';

    startedAt = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback(silent) {
    if (!mode) return;
    var was = mode;
    mode = null;
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

  function canRecord() {
    if (!window.MediaRecorder || typeof canvas.captureStream !== 'function') {
      toast('This browser cannot record a canvas - no MediaRecorder support');
      return false;
    }
    if (!pickMime()) {
      toast('This browser has no supported video format to record');
      return false;
    }
    return true;
  }

  function pickMime() {
    if (!window.MediaRecorder) return '';
    for (var i = 0; i < MIMES.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(MIMES[i])) return MIMES[i];
      } catch (err) {
        /* ignore and try the next candidate */
      }
    }
    return '';
  }

  function startRecorder() {
    var mime = pickMime();
    if (!mime) return false;
    var stream;
    try {
      stream = canvas.captureStream(30);
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
    } catch (err) {
      toast('Could not start the recorder: ' + (err && err.message ? err.message : 'unknown error'));
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      recorder = null;
      return false;
    }

    var active = recorder;

    recorder.ondataavailable = function (event) {
      if (event.data && event.data.size) chunks.push(event.data);
    };

    recorder.onstop = function () {
      stream.getTracks().forEach(function (track) { track.stop(); });
      var type = active.mimeType || mime;
      finalize(new Blob(chunks, { type: type }), type);
      recorder = null;
    };

    recorder.onerror = function (event) {
      toast('Recording failed: ' + ((event && event.error && event.error.name) || 'unknown error'));
    };

    recorder.start(250);
    return true;
  }

  function finalize(blob, type) {
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
      fmt(totalMs()) + ' \u00B7 ' + kb(blob.size) + ' \u00B7 silent';

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

      li.appendChild(area);
      li.appendChild(side);
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
    begin('record');
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

  el.player.addEventListener('play', function () {
    if (mode === null) el.statLine.textContent = 'Playing the take';
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (mode) stopPlayback(false);
  });

  window.addEventListener('pagehide', function () {
    mode = null;
    cancelAnimationFrame(rafId);
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
