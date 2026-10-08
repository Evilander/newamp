import type { ResamplerKind } from '@shared/types';

/**
 * How the signal-path UI names the ffmpeg resampler that converted a track.
 * The main process reports which one ran (electron/resampler.ts); builds
 * without libsoxr use a high-precision swr filter, and the UI must say so
 * rather than assume SoX.
 */
export function resamplerName(kind: ResamplerKind | null | undefined): string {
  if (kind === 'soxr') return 'SoX';
  if (kind === 'swr') return 'FFmpeg swr';
  return 'ffmpeg';
}
