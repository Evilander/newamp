// Which codec an MP4-family file (.m4a, .m4b, .mp4) carries in its first
// sound track, read from the sample description (stsd) inside moov.
//
// The extension says nothing: Apple Lossless, AAC, FLAC and Opus all ship as
// .m4a, and Chromium's demuxer plays only some of them. An ALAC file handed
// to the <audio> element fails with DEMUXER_ERROR_NO_SUPPORTED_STREAMS, while
// ffmpeg decodes it fine, so the protocol handler asks here before choosing
// a path (electron/transcode.ts resolvePlaybackMode). The gapless trim
// (electron/gapless-trim.ts) walks the same boxes and shares the reader.
//
// Only the top-level box headers and moov itself are read, wherever moov
// sits (the start with faststart, the end for most encoders). A file that
// can't be read that far answers null, and callers keep the extension's
// verdict.

import { open, stat, type FileHandle } from 'node:fs/promises';

export interface Mp4Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

export const MP4_EXTS = new Set(['.m4a', '.m4b', '.mp4']);
// moov is small (sample tables for hours of AAC stay in the low megabytes);
// anything bigger than this is not a file worth reading.
export const MAX_MOOV_BYTES = 32 * 1024 * 1024;
// Sample-entry fourccs Chromium's MP4 demuxer decodes: AAC (and MP3 in an
// mp4a entry), FLAC and Opus. Apple Lossless ('alac'), AC-3, DTS and PCM
// entries are not among them.
const CHROMIUM_MP4_AUDIO = new Set(['mp4a', 'fLaC', 'Opus']);
const CACHE_CAP = 512;

// Verdicts by path, size and mtime, most recently used last.
const cache = new Map<string, string | null>();

/**
 * The first sound track's sample-entry fourcc ('mp4a', 'alac', 'fLaC',
 * 'Opus', 'ac-3', ...), or null when the file has none that can be read.
 */
export async function mp4SoundCodec(path: string): Promise<string | null> {
  let key: string;
  try {
    const info = await stat(path);
    key = `${path}:${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let codec: string | null = null;
  try {
    const moov = await readMoov(path);
    codec = moov ? soundSampleEntry(moov) : null;
  } catch {
    codec = null;
  }
  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
  cache.set(key, codec);
  return codec;
}

export function chromiumPlaysMp4Audio(codec: string): boolean {
  return CHROMIUM_MP4_AUDIO.has(codec);
}

/** The sample-entry fourcc of the first sound track in a moov box body. */
export function soundSampleEntry(moov: Buffer): string | null {
  const trak = soundTrak(moov);
  const stsd = trak ? boxPath(moov, trak, 'mdia', 'minf', 'stbl', 'stsd') : null;
  return stsd ? sampleEntryType(moov, stsd) : null;
}

/** The first trak whose handler is 'soun'; a video track ahead of it is skipped. */
export function soundTrak(moov: Buffer): Mp4Box | null {
  return boxChildren(moov, 0, moov.length)
    .filter((b) => b.type === 'trak')
    .find((t) => {
      const hdlr = boxPath(moov, t, 'mdia', 'hdlr');
      return hdlr != null && moov.toString('latin1', hdlr.body + 8, hdlr.body + 12) === 'soun';
    }) ?? null;
}

/** The fourcc of the first entry in a sample description box. */
export function sampleEntryType(buf: Buffer, stsd: Mp4Box): string | null {
  // stsd is a full box: version and flags, then the entry count.
  if (stsd.body + 8 > stsd.end || !buf.readUInt32BE(stsd.body + 4)) return null;
  return boxChildren(buf, stsd.body + 8, stsd.end)[0]?.type ?? null;
}

/** The body of the top-level moov box, or null when there is none to read. */
export async function readMoov(path: string): Promise<Buffer | null> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    let offset = 0;
    const header = Buffer.alloc(16);
    while (offset + 8 <= size) {
      await read(file, header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (boxSize === 1) {
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < headerSize) return null;
      if (type === 'moov') {
        if (boxSize > MAX_MOOV_BYTES) return null;
        const moov = Buffer.alloc(boxSize - headerSize);
        await read(file, moov, 0, moov.length, offset + headerSize);
        return moov;
      }
      offset += boxSize;
    }
    return null;
  } finally {
    await file.close();
  }
}

async function read(file: FileHandle, buffer: Buffer, at: number, length: number, position: number): Promise<void> {
  const { bytesRead } = await file.read(buffer, at, length, position);
  if (bytesRead < Math.min(length, 8)) throw new Error('short read');
}

export function boxChildren(buf: Buffer, start: number, end: number): Mp4Box[] {
  const out: Mp4Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < body - p || p + size > end) break;
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, end: p + size, body });
    p += size;
  }
  return out;
}

export function boxChild(buf: Buffer, parent: Mp4Box | { body: number; end: number }, type: string): Mp4Box | null {
  return boxChildren(buf, parent.body, parent.end).find((b) => b.type === type) ?? null;
}

export function boxPath(buf: Buffer, parent: Mp4Box | { body: number; end: number }, ...types: string[]): Mp4Box | null {
  let box: Mp4Box | { body: number; end: number } | null = parent;
  for (const type of types) {
    box = box ? boxChild(buf, box, type) : null;
  }
  return box as Mp4Box | null;
}
