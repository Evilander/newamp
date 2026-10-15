// Waveform peaks for the seek bar.
//
// The renderer asks for a track's waveform when it is about to draw the seek
// bar. This module decodes the track to low-rate mono PCM with ffmpeg, folds
// it into a fixed number of peak/RMS buckets while the PCM streams in, and
// keeps the result as a small JSON file, so a track is only decoded once.
//
// Nothing here holds the PCM: memory is a few KB whatever the track length,
// and the reduction runs in the chunk callbacks, a few milliseconds each, so
// IPC and window events keep flowing. Only one decode runs at a time. The
// track on screen goes first: asking for it drops whatever was still waiting
// and stops a decode for a track the listener has already left.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { constants as osConstants, setPriority } from 'node:os';
import { join } from 'node:path';
import type { WaveformData } from '../shared/types.js';
import { caseFoldCachePath } from './cache-key-casing.js';
import { killChild } from './kill-child.js';
import { onPlaybackHunger, whenPlaybackFed } from './playback-io.js';
import { resolveFfmpegPath, watchFfmpegInput } from './transcode.js';

export interface WaveformRequest {
  path: string;
  /** Cue-sheet tracks are a slice of a longer file; both in seconds. */
  cueStart?: number | null;
  cueEnd?: number | null;
  /** What the library knows of the track's length, in seconds. */
  duration?: number | null;
}

export interface WaveformOptions {
  /** Queue behind whatever is needed right now. */
  prefetch?: boolean;
}

export const WAVEFORM_BUCKETS = 2048;
export const WAVEFORM_SAMPLE_RATE = 8000;
/** Bumped when the decode or the reduction changes what a file holds. */
export const WAVEFORM_VERSION = 1;
/** A clip shorter than this has no shape worth drawing. */
const MIN_SECONDS = 1;
/** Longer than this (an audiobook, a day-long mix) the seek bar stays plain. */
const MAX_SECONDS = 3 * 3600;

// Same watchdog reasoning as score-analyzer.ts: a malformed source can stall
// ffmpeg on demux forever.
const FFMPEG_TIMEOUT_MS = 180_000;
// ~6 KB each. Past this many files the oldest-used fifth is dropped, checked
// at startup and again after every PRUNE_EVERY_WRITES new files.
const MAX_CACHED_FILES = 6000;
const PRUNE_EVERY_WRITES = 400;
const MAX_REMEMBERED_FAILURES = 500;
// A .part file younger than this may be a write in progress.
const STALE_PART_MS = 60_000;

// ---------------------------------------------------------------------------
// Reduction

const FINE_SLOTS = WAVEFORM_BUCKETS * 2;
const FIRST_SLOT_SAMPLES = 16;

/**
 * Folds a stream of 16-bit mono PCM into WAVEFORM_BUCKETS peak/RMS pairs
 * without knowing the length up front. Samples fill fine slots; when they run
 * out, neighbours merge and each slot spans twice as many samples, so the
 * slots always cover the whole stream at 2048 to 4096 slots. finish() maps
 * them onto the buckets.
 */
export class PeakReducer {
  private readonly slotPeak = new Float32Array(FINE_SLOTS);
  private readonly slotSquares = new Float64Array(FINE_SLOTS);
  private readonly slotCount = new Uint32Array(FINE_SLOTS);
  private used = 0;
  private perSlot = FIRST_SLOT_SAMPLES;
  private peak = 0;
  private squares = 0;
  private count = 0;
  private total = 0;
  // A chunk can end halfway through a 16-bit sample; the odd byte waits here.
  private carry = -1;

  /** Raw s16le bytes, in the pieces ffmpeg writes them. */
  push(chunk: Buffer): void {
    let offset = 0;
    if (this.carry >= 0 && chunk.length > 0) {
      this.add((((chunk[0]! << 8) | this.carry) << 16) >> 16);
      this.carry = -1;
      offset = 1;
    }
    const pairs = (chunk.length - offset) >> 1;
    if (((chunk.byteOffset + offset) & 1) === 0) {
      // Little-endian on every platform NewAmp runs on, so s16le can be read in place.
      const samples = new Int16Array(chunk.buffer, chunk.byteOffset + offset, pairs);
      for (let i = 0; i < pairs; i++) this.add(samples[i]!);
    } else {
      for (let i = 0; i < pairs; i++) this.add(chunk.readInt16LE(offset + i * 2));
    }
    if ((chunk.length - offset) & 1) this.carry = chunk[chunk.length - 1]!;
  }

  get samples(): number {
    return this.total;
  }

  private add(sample: number): void {
    const level = sample < 0 ? -sample : sample;
    if (level > this.peak) this.peak = level;
    this.squares += sample * sample;
    this.total += 1;
    if (++this.count < this.perSlot) return;
    // Out of slots: merge instead, and let this one keep growing to the new width.
    if (this.used === FINE_SLOTS) this.merge();
    else this.closeSlot();
  }

  private closeSlot(): void {
    const at = this.used++;
    this.slotPeak[at] = this.peak;
    this.slotSquares[at] = this.squares;
    this.slotCount[at] = this.count;
    this.peak = 0;
    this.squares = 0;
    this.count = 0;
  }

  private merge(): void {
    const half = FINE_SLOTS / 2;
    for (let i = 0; i < half; i++) {
      const a = i * 2;
      const b = a + 1;
      this.slotPeak[i] = Math.max(this.slotPeak[a]!, this.slotPeak[b]!);
      this.slotSquares[i] = this.slotSquares[a]! + this.slotSquares[b]!;
      this.slotCount[i] = this.slotCount[a]! + this.slotCount[b]!;
    }
    this.used = half;
    this.perSlot *= 2;
  }

  /** The buckets, or null when the stream was too short to draw. */
  finish(sampleRate = WAVEFORM_SAMPLE_RATE): WaveformData | null {
    if (this.count > 0) {
      if (this.used === FINE_SLOTS) this.merge();
      this.closeSlot();
    }
    if (this.total < sampleRate * MIN_SECONDS) return null;
    const peak = new Uint8Array(WAVEFORM_BUCKETS);
    const rms = new Uint8Array(WAVEFORM_BUCKETS);
    const slots = this.used;
    for (let b = 0; b < WAVEFORM_BUCKETS; b++) {
      const first = Math.floor((b * slots) / WAVEFORM_BUCKETS);
      const last = Math.max(first + 1, Math.floor(((b + 1) * slots) / WAVEFORM_BUCKETS));
      let top = 0;
      let squares = 0;
      let samples = 0;
      for (let s = first; s < last && s < slots; s++) {
        if (this.slotPeak[s]! > top) top = this.slotPeak[s]!;
        squares += this.slotSquares[s]!;
        samples += this.slotCount[s]!;
      }
      peak[b] = toByte(top / 32768);
      rms[b] = toByte(samples > 0 ? Math.sqrt(squares / samples) / 32768 : 0);
    }
    return { buckets: WAVEFORM_BUCKETS, duration: this.total / sampleRate, peak, rms };
  }
}

function toByte(level: number): number {
  return Math.round(Math.min(1, Math.max(0, level)) * 255);
}

// ---------------------------------------------------------------------------
// Cache files

export function waveformCacheKey(parts: {
  path: string;
  size: number;
  mtimeMs: number;
  start: number;
  end: number | null;
}, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha1')
    .update(`${caseFoldCachePath(parts.path, platform)}|${parts.size}|${Math.round(parts.mtimeMs)}|${parts.start}|${parts.end ?? ''}|v${WAVEFORM_VERSION}`)
    .digest('hex');
}

export function encodeWaveformFile(data: WaveformData): string {
  return JSON.stringify({
    v: WAVEFORM_VERSION,
    buckets: data.buckets,
    duration: data.duration,
    peak: Buffer.from(data.peak).toString('base64'),
    rms: Buffer.from(data.rms).toString('base64'),
  });
}

/** The waveform a cache file holds, or null for anything that isn't one. */
export function parseWaveformFile(text: string): WaveformData | null {
  let parsed: Partial<Record<string, unknown>>;
  try {
    parsed = JSON.parse(text) as Partial<Record<string, unknown>>;
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== WAVEFORM_VERSION || parsed.buckets !== WAVEFORM_BUCKETS) return null;
  const duration = parsed.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null;
  const peak = decodeBytes(parsed.peak);
  const rms = decodeBytes(parsed.rms);
  if (!peak || !rms) return null;
  return { buckets: WAVEFORM_BUCKETS, duration, peak, rms };
}

// A copy, so the array owns an ArrayBuffer of exactly its own size rather than
// a slice of Node's shared Buffer pool.
function decodeBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== WAVEFORM_BUCKETS) return null;
  const out = new Uint8Array(WAVEFORM_BUCKETS);
  out.set(bytes);
  return out;
}

let cacheDir = '';
let ready: Promise<void> | null = null;
let writesSincePrune = 0;

export function initWaveformCache(dir: string): void {
  cacheDir = dir;
  closed = false;
  ready = mkdir(dir, { recursive: true })
    .then(() => pruneCache(dir))
    .catch((err) => {
      console.error('[waveform] cache unavailable; waveforms will be rebuilt each session:', err);
      cacheDir = '';
    });
}

async function readCached(key: string): Promise<WaveformData | null> {
  if (!cacheDir) return null;
  const file = join(cacheDir, `${key}.json`);
  try {
    const data = parseWaveformFile(await readFile(file, 'utf8'));
    if (!data) return null;
    // Touch so pruning drops what hasn't been played, not what was built first.
    const now = new Date();
    void utimes(file, now, now).catch(() => undefined);
    return data;
  } catch {
    return null;
  }
}

async function writeCached(key: string, data: WaveformData): Promise<void> {
  if (!cacheDir) return;
  const file = join(cacheDir, `${key}.json`);
  const temp = `${file}.${process.pid}.part`;
  try {
    try {
      await writeFile(temp, encodeWaveformFile(data), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // The folder was removed while the app ran (a cache cleaner, the user).
      await mkdir(cacheDir, { recursive: true });
      await writeFile(temp, encodeWaveformFile(data), 'utf8');
    }
    await rename(temp, file);
    writesSincePrune += 1;
    if (writesSincePrune >= PRUNE_EVERY_WRITES) {
      writesSincePrune = 0;
      void pruneCache(cacheDir).catch(() => undefined);
    }
  } catch (err) {
    console.error('[waveform] could not cache waveform:', err instanceof Error ? err.message : err);
    void unlink(temp).catch(() => undefined);
  }
}

async function pruneCache(dir: string): Promise<void> {
  const names = await readdir(dir);
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    // Left by a crash, unless a write is still in flight.
    const at = (await stat(join(dir, name)).catch(() => null))?.mtimeMs;
    if (at != null && now - at > STALE_PART_MS) void unlink(join(dir, name)).catch(() => undefined);
  }
  const files = names.filter((name) => name.endsWith('.json'));
  if (files.length <= MAX_CACHED_FILES) return;
  const aged = await Promise.all(
    files.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  aged.sort((a, b) => a.at - b.at);
  for (const { name } of aged.slice(0, Math.ceil(files.length / 5))) {
    void unlink(join(dir, name)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Requests and the decode queue

interface Job {
  key: string;
  path: string;
  start: number;
  end: number | null;
  /** The length is known (cue range or library duration), so a decode that fills MAX_SECONDS is not a truncated long file. */
  bounded: boolean;
  /** Asked for ahead of time (the next track); stopped when playback runs short. */
  prefetch: boolean;
  child: ChildProcess | null;
  cancelled: boolean;
  /** The decode was stopped from outside (the Recycle Bin flow); that says nothing about the file. */
  interrupted: boolean;
  settle: (value: WaveformData | null) => void;
}

interface Entry {
  promise: Promise<WaveformData | null>;
  prefetch: boolean;
  /** The cancelWaveformWork() count when the request was made. */
  epoch: number;
  /** Set once the cache has missed and the decode is queued or running. */
  job: Job | null;
}

const inflight = new Map<string, Entry>();
const waiting: Job[] = [];
const liveFfmpeg = new Set<ChildProcess>();
// Tracks that failed to decode or are too short, so a request for one answers
// at once instead of starting ffmpeg again. Not kept for the next session: a
// codec that gets fixed shouldn't stay marked.
const failed = new Set<string>();
let running: Job | null = null;
let pumping = false;
let closed = false;
let epoch = 0;

/**
 * The waveform for a track, from cache or freshly decoded. Resolves null when
 * the track can't have one: a missing file, a clip under a second, a decode
 * failure, or a request that was overtaken by a newer one.
 */
export async function getWaveform(request: WaveformRequest, options: WaveformOptions = {}): Promise<WaveformData | null> {
  if (!request.path || closed) return null;
  if (Number(request.duration) > MAX_SECONDS) return null;
  // Work cancelled while this request was still checking the file is not started for it.
  const born = epoch;
  await ready;
  let info;
  try {
    info = await stat(request.path);
  } catch {
    return null;
  }
  if (born !== epoch || closed) return null;
  const start = Math.max(0, Number(request.cueStart) || 0);
  const end = Number(request.cueEnd) > start ? Number(request.cueEnd) : null;
  const key = waveformCacheKey({ path: request.path, size: info.size, mtimeMs: info.mtimeMs, start, end });
  if (failed.has(key)) return null;

  const prefetch = options.prefetch === true;
  const existing = inflight.get(key);
  // A request that was overtaken is finishing as null; this one starts afresh.
  if (existing && !existing.job?.cancelled && existing.epoch === born) {
    if (existing.prefetch && !prefetch) {
      existing.prefetch = false;
      if (existing.job) makeUrgent(existing.job);
    }
    return existing.promise;
  }
  const entry: Entry = { prefetch, epoch: born, job: null, promise: Promise.resolve(null) };
  const bounded = end != null || Number(request.duration) > 0;
  entry.promise = (async () => {
    const cached = await readCached(key);
    if (cached) return cached;
    return enqueue(entry, { key, path: request.path, start, end, bounded });
  })()
    .catch((err) => {
      console.error('[waveform] failed:', err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
    });
  inflight.set(key, entry);
  return entry.promise;
}

/** ffmpeg processes building a waveform right now. */
export function activeWaveformDecodes(): number {
  return liveFfmpeg.size;
}

/** Process ids of those ffmpeg processes. */
export function activeWaveformPids(): number[] {
  return [...liveFfmpeg].flatMap((child) => (child.pid != null ? [child.pid] : []));
}

/**
 * Stops the decode that is running, drops the ones waiting and answers the
 * requests still reading the cache with null. The queue stays open: a request
 * made afterwards decodes as usual.
 */
export function cancelWaveformWork(): void {
  epoch += 1;
  for (const job of waiting.splice(0)) drop(job);
  if (running) running.cancelled = true;
  for (const child of liveFfmpeg) killChild(child);
}

export function killAllWaveformFfmpeg(): void {
  closed = true;
  cancelWaveformWork();
}

function enqueue(entry: Entry, spec: Pick<Job, 'key' | 'path' | 'start' | 'end' | 'bounded'>): Promise<WaveformData | null> {
  return new Promise((resolve) => {
    if (closed || entry.epoch !== epoch) {
      resolve(null);
      return;
    }
    const job: Job = { ...spec, prefetch: entry.prefetch, child: null, cancelled: false, interrupted: false, settle: resolve };
    entry.job = job;
    if (entry.prefetch) waiting.push(job);
    else makeUrgent(job);
    void pump();
  });
}

// The track being played goes first. Anything still waiting is for a track
// the listener has moved past (the next one's prefetch is asked for after
// this), and a decode already running for another track is wasted work.
function makeUrgent(job: Job): void {
  job.prefetch = false;
  for (const other of waiting.splice(0)) {
    if (other !== job) drop(other);
  }
  if (running === job) return;
  waiting.push(job);
  if (running) {
    running.cancelled = true;
    if (running.child) killChild(running.child);
  }
}

// A prefetch decoding when playback runs short is stopped. It isn't a failure:
// the track decodes again once it is the one playing.
onPlaybackHunger((hungry) => {
  if (!hungry || !running?.prefetch) return;
  running.cancelled = true;
  if (running.child) killChild(running.child);
});

function drop(job: Job): void {
  job.cancelled = true;
  job.settle(null);
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (let job = waiting.shift(); job; job = waiting.shift()) {
      running = job;
      // A drive that is starving playback serves it first.
      await whenPlaybackFed();
      let result: WaveformData | null = null;
      try {
        if (!job.cancelled && !closed) result = await decode(job);
      } catch (err) {
        if (!job.cancelled && !closed) console.error('[waveform] decode failed:', err instanceof Error ? err.message : err);
      }
      running = null;
      if (job.cancelled || closed) {
        job.settle(null);
        continue;
      }
      if (result) await writeCached(job.key, result);
      else if (!job.interrupted) rememberFailure(job.key);
      job.settle(result);
    }
  } finally {
    pumping = false;
  }
}

function rememberFailure(key: string): void {
  if (failed.size >= MAX_REMEMBERED_FAILURES) failed.clear();
  failed.add(key);
}

function decode(job: Job): Promise<WaveformData | null> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    if (job.start > 0) args.push('-ss', String(job.start));
    args.push(
      '-i', job.path,
      '-t', String(job.end != null ? Math.min(MAX_SECONDS, job.end - job.start) : MAX_SECONDS),
      '-vn',
      '-map', '0:a:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', String(WAVEFORM_SAMPLE_RATE),
      'pipe:1',
    );
    const child = spawn(resolveFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    job.child = child;
    liveFfmpeg.add(child);
    watchFfmpegInput(child, job.path);
    // The decode starts at a track change, when playback is most exposed to a
    // busy core (a gapless handoff, the native output thread).
    if (child.pid != null) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* it runs at normal priority */
      }
    }
    const reducer = new PeakReducer();
    let stderr = '';
    let settled = false;
    const settle = (err?: Error, result?: WaveformData | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveFfmpeg.delete(child);
      job.child = null;
      if (err) reject(err);
      else resolve(result ?? null);
    };
    const timer = setTimeout(() => {
      killChild(child);
      settle(new Error('ffmpeg timed out building a waveform'));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => reducer.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on('error', (err) => settle(err));
    child.on('close', (code, signal) => {
      if (job.cancelled) {
        settle(undefined, null);
      } else if (code === 0) {
        const data = reducer.finish();
        // -t cut it off: this is the first three hours of something longer.
        settle(undefined, data && !job.bounded && data.duration >= MAX_SECONDS - 1 ? null : data);
      } else if (code === null && signal) {
        job.interrupted = true;
        settle(undefined, null);
      } else {
        settle(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`));
      }
    });
  });
}
