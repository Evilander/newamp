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
import { open, stat, type FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { isStorageError, retryStorageErrors, storageRetryDelay, STORAGE_OUTAGE_MS, watchReadFailures } from './read-failure.js';

type PcmChild = ChildProcessByStdio<null, Readable, Readable>;
import { resamplerFilter, resamplerKindNow } from './resampler.js';
import { resolveFfmpegPath, transcodeToWavResponse, watchFfmpegInput } from './transcode.js';
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
      let outageSince: number | null = null;
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
          controller.enqueue(chunk.subarray(0, bytesRead));
          return;
        } catch (err) {
          if (closed) {
            await dropHandle();
            return;
          }
          outageSince ??= performance.now();
          if (!isStorageError(err) || performance.now() - outageSince >= STORAGE_OUTAGE_MS) {
            closed = true;
            await dropHandle();
            controller.error(err);
            return;
          }
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
 * Serve a file on disk with real byte-range semantics (200/206/416).
 * Used for native-format tracks AND finalized cached FLACs — the two cases
 * that previously trusted net.fetch(file://) and got non-seekable 200s.
 */
export async function fileRangeResponse(
  filePath: string,
  request: Request,
  headerOverrides: Record<string, string> = {},
): Promise<Response> {
  let size: number;
  try {
    // A share that times out on the stat is waited on like one that times out
    // on a read: a 404 here would make Chromium give the track up.
    size = (await retryStorageErrors(() => stat(filePath))).size;
  } catch (err) {
    if (isStorageError(err)) return new Response('Storage unavailable', { status: 503, headers: { 'Retry-After': '5' } });
    return new Response('Not found', { status: 404 });
  }

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

function isDsdPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === '.dsf' || ext === '.dff';
}

/**
 * Duration + sample rate via `ffmpeg -i` stderr (ffmpeg-static ships no
 * ffprobe). Returns null when the source is unreadable — callers fall back to
 * the legacy non-seekable pipe so playback never gates on the probe.
 */
export async function probePcmStreamInfo(filePath: string): Promise<PcmStreamInfo | null> {
  let cacheKey = filePath;
  try {
    const st = await stat(filePath);
    cacheKey = `${filePath}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
  const cached = probeCacheGet(cacheKey);
  if (cached) return cached;

  const stderr = await new Promise<string | null>((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(resolveFfmpegPath(), ['-hide_banner', '-i', filePath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killChild(child);
        done(null);
      }, 15_000);
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
  args.push('-i', filePath, '-map', '0:a:0', '-vn');
  if (dsd) args.push('-af', resamplerFilter(resamplerKindNow(resolveFfmpegPath())), '-ar', '88200');
  args.push('-acodec', 'pcm_f32le', '-ac', '2', '-f', 'f32le', 'pipe:1');
  const child = spawn(resolveFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // Held open under backpressure for as long as the track plays, so a move to
  // the Recycle Bin has to be able to stop it.
  watchFfmpegInput(child, filePath);
  return child;
}

/**
 * Body stream: optional prelude bytes, then ffmpeg PCM with `dropBytes`
 * discarded from the front (sub-frame alignment for mid-frame range starts),
 * capped at exactly `pcmBytes` — zero-padded if the decode runs short, so the
 * promised Content-Length is always honored to the byte.
 *
 * A decode that stops on a failed read (a share timing out: ffmpeg logs it and
 * exits 0) is not a short track. It starts again where it stopped, as the
 * gapless transport does, until the read recovers or the outage has lasted
 * STORAGE_OUTAGE_MS; then the body errors rather than padding silence over the
 * rest of the song.
 */
function pcmBodyStream(
  filePath: string,
  prelude: Uint8Array | null,
  seekSec: number,
  dropBytes: number,
  pcmBytes: number,
  sampleRate: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
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
  let outageSince: number | null = null;
  let attempt = 0;

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

      signal.addEventListener('abort', () => {
        closed = true;
        kill();
      }, { once: true });

      const launch = () => {
        // Whole frames, so the new decoder starts on one; the few bytes of a
        // split frame it repeats are skipped below.
        base = Math.floor(have / BYTES_PER_FRAME) * BYTES_PER_FRAME;
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
        const readFailed = watchReadFailures(proc, filePath);

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
          }
          // A decoder that got a second in has recovered: the next failed
          // read is a new outage.
          if (have - startedAt >= sampleRate * BYTES_PER_FRAME) {
            outageSince = null;
            attempt = 0;
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
          if (readFailed()) {
            outageSince ??= performance.now();
            if (performance.now() - outageSince < STORAGE_OUTAGE_MS) {
              attempt += 1;
              console.warn(`[newamp] seekable transcode stopped on a failed read for ${filePath}; reading again (try ${attempt})`);
              resumeTimer = setTimeout(() => {
                resumeTimer = null;
                if (!closed) launch();
              }, storageRetryDelay(attempt));
              return;
            }
            fail(new Error(`The drive stopped answering while ${filePath} was being read.`));
            return;
          }
          // Decode ended short of the probed duration (VBR estimate drift):
          // honor the promised length with silence so Chromium never stalls on
          // a body shorter than Content-Length.
          let deficit = total - Math.max(have, dropBytes);
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
  const info = await probePcmStreamInfo(filePath);
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
    const body = pcmBodyStream(filePath, prelude, 0, 0, dataBytes, info.sampleRate, request.signal);
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

  const body = pcmBodyStream(filePath, preludePart, seekSec, dropBytes, pcmLen, info.sampleRate, request.signal);
  return new Response(body, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
  });
}
