// Turns the analyser's time-domain bytes into the window Butterchurn reads.
//
// Butterchurn takes BUTTERCHURN_FFT_SIZE contiguous samples and places its
// bass/mid/treb edges from the sample rate it is told. The window has to be
// those samples at that rate: every second sample of a longer window, reported
// at the full rate, puts every edge an octave low and folds anything above a
// quarter of the rate back down.

type Reactivity = 'truth' | 'punch' | 'wild';

// The iframe's OfflineAudioContext (which Butterchurn reads the rate from)
// only accepts rates up to this.
const MAX_FEED_RATE = 96000;

// Butterchurn's bands are each frame's level over a long running average, so
// a linear gain cancels out of them; what it moves is the drawn waveform. The
// signal is hard-limited at full scale rather than soft-clipped: a soft clip
// compresses peaks against the rest of the signal and takes contrast away.
const WAVE_GAIN: Record<Reactivity, number> = { truth: 1, punch: 1.4, wild: 2 };

export function waveGainFor(reactivity: Reactivity): number {
  return WAVE_GAIN[reactivity];
}

/** How many analyser samples are averaged into each fed sample. */
export function feedDecimation(sampleRate: number): number {
  return Math.max(1, Math.ceil(sampleRate / MAX_FEED_RATE - 1e-9));
}

/** The sample rate of what `fillButterchurnSamples` produces: the rate to tell Butterchurn. */
export function feedSampleRate(sampleRate: number): number {
  return sampleRate / feedDecimation(sampleRate);
}

/**
 * Fills `out` with the most recent contiguous window of `wave` (analyser
 * bytes at `sampleRate`), scaled by `gain` and limited to full scale. Rates
 * above what the iframe accepts are box-filtered down by feedDecimation().
 */
export function fillButterchurnSamples(wave: Uint8Array, out: Uint8Array, gain: number, sampleRate: number): void {
  const factor = feedDecimation(sampleRate);
  const start = wave.length - out.length * factor;
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += (wave[start + i * factor + k] ?? 128) - 128;
    const level = Math.max(-1, Math.min(127 / 128, (sum / factor / 128) * gain));
    out[i] = 128 + Math.round(level * 128);
  }
}
