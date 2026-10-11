// The Auto-VJ's reading of how much is going on in the music, 0..1. No React and
// no DOM globals, so scripts/spectrum-bands-test.mjs can run it directly.
import { bandEnd, logBandEdges } from '../visualizer/band-edges';

/** Log-spaced bands over 30 Hz - 16 kHz whose edges mark where the three groups split. */
export const ENERGY_BANDS = 12;
// Six bands span 30-700 Hz (bass through the low mids), the next three
// 700 Hz-3.4 kHz (voice, guitars) and the last three everything above.
const LOW_END = 6;
const MID_END = 9;

/**
 * Weighted low/mid/high level of one frequency frame. The groups sit at the same
 * Hz at any sample rate, so Bit-Perfect output at 96 or 192 kHz reads the same
 * music the same way instead of counting its bass as mids. Each group is the
 * plain mean of its bins, as the bin-index version was, so the reading and the
 * thresholds built on it stay where they were at 44.1 kHz.
 */
export function visualizerEnergy(freq: Uint8Array, sampleRate: number, fftSize: number): number {
  if (!freq.length || !(sampleRate > 0) || !(fftSize > 0)) return 0;
  const edges = logBandEdges(sampleRate, fftSize, ENERGY_BANDS);
  const low = groupLevel(freq, edges, 0, LOW_END);
  const mid = groupLevel(freq, edges, LOW_END, MID_END);
  const high = groupLevel(freq, edges, MID_END, ENERGY_BANDS);
  return Math.min(1, Math.pow(low * 0.48 + mid * 0.36 + high * 0.16, 0.72));
}

/** Mean level, 0..1, of every bin in bands [from, to) of `edges`. */
function groupLevel(freq: Uint8Array, edges: Int32Array, from: number, to: number): number {
  const start = edges[from]!;
  const end = Math.min(bandEnd(edges, to - 1), freq.length);
  let total = 0;
  for (let index = start; index < end; index += 1) total += freq[index]!;
  return end > start ? total / (end - start) / 255 : 0;
}
