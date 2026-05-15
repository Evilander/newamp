import { stat, readFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { LocalLyricsResult, Track } from '../shared/types.js';

const MAX_LYRICS_BYTES = 512 * 1024;

type LyricTrack = Pick<Track, 'path' | 'artist' | 'title' | 'album'>;

export async function findLocalLyricsForTrack(track: LyricTrack): Promise<LocalLyricsResult | null> {
  if (!track.path) return null;
  if (!(await isReadableFile(track.path))) return null;

  for (const candidate of localLyricsCandidates(track)) {
    const result = await readLyricsCandidate(candidate);
    if (result) return result;
  }

  return null;
}

export function localLyricsCandidates(track: LyricTrack): string[] {
  const parsed = parse(track.path);
  const bases = uniqueNonEmpty([
    parsed.name,
    `${track.artist} - ${track.title}`,
    track.title,
    `${track.album} - ${track.title}`,
  ].map(safeNamePart));
  const suffixes = ['.lrc', '.lyrics.lrc', '.txt', '.lyrics.txt'];
  const out: string[] = [];

  for (const base of bases) {
    for (const suffix of suffixes) out.push(join(parsed.dir, `${base}${suffix}`));
  }

  for (const base of bases) {
    for (const suffix of suffixes) out.push(join(parsed.dir, 'lyrics', `${base}${suffix}`));
  }

  return uniquePaths(out);
}

async function readLyricsCandidate(path: string): Promise<LocalLyricsResult | null> {
  let size = 0;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_LYRICS_BYTES) return null;
    size = info.size;
  } catch {
    return null;
  }

  try {
    const raw = await readFile(path, 'utf8');
    const text = raw.replace(/^\uFEFF/, '').trim();
    if (!text || Buffer.byteLength(text, 'utf8') > Math.max(size * 2, MAX_LYRICS_BYTES)) return null;
    const synced = hasLrcTimestamp(text);
    return {
      source: 'sidecar',
      path,
      syncedLyrics: synced ? text : null,
      plainLyrics: synced ? null : text,
    };
  } catch {
    return null;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function hasLrcTimestamp(text: string): boolean {
  return /\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?\]|\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/.test(text);
}

function safeNamePart(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  return values.filter((value, index) => !!value && values.indexOf(value) === index);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}
