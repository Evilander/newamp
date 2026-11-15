// Seekable transcode cache.
//
// Problem: Chromium's <audio> can only seek a resource that is byte-range
// addressable with a known total size. The live ffmpeg WAV pipe
// (transcodeToWavResponse) returns `Accept-Ranges: none` with no Content-Length,
// so scrubbing any ffmpeg-mode file (.wma/.alac/.aiff/.dsf/.dff/.ape/.wv/.mpc/
// .tta/.mka/.ac3/.dts + unknown exts) snapped playback back to 0.
//
// Fix: transcode each ffmpeg-mode source ONCE to a finalized, lossless FLAC file
// on disk (keyed by path+size+mtime), then serve it through the same Range-aware
// net.fetch(file://) path the native formats use. A finalized FLAC has a real
// Content-Length and STREAMINFO total-samples, so net.fetch returns 206 and seek
// works. Repeat plays/seeks are instant (cache hit).
//
// Hardening (from adversarial review):
//  - In-flight job map dedups concurrent requests for the same track (Chromium
//    fires 2-3 fetches per <audio> src, plus gapless prepareNext) so ffmpeg runs
//    exactly once and no one ever sees a half-written file.
//  - The protocol handler AWAITS the job before serving, so a Range request never
//    hits a partial file.
//  - Per-job temp names + atomic rename (with copy-fallback for Windows
//    Defender/OneDrive EBUSY) — no shared .part, no corruption.
//  - STREAMINFO total-samples is verified after encode; a 0 (unfinalized) file is
//    rejected so we never advertise a non-seekable FLAC.
//  - ffmpeg availability is probed once; missing ffmpeg yields a clean reason, not
//    an empty body.
//  - A concurrency semaphore caps CPU so prepareNext warming can't thrash, and
//    its queue is short: skipping through tracks drops the warms for the ones
//    skipped instead of encoding each over a slow share.
//  - Startup janitor deletes orphan .part files; LRU eviction caps disk use.
//  - A storage error (a network share timing out) is never read as a missing
//    source: a track already cached keeps being served from the cache.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, stat, unlink, utimes, copyFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { killChild } from './kill-child.js';
import { isStorageError, watchReadFailures } from './read-failure.js';
import { probeResampler } from './resampler.js';
import { resolveFfmpegPath, buildPlaybackFlacArgs, watchFfmpegInput, watchFfmpegProgress } from './transcode.js';
import { caseFoldCachePath } from './cache-key-casing.js';

export type TranscodeResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cache-disabled' | 'ffmpeg-missing' | 'source-missing' | 'source-unreadable' | 'transcode-failed' };

// Bump when the encode recipe changes so old cache entries are not reused. The
// v2 bump retires FLACs cached from a read that failed partway: ffmpeg finishes
// those with a valid header, so they passed every check and ended the track early.
const RECIPE_TAG = 'flac-s32-cl1-v2';
// Finished files carry the recipe in their name, so the janitor can tell the
// ones an earlier recipe made.
const FINAL_SUFFIX = `.${RECIPE_TAG}.flac`;
const CACHE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB LRU cap
// A file used within this long is not evicted: it is the track playing or one
// just warmed for the next.
const EVICT_RECENT_MS = 5 * 60_000;
const MAX_CONCURRENT = Math.max(1, Math.min(2, (cpus()?.length ?? 2) - 1));
// Encodes waiting for a slot beyond the ones running. A new request past this
// drops the oldest waiting one.
const MAX_QUEUED = 2;
// A failed encode is not started again for this long (it grows with each
// failure), so the 2-3 fetches Chromium makes per track don't each re-read a
// source that is failing.
const FAILURE_BACKOFF_MS = [30_000, 120_000, 600_000];
const FAILURE_MEMORY_CAP = 256;
// How long after a failed probe the next request may probe ffmpeg again.
const FFMPEG_REPROBE_MS = 30_000;
// The first run of a freshly installed bundled ffmpeg can take seconds (the
// system scans it), so the probe waits this long before calling it missing.
const FFMPEG_PROBE_TIMEOUT_MS = 15_000;
const KNOWN_SOURCES_CAP = 4096;

let cacheDir = '';
let readyPromise: Promise<void> | null = null;
let cacheEnabled = false;
let ffmpegOk = false;
let lastProbeAt = 0;
let probing: Promise<boolean> | null = null;

const inflight = new Map<string, Promise<string>>();
// The cached FLAC of each source path that has had one, so a request made
// while the share stops answering can still be served from disk.
const knownFlacs = new Map<string, string>();
const failures = new Map<string, { failedAt: number; attempts: number }>();

// The share did not answer: not a fault of the file, so it is not held against it.
class TranscodeReadFailedError extends Error {}
// Dropped from the queue because newer requests came in.
class TranscodeSupersededError extends Error {}

// --- tiny counting semaphore ---
let active = 0;
const waiters: Array<{ grant: () => void; drop: (err: Error) => void }> = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  // Wait for a slot to be HANDED to us. release() hands off without decrementing,
  // so we must NOT re-increment here — the slot is inherited atomically. (The old
  // decrement-then-reincrement could transiently over-admit: a fresh acquire() on
  // the same microtask turn as release() saw `active < MAX` and slipped in.)
  await new Promise<void>((grant, drop) => {
    waiters.push({ grant, drop });
    while (waiters.length > MAX_QUEUED) waiters.shift()!.drop(new TranscodeSupersededError('a newer track is waiting'));
  });
}
function release(): void {
  const next = waiters.shift();
  if (next) next.grant(); // hand the slot directly to the next waiter (no decrement)
  else active -= 1;
}

function rememberFlac(filePath: string, finalPath: string): void {
  knownFlacs.delete(filePath);
  knownFlacs.set(filePath, finalPath);
  if (knownFlacs.size > KNOWN_SOURCES_CAP) knownFlacs.delete(knownFlacs.keys().next().value!);
}

function recordFailure(key: string, err: unknown): void {
  if (err instanceof TranscodeReadFailedError || err instanceof TranscodeSupersededError) return;
  const attempts = (failures.get(key)?.attempts ?? 0) + 1;
  failures.delete(key);
  failures.set(key, { failedAt: Date.now(), attempts });
  if (failures.size > FAILURE_MEMORY_CAP) failures.delete(failures.keys().next().value!);
}

function inFailureBackoff(key: string): boolean {
  const failure = failures.get(key);
  if (!failure) return false;
  const wait = FAILURE_BACKOFF_MS[Math.min(failure.attempts, FAILURE_BACKOFF_MS.length) - 1]!;
  return Date.now() - failure.failedAt < wait;
}

// Everything here can be made again from the music files, and it grows to
// the 8 GB cap; Time Machine would copy each new file on every backup.
// Written straight onto the folder: the attribute `tmutil addexclusion` sets
// (a binary plist naming com.apple.backupd). tmutil itself goes through
// backupd and took eight seconds when the app ran it; xattr takes a few ms.
const TIME_MACHINE_EXCLUDE_ATTR = 'com.apple.metadata:com_apple_backup_excludeItem';
const TIME_MACHINE_EXCLUDE_VALUE =
  '62706C69737430305F1011636F6D2E6170706C652E6261636B75706408000000000000010100000000000000010000000000000000000000000000001C';

function excludeFromBackups(dir: string): void {
  if (process.platform !== 'darwin') return;
  execFile('/usr/bin/xattr', ['-wx', TIME_MACHINE_EXCLUDE_ATTR, TIME_MACHINE_EXCLUDE_VALUE, dir], () => undefined);
}

export function initTranscodeCache(dir: string): void {
  cacheDir = dir;
  readyPromise = (async () => {
    try {
      await mkdir(cacheDir, { recursive: true });
      cacheEnabled = true;
      excludeFromBackups(cacheDir);
    } catch (err) {
      console.error('[newamp] transcode cache dir unavailable; seekable transcode disabled:', err);
      cacheEnabled = false;
    }
    // Also learn which resampler this ffmpeg runs, so the DSD recipes (which
    // build their arguments synchronously) never have to probe inline.
    await Promise.all([runFfmpegProbe(), probeResampler(resolveFfmpegPath())]);
    if (cacheEnabled) {
      await dropOldRecipeFiles().catch(() => {});
      await sweepPartFiles().catch(() => {});
      await evictIfNeeded().catch(() => {});
    }
  })();
}

async function ensureReady(): Promise<void> {
  if (readyPromise) await readyPromise;
}

// Where a source's cached FLAC lives. Throws when the source can't be read,
// which for a share that timed out is a storage error.
async function locate(filePath: string): Promise<{ key: string; finalPath: string }> {
  const st = await stat(filePath);
  const key = await canonicalKey(filePath, st.size, st.mtimeMs);
  return { key, finalPath: join(cacheDir, `${key}${FINAL_SUFFIX}`) };
}

// The cached FLAC remembered for a source the share won't answer for, so a
// track served from the cache keeps playing from it (a different file with a
// different layout mid-play would restart it).
function rememberedFlac(filePath: string, err: unknown): string | null {
  const remembered = isStorageError(err) ? knownFlacs.get(filePath) : undefined;
  return remembered && existsSync(remembered) ? remembered : null;
}

export async function getOrTranscodeToFlac(filePath: string): Promise<TranscodeResult> {
  await ensureReady();
  if (!cacheEnabled) return { ok: false, reason: 'cache-disabled' };

  let located;
  try {
    located = await locate(filePath);
  } catch (err) {
    if (!isStorageError(err)) return { ok: false, reason: 'source-missing' };
    const remembered = rememberedFlac(filePath, err);
    return remembered ? { ok: true, path: remembered } : { ok: false, reason: 'source-unreadable' };
  }
  const { key, finalPath } = located;

  if (existsSync(finalPath)) {
    // bump mtime so frequently played tracks survive LRU eviction (best-effort)
    void utimes(finalPath, new Date(), new Date()).catch(() => {});
    rememberFlac(filePath, finalPath);
    return { ok: true, path: finalPath };
  }
  if (!(await ensureFfmpeg())) return { ok: false, reason: 'ffmpeg-missing' };

  let job = inflight.get(key);
  if (!job) {
    if (inFailureBackoff(key)) return { ok: false, reason: 'transcode-failed' };
    job = runTranscode(filePath, key, finalPath).then(
      (path) => {
        failures.delete(key);
        rememberFlac(filePath, path);
        return path;
      },
      (err) => {
        recordFailure(key, err);
        throw err;
      },
    );
    inflight.set(key, job);
    // `.finally` returns a promise that mirrors the rejection; the caller handles
    // the original via `await job`, so swallow this side-chain to avoid a spurious
    // unhandledRejection (which would spam the crash-triage diagnostic channel).
    void job.finally(() => inflight.delete(key)).catch(() => {});
  }

  try {
    const path = await job;
    return { ok: true, path };
  } catch (err) {
    if (!(err instanceof TranscodeSupersededError)) console.error('[newamp] transcode cache failed for', filePath, err);
    return { ok: false, reason: 'transcode-failed' };
  }
}

/**
 * Non-blocking probe: returns the finalized cached FLAC's path, or null.
 * Never transcodes, never touches the semaphore or inflight map — safe to call
 * on the hot serve path. (`finalPath` only exists post-atomic-rename, so a
 * half-written `.part` can never satisfy this.)
 */
export async function peekCachedFlac(filePath: string): Promise<string | null> {
  await ensureReady();
  if (!cacheEnabled) return null;
  let located;
  try {
    located = await locate(filePath);
  } catch (err) {
    return rememberedFlac(filePath, err);
  }
  const { finalPath } = located;
  if (!existsSync(finalPath)) {
    // A miss is followed by a check that ffmpeg works; let a probe that failed
    // early on (a slow first start) be redone before that check answers.
    if (!ffmpegOk) await ensureFfmpeg();
    return null;
  }
  // Bump mtime so frequently played tracks survive LRU eviction (best-effort).
  void utimes(finalPath, new Date(), new Date()).catch(() => {});
  rememberFlac(filePath, finalPath);
  return finalPath;
}

async function runTranscode(filePath: string, key: string, finalPath: string): Promise<string> {
  await acquire();
  // Per-job temp name (pid + random) so concurrent/leftover jobs never collide.
  const rand = createHash('sha1').update(`${Date.now()}:${process.hrtime.bigint()}:${key}`).digest('hex').slice(0, 8);
  const temp = join(cacheDir, `${key}.${process.pid}.${rand}.flac.part`);
  try {
    if (existsSync(finalPath)) return finalPath; // won the race while waiting on the semaphore
    await runFfmpegToFile(filePath, temp);
    const total = await readFlacTotalSamples(temp).catch(() => 0);
    if (!total || total <= 0) {
      // STREAMINFO total-samples unfinalized -> the file is NOT reliably seekable.
      await unlink(temp).catch(() => {});
      throw new Error('FLAC STREAMINFO total-samples is 0 (unseekable); rejecting cache entry');
    }
    await atomicRename(temp, finalPath);
    void evictIfNeeded().catch(() => {});
    return finalPath;
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  } finally {
    release();
  }
}

function runFfmpegToFile(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    const child = spawn(ffmpeg, buildPlaybackFlacArgs(inputPath, outputPath), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    watchFfmpegInput(child, inputPath);
    const readFailed = watchReadFailures(child, inputPath);
    let stderr = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      stopWatching();
      if (err) reject(err);
      else resolve();
    };
    // Watchdog: a malformed/truncated source can stall ffmpeg on demux so it never
    // closes — that would hold a semaphore slot AND the inflight entry forever,
    // wedging all ffmpeg-mode playback. The temp file growing is what shows an
    // encode is alive, so a long source on a slow share is left to finish and
    // only a stalled one is killed; runTranscode then unlinks the temp, the slot
    // is released, and the protocol handler falls back to the live stream.
    const stopWatching = watchFfmpegProgress(child, (why) => {
      killChild(child);
      done(new Error(`ffmpeg ${why} for ${inputPath}`));
    }, { outputPath });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on('error', (err) => done(err));
    child.on('close', (code) => {
      // ffmpeg finishes the FLAC after a failed read too; cached, the track would end there for good.
      if (readFailed()) done(new TranscodeReadFailedError(`a read of ${inputPath} failed partway; not caching the transcode`));
      else if (code === 0) done();
      else done(new Error(`ffmpeg exited ${code ?? 'unknown'} for ${inputPath}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

// Parse STREAMINFO total-samples directly from the FLAC header (no ffprobe — the
// bundled ffmpeg-static ships ffmpeg only). Nonzero proves duration is known and
// the file is seekable.
async function readFlacTotalSamples(path: string): Promise<number> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(26);
    const { bytesRead } = await fh.read(buf, 0, 26, 0);
    if (bytesRead < 26) return 0;
    if (buf.toString('ascii', 0, 4) !== 'fLaC') return 0;
    // Metadata block header at offset 4: type must be STREAMINFO (0). Body at 8.
    if ((buf[4] & 0x7f) !== 0) return 0;
    // Packed 64-bit field begins at body offset 10 => file offset 18:
    // [20b sampleRate][3b channels-1][5b bps-1][36b totalSamples]
    const packed = buf.readBigUInt64BE(18);
    const totalSamples = Number(packed & 0xfffffffffn); // low 36 bits
    return totalSamples;
  } finally {
    await fh.close();
  }
}

async function atomicRename(temp: string, finalPath: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rename(temp, finalPath);
      return;
    } catch (err: any) {
      // Last resort: copy to a staging `.copy.part`, then atomically rename THAT
      // into place (works when the direct rename is blocked by a sharing lock).
      // Copying straight to finalPath would be non-atomic — a crash mid-copy
      // leaves a truncated file that the next cache-hit serves blindly. Staging
      // guarantees finalPath only ever appears via an atomic rename.
      if (attempt === 3) {
        const stage = `${finalPath}.copy.part`;
        await copyFile(temp, stage);
        try {
          await rename(stage, finalPath);
        } catch (renameErr) {
          await unlink(stage).catch(() => {});
          throw renameErr;
        }
        await unlink(temp).catch(() => {});
        return;
      }
      // Windows Defender / OneDrive can briefly hold a freshly written file (EBUSY/EPERM/EACCES).
      if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') {
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function canonicalKey(filePath: string, size: number, mtimeMs: number): Promise<string> {
  let canon = filePath;
  try {
    canon = await realpath(filePath);
  } catch (err) {
    // Another path would key a different entry, as if the track had never
    // been cached.
    if (isStorageError(err)) throw err;
  }
  canon = canon.replace(/\\/g, '/');
  canon = caseFoldCachePath(canon, process.platform);
  return createHash('sha1')
    .update(`${canon}|${size}|${Math.round(mtimeMs)}|${RECIPE_TAG}`)
    .digest('hex')
    .slice(0, 40);
}

// Probes ffmpeg and records the answer. A failed probe is not final: see ensureFfmpeg.
async function runFfmpegProbe(): Promise<boolean> {
  lastProbeAt = Date.now();
  ffmpegOk = await probeFfmpeg();
  return ffmpegOk;
}

// Whether ffmpeg works. After a failed probe it is tried again, at most once per
// FFMPEG_REPROBE_MS, so one slow start doesn't turn off ffmpeg-mode playback
// until the app restarts.
async function ensureFfmpeg(): Promise<boolean> {
  if (ffmpegOk) return true;
  if (probing) return probing;
  if (Date.now() - lastProbeAt < FFMPEG_REPROBE_MS) return false;
  probing = runFfmpegProbe().finally(() => {
    probing = null;
  });
  return probing;
}

async function probeFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, why?: string) => {
      if (settled) return;
      settled = true;
      if (!ok) console.error(`[newamp] ffmpeg probe failed: ${why ?? 'unknown'}`);
      resolve(ok);
    };
    try {
      const child = spawn(resolveFfmpegPath(), ['-hide_banner', '-version'], { windowsHide: true });
      const timer = setTimeout(() => {
        killChild(child);
        done(false, `no answer in ${FFMPEG_PROBE_TIMEOUT_MS}ms`);
      }, FFMPEG_PROBE_TIMEOUT_MS);
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        done(false, err.code ?? err.message);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0, `exit code ${code ?? 'unknown'}`);
      });
    } catch (err) {
      done(false, err instanceof Error ? err.message : String(err));
    }
  });
}

// Files made by an earlier recipe are never matched again (their keys differ),
// so they only take up the budget.
async function dropOldRecipeFiles(): Promise<void> {
  const entries = await readdir(cacheDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.flac') && !name.endsWith(FINAL_SUFFIX))
      .map((name) => unlink(join(cacheDir, name)).catch(() => {})),
  );
}

async function sweepPartFiles(): Promise<void> {
  const entries = await readdir(cacheDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.part'))
      .map((name) => unlink(join(cacheDir, name)).catch(() => {})),
  );
}

// One pass at a time: two passes over the same listing each count files the
// other already removed and delete on past the budget. A call made during a
// pass asks for another pass once it ends.
let evicting: Promise<void> | null = null;
let evictAgain = false;
function evictIfNeeded(): Promise<void> {
  if (evicting) {
    evictAgain = true;
    return evicting;
  }
  const pass = (async () => {
    do {
      evictAgain = false;
      await evictOnce();
    } while (evictAgain);
  })();
  evicting = pass.finally(() => {
    evicting = null;
  });
  return evicting;
}

async function evictOnce(): Promise<void> {
  if (!cacheEnabled) return;
  const entries = await readdir(cacheDir).catch(() => [] as string[]);
  const flacs = await Promise.all(
    entries
      .filter((name) => name.endsWith('.flac'))
      .map(async (name) => {
        const p = join(cacheDir, name);
        try {
          const s = await stat(p);
          return { path: p, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const files = flacs.filter((f): f is { path: string; size: number; mtimeMs: number } => f !== null);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= CACHE_BUDGET_BYTES) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest (LRU) first
  const now = Date.now();
  for (const f of files) {
    if (total <= CACHE_BUDGET_BYTES) break;
    if (now - f.mtimeMs < EVICT_RECENT_MS) break; // the rest are newer still
    try {
      await unlink(f.path);
      total -= f.size;
    } catch (err) {
      // Already gone counts as freed; anything else is in use, so skip it.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') total -= f.size;
    }
  }
}

// Test/diagnostics hook.
export function transcodeCacheStatus(): { dir: string; enabled: boolean; ffmpeg: boolean } {
  return { dir: cacheDir, enabled: cacheEnabled, ffmpeg: ffmpegOk };
}
