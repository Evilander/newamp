// Log-spaced analysis bands that cover the same Hz at any sample rate.
//
// A bin index means a frequency only at one sample rate: bin 100 is 2.1 kHz at
// 44.1 kHz and 4.7 kHz at 96 kHz. Meters that slice the spectrum by bin count
// put their bass bars on the mids as soon as Bit-Perfect output moves the
// device to a higher rate, and a linear slice spends most of its bars above
// the range where music has energy. These edges are anchored in Hz instead.

const edgeCache = new Map<string, Int32Array>();

/**
 * Bin edges of `count` log-spaced bands from loHz to hiHz: band i covers bins
 * [edges[i], bandEnd(edges, i)). Bin 0 is the DC offset and never belongs to a
 * band. Each edge is the bin nearest its frequency, so an edge sits at the same
 * Hz at any sample rate to within one bin. Where the spacing is finer than the
 * resolution (the lowest bands at 44.1 kHz, most of them at 192 kHz) several
 * bands start on the same bin and show the same level; pushing the later edges
 * up to keep every band a bin wide would move the whole upper half of the
 * meter off its frequencies instead.
 */
export function logBandEdges(sampleRate: number, fftSize: number, count: number, loHz = 30, hiHz = 16000): Int32Array {
  const key = `${sampleRate}|${fftSize}|${count}|${loHz}|${hiHz}`;
  const cached = edgeCache.get(key);
  if (cached) return cached;
  const binWidth = sampleRate / fftSize;
  const binCount = fftSize / 2;
  const top = Math.min(hiHz, sampleRate / 2);
  const edges = new Int32Array(count + 1);
  edges[0] = Math.min(binCount, Math.max(1, Math.round(loHz / binWidth)));
  for (let i = 1; i <= count; i += 1) {
    const hz = loHz * (top / loHz) ** (i / count);
    edges[i] = Math.min(binCount, Math.max(edges[i - 1]!, Math.round(hz / binWidth)));
  }
  if (edgeCache.size > 16) edgeCache.clear();
  edgeCache.set(key, edges);
  return edges;
}

/** Where band `i` of `edges` ends (exclusive): always at least one bin past its start. */
export function bandEnd(edges: Int32Array, i: number): number {
  return Math.max(edges[i + 1]!, edges[i]! + 1);
}

/**
 * Notices a sample-rate change. Bit-Perfect output negotiates the device rate
 * per track, so analysers built from the rate at mount map their Hz bands onto
 * the wrong bins afterwards. Poll it from a render loop: it reads the rate at
 * most every `checkEveryMs` and returns the new rate once per change.
 */
export function createSampleRateWatch(
  read: () => number,
  initial: number,
  checkEveryMs = 500,
): (now: number) => number | null {
  let known = initial;
  let checkedAt = -Infinity;
  return (now) => {
    if (now - checkedAt < checkEveryMs) return null;
    checkedAt = now;
    const rate = read();
    if (!(rate > 0) || rate === known) return null;
    known = rate;
    return rate;
  };
}
