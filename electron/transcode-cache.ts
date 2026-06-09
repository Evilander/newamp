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
//  - A concurrency semaphore caps CPU so prepareNext warming can't thrash.
//  - Startup janitor deletes orphan .part files; LRU eviction caps disk use.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, stat, unlink, utimes, copyFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpegPath, buildPlaybackFlacArgs } from './transcode.js';
import { caseFoldCachePath } from './cache-key-casing.js';

export type TranscodeResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cache-disabled' | 'ffmpeg-missing' | 'source-missing' | 'transcode-failed' };

// Bump when the encode recipe changes so old cache entries are not reused.
const RECIPE_TAG = 'flac-s32-cl1-v1';
const CACHE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB LRU cap
const MAX_CONCURRENT = Math.max(1, Math.min(2, (cpus()?.length ?? 2) - 1));
// Hard watchdog for a single encode. Generous enough to never abort a legit long
// DSD/APE track (a 20-min source encodes well under this even with soxr), short
// enough to recover from a hung/stalled ffmpeg (truncated/malformed source) that
// would otherwise pin a semaphore slot + inflight entry forever.
const FFMPEG_TIMEOUT_MS = 180_000;

let cacheDir = '';
let readyPromise: Promise<void> | null = null;
let cacheEnabled = false;
let ffmpegOk = false;

const inflight = new Map<string, Promise<string>>();

// --- tiny counting semaphore ---
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  // Wait for a slot to be HANDED to us. release() hands off without decrementing,
  // so we must NOT re-increment here — the slot is inherited atomically. (The old
  // decrement-then-reincrement could transiently over-admit: a fresh acquire() on
  // the same microtask turn as release() saw `active < MAX` and slipped in.)
  await new Promise<void>((res) => waiters.push(res));
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot directly to the next waiter (no decrement)
  else active -= 1;
}

export function initTranscodeCache(dir: string): void {
  cacheDir = dir;
  readyPromise = (async () => {
    try {
      await mkdir(cacheDir, { recursive: true });
      cacheEnabled = true;
    } catch (err) {
      console.error('[newamp] transcode cache dir unavailable; seekable transcode disabled:', err);
      cacheEnabled = false;
    }
    ffmpegOk = await probeFfmpeg();
    if (cacheEnabled) {
      await sweepPartFiles().catch(() => {});
      await evictIfNeeded().catch(() => {});
    }
  })();
}

async function ensureReady(): Promise<void> {
  if (readyPromise) await readyPromise;
}

export async function getOrTranscodeToFlac(filePath: string): Promise<TranscodeResult> {
  await ensureReady();
  if (!cacheEnabled) return { ok: false, reason: 'cache-disabled' };
  if (!ffmpegOk) return { ok: false, reason: 'ffmpeg-missing' };

  let st;
  try {
    st = await stat(filePath);
  } catch {
    return { ok: false, reason: 'source-missing' };
  }

  const key = await canonicalKey(filePath, st.size, st.mtimeMs);
  const finalPath = join(cacheDir, `${key}.flac`);

  if (existsSync(finalPath)) {
    // bump mtime so frequently played tracks survive LRU eviction (best-effort)
    void utimes(finalPath, new Date(), new Date()).catch(() => {});
    return { ok: true, path: finalPath };
  }

  let job = inflight.get(key);
  if (!job) {
    job = runTranscode(filePath, key, finalPath);
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
    console.error('[newamp] transcode cache failed for', filePath, err);
    return { ok: false, reason: 'transcode-failed' };
  }
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
    let stderr = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    // Watchdog: a malformed/truncated source can stall ffmpeg on demux so it never
    // closes — that would hold a semaphore slot AND the inflight entry forever,
    // wedging all ffmpeg-mode playback. Kill + reject so runTranscode unlinks the
    // temp, the slot is released, and the protocol handler falls back to the live
    // stream. (See probeFfmpeg for the same pattern.)
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms for ${inputPath}`));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on('error', (err) => done(err));
    child.on('close', (code) => {
      if (code === 0) done();
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
  } catch {
    /* keep original */
  }
  canon = canon.replace(/\\/g, '/');
  canon = caseFoldCachePath(canon, process.platform);
  return createHash('sha1')
    .update(`${canon}|${size}|${Math.round(mtimeMs)}|${RECIPE_TAG}`)
    .digest('hex')
    .slice(0, 40);
}

async function probeFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(resolveFfmpegPath(), ['-hide_banner', '-version'], { windowsHide: true });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done(false);
      }, 3000);
      child.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
}

async function sweepPartFiles(): Promise<void> {
  const entries = await readdir(cacheDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.part'))
      .map((name) => unlink(join(cacheDir, name)).catch(() => {})),
  );
}

async function evictIfNeeded(): Promise<void> {
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
  for (const f of files) {
    if (total <= CACHE_BUDGET_BYTES) break;
    try {
      await unlink(f.path);
      total -= f.size;
    } catch {
      /* in use; skip */
    }
  }
}

// Test/diagnostics hook.
export function transcodeCacheStatus(): { dir: string; enabled: boolean; ffmpeg: boolean } {
  return { dir: cacheDir, enabled: cacheEnabled, ffmpeg: ffmpegOk };
}
