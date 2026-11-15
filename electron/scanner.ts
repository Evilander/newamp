import { promises as fs } from 'node:fs';
import { extname, join, basename, dirname } from 'node:path';
import { parseFile, type IAudioMetadata, type IOptions } from 'music-metadata';
import { FileTokenizer } from 'strtok3';
import { LibraryStore, type IncomingTrack, type ArtBlob, type TrackFileState } from './library.js';
import { CONTAINER_AUDIO_EXTENSIONS, codecFamilyFromCodec } from '../shared/audio-quality.js';
import type { ScanProgress } from '../shared/types.js';
import type { TrackTagExtras } from '../shared/album-identity.js';
import { runTagBackfill, type TagBackfillControl } from './album-identity-backfill.js';
import { chooseFolderArt, isDiscFolderName, isFolderArtImage, type FolderImage, type FolderListing } from './folder-art.js';
import { AUDIO_EXTS, isSkippedLibraryFile, isSkippedLibraryFolder } from './library-skip.js';
import { whenPlaybackFed } from './playback-io.js';
import { isStorageError } from './read-failure.js';

// Containers whose extension can't say lossy from lossless. A row that has
// never had its codec read is read again once, even if the file is unchanged.
const CODEC_PROBE_EXTS = new Set(CONTAINER_AUDIO_EXTENSIONS.map((ext) => `.${ext}`));

const METADATA_OPTIONS: IOptions = { duration: true, skipCovers: false, skipPostHeaders: true };
const CODEC_PROBE_OPTIONS: IOptions = { ...METADATA_OPTIONS, skipCovers: true };
// The backfill only wants tags: no cover, no duration scan.
const TAGS_ONLY_OPTIONS: IOptions = { duration: false, skipCovers: true, skipPostHeaders: true };
// How long after launch the tag backfill may start on its own, if no scan has
// run and started it first.
const BACKFILL_IDLE_DELAY_MS = 20_000;
const DISCOVERY_CONCURRENCY = 4;
const DISCOVERY_PROGRESS_INTERVAL = 200;
const METADATA_BATCH_SIZE = 128;
const METADATA_CONCURRENCY = 8;
// Files of one folder stat'ed at once. A folder can hold hundreds, and every
// stat in flight holds one of the few threads the file system calls share with
// the audio the player is reading.
const STAT_CONCURRENCY = 8;
// Folder art images kept in memory at once. Tracks are read folder by folder,
// so an image is only wanted while its folder's tracks are.
const FOLDER_ART_CACHE_SIZE = 16;

patchTokenizerNegativeIgnore();

export interface ScannerStartOptions {
  force?: boolean;
}

function isAudioPath(p: string): boolean {
  return AUDIO_EXTS.has(extname(p).toLowerCase());
}

interface DiscoveredFile {
  full: string;
  size: number;
  mtime: number;
  dev: number;
}

// A root that is not there was deleted when the folder holding it still
// answers; when that does not either (a share that is down, a mapped drive
// that is disconnected) the scan could not look, which is not the same thing.
async function rootUnreachable(root: string): Promise<boolean> {
  const parent = dirname(root);
  if (parent === root) return true;
  try {
    await fs.stat(parent);
    return false;
  } catch {
    return true;
  }
}

// What a walk learned about its root besides the files: whether the root was
// there at all, whether it held anything (a share that is not mounted leaves
// an empty folder behind), and which folders under it could not be listed. A
// scan only treats "not found" as meaningful where it actually looked.
interface WalkReport {
  reachable: boolean;
  empty: boolean;
  unreadable: string[];
}

async function* walk(root: string, report: WalkReport = { reachable: false, empty: false, unreadable: [] }): AsyncGenerator<DiscoveredFile> {
  try {
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      report.reachable = true;
      if (isAudioPath(root)) yield { full: root, size: stat.size, mtime: stat.mtimeMs, dev: Number(stat.dev) };
      return;
    }
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }
  report.reachable = true;

  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    // The walk's reads come second to a stream that is short of audio.
    await whenPlaybackFed();
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      report.unreadable.push(dir);
      continue; // skip permission denied / unreadable
    }
    if (dir === root && !entries.length) report.empty = true;
    const files: string[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (isSkippedLibraryFolder(e.name, basename(dir))) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (isSkippedLibraryFile(e.name) || !isAudioPath(e.name)) continue;
        files.push(full);
      }
    }
    // A folder's files are stat'ed together rather than one after another: on
    // a network share each stat is a round trip.
    let statFailed = false;
    const stats = await pMap(files, STAT_CONCURRENCY, (full) =>
      fs.stat(full).catch((err: unknown) => {
        // A timed-out stat says nothing about the file. Its folder is reported
        // as unreadable so a file missing from this walk isn't taken as gone.
        if (isStorageError(err)) statFailed = true;
        return null;
      }),
    );
    if (statFailed) report.unreadable.push(dir);
    for (let i = 0; i < files.length; i += 1) {
      const stat = stats[i];
      if (stat) yield { full: files[i], size: stat.size, mtime: stat.mtimeMs, dev: Number(stat.dev) };
    }
  }
}

// What a scan has listed so far, by folder: the tracks of one folder, and the
// discs of a set that share the folder above them, each list it once.
type FolderListings = Map<string, Promise<FolderListing | null>>;

async function listFolder(dir: string): Promise<FolderListing | null> {
  await whenPlaybackFed();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const subdirs: string[] = [];
  const candidates: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      // The folders the walk doesn't enter, and a NAS's index folders
      // (@eaDir), don't make a folder of tracks into something else.
      if (!isSkippedLibraryFolder(e.name, basename(dir))) subdirs.push(e.name);
    } else if (isFolderArtImage(e.name)) {
      candidates.push(e.name);
    }
  }
  const stats = await pMap(candidates, STAT_CONCURRENCY, (name) => fs.stat(join(dir, name)).catch(() => null));
  const images: FolderImage[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const stat = stats[i];
    // An empty file is no cover, and chosen anyway it would be read to nothing
    // on every scan.
    if (stat?.isFile() && stat.size > 0) images.push({ name: candidates[i]!, size: stat.size });
  }
  return { images, subdirs };
}

function pickFolderArtFile(dir: string, listings: FolderListings = new Map()): Promise<string | null> {
  const listing = (path: string): Promise<FolderListing | null> => {
    let cached = listings.get(path);
    if (!cached) {
      cached = listFolder(path);
      listings.set(path, cached);
    }
    return cached;
  };
  return (async () => {
    const own = await listing(dir);
    if (!own) return null;
    const parentDir = dirname(dir);
    const parent = isDiscFolderName(basename(dir)) && parentDir !== dir ? await listing(parentDir) : null;
    const chosen = chooseFolderArt(own, parent);
    if (!chosen) return null;
    return join(chosen.from === 'own' ? dir : parentDir, chosen.image.name);
  })();
}

function mimeFromExt(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function readMeta(
  full: string,
  size: number,
  mtime: number,
  dev: number | null,
  folderArtForFile: (filePath: string) => Promise<ArtBlob | null> = (filePath) => readFolderArtFile(dirname(filePath)),
  codecOnly = false,
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
  let codec = '';
  let codecLossless: boolean | null = null;
  let bitsPerSample: number | null = null;
  let fileRatingScore: number | null = null;
  let filePlayCount: number | null = null;
  let ids: EmbeddedIds = EMPTY_IDS;
  let tags: TrackTagExtras | undefined;
  let art: ArtBlob | null = null;
  let parseFailed = false;

  try {
    const meta = await parseMetadata(full, codecOnly);
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
    // The parser was told not to read a raw AAC stream through (parseMetadata),
    // so its bitrate is that of the first frame, not the average. Neither it nor
    // a length worked out from it is kept: a VBR file would get a confident
    // wrong number.
    if (duration === null && extname(full).toLowerCase() === '.aac') bitrate = null;
    sampleRate = meta.format.sampleRate ?? null;
    // A BPM tag of 0 is "not set". Stored as a tempo it matched every "slow" filter.
    bpm = Number.isFinite(c.bpm) && Number(c.bpm) > 0 ? Number(c.bpm) : null;
    key = c.key ?? null;
    replayGainTrackDb = finiteDb(c.replaygain_track_gain?.dB);
    replayGainAlbumDb = finiteDb(c.replaygain_album_gain?.dB);
    codec = meta.format.codec ?? '';
    const codecFamily = codecFamilyFromCodec(meta.format.codec, meta.format.lossless);
    codecLossless = codecFamily ? codecFamily === 'lossless' : null;
    bitsPerSample = positiveInt(meta.format.bitsPerSample);
    fileRatingScore = embeddedRatingScore(meta);
    filePlayCount = embeddedPlayCount(meta);
    ids = embeddedIds(c);
    tags = tagExtras(c);
    if (c.picture && c.picture.length) {
      const pic = c.picture[0];
      if (pic.data && pic.data.length) {
        art = { mime: pic.format || 'image/jpeg', data: Buffer.from(pic.data) };
      }
    }
  } catch (err) {
    // The storage failing for a moment is not the file failing to parse; the
    // scan leaves that file for next time (see isTransientReadError).
    if (isTransientReadError(err)) throw err;
    // Metadata parsing failed. A new file still gets a row from the filename;
    // a known one keeps what it has (LibraryStore.upsertTracks).
    parseFailed = true;
  }

  // A codec-only read brings no art at all, so the row keeps the art it has.
  if (!art && !codecOnly) {
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
    dev,
    parseFailed,
    // '' says the file was read and named no codec, which is what keeps a
    // container that never parses from being read again on every scan.
    codec: parseFailed ? '' : codec,
    codecLossless,
    bitsPerSample,
    fileRatingScore,
    filePlayCount,
    ...ids,
    // Absent when the file would not parse, so a row keeps the tags it has.
    tags,
  };
}

// Reads one file's tags the way a scan would, outside the scan queue (which
// a long library scan can hold for minutes). Null when the file isn't there,
// or isn't one a scan would read: a CUE sheet can name any file, and the
// library serves what it holds to the player.
// With `rethrowStorageErrors` a read that failed for a reason other than the
// file (a share that timed out, a permission not granted yet, no descriptors
// left) is thrown instead, so the caller can tell it from a file that won't
// parse. A file that is simply gone still comes back null.
export async function readTrackFile(
  path: string,
  options: { rethrowStorageErrors?: boolean } = {},
): Promise<IncomingTrack | null> {
  if (!isAudioPath(path) || isSkippedLibraryFile(basename(path))) return null;
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return null;
    return await readMeta(path, stat.size, stat.mtimeMs, Number(stat.dev));
  } catch (err) {
    if (options.rethrowStorageErrors && isTransientReadError(err) && (err as { code?: unknown }).code !== 'ENOENT') throw err;
    return null;
  }
}

// Only the tags the album grouping needs, for the backfill that gives rows
// scanned before those tags were stored their values. Null when the file will
// not parse. A read that failed for a reason other than the file (the storage
// timing out, a permission not granted yet) is thrown instead: the file may
// parse fine next time, and the caller must not take it for one that never will.
export async function readTagExtras(path: string): Promise<TrackTagExtras | null> {
  try {
    const meta = await parseFile(path, TAGS_ONLY_OPTIONS);
    return tagExtras(meta.common);
  } catch (err) {
    if (isTransientReadError(err) && (err as { code?: unknown }).code !== 'ENOENT') throw err;
    return null;
  }
}

async function readFolderArtFile(dir: string): Promise<ArtBlob | null> {
  const folderArt = await pickFolderArtFile(dir);
  if (!folderArt) return null;
  return readArtBlob(folderArt);
}

async function readArtBlob(path: string): Promise<ArtBlob | null> {
  try {
    const data = await fs.readFile(path);
    if (!data.length) return null;
    return { mime: mimeFromExt(path), data };
  } catch {
    return null;
  }
}

async function parseMetadata(full: string, codecOnly: boolean): Promise<IAudioMetadata> {
  const options = codecOnly ? CODEC_PROBE_OPTIONS : METADATA_OPTIONS;
  // A raw AAC stream has no header that says how long it is, so asking for a
  // duration reads every frame of the file, which on a network share is
  // thousands of small reads per track. Its length is left unset.
  return parseFile(full, extname(full).toLowerCase() === '.aac' ? { ...options, duration: false } : options);
}

function fallbackTrack(full: string, size: number, mtime: number, dev: number): IncomingTrack {
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
    dev,
    parseFailed: true,
    codec: '',
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
  private backfillRun: Promise<void> | null = null;
  private backfillControl: TagBackfillControl = { cancelled: false };
  private backfillTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly library: LibraryStore,
    private readonly onProgress: (p: ScanProgress) => void,
  ) {
    // A library scanned before these tags were stored fills them in even when
    // no scan runs this session. A scan that finishes first starts it sooner.
    this.armBackfillTimer();
  }

  private armBackfillTimer(): void {
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      // A scan that is still reading starts it when it ends (runNow); two
      // sets of reads at once is what the share was already slow under.
      if (this.running) return;
      void this.startTagBackfill();
    }, BACKFILL_IDLE_DELAY_MS);
    this.backfillTimer.unref?.();
  }

  cancel(): void {
    this.cancelled = true;
    this.cancelGeneration += 1;
    this.backfillControl.cancelled = true;
    // Cancelling a scan stops the backfill with it. It picks up where it left
    // off once things have been quiet for a while; without this the rows it had
    // not reached would wait for the next scan to end.
    this.armBackfillTimer();
  }

  // Reads the tags the album grouping needs for every row scanned before they
  // were stored, a few files at a time and only while playback is fed. Resumes
  // where it stopped after a restart; a no-op once every row has been read.
  startTagBackfill(): Promise<void> {
    if (this.backfillRun) return this.backfillRun;
    if (this.library.isClosed() || !this.library.tagBackfillPending()) return Promise.resolve();
    const control: TagBackfillControl = { cancelled: false };
    this.backfillControl = control;
    const run: Promise<void> = runTagBackfill(this.library, readTagExtras, control)
      .then(() => undefined)
      .catch((err) => {
        console.warn(`[newamp] tag backfill stopped: ${errorMessage(err)}`);
      })
      .finally(() => {
        if (this.backfillRun === run) this.backfillRun = null;
      });
    this.backfillRun = run;
    return run;
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
    let scanned = 0;
    let finished = false;
    // The scan groups the albums itself when it ends; its batches do not.
    this.library.holdRegroup();
    // A cancelled scan still ends: the banner and the list refresh wait for a
    // done event, and without one they sat on "Scanning" after Cancel.
    const reportCancelled = (scanned: number): void => {
      this.onProgress({ scanned, total: scanned, current: '', done: true, cancelled: true, startedAt, parsed, skipped });
    };

    try {
      const discovered: DiscoveredFile[] = [];
      // Overlapping roots (a folder and one inside it, the same folder written
      // two ways) walk the same files twice; each is read and upserted once.
      const seen = new Set<string>();
      const walkedRoots: string[] = [];
      const unreadableFolders: string[] = [];
      const unreachableRoots: string[] = [];
      await pMap(roots, DISCOVERY_CONCURRENCY, async (root) => {
        const report: WalkReport = { reachable: false, empty: false, unreadable: [] };
        for await (const f of walk(root, report)) {
          if (this.cancelled) break;
          const key = discoveredPathKey(f.full);
          if (seen.has(key)) continue;
          seen.add(key);
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
        if (!report.reachable) {
          if (await rootUnreachable(root)) unreachableRoots.push(root);
        }
        // An empty folder is what an unmounted share leaves behind, and a walk of
        // it finds nothing under any name, so it cannot say what has gone.
        else if (!report.empty) {
          walkedRoots.push(root);
          unreadableFolders.push(...report.unreadable);
        }
      });
      // A cancelled walk stopped part-way, so what it didn't find says nothing.
      if (this.cancelled) {
        reportCancelled(0);
        return;
      }
      // Everything just found is on disk, including files skipped below as
      // unchanged, so any of them marked missing are available again.
      const found = discovered.map((f) => f.full);
      this.library.markTracksPresent(found);
      // And the other way round: a file deleted while NewAmp was closed left no
      // watcher event behind. Only roots that were there and walked to the end
      // count; an unplugged drive or dropped share marks nothing.
      await this.library.markUnfoundTracksMissingAsync(walkedRoots, found, unreadableFolders);

      const total = discovered.length;
      const folderArtPathCache = new Map<string, Promise<string | null>>();
      const folderListings: FolderListings = new Map();
      const folderArtBlobCache = new Map<string, Promise<ArtBlob | null>>();
      const folderArtPathForFile = (filePath: string): Promise<string | null> => {
        const dir = dirname(filePath);
        let cached = folderArtPathCache.get(dir);
        if (!cached) {
          cached = pickFolderArtFile(dir, folderListings);
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
          // Oldest first: the tracks of a folder are read together, so an
          // older image is no longer wanted and every cover of a library held
          // until the scan ended was gigabytes.
          if (folderArtBlobCache.size > FOLDER_ART_CACHE_SIZE) {
            folderArtBlobCache.delete(folderArtBlobCache.keys().next().value!);
          }
        }
        return cached;
      };

      for (let i = 0; i < discovered.length; i += METADATA_BATCH_SIZE) {
        if (this.cancelled) {
          reportCancelled(scanned);
          return;
        }
        const slice = discovered.slice(i, i + METADATA_BATCH_SIZE);
        const existing = options.force
          ? new Map<string, TrackFileState>()
          : this.library.getTrackFileStates(slice.map((f) => f.full));
        const codecOnly = new Set<string>();
        const changed = options.force
          ? slice
          : await pMap(slice, METADATA_CONCURRENCY, async (f) => {
              const refresh = await metadataRefresh(f, existing.get(f.full), hasFolderArt);
              if (refresh === 'codec') codecOnly.add(f.full);
              return refresh ? f : null;
            }).then((rows) =>
              rows.filter((row): row is DiscoveredFile => !!row),
            );
        skipped += slice.length - changed.length;
        // Unchanged files aren't read, but their device is known now; explicit
        // cleanup needs it to tell a deleted file from an unmounted drive.
        const changedPaths = new Set(changed.map((f) => f.full));
        const devices = slice.flatMap((f) => {
          const state = existing.get(f.full);
          return state && !changedPaths.has(f.full) && state.fileDev !== f.dev ? [{ id: state.id, dev: f.dev }] : [];
        });
        this.library.setTrackDevices(devices);

        const read = await pMap(changed, METADATA_CONCURRENCY, async (f) => {
          if (this.cancelled) return null;
          // Playback that runs short of audio goes first: on a slow drive or
          // share the scan's reads are what its decoder waits behind.
          await whenPlaybackFed();
          if (this.cancelled) return null;
          try {
            return await readMeta(f.full, f.size, f.mtime, f.dev, folderArtForFile, codecOnly.has(f.full));
          } catch (err) {
            console.warn(`[newamp] metadata parse failed for ${f.full}: ${errorMessage(err)}`);
            // A share that timed out or a file that went away says nothing
            // about the file. Its guessed row would carry the file's real size
            // and date, so later scans would take it as read and keep "Unknown
            // Artist" for good; the next scan reads it instead.
            if (isTransientReadError(err)) return null;
            return fallbackTrack(f.full, f.size, f.mtime, f.dev);
          }
        });
        const incoming = read.filter((track): track is IncomingTrack => track !== null);
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

      // A cancel that came during the last batch stopped its reads short.
      if (this.cancelled) {
        reportCancelled(scanned);
        return;
      }

      // The folders this scan touched may now read differently (a compilation
      // that finished arriving, a disc folder that was added), so the albums
      // are settled before anything asks for them.
      try {
        await this.library.regroupAlbums();
      } catch (err) {
        // The albums keep the grouping their tracks were written with.
        console.warn(`[newamp] album grouping failed: ${errorMessage(err)}`);
      }
      if (unreachableRoots.length) {
        console.warn(`[newamp] scan could not reach: ${unreachableRoots.join(', ')}`);
      }
      const last: ScanProgress & { unreachable?: string[] } = { scanned: total, total, current: '', done: true, startedAt, parsed, skipped };
      if (unreachableRoots.length) last.unreachable = unreachableRoots;
      this.onProgress(last);
      finished = true;
    } catch (err) {
      // A scan that dies part-way (a full disk, a closed store) still ends for
      // the banner, which would otherwise sit on "Scanning" for good.
      console.warn(`[newamp] scan failed: ${errorMessage(err)}`);
      reportCancelled(scanned);
      throw err;
    } finally {
      this.running = false;
      this.library.releaseRegroup();
    }
    if (finished) void this.startTagBackfill();
  }
}

// Same case policy as library-watcher.ts: Windows and macOS volumes compare
// names without case, Linux ones don't.
function discoveredPathKey(path: string): string {
  const key = path.replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin' ? key.toLowerCase() : key;
}

function sameFileState(
  discovered: { full: string; size: number; mtime: number },
  existing: TrackFileState | undefined,
): boolean {
  return !!existing && existing.size === discovered.size && existing.mtime === Math.round(discovered.mtime);
}

// 'codec' is a file that has not changed and whose art is fine, only read
// before codecs were stored: its tags are read again without the cover, which
// is the heavy part of an audiobook's header.
type MetadataRefresh = 'full' | 'codec';

async function metadataRefresh(
  discovered: { full: string; size: number; mtime: number },
  existing: TrackFileState | undefined,
  hasFolderArt: (filePath: string) => Promise<boolean>,
): Promise<MetadataRefresh | null> {
  if (!existing) return 'full';
  if (!sameFileState(discovered, existing)) return 'full';
  if (existing.hasArt && !existing.artExists) return 'full';
  if (!existing.hasArt && (await hasFolderArt(discovered.full))) return 'full';
  if (existing.codec === null && CODEC_PROBE_EXTS.has(extname(discovered.full).toLowerCase())) return 'codec';
  return null;
}

// Errors that say nothing about the file's contents: from the storage, a file
// deleted after the walk listed it, a volume that went away mid-read
// (macOS answers ENXIO, "Device not configured"), or a read this process was
// refused or ran out of descriptors for. Each goes away when the share is back,
// the permission is granted or the other reads finish, and none changes the
// file's size or date, so a row built from it would never be read again.
const UNREADABLE_FOR_NOW_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENXIO', 'ENODEV', 'EMFILE', 'ENFILE', 'EINTR']);

function isTransientReadError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return isStorageError(err) || (typeof code === 'string' && UNREADABLE_FOR_NOW_CODES.has(code));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function finiteDb(value: number | undefined): number | null {
  return Number.isFinite(value) ? Number(value!.toFixed(2)) : null;
}

function positiveInt(value: number | undefined): number | null {
  return Number.isFinite(value) && value! > 0 ? Math.round(value!) : null;
}

interface EmbeddedIds {
  mbRecordingId: string | null;
  mbReleaseId: string | null;
  mbArtistId: string | null;
  isrc: string | null;
  acoustidId: string | null;
}

const EMPTY_IDS: EmbeddedIds = { mbRecordingId: null, mbReleaseId: null, mbArtistId: null, isrc: null, acoustidId: null };

function tagId(value: string | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 64) : null;
}

// Identifiers Picard and similar taggers write; the first of any that repeat.
function embeddedIds(common: IAudioMetadata['common']): EmbeddedIds {
  return {
    mbRecordingId: tagId(common.musicbrainz_recordingid),
    mbReleaseId: tagId(common.musicbrainz_albumid),
    mbArtistId: tagId(common.musicbrainz_artistid?.[0]),
    isrc: tagId(common.isrc?.[0]),
    acoustidId: tagId(common.acoustid_id),
  };
}

function cleanTag(value: string | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 256) : null;
}

// The values of a multi-valued tag, only when it holds more than one.
function tagList(values: string[] | undefined): string[] | null {
  if (!Array.isArray(values) || values.length < 2) return null;
  const list = [...new Set(values.map((v) => cleanTag(v)).filter((v): v is string => !!v))].slice(0, 12);
  return list.length > 1 ? list : null;
}

function originalYearOf(common: IAudioMetadata['common']): number | null {
  if (Number.isFinite(common.originalyear)) return positiveInt(common.originalyear);
  const fromDate = /^\d{4}/.exec(common.originaldate ?? '');
  return fromDate ? positiveInt(Number(fromDate[0])) : null;
}

// What the album grouping reads from a file beyond what a track row always
// held: the file's own ALBUMARTIST (album_artist alone can't say whether the
// file named one), the compilation flag, sort names, disc and track totals.
function tagExtras(common: IAudioMetadata['common']): TrackTagExtras {
  const subtitle = Array.isArray(common.discsubtitle) ? common.discsubtitle[0] : (common.discsubtitle as string | undefined);
  return {
    albumArtistTag: cleanTag(common.albumartist),
    compilation: common.compilation === true,
    albumArtistSort: cleanTag(common.albumartistsort),
    artistSort: cleanTag(common.artistsort),
    discTotal: positiveInt(common.disk?.of ?? undefined),
    trackTotal: positiveInt(common.track?.of ?? undefined),
    discSubtitle: cleanTag(subtitle),
    mbReleaseGroupId: tagId(common.musicbrainz_releasegroupid),
    originalYear: originalYearOf(common),
    artists: tagList(common.artists),
    genres: tagList(common.genre),
  };
}

interface NativeTag {
  id: string;
  value: unknown;
}

function nativeTags(meta: IAudioMetadata): NativeTag[] {
  return Object.values(meta.native ?? {}).flat() as NativeTag[];
}

function ratingScore(score: number): number | null {
  const rounded = Math.round(Math.min(100, score) * 10) / 10;
  // Under half a star is noise (an FMPS_RATING of 0.05, a POPM byte of 2).
  return rounded >= 10 ? rounded : null;
}

// ID3's popularimeter byte as 1-5 stars: 0 is unrated and each star owns a
// band (1-31, 32-95, 96-159, 160-223, 224-255), which is how Windows Explorer,
// Windows Media Player and MediaMonkey write their 1, 64, 128, 196 and 255.
// music-metadata's own (byte - 1) / 254 scaling lands those on the wrong stars.
function popmStars(byte: number): number {
  if (!(byte >= 1)) return 0;
  if (byte < 32) return 1;
  if (byte < 96) return 2;
  if (byte < 160) return 3;
  if (byte < 224) return 4;
  return 5;
}

// The file's own rating on NewAmp's 0-100 score. FMPS_RATING (0..1) is
// unambiguous. A bare Vorbis RATING is Winamp's 0-100 but foobar2000 writes
// 1-5, so small values are stars. POPM is read from its raw byte; iTunes' rate
// and WM/SharedUserRating reach us from music-metadata already scaled to 0..1.
function embeddedRatingScore(meta: IAudioMetadata): number | null {
  const tags = nativeTags(meta);
  for (const tag of tags) {
    if (!/(^|:)fmps_rating$/i.test(tag.id)) continue;
    const value = Number.parseFloat(String(tag.value));
    if (value > 0 && value <= 1) return ratingScore(value * 100);
  }
  const bare = tags.find((tag) => tag.id === 'RATING');
  if (bare) {
    const value = Number.parseFloat(String(bare.value));
    if (value > 0 && value <= 5) return ratingScore(value * 20);
    if (value > 5 && value <= 100) return ratingScore(value);
  }
  for (const tag of tags) {
    if (tag.id !== 'POPM') continue;
    const stars = popmStars(Number((tag.value as { rating?: unknown } | null)?.rating));
    if (stars > 0) return ratingScore(stars * 20);
  }
  for (const entry of meta.common.rating ?? []) {
    const value = entry.rating;
    if (value != null && value > 0 && value <= 1) return ratingScore(value * 100);
  }
  return null;
}

// A play count the file's tags hold: FMPS_PLAYCOUNT, then ID3's PCNT, then
// the counter inside a POPM frame.
function embeddedPlayCount(meta: IAudioMetadata): number | null {
  const tags = nativeTags(meta);
  for (const tag of tags) {
    if (!/(^|:)fmps_playcount$/i.test(tag.id)) continue;
    const count = Number.parseFloat(String(tag.value));
    if (count > 0) return Math.trunc(count);
  }
  const pcnt = meta.common.playCounter;
  if (pcnt != null && pcnt > 0) return Math.trunc(pcnt);
  for (const tag of tags) {
    if (tag.id !== 'POPM') continue;
    const counter = Number((tag.value as { counter?: unknown } | null)?.counter);
    if (counter > 0) return Math.trunc(counter);
  }
  return null;
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
