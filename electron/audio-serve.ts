// Range-aware audio responses for the newamp:// protocol.
//
// Chromium's media stack only treats a resource as seekable when its Range
// probe (`Range: bytes=0-`) is answered with a real `206 Partial Content` +
// `Content-Range` + `Content-Length`. Electron's net.fetch(file://) SLICES the
// body per the Range header but answers `200` with none of those headers
// (verified empirically on Electron 37 / Windows), so every track — native
// FLAC/MP3 included — was classified as an endless stream and every scrub
// snapped back to 0:00. This module answers 200/206/416 with correct headers
// straight from the filesystem, and makes even the live ffmpeg transcode pipe
// seekable by exploiting that PCM-in-WAV is constant-bitrate: byte offsets map
// linearly to seconds, so a Range request becomes an `ffmpeg -ss` spawn.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Stats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import {
  isMissingError,
  isStorageError,
  isStorageReadFailure,
  logReadFailure,
  probeFileRead,
  rememberStorageGone,
  storageAnswered,
  storageKnownGone,
  storageOutageMs,
  storageRetryDelay,
  STORAGE_OUTAGE_MS,
  volumeAway,
  watchReadFailureKind,
} from './read-failure.js';

type PcmChild = ChildProcessByStdio<null, Readable, Readable>;
import { resamplerFilter, resamplerKindNow } from './resampler.js';
import { INPUT_PROTOCOLS, resolveFfmpegPath, transcodeToWavResponse, watchFfmpegInput } from './transcode.js';
import { killChild } from './kill-child.js';

const AUDIO_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function audioContentType(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

interface ByteRange {
  start: number;
  end: number; // inclusive
}

// Returns null when no Range header, 'invalid' when unsatisfiable.
function parseRange(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)(?:,|$)/.exec(header.trim());
  if (!m) return 'invalid';
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  if (rawStart === '') {
    // suffix range: last N bytes
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    const start = Math.max(0, size - n);
    return start >= size ? 'invalid' : { start, end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(size - 1, Number(rawEnd));
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return { start, end };
}

// A network share that times out partway through a file fails a read, not the
// file. A body that errored there would make Chromium give the track up and
// the queue move on, so the read is tried again at the same offset, with a
// fresh handle, until the share answers or has been gone STORAGE_OUTAGE_MS: the
// response arrives late instead of cut short.
const READ_CHUNK_BYTES = 256 * 1024;

// One outage clock per file, whichever response is waiting on it. Chromium asks
// again for a body that errored, up to thirty times over, and a clock per
// request would give each of those a whole outage of its own to wait out: the
// track would sit on Buffering for many minutes after the share was given up
// on. With one clock the first request does the waiting, and the ones that
// follow fail at once until the file reads again or nothing has asked for it
// in a while.
const outages = new Map<string, { since: number; last: number }>();
const OUTAGE_RECORDS = 256;

/** Notes a read of `filePath` that the storage just failed. True once it has been failing for `budgetMs`. */
function outageSpent(filePath: string, budgetMs = STORAGE_OUTAGE_MS): boolean {
  const now = performance.now();
  let outage = outages.get(filePath);
  if (!outage || now - outage.last >= STORAGE_OUTAGE_MS) outage = { since: now, last: now };
  outage.last = now;
  outages.delete(filePath);
  outages.set(filePath, outage);
  if (outages.size > OUTAGE_RECORDS) outages.delete(outages.keys().next().value!);
  return now - outage.since >= budgetMs;
}

function outageOver(filePath: string): void {
  outages.delete(filePath);
  storageAnswered(filePath);
}

/**
 * Whether a read of `filePath` that the storage just failed is to be given up
 * on: the storage it is on was given up on a moment ago for another file, or
 * this file's own outage has lasted as long as `err` is waited out. Giving up
 * is noted against the storage, so the files that follow are not each waited
 * on in turn.
 */
function outageGivenUp(filePath: string, err?: unknown): boolean {
  if (!storageKnownGone(filePath) && !outageSpent(filePath, storageOutageMs(err))) return false;
  rememberStorageGone(filePath, err);
  return true;
}

// What opening a file can answer while its share is coming back: the path is
// not there yet, or the server has not let this user back in.
const REOPEN_REFUSALS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

function storageUnavailable(): Response {
  return new Response('Storage unavailable', { status: 503, headers: { 'Retry-After': '5' } });
}

/** Bytes `start`..`end` (inclusive) of `filePath`, read on demand. */
export function fileBody(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
  let handle: FileHandle | null = null;
  let pos = start;
  let closed = false;
  const dropHandle = (): Promise<void> => {
    const h = handle;
    handle = null;
    return h ? h.close().catch(() => undefined) : Promise.resolve();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let failing = false;
      let attempt = 0;
      while (!closed) {
        if (pos > end) {
          closed = true;
          await dropHandle();
          controller.close();
          return;
        }
        try {
          if (!handle) {
            const opened = await open(filePath, 'r');
            // Cancelled while the file was opening: cancel() found no handle
            // to close, so this one is closed here.
            if (closed) {
              await opened.close().catch(() => undefined);
              return;
            }
            handle = opened;
          }
          const want = Math.min(READ_CHUNK_BYTES, end - pos + 1);
          const chunk = Buffer.allocUnsafe(want);
          const { bytesRead } = await handle.read(chunk, 0, want, pos);
          if (closed) {
            await dropHandle();
            return;
          }
          // The file got shorter than its Content-Length: nothing to wait for.
          if (bytesRead === 0) throw Object.assign(new Error(`${filePath} ended at byte ${pos}`), { code: 'ESHORT' });
          pos += bytesRead;
          outageOver(filePath);
          controller.enqueue(chunk.subarray(0, bytesRead));
          return;
        } catch (err) {
          if (closed) {
            await dropHandle();
            return;
          }
          // The storage's own error; or the file is not there because its
          // drive letter or share has gone; or, once a read has failed that
          // way, whatever opening the file again answers before the share is
          // all the way back.
          const refused = REOPEN_REFUSALS.has(String((err as NodeJS.ErrnoException).code));
          const storage =
            isStorageError(err) || (refused && failing) || (isMissingError(err) && (await volumeAway(filePath)));
          if (closed) {
            await dropHandle();
            return;
          }
          if (!storage || outageGivenUp(filePath, err)) {
            closed = true;
            await dropHandle();
            controller.error(err);
            return;
          }
          failing = true;
          // A handle opened before the share dropped can stay broken.
          await dropHandle();
          attempt += 1;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, storageRetryDelay(attempt)));
        }
      }
    },
    async cancel() {
      closed = true;
      await dropHandle();
    },
  });
}

/**
 * The file's stat, waited for like a read while its storage is away: tried
 * again until the storage answers, the outage has lasted too long, or the
 * request is gone. 'unavailable' is the storage never answering, which is not
 * the same as null, a file that is not there.
 */
async function statOnceAvailable(filePath: string, signal: AbortSignal): Promise<Stats | 'unavailable' | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const info = await stat(filePath);
      outageOver(filePath);
      return info;
    } catch (err) {
      // A drive letter or a share that has gone answers as a missing file does.
      if (!isStorageError(err) && !(isMissingError(err) && (await volumeAway(filePath)))) return null;
      if (signal.aborted || outageGivenUp(filePath, err)) return 'unavailable';
      await new Promise((resolveDelay) => setTimeout(resolveDelay, storageRetryDelay(attempt)));
      // Nobody is waiting for the answer any more (a seek, a skip).
      if (signal.aborted) return 'unavailable';
    }
  }
}

/**
 * Serve a file on disk with real byte-range semantics (200/206/416).
 * Used for native-format tracks AND finalized cached FLACs — the two cases
 * that previously trusted net.fetch(file://) and got non-seekable 200s.
 */
export async function fileRangeResponse(
  filePath: string,
  request: Request,
  headerOverrides: Record<string, string> = {},
): Promise<Response> {
  // A share that times out on the stat is waited on like one that times out
  // on a read: a 404 here would make Chromium give the track up.
  const info = await statOnceAvailable(filePath, request.signal);
  if (info === 'unavailable') return storageUnavailable();
  if (!info) return new Response('Not found', { status: 404 });
  const { size } = info;

  const baseHeaders: Record<string, string> = {
    ...AUDIO_CORS_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Type': audioContentType(filePath),
    'Cache-Control': 'no-store',
    ...headerOverrides,
  };

  const range = parseRange(request.headers.get('Range'), size);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
    });
  }

  if (!range) {
    return new Response(fileBody(filePath, 0, size - 1), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(size) },
    });
  }

  return new Response(fileBody(filePath, range.start, range.end), {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Seekable live transcode: WAV(f32le) with synthesized header + ffmpeg -ss
// ---------------------------------------------------------------------------

interface PcmStreamInfo {
  durationSec: number;
  sampleRate: number; // post-pipeline rate (DSD is pinned to 88200)
}

const probeCache = new Map<string, PcmStreamInfo>();
// Simple LRU cap: without one, every unique ffmpeg-fallback source probed over
// an app session accumulates here forever. Map preserves insertion order, so
// the oldest (first) key is the least-recently-touched entry.
const PROBE_CACHE_MAX_ENTRIES = 500;

function probeCacheSet(key: string, info: PcmStreamInfo): void {
  probeCache.set(key, info);
  if (probeCache.size > PROBE_CACHE_MAX_ENTRIES) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) probeCache.delete(oldest);
  }
}

function probeCacheGet(key: string): PcmStreamInfo | undefined {
  const hit = probeCache.get(key);
  if (hit) {
    // Refresh recency: delete + re-set moves this key to the end of Map's
    // insertion order, the newest position.
    probeCache.delete(key);
    probeCache.set(key, hit);
  }
  return hit;
}

// A probe reads a file's header and exits; one still running after this long is stuck in a read.
const PROBE_TIMEOUT_MS = 15_000;

function isDsdPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === '.dsf' || ext === '.dff';
}

/**
 * Duration + sample rate via `ffmpeg -i` stderr (ffmpeg-static ships no
 * ffprobe). Returns null when the source is unreadable — callers fall back to
 * the legacy non-seekable pipe so playback never gates on the probe. Returns
 * 'unavailable' when it is the storage that did not answer, for the stat or
 * for the probe's own read: that says nothing about the source, and falling
 * back for it would play the track with no length and no way to seek.
 */
export async function probePcmStreamInfo(
  filePath: string,
  signal: AbortSignal,
): Promise<PcmStreamInfo | 'unavailable' | null> {
  const st = await statOnceAvailable(filePath, signal);
  if (st === 'unavailable' || !st) return st;
  const cacheKey = `${filePath}|${st.size}|${Math.round(st.mtimeMs)}`;
  const cached = probeCacheGet(cacheKey);
  if (cached) return cached;

  let stderr: string | null;
  for (let attempt = 1; ; attempt++) {
    const answer = await runProbe(filePath);
    // A probe whose read the storage failed, or that sat in one until it was
    // stopped, learned nothing about the file: it is run again while the
    // outage lasts.
    const failure = answer && answer !== 'stalled' ? logReadFailure(answer, filePath) : null;
    if (answer !== 'stalled' && !(failure && (await isStorageReadFailure(failure, filePath)))) {
      stderr = answer;
      break;
    }
    if (signal.aborted || outageGivenUp(filePath)) return 'unavailable';
    await new Promise((resolveDelay) => setTimeout(resolveDelay, storageRetryDelay(attempt)));
    if (signal.aborted) return 'unavailable';
  }
  if (!stderr) return null;

  const durMatch = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/.exec(stderr);
  const rateMatch = /Audio:[^\n]*?(\d{4,6})\s*Hz/.exec(stderr);
  if (!durMatch || !rateMatch) return null;
  const durationSec =
    Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) + Number(durMatch[4]) / 100;
  const sourceRate = Number(rateMatch[1]);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(sourceRate) || sourceRate <= 0) {
    return null;
  }
  const info: PcmStreamInfo = {
    durationSec,
    sampleRate: isDsdPath(filePath) ? 88200 : sourceRate,
  };
  probeCacheSet(cacheKey, info);
  return info;
}

/** What `ffmpeg -i` printed about the file; null if ffmpeg could not be run, 'stalled' if it had to be stopped. */
function runProbe(filePath: string): Promise<string | 'stalled' | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | 'stalled' | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(resolveFfmpegPath(), ['-hide_banner', ...INPUT_PROTOCOLS, '-i', filePath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killChild(child);
        done('stalled');
      }, PROBE_TIMEOUT_MS);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        out += chunk;
        if (out.length > 60_000) out = out.slice(-60_000);
      });
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      // ffmpeg exits non-zero for probe-only invocations; stderr still has the
      // stream banner we need.
      child.on('close', () => {
        clearTimeout(timer);
        done(out);
      });
    } catch {
      done(null);
    }
  });
}

// f32le stereo: 2 channels x 4 bytes.
const BYTES_PER_FRAME = 8;
// RIFF(12) + fmt-18(26) + fact(12) + data header(8). IEEE-float WAV requires
// the 18-byte fmt chunk (cbSize=0) plus a fact chunk per the spec; Chromium's
// ffmpeg-based demuxer reads this layout natively.
const WAV_PRELUDE_BYTES = 58;

function buildWavPrelude(frames: number, sampleRate: number): Buffer {
  const dataBytes = frames * BYTES_PER_FRAME;
  const buf = Buffer.alloc(WAV_PRELUDE_BYTES);
  const u32 = (v: number) => Math.min(0xffffffff, v); // >4GiB: stream convention
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(u32(dataBytes + WAV_PRELUDE_BYTES - 8), o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(18, o); o += 4;
  buf.writeUInt16LE(3, o); o += 2; // WAVE_FORMAT_IEEE_FLOAT
  buf.writeUInt16LE(2, o); o += 2; // channels
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(sampleRate * BYTES_PER_FRAME, o); o += 4; // byte rate
  buf.writeUInt16LE(BYTES_PER_FRAME, o); o += 2; // block align
  buf.writeUInt16LE(32, o); o += 2; // bits per sample
  buf.writeUInt16LE(0, o); o += 2; // cbSize
  buf.write('fact', o); o += 4;
  buf.writeUInt32LE(4, o); o += 4;
  buf.writeUInt32LE(u32(frames), o); o += 4;
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(u32(dataBytes), o);
  return buf;
}

function spawnPcmDecoder(filePath: string, seekSec: number): PcmChild {
  const dsd = isDsdPath(filePath);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (seekSec > 0) args.push('-ss', seekSec.toFixed(6));
  args.push(...INPUT_PROTOCOLS, '-i', filePath, '-map', '0:a:0', '-vn');
  if (dsd) args.push('-af', resamplerFilter(resamplerKindNow(resolveFfmpegPath())), '-ar', '88200');
  args.push('-acodec', 'pcm_f32le', '-ac', '2', '-f', 'f32le', 'pipe:1');
  const child = spawn(resolveFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // Held open under backpressure for as long as the track plays, so a move to
  // the Recycle Bin has to be able to stop it.
  watchFfmpegInput(child, filePath);
  return child;
}

// The probed length can be off by this much (a header's estimate), and a
// damaged file that stops this close to its end has as good as played out:
// that much is made up with silence. Further short than this, the decode
// stopped before the end of the track.
const END_SLACK_SEC = 2;
// How far before the stop a decoder that carries on seeks, to be discarded:
// the first frames decoded after a seek are not what a decode from the start
// gives there (see the gapless transport's spawnDecoder).
const RESUME_WARMUP_SEC = 0.25;
// How many times in a row a decoder is started to look past an early stop,
// with less than a second gained each time, before the decode is given up on.
const MAX_LOOKS_PAST_AN_EXIT = 3;

/**
 * Body stream: optional prelude bytes, then ffmpeg PCM with `dropBytes`
 * discarded from the front (sub-frame alignment for mid-frame range starts),
 * capped at exactly `pcmBytes` — zero-padded if the decode runs a little
 * short, so the promised Content-Length is always honored to the byte.
 *
 * A decode that stops on a failed read (a share timing out: ffmpeg logs it and
 * exits 0) is not a short track. It starts again where it stopped, as the
 * gapless transport does, until the read recovers or the outage has lasted
 * STORAGE_OUTAGE_MS; then the body errors rather than padding silence over the
 * rest of the song. So does one that ffmpeg gave up on (a non-zero exit) well
 * before the end, and one whose read failed though the file is all there to
 * be read, once a second decoder has got no further. A clean exit well before
 * the end is the end only if the file can be read to its last byte and a
 * second decoder, started where the first stopped, finds no more audio
 * either: then the length was wrong, and the rest is silence as it always was.
 */
function pcmBodyStream(
  filePath: string,
  prelude: Uint8Array | null,
  seekSec: number,
  dropBytes: number,
  pcmBytes: number,
  sampleRate: number,
  request: Request,
): ReadableStream<Uint8Array> {
  // The request is held for as long as the stream is, not only its signal. A
  // Request that has been collected no longer passes an abort on to the signal
  // it handed out, so with the signal alone a seek that replaced this one, or
  // a skipped track, could leave the decoder running until the body itself
  // was cancelled.
  let child: PcmChild | null = null;
  let closed = false;
  // Decoder output is counted from its first frame at `seekSec`. `have` is how
  // much of it is behind us, dropped or enqueued; `base` is where the running
  // decoder's own output starts on that count, and `received` how much of it
  // has arrived.
  const total = dropBytes + pcmBytes;
  let have = 0;
  let base = 0;
  let received = 0;
  let resumeTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let looks = 0;
  const warmupBytes = Math.round(RESUME_WARMUP_SEC * sampleRate) * BYTES_PER_FRAME;

  const kill = () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
    if (child && !child.killed) killChild(child);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already errored/closed */
        }
        kill();
      };
      const fail = (err: Error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
        kill();
      };
      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
          kill();
        }
      };

      if (prelude && prelude.length) enqueue(prelude);
      if (pcmBytes <= 0) {
        close();
        return;
      }

      // Gone before it began (a seek that was replaced at once): the abort
      // has already happened and will not be heard again.
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener('abort', () => {
        closed = true;
        kill();
      }, { once: true });

      // The storage failed a read: the decoder starts again where it stopped,
      // a little later each time, until the outage has lasted too long.
      const readAgain = () => {
        if (outageGivenUp(filePath)) {
          fail(new Error(`The drive stopped answering while ${filePath} was being read.`));
          return;
        }
        attempt += 1;
        console.warn(`[newamp] seekable transcode stopped on a failed read for ${filePath}; reading again (try ${attempt})`);
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (!closed) launch();
        }, storageRetryDelay(attempt));
      };

      // `confirming`: started right after the file was read to its end, to
      // find out whether a clean early exit was the end of the track.
      const launch = (confirming = false) => {
        // Whole frames, so the new decoder starts on one, and a little before
        // the stop when it carries on from one; what it repeats is skipped below.
        const frames = Math.floor(have / BYTES_PER_FRAME) * BYTES_PER_FRAME;
        base = have > 0 ? Math.max(0, frames - warmupBytes) : frames;
        received = 0;
        const startedAt = have;
        const proc = spawnPcmDecoder(filePath, seekSec + base / BYTES_PER_FRAME / sampleRate);
        child = proc;
        let stderr = '';
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (chunk) => {
          stderr += chunk;
          if (stderr.length > 6000) stderr = stderr.slice(-6000);
        });
        const readFailure = watchReadFailureKind(proc, filePath);

        proc.stdout.on('data', (raw: Buffer) => {
          if (closed || child !== proc) return;
          const at = base + received;
          received += raw.length;
          const end = Math.min(at + raw.length, total);
          if (end > have) {
            // Only what is past `have` is new, and the front `dropBytes` of
            // the count is dropped rather than sent.
            const from = Math.max(at, have, dropBytes);
            if (end > from) enqueue(raw.subarray(from - at, end - at));
            have = end;
            storageAnswered(filePath);
          }
          // A decoder that got a second in has recovered: the next failed
          // read is a new outage.
          if (have - startedAt >= sampleRate * BYTES_PER_FRAME) {
            outageOver(filePath);
            attempt = 0;
            looks = 0;
          }
          if (have >= total) {
            close();
            return;
          }
          // Backpressure: pause the pipe when Chromium's buffer is full.
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            proc.stdout.pause();
          }
        });
        proc.on('error', (err) => {
          console.error('[newamp] seekable transcode spawn failed:', err);
          fail(err);
        });
        proc.on('close', (code) => {
          if (closed || child !== proc) return;
          // Stopped from outside (its file is being moved away): padding out
          // the rest of the track would queue the whole remainder as silence.
          if (proc.killed) {
            fail(new Error('The decoder was stopped.'));
            return;
          }
          if (code && code !== 0) {
            console.error(`[newamp] seekable transcode ffmpeg exited ${code} for ${filePath}\n${stderr}`);
          }
          // Started to look past an early stop, and found nothing there.
          const foundNoMore = confirming && have - startedAt < warmupBytes;
          const failure = readFailure();
          if (failure === 'storage') {
            readAgain();
            return;
          }
          if (failure) {
            // A read failed, for a reason that a drive which stopped delivering
            // gives and that a file with damaged data gets too. The file system
            // says which. If the file is all there to be read, one more decoder
            // is started from here in case the trouble has passed; one that gets
            // no further has met data it can't decode, and waiting mends nothing.
            void probeFileRead(filePath).then((probe) => {
              if (closed || child !== proc) return;
              if (probe === 'storage') readAgain();
              else if (probe === 'readable' && !foundNoMore && ++looks <= MAX_LOOKS_PAST_AN_EXIT) launch(true);
              else fail(new Error(`ffmpeg could not read on in ${filePath}`));
            });
            return;
          }
          let deficit = total - Math.max(have, dropBytes);
          if (deficit > END_SLACK_SEC * sampleRate * BYTES_PER_FRAME) {
            // Not the end of the track: an error lets the player load the
            // file again from where it was, where silence would play the rest
            // of the song out as if nothing had happened.
            if (code !== 0) {
              fail(new Error(`ffmpeg exited ${code ?? 'unknown'} partway through ${filePath}`));
              return;
            }
            // A clean exit, then, and one this decoder was not started to
            // confirm, or it found more audio than it was asked to repeat:
            // not every failed read is reported as one. The file system is
            // asked whether the file reads to its end, and if it does, one
            // more decoder is started from here to see what it finds.
            if (!foundNoMore) {
              void probeFileRead(filePath).then((probe) => {
                if (closed || child !== proc) return;
                if (probe === 'storage') readAgain();
                else if (probe === 'readable' && ++looks <= MAX_LOOKS_PAST_AN_EXIT) launch(true);
                else fail(new Error(`${filePath} stopped decoding before its end`));
              });
              return;
            }
          }
          // Decode ended short of the probed duration (VBR estimate drift):
          // honor the promised length with silence so Chromium never stalls on
          // a body shorter than Content-Length.
          while (deficit > 0 && !closed) {
            const chunk = Math.min(deficit, 65536);
            enqueue(Buffer.alloc(chunk));
            deficit -= chunk;
          }
          close();
        });
      };
      launch();
    },
    pull() {
      child?.stdout.resume();
    },
    cancel() {
      closed = true;
      kill();
    },
  });
}

/**
 * Seekable response for ffmpeg-mode sources WITHOUT a finalized cache entry.
 * PCM-in-WAV is constant-bitrate, so we can promise an exact total size from
 * the probed duration and satisfy any byte range by seeking ffmpeg to
 * `(byte - prelude) / byteRate` seconds. This makes the FIRST play of
 * .wma/.ape/.wv/.dsf/... tracks scrubbable — previously only the second play
 * (cached FLAC) could seek. Falls back to the legacy non-seekable pipe when
 * the source can't be probed.
 */
export async function seekableTranscodeResponse(filePath: string, request: Request): Promise<Response> {
  const info = await probePcmStreamInfo(filePath, request.signal);
  if (info === 'unavailable') return storageUnavailable();
  if (!info) return transcodeToWavResponse(filePath, request);

  const frames = Math.floor(info.durationSec * info.sampleRate);
  if (frames <= 0) return transcodeToWavResponse(filePath, request);
  const dataBytes = frames * BYTES_PER_FRAME;
  const total = WAV_PRELUDE_BYTES + dataBytes;
  const prelude = buildWavPrelude(frames, info.sampleRate);

  const baseHeaders: Record<string, string> = {
    ...AUDIO_CORS_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Type': 'audio/wav',
    'Cache-Control': 'no-store',
    'X-Newamp-Playback': 'ffmpeg-seekable-wav',
  };

  const range = parseRange(request.headers.get('Range'), total);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` },
    });
  }

  if (!range) {
    const body = pcmBodyStream(filePath, prelude, 0, 0, dataBytes, info.sampleRate, request);
    return new Response(body, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) },
    });
  }

  const { start, end } = range;
  const preludePart = start < WAV_PRELUDE_BYTES
    ? prelude.subarray(start, Math.min(end + 1, WAV_PRELUDE_BYTES))
    : null;
  const pcmFrom = Math.max(0, start - WAV_PRELUDE_BYTES);
  const pcmLen = Math.max(0, end + 1 - WAV_PRELUDE_BYTES - pcmFrom);
  const startFrame = Math.floor(pcmFrom / BYTES_PER_FRAME);
  const dropBytes = pcmFrom - startFrame * BYTES_PER_FRAME;
  const seekSec = startFrame / info.sampleRate;

  const body = pcmBodyStream(filePath, preludePart, seekSec, dropBytes, pcmLen, info.sampleRate, request);
  return new Response(body, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
  });
}
