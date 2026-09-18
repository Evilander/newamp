// Song-score analysis for the Eviland visualizers.
//
// The renderer asks for a track's score (src/visualizer/eviland-score.ts) when
// an Eviland visualizer is actually showing it. This module decodes the track
// to mono PCM with ffmpeg, runs the analysis, and keeps the result as a small
// JSON file so a track is only ever analysed once.
//
// Why files and not the library database: a score is ~10 KB, the library DB is
// rewritten wholesale on save, and a big library would carry hundreds of MB of
// data that only the visualizer reads.
//
// Cost, measured on real tracks: ~0.5 s of ffmpeg decode plus ~1.5–2 s of
// analysis for a 5-minute song. The analysis runs on this (main) thread, so it
// yields to the event loop every few milliseconds — IPC and window events keep
// flowing — and only one track is analysed at a time.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SONG_SCORE_MAX_SECONDS,
  SONG_SCORE_SAMPLE_RATE,
  SONG_SCORE_VERSION,
  computeSongScore,
  isValidSongScore,
  type SongScore,
} from '../src/visualizer/eviland-score.js';
import { caseFoldCachePath } from './cache-key-casing.js';
import { resolveFfmpegPath } from './transcode.js';

export interface ScoreRequest {
  path: string;
  /** Cue-sheet tracks are a slice of a longer file; both in seconds. */
  cueStart?: number | null;
  cueEnd?: number | null;
}

// Same watchdog reasoning as dna-analyzer.ts: a malformed source can stall
// ffmpeg on demux forever.
const FFMPEG_TIMEOUT_MS = 180_000;
// ~10 KB each. Past this many files the oldest-used fifth is dropped — checked
// at startup and again after every PRUNE_EVERY_WRITES new scores, so one long
// session can't grow the folder without bound.
const MAX_CACHED_SCORES = 6000;
const PRUNE_EVERY_WRITES = 500;
let writesSincePrune = 0;

let cacheDir = '';
let ready: Promise<void> | null = null;
const inflight = new Map<string, Promise<SongScore | null>>();
const liveScoreFfmpeg = new Set<ChildProcess>();
// One analysis at a time: it is CPU on the main thread, and the only callers
// are the current track and a prefetch of the next one.
let queue: Promise<unknown> = Promise.resolve();

export function initScoreCache(dir: string): void {
  cacheDir = dir;
  ready = mkdir(dir, { recursive: true })
    .then(() => pruneCache(dir))
    .catch((err) => {
      console.error('[score] cache unavailable; scores will be recomputed each session:', err);
      cacheDir = '';
    });
}

export function killAllScoreFfmpeg(): void {
  for (const child of liveScoreFfmpeg) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/**
 * The score for a track, from cache or freshly analysed. Resolves null when
 * the track can't have one (missing file, under ~20 s, decode failure) — the
 * visualizer then simply runs on its live analysis.
 */
export async function getSongScore(request: ScoreRequest): Promise<SongScore | null> {
  if (!request.path) return null;
  await ready;
  let info;
  try {
    info = await stat(request.path);
  } catch {
    return null;
  }
  const start = Math.max(0, Number(request.cueStart) || 0);
  const end = Number(request.cueEnd) > start ? Number(request.cueEnd) : null;
  const key = createHash('sha1')
    .update(`${caseFoldCachePath(request.path, process.platform)}|${info.size}|${Math.round(info.mtimeMs)}|${start}|${end ?? ''}|v${SONG_SCORE_VERSION}`)
    .digest('hex');

  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (async () => {
    const cached = await readCached(key);
    if (cached) return cached;
    // Chain onto the queue; a failed predecessor must not block this job.
    const run = queue.then(
      () => analyse(request.path, start, end),
      () => analyse(request.path, start, end),
    );
    queue = run.catch(() => undefined);
    const score = await run;
    if (score) await writeCached(key, score);
    return score;
  })()
    .catch((err) => {
      console.error('[score] analysis failed:', err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function analyse(path: string, start: number, end: number | null): Promise<SongScore | null> {
  const seconds = Math.min(SONG_SCORE_MAX_SECONDS, end != null ? end - start : SONG_SCORE_MAX_SECONDS);
  const pcm = await decodeMonoPcm(path, start, seconds);
  return computeSongScore(pcm, {
    sampleRate: SONG_SCORE_SAMPLE_RATE,
    pause: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
}

/**
 * Decode to mono float PCM at the analysis rate. Samples are converted as
 * ffmpeg's s16le arrives rather than after the fact: holding the raw chunks,
 * their concatenation and the float copy together cost ~8 bytes per sample
 * (about 200 MB for a 20-minute mix); this way it is 4.
 */
function decodeMonoPcm(inputPath: string, start: number, seconds: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    if (start > 0) args.push('-ss', String(start));
    args.push(
      '-i', inputPath,
      '-t', String(seconds),
      '-vn',
      '-map', '0:a:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', String(SONG_SCORE_SAMPLE_RATE),
      'pipe:1',
    );
    const child = spawn(resolveFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    liveScoreFfmpeg.add(child);
    // Starts at five minutes of audio and doubles when a longer track needs it.
    let samples = new Float32Array(SONG_SCORE_SAMPLE_RATE * 300);
    let count = 0;
    // A chunk can end halfway through a 16-bit sample; carry the odd byte over.
    let carry = -1;
    let stderr = '';
    let settled = false;
    const settle = (err?: Error, result?: Float32Array): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveScoreFfmpeg.delete(child);
      if (err) reject(err);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      settle(new Error('ffmpeg timed out decoding for score analysis'));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      let offset = 0;
      const needed = count + ((chunk.length + 1) >> 1);
      if (needed > samples.length) {
        const grown = new Float32Array(Math.max(needed, samples.length * 2));
        grown.set(samples.subarray(0, count));
        samples = grown;
      }
      if (carry >= 0 && chunk.length > 0) {
        samples[count++] = (((chunk[0]! << 8) | carry) << 16 >> 16) / 32768;
        carry = -1;
        offset = 1;
      }
      for (; offset + 1 < chunk.length; offset += 2) samples[count++] = chunk.readInt16LE(offset) / 32768;
      if (offset < chunk.length) carry = chunk[offset]!;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on('error', (err) => settle(err));
    child.on('close', (code) => {
      if (code === 0) settle(undefined, samples.subarray(0, count));
      else settle(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

async function readCached(key: string): Promise<SongScore | null> {
  if (!cacheDir) return null;
  const file = join(cacheDir, `${key}.json`);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isValidSongScore(parsed)) return null;
    // Touch so pruning drops what hasn't been played, not what was analysed first.
    const now = new Date();
    void utimes(file, now, now).catch(() => undefined);
    return parsed;
  } catch {
    return null;
  }
}

async function writeCached(key: string, score: SongScore): Promise<void> {
  if (!cacheDir) return;
  const file = join(cacheDir, `${key}.json`);
  const temp = `${file}.${process.pid}.part`;
  try {
    await writeFile(temp, JSON.stringify(score), 'utf8');
    await rename(temp, file);
    writesSincePrune += 1;
    if (writesSincePrune >= PRUNE_EVERY_WRITES) {
      writesSincePrune = 0;
      void pruneCache(cacheDir).catch(() => undefined);
    }
  } catch (err) {
    console.error('[score] could not cache score:', err instanceof Error ? err.message : err);
    void unlink(temp).catch(() => undefined);
  }
}

async function pruneCache(dir: string): Promise<void> {
  const names = await readdir(dir);
  for (const name of names) {
    if (name.endsWith('.part')) void unlink(join(dir, name)).catch(() => undefined);
  }
  const scores = names.filter((name) => name.endsWith('.json'));
  if (scores.length <= MAX_CACHED_SCORES) return;
  const aged = await Promise.all(
    scores.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  aged.sort((a, b) => a.at - b.at);
  for (const { name } of aged.slice(0, Math.ceil(scores.length / 5))) {
    void unlink(join(dir, name)).catch(() => undefined);
  }
}
