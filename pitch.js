/* Pitch tracking for the Gamaka Annotator.
 * YIN pitch estimation runs in a Web Worker (built from a Blob, so it also
 * works when index.html is opened straight from disk). Clean-up and Sa
 * detection run on the main thread because they are cheap and depend on
 * user settings.
 */
(() => {
  'use strict';

  const SR = 16000;   // analysis sample rate
  const HOP = 160;    // 10 ms between pitch frames
  const WIN = 512;    // 32 ms analysis window
  const FMIN = 65;    // Hz, below a low male mandra Pa
  const FMAX = 1100;  // Hz, above a high female tara Pa

  // ---------- Worker: raw YIN ----------
  function workerMain() {
    self.onmessage = (e) => {
      const { samples: x, sr, hop, win, fmin, fmax } = e.data;
      const maxTau = Math.floor(sr / fmin);
      const minTau = Math.max(2, Math.floor(sr / fmax));
      const threshold = 0.2;
      const n = Math.max(0, Math.floor((x.length - win - maxTau) / hop) + 1);
      const hz = new Float32Array(n);
      const conf = new Float32Array(n);
      const rms = new Float32Array(n);
      const d = new Float32Array(maxTau + 2);

      for (let i = 0; i < n; i++) {
        const off = i * hop;
        let energy = 0;
        for (let j = 0; j < win; j++) energy += x[off + j] * x[off + j];
        rms[i] = Math.sqrt(energy / win);

        // Difference function
        for (let tau = 1; tau <= maxTau; tau++) {
          let s = 0;
          for (let j = 0; j < win; j++) {
            const diff = x[off + j] - x[off + j + tau];
            s += diff * diff;
          }
          d[tau] = s;
        }
        // Cumulative mean normalised difference
        d[0] = 1;
        let running = 0;
        for (let tau = 1; tau <= maxTau; tau++) {
          running += d[tau];
          d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
        }
        // First dip below threshold, else the global minimum
        let est = -1;
        for (let tau = minTau; tau <= maxTau; tau++) {
          if (d[tau] < threshold) {
            while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) tau++;
            est = tau;
            break;
          }
        }
        if (est < 0) {
          est = minTau;
          for (let tau = minTau + 1; tau <= maxTau; tau++) if (d[tau] < d[est]) est = tau;
        }
        // Parabolic interpolation for sub-sample accuracy
        let better = est;
        if (est > minTau && est < maxTau) {
          const a = d[est - 1], b = d[est], c = d[est + 1];
          const den = a + c - 2 * b;
          if (den !== 0) better = est + (a - c) / (2 * den);
        }
        hz[i] = sr / better;
        conf[i] = Math.max(0, 1 - d[est]);

        if (i % 400 === 0) self.postMessage({ progress: i / n });
      }
      self.postMessage({ done: true, hz, conf, rms }, [hz.buffer, conf.buffer, rms.buffer]);
    };
  }

  let worker = null;
  let workerUrl = null;

  function cancel() {
    if (worker) { worker.terminate(); worker = null; }
  }

  // Decode, mix to mono, band-limit to the vocal range and resample to 16 kHz.
  async function prepare(file) {
    const buf = await file.arrayBuffer();
    const decoded = await new OfflineAudioContext(1, 1, SR).decodeAudioData(buf);
    const ctx = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 60;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2500;
    src.connect(hp).connect(lp).connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0);
  }

  /** Returns raw pitch frames: { hz, conf, rms, t0, dt } */
  async function analyze(file, onProgress) {
    cancel();
    onProgress?.(0, 'decoding');
    const samples = await prepare(file);
    if (!workerUrl) {
      workerUrl = URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }));
    }
    const w = new Worker(workerUrl);
    worker = w;
    return new Promise((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.progress !== undefined) { onProgress?.(e.data.progress, 'tracking'); return; }
        if (e.data.done) {
          w.terminate();
          if (worker === w) worker = null;
          resolve({ hz: e.data.hz, conf: e.data.conf, rms: e.data.rms, t0: WIN / 2 / SR, dt: HOP / SR });
        }
      };
      w.onerror = (err) => { w.terminate(); reject(err); };
      w.postMessage({ samples, sr: SR, hop: HOP, win: WIN, fmin: FMIN, fmax: FMAX }, [samples.buffer]);
    });
  }

  // ---------- Clean-up ----------
  function median(arr) {
    const a = Float32Array.from(arr).sort();
    return a.length ? a[a.length >> 1] : 0;
  }

  /**
   * Turns raw frames into a MIDI-scale contour (NaN where unvoiced).
   * strictness 0..1: higher keeps only confident, louder frames (useful for concert mixes).
   */
  function clean(raw, strictness = 0.5) {
    const n = raw.hz.length;
    const minConf = 0.25 + 0.6 * strictness;
    const rmsGate = median(raw.rms) * (0.1 + 0.6 * strictness);
    const midi = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ok = raw.conf[i] >= minConf && raw.rms[i] >= rmsGate && raw.hz[i] > 0;
      midi[i] = ok ? 69 + 12 * Math.log2(raw.hz[i] / 440) : NaN;
    }

    // Octave-jump correction against a local median of voiced frames
    const R = 25;
    const fixed = Float32Array.from(midi);
    const win = [];
    for (let i = 0; i < n; i++) {
      if (isNaN(midi[i])) continue;
      win.length = 0;
      for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) if (!isNaN(midi[j])) win.push(midi[j]);
      if (win.length < 5) continue;
      win.sort((a, b) => a - b);
      const med = win[win.length >> 1];
      const diff = midi[i] - med;
      if (diff > 9) fixed[i] = midi[i] - 12 * Math.round(diff / 12);
      else if (diff < -9) fixed[i] = midi[i] + 12 * Math.round(-diff / 12);
    }

    // 3-frame median smoothing inside voiced stretches (wider would flatten fast kampitas)
    const smooth = Float32Array.from(fixed);
    const k = [];
    for (let i = 0; i < n; i++) {
      if (isNaN(fixed[i])) continue;
      k.length = 0;
      for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < n && !isNaN(fixed[j])) k.push(fixed[j]);
      k.sort((a, b) => a - b);
      smooth[i] = k[k.length >> 1];
    }

    // Drop voiced blips shorter than 40 ms
    for (let i = 0; i < n;) {
      if (isNaN(smooth[i])) { i++; continue; }
      let j = i;
      while (j < n && !isNaN(smooth[j])) j++;
      if (j - i < 4) for (let q = i; q < j; q++) smooth[q] = NaN;
      i = j;
    }
    return smooth;
  }

  // ---------- Sa (tonic) estimate ----------
  /** Guesses Sa in Hz from a cleaned contour: the strongest pitch class, placed in a sensible octave. */
  function estimateSa(midi) {
    const BINS = 120; // 10-cent bins over one octave
    const hist = new Float32Array(BINS);
    const voiced = [];
    for (let i = 0; i < midi.length; i++) {
      const m = midi[i];
      if (isNaN(m)) continue;
      voiced.push(m);
      const pc = ((m % 12) + 12) % 12;
      hist[Math.floor(pc * 10) % BINS] += 1;
    }
    if (voiced.length < 50) return null;
    // Circular smoothing (±30 cents)
    const sm = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      let s = 0;
      for (let o = -3; o <= 3; o++) s += hist[(b + o + BINS) % BINS] * (4 - Math.abs(o));
      sm[b] = s;
    }
    let best = 0;
    for (let b = 1; b < BINS; b++) if (sm[b] > sm[best]) best = b;
    const pc = best / 10 + 0.05;
    // Place Sa so the singer's median pitch sits between Sa-2 and Sa+10 semitones
    const med = median(voiced);
    let sa = pc;
    while (sa + 10 <= med) sa += 12;
    while (sa - 2 > med) sa -= 12;
    return 440 * Math.pow(2, (sa - 69) / 12);
  }

  window.PitchTracker = { analyze, clean, estimateSa, cancel };
})();
