// The Now Playing spectrum's reading of one bar. No React and no DOM globals, so
// scripts/spectrum-bands-test.mjs can run it directly.
import { bandEnd } from '../../visualizer/band-edges';

/** The loudest bin in band `i` of `edges` (see logBandEdges), 0..1. */
export function bandPeak(freq: Uint8Array, edges: Int32Array, i: number): number {
  const end = Math.min(bandEnd(edges, i), freq.length);
  let max = 0;
  for (let k = edges[i]!; k < end; k += 1) {
    if (freq[k]! > max) max = freq[k]!;
  }
  return max / 255;
}
