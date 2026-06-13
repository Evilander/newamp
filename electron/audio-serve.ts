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
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

type PcmChild = ChildProcessByStdio<null, Readable, Readable>;
import { resolveFfmpegPath, transcodeToWavResponse } from './transcode.js';

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
    size = (await stat(filePath)).size;
  } catch {
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
    const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(size) },
    });
  }

  const body = Readable.toWeb(
    createReadStream(filePath, { start: range.start, end: range.end }),
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
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
  const cached = probeCache.get(cacheKey);
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
        try {
          child.kill();
        } catch {
          /* gone */
        }
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
  probeCache.set(cacheKey, info);
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
  if (seekSec > 0) args.push('-ss', seekSec.toFixed(3));
  args.push('-i', filePath, '-map', '0:a:0', '-vn');
  if (dsd) args.push('-af', 'aresample=resampler=soxr:precision=28', '-ar', '88200');
  args.push('-acodec', 'pcm_f32le', '-ac', '2', '-f', 'f32le', 'pipe:1');
  return spawn(resolveFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Body stream: optional prelude bytes, then ffmpeg PCM with `dropBytes`
 * discarded from the front (sub-frame alignment for mid-frame range starts),
 * capped at exactly `pcmBytes` — zero-padded if the decode runs short, so the
 * promised Content-Length is always honored to the byte.
 */
function pcmBodyStream(
  filePath: string,
  prelude: Uint8Array | null,
  seekSec: number,
  dropBytes: number,
  pcmBytes: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let child: PcmChild | null = null;
  let dropped = 0;
  let sent = 0;
  let closed = false;

  const kill = () => {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    }
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

      child = spawnPcmDecoder(filePath, seekSec);
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 6000) stderr = stderr.slice(-6000);
      });
      signal.addEventListener('abort', () => {
        closed = true;
        kill();
      }, { once: true });

      child.stdout.on('data', (raw: Buffer) => {
        if (closed) return;
        let buf: Buffer = raw;
        if (dropped < dropBytes) {
          const d = Math.min(dropBytes - dropped, buf.length);
          dropped += d;
          buf = buf.subarray(d);
        }
        if (!buf.length) return;
        const remaining = pcmBytes - sent;
        if (buf.length >= remaining) {
          enqueue(buf.subarray(0, remaining));
          sent = pcmBytes;
          close();
          return;
        }
        sent += buf.length;
        enqueue(buf);
        // Backpressure: pause the pipe when Chromium's buffer is full.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          child?.stdout.pause();
        }
      });
      child.stdout.on('close', () => {
        if (closed) return;
        // Decode ended short of the probed duration (VBR estimate drift):
        // honor the promised length with silence so Chromium never stalls on
        // a body shorter than Content-Length.
        let deficit = pcmBytes - sent;
        while (deficit > 0 && !closed) {
          const chunk = Math.min(deficit, 65536);
          enqueue(Buffer.alloc(chunk));
          deficit -= chunk;
        }
        close();
      });
      child.on('error', (err) => {
        console.error('[newamp] seekable transcode spawn failed:', err);
        if (!closed) {
          closed = true;
          try {
            controller.error(err);
          } catch {
            /* already closed */
          }
        }
      });
      child.on('close', (code) => {
        if (code && code !== 0 && sent < pcmBytes && !closed) {
          console.error(`[newamp] seekable transcode ffmpeg exited ${code} for ${filePath}\n${stderr}`);
        }
      });
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
    const body = pcmBodyStream(filePath, prelude, 0, 0, dataBytes, request.signal);
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

  const body = pcmBodyStream(filePath, preludePart, seekSec, dropBytes, pcmLen, request.signal);
  return new Response(body, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
  });
}
