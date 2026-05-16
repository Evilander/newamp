import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Track } from '../shared/types.js';

export interface CueSheetEntry {
  cuePath: string;
  filePath: string;
  album: string;
  albumArtist: string;
  title: string;
  artist: string;
  trackNo: number | null;
  start: number;
  end: number | null;
  year: number | null;
  genre: string | null;
}

interface MutableCueEntry extends Omit<CueSheetEntry, 'end'> {
  end?: number | null;
}

export function parseCueSheet(content: string, cuePath: string): CueSheetEntry[] {
  const resolvedCuePath = resolve(cuePath);
  const baseDir = dirname(resolvedCuePath);
  let album = basename(resolvedCuePath).replace(/\.cue$/i, '');
  let albumArtist = 'Unknown Artist';
  let year: number | null = null;
  let genre: string | null = null;
  let currentFile = '';
  let currentTrack: MutableCueEntry | null = null;
  const entries: MutableCueEntry[] = [];

  const finishTrack = () => {
    if (!currentTrack || !currentTrack.filePath || !Number.isFinite(currentTrack.start)) return;
    entries.push({
      ...currentTrack,
      title: cleanText(currentTrack.title) || `Track ${currentTrack.trackNo ?? entries.length + 1}`,
      artist: cleanText(currentTrack.artist) || albumArtist,
      album: cleanText(currentTrack.album) || album,
      albumArtist: cleanText(currentTrack.albumArtist) || albumArtist,
      genre: currentTrack.genre ?? genre,
      year: currentTrack.year ?? year,
      start: Math.max(0, currentTrack.start),
      end: null,
    });
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const rem = line.match(/^REM\s+([A-Z0-9_]+)\s+(.+)$/i);
    if (rem) {
      const key = rem[1]!.toUpperCase();
      const value = unquote(rem[2]!);
      if (key === 'DATE' || key === 'YEAR') year = parseYear(value);
      if (key === 'GENRE') genre = cleanText(value) || null;
      continue;
    }

    const file = line.match(/^FILE\s+(.+?)(?:\s+\S+)?$/i);
    if (file) {
      currentFile = resolve(baseDir, unquote(file[1]!));
      continue;
    }

    const track = line.match(/^TRACK\s+(\d+)\s+AUDIO\b/i);
    if (track) {
      finishTrack();
      currentTrack = {
        cuePath: resolvedCuePath,
        filePath: currentFile,
        album,
        albumArtist,
        title: '',
        artist: albumArtist,
        trackNo: Number.parseInt(track[1]!, 10),
        start: Number.NaN,
        year,
        genre,
      };
      continue;
    }

    const title = line.match(/^TITLE\s+(.+)$/i);
    if (title) {
      const value = unquote(title[1]!);
      if (currentTrack) currentTrack.title = value;
      else album = cleanText(value) || album;
      continue;
    }

    const performer = line.match(/^PERFORMER\s+(.+)$/i);
    if (performer) {
      const value = unquote(performer[1]!);
      if (currentTrack) currentTrack.artist = value;
      else albumArtist = cleanText(value) || albumArtist;
      continue;
    }

    const index = line.match(/^INDEX\s+01\s+(\d+):(\d+):(\d+)$/i);
    if (index && currentTrack) {
      currentTrack.start = cueTimeToSeconds(index[1]!, index[2]!, index[3]!);
    }
  }

  finishTrack();

  const out = entries
    .filter((entry) => entry.filePath && Number.isFinite(entry.start) && existsSync(entry.filePath))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.start - b.start || (a.trackNo ?? 0) - (b.trackNo ?? 0));

  for (let i = 0; i < out.length; i += 1) {
    const current = out[i]!;
    const next = out[i + 1] ?? null;
    current.end = next && next.filePath === current.filePath && next.start > current.start ? next.start : null;
  }

  return out.map((entry) => ({ ...entry, end: entry.end ?? null }));
}

export function cueAudioPaths(entries: CueSheetEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.filePath))];
}

export function cueEntriesToTracks(entries: CueSheetEntry[], libraryTracks: Track[]): Track[] {
  const byPath = new Map(libraryTracks.map((track) => [resolve(track.path).toLowerCase(), track]));
  return entries.flatMap((entry, index) => {
    const base = byPath.get(resolve(entry.filePath).toLowerCase());
    if (!base) return [];
    const cueEnd = entry.end ?? (base.duration && base.duration > entry.start ? base.duration : null);
    const duration = cueEnd && cueEnd > entry.start ? cueEnd - entry.start : null;
    return [{
      ...base,
      id: -cueTrackId(entry, index),
      title: entry.title,
      artist: entry.artist,
      album: entry.album || base.album,
      albumArtist: entry.albumArtist || base.albumArtist,
      trackNo: entry.trackNo,
      year: entry.year ?? base.year,
      genre: entry.genre ?? base.genre,
      duration,
      cuePath: entry.cuePath,
      cueStart: entry.start,
      cueEnd,
      playCount: 0,
      lastPlayed: null,
      skipCount: 0,
      lastSkipped: null,
    }];
  });
}

function cueTrackId(entry: CueSheetEntry, index: number): number {
  const digest = createHash('sha1')
    .update(`${entry.cuePath}\0${entry.filePath}\0${entry.trackNo ?? index}\0${entry.start}`)
    .digest();
  return Math.max(1, digest.readUInt32BE(0) & 0x7fffffff);
}

function cueTimeToSeconds(minutes: string, seconds: string, frames: string): number {
  return Number.parseInt(minutes, 10) * 60 +
    Number.parseInt(seconds, 10) +
    Number.parseInt(frames, 10) / 75;
}

function parseYear(value: string): number | null {
  const match = value.match(/\b(19|20)\d{2}\b/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^"([\s\S]*)"$/);
  return quoted ? quoted[1]! : trimmed.split(/\s+(?:BINARY|MOTOROLA|AIFF|WAVE|MP3)$/i)[0]!.trim();
}

function cleanText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
