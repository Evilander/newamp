import { promises as fs } from 'node:fs';
import { extname, join, basename, dirname } from 'node:path';
import { parseFile, type IAudioMetadata, type IOptions } from 'music-metadata';
import { FileTokenizer } from 'strtok3';
import { LibraryStore, type IncomingTrack, type ArtBlob, type TrackFileState } from './library.js';
import type { ScanProgress } from '../shared/types.js';

const AUDIO_EXTS = new Set([
  '.mp3',
  '.m4a',
  '.m4b',
  '.mp4',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.dsf',
  '.ape',
  '.wv',
  '.mpc',
  '.tta',
  '.mka',
  '.ac3',
  '.dts',
]);

const METADATA_OPTIONS: IOptions = { duration: true, skipCovers: false, skipPostHeaders: true };
const DISCOVERY_CONCURRENCY = 4;
const DISCOVERY_PROGRESS_INTERVAL = 200;
const METADATA_BATCH_SIZE = 128;
const METADATA_CONCURRENCY = 8;

patchTokenizerNegativeIgnore();

export interface ScannerStartOptions {
  force?: boolean;
}

function isAudioPath(p: string): boolean {
  return AUDIO_EXTS.has(extname(p).toLowerCase());
}

async function* walk(root: string): AsyncGenerator<{ full: string; size: number; mtime: number }> {
  try {
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      if (isAudioPath(root)) yield { full: root, size: stat.size, mtime: stat.mtimeMs };
      return;
    }
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }

  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // skip permission denied / unreadable
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'System Volume Information') continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (!isAudioPath(e.name)) continue;
        try {
          const stat = await fs.stat(full);
          yield { full, size: stat.size, mtime: stat.mtimeMs };
        } catch {
          /* skip */
        }
      }
    }
  }
}

function pickFolderArtFile(dir: string): Promise<string | null> {
  const candidates = [
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
    'cover.webp',
    'folder.jpg',
    'folder.png',
    'folder.webp',
    'front.jpg',
    'front.png',
    'art.jpg',
    'album.jpg',
  ];
  return (async () => {
    const dirs = [dir];
    if (isDiscFolderName(basename(dir))) dirs.push(dirname(dir));
    const seen = new Set<string>();
    for (const searchDir of dirs) {
      const key = searchDir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      for (const name of candidates) {
        try {
          const p = join(searchDir, name);
          await fs.access(p);
          return p;
        } catch {
          /* keep looking */
        }
      }
    }
    return null;
  })();
}

function isDiscFolderName(name: string): boolean {
  return /^(cd|disc|disk|dvd|side|vol|volume)[\s._-]*[0-9a-z]+$/i.test(name.trim());
}

function mimeFromExt(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function readMeta(
  full: string,
  size: number,
  mtime: number,
  folderArtForFile: (filePath: string) => Promise<ArtBlob | null> = (filePath) => readFolderArtFile(dirname(filePath)),
): Promise<IncomingTrack> {
  let title = basename(full, extname(full));
  let artist = 'Unknown Artist';
  let album = '';
  let albumArtist = '';
  let trackNo: number | null = null;
  let discNo: number | null = null;
  let year: number | null = null;
  let genre: string | null = null;
  let duration: number | null = null;
  let bitrate: number | null = null;
  let sampleRate: number | null = null;
  let bpm: number | null = null;
  let key: string | null = null;
  let replayGainTrackDb: number | null = null;
  let replayGainAlbumDb: number | null = null;
  let art: ArtBlob | null = null;

  try {
    const meta = await parseMetadata(full);
    const c = meta.common;
    if (c.title) title = c.title;
    if (c.artist) artist = c.artist;
    if (c.album) album = c.album;
    if (c.albumartist) albumArtist = c.albumartist;
    trackNo = c.track?.no ?? null;
    discNo = c.disk?.no ?? null;
    year = c.year ?? null;
    genre = c.genre?.[0] ?? null;
    duration = meta.format.duration ?? null;
    bitrate = meta.format.bitrate ? Math.round(meta.format.bitrate) : null;
    sampleRate = meta.format.sampleRate ?? null;
    bpm = Number.isFinite(c.bpm) ? Number(c.bpm) : null;
    key = c.key ?? null;
    replayGainTrackDb = finiteDb(c.replaygain_track_gain?.dB);
    replayGainAlbumDb = finiteDb(c.replaygain_album_gain?.dB);
    if (c.picture && c.picture.length) {
      const pic = c.picture[0];
      if (pic.data && pic.data.length) {
        art = { mime: pic.format || 'image/jpeg', data: Buffer.from(pic.data) };
      }
    }
  } catch {
    // metadata parsing failed; we still keep the row using filename heuristic
  }

  if (!art) {
    art = await folderArtForFile(full);
  }

  return {
    path: full,
    title,
    artist,
    album,
    albumArtist: albumArtist || artist,
    trackNo,
    discNo,
    year,
    genre,
    duration,
    bitrate,
    sampleRate,
    bpm,
    key,
    replayGainTrackDb,
    replayGainAlbumDb,
    size,
    mtime: Math.round(mtime),
    art,
  };
}

async function readFolderArtFile(dir: string): Promise<ArtBlob | null> {
  const folderArt = await pickFolderArtFile(dir);
  if (!folderArt) return null;
  return readArtBlob(folderArt);
}

async function readArtBlob(path: string): Promise<ArtBlob | null> {
  try {
    const data = await fs.readFile(path);
    return { mime: mimeFromExt(path), data };
  } catch {
    return null;
  }
}

async function parseMetadata(full: string): Promise<IAudioMetadata> {
  return parseFile(full, METADATA_OPTIONS);
}

function fallbackTrack(full: string, size: number, mtime: number): IncomingTrack {
  const artist = 'Unknown Artist';
  return {
    path: full,
    title: basename(full, extname(full)),
    artist,
    album: '',
    albumArtist: artist,
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: null,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size,
    mtime: Math.round(mtime),
    art: null,
  };
}

async function pMap<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class Scanner {
  private cancelled = false;
  private running = false;
  private scanQueue: Promise<void> = Promise.resolve();
  private cancelGeneration = 0;

  constructor(
    private readonly library: LibraryStore,
    private readonly onProgress: (p: ScanProgress) => void,
  ) {}

  cancel(): void {
    this.cancelled = true;
    this.cancelGeneration += 1;
  }

  async start(roots: string[], options: ScannerStartOptions = {}): Promise<void> {
    const generation = this.cancelGeneration;
    const run = this.scanQueue.then(async () => {
      if (generation !== this.cancelGeneration) return;
      await this.runNow(roots, options);
    });
    this.scanQueue = run.catch(() => undefined);
    return run;
  }

  private async runNow(roots: string[], options: ScannerStartOptions): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    const startedAt = Date.now();
    let parsed = 0;
    let skipped = 0;

    try {
      const discovered: Array<{ full: string; size: number; mtime: number }> = [];
      await pMap(roots, DISCOVERY_CONCURRENCY, async (root) => {
        for await (const f of walk(root)) {
          if (this.cancelled) break;
          discovered.push(f);
          if (discovered.length % DISCOVERY_PROGRESS_INTERVAL === 0) {
            this.onProgress({
              scanned: 0,
              total: discovered.length,
              current: f.full,
              done: false,
              startedAt,
              parsed,
              skipped,
            });
          }
        }
      });
      if (this.cancelled) return;

      const total = discovered.length;
      let scanned = 0;
      const existing = options.force
        ? new Map<string, TrackFileState>()
        : this.library.getTrackFileStates(discovered.map((f) => f.full));
      const folderArtPathCache = new Map<string, Promise<string | null>>();
      const folderArtBlobCache = new Map<string, Promise<ArtBlob | null>>();
      const folderArtPathForFile = (filePath: string): Promise<string | null> => {
        const dir = dirname(filePath);
        let cached = folderArtPathCache.get(dir);
        if (!cached) {
          cached = pickFolderArtFile(dir);
          folderArtPathCache.set(dir, cached);
        }
        return cached;
      };
      const hasFolderArt = async (filePath: string): Promise<boolean> => Boolean(await folderArtPathForFile(filePath));
      const folderArtForFile = async (filePath: string): Promise<ArtBlob | null> => {
        const artPath = await folderArtPathForFile(filePath);
        if (!artPath) return null;
        let cached = folderArtBlobCache.get(artPath);
        if (!cached) {
          cached = readArtBlob(artPath);
          folderArtBlobCache.set(artPath, cached);
        }
        return cached;
      };

      for (let i = 0; i < discovered.length; i += METADATA_BATCH_SIZE) {
        if (this.cancelled) return;
        const slice = discovered.slice(i, i + METADATA_BATCH_SIZE);
        const changed = options.force
          ? slice
          : await pMap(slice, METADATA_CONCURRENCY, async (f) =>
              (await needsMetadataRefresh(f, existing.get(f.full), hasFolderArt)) ? f : null,
            ).then((rows) =>
              rows.filter((row): row is { full: string; size: number; mtime: number } => !!row),
            );
        skipped += slice.length - changed.length;

        const incoming = await pMap(changed, METADATA_CONCURRENCY, async (f) => {
          try {
            return await readMeta(f.full, f.size, f.mtime, folderArtForFile);
          } catch (err) {
            console.warn(`[newamp] metadata parse failed for ${f.full}: ${errorMessage(err)}`);
            return fallbackTrack(f.full, f.size, f.mtime);
          }
        });
        parsed += incoming.length;
        this.library.upsertTracks(incoming);
        scanned += slice.length;
        this.onProgress({
          scanned,
          total,
          current: slice[slice.length - 1]?.full ?? '',
          done: false,
          startedAt,
          parsed,
          skipped,
        });
      }

      this.onProgress({ scanned: total, total, current: '', done: true, startedAt, parsed, skipped });
    } finally {
      this.running = false;
    }
  }
}

function sameFileState(
  discovered: { full: string; size: number; mtime: number },
  existing: TrackFileState | undefined,
): boolean {
  return !!existing && existing.size === discovered.size && existing.mtime === Math.round(discovered.mtime);
}

async function needsMetadataRefresh(
  discovered: { full: string; size: number; mtime: number },
  existing: TrackFileState | undefined,
  hasFolderArt: (filePath: string) => Promise<boolean>,
): Promise<boolean> {
  if (!existing) return true;
  if (!sameFileState(discovered, existing)) return true;
  if (existing.hasArt && !existing.artExists) return true;
  if (!existing.hasArt) return hasFolderArt(discovered.full);
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function finiteDb(value: number | undefined): number | null {
  return Number.isFinite(value) ? Number(value!.toFixed(2)) : null;
}

// Malformed APE/ID3 trailers can make music-metadata ask strtok3 to rewind via
// ignore(-n), which aborts otherwise valid full-library scans.
function patchTokenizerNegativeIgnore(): void {
  type PatchedFileTokenizer = typeof FileTokenizer.prototype & {
    __newampNegativeIgnorePatch?: boolean;
  };

  const proto = FileTokenizer.prototype as PatchedFileTokenizer;
  if (proto.__newampNegativeIgnorePatch) return;

  const originalIgnore = proto.ignore;
  proto.ignore = function ignore(length: number): Promise<number> {
    if (length < 0) return Promise.resolve(0);
    return originalIgnore.call(this, length);
  };
  proto.__newampNegativeIgnorePatch = true;
}
