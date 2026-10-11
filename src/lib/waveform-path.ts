// Shapes for the waveform seek bar: the peak/RMS buckets the main process
// builds, turned into two mirrored SVG paths in a fixed box that the bar
// stretches to its own size.

import type { WaveformData } from '@shared/types';

/** The path box is as wide as the data has buckets and WAVEFORM_VIEW_HEIGHT tall. */
export const WAVEFORM_VIEW_HEIGHT = 100;
const MID = WAVEFORM_VIEW_HEIGHT / 2;
/** Half-height of a full-scale bucket, leaving a little room top and bottom. */
const FULL_HALF = 47;
/** The loud parts of a track are brought up to this much of the height. */
const HEADROOM = 0.94;
/** A track quieter than this is not boosted past it, so room tone stays small. */
const MIN_REFERENCE = 0.12;

export interface WaveformPaths {
  /** The outline of the peaks. */
  peak: string;
  /** The inner body, from the RMS level. */
  rms: string;
}

// By tag rather than instanceof: the arrays arrive over the context bridge.
const isBytes = (value: unknown): value is Uint8Array => Object.prototype.toString.call(value) === '[object Uint8Array]';

export function isWaveformData(value: unknown): value is WaveformData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<WaveformData>;
  return (
    typeof data.buckets === 'number'
    && data.buckets > 1
    && typeof data.duration === 'number'
    && data.duration > 0
    && isBytes(data.peak)
    && isBytes(data.rms)
    && data.peak.length === data.buckets
    && data.rms.length === data.buckets
  );
}

/**
 * How much to scale a track for display. Levels are absolute, so a quiet
 * master would draw as a thin line; this brings the loud parts to nearly the
 * full height. It looks at the 99th percentile rather than the top, so one
 * click in a quiet track doesn't set the scale for everything else.
 */
export function waveformGain(peak: Uint8Array): number {
  const counts = new Uint32Array(256);
  for (let i = 0; i < peak.length; i++) counts[peak[i]!] += 1;
  const target = Math.ceil(peak.length * 0.99);
  let seen = 0;
  let level = 0;
  for (; level < 255; level++) {
    seen += counts[level]!;
    if (seen >= target) break;
  }
  return HEADROOM / Math.max(MIN_REFERENCE, level / 255);
}

function mirrored(levels: Uint8Array, gain: number): string {
  const n = levels.length;
  const half = (i: number): number => Math.min(1, (levels[i]! / 255) * gain) * FULL_HALF;
  const first = half(0);
  const last = half(n - 1);
  const top: string[] = [`M0 ${(MID - first).toFixed(1)}`];
  const bottom: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = half(i);
    const x = (i + 0.5).toFixed(1);
    top.push(`L${x} ${(MID - h).toFixed(1)}`);
    bottom.push(`L${x} ${(MID + h).toFixed(1)}`);
  }
  top.push(`L${n} ${(MID - last).toFixed(1)}`, `L${n} ${(MID + last).toFixed(1)}`);
  bottom.reverse();
  return `${top.join(' ')} ${bottom.join(' ')} L0 ${(MID + first).toFixed(1)} Z`;
}

export function buildWaveformPaths(data: WaveformData): WaveformPaths {
  const gain = waveformGain(data.peak);
  return { peak: mirrored(data.peak, gain), rms: mirrored(data.rms, gain) };
}

const built = new WeakMap<WaveformData, WaveformPaths>();

/** buildWaveformPaths, once per waveform: the bar redraws every tick and the shape does not change. */
export function waveformPaths(data: WaveformData): WaveformPaths {
  let paths = built.get(data);
  if (!paths) {
    paths = buildWaveformPaths(data);
    built.set(data, paths);
  }
  return paths;
}

/** Within this much of the bar's length the waveform is drawn edge to edge. */
const FIT_TOLERANCE = 0.02;
/**
 * Past this the bar's length is more likely a placeholder (the seek bar uses 1
 * for "unknown") than a tag that is off, so the drawing is left stretched.
 */
const FIT_LIMIT = 2;

/**
 * How wide to draw a waveform relative to the bar, 1 being edge to edge. The
 * buckets cover the seconds that were decoded; if the player or the library
 * puts the track's length elsewhere (a VBR MP3 with no Xing header, wrong
 * tags), drawing them across the whole bar would put every feature at the
 * wrong time.
 */
export function waveformScale(decoded: number, barSeconds: number): number {
  if (!(decoded > 0) || !(barSeconds > 0)) return 1;
  const ratio = decoded / barSeconds;
  if (Math.abs(ratio - 1) <= FIT_TOLERANCE || ratio > FIT_LIMIT || ratio < 1 / FIT_LIMIT) return 1;
  return ratio;
}

/** m:ss, or h:mm:ss from an hour up. */
export function seekClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
