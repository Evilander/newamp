// Which resampler this ffmpeg build can actually run, and the filter string
// for it. Every explicit rate conversion NewAmp asks ffmpeg for (exclusive
// output, DSD → PCM, the sample-accurate gapless transport) goes through
// here, so no path requests soxr from a build without libsoxr: the bundled
// Windows ffmpeg-static 6.1.1 "essentials" build has none, and
// `aresample=resampler=soxr` fails there outright.
//
// soxr at precision 28 is the first choice. The fallback is a long
// Kaiser-windowed swr filter: THD+N at or below -128 dB up to 19.5 kHz on a
// 44.1k→48k sine (measured on that build), well past 24-bit. Callers report
// the kind they got, never assume one.

import { spawn } from 'node:child_process';
import type { ResamplerKind } from '../shared/types.js';
import { killChild } from './kill-child.js';

const FILTERS: Record<ResamplerKind, string> = {
  soxr: 'aresample=resampler=soxr:precision=28',
  swr: 'aresample=resampler=swr:filter_size=128:phase_shift=12:linear_interp=1:cutoff=0.98:filter_type=kaiser:kaiser_beta=12',
};

// Resample 50 ms of generated silence through soxr: exit 0 means the engine
// is compiled in.
const PROBE_ARGS = [
  '-hide_banner', '-nostdin', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.05',
  '-af', FILTERS.soxr, '-ar', '48000', '-f', 'null', '-',
];
const PROBE_TIMEOUT_MS = 10_000;
// A probe that timed out (a first run held up by the system's scan of a
// freshly installed binary) did not find out whether soxr is there, so it is
// asked again, but not on every call while the answer is still being waited on.
const PROBE_RETRY_MS = 60_000;

const known = new Map<string, ResamplerKind>();
const timedOutAt = new Map<string, number>();
const pending = new Map<string, Promise<ResamplerKind>>();

export function resamplerFilter(kind: ResamplerKind): string {
  return FILTERS[kind];
}

/**
 * Probe `ffmpeg` once (per binary) for soxr; later calls answer from the
 * cache. A probe that timed out answers swr for that call only.
 */
export function probeResampler(ffmpeg: string): Promise<ResamplerKind> {
  const cached = known.get(ffmpeg);
  if (cached) return Promise.resolve(cached);
  const timedOut = timedOutAt.get(ffmpeg);
  if (timedOut != null && performance.now() - timedOut < PROBE_RETRY_MS) return Promise.resolve('swr');
  let probe = pending.get(ffmpeg);
  if (!probe) {
    probe = new Promise<ResamplerKind>((resolve) => {
      let settled = false;
      const done = (kind: ResamplerKind, answered: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(ffmpeg);
        if (answered) {
          known.set(ffmpeg, kind);
          timedOutAt.delete(ffmpeg);
        } else {
          timedOutAt.set(ffmpeg, performance.now());
        }
        resolve(kind);
      };
      const child = spawn(ffmpeg, PROBE_ARGS, { stdio: 'ignore', windowsHide: true });
      // swr is always compiled in, so a probe that can't answer settles on it.
      const timer = setTimeout(() => {
        killChild(child);
        done('swr', false);
      }, PROBE_TIMEOUT_MS);
      child.on('error', () => done('swr', true));
      child.on('close', (code) => done(code === 0 ? 'soxr' : 'swr', true));
    });
    pending.set(ffmpeg, probe);
  }
  return probe;
}

/**
 * The cached answer, for code that builds ffmpeg arguments synchronously on
 * the main thread, which must never wait on a probe. The transcode cache
 * warms the async probe at startup; until it answers, this starts it and
 * says swr (always compiled in). Callers use and report what this returned.
 */
export function resamplerKindNow(ffmpeg: string): ResamplerKind {
  const cached = known.get(ffmpeg);
  if (cached) return cached;
  void probeResampler(ffmpeg);
  return 'swr';
}
