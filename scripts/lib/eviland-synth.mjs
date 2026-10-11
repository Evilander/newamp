// Synthetic audio for the Eviland tests: a small PCM synth (kicks, snares,
// hats, tones), a Web Audio AnalyserNode emulation, and a driver that feeds a
// live reactor the way Visualizer.tsx does. No audio hardware, no GPU.

export function createFft(size) {
  const cos = new Float32Array(size / 2);
  const sin = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / size);
    sin[i] = Math.sin((-2 * Math.PI * i) / size);
  }
  const reversed = new Uint32Array(size);
  const bits = Math.log2(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < size; i++) {
      const j = reversed[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const stride = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * stride];
          const wi = sin[k * stride];
          const a = start + k;
          const b = a + half;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

/**
 * AnalyserNode as the Web Audio spec describes it: Blackman window,
 * magnitude / N, time smoothing, then dB mapped linearly onto bytes between
 * minDecibels and maxDecibels (the engine's -86 / -10).
 */
export function createAnalyser({ fftSize = 2048, minDb = -86, maxDb = -10, smoothing = 0 } = {}) {
  const n = fftSize;
  const bins = n / 2;
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
  const fft = createFft(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const smooth = new Float32Array(bins);
  return {
    bins,
    /** samples: the most recent fftSize samples; out: Uint8Array(bins). */
    getByteFrequencyData(samples, out) {
      for (let i = 0; i < n; i++) {
        re[i] = (samples[i] ?? 0) * window[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        const mag = Math.hypot(re[k], im[k]) / n;
        smooth[k] = smoothing * smooth[k] + (1 - smoothing) * mag;
        const db = 20 * Math.log10(smooth[k] + 1e-30);
        const v = Math.floor((255 / (maxDb - minDb)) * (db - minDb));
        out[k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    },
  };
}

/**
 * Drive a reactor over stereo PCM like Visualizer.tsx does: one smoothed
 * analyser for `freq`, unsmoothed ones for onsets and each channel, one
 * analyze() per hop. `onFrame(frame, seconds, nowMs)` runs per frame.
 */
export function runReactor(createEvilandReactor, left, right, sampleRate, onFrame, { hopMs = 1000 / 60, fftSize = 2048 } = {}) {
  const bins = fftSize / 2;
  const reactor = createEvilandReactor({ sampleRate, fftSize, binCount: bins });
  const aFreq = createAnalyser({ fftSize, smoothing: 0.24 });
  const aOnset = createAnalyser({ fftSize });
  const aLeft = createAnalyser({ fftSize });
  const aRight = createAnalyser({ fftSize });
  const freq = new Uint8Array(bins);
  const onset = new Uint8Array(bins);
  const lb = new Uint8Array(bins);
  const rb = new Uint8Array(bins);
  const mono = new Float32Array(fftSize);
  const lw = new Float32Array(fftSize);
  const rw = new Float32Array(fftSize);
  const hop = (sampleRate * hopMs) / 1000;
  let now = 0;
  for (let pos = fftSize; pos < left.length; pos += hop) {
    const end = Math.floor(pos);
    for (let i = 0; i < fftSize; i++) {
      const s = end - fftSize + i;
      lw[i] = left[s];
      rw[i] = right[s];
      mono[i] = 0.5 * (left[s] + right[s]);
    }
    aFreq.getByteFrequencyData(mono, freq);
    aOnset.getByteFrequencyData(mono, onset);
    aLeft.getByteFrequencyData(lw, lb);
    aRight.getByteFrequencyData(rw, rb);
    const frame = reactor.analyze(freq, onset, lb, rb, hopMs, now);
    onFrame(frame, end / sampleRate, now);
    now += hopMs;
  }
  return reactor;
}

/** A stereo PCM scratchpad with a few instruments. Deterministic noise. */
export function makeSynth(sampleRate, seconds) {
  const total = Math.round(seconds * sampleRate);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let noiseState = 0x2545f491;
  const noise = () => {
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    return ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
  };
  const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
  const add = (start, i, v, pan = 0) => {
    const idx = start + i;
    if (idx < 0 || idx >= total) return;
    L[idx] += v * (1 - Math.max(0, pan));
    R[idx] += v * (1 + Math.min(0, pan));
  };
  const synth = {
    L, R, total, sampleRate, noise, midiHz,
    tone(at, dur, hz, gain, harmonics = 1, pan = 0) {
      const start = Math.round(at * sampleRate);
      const n = Math.round(dur * sampleRate);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, t / 0.01) * Math.min(1, (dur - t) / 0.05);
        let v = 0;
        for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * hz * h * t) / h;
        add(start, i, v * gain * env, pan);
      }
    },
    kick(at, gain = 0.7) {
      const start = Math.round(at * sampleRate);
      for (let i = 0; i < sampleRate * 0.18; i++) {
        const t = i / sampleRate;
        add(start, i, Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-t * 28)) * t) * Math.exp(-t * 16) * gain);
      }
    },
    bass(at, dur, hz, gain = 0.3) {
      const start = Math.round(at * sampleRate);
      const n = Math.round(dur * sampleRate);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, t / 0.005) * Math.exp(-t * 6);
        add(start, i, (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.25 * Math.sin(6 * Math.PI * hz * t)) * gain * env);
      }
    },
    noiseHit(at, dur, gain, decay, pan = 0) {
      const start = Math.round(at * sampleRate);
      let prev = 0;
      for (let i = 0; i < dur * sampleRate; i++) {
        const raw = noise();
        const bright = raw - prev;
        prev = raw;
        add(start, i, bright * gain * Math.exp((-i / sampleRate) * decay), pan);
      }
    },
    snare(at, gain = 0.35) {
      synth.noiseHit(at, 0.16, gain, 22);
      synth.tone(at, 0.08, 180, gain * 0.6, 1);
    },
    hat(at, gain = 0.14, pan = 0.3) {
      synth.noiseHit(at, 0.04, gain, 90, pan);
    },
    ride(at, gain = 0.12) {
      synth.noiseHit(at, 0.25, gain * 0.6, 10, 0.4);
      synth.tone(at, 0.3, 5200, gain * 0.5, 1, 0.4);
    },
    /** Multiply the whole buffer by gain(tSeconds). */
    scale(gainAt) {
      for (let i = 0; i < total; i++) {
        const g = gainAt(i / sampleRate);
        L[i] *= g;
        R[i] *= g;
      }
    },
    normalise(peakTo = 0.9) {
      let peak = 0;
      for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      if (peak > 0) for (let i = 0; i < total; i++) { L[i] = (L[i] / peak) * peakTo; R[i] = (R[i] / peak) * peakTo; }
    },
    mono() {
      const m = new Float32Array(total);
      for (let i = 0; i < total; i++) m[i] = 0.5 * (L[i] + R[i]);
      return m;
    },
  };
  return synth;
}

/**
 * A verse/chorus form at `bpm`: 'A' verse (kick, bass, soft pad), 'B' chorus
 * (plus snare, hats, a brighter louder pad), 'C' bridge (no drums, a quieter
 * bass, up a major third). I-V-vi-IV, two bars per chord. Returns the synth
 * and the true section boundaries in seconds.
 */
export function makeForm(sampleRate, { bpm = 120, sectionBars = 8, form = ['A', 'B', 'A', 'B', 'C', 'B'], level = 1, fadeOutSeconds = 0, introBars = 0, chordBars = 2, tonicOf = () => 60 } = {}) {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const seconds = (form.length * sectionBars + introBars) * bar;
  const s = makeSynth(sampleRate, seconds);
  const PROGRESSION = [0, 7, 9, 5];
  for (let b = 0; b < introBars; b++) {
    const root = 60 + PROGRESSION[Math.floor(b / chordBars) % 4];
    for (const m of [root, root + 4, root + 7]) s.tone(b * bar, bar * 0.95, s.midiHz(m), 0.12, 4);
  }
  const t0 = introBars * bar;
  form.forEach((kind, index) => {
    const start = t0 + index * sectionBars * bar;
    const tonic = tonicOf(index, kind) + (kind === 'C' ? 4 : 0);
    for (let b = 0; b < sectionBars; b++) {
      const barStart = start + b * bar;
      const degree = PROGRESSION[Math.floor(b / chordBars) % 4];
      const root = tonic + degree;
      const third = root + (degree === 9 ? 3 : 4);
      const padGain = kind === 'B' ? 0.11 : 0.06;
      const harmonics = kind === 'B' ? 6 : 2;
      for (const n of [root, third, root + 7]) s.tone(barStart, bar, s.midiHz(n), padGain, harmonics);
      s.tone(barStart, bar, s.midiHz(root - 24), kind === 'C' ? 0.12 : 0.2, 2);
      for (let q = 0; q < 4; q++) {
        const at = barStart + q * beat;
        if (kind !== 'C') s.kick(at, q === 0 ? 0.75 : 0.6);
        if (kind === 'B') {
          if (q === 1 || q === 3) s.snare(at, 0.35);
          s.hat(at, 0.14);
          s.hat(at + beat / 2, 0.12);
        }
      }
    }
  });
  s.normalise(0.9 * level);
  if (fadeOutSeconds > 0) s.scale((t) => (t > seconds - fadeOutSeconds ? Math.max(0, (seconds - t) / fadeOutSeconds) : 1));
  const boundaries = [];
  if (introBars > 0) boundaries.push(t0);
  for (let i = 1; i < form.length; i++) boundaries.push(t0 + i * sectionBars * bar);
  return { synth: s, boundaries, seconds, beat, bar, fadeAt: fadeOutSeconds > 0 ? seconds - fadeOutSeconds : Infinity };
}

export const percentile = (values, q) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? NaN;
};
