// Butterchurn places its bass/mid/treb band edges once, when its renderer is
// built, from the sample rate of the audio context it is given. Bit-Perfect
// output can move the device to another rate between tracks, and the context
// here is offline and fixed, so the bands are moved in place instead of
// rebuilding the renderer and every compiled preset with it.
//
// This reaches into the pinned butterchurn 2.6.7 renderer (the same private
// surface eviland-live-pipeline.ts depends on) and does nothing when it is not
// shaped the way it expects.

// MilkDrop's band edges in Hz, as butterchurn's AudioLevels uses them.
const BAND_EDGES_HZ = [20, 320, 2800, 11025] as const;

interface RendererLike {
  audio?: { fftSize?: number; numSamps?: number };
  audioLevels?: { starts?: unknown; stops?: unknown };
}

export function retuneButterchurnBands(visualizer: unknown, sampleRate: number): boolean {
  const renderer = (visualizer as { renderer?: RendererLike } | null)?.renderer;
  const audio = renderer?.audio;
  const levels = renderer?.audioLevels;
  if (!audio?.fftSize || !audio.numSamps || !levels) return false;
  if (!Array.isArray(levels.starts) || !Array.isArray(levels.stops) || !(sampleRate > 0)) return false;
  const bucketHz = sampleRate / audio.fftSize;
  const last = audio.numSamps - 1;
  const [bassLow, bassHigh, midHigh, trebHigh] = BAND_EDGES_HZ.map((hz) =>
    Math.min(last, Math.max(0, Math.round(hz / bucketHz) - 1)),
  );
  levels.starts = [bassLow, bassHigh, midHigh];
  levels.stops = [bassHigh, midHigh, trebHigh];
  return true;
}
