/* Gamaka Annotator
 * Boundaries ("pauses") split the song into sections; every section between
 * two consecutive boundaries is one gamaka. Each section is keyed by the id of
 * the boundary that starts it, so names survive dragging/undo/redo.
 */
(() => {
  'use strict';

  const STORE_KEY = 'gamakaAnnotator.v1';
  const DEFAULT_GAMAKAS = [
    'Kampita', 'Jaaru (Etra)', 'Jaaru (Irakka)', 'Nokku', 'Odukkal', 'Orikai',
    'Spurita', 'Pratyahata', 'Kandippu', 'Vali', 'Ravai', 'Ahata', 'Andolita',
    'Tripuchcha', 'Murchana', 'Dhalu', 'Aarohana', 'Avarohana', 'Plain (no gamaka)',
  ];
  const MIN_GAP = 0.02; // seconds; ignore boundaries closer than this

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $('fileInput'), dropZone: $('dropZone'), editor: $('editor'),
    songName: $('songName'), curTime: $('curTime'), totTime: $('totTime'),
    playBtn: $('playBtn'), markBtn: $('markBtn'), undoBtn: $('undoBtn'), redoBtn: $('redoBtn'),
    clearBtn: $('clearBtn'), seek: $('seek'), seekCur: $('seekCur'), seekTot: $('seekTot'), volume: $('volume'), speed: $('speed'), zoom: $('zoom'), markOnPause: $('markOnPause'),
    includeBlank: $('includeBlank'), segBody: $('segBody'), segEmpty: $('segEmpty'),
    segCount: $('segCount'), exportBtn: $('exportBtn'), exportAllBtn: $('exportAllBtn'),
    library: $('library'), lane: $('lane'), laneInner: $('laneInner'),
    gamakaList: $('gamakaList'), toast: $('toast'),
    pitchWrap: $('pitchWrap'), pitchCanvas: $('pitchCanvas'), pitchHead: $('pitchHead'),
    pitchReadout: $('pitchReadout'), pitchStatus: $('pitchStatus'), saNote: $('saNote'),
    saHz: $('saHz'), saAuto: $('saAuto'), strictness: $('strictness'), vocalInput: $('vocalInput'),
  };

  // ---------- State ----------
  let song = null;          // { key, fileName, songName, duration }
  let markers = [];         // [{ id, t }] kept sorted by t
  let names = {};           // segmentId (start marker id) -> gamaka name
  let undoStack = [];
  let redoStack = [];
  let stopAt = null;        // end time when playing a single section
  let objectUrl = null;
  let nextId = 1;
  let activeSegId = null;
  let seeking = false;      // true while the seek bar is being dragged
  let pitch = null;         // { raw, midi, range: {lo, hi}, kind, name } from PitchTracker
  let pitchToken = 0;       // ignores results from an analysis that was superseded
  let pitchVersion = 0;     // bump to force the pitch canvas to redraw

  const newId = () => `m${Date.now().toString(36)}${(nextId++).toString(36)}`;

  // ---------- Helpers ----------
  function fmt(t) {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
  const round3 = (x) => Math.round(x * 1000) / 1000;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  function segments() {
    const out = [];
    for (let i = 0; i < markers.length - 1; i++) {
      const a = markers[i], b = markers[i + 1];
      out.push({ id: a.id, index: i + 1, start: a.t, end: b.t, name: names[a.id] || '' });
    }
    return out;
  }

  const isTyping = (el) => el && (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number') || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

  // ---------- Storage ----------
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { songs: {} }; }
    catch { return { songs: {} }; }
  }
  function writeStore(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) { console.warn('Could not save', e); }
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }
  function saveNow() {
    if (!song) return;
    const store = loadStore();
    store.songs[song.key] = {
      fileName: song.fileName,
      songName: song.songName,
      duration: song.duration,
      saHz: song.saHz || null,
      markers,
      names,
      updatedAt: new Date().toISOString(),
    };
    writeStore(store);
    renderLibrary();
    refreshSuggestions();
  }

  // ---------- History (undo / redo) ----------
  const snapshot = () => JSON.stringify({ markers, names });
  function restore(snap) {
    const s = JSON.parse(snap);
    markers = s.markers;
    names = s.names;
  }
  function pushHistory(snap = snapshot()) {
    undoStack.push(snap);
    if (undoStack.length > 500) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    changed();
    toast('Undone');
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    changed();
    toast('Redone');
  }
  function updateHistoryButtons() {
    els.undoBtn.disabled = !undoStack.length;
    els.redoBtn.disabled = !redoStack.length;
  }

  // ---------- Mutations ----------
  function addMarker(t) {
    if (!song) return;
    t = round3(Math.max(0, Math.min(t, song.duration)));
    if (markers.some((m) => Math.abs(m.t - t) < MIN_GAP)) return;
    pushHistory();
    markers.push({ id: newId(), t });
    markers.sort((a, b) => a.t - b.t);
    changed();
  }

  function removeMarker(id) {
    pushHistory();
    markers = markers.filter((m) => m.id !== id);
    delete names[id];
    changed();
  }

  function moveMarker(id, t) {
    const m = markers.find((x) => x.id === id);
    if (!m) return;
    t = round3(Math.max(0, Math.min(t, song.duration)));
    if (Math.abs(m.t - t) < 0.001) return;
    pushHistory();
    m.t = t;
    markers.sort((a, b) => a.t - b.t);
    changed();
  }

  function changed() {
    pitchVersion++;
    updateHistoryButtons();
    renderRegions();
    renderTable();
    renderLane();
    scheduleSave();
  }

  // ---------- WaveSurfer ----------
  const css = getComputedStyle(document.documentElement);
  const cssVar = (n) => css.getPropertyValue(n).trim();

  const regions = WaveSurfer.Regions.create();
  const ws = WaveSurfer.create({
    container: '#waveform',
    height: 150,
    waveColor: cssVar('--wave'),
    progressColor: cssVar('--wave-done'),
    cursorColor: '#1f1b16',
    cursorWidth: 3,
    normalize: true,
    autoScroll: true,
    autoCenter: true,
    dragToSeek: true,
    plugins: [
      regions,
      WaveSurfer.Timeline.create({ container: '#timeline', height: 18, style: { fontSize: '11px', color: cssVar('--muted') } }),
    ],
  });

  let rendering = false;
  function renderRegions() {
    rendering = true;
    regions.clearRegions();
    if (song) {
      segments().forEach((s, i) => {
        const label = document.createElement('div');
        label.textContent = `#${s.index}`;
        label.style.cssText = 'font:600 11px system-ui;color:#5a5047;padding:2px 4px;pointer-events:none';
        const r = regions.addRegion({
          id: `seg:${s.id}`,
          start: s.start,
          end: s.end,
          color: i % 2 ? cssVar('--seg-b') : cssVar('--seg-a'),
          drag: false,
          resize: false,
          content: label,
        });
        r.element.style.pointerEvents = 'none'; // let clicks/drags reach the waveform to seek
      });
      markers.forEach((m) => {
        regions.addRegion({
          id: `mk:${m.id}`,
          start: m.t,
          color: cssVar('--marker'),
          drag: true,
          resize: false,
        });
      });
    }
    rendering = false;
  }

  regions.on('region-updated', (r) => {
    if (rendering || !r.id.startsWith('mk:')) return;
    const id = r.id.slice(3);
    setTimeout(() => moveMarker(id, r.start), 0); // defer: don't rebuild regions inside their own event
  });

  regions.on('region-double-clicked', (r, e) => {
    if (!r.id.startsWith('mk:')) return;
    e.stopPropagation();
    const id = r.id.slice(3);
    setTimeout(() => { removeMarker(id); toast('Boundary removed (Ctrl+Z to undo)'); }, 0);
  });

  ws.on('ready', () => {
    song.duration = ws.getDuration();
    els.totTime.textContent = fmt(song.duration);
    els.seekTot.textContent = fmt(song.duration);
    els.seek.max = song.duration;
    changed();
  });

  function showTime(t) {
    els.curTime.textContent = fmt(t);
    els.seekCur.textContent = fmt(t);
    if (!seeking) els.seek.value = t;
  }
  ws.on('seeking', showTime);
  ws.on('drag', (rel) => showTime(rel * ws.getDuration())); // live while dragging the playhead
  ws.on('timeupdate', (t) => {
    showTime(t);
    if (stopAt !== null && t >= stopAt) {
      stopAt = null;
      ws.pause();
    }
    highlightActive(t);
  });

  ws.on('play', () => { els.playBtn.textContent = '❚❚ Pause'; });
  ws.on('pause', () => { els.playBtn.textContent = '▶ Play'; });
  ws.on('finish', () => { els.playBtn.textContent = '▶ Play'; });

  // ---------- Playback controls ----------
  function togglePlay({ mark }) {
    if (!song) return;
    stopAt = null;
    if (ws.isPlaying()) {
      ws.pause();
      if (mark) addMarker(ws.getCurrentTime());
    } else {
      ws.play();
    }
  }

  function playSegment(seg) {
    stopAt = seg.end;
    ws.setTime(seg.start);
    ws.play();
  }

  function seekBy(dt) {
    if (!song) return;
    ws.setTime(Math.max(0, Math.min(song.duration, ws.getCurrentTime() + dt)));
  }

  // ---------- Table ----------
  function renderTable() {
    const segs = segments();
    els.segCount.textContent = segs.length;
    els.segEmpty.hidden = segs.length > 0;
    els.segBody.innerHTML = segs.map((s, i) => `
      <tr data-id="${s.id}">
        <td><span class="swatch" style="background:${i % 2 ? cssVar('--seg-b') : cssVar('--seg-a')};outline:1px solid ${i % 2 ? 'rgba(180,68,31,.5)' : 'rgba(31,111,139,.5)'}"></span>${s.index}</td>
        <td class="mono">${fmt(s.start)}</td>
        <td class="mono">${fmt(s.end)}</td>
        <td class="mono">${(s.end - s.start).toFixed(2)}</td>
        <td><input type="text" class="name-input" data-id="${s.id}" list="gamakaList" placeholder="Gamaka type…" value="${escapeHtml(s.name)}" /></td>
        <td><button class="btn small play-seg" data-id="${s.id}" title="Play only this section">▶ Play</button></td>
      </tr>`).join('');
    activeSegId = null;
    highlightActive(ws.getCurrentTime());
  }

  els.segBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.play-seg');
    if (!btn) return;
    const seg = segments().find((s) => s.id === btn.dataset.id);
    if (seg) playSegment(seg);
  });

  // ---------- Name lane (inputs aligned under the waveform) ----------
  function renderLane() {
    const segs = segments();
    els.laneInner.innerHTML = segs.map((s, i) => `
      <div class="lane-slot ${i % 2 ? 'b' : 'a'}" data-id="${s.id}" data-start="${s.start}" data-end="${s.end}">
        <input type="text" class="name-input ${s.name ? 'filled' : ''}" data-id="${s.id}" list="gamakaList"
          placeholder="#${s.index}" title="#${s.index}  ${fmt(s.start)} – ${fmt(s.end)}" value="${escapeHtml(s.name)}" />
      </div>`).join('');
    lastLane = { width: -1, scroll: -1 };
    syncLane();
  }

  let lastLane = { width: -1, scroll: -1 };
  function syncLane() {
    if (!song || !song.duration) return;
    const width = ws.getWrapper().getBoundingClientRect().width;
    const scroll = ws.getScroll();
    if (width === lastLane.width && scroll === lastLane.scroll) return;
    const widthChanged = width !== lastLane.width;
    lastLane = { width, scroll };
    els.laneInner.style.width = `${width}px`;
    els.laneInner.style.transform = `translateX(${-scroll}px)`;
    if (widthChanged) {
      const pps = width / song.duration;
      els.laneInner.querySelectorAll('.lane-slot').forEach((slot) => {
        const left = +slot.dataset.start * pps;
        const w = (+slot.dataset.end - +slot.dataset.start) * pps;
        slot.style.left = `${left}px`;
        slot.style.width = `${Math.max(w, 6)}px`;
        slot.classList.toggle('tiny', w < 48);
      });
    }
  }

  // ---------- Pitch panel ----------
  const SVARAS = ['S', 'R₁', 'R₂', 'G₂', 'G₃', 'M₁', 'M₂', 'P', 'D₁', 'D₂', 'N₂', 'N₃'];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const KATTAI = ['1', '1½', '2', '2½', '3', '4', '4½', '5', '5½', '6', '6½', '7'];
  const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Svara label for a whole number of semitones from Sa; dots mark tara (above) / mandra (below).
  function svaraLabel(semi) {
    const deg = ((semi % 12) + 12) % 12;
    const oct = Math.floor(semi / 12);
    const name = SVARAS[deg];
    const mark = oct === 1 ? '̇' : oct >= 2 ? '̈' : oct === -1 ? '̣' : oct <= -2 ? '̤' : '';
    return name[0] + mark + name.slice(1);
  }

  // Sa picker: A2 (110 Hz) to D#4 (311 Hz) covers male and female shrutis
  els.saNote.innerHTML = '<option value="">Custom</option>' +
    Array.from({ length: 19 }, (_, k) => 45 + k).map((m) =>
      `<option value="${m}">${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1} · ${KATTAI[m % 12]} kattai · ${midiToHz(m).toFixed(1)} Hz</option>`
    ).join('');

  function updateSaInputs() {
    const hz = song?.saHz;
    els.saHz.value = hz ? hz.toFixed(1) : '';
    const m = hz ? hzToMidi(hz) : NaN;
    const near = Math.round(m);
    els.saNote.value = hz && Math.abs(m - near) < 0.15 && near >= 45 && near <= 63 ? String(near) : '';
  }

  function setSa(hz) {
    if (!song || !(hz >= 60 && hz <= 600)) return;
    song.saHz = hz;
    updateSaInputs();
    computeRange();
    pitchVersion++;
    scheduleSave();
  }

  function describeSa(hz) {
    const m = Math.round(hzToMidi(hz));
    return `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1} (${KATTAI[m % 12]} kattai, ${hz.toFixed(1)} Hz)`;
  }

  function setPitchStatus(msg) { els.pitchStatus.textContent = msg; }

  // Vertical range of the panel, in cents from Sa, fitted to the singing
  function computeRange() {
    if (!pitch || !song?.saHz) return;
    const sa = hzToMidi(song.saHz);
    const cents = [];
    for (let i = 0; i < pitch.midi.length; i++) if (!isNaN(pitch.midi[i])) cents.push((pitch.midi[i] - sa) * 100);
    if (cents.length < 20) { pitch.range = { lo: -500, hi: 1700 }; return; }
    cents.sort((a, b) => a - b);
    let lo = Math.floor((cents[Math.floor(cents.length * 0.01)] - 150) / 100) * 100;
    let hi = Math.ceil((cents[Math.floor(cents.length * 0.99)] + 150) / 100) * 100;
    if (hi - lo < 1400) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 700) / 100) * 100; hi = lo + 1400; }
    pitch.range = { lo: Math.max(lo, -2400), hi: Math.min(hi, 3600) };
  }

  function startPitch(file, kind) {
    const token = ++pitchToken;
    pitch = null;
    pitchVersion++;
    PitchTracker.analyze(file, (p, stage) => {
      if (token !== pitchToken) return;
      setPitchStatus(stage === 'decoding' ? 'Preparing audio for pitch…' : `Tracking pitch… ${Math.round(p * 100)}%`);
    }).then((raw) => {
      if (token !== pitchToken || !song) return;
      pitch = { raw, midi: PitchTracker.clean(raw, +els.strictness.value / 100), kind, name: file.name };
      const len = raw.hz.length * raw.dt;
      if (kind === 'vocal' && song.duration && Math.abs(len - song.duration) > 1) {
        toast(`Vocal track is ${fmt(len)} long but the song is ${fmt(song.duration)}; the pitch line may not line up`);
      }
      if (!song.saHz) {
        const guess = PitchTracker.estimateSa(pitch.midi);
        if (guess) { setSa(guess); toast(`Sa guessed as ${describeSa(guess)}. Check it by ear and change it if needed.`); }
      }
      updateSaInputs();
      computeRange();
      pitchVersion++;
      setPitchStatus(kind === 'vocal' ? `Pitch from vocal track: ${file.name}` : 'Pitch from the song mix');
    }).catch((err) => {
      if (token !== pitchToken) return;
      console.error(err);
      setPitchStatus('Pitch tracking failed for this file');
    });
  }

  const pctx = els.pitchCanvas.getContext('2d');
  let lastPitchKey = '';
  function drawPitch() {
    if (!song || !song.duration) return;
    const W = els.pitchWrap.clientWidth, H = els.pitchWrap.clientHeight;
    const fullW = ws.getWrapper().getBoundingClientRect().width;
    const scroll = ws.getScroll();
    const pps = fullW / song.duration;
    els.pitchHead.style.left = `${ws.getCurrentTime() * pps - scroll}px`;

    const key = `${W}|${H}|${fullW}|${scroll}|${pitchVersion}`;
    if (key === lastPitchKey || !W) return;
    lastPitchKey = key;

    const dpr = window.devicePixelRatio || 1;
    if (els.pitchCanvas.width !== Math.round(W * dpr) || els.pitchCanvas.height !== Math.round(H * dpr)) {
      els.pitchCanvas.width = Math.round(W * dpr);
      els.pitchCanvas.height = Math.round(H * dpr);
    }
    const c = pctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const t0 = scroll / pps, t1 = (scroll + W) / pps;
    const X = (t) => t * pps - scroll;

    // Sections and boundaries, matching the waveform
    segments().forEach((s, i) => {
      if (s.end < t0 || s.start > t1) return;
      c.fillStyle = i % 2 ? cssVar('--seg-b') : cssVar('--seg-a');
      c.fillRect(X(s.start), 0, X(s.end) - X(s.start), H);
    });
    c.fillStyle = cssVar('--marker');
    markers.forEach((m) => { if (m.t >= t0 && m.t <= t1) c.fillRect(Math.round(X(m.t)) - 1, 0, 2, H); });

    if (!pitch || !song.saHz || !pitch.range) {
      c.fillStyle = cssVar('--muted');
      c.font = '13px system-ui';
      c.textAlign = 'center';
      c.fillText(pitch ? 'Set Sa to see the svara grid' : 'The pitch line will appear here once analysis finishes', W / 2, H / 2);
      c.textAlign = 'left';
      return;
    }

    const sa = hzToMidi(song.saHz);
    const { lo, hi } = pitch.range;
    const pad = 8;
    const Y = (cents) => H - pad - ((cents - lo) / (hi - lo)) * (H - 2 * pad);
    const pxPerSemi = (H - 2 * pad) / ((hi - lo) / 100);

    // Svara grid: S and P stronger
    const labels = [];
    for (let semi = Math.ceil(lo / 100); semi <= Math.floor(hi / 100); semi++) {
      const deg = ((semi % 12) + 12) % 12;
      const strong = deg === 0 || deg === 7;
      const y = Math.round(Y(semi * 100)) + 0.5;
      c.strokeStyle = deg === 0 ? 'rgba(180,68,31,.55)' : strong ? 'rgba(180,68,31,.3)' : 'rgba(0,0,0,.07)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
      if (strong || pxPerSemi >= 11) labels.push([svaraLabel(semi), y, strong]);
    }

    // Contour
    const midi = pitch.midi, n = midi.length, { t0: ft0, dt } = pitch.raw;
    const i0 = Math.max(0, Math.floor((t0 - ft0) / dt) - 1);
    const i1 = Math.min(n - 1, Math.ceil((t1 - ft0) / dt) + 1);
    c.strokeStyle = c.fillStyle = '#16465a';
    if (1 / (dt * pps) > 1.5) {
      // Zoomed out: one min-max stroke per pixel column
      let col = null, mn = Infinity, mx = -Infinity;
      const flush = () => { if (col !== null && mn <= mx) c.fillRect(col, Y(mx) - 0.75, 1.5, Math.max(1.5, Y(mn) - Y(mx) + 1.5)); };
      for (let i = i0; i <= i1; i++) {
        const px = Math.floor(X(ft0 + i * dt));
        if (px !== col) { flush(); col = px; mn = Infinity; mx = -Infinity; }
        if (!isNaN(midi[i])) { const v = (midi[i] - sa) * 100; if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      flush();
    } else {
      c.lineWidth = 1.8;
      c.lineJoin = 'round';
      c.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        if (isNaN(midi[i])) { pen = false; continue; }
        const px = X(ft0 + i * dt), py = Y((midi[i] - sa) * 100);
        if (pen) c.lineTo(px, py); else c.moveTo(px, py);
        pen = true;
      }
      c.stroke();
    }

    // Labels last so they sit on top
    c.font = '600 11px system-ui';
    c.textBaseline = 'middle';
    labels.forEach(([txt, y, strong]) => {
      const w = c.measureText(txt).width + 8;
      c.fillStyle = 'rgba(252,251,248,.9)';
      c.fillRect(2, y - 7, w, 14);
      c.fillStyle = strong ? '#b4441f' : '#7a7064';
      c.fillText(txt, 6, y);
    });
    c.textBaseline = 'alphabetic';
  }

  // Hover readout and click/drag-to-seek on the pitch panel
  function pitchTimeAt(e) {
    const r = els.pitchWrap.getBoundingClientRect();
    const fullW = ws.getWrapper().getBoundingClientRect().width;
    return Math.max(0, Math.min(song.duration, (ws.getScroll() + e.clientX - r.left) / (fullW / song.duration)));
  }
  let pitchDragging = false;
  els.pitchWrap.addEventListener('pointerdown', (e) => {
    if (!song?.duration) return;
    pitchDragging = true;
    els.pitchWrap.setPointerCapture(e.pointerId);
    stopAt = null;
    ws.setTime(pitchTimeAt(e));
  });
  els.pitchWrap.addEventListener('pointerup', () => { pitchDragging = false; });
  els.pitchWrap.addEventListener('pointermove', (e) => {
    if (!song?.duration) return;
    const t = pitchTimeAt(e);
    if (pitchDragging) ws.setTime(t);
    let txt = fmt(t);
    if (pitch && song.saHz) {
      const m = pitch.midi[Math.round((t - pitch.raw.t0) / pitch.raw.dt)];
      if (m !== undefined && !isNaN(m)) {
        const cents = (m - hzToMidi(song.saHz)) * 100;
        const semi = Math.round(cents / 100);
        const off = Math.round(cents - semi * 100);
        txt += `   ${midiToHz(m).toFixed(1)} Hz   ${svaraLabel(semi)} ${off >= 0 ? '+' : ''}${off}¢`;
      } else {
        txt += '   (no pitch)';
      }
    }
    els.pitchReadout.textContent = txt;
    els.pitchReadout.hidden = false;
  });
  els.pitchWrap.addEventListener('pointerleave', () => { els.pitchReadout.hidden = true; });

  els.saNote.addEventListener('change', () => { if (els.saNote.value) setSa(midiToHz(+els.saNote.value)); });
  els.saHz.addEventListener('change', () => {
    const v = parseFloat(els.saHz.value);
    if (v >= 60 && v <= 600) setSa(v); else { toast('Sa should be between 60 and 600 Hz'); updateSaInputs(); }
  });
  els.saAuto.addEventListener('click', () => {
    if (!pitch) { toast('Wait for pitch analysis to finish'); return; }
    const guess = PitchTracker.estimateSa(pitch.midi);
    if (!guess) { toast('Not enough clear singing to guess Sa'); return; }
    setSa(guess);
    toast(`Sa guessed as ${describeSa(guess)}. If the line sits on P instead of S, pick the note a fifth lower.`);
  });
  let strictTimer = null;
  els.strictness.addEventListener('input', () => {
    clearTimeout(strictTimer);
    strictTimer = setTimeout(() => {
      if (!pitch) return;
      pitch.midi = PitchTracker.clean(pitch.raw, +els.strictness.value / 100);
      computeRange();
      pitchVersion++;
    }, 120);
  });
  els.vocalInput.addEventListener('change', () => {
    const f = els.vocalInput.files[0];
    els.vocalInput.value = '';
    if (f && song) startPitch(f, 'vocal');
  });

  // ---------- Shared name editing (table + lane) ----------
  let focusSnap = null;
  document.addEventListener('focusin', (e) => {
    if (e.target.classList?.contains('name-input')) focusSnap = snapshot();
  });
  document.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp.classList?.contains('name-input')) return;
    const id = inp.dataset.id;
    const v = inp.value;
    if (v.trim()) names[id] = v; else delete names[id];
    document.querySelectorAll(`.name-input[data-id="${id}"]`).forEach((other) => {
      if (other !== inp) other.value = v;
      other.classList.toggle('filled', !!v.trim());
    });
    scheduleSave();
  });
  document.addEventListener('change', (e) => {
    if (!e.target.classList?.contains('name-input')) return;
    if (focusSnap && focusSnap !== snapshot()) pushHistory(focusSnap);
    focusSnap = snapshot();
  });

  function highlightActive(t) {
    const seg = segments().find((s) => t >= s.start && t < s.end);
    const id = seg ? seg.id : null;
    if (id === activeSegId) return;
    activeSegId = id;
    els.segBody.querySelectorAll('tr').forEach((tr) => tr.classList.toggle('active', tr.dataset.id === id));
  }

  // ---------- Suggestions ----------
  function refreshSuggestions() {
    const set = new Set(DEFAULT_GAMAKAS);
    Object.values(loadStore().songs).forEach((s) => Object.values(s.names || {}).forEach((n) => n && set.add(n.trim())));
    Object.values(names).forEach((n) => n && set.add(n.trim()));
    els.gamakaList.innerHTML = [...set].map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  }

  // ---------- Loading songs ----------
  function loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|flac|ogg|aac|opus|webm)$/i.test(file.name)) {
      toast('That does not look like an audio file');
      return;
    }
    if (song) saveNow();
    const key = `${file.name}|${file.size}`;
    const saved = loadStore().songs[key];
    song = {
      key,
      fileName: file.name,
      songName: saved?.songName || file.name.replace(/\.[^.]+$/, ''),
      duration: 0,
      saHz: saved?.saHz || null,
    };
    markers = saved?.markers ? saved.markers.map((m) => ({ ...m })) : [];
    names = saved?.names ? { ...saved.names } : {};
    undoStack = [];
    redoStack = [];
    stopAt = null;
    updateHistoryButtons();

    els.songName.value = song.songName;
    els.dropZone.hidden = true;
    els.editor.hidden = false;
    els.exportBtn.disabled = false;
    els.zoom.value = 0;
    els.curTime.textContent = fmt(0);
    els.totTime.textContent = '…';
    regions.clearRegions();
    els.laneInner.innerHTML = '';
    els.segBody.innerHTML = '';

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    ws.load(objectUrl).catch((err) => {
      console.error(err);
      toast('Could not decode this audio file');
    });
    ws.setPlaybackRate(+els.speed.value, true);
    updateSaInputs();
    startPitch(file, 'mix');

    if (saved?.markers?.length) toast(`Restored ${saved.markers.length} boundaries from your last session`);
    renderLibrary();
  }

  els.fileInput.addEventListener('change', () => {
    loadFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    els.dropZone.classList.remove('over');
  }));
  document.addEventListener('drop', (e) => loadFile(e.dataTransfer?.files?.[0]));

  els.songName.addEventListener('input', () => {
    if (!song) return;
    song.songName = els.songName.value;
    scheduleSave();
  });

  // ---------- Buttons ----------
  // Keep buttons from taking focus so Space never "clicks" them.
  document.addEventListener('mousedown', (e) => { if (e.target.closest('button, label.btn')) e.preventDefault(); });

  els.playBtn.addEventListener('click', () => togglePlay({ mark: false }));
  els.markBtn.addEventListener('click', () => addMarker(ws.getCurrentTime()));
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  els.clearBtn.addEventListener('click', () => {
    if (!markers.length) return;
    if (!confirm('Remove all boundaries and names for this song? (You can still Undo.)')) return;
    pushHistory();
    markers = [];
    names = {};
    changed();
  });
  // Seek bar: move the playhead while dragging, without fighting timeupdate.
  els.seek.addEventListener('pointerdown', () => { seeking = true; });
  window.addEventListener('pointerup', () => { seeking = false; });
  els.seek.addEventListener('input', () => {
    if (!song) return;
    stopAt = null;
    ws.setTime(+els.seek.value);
  });
  els.seek.addEventListener('keydown', (e) => e.preventDefault()); // arrows/space are handled globally
  els.volume.addEventListener('input', () => ws.setVolume(+els.volume.value));
  els.speed.addEventListener('change', () => ws.setPlaybackRate(+els.speed.value, true));
  els.zoom.addEventListener('input', () => { if (song) ws.zoom(+els.zoom.value); });
  els.exportBtn.addEventListener('click', exportCurrent);
  els.exportAllBtn.addEventListener('click', exportAll);

  // ---------- Keyboard ----------
  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) {
      if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
      return;
    }
    if (!song) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) togglePlay({ mark: els.markOnPause.checked });
    } else if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (!ctrl && e.key.toLowerCase() === 'm') {
      addMarker(ws.getCurrentTime());
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seekBy(e.shiftKey ? -0.2 : -2);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seekBy(e.shiftKey ? 0.2 : 2);
    }
  });

  // ---------- Excel export ----------
  const HEADER = ['Song Name', 'S.No', 'Timestamp', 'Gamaka Type', 'Start (sec)', 'End (sec)', 'Duration (sec)'];
  const COLS = [{ wch: 28 }, { wch: 6 }, { wch: 22 }, { wch: 24 }, { wch: 11 }, { wch: 11 }, { wch: 13 }];

  function rowsFor(songName, segs, includeBlank) {
    return segs
      .filter((s) => includeBlank || s.name.trim())
      .map((s, i) => [
        songName,
        i + 1,
        `${fmt(s.start)} - ${fmt(s.end)}`,
        s.name.trim(),
        round3(s.start),
        round3(s.end),
        round3(s.end - s.start),
      ]);
  }

  function segsFromSaved(saved) {
    const ms = [...(saved.markers || [])].sort((a, b) => a.t - b.t);
    const out = [];
    for (let i = 0; i < ms.length - 1; i++) {
      out.push({ id: ms[i].id, start: ms[i].t, end: ms[i + 1].t, name: (saved.names || {})[ms[i].id] || '' });
    }
    return out;
  }

  function makeSheet(rows) {
    const sheet = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
    sheet['!cols'] = COLS;
    return sheet;
  }

  const safeFileName = (s) => (s || 'song').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'song';
  function sheetName(s, used) {
    let base = (s || 'Song').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Song';
    let name = base, n = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${n++}`;
    used.add(name.toLowerCase());
    return name;
  }

  function exportCurrent() {
    if (!song) return;
    saveNow();
    const songName = (song.songName || '').trim() || song.fileName;
    const rows = rowsFor(songName, segments(), els.includeBlank.checked);
    if (!rows.length) {
      toast('Nothing to export yet. Name at least one section, or tick "Include unnamed sections".');
      return;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, makeSheet(rows), sheetName(songName, new Set()));
    XLSX.writeFile(wb, `${safeFileName(songName)}_gamakas.xlsx`);
    toast(`Exported ${rows.length} gamaka${rows.length === 1 ? '' : 's'}`);
  }

  function exportAll() {
    if (song) saveNow();
    const songs = Object.values(loadStore().songs);
    const includeBlank = els.includeBlank.checked;
    const wb = XLSX.utils.book_new();
    const used = new Set(['all songs']);
    const all = [];
    const perSong = [];
    songs.forEach((s) => {
      const nm = (s.songName || '').trim() || s.fileName;
      const rows = rowsFor(nm, segsFromSaved(s), includeBlank);
      if (rows.length) { all.push(...rows); perSong.push([nm, rows]); }
    });
    if (!all.length) { toast('No named gamakas saved yet'); return; }
    XLSX.utils.book_append_sheet(wb, makeSheet(all), 'All Songs');
    perSong.forEach(([nm, rows]) => XLSX.utils.book_append_sheet(wb, makeSheet(rows), sheetName(nm, used)));
    XLSX.writeFile(wb, `gamaka_annotations_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast(`Exported ${all.length} gamakas from ${perSong.length} song${perSong.length === 1 ? '' : 's'}`);
  }

  function exportSaved(key) {
    const s = loadStore().songs[key];
    if (!s) return;
    const nm = (s.songName || '').trim() || s.fileName;
    const rows = rowsFor(nm, segsFromSaved(s), els.includeBlank.checked);
    if (!rows.length) { toast('This song has no named gamakas'); return; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, makeSheet(rows), sheetName(nm, new Set()));
    XLSX.writeFile(wb, `${safeFileName(nm)}_gamakas.xlsx`);
  }

  // ---------- Library ----------
  function renderLibrary() {
    const store = loadStore();
    const entries = Object.entries(store.songs).sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''));
    els.exportAllBtn.disabled = !entries.length;
    if (!entries.length) {
      els.library.innerHTML = '<li class="lib-empty">Nothing yet. Upload a song to start annotating.</li>';
      return;
    }
    els.library.innerHTML = entries.map(([key, s]) => {
      const segs = segsFromSaved(s);
      const named = segs.filter((x) => x.name.trim()).length;
      const isCur = song && song.key === key;
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
      return `<li>
        <div>
          <div class="${isCur ? 'current' : ''}">${escapeHtml(s.songName || s.fileName)}${isCur ? ' · open now' : ''}</div>
          <div class="muted small">${escapeHtml(s.fileName)} · ${named} named / ${segs.length} sections · ${escapeHtml(when)}</div>
        </div>
        <div class="lib-actions">
          <button class="btn small" data-act="export" data-key="${escapeHtml(key)}">⬇ Excel</button>
          <button class="btn small danger-ghost" data-act="delete" data-key="${escapeHtml(key)}">Delete</button>
        </div>
      </li>`;
    }).join('');
  }

  els.library.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const key = btn.dataset.key;
    if (btn.dataset.act === 'export') exportSaved(key);
    if (btn.dataset.act === 'delete') {
      const store = loadStore();
      const s = store.songs[key];
      if (!s || !confirm(`Delete saved annotations for "${s.songName || s.fileName}"?`)) return;
      delete store.songs[key];
      writeStore(store);
      renderLibrary();
    }
  });

  window.addEventListener('beforeunload', () => { if (song) saveNow(); });

  // ---------- Init ----------
  renderLibrary();
  refreshSuggestions();
  updateHistoryButtons();
  (function frame() { syncLane(); drawPitch(); requestAnimationFrame(frame); })();
})();
