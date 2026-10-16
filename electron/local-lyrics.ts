import { stat, readFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { parseFile, TimestampFormat, type IAudioMetadata } from 'music-metadata';
import type { LocalLyricsResult, Track } from '../shared/types.js';

const MAX_LYRICS_BYTES = 512 * 1024;

type LyricTrack = Pick<Track, 'path' | 'artist' | 'title' | 'album'>;

// Lyrics the file itself carries (ID3 USLT/SYLT, Vorbis LYRICS, MP4 lyr, APE,
// WM/Lyrics) come after a sidecar, which is the one a listener put there on
// purpose. Reading them is a tag parse per track, so it only happens when
// lyrics are asked for and nothing next to the file answered first.
export async function findLocalLyricsForTrack(track: LyricTrack): Promise<LocalLyricsResult | null> {
  return (await findSidecarLyricsForTrack(track)) ?? findEmbeddedLyricsForTrack(track);
}

export async function findSidecarLyricsForTrack(track: LyricTrack): Promise<LocalLyricsResult | null> {
  if (!track.path) return null;
  if (!(await isReadableFile(track.path))) return null;

  for (const candidate of localLyricsCandidates(track)) {
    const result = await readLyricsCandidate(candidate);
    if (result) return result;
  }

  return null;
}

// Keyed by path, mtime and size, so a retagged file is read again. Misses are
// kept too: opening Now Playing on a file with no lyrics should not parse its
// tags every time.
const EMBEDDED_CACHE_LIMIT = 64;
const embeddedCache = new Map<string, LocalLyricsResult | null>();

export async function findEmbeddedLyricsForTrack(track: Pick<Track, 'path'>): Promise<LocalLyricsResult | null> {
  if (!track.path) return null;
  let key: string;
  try {
    const info = await stat(track.path);
    if (!info.isFile()) return null;
    key = `${track.path}|${info.mtimeMs}|${info.size}`;
  } catch {
    return null;
  }

  if (embeddedCache.has(key)) {
    const hit = embeddedCache.get(key) ?? null;
    embeddedCache.delete(key);
    embeddedCache.set(key, hit);
    return hit;
  }

  const result = await readEmbeddedLyrics(track.path);
  embeddedCache.set(key, result);
  if (embeddedCache.size > EMBEDDED_CACHE_LIMIT) {
    const oldest = embeddedCache.keys().next().value;
    if (oldest !== undefined) embeddedCache.delete(oldest);
  }
  return result;
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

interface LyricsText {
  synced: string | null;
  plain: string | null;
}

// Taggers that write Vorbis comments often use these names, which
// music-metadata leaves out of common.lyrics.
const NATIVE_LYRICS_IDS = new Set(['UNSYNCEDLYRICS', 'UNSYNCED LYRICS', 'SYNCEDLYRICS']);

async function readEmbeddedLyrics(path: string): Promise<LocalLyricsResult | null> {
  let meta: IAudioMetadata;
  try {
    meta = await parseFile(path, { duration: false, skipCovers: true });
  } catch {
    return null;
  }

  const found = pickEmbeddedLyrics(embeddedLyricsTexts(meta));
  if (!found) return null;
  // The panel labels this as local lyrics, same as a sidecar; the path is the audio file.
  return { source: 'sidecar', path, syncedLyrics: found.synced, plainLyrics: found.plain };
}

function embeddedLyricsTexts(meta: IAudioMetadata): LyricsText[] {
  const out: LyricsText[] = [];
  for (const tag of meta.common.lyrics ?? []) {
    // SYLT carries timestamps. USLT arrives as bare text with no syncText at
    // all, and some taggers put LRC lines in it, which lyricsText() spots.
    const syncText = tag.syncText ?? [];
    if (syncText.length && tag.timeStampFormat === TimestampFormat.milliseconds) {
      const lrc = syncTextToLrc(syncText);
      if (lrc) {
        out.push({ synced: lrc, plain: null });
        continue;
      }
    }
    out.push(lyricsText(tag.text));
  }
  for (const tags of Object.values(meta.native)) {
    for (const tag of tags) {
      if (NATIVE_LYRICS_IDS.has(tag.id.toUpperCase()) && typeof tag.value === 'string') out.push(lyricsText(tag.value));
    }
  }
  return out;
}

// Timed lyrics win over plain ones, and the first of each kind wins over later
// ones (a file can carry several languages).
function pickEmbeddedLyrics(texts: LyricsText[]): LyricsText | null {
  return texts.find((item) => item.synced) ?? texts.find((item) => item.plain) ?? null;
}

function lyricsText(raw: string | undefined): LyricsText {
  const text = (raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_LYRICS_BYTES) return { synced: null, plain: null };
  return hasLrcTimestamp(text) ? { synced: text, plain: null } : { synced: null, plain: text };
}

function syncTextToLrc(lines: Array<{ text: string; timestamp?: number }>): string | null {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (!text || typeof line.timestamp !== 'number' || !Number.isFinite(line.timestamp)) continue;
    const centi = Math.floor(Math.max(0, line.timestamp) / 10);
    const minutes = Math.floor(centi / 6000);
    const seconds = Math.floor((centi % 6000) / 100);
    out.push(`[${pad2(minutes)}:${pad2(seconds)}.${pad2(centi % 100)}]${text}`);
  }
  return out.length ? out.join('\n') : null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
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
