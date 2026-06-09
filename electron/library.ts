// Library store backed by sql.js (pure WASM SQLite) plus filesystem-backed
// album art. We chose sql.js over better-sqlite3 because it removes the
// native compilation dependency, making NewAmp easier to install on any
// Node/Electron combination.

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createWriteStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type {
  AddTracksToPlaylistInput,
  AlbumArtApplyResult,
  AlbumRating,
  AlbumSummary,
  ArtistSummary,
  CatalogSummaryQueryOptions,
  CachedGuitarTab,
  CustomLyricsInput,
  DiscoverSurface,
  DiscoverSurfaceInput,
  FolderSummary,
  GuitarTabDocument,
  HarmonicMixInput,
  LibraryHealth,
  LibraryPruneMissingResult,
  ListeningHistoryItem,
  ListeningInsights,
  WrappedStats,
  WrappedRange,
  Review,
  ReviewInput,
  ReviewTargetType,
  ListSummary,
  ListDetail,
  ListItem,
  ListInput,
  ListItemInput,
  UserProfile,
  UserProfileInput,
  SocialPrivacy,
  LocalLyricsResult,
  MetadataLookupCandidate,
  PlaylistM3uImportResult,
  SavedPlaylist,
  SavePlaylistInput,
  SaveTrackBookmarkInput,
  SimilarTrack,
  SmartPlaylistMood,
  SmartPlaylistRule,
  SmartPlaylistRuleInput,
  SmartPlaylistSuggestion,
  TagRecomputeOptions,
  TagRecomputeResult,
  TagRule,
  TagRuleInput,
  TagSummary,
  TasteMixInput,
  TrackQueryOptions,
  TrackMetadataPatchInput,
  TrackBookmark,
  Track,
  RecoveryEvent,
} from '../shared/types.js';
import { albumKey } from '../shared/album-key.js';
import { dnaCosineSimilarity, isValidTrackDna, type TrackDna } from '../shared/audio-dna.js';
import { applySeedVibeGate, createSeedVibeContext, seedVibeSimilarity } from '../shared/seed-vibe.js';
import {
  buildEvalEnvironment,
  evaluateRulesForTrack,
  parseRule,
  topologicalSort,
  type ParsedRule,
  type TrackContext,
} from '../shared/tag-dsl.js';
import {
  audioExtension,
  classifyAudioQuality,
  CONTAINER_AUDIO_EXTENSIONS,
  DSD_EXTENSIONS,
  FFMPEG_FALLBACK_EXTENSIONS,
  LOSSY_EXTENSIONS,
  PCM_LOSSLESS_EXTENSIONS,
} from '../shared/audio-quality.js';
import { buildDiscoverSurface } from '../shared/discover.js';
import { buildHarmonicMix as buildHarmonicMixSequence } from '../shared/harmonic-mix.js';
import { quarantineCorruptFile, recoveryReason } from './recovery.js';

const require = createRequire(import.meta.url);
const LEGACY_FORMATS = new Set([
  '.wma',
  '.aiff',
  '.aif',
  '.alac',
  '.dsf',
  '.dff',
  '.ape',
  '.wv',
  '.mpc',
  '.tta',
  '.mka',
  '.ac3',
  '.dts',
]);

export interface ArtBlob {
  mime: string;
  data: Buffer;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT    UNIQUE NOT NULL,
  title        TEXT    NOT NULL DEFAULT '',
  artist       TEXT    NOT NULL DEFAULT '',
  album        TEXT    NOT NULL DEFAULT '',
  album_artist TEXT    NOT NULL DEFAULT '',
  track_no     INTEGER,
  disc_no      INTEGER,
  year         INTEGER,
  genre        TEXT,
  duration     REAL,
  bitrate      INTEGER,
  sample_rate  INTEGER,
  size         INTEGER,
  mtime        INTEGER NOT NULL DEFAULT 0,
  has_art      INTEGER NOT NULL DEFAULT 0,
  loved        INTEGER NOT NULL DEFAULT 0,
  rating       INTEGER NOT NULL DEFAULT 0,
  rating_score REAL,
  avoid_auto_play INTEGER NOT NULL DEFAULT 0,
  play_count   INTEGER NOT NULL DEFAULT 0,
  last_played  INTEGER,
  skip_count   INTEGER NOT NULL DEFAULT 0,
  last_skipped INTEGER,
  bpm          REAL,
  key          TEXT,
  replaygain_track_db REAL,
  replaygain_album_db REAL,
  art_hash     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album_artist);
CREATE INDEX IF NOT EXISTS idx_tracks_loved  ON tracks(loved);
CREATE INDEX IF NOT EXISTS idx_tracks_rating ON tracks(rating DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_avoid_auto_play ON tracks(avoid_auto_play);
CREATE INDEX IF NOT EXISTS idx_tracks_play   ON tracks(play_count DESC);

CREATE TABLE IF NOT EXISTS play_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    INTEGER NOT NULL,
  played_at   INTEGER NOT NULL,
  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_history_track ON play_history(track_id);

CREATE TABLE IF NOT EXISTS skip_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    INTEGER NOT NULL,
  skipped_at  INTEGER NOT NULL,
  position    REAL    NOT NULL DEFAULT 0,
  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skip_history_skipped ON skip_history(skipped_at DESC);
CREATE INDEX IF NOT EXISTS idx_skip_history_track ON skip_history(track_id);

CREATE TABLE IF NOT EXISTS track_bookmarks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    INTEGER NOT NULL,
  position    REAL    NOT NULL,
  label       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_track_bookmarks_track ON track_bookmarks(track_id, position);

CREATE TABLE IF NOT EXISTS guitar_tab_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    INTEGER NOT NULL,
  url         TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  artist      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  document    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE,
  UNIQUE(track_id, url)
);
CREATE INDEX IF NOT EXISTS idx_guitar_tab_cache_track ON guitar_tab_cache(track_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS custom_lyrics (
  track_id      INTEGER PRIMARY KEY,
  plain_lyrics  TEXT,
  synced_lyrics TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    UNIQUE NOT NULL,
  cover_art_path TEXT,
  cover_art_updated_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL,
  track_id    INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);

CREATE TABLE IF NOT EXISTS smart_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    UNIQUE NOT NULL,
  mood           TEXT    NOT NULL,
  count          INTEGER NOT NULL,
  genre_query    TEXT,
  search_query   TEXT,
  min_year       INTEGER,
  max_year       INTEGER,
  min_bpm        REAL,
  max_bpm        REAL,
  min_rating     INTEGER,
  loved_only     INTEGER NOT NULL DEFAULT 0,
  unplayed_only  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_smart_rules_updated ON smart_rules(updated_at DESC);

CREATE TABLE IF NOT EXISTS tag_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    UNIQUE NOT NULL,
  body        TEXT    NOT NULL,
  boost       REAL    NOT NULL DEFAULT 1,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tag_rules_updated ON tag_rules(updated_at DESC);

CREATE TABLE IF NOT EXISTS track_tags (
  track_id    INTEGER NOT NULL,
  tag_name    TEXT    NOT NULL,
  PRIMARY KEY (track_id, tag_name),
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_track_tags_name ON track_tags(tag_name);
CREATE INDEX IF NOT EXISTS idx_track_tags_track ON track_tags(track_id);

-- Album-level ratings, separate from per-track ratings. Album rating no
-- longer cascades to every track; the user can rate the album AND rate
-- individual songs independently. Composite key (album_artist, album)
-- with NOCASE collation matches how tracks are grouped into albums
-- elsewhere in the codebase. Note: SQLite NOCASE is ASCII-only — for
-- non-ASCII album titles (e.g., "ÉLAN"), JS-side lookups using
-- toLowerCase() will fold characters that SQL NOCASE won't. Until the
-- ICU extension is loaded, treat (artist, album) lookups as
-- best-effort case-folded for the ASCII alphabet only.
CREATE TABLE IF NOT EXISTS album_ratings (
  album_artist  TEXT NOT NULL COLLATE NOCASE,
  album         TEXT NOT NULL COLLATE NOCASE,
  rating        INTEGER NOT NULL DEFAULT 0,
  rating_score  REAL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (album_artist, album)
);

-- One-shot migration flags. Keeps schema-migration state next to the DB
-- so it travels with the data instead of living in settings.json.
CREATE TABLE IF NOT EXISTS library_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Local-first social objects (Letterboxd-for-listening foundation). No server,
-- no upload: every row carries a privacy flag (local / friends / public) that
-- only governs what a future export/sync would include. Default is local.
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,           -- 'track' | 'album' | 'artist'
  target_key  TEXT NOT NULL,           -- track id, albumKey, or artist name
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  rating      REAL,                    -- optional 0-100 score
  privacy     TEXT NOT NULL DEFAULT 'local',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_target ON reviews(target_type, target_key);
CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT 'Untitled list',
  description TEXT NOT NULL DEFAULT '',
  ranked      INTEGER NOT NULL DEFAULT 1,
  privacy     TEXT NOT NULL DEFAULT 'local',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS list_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id   INTEGER NOT NULL,
  track_id  INTEGER,                   -- nullable: items can be free-text entries
  label     TEXT NOT NULL DEFAULT '',
  note      TEXT NOT NULL DEFAULT '',
  position  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(list_id) REFERENCES lists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position);
CREATE TABLE IF NOT EXISTS profile (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT '',
  bio          TEXT NOT NULL DEFAULT '',
  favorites    TEXT NOT NULL DEFAULT '[]', -- JSON array of "five bags" picks
  default_privacy TEXT NOT NULL DEFAULT 'local',
  updated_at   INTEGER NOT NULL DEFAULT 0
);
`;

interface RawRow {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  genre: string | null;
  duration: number | null;
  bitrate: number | null;
  sample_rate: number | null;
  size: number | null;
  mtime: number;
  has_art: number;
  loved: number;
  rating: number;
  rating_score: number | null;
  avoid_auto_play: number;
  play_count: number;
  last_played: number | null;
  skip_count: number;
  last_skipped: number | null;
  bpm: number | null;
  key: string | null;
  replaygain_track_db: number | null;
  replaygain_album_db: number | null;
  art_hash: string | null;
}

interface SmartRuleRow {
  id: number;
  name: string;
  mood: string;
  count: number;
  genre_query: string | null;
  search_query: string | null;
  min_year: number | null;
  max_year: number | null;
  min_bpm: number | null;
  max_bpm: number | null;
  min_rating: number | null;
  loved_only: number;
  unplayed_only: number;
  created_at: number;
  updated_at: number;
}

interface TagRuleRow {
  id: number;
  name: string;
  body: string;
  boost: number;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

interface TrackSearchToken {
  field: string | null;
  value: string;
}

interface ParsedTrackSearch {
  terms: string[];
  filters: TrackSearchToken[];
}

interface BookmarkRow {
  id: number;
  track_id: number;
  position: number;
  label: string;
  created_at: number;
  updated_at: number;
}

interface CachedGuitarTabRow {
  id: number;
  track_id: number;
  url: string;
  title: string;
  artist: string;
  kind: string;
  document: string;
  created_at: number;
  updated_at: number;
}

interface PruneTarget {
  kind: 'file' | 'dir';
  key: string;
}

interface FolderTrackRow {
  id: number;
  path: string;
  duration: number | null;
  has_art: number;
}

interface LibraryHealthRow {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  duration: number | null;
  bitrate: number | null;
  sample_rate: number | null;
  size: number | null;
  mtime: number;
  has_art: number;
  replaygain_track_db: number | null;
  replaygain_album_db: number | null;
}

interface FolderSummaryAccumulator {
  path: string;
  parentPath: string | null;
  childFolderKeys: Set<string>;
  trackCount: number;
  totalTrackCount: number;
  duration: number;
  artFromTrackId: number | null;
}

interface FolderTrackIdRow {
  id: number;
  path: string;
}

function rowToTrack(r: RawRow): Track {
  return {
    id: r.id,
    path: r.path,
    title: r.title,
    artist: r.artist,
    album: r.album,
    albumArtist: r.album_artist,
    trackNo: r.track_no,
    discNo: r.disc_no,
    year: r.year,
    genre: r.genre,
    duration: r.duration,
    bitrate: r.bitrate,
    sampleRate: r.sample_rate,
    size: r.size,
    mtime: r.mtime,
    hasArt: r.has_art ? 1 : 0,
    loved: r.loved ? 1 : 0,
    rating: normalizeTrackRating(r.rating),
    ratingScore: normalizeTrackRatingScore(r.rating_score),
    avoidAutoPlay: r.avoid_auto_play ? 1 : 0,
    playCount: r.play_count,
    lastPlayed: r.last_played,
    skipCount: Math.max(0, Math.trunc(Number(r.skip_count) || 0)),
    lastSkipped: r.last_skipped,
    bpm: r.bpm,
    key: r.key,
    replayGainTrackDb: r.replaygain_track_db,
    replayGainAlbumDb: r.replaygain_album_db,
  };
}

function rowToTagRule(row: TagRuleRow): TagRule {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    boost: Number(row.boost) || 1,
    enabled: row.enabled !== 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    lastError: row.last_error,
  };
}

function rowToSmartRule(row: SmartRuleRow): SmartPlaylistRule {
  return {
    id: row.id,
    name: row.name,
    mood: normalizeSmartMood(row.mood),
    count: row.count,
    genreQuery: row.genre_query,
    searchQuery: row.search_query,
    minYear: row.min_year,
    maxYear: row.max_year,
    minBpm: row.min_bpm,
    maxBpm: row.max_bpm,
    minRating: row.min_rating,
    lovedOnly: !!row.loved_only,
    unplayedOnly: !!row.unplayed_only,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBookmark(row: BookmarkRow): TrackBookmark {
  return {
    id: row.id,
    trackId: row.track_id,
    position: row.position,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCachedGuitarTab(row: CachedGuitarTabRow): CachedGuitarTab {
  return {
    id: row.id,
    trackId: row.track_id,
    url: row.url,
    title: row.title,
    artist: row.artist,
    kind: row.kind,
    document: JSON.parse(row.document) as GuitarTabDocument,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface IncomingTrack {
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  duration: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  bpm?: number | null;
  key?: string | null;
  replayGainTrackDb: number | null;
  replayGainAlbumDb: number | null;
  size: number;
  mtime: number;
  art: ArtBlob | null;
}

export interface TrackFileState {
  path: string;
  size: number | null;
  mtime: number;
  hasArt: number;
  artHash: string | null;
  artExists: boolean;
}

interface TrackFileStateRow {
  path: string;
  size: number | null;
  mtime: number;
  has_art: number;
  art_hash: string | null;
}

export class LibraryStore {
  public readonly recoveryEvents: RecoveryEvent[] = [];
  private db!: Database;
  private SQL!: SqlJsStatic;
  private artDir: string;
  private playlistArtDir: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  // Cache of the full track DNA index. Building it walks the entire DNA table
  // and JSON.parses every blob; for a 50k-track library that's a real cost on
  // every Harmonic / Taste mix call. We cache after first build and invalidate
  // on any track DNA write (setTrackDna, upsertTracks with dna_json).
  private dnaIndexCache: Map<number, TrackDna> | null = null;
  // Folder summarization iterates EVERY track row in JS to build the folder
  // tree. Without this cache, every folder click re-ran SELECT id, path,
  // duration, has_art FROM tracks on ~60k rows — single-threaded sql.js stalls
  // the main process and freezes IPC. Cache invalidates only when the columns
  // we read change: insert/update of path/duration/has_art, or delete.
  private folderTrackRowsCache: FolderTrackRow[] | null = null;

  private constructor(private readonly file: string) {
    this.artDir = join(dirname(file), 'art');
    this.playlistArtDir = join(dirname(file), 'playlist-art');
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(this.artDir, { recursive: true });
    mkdirSync(this.playlistArtDir, { recursive: true });
  }

  static async open(file: string): Promise<LibraryStore> {
    const store = new LibraryStore(file);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    // sql.js needs its WASM file. Use createRequire to robustly find sql.js's
    // package root, then resolve dist/sql-wasm.wasm relative to that — works
    // in dev (script run from repo) and in production builds.
    let wasmPath: string;
    try {
      const sqlEntry = require.resolve('sql.js');
      wasmPath = join(dirname(sqlEntry), 'sql-wasm.wasm');
      if (!existsSync(wasmPath)) {
        // sql.js entry may be at dist/sql-wasm.js OR at lib/sql.js depending on version.
        wasmPath = join(dirname(sqlEntry), '..', 'dist', 'sql-wasm.wasm');
      }
    } catch {
      // Fallback: probe a few likely locations from CWD.
      const candidates = [
        join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      ];
      wasmPath = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
    }
    this.SQL = await initSqlJs({
      locateFile: (f: string) => (f.endsWith('.wasm') ? wasmPath : f),
    });
    const hadExistingDb = existsSync(this.file);
    let recovered = false;
    if (hadExistingDb) {
      try {
        const buf = readFileSync(this.file);
        this.db = new this.SQL.Database(buf);
      } catch (err) {
        const event = quarantineCorruptFile(this.file, 'library', recoveryReason(err));
        if (event) this.recoveryEvents.push(event);
        this.db = new this.SQL.Database();
        recovered = true;
      }
    } else {
      this.db = new this.SQL.Database();
    }
    const applySchema = () => {
      this.db.exec(SCHEMA);
      this.ensureColumn('tracks', 'rating', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('tracks', 'rating_score', 'REAL');
      this.ensureColumn('tracks', 'avoid_auto_play', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('tracks', 'skip_count', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('tracks', 'last_skipped', 'INTEGER');
      this.ensureColumn('tracks', 'replaygain_track_db', 'REAL');
      this.ensureColumn('tracks', 'replaygain_album_db', 'REAL');
      this.ensureColumn('tracks', 'dna_json', 'TEXT');
      this.ensureColumn('tracks', 'dna_analyzed_at', 'INTEGER');
      this.ensureColumn('smart_rules', 'min_rating', 'INTEGER');
      this.ensureColumn('smart_rules', 'search_query', 'TEXT');
      this.ensureColumn('playlists', 'cover_art_path', 'TEXT');
      this.ensureColumn('playlists', 'cover_art_updated_at', 'INTEGER');
      this.db.exec('PRAGMA foreign_keys = ON');
      // One-shot DB migrations gated by flags in library_meta. Currently:
      // backfill album_ratings from pre-1.5.4 cascaded track rating_score.
      this.runOneShotMigrations();
    };
    try {
      applySchema();
    } catch (err) {
      if (!hadExistingDb || recovered) throw err;
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      const event = quarantineCorruptFile(this.file, 'library', recoveryReason(err));
      if (event) this.recoveryEvents.push(event);
      this.db = new this.SQL.Database();
      recovered = true;
      applySchema();
    }
    if (recovered) this.flushSync();
  }

  close(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.dirty) this.flushSync();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.flushSync();
      } catch (err) {
        console.error('library flush failed', err);
      }
    }, 800);
  }

  private flushSync(): void {
    const data = this.db.export();
    writeFileSync(this.file, Buffer.from(data));
    this.dirty = false;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.many<{ name: string }>(`PRAGMA table_info(${table})`);
    if (rows.some((row) => row.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    this.scheduleFlush();
  }

  upsertTracks(items: IncomingTrack[]): void {
    if (!items.length) return;

    this.db.run('BEGIN');
    try {
      const stmt = this.db.prepare(
        `INSERT INTO tracks
         (path, title, artist, album, album_artist, track_no, disc_no, year, genre,
          duration, bitrate, sample_rate, bpm, key, replaygain_track_db, replaygain_album_db, size, mtime, has_art, art_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET
           title=excluded.title,
           artist=excluded.artist,
           album=excluded.album,
           album_artist=excluded.album_artist,
           track_no=excluded.track_no,
           disc_no=excluded.disc_no,
           year=excluded.year,
           genre=excluded.genre,
           duration=excluded.duration,
           bitrate=excluded.bitrate,
           sample_rate=excluded.sample_rate,
           bpm=excluded.bpm,
           key=excluded.key,
           replaygain_track_db=excluded.replaygain_track_db,
           replaygain_album_db=excluded.replaygain_album_db,
           size=excluded.size,
           mtime=excluded.mtime,
           has_art=excluded.has_art,
           art_hash=excluded.art_hash`,
      );
      const artHashCache = new WeakMap<Buffer, string>();
      const writtenArtHashes = new Set<string>();
      for (const r of items) {
        let artHash: string | null = null;
        if (r.art && r.art.data.length) {
          const cachedHash = artHashCache.get(r.art.data);
          artHash = cachedHash ?? createHash('sha1').update(r.art.data).digest('hex');
          if (!cachedHash) artHashCache.set(r.art.data, artHash);
          if (!writtenArtHashes.has(artHash)) {
            this.writeArtIfMissing(artHash, r.art);
            writtenArtHashes.add(artHash);
          }
        }
        stmt.run([
          r.path,
          r.title,
          r.artist,
          r.album,
          r.albumArtist,
          r.trackNo,
          r.discNo,
          r.year,
          r.genre,
          r.duration,
          r.bitrate,
          r.sampleRate,
          r.bpm ?? null,
          r.key ?? null,
          r.replayGainTrackDb,
          r.replayGainAlbumDb,
          r.size,
          r.mtime,
          artHash ? 1 : 0,
          artHash,
        ]);
      }
      stmt.free();
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    // upsertTracks writes path/duration/has_art — cached folder-row columns.
    this.invalidateFolderTrackRowsCache();
    this.scheduleFlush();
  }

  private writeArtIfMissing(hash: string, art: ArtBlob): void {
    const ext = mimeToExt(art.mime);
    const p = join(this.artDir, `${hash}${ext}`);
    if (!existsSync(p)) {
      writeFileSync(p, art.data);
    }
  }

  getStats(): { tracks: number; albums: number; artists: number; duration: number } {
    const t = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks`);
    const a = this.one<{ n: number }>(
      `SELECT COUNT(DISTINCT album || ' ' || album_artist) AS n FROM tracks WHERE album != ''`,
    );
    const r = this.one<{ n: number }>(
      `SELECT COUNT(DISTINCT artist) AS n FROM tracks WHERE artist != ''`,
    );
    const d = this.one<{ d: number }>(`SELECT COALESCE(SUM(duration), 0) AS d FROM tracks`);
    return { tracks: t?.n ?? 0, albums: a?.n ?? 0, artists: r?.n ?? 0, duration: d?.d ?? 0 };
  }

  getLibraryHealth(): LibraryHealth {
    const rows = this.many<LibraryHealthRow>(
      `SELECT id, path, title, artist, album, year, duration, bitrate, sample_rate, size, mtime, has_art, replaygain_track_db, replaygain_album_db FROM tracks`,
    );
    const totals = this.getStats();
    const missing = {
      artist: 0,
      album: 0,
      year: 0,
      art: 0,
      duration: 0,
    };
    const quality = {
      lossless: 0,
      lossy: 0,
      hiRes: 0,
      dsd: 0,
      ffmpegFallback: 0,
      lowBitrate: 0,
      replayGainReady: 0,
      replayGainMissing: 0,
      unknown: 0,
    };

    const duplicateMap = new Map<string, LibraryHealthRow[]>();
    const legacyMap = new Map<string, number>();
    for (const row of rows) {
      if (isUnknownArtistName(row.artist)) missing.artist += 1;
      if (!row.album.trim()) missing.album += 1;
      if (row.year == null) missing.year += 1;
      if (!row.has_art) missing.art += 1;
      if (row.duration == null || row.duration <= 0) missing.duration += 1;

      const signal = classifyAudioQuality({
        path: row.path,
        bitrate: row.bitrate,
        sampleRate: row.sample_rate,
        duration: row.duration,
        size: row.size,
        replayGainTrackDb: row.replaygain_track_db,
        replayGainAlbumDb: row.replaygain_album_db,
      });
      if (signal.isLossless) quality.lossless += 1;
      if (signal.family === 'lossy') quality.lossy += 1;
      if (signal.isHiRes) quality.hiRes += 1;
      if (signal.isDsd) quality.dsd += 1;
      if (signal.decodePath === 'ffmpeg-pcm-fallback') quality.ffmpegFallback += 1;
      if (signal.isLowBitrate) quality.lowBitrate += 1;
      if (signal.hasReplayGain) quality.replayGainReady += 1;
      else quality.replayGainMissing += 1;
      if (signal.family === 'unknown') quality.unknown += 1;

      const artist = normalizeDuplicateText(row.artist);
      const title = normalizeDuplicateText(row.title);
      if (artist && title && !isUnknownArtistName(artist)) {
        const key = `${artist}\u0000${title}`;
        const group = duplicateMap.get(key) ?? [];
        group.push(row);
        duplicateMap.set(key, group);
      }

      const ext = extname(row.path).toLowerCase();
      if (LEGACY_FORMATS.has(ext)) legacyMap.set(ext, (legacyMap.get(ext) ?? 0) + 1);
    }

    const duplicateGroups = [...duplicateMap.values()]
      .filter((group) => group.length > 1)
      .map((group) => {
        const first = group[0]!;
        const trackIds = [...group]
          .sort((a, b) => (a.album || '').localeCompare(b.album || '') || a.path.localeCompare(b.path))
          .slice(0, 8)
          .map((row) => row.id);
        return {
          artist: first.artist,
          title: first.title,
          count: group.length,
          exactMatchCount: duplicateExactMatchCount(group),
          trackIds,
        };
      })
      .sort(
        (a, b) =>
          b.exactMatchCount - a.exactMatchCount ||
          b.count - a.count ||
          a.artist.localeCompare(b.artist) ||
          a.title.localeCompare(b.title),
      )
      .slice(0, 12)
      .map(({ trackIds, ...group }) => ({
        ...group,
        tracks: this.getTracksByIdsInOrder(trackIds),
      }));

    const legacyFormats = [...legacyMap.entries()]
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));

    const recentlyAdded = this.many<RawRow>(
      `SELECT * FROM tracks ORDER BY mtime DESC, artist COLLATE NOCASE, title COLLATE NOCASE LIMIT 12`,
    ).map(rowToTrack);

    return {
      totals,
      missing,
      quality,
      duplicateGroups,
      legacyFormats,
      recentlyAdded,
      generatedAt: Date.now(),
    };
  }

  getTrackCount(opts: Pick<TrackQueryOptions, 'search' | 'sort'> = {}): number {
    const { whereSql, params } = this.buildTrackQuery(opts);
    const row = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks ${whereSql}`, params);
    return row?.n ?? 0;
  }

  getTracks(opts: TrackQueryOptions = {}): Track[] {
    const sortKey = trackSortOrder(opts.sort);
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 100000));
    const offset = Math.max(0, opts.offset ?? 0);
    const { whereSql, params } = this.buildTrackQuery(opts);

    return this.many(
      `SELECT * FROM tracks ${whereSql} ORDER BY ${sortKey} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map(rowToTrack);
  }

  getTrackIds(opts: TrackQueryOptions = {}): number[] {
    const sortKey = trackSortOrder(opts.sort);
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 100000));
    const offset = Math.max(0, opts.offset ?? 0);
    const { whereSql, params } = this.buildTrackQuery(opts);

    return this.many<{ id: number }>(
      `SELECT id FROM tracks ${whereSql} ORDER BY ${sortKey} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((row) => row.id);
  }

  private buildTrackQuery(opts: Pick<TrackQueryOptions, 'search' | 'sort'>): {
    whereSql: string;
    params: unknown[];
  } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.sort === 'recent') where.push('last_played IS NOT NULL');
    if (opts.sort === 'plays') where.push('play_count > 0');
    if (opts.sort === 'loved') where.push('loved = 1');

    const search = parseTrackSearchQuery(opts.search ?? '');
    const searchWhere = trackSearchWhere(search);
    where.push(...searchWhere.where);
    params.push(...searchWhere.params);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return { whereSql, params };
  }

  getTrack(id: number): Track | null {
    const row = this.one<RawRow>(`SELECT * FROM tracks WHERE id = ?`, [id]);
    return row ? rowToTrack(row) : null;
  }

  getTracksByIdsInOrder(ids: number[]): Track[] {
    const wanted = ids.filter((id) => Number.isFinite(id));
    if (!wanted.length) return [];
    const byId = new Map<number, Track>();
    const unique = [...new Set(wanted)];
    const chunkSize = 500;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.many<RawRow>(`SELECT * FROM tracks WHERE id IN (${placeholders})`, chunk);
      for (const row of rows) {
        const track = rowToTrack(row);
        byId.set(track.id, track);
      }
    }
    // Preserve input order AND duplicates (a play queue may legitimately
    // contain the same track more than once); only missing ids are dropped.
    // This matches the prior `ids.map(getTrack).filter(Boolean)` behavior.
    const out: Track[] = [];
    for (const id of wanted) {
      const track = byId.get(id);
      if (track) out.push(track);
    }
    return out;
  }

  getCustomLyrics(trackId: number): LocalLyricsResult | null {
    const id = Math.trunc(Number(trackId));
    if (!Number.isFinite(id) || id <= 0) return null;
    const row = this.one<{ plain_lyrics: string | null; synced_lyrics: string | null; updated_at: number }>(
      `SELECT plain_lyrics, synced_lyrics, updated_at FROM custom_lyrics WHERE track_id = ?`,
      [id],
    );
    if (!row || (!row.plain_lyrics && !row.synced_lyrics)) return null;
    return {
      source: 'custom',
      path: `newamp:lyrics:custom:${id}`,
      plainLyrics: row.plain_lyrics || null,
      syncedLyrics: row.synced_lyrics || null,
      updatedAt: row.updated_at,
    };
  }

  saveCustomLyrics(input: CustomLyricsInput): LocalLyricsResult | null {
    const trackId = Math.trunc(Number(input.trackId));
    if (!Number.isFinite(trackId) || trackId <= 0 || !this.getTrack(trackId)) return null;
    const plainLyrics = normalizeLyricsText(input.plainLyrics);
    const syncedLyrics = normalizeLyricsText(input.syncedLyrics);
    if (!plainLyrics && !syncedLyrics) {
      this.clearCustomLyrics(trackId);
      return null;
    }
    const now = Date.now();
    this.db.run(
      `INSERT INTO custom_lyrics (track_id, plain_lyrics, synced_lyrics, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(track_id) DO UPDATE SET
         plain_lyrics=excluded.plain_lyrics,
         synced_lyrics=excluded.synced_lyrics,
         updated_at=excluded.updated_at`,
      [trackId, plainLyrics, syncedLyrics, now, now],
    );
    this.scheduleFlush();
    return this.getCustomLyrics(trackId);
  }

  clearCustomLyrics(trackId: number): void {
    const id = Math.trunc(Number(trackId));
    if (!Number.isFinite(id) || id <= 0) return;
    this.db.run(`DELETE FROM custom_lyrics WHERE track_id = ?`, [id]);
    this.scheduleFlush();
  }

  getTracksByPaths(paths: string[]): Track[] {
    const out: Track[] = [];
    const seen = new Set<number>();
    for (const path of paths) {
      const found = this.resolveTrackByPath(path);
      if (!found || seen.has(found.id)) continue;
      const track = this.getTrack(found.id);
      if (!track) continue;
      seen.add(found.id);
      out.push(track);
    }
    return out;
  }

  getTrackFileStates(paths: string[]): Map<string, TrackFileState> {
    const out = new Map<string, TrackFileState>();
    const unique = [...new Set(paths.filter((path) => typeof path === 'string' && path.length))];
    const chunkSize = 500;

    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.many<TrackFileStateRow>(
        `SELECT path, size, mtime, has_art, art_hash FROM tracks WHERE path IN (${placeholders})`,
        chunk,
      );
      for (const row of rows) out.set(row.path, this.rowToTrackFileState(row));
    }

    if (out.size < unique.length) {
      const normalizedRows = new Map(
        this.many<TrackFileStateRow>(`SELECT path, size, mtime, has_art, art_hash FROM tracks`).map((row) => [
          normalizeFileStatePath(row.path),
          row,
        ]),
      );
      for (const path of unique) {
        if (out.has(path)) continue;
        const row = normalizedRows.get(normalizeFileStatePath(path));
        if (row) out.set(path, { ...this.rowToTrackFileState(row), path });
      }
    }

    return out;
  }

  private rowToTrackFileState(row: TrackFileStateRow): TrackFileState {
    return {
      path: row.path,
      size: row.size,
      mtime: row.mtime,
      hasArt: row.has_art ? 1 : 0,
      artHash: row.art_hash,
      artExists: row.art_hash ? this.artFileExists(row.art_hash) : false,
    };
  }

  private artFileExists(hash: string): boolean {
    return ['.jpg', '.jpeg', '.png', '.webp'].some((ext) => existsSync(join(this.artDir, `${hash}${ext}`)));
  }

  pruneMissingTracks(targets?: string[]): LibraryPruneMissingResult {
    const tracks = this.many<RawRow>(`SELECT * FROM tracks`).map(rowToTrack);
    const normalizedTargets = normalizePruneTargets(targets);
    const candidates = normalizedTargets.length
      ? tracks.filter((track) => matchesPruneTargets(track.path, normalizedTargets))
      : tracks;
    const missingIds = candidates
      .filter((track) => !existsSync(track.path))
      .map((track) => track.id);

    if (!missingIds.length) return { checked: candidates.length, removed: 0 };

    this.db.run('BEGIN');
    try {
      for (const id of missingIds) {
        this.db.run(`DELETE FROM playlist_tracks WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM play_history WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM skip_history WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM track_bookmarks WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM guitar_tab_cache WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM custom_lyrics WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM tracks WHERE id = ?`, [id]);
      }
      this.invalidateDnaIndexCache();
      this.invalidateFolderTrackRowsCache();
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    this.scheduleFlush();
    return { checked: candidates.length, removed: missingIds.length };
  }

  applyMetadataPatch(trackId: number, candidate: MetadataLookupCandidate): Track | null {
    const id = Math.trunc(trackId);
    const current = this.getTrack(id);
    if (!current) return null;

    const title = cleanMetadataText(candidate.title, current.title);
    const artist = cleanMetadataText(candidate.artist, current.artist || 'Unknown Artist');
    const album = cleanMetadataText(candidate.album, current.album);
    const albumArtist = cleanMetadataText(candidate.albumArtist, artist);
    const year = finiteYear(candidate.year) ?? current.year;
    const trackNo = finitePositiveInteger(candidate.trackNo) ?? current.trackNo;
    const discNo = finitePositiveInteger(candidate.discNo) ?? current.discNo;
    const duration = current.duration ?? finitePositiveNumber(candidate.duration);

    this.db.run(
      `UPDATE tracks
          SET title = ?, artist = ?, album = ?, album_artist = ?,
              track_no = ?, disc_no = ?, year = ?, duration = ?
        WHERE id = ?`,
      [title, artist, album, albumArtist, trackNo, discNo, year, duration, id],
    );
    // duration is one of the cached folder-row columns.
    this.invalidateFolderTrackRowsCache();
    this.scheduleFlush();
    return this.getTrack(id);
  }

  applyManualMetadataPatch(trackId: number, patch: TrackMetadataPatchInput): Track | null {
    const id = Math.trunc(trackId);
    const current = this.getTrack(id);
    if (!current) return null;

    const title = patch.title === undefined ? current.title : cleanMetadataText(patch.title, current.title);
    const artist = patch.artist === undefined
      ? current.artist
      : cleanMetadataText(patch.artist, current.artist || 'Unknown Artist');
    const album = patch.album === undefined ? current.album : cleanOptionalMetadataText(patch.album) ?? '';
    const albumArtist = patch.albumArtist === undefined
      ? current.albumArtist
      : cleanMetadataText(patch.albumArtist, artist);
    const genre = patch.genre === undefined ? current.genre : cleanOptionalMetadataText(patch.genre);
    const year = patch.year === undefined ? current.year : finiteYear(patch.year);
    const trackNo = patch.trackNo === undefined ? current.trackNo : finitePositiveInteger(patch.trackNo);
    const discNo = patch.discNo === undefined ? current.discNo : finitePositiveInteger(patch.discNo);

    this.db.run(
      `UPDATE tracks
          SET title = ?, artist = ?, album = ?, album_artist = ?,
              track_no = ?, disc_no = ?, year = ?, genre = ?
        WHERE id = ?`,
      [title, artist, album, albumArtist, trackNo, discNo, year, genre, id],
    );
    this.scheduleFlush();
    return this.getTrack(id);
  }

  getAlbums(opts: CatalogSummaryQueryOptions = {}): AlbumSummary[] {
    const search = String(opts.search ?? '').trim();
    const limit = summaryQueryLimit(opts.limit);
    const offset = summaryQueryOffset(opts.offset);
    const where = ['album != \'\''];
    const params: unknown[] = [];
    const having: string[] = [];
    const havingParams: unknown[] = [];

    // Search matches album name, album artist, year — AND song titles. A query
    // like "helter skelter" surfaces the album that contains that track even
    // though no album/artist field matches. We must NOT filter track rows in
    // WHERE for that (it would shrink the album's track_count/duration to only
    // the matching songs); instead group every track and decide album inclusion
    // in HAVING via MAX(CASE ...). matched_titles surfaces the matching songs.
    let matchSelect = '';
    const matchSelectParams: unknown[] = [];
    if (search) {
      const q = likeParam(search);
      matchSelect = `,
              MAX(CASE WHEN lower(album) LIKE ? OR lower(COALESCE(NULLIF(album_artist,''), artist)) LIKE ? OR CAST(year AS TEXT) LIKE ? THEN 1 ELSE 0 END) AS matched_meta,
              MAX(CASE WHEN lower(title) LIKE ? THEN 1 ELSE 0 END) AS matched_track,
              GROUP_CONCAT(CASE WHEN lower(title) LIKE ? THEN title ELSE NULL END, char(31)) AS matched_titles`;
      matchSelectParams.push(q, q, q, q, q);
      having.push('(matched_meta = 1 OR matched_track = 1)');
    }
    if (typeof opts.excludeAlbum === 'string' && opts.excludeAlbum.trim()) {
      const excludeAlbum = opts.excludeAlbum.trim();
      const excludeAlbumArtist = String(opts.excludeAlbumArtist ?? '').trim();
      if (excludeAlbumArtist) {
        where.push('NOT (album = ? AND COALESCE(NULLIF(album_artist,\'\'), artist) = ?)');
        params.push(excludeAlbum, excludeAlbumArtist);
      } else {
        where.push('album != ?');
        params.push(excludeAlbum);
      }
    }
    if (Number.isFinite(opts.year)) {
      const year = Math.trunc(Number(opts.year));
      const yearWindow = Math.max(0, Math.min(Math.trunc(Number(opts.yearWindow ?? 0)), 10));
      having.push('MIN(year) IS NOT NULL AND ABS(MIN(year) - ?) <= ?');
      havingParams.push(year, yearWindow);
    }
    if (opts.missingArtOnly === true) {
      having.push('MIN(CASE WHEN has_art = 1 THEN id ELSE NULL END) IS NULL');
    }
    const havingSql = having.length ? `HAVING ${having.join(' AND ')}` : '';
    // When searching, float album/artist/year matches above songs-only matches
    // within each sort group so a literal album name still leads.
    const orderSql = (search ? 'matched_meta DESC, ' : '') + albumSortOrder(opts.sort, opts.randomSeed);

    // NOTE: Don't JOIN album_ratings here. An earlier attempt at a LEFT
    // JOIN broke listAlbums entirely: the WHERE clause references
    // unqualified `album` / `album_artist` columns, which became ambiguous
    // once both `tracks` and `album_ratings` carried them — SQLite raised
    // "ambiguous column" on every call and zero rows came back. Instead,
    // run the aggregation query unchanged and merge album ratings in via
    // a single bulk lookup. Same number of round-trips, no JOIN fragility.
    const rows = this.many<{
      album: string;
      album_artist: string;
      year: number | null;
      track_count: number;
      duration: number;
      art_track: number | null;
      matched_track?: number;
      matched_titles?: string | null;
    }>(
      `SELECT album,
              COALESCE(NULLIF(album_artist,''), artist) AS album_artist,
              MIN(year) AS year,
              COUNT(*) AS track_count,
              COALESCE(SUM(duration), 0) AS duration,
              MIN(CASE WHEN has_art = 1 THEN id ELSE NULL END) AS art_track${matchSelect}
         FROM tracks
        WHERE ${where.join(' AND ')}
        GROUP BY album, COALESCE(NULLIF(album_artist,''), artist)
        ${havingSql}
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?`,
      [...matchSelectParams, ...params, ...havingParams, limit, offset],
    );

    // One extra query for the whole rating set — typically tiny (only rated
    // albums). Map-lookup on `lowercase(artist)|lowercase(album)` matches
    // the schema's NOCASE collation without an extra string compare.
    const ratingIndex = this.many<{
      album_artist: string;
      album: string;
      rating: number;
      rating_score: number | null;
    }>(
      `SELECT album_artist, album, rating, rating_score FROM album_ratings`,
      [],
    );
    const ratingMap = new Map<string, { rating: number; ratingScore: number | null }>();
    for (const row of ratingIndex) {
      const key = albumKey(row.album_artist, row.album);
      ratingMap.set(key, { rating: row.rating, ratingScore: row.rating_score });
    }

    return rows.map((r) => {
      const key = albumKey(r.album_artist || 'Unknown Artist', r.album);
      const rating = ratingMap.get(key);
      return {
        album: r.album,
        albumArtist: r.album_artist || 'Unknown Artist',
        year: r.year,
        trackCount: r.track_count,
        duration: r.duration,
        artFromTrackId: r.art_track,
        rating: rating?.rating ?? 0,
        ratingScore: rating?.ratingScore ?? null,
        matchedOnTrack: search ? Boolean(r.matched_track) : undefined,
        // Split on the U+001F unit separator (the SQL GROUP_CONCAT used char(31))
        // — chosen because it cannot occur inside a song title.
        matchedTrackTitles:
          search && r.matched_titles
            ? Array.from(new Set(r.matched_titles.split(''))).slice(0, 4).join(' · ')
            : null,
      };
    });
  }

  applyAlbumArtToAlbum(
    album: string,
    albumArtist: string,
    art: ArtBlob,
    sourceUrl: string,
    appliedAt = Date.now(),
  ): AlbumArtApplyResult | null {
    const cleanAlbum = String(album ?? '').trim();
    const cleanAlbumArtist = String(albumArtist ?? '').trim() || 'Unknown Artist';
    if (!cleanAlbum || !art.data.length) return null;

    const rows = this.many<{ id: number }>(
      `SELECT id FROM tracks
        WHERE album = ?
          AND COALESCE(NULLIF(album_artist,''), artist) = ?`,
      [cleanAlbum, cleanAlbumArtist],
    );
    if (!rows.length) return null;

    const artHash = createHash('sha1').update(art.data).digest('hex');
    this.writeArtIfMissing(artHash, art);
    const stmt = this.db.prepare(`UPDATE tracks SET has_art = 1, art_hash = ? WHERE id = ?`);
    this.db.run('BEGIN');
    try {
      for (const row of rows) stmt.run([artHash, row.id]);
      stmt.free();
      this.db.run('COMMIT');
    } catch (err) {
      stmt.free();
      this.db.run('ROLLBACK');
      throw err;
    }
    // has_art is one of the cached folder-row columns.
    this.invalidateFolderTrackRowsCache();
    this.scheduleFlush();

    return {
      album: cleanAlbum,
      albumArtist: cleanAlbumArtist,
      artFromTrackId: rows[0]?.id ?? null,
      appliedTrackCount: rows.length,
      mime: art.mime,
      bytes: art.data.byteLength,
      sourceUrl,
      appliedAt,
    };
  }

  getArtists(opts: CatalogSummaryQueryOptions = {}): ArtistSummary[] {
    const search = String(opts.search ?? '').trim();
    const limit = summaryQueryLimit(opts.limit);
    const offset = summaryQueryOffset(opts.offset);
    const where = ['artist != \'\''];
    const params: unknown[] = [];

    if (search) {
      const q = likeParam(search);
      where.push('(lower(artist) LIKE ? OR lower(album) LIKE ?)');
      params.push(q, q);
    }

    return this.many<{ artist: string; track_count: number; album_count: number }>(
      `SELECT artist, COUNT(*) AS track_count, COUNT(DISTINCT album) AS album_count
         FROM tracks WHERE ${where.join(' AND ')}
        GROUP BY artist
        ORDER BY artist COLLATE NOCASE
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((r) => ({ artist: r.artist, trackCount: r.track_count, albumCount: r.album_count }));
  }

  getFolders(parentPath?: string | null, roots: string[] = []): FolderSummary[] {
    const rows = this.getFolderTrackRows();
    const parent = normalizeFolderPath(parentPath);
    if (parent) return summarizeChildFolders(rows, parent);

    const configuredRoots = uniqueNormalizedFolders(roots)
      .map((root) => summarizeFolder(rows, root, null))
      .filter((folder) => folder.totalTrackCount > 0);

    if (configuredRoots.length) return sortFolders(configuredRoots);

    return sortFolders(
      deriveCatalogRoots(rows)
        .map((root) => summarizeFolder(rows, root, null))
        .filter((folder) => folder.totalTrackCount > 0),
    );
  }

  getFolderTracks(
    folderPath: string,
    opts: { recursive?: boolean; limit?: number; offset?: number } = {},
  ): Track[] {
    return this.queryFolderTrackRows(folderPath, opts).map(rowToTrack);
  }

  getFolderTrackIds(
    folderPath: string,
    opts: { recursive?: boolean; limit?: number; offset?: number } = {},
  ): number[] {
    return this.queryFolderRows<FolderTrackIdRow>(
      folderPath,
      opts,
      'id, path, disc_no, track_no, title',
    ).map((row) => row.id);
  }

  private queryFolderTrackRows(
    folderPath: string,
    opts: { recursive?: boolean; limit?: number; offset?: number } = {},
  ): RawRow[] {
    return this.queryFolderRows<RawRow>(folderPath, opts, '*');
  }

  private queryFolderRows<T extends { path: string }>(
    folderPath: string,
    opts: { recursive?: boolean; limit?: number; offset?: number } = {},
    selectClause: string,
  ): T[] {
    const folder = normalizeFolderPath(folderPath);
    if (!folder) return [];
    const recursive = !!opts.recursive;
    const limit = Math.max(1, Math.min(opts.limit ?? 100000, 100000));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows: T[] = [];
    let matched = 0;
    const stmt = this.db.prepare(
      `SELECT ${selectClause} FROM tracks
        WHERE lower(replace(path, '/', '\\')) LIKE ? ESCAPE '|'
        ORDER BY lower(replace(path, '/', '\\')) COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE, id`,
    );
    try {
      stmt.bind([folderTrackPathPrefixParam(folder)] as unknown as import('sql.js').BindParams);
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as T;
        if (!trackPathIsInFolder(row.path, folder, recursive)) continue;
        if (matched < offset) {
          matched += 1;
          continue;
        }
        rows.push(row);
        matched += 1;
        if (rows.length >= limit) break;
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private getFolderTrackRows(): FolderTrackRow[] {
    if (this.folderTrackRowsCache) return this.folderTrackRowsCache;
    const rows = this.many<FolderTrackRow>(`SELECT id, path, duration, has_art FROM tracks`);
    this.folderTrackRowsCache = rows;
    return rows;
  }

  private invalidateFolderTrackRowsCache(): void {
    this.folderTrackRowsCache = null;
  }

  getAlbumTracks(albumArtist: string, album: string): Track[] {
    return this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE album = ?
          AND COALESCE(NULLIF(album_artist,''), artist) = ?
        ORDER BY disc_no, track_no, title`,
      [album, albumArtist],
    ).map(rowToTrack);
  }

  getArtistTracks(artist: string): Track[] {
    return this.many<RawRow>(
      `SELECT * FROM tracks WHERE artist = ?
        ORDER BY year, album COLLATE NOCASE, disc_no, track_no, title`,
      [artist],
    ).map(rowToTrack);
  }

  getPlaylists(): SavedPlaylist[] {
    return this.many<{
      id: number;
      name: string;
      cover_art_path: string | null;
      cover_art_updated_at: number | null;
      track_count: number;
      duration: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT p.id,
              p.name,
              p.cover_art_path,
              p.cover_art_updated_at,
              COUNT(pt.track_id) AS track_count,
              COALESCE(SUM(t.duration), 0) AS duration,
              p.created_at,
              p.updated_at
         FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = pt.track_id
        GROUP BY p.id
        ORDER BY p.updated_at DESC, p.name COLLATE NOCASE`,
    ).map((row) => ({
      id: row.id,
      name: row.name,
      trackCount: row.track_count,
      duration: row.duration,
      hasCoverArt: row.cover_art_path ? 1 : 0,
      coverArtUpdatedAt: row.cover_art_path ? row.cover_art_updated_at : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  savePlaylist(input: SavePlaylistInput): SavedPlaylist {
    const name = normalizePlaylistName(input.name);
    const trackIds = input.trackIds
      .map((id) => Math.trunc(Number(id)))
      .filter((id) => Number.isFinite(id) && id > 0);
    const now = Date.now();
    let id = input.id ? Math.trunc(input.id) : 0;

    this.db.run('BEGIN');
    try {
      const existingById = id
        ? this.one<{ id: number }>(`SELECT id FROM playlists WHERE id = ?`, [id])
        : null;
      const finalName = this.uniquePlaylistName(name, existingById ? id : 0);
      if (existingById) {
        this.db.run(`UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?`, [finalName, now, id]);
      } else {
        this.db.run(
          `INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)`,
          [finalName, now, now],
        );
        id = this.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
      }

      if (input.clearCoverImage) {
        this.db.run(
          `UPDATE playlists SET cover_art_path = NULL, cover_art_updated_at = NULL, updated_at = ? WHERE id = ?`,
          [now, id],
        );
      } else if (input.coverImagePath?.trim()) {
        const coverPath = this.writePlaylistCover(id, input.coverImagePath);
        this.db.run(
          `UPDATE playlists SET cover_art_path = ?, cover_art_updated_at = ?, updated_at = ? WHERE id = ?`,
          [coverPath, now, now, id],
        );
      }

      this.db.run(`DELETE FROM playlist_tracks WHERE playlist_id = ?`, [id]);
      const stmt = this.db.prepare(
        `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`,
      );
      try {
        trackIds.forEach((trackId, position) => stmt.run([id, trackId, position]));
      } finally {
        stmt.free();
      }

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    this.scheduleFlush();
    const playlist = this.getPlaylist(id);
    if (!playlist) throw new Error('Playlist was not saved.');
    return playlist;
  }

  addTracksToPlaylist(input: AddTracksToPlaylistInput): SavedPlaylist | null {
    const playlistId = Math.trunc(Number(input.playlistId));
    if (!Number.isFinite(playlistId) || playlistId <= 0) return null;
    const playlist = this.getPlaylist(playlistId);
    if (!playlist) return null;

    const trackIds = input.trackIds
      .map((id) => Math.trunc(Number(id)))
      .filter((id) => Number.isFinite(id) && id > 0)
      .filter((id) => !!this.getTrack(id));
    if (!trackIds.length) return playlist;

    const startPosition =
      (this.one<{ position: number }>(
        `SELECT COALESCE(MAX(position), -1) AS position FROM playlist_tracks WHERE playlist_id = ?`,
        [playlistId],
      )?.position ?? -1) + 1;
    const now = Date.now();

    this.db.run('BEGIN');
    try {
      const stmt = this.db.prepare(
        `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`,
      );
      try {
        trackIds.forEach((trackId, offset) => stmt.run([playlistId, trackId, startPosition + offset]));
      } finally {
        stmt.free();
      }
      this.db.run(`UPDATE playlists SET updated_at = ? WHERE id = ?`, [now, playlistId]);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    this.scheduleFlush();
    return this.getPlaylist(playlistId);
  }

  deletePlaylist(id: number): void {
    const playlistId = Math.trunc(id);
    this.db.run('BEGIN');
    try {
      this.db.run(`DELETE FROM playlist_tracks WHERE playlist_id = ?`, [playlistId]);
      this.db.run(`DELETE FROM playlists WHERE id = ?`, [playlistId]);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleFlush();
  }

  getPlaylistTracks(id: number): Track[] {
    return this.many<RawRow>(
      `SELECT t.*
         FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position`,
      [Math.trunc(id)],
    ).map(rowToTrack);
  }

  getPlaylistCover(id: number): ArtBlob | null {
    const row = this.one<{ cover_art_path: string | null }>(
      `SELECT cover_art_path FROM playlists WHERE id = ?`,
      [Math.trunc(id)],
    );
    if (!row?.cover_art_path || !existsSync(row.cover_art_path)) return null;
    const mime = playlistCoverMime(row.cover_art_path);
    if (!mime) return null;
    return { mime, data: readFileSync(row.cover_art_path) };
  }

  exportPlaylistM3u(id: number): string {
    const playlist = this.getPlaylist(Math.trunc(id));
    if (!playlist) throw new Error('Playlist not found.');
    const tracks = this.getPlaylistTracks(playlist.id);
    const lines = ['#EXTM3U', `#PLAYLIST:${playlist.name}`];
    for (const track of tracks) {
      const duration = track.duration ? Math.max(0, Math.round(track.duration)) : -1;
      lines.push(`#EXTINF:${duration},${track.artist} - ${track.title}`);
      lines.push(track.path);
    }
    return `${lines.join('\n')}\n`;
  }

  exportPlaylistPls(id: number): string {
    const playlist = this.getPlaylist(Math.trunc(id));
    if (!playlist) throw new Error('Playlist not found.');
    const tracks = this.getPlaylistTracks(playlist.id);
    const lines = ['[playlist]', `NumberOfEntries=${tracks.length}`];
    tracks.forEach((track, index) => {
      const n = index + 1;
      lines.push(`File${n}=${track.path}`);
      lines.push(`Title${n}=${track.artist} - ${track.title}`);
      lines.push(`Length${n}=${track.duration ? Math.max(0, Math.round(track.duration)) : -1}`);
    });
    lines.push('Version=2');
    return `${lines.join('\n')}\n`;
  }

  importPlaylistM3u(input: {
    name: string;
    content: string;
    baseDir?: string;
  }): PlaylistM3uImportResult {
    const paths = parsePlaylistPaths(input.content, input.baseDir);
    const trackIds: number[] = [];
    let skipped = 0;
    for (const path of paths) {
      const row = this.resolveTrackByPath(path);
      if (row) trackIds.push(row.id);
      else skipped += 1;
    }
    const playlist = this.savePlaylist({
      name: input.name,
      trackIds,
    });
    return { playlist, matched: trackIds.length, skipped };
  }

  getSmartPlaylistRules(): SmartPlaylistRule[] {
    return this.many<SmartRuleRow>(
      `SELECT * FROM smart_rules ORDER BY updated_at DESC, name COLLATE NOCASE`,
    ).map(rowToSmartRule);
  }

  getSuggestedSmartPlaylistRules(): SmartPlaylistSuggestion[] {
    const suggestions: SmartPlaylistSuggestion[] = [];
    const addSuggestion = (
      id: string,
      title: string,
      subtitle: string,
      reason: string,
      rule: SmartPlaylistRuleInput,
    ) => {
      if (suggestions.some((item) => item.id === id || item.title.toLowerCase() === title.toLowerCase())) return;
      const normalizedRule = normalizeSmartRuleInput(rule);
      const sampleCount = this.countSmartPlaylistRuleMatches({
        ...normalizedRule,
        id: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      if (!sampleCount) return;
      suggestions.push({ id, title, subtitle, reason, sampleCount, rule: normalizedRule });
    };

    const loved = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE loved = 1`)?.n ?? 0;
    if (loved >= 2) {
      addSuggestion(
        'taste:loved',
        'Loved Radio',
        `${loved.toLocaleString()} loved tracks`,
        'Built from tracks you explicitly loved.',
        { name: 'Loved Radio', mood: 'focus', count: 40, lovedOnly: true },
      );
    }

    const rated = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE rating >= 4`)?.n ?? 0;
    if (rated >= 2) {
      addSuggestion(
        'taste:rated',
        'High Rated Radio',
        `${rated.toLocaleString()} tracks rated 4+`,
        'Prioritizes the strongest star ratings in your catalog.',
        { name: 'High Rated Radio', mood: 'drive', count: 40, minRating: 4 },
      );
    }

    const unplayed = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE play_count = 0`)?.n ?? 0;
    if (unplayed >= 2) {
      addSuggestion(
        'taste:fresh',
        'Discovery Radio',
        `${unplayed.toLocaleString()} unplayed tracks`,
        'Pulls from tracks NewAmp has not seen you play yet.',
        { name: 'Discovery Radio', mood: 'deep-cuts', count: 40, unplayedOnly: true },
      );
    }

    const recentArtists = this.many<{ artist: string; genre: string | null; plays: number; last_played: number }>(
      `SELECT t.artist AS artist,
              MIN(NULLIF(trim(COALESCE(t.genre, '')), '')) AS genre,
              COUNT(*) AS plays,
              MAX(h.played_at) AS last_played
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
        WHERE trim(t.artist) <> ''
          AND lower(trim(t.artist)) NOT IN ('unknown artist', 'unknown')
        GROUP BY lower(trim(t.artist))
       HAVING plays >= 2
        ORDER BY plays DESC, last_played DESC, artist COLLATE NOCASE
        LIMIT 4`,
    );
    for (const row of recentArtists) {
      const artist = cleanSuggestedSearchText(row.artist);
      if (!artist) continue;
      addSuggestion(
        `recent-artist:${slugId(artist)}`,
        `Recent ${artist} Radio`,
        `${row.plays.toLocaleString()} recent plays`,
        `Built from artists NewAmp has seen you return to recently.`,
        {
          name: `Recent ${artist} Radio`,
          mood: moodForStationText(row.genre ?? artist),
          count: 40,
          searchQuery: `artist:"${artist.replace(/"/g, '\\"')}"`,
        },
      );
      if (suggestions.length >= 12) break;
    }

    const genres = this.many<{ genre: string; n: number }>(
      `SELECT MIN(trim(genre)) AS genre, COUNT(*) AS n
        FROM tracks
        WHERE genre IS NOT NULL AND trim(genre) <> ''
        GROUP BY lower(trim(genre))
        ORDER BY n DESC, genre COLLATE NOCASE
        LIMIT 8`,
    );
    for (const row of genres) {
      const genre = normalizeSuggestedGenre(row.genre);
      if (!genre || row.n < 2) continue;
      addSuggestion(
        `genre:${slugId(genre)}`,
        `${genre} Radio`,
        `${row.n.toLocaleString()} ${genre} tracks`,
        `Detected ${genre} as a strong genre cluster in your library.`,
        { name: `${genre} Radio`, mood: moodForStationText(genre), count: 40, genreQuery: genre },
      );
      if (suggestions.length >= 12) break;
    }

    const decades = this.many<{ decade: number; n: number }>(
      `SELECT CAST(CAST(year / 10 AS INTEGER) * 10 AS INTEGER) AS decade, COUNT(*) AS n
        FROM tracks
        WHERE year BETWEEN 1900 AND 2099
        GROUP BY decade
        ORDER BY n DESC, decade DESC
        LIMIT 6`,
    );
    for (const row of decades) {
      if (!Number.isFinite(row.decade) || row.n < 2) continue;
      const decade = Math.trunc(row.decade);
      addSuggestion(
        `decade:${decade}`,
        `${decade}s Radio`,
        `${row.n.toLocaleString()} tracks from ${decade}-${decade + 9}`,
        `Detected a dense ${decade}s era cluster in your library.`,
        { name: `${decade}s Radio`, mood: 'drive', count: 40, minYear: decade, maxYear: decade + 9 },
      );
      if (suggestions.length >= 12) break;
    }

    return suggestions.slice(0, 12);
  }

  getDiscoverSurface(input: DiscoverSurfaceInput = {}): DiscoverSurface {
    const limit = Math.max(4, Math.min(40, Math.trunc(Number(input.limit) || 12)));
    const currentTrack = input.seedTrackId ? this.getTrack(Math.trunc(input.seedTrackId)) : null;
    const highSignalCandidates = this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
        ORDER BY
          loved DESC,
          rating_score DESC,
          rating DESC,
          play_count DESC,
          mtime DESC,
          album_artist COLLATE NOCASE,
          album COLLATE NOCASE,
          disc_no,
          track_no,
          title COLLATE NOCASE
        LIMIT 6000`,
    ).map(rowToTrack);
    const freshCandidates = this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
        ORDER BY mtime DESC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE
        LIMIT 3000`,
    ).map(rowToTrack);
    const underplayedCandidates = this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
          AND play_count <= 1
        ORDER BY mtime ASC, year IS NULL, year ASC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE
        LIMIT 4000`,
    ).map(rowToTrack);
    const albumCandidates = this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
        ORDER BY album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE
        LIMIT 6000`,
    ).map(rowToTrack);
    const tracks = currentTrack && !currentTrack.avoidAutoPlay
      ? uniqueTracksById([currentTrack, ...highSignalCandidates, ...freshCandidates, ...underplayedCandidates, ...albumCandidates])
      : uniqueTracksById([...highSignalCandidates, ...freshCandidates, ...underplayedCandidates, ...albumCandidates]);
    return buildDiscoverSurface({
      ...input,
      limit,
      tracks,
      stats: this.getStats(),
    });
  }

  saveSmartPlaylistRule(input: SmartPlaylistRuleInput): SmartPlaylistRule {
    const normalized = normalizeSmartRuleInput(input);
    const now = Date.now();
    let id = input.id ? Math.trunc(input.id) : 0;

    this.db.run('BEGIN');
    try {
      const existingById = id
        ? this.one<{ id: number }>(`SELECT id FROM smart_rules WHERE id = ?`, [id])
        : null;
      const params = smartRuleParams(normalized);
      if (existingById) {
        this.db.run(
          `UPDATE smart_rules
              SET name = ?, mood = ?, count = ?, genre_query = ?, search_query = ?, min_year = ?, max_year = ?,
                  min_bpm = ?, max_bpm = ?, min_rating = ?, loved_only = ?, unplayed_only = ?, updated_at = ?
            WHERE id = ?`,
          [...params, now, id],
        );
      } else {
        const existingByName = this.one<{ id: number }>(
          `SELECT id FROM smart_rules WHERE name = ?`,
          [normalized.name],
        );
        if (existingByName) {
          id = existingByName.id;
          this.db.run(
            `UPDATE smart_rules
                SET mood = ?, count = ?, genre_query = ?, search_query = ?, min_year = ?, max_year = ?,
                    min_bpm = ?, max_bpm = ?, min_rating = ?, loved_only = ?, unplayed_only = ?, updated_at = ?
              WHERE id = ?`,
            [normalized.mood, normalized.count, normalized.genreQuery, normalized.searchQuery,
              normalized.minYear, normalized.maxYear,
              normalized.minBpm, normalized.maxBpm, normalized.minRating, normalized.lovedOnly ? 1 : 0,
              normalized.unplayedOnly ? 1 : 0, now, id],
          );
        } else {
          this.db.run(
            `INSERT INTO smart_rules
             (name, mood, count, genre_query, search_query, min_year, max_year, min_bpm, max_bpm,
              min_rating, loved_only, unplayed_only, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...params, now, now],
          );
          id = this.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
        }
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    this.scheduleFlush();
    const saved = this.getSmartRule(id);
    if (!saved) throw new Error('Smart rule was not saved.');
    return saved;
  }

  deleteSmartPlaylistRule(id: number): void {
    this.db.run(`DELETE FROM smart_rules WHERE id = ?`, [Math.trunc(id)]);
    this.scheduleFlush();
  }

  listTagRules(): TagRule[] {
    const rows = this.many<TagRuleRow>(
      `SELECT id, name, body, boost, enabled, created_at, updated_at, last_error
       FROM tag_rules ORDER BY updated_at DESC`,
    );
    return rows.map(rowToTagRule);
  }

  getTagRule(id: number): TagRule | null {
    const row = this.one<TagRuleRow>(
      `SELECT id, name, body, boost, enabled, created_at, updated_at, last_error
       FROM tag_rules WHERE id = ?`,
      [Math.trunc(id)],
    );
    return row ? rowToTagRule(row) : null;
  }

  saveTagRule(input: TagRuleInput): TagRule {
    const compiled = parseRule(input.body);
    if (!compiled.rule) {
      const err = compiled.errors[0];
      throw new Error(`tag rule "${input.name}" failed to parse: ${err?.message ?? 'unknown error'}`);
    }
    if (compiled.rule.name !== input.name) {
      throw new Error(`tag name mismatch: header "${input.name}", body "${compiled.rule.name}"`);
    }
    const otherRules = this.listTagRules()
      .filter((rule) => rule.id !== input.id && rule.enabled)
      .map((rule) => parseRule(rule.body).rule)
      .filter((rule): rule is ParsedRule => rule != null);
    try {
      topologicalSort([...otherRules, compiled.rule]);
    } catch (err) {
      throw new Error(
        `tag rule "${compiled.rule.name}" would form a cycle: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const boost = Number.isFinite(input.boost) && input.boost! > 0 ? input.boost! : compiled.rule.boost;
    const now = Date.now();
    const enabled = input.enabled === false ? 0 : 1;
    const trimmedBody = input.body.trim();
    if (input.id) {
      this.db.run(
        `UPDATE tag_rules SET name = ?, body = ?, boost = ?, enabled = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
        [compiled.rule.name, trimmedBody, boost, enabled, now, Math.trunc(input.id)],
      );
      this.scheduleFlush();
      const saved = this.getTagRule(input.id);
      if (!saved) throw new Error(`tag rule ${input.id} disappeared after update`);
      return saved;
    }
    this.db.run(
      `INSERT INTO tag_rules (name, body, boost, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [compiled.rule.name, trimmedBody, boost, enabled, now, now],
    );
    const row = this.one<{ id: number }>(`SELECT id FROM tag_rules WHERE name = ?`, [compiled.rule.name]);
    this.scheduleFlush();
    const saved = row ? this.getTagRule(row.id) : null;
    if (!saved) throw new Error(`tag rule ${compiled.rule.name} could not be loaded after insert`);
    return saved;
  }

  deleteTagRule(id: number): void {
    const rule = this.getTagRule(id);
    if (!rule) return;
    this.db.run(`DELETE FROM track_tags WHERE tag_name = ?`, [rule.name]);
    this.db.run(`DELETE FROM tag_rules WHERE id = ?`, [Math.trunc(id)]);
    this.scheduleFlush();
  }

  setTagRuleEnabled(id: number, enabled: boolean): TagRule | null {
    this.db.run(`UPDATE tag_rules SET enabled = ?, updated_at = ? WHERE id = ?`,
      [enabled ? 1 : 0, Date.now(), Math.trunc(id)]);
    this.scheduleFlush();
    const rule = this.getTagRule(id);
    if (rule && !enabled) {
      this.db.run(`DELETE FROM track_tags WHERE tag_name = ?`, [rule.name]);
      this.scheduleFlush();
    }
    return rule;
  }

  getTagsForTrack(id: number): string[] {
    const rows = this.many<{ tag_name: string }>(
      `SELECT tag_name FROM track_tags WHERE track_id = ? ORDER BY tag_name`,
      [Math.trunc(id)],
    );
    return rows.map((row) => row.tag_name);
  }

  getTrackIdsByTag(name: string): number[] {
    const tag = String(name || '').toLowerCase();
    if (!tag) return [];
    const rows = this.many<{ track_id: number }>(
      `SELECT track_id FROM track_tags WHERE tag_name = ?`,
      [tag],
    );
    return rows.map((row) => row.track_id);
  }

  previewTagRule(input: { body: string; limit?: number }): {
    ok: boolean;
    errors: { message: string; line: number; column: number }[];
    ruleName: string | null;
    references: string[];
    matchCount: number;
    sampleTrackIds: number[];
  } {
    const compiled = parseRule(String(input.body || ''));
    if (!compiled.rule) {
      return { ok: false, errors: compiled.errors, ruleName: null, references: [], matchCount: 0, sampleTrackIds: [] };
    }
    const env = buildEvalEnvironment();
    const otherRules = this.listTagRules().filter((r) => r.enabled && r.name !== compiled.rule!.name);
    const parsedOthers: ParsedRule[] = [];
    for (const rule of otherRules) {
      const c = parseRule(rule.body);
      if (c.rule) parsedOthers.push({ ...c.rule, boost: rule.boost });
    }
    const rules: ParsedRule[] = [...parsedOthers, compiled.rule];
    const limit = Math.max(1, Math.min(10000, Math.trunc(input.limit ?? 2000)));
    const rows = this.many<RawRow>(`SELECT * FROM tracks LIMIT ${limit}`);
    const dnaIndex = this.buildDnaIndex();
    let matchCount = 0;
    const samples: number[] = [];
    for (const row of rows) {
      const track = rowToTrack(row);
      const baseContext: Omit<TrackContext, 'tags'> = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        albumArtist: track.albumArtist,
        genre: track.genre,
        year: track.year,
        duration: track.duration,
        bitrate: track.bitrate,
        sampleRate: track.sampleRate,
        size: track.size,
        mtime: track.mtime,
        bpm: track.bpm,
        key: track.key,
        format: audioExtension(track.path),
        rating: track.rating,
        ratingScore: track.ratingScore,
        playCount: track.playCount,
        skipCount: track.skipCount,
        lastPlayed: track.lastPlayed,
        lastSkipped: track.lastSkipped,
        loved: Boolean(track.loved),
        avoidAutoPlay: Boolean(track.avoidAutoPlay),
        replayGainTrack: track.replayGainTrackDb,
        replayGainAlbum: track.replayGainAlbumDb,
        dna: dnaIndex.get(track.id) ?? null,
      };
      const evaluation = evaluateRulesForTrack({ rules, context: baseContext, env });
      if (evaluation.tags.has(compiled.rule.name)) {
        matchCount += 1;
        if (samples.length < 12) samples.push(track.id);
      }
    }
    return {
      ok: true,
      errors: [],
      ruleName: compiled.rule.name,
      references: compiled.rule.references,
      matchCount,
      sampleTrackIds: samples,
    };
  }

  getTagSummaries(): TagSummary[] {
    const rules = this.listTagRules();
    const boostByName = new Map(rules.map((r) => [r.name, r.boost] as const));
    const enabledByName = new Map(rules.map((r) => [r.name, r.enabled] as const));
    const rows = this.many<{ tag_name: string; count: number }>(
      `SELECT tag_name, COUNT(*) as count FROM track_tags GROUP BY tag_name ORDER BY count DESC`,
    );
    return rows.map((row) => ({
      name: row.tag_name,
      trackCount: row.count,
      boost: boostByName.get(row.tag_name) ?? 1,
      enabled: enabledByName.get(row.tag_name) ?? true,
    }));
  }

  recomputeTags(opts: TagRecomputeOptions = {}): TagRecomputeResult {
    const rules = this.listTagRules().filter((r) => r.enabled);
    const parsedRules: ParsedRule[] = [];
    const errors: Record<string, string> = {};
    for (const rule of rules) {
      const compiled = parseRule(rule.body);
      if (!compiled.rule) {
        const message = compiled.errors[0]?.message ?? 'parse error';
        errors[rule.name] = message;
        this.db.run(`UPDATE tag_rules SET last_error = ? WHERE id = ?`, [message, rule.id]);
        continue;
      }
      parsedRules.push({ ...compiled.rule, boost: rule.boost });
      this.db.run(`UPDATE tag_rules SET last_error = NULL WHERE id = ?`, [rule.id]);
    }
    if (!parsedRules.length) {
      this.db.run(`DELETE FROM track_tags`);
      this.scheduleFlush();
      return { rulesEvaluated: 0, tracksEvaluated: 0, tagsAssigned: 0, errors };
    }

    const env = buildEvalEnvironment(opts.now);
    const targetIds = opts.trackIds && opts.trackIds.length
      ? opts.trackIds.map((id) => Math.trunc(Number(id))).filter((n) => Number.isFinite(n) && n > 0)
      : null;
    const limitSql = opts.limit ? ` LIMIT ${Math.max(1, Math.trunc(opts.limit))}` : '';
    const rows = targetIds
      ? this.many<RawRow>(
          `SELECT * FROM tracks WHERE id IN (${targetIds.map(() => '?').join(',') || '0'})${limitSql}`,
          targetIds,
        )
      : this.many<RawRow>(`SELECT * FROM tracks${limitSql}`);

    if (targetIds) {
      this.db.run(
        `DELETE FROM track_tags WHERE track_id IN (${targetIds.map(() => '?').join(',') || '0'})`,
        targetIds,
      );
    } else {
      this.db.run(`DELETE FROM track_tags`);
    }

    const dnaIndex = this.buildDnaIndex();
    const pending: Array<[number, string]> = [];
    let tagsAssigned = 0;
    let tracksEvaluated = 0;
    for (const row of rows) {
      const track = rowToTrack(row);
      const baseContext: Omit<TrackContext, 'tags'> = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        albumArtist: track.albumArtist,
        genre: track.genre,
        year: track.year,
        duration: track.duration,
        bitrate: track.bitrate,
        sampleRate: track.sampleRate,
        size: track.size,
        mtime: track.mtime,
        bpm: track.bpm,
        key: track.key,
        format: audioExtension(track.path),
        rating: track.rating,
        ratingScore: track.ratingScore,
        playCount: track.playCount,
        skipCount: track.skipCount,
        lastPlayed: track.lastPlayed,
        lastSkipped: track.lastSkipped,
        loved: Boolean(track.loved),
        avoidAutoPlay: Boolean(track.avoidAutoPlay),
        replayGainTrack: track.replayGainTrackDb,
        replayGainAlbum: track.replayGainAlbumDb,
        dna: dnaIndex.get(track.id) ?? null,
      };
      try {
        const evaluation = evaluateRulesForTrack({ rules: parsedRules, context: baseContext, env });
        for (const tag of evaluation.tags) pending.push([track.id, tag]);
        tagsAssigned += evaluation.tags.size;
        for (const [tagName, ruleErrors] of evaluation.errors) {
          if (ruleErrors.length) errors[tagName] = ruleErrors[0]!;
        }
      } catch (err) {
        errors.__recompute__ = err instanceof Error ? err.message : String(err);
      }
      tracksEvaluated += 1;
    }
    this.bulkInsertTrackTags(pending);
    this.scheduleFlush();
    return { rulesEvaluated: parsedRules.length, tracksEvaluated, tagsAssigned, errors };
  }

  private buildDnaIndex(): Map<number, TrackDna> {
    if (this.dnaIndexCache) return this.dnaIndexCache;
    const all = this.getAllTrackDna();
    const map = new Map<number, TrackDna>();
    for (const row of all) map.set(row.id, row.dna);
    this.dnaIndexCache = map;
    return map;
  }

  private invalidateDnaIndexCache(): void {
    this.dnaIndexCache = null;
  }

  private bulkInsertTrackTags(pairs: Array<[number, string]>): void {
    if (!pairs.length) return;
    const CHUNK = 500;
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const slice = pairs.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '(?, ?)').join(',');
      const params: Array<number | string> = [];
      for (const [trackId, tag] of slice) {
        params.push(trackId, tag);
      }
      this.db.run(
        `INSERT OR IGNORE INTO track_tags (track_id, tag_name) VALUES ${placeholders}`,
        params,
      );
    }
  }

  runSmartPlaylistRule(input: number | SmartPlaylistRuleInput): Track[] {
    const rule = typeof input === 'number'
      ? this.getSmartRule(Math.trunc(input))
      : { ...normalizeSmartRuleInput(input), id: 0, createdAt: 0, updatedAt: 0 };
    if (!rule) return [];

    const { where, params } = smartRuleWhere(rule);
    const candidates = this.many<RawRow>(
      `SELECT * FROM tracks ${where} LIMIT 10000`,
      params,
    ).map(rowToTrack);

    return candidates
      .map((track) => ({
        track,
        score: scoreSmartTrack(track, rule) + stableJitter(track.id),
      }))
      .sort((a, b) =>
        b.score - a.score ||
        (a.track.artist || '').localeCompare(b.track.artist || '') ||
        (a.track.title || '').localeCompare(b.track.title || ''),
      )
      .slice(0, rule.count)
      .map((item) => item.track);
  }

  private countSmartPlaylistRuleMatches(rule: SmartPlaylistRule): number {
    const { where, params } = smartRuleWhere(rule);
    const row = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks ${where}`, params);
    return Math.min(rule.count, Math.max(0, row?.n ?? 0));
  }

  buildHarmonicMix(input: HarmonicMixInput = {}): Track[] {
    const where: string[] = ['path IS NOT NULL', 'avoid_auto_play = 0'];
    const params: unknown[] = [];
    const genreQuery = input.genreQuery?.trim();
    if (genreQuery) {
      where.push('genre IS NOT NULL AND lower(genre) LIKE ?');
      params.push(`%${genreQuery.toLowerCase()}%`);
    }
    let candidates = this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE ${where.join(' AND ')}
        ORDER BY
          CASE WHEN bpm IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN key IS NOT NULL AND trim(key) <> '' THEN 0 ELSE 1 END,
          loved DESC,
          play_count DESC,
          title COLLATE NOCASE
        LIMIT 10000`,
      params,
    ).map(rowToTrack);

    const seed = input.seedTrackId ? this.getTrack(input.seedTrackId) : null;
    if (seed && !candidates.some((track) => track.id === seed.id) && !seed.avoidAutoPlay) {
      candidates.unshift(seed);
    }

    if (seed) {
      const seedDnaIndex = this.buildDnaIndex();
      const seedDna = seedDnaIndex.get(seed.id) ?? null;
      const seedCtx = createSeedVibeContext(seed, seedDna);
      const scored = candidates
        .map((track) => ({
          track,
          vibe: track.id === seed.id ? 1 : seedVibeSimilarity(track, seedCtx, seedDnaIndex.get(track.id) ?? null),
        }))
        .sort((a, b) => b.vibe - a.vibe);
      const targetCount = Math.max(80, Math.min(800, normalizeMixCount(input.count) * 12));
      const trimmed = scored.slice(0, targetCount).map((entry) => entry.track);
      candidates = trimmed.length ? trimmed : candidates;
    }

    return buildHarmonicMixSequence(candidates, input);
  }

  buildTasteMix(input: TasteMixInput = {}): Track[] {
    const count = normalizeMixCount(input.count);
    const candidates = this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
        ORDER BY loved DESC, rating DESC, play_count DESC, last_played DESC, title COLLATE NOCASE
        LIMIT 10000`,
    ).map(rowToTrack);

    const requestedSeedId = input.seedTrackId ? Math.trunc(input.seedTrackId) : 0;
    const seed = requestedSeedId > 0 ? this.getTrack(requestedSeedId) : null;
    const pool = seed && !candidates.some((track) => track.id === seed.id) ? [seed, ...candidates] : candidates;
    const unique = uniqueTracksById(pool).filter(isTasteMixCandidate);
    if (!unique.length) return [];

    const opener = seed && isTasteMixCandidate(seed) ? seed : null;
    const context = buildTasteContext(unique, opener, this.buildAlbumRatingIndex());

    // When the user has a seed track, the mix must cohere around that track's
    // vibe. Compute per-candidate seed similarity (DNA + genre + era + artist),
    // then blend it as a strong multiplier on the taste score so off-vibe
    // tracks (different genre / era / no DNA match) drop out even if they're
    // loved heavy-rotation favorites.
    const seedDnaIndex = opener ? this.buildDnaIndex() : null;
    const seedCtx = opener ? createSeedVibeContext(opener, seedDnaIndex?.get(opener.id) ?? null) : null;

    const scored = unique
      .filter((track) => track.id !== opener?.id)
      .map((track) => {
        const base = scoreTasteTrack(track, context) + stableJitter(track.id);
        if (!opener || !seedCtx) return { track, score: base };
        const vibe = seedVibeSimilarity(track, seedCtx, seedDnaIndex?.get(track.id) ?? null);
        return { track, score: applySeedVibeGate(base, vibe) };
      })
      .sort((a, b) =>
        b.score - a.score ||
        (a.track.artist || '').localeCompare(b.track.artist || '') ||
        (a.track.title || '').localeCompare(b.track.title || ''),
      );

    const picked = scored.slice(0, opener ? count - 1 : count).map((item) => item.track);
    return opener ? [opener, ...picked] : picked;
  }

  toggleLove(id: number): boolean {
    const r = this.one<{ loved: number }>(`SELECT loved FROM tracks WHERE id = ?`, [id]);
    if (!r) return false;
    const next = r.loved ? 0 : 1;
    this.db.run(`UPDATE tracks SET loved = ? WHERE id = ?`, [next, id]);
    this.scheduleFlush();
    return !!next;
  }

  setTrackRating(id: number, rating: number): Track | null {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return null;
    const next = normalizeTrackRating(rating);
    // Star changes also sync the fine score so the two stay coherent.
    // 0 stars clears the score; otherwise score = stars * 20.
    const nextScore = next === 0 ? null : next * 20;
    this.db.run(
      `UPDATE tracks SET rating = ?, rating_score = ? WHERE id = ?`,
      [next, nextScore, trackId],
    );
    if (this.db.getRowsModified() <= 0) return null;
    this.scheduleFlush();
    return this.getTrack(trackId);
  }

  setTrackRatingScore(id: number, score: number | null): Track | null {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return null;
    const nextScore = normalizeTrackRatingScore(score);
    // Keep the integer rating column coherent so legacy sorts / smart rules
    // / keyboard shortcuts continue working. round-half-up gives stable buckets.
    const nextStars = nextScore == null ? 0 : Math.max(0, Math.min(5, Math.round(nextScore / 20)));
    this.db.run(
      `UPDATE tracks SET rating = ?, rating_score = ? WHERE id = ?`,
      [nextStars, nextScore, trackId],
    );
    if (this.db.getRowsModified() <= 0) return null;
    this.scheduleFlush();
    return this.getTrack(trackId);
  }

  /**
   * Run one-shot DB migrations gated by flags in `library_meta`. Each
   * migration is idempotent and bails early if its flag is already set.
   * Called once per LibraryStore boot, right after schema is applied.
   */
  private runOneShotMigrations(): void {
    this.maybeBackfillAlbumRatingsFromTracks();
  }

  /**
   * Migration: when a user upgrades from 1.5.3 (or earlier), their album
   * ratings live in `tracks.rating_score` because the old AlbumsView
   * cascade wrote the same score across every track in the album. 1.5.4
   * split album rating into its own table but did not backfill, so those
   * users saw their ratings vanish from NowPlayingView + the taste-mix
   * boost. This migration walks the tracks table, finds (artist, album)
   * groups where every track shares the same nonzero rating_score, and
   * inserts a row into album_ratings. INSERT OR IGNORE preserves any
   * explicit album rating the user has set since 1.5.4.
   */
  private maybeBackfillAlbumRatingsFromTracks(): void {
    const flagKey = 'album_ratings_backfilled_from_tracks_v1';
    const existing = this.one<{ value: string }>(
      `SELECT value FROM library_meta WHERE key = ?`,
      [flagKey],
    );
    if (existing) return;
    try {
      this.db.run(
        `INSERT OR IGNORE INTO album_ratings (album_artist, album, rating, rating_score, updated_at)
         SELECT COALESCE(NULLIF(album_artist, ''), artist) AS album_artist,
                album AS album,
                MIN(rating) AS rating,
                MIN(rating_score) AS rating_score,
                0 AS updated_at
           FROM tracks
          WHERE album != ''
       GROUP BY COALESCE(NULLIF(album_artist, ''), artist), album
         HAVING MIN(rating_score) IS NOT NULL
            AND MIN(rating_score) > 0
            AND MIN(rating_score) = MAX(rating_score)`,
      );
      const inserted = this.db.getRowsModified();
      this.db.run(
        `INSERT OR REPLACE INTO library_meta (key, value) VALUES (?, ?)`,
        [flagKey, String(Date.now())],
      );
      if (inserted > 0) {
        console.log(`[newamp] backfilled ${inserted} album_ratings rows from pre-1.5.4 track-cascade scores`);
      }
      this.scheduleFlush();
    } catch (err) {
      // Don't poison the boot path — if the backfill fails (corrupt DB,
      // unexpected schema), the user just doesn't get their old ratings
      // surfaced. Their tracks table is untouched.
      console.error('[newamp] album_ratings backfill migration failed:', err);
    }
  }

  /**
   * Bulk-read every (album_artist, album) → rating_score row into a Map
   * keyed on `lowercase(albumArtist)|lowercase(album)`. One SQL hit per
   * mix call avoids the N+1 that would otherwise happen if each track
   * looked up its album rating individually.
   */
  buildAlbumRatingIndex(): Map<string, number> {
    const rows = this.many<{ album_artist: string; album: string; rating_score: number | null }>(
      `SELECT album_artist, album, rating_score FROM album_ratings WHERE rating_score IS NOT NULL`,
      [],
    );
    const index = new Map<string, number>();
    for (const row of rows) {
      index.set(albumKey(row.album_artist, row.album), row.rating_score!);
    }
    return index;
  }

  /**
   * Read the stored album rating for a specific (album_artist, album) pair.
   * Returns null if the album has never been rated. Independent of any
   * per-track rating cascade — the previous "set album rating" cascade
   * overwrote each track's rating, losing the user's per-song nuance.
   */
  getAlbumRating(albumArtist: string, album: string): AlbumRating | null {
    const a = (albumArtist ?? '').trim();
    const b = (album ?? '').trim();
    // Missing input is the renderer's bug, not "this album is unrated".
    // Throw so the caller's try/catch surfaces it instead of folding
    // "rateable album never rated" and "this call should never have
    // been made" into the same `null` return.
    if (!a || !b) {
      throw new Error(
        `getAlbumRating requires non-empty albumArtist and album (got albumArtist=${JSON.stringify(albumArtist)}, album=${JSON.stringify(album)})`,
      );
    }
    const row = this.one<{ rating: number; rating_score: number | null; updated_at: number }>(
      `SELECT rating, rating_score, updated_at
         FROM album_ratings
        WHERE album_artist = ? COLLATE NOCASE
          AND album        = ? COLLATE NOCASE`,
      [a, b],
    );
    if (!row) return null;
    return {
      albumArtist: a,
      album: b,
      rating: row.rating,
      ratingScore: row.rating_score,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Upsert the album-level rating score. score === null clears the entry.
   * Track ratings are untouched — albums and songs hold independent
   * ratings. `getAlbums` reads `album_ratings` separately and merges into
   * its result rows via a Map (the LEFT JOIN approach was reverted in
   * 1.5.5 after it broke the WHERE clause with ambiguous columns).
   *
   * Returns `null` only on a successful clear. Throws on missing
   * (albumArtist, album) so the renderer can distinguish "I tried to
   * rate an unrateable album" (e.g., empty AlbumArtist tag) from
   * "I cleared the rating successfully" — those used to share the same
   * `null` return and the UI lied about successful clears for albums
   * that were actually no-ops.
   */
  setAlbumRatingScore(albumArtist: string, album: string, score: number | null): AlbumRating | null {
    const a = (albumArtist ?? '').trim();
    const b = (album ?? '').trim();
    if (!a || !b) {
      throw new Error(
        `setAlbumRatingScore requires non-empty albumArtist and album (got albumArtist=${JSON.stringify(albumArtist)}, album=${JSON.stringify(album)})`,
      );
    }
    const nextScore = normalizeTrackRatingScore(score);
    if (nextScore == null) {
      this.db.run(
        `DELETE FROM album_ratings
          WHERE album_artist = ? COLLATE NOCASE
            AND album        = ? COLLATE NOCASE`,
        [a, b],
      );
      this.scheduleFlush();
      return null;
    }
    const nextStars = Math.max(0, Math.min(5, Math.round(nextScore / 20)));
    const now = Date.now();
    this.db.run(
      `INSERT INTO album_ratings (album_artist, album, rating, rating_score, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(album_artist, album) DO UPDATE SET
         rating       = excluded.rating,
         rating_score = excluded.rating_score,
         updated_at   = excluded.updated_at`,
      [a, b, nextStars, nextScore, now],
    );
    this.scheduleFlush();
    return {
      albumArtist: a,
      album: b,
      rating: nextStars,
      ratingScore: nextScore,
      updatedAt: now,
    };
  }

  setTrackDna(id: number, dna: TrackDna | null): boolean {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return false;
    if (dna == null) {
      this.db.run(`UPDATE tracks SET dna_json = NULL, dna_analyzed_at = NULL WHERE id = ?`, [trackId]);
    } else {
      const json = JSON.stringify(dna);
      const now = Date.now();
      this.db.run(`UPDATE tracks SET dna_json = ?, dna_analyzed_at = ? WHERE id = ?`, [json, now, trackId]);
    }
    if (this.db.getRowsModified() <= 0) return false;
    this.invalidateDnaIndexCache();
    this.scheduleFlush();
    return true;
  }

  getTrackDna(id: number): TrackDna | null {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return null;
    const row = this.one<{ dna_json: string | null }>(
      `SELECT dna_json FROM tracks WHERE id = ?`,
      [trackId],
    );
    if (!row?.dna_json) return null;
    try {
      const parsed = JSON.parse(row.dna_json);
      return isValidTrackDna(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  getTrackIdsMissingDna(limit = 100): number[] {
    const cap = Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 100)));
    const rows = this.many<{ id: number }>(
      `SELECT id FROM tracks WHERE dna_json IS NULL ORDER BY (loved + rating + (rating_score IS NOT NULL)) DESC, mtime DESC LIMIT ?`,
      [cap],
    );
    return rows.map((row) => row.id);
  }

  getAllTrackDna(): Array<{ id: number; dna: TrackDna }> {
    const rows = this.many<{ id: number; dna_json: string | null }>(
      `SELECT id, dna_json FROM tracks WHERE dna_json IS NOT NULL`,
    );
    const out: Array<{ id: number; dna: TrackDna }> = [];
    for (const row of rows) {
      if (!row.dna_json) continue;
      try {
        const parsed = JSON.parse(row.dna_json);
        if (isValidTrackDna(parsed)) out.push({ id: row.id, dna: parsed });
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }

  findSimilarTracks(trackId: number, limit = 20): SimilarTrack[] {
    const id = Math.trunc(Number(trackId));
    if (!Number.isFinite(id) || id <= 0) return [];
    const sourceDna = this.getTrackDna(id);
    if (!sourceDna) return [];
    const all = this.getAllTrackDna();
    const scored: Array<{ id: number; score: number }> = [];
    for (const row of all) {
      if (row.id === id) continue;
      const score = dnaCosineSimilarity(sourceDna, row.dna);
      scored.push({ id: row.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 20));
    const top = scored.slice(0, cap);
    if (!top.length) return [];
    const idList = top.map((entry) => entry.id);
    const tracks = this.getTracksByIdsInOrder(idList);
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return top
      .map((entry) => {
        const track = byId.get(entry.id);
        return track ? { track, score: Math.round(entry.score * 1000) / 1000 } : null;
      })
      .filter((row): row is SimilarTrack => row != null);
  }

  getDnaStats(): { analyzed: number; missing: number; total: number } {
    const totalRow = this.one<{ count: number }>(`SELECT COUNT(*) as count FROM tracks`);
    const analyzedRow = this.one<{ count: number }>(
      `SELECT COUNT(*) as count FROM tracks WHERE dna_json IS NOT NULL`,
    );
    const total = Number(totalRow?.count ?? 0);
    const analyzed = Number(analyzedRow?.count ?? 0);
    return { analyzed, missing: Math.max(0, total - analyzed), total };
  }

  setTrackReplayGain(id: number, replayGainTrackDb: number, replayGainAlbumDb?: number | null): Track | null {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return null;
    const trackGain = normalizeReplayGainDb(replayGainTrackDb);
    if (trackGain == null) return null;
    if (replayGainAlbumDb === undefined) {
      this.db.run(`UPDATE tracks SET replaygain_track_db = ? WHERE id = ?`, [trackGain, trackId]);
    } else {
      const albumGain = normalizeReplayGainDb(replayGainAlbumDb);
      this.db.run(`UPDATE tracks SET replaygain_track_db = ?, replaygain_album_db = ? WHERE id = ?`, [
        trackGain,
        albumGain,
        trackId,
      ]);
    }
    if (this.db.getRowsModified() <= 0) return null;
    this.scheduleFlush();
    return this.getTrack(trackId);
  }

  toggleAvoidAutoPlay(id: number): Track | null {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return null;
    const row = this.one<{ avoid_auto_play: number }>(
      `SELECT avoid_auto_play FROM tracks WHERE id = ?`,
      [trackId],
    );
    if (!row) return null;
    const next = row.avoid_auto_play ? 0 : 1;
    this.db.run(`UPDATE tracks SET avoid_auto_play = ? WHERE id = ?`, [next, trackId]);
    this.scheduleFlush();
    return this.getTrack(trackId);
  }

  recordPlay(id: number, playedAt = Date.now()): void {
    const trackId = Math.trunc(id);
    const played = Math.max(0, Math.trunc(playedAt));
    this.db.run('BEGIN');
    try {
      this.db.run(`UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?`, [
        played,
        trackId,
      ]);
      this.db.run(`INSERT INTO play_history (track_id, played_at) VALUES (?, ?)`, [trackId, played]);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleFlush();
  }

  recordSkip(id: number, skippedAt = Date.now(), position = 0): void {
    const trackId = Math.trunc(id);
    const skipped = Math.max(0, Math.trunc(skippedAt));
    const skipPosition = Math.max(0, Number(position) || 0);
    this.db.run('BEGIN');
    try {
      this.db.run(`UPDATE tracks SET skip_count = skip_count + 1, last_skipped = ? WHERE id = ?`, [
        skipped,
        trackId,
      ]);
      this.db.run(`INSERT INTO skip_history (track_id, skipped_at, position) VALUES (?, ?, ?)`, [
        trackId,
        skipped,
        skipPosition,
      ]);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleFlush();
  }

  getListeningHistory(opts: { limit?: number; offset?: number } = {}): ListeningHistoryItem[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = this.many<RawRow & { history_id: number; played_at: number }>(
      `SELECT h.id AS history_id,
              h.played_at,
              t.*
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
        ORDER BY h.played_at DESC, h.id DESC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map((row) => ({
      id: row.history_id,
      playedAt: row.played_at,
      track: rowToTrack(row),
    }));
  }

  getListeningInsights(opts: { now?: number } = {}): ListeningInsights {
    const requestedNow = Number(opts.now);
    const now = Number.isFinite(requestedNow) ? Math.max(0, Math.trunc(requestedNow)) : Date.now();
    const todayStart = startOfLocalDay(now);
    const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
    const playRows = this.many<{
      track_id: number;
      played_at: number;
      artist: string;
      album: string;
      album_artist: string;
      duration: number | null;
    }>(
      `SELECT h.track_id,
              h.played_at,
              t.artist,
              t.album,
              t.album_artist,
              t.duration
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
        ORDER BY h.played_at DESC, h.id DESC`,
    );
    const skipRows = this.many<{
      track_id: number;
      skipped_at: number;
      artist: string;
      album: string;
      album_artist: string;
    }>(
      `SELECT h.track_id,
              h.skipped_at,
              t.artist,
              t.album,
              t.album_artist
         FROM skip_history h
         JOIN tracks t ON t.id = h.track_id
        ORDER BY h.skipped_at DESC, h.id DESC`,
    );

    const uniqueTracks = new Set<number>();
    const uniqueSkippedTracks = new Set<number>();
    const artists = new Map<string, { plays: number; duration: number; skips: number }>();
    const albums = new Map<string, { album: string; albumArtist: string; plays: number; duration: number; skips: number }>();
    const days = new Map<string, { plays: number; duration: number; skips: number }>();
    let totalDuration = 0;
    let todayPlays = 0;
    let todayDuration = 0;
    let todaySkips = 0;
    let weekPlays = 0;
    let weekDuration = 0;
    let weekSkips = 0;
    let firstPlayedAt: number | null = null;
    let lastPlayedAt: number | null = null;
    let lastSkippedAt: number | null = null;

    for (const row of playRows) {
      const playedAt = Math.max(0, Math.trunc(row.played_at));
      const duration = Math.max(0, Number(row.duration) || 0);
      uniqueTracks.add(row.track_id);
      totalDuration += duration;
      firstPlayedAt = firstPlayedAt == null ? playedAt : Math.min(firstPlayedAt, playedAt);
      lastPlayedAt = lastPlayedAt == null ? playedAt : Math.max(lastPlayedAt, playedAt);

      if (playedAt >= todayStart) {
        todayPlays += 1;
        todayDuration += duration;
      }
      if (playedAt >= weekStart) {
        weekPlays += 1;
        weekDuration += duration;
      }

      const artist = row.artist || 'Unknown Artist';
      const artistBucket = artists.get(artist) ?? { plays: 0, duration: 0, skips: 0 };
      artistBucket.plays += 1;
      artistBucket.duration += duration;
      artists.set(artist, artistBucket);

      const album = row.album || 'Unknown Album';
      const albumArtist = row.album_artist || artist;
      const albumKey = `${albumArtist}\u0000${album}`;
      const albumBucket = albums.get(albumKey) ?? { album, albumArtist, plays: 0, duration: 0, skips: 0 };
      albumBucket.plays += 1;
      albumBucket.duration += duration;
      albums.set(albumKey, albumBucket);

      const day = localDateKey(playedAt);
      const dayBucket = days.get(day) ?? { plays: 0, duration: 0, skips: 0 };
      dayBucket.plays += 1;
      dayBucket.duration += duration;
      days.set(day, dayBucket);
    }

    for (const row of skipRows) {
      const skippedAt = Math.max(0, Math.trunc(row.skipped_at));
      uniqueSkippedTracks.add(row.track_id);
      lastSkippedAt = lastSkippedAt == null ? skippedAt : Math.max(lastSkippedAt, skippedAt);

      if (skippedAt >= todayStart) todaySkips += 1;
      if (skippedAt >= weekStart) weekSkips += 1;

      const artist = row.artist || 'Unknown Artist';
      const artistBucket = artists.get(artist) ?? { plays: 0, duration: 0, skips: 0 };
      artistBucket.skips += 1;
      artists.set(artist, artistBucket);

      const album = row.album || 'Unknown Album';
      const albumArtist = row.album_artist || artist;
      const albumKey = `${albumArtist}\u0000${album}`;
      const albumBucket = albums.get(albumKey) ?? { album, albumArtist, plays: 0, duration: 0, skips: 0 };
      albumBucket.skips += 1;
      albums.set(albumKey, albumBucket);

      const day = localDateKey(skippedAt);
      const dayBucket = days.get(day) ?? { plays: 0, duration: 0, skips: 0 };
      dayBucket.skips += 1;
      days.set(day, dayBucket);
    }

    return {
      generatedAt: now,
      total: {
        plays: playRows.length,
        duration: totalDuration,
        skips: skipRows.length,
        uniqueTracks: uniqueTracks.size,
        uniqueSkippedTracks: uniqueSkippedTracks.size,
        firstPlayedAt,
        lastPlayedAt,
        lastSkippedAt,
      },
      today: { plays: todayPlays, duration: todayDuration, skips: todaySkips },
      week: { plays: weekPlays, duration: weekDuration, skips: weekSkips },
      topArtists: [...artists.entries()]
        .map(([artist, bucket]) => ({ artist, ...bucket }))
        .sort(sortInsightBuckets)
        .slice(0, 8),
      topAlbums: [...albums.values()].sort(sortInsightBuckets).slice(0, 8),
      recentDays: [...days.entries()]
        .map(([date, bucket]) => ({ date, ...bucket }))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 14),
    };
  }

  getWrappedStats(opts: { range?: WrappedRange; now?: number } = {}): WrappedStats {
    const requestedNow = Number(opts.now);
    const now = Number.isFinite(requestedNow) ? Math.max(0, Math.trunc(requestedNow)) : Date.now();
    const validRanges: WrappedRange[] = ['day', 'week', 'month', 'year', 'all'];
    const range: WrappedRange = validRanges.includes(opts.range as WrappedRange) ? (opts.range as WrappedRange) : 'year';
    const { start, end, label } = wrappedWindow(range, now);

    const rows = this.many<{
      track_id: number;
      played_at: number;
      title: string;
      artist: string;
      album: string;
      album_artist: string;
      duration: number | null;
      genre: string | null;
      loved: number;
      dna_json: string | null;
    }>(
      `SELECT h.track_id, h.played_at, t.title, t.artist, t.album, t.album_artist, t.duration, t.genre, t.loved, t.dna_json
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
        WHERE h.played_at >= ? AND h.played_at <= ?`,
      [start, end],
    );

    // Global first-play per track → "discoveries" = tracks whose first-ever
    // play landed inside this window.
    const firstPlays = this.many<{ track_id: number; first_at: number }>(
      `SELECT track_id, MIN(played_at) AS first_at FROM play_history GROUP BY track_id`,
    );
    let discoveries = 0;
    for (const fp of firstPlays) {
      const at = Math.trunc(fp.first_at);
      if (at >= start && at <= end) discoveries += 1;
    }

    const trackPlays = new Map<number, { title: string; artist: string; plays: number }>();
    const artistAgg = new Map<string, { plays: number; duration: number }>();
    const albumAgg = new Map<string, { album: string; albumArtist: string; plays: number }>();
    const genreAgg = new Map<string, number>();
    const clock = new Array(24).fill(0) as number[];
    const dayPlays = new Map<string, number>();
    const uniqueTracks = new Set<number>();
    const uniqueArtists = new Set<string>();
    const lovedTracks = new Set<number>();
    const dnaSeen = new Map<number, TrackDna | null>();
    let durationSec = 0;
    let energySum = 0;
    let brightSum = 0;
    let dnaWeight = 0;
    const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

    for (const row of rows) {
      const playedAt = Math.max(0, Math.trunc(row.played_at));
      const dur = Math.max(0, Number(row.duration) || 0);
      durationSec += dur;
      uniqueTracks.add(row.track_id);
      const artist = row.artist || 'Unknown Artist';
      uniqueArtists.add(artist);
      if (row.loved) lovedTracks.add(row.track_id);

      const tp = trackPlays.get(row.track_id) ?? { title: row.title || 'Unknown', artist, plays: 0 };
      tp.plays += 1;
      trackPlays.set(row.track_id, tp);

      const ab = artistAgg.get(artist) ?? { plays: 0, duration: 0 };
      ab.plays += 1;
      ab.duration += dur;
      artistAgg.set(artist, ab);

      const album = row.album || 'Unknown Album';
      const albumArtist = row.album_artist || artist;
      const akey = `${albumArtist} ${album}`;
      const al = albumAgg.get(akey) ?? { album, albumArtist, plays: 0 };
      al.plays += 1;
      albumAgg.set(akey, al);

      const genre = (row.genre || '').trim();
      if (genre) genreAgg.set(genre, (genreAgg.get(genre) ?? 0) + 1);

      clock[new Date(playedAt).getHours()] += 1;
      const dk = localDateKey(playedAt);
      dayPlays.set(dk, (dayPlays.get(dk) ?? 0) + 1);

      if (!dnaSeen.has(row.track_id)) {
        let dna: TrackDna | null = null;
        if (row.dna_json) {
          try {
            const parsed = JSON.parse(row.dna_json) as unknown;
            dna = isValidTrackDna(parsed) ? parsed : null;
          } catch {
            dna = null;
          }
        }
        dnaSeen.set(row.track_id, dna);
      }
      const dna = dnaSeen.get(row.track_id);
      if (dna) {
        energySum += clamp01(dna.rms * 0.5 + dna.onsetDensity * 0.5);
        brightSum += clamp01(dna.brightness);
        dnaWeight += 1;
      }
    }

    let busiestDay: { date: string; plays: number } | null = null;
    for (const [date, plays] of dayPlays) {
      if (!busiestDay || plays > busiestDay.plays) busiestDay = { date, plays };
    }

    // Longest run of consecutive local days with at least one play in window.
    const sortedDays = [...dayPlays.keys()].sort();
    let longestStreakDays = 0;
    let run = 0;
    let prevKey: string | null = null;
    for (const key of sortedDays) {
      if (prevKey && new Date(`${key}T00:00:00`).getTime() - new Date(`${prevKey}T00:00:00`).getTime() === 86_400_000) {
        run += 1;
      } else {
        run = 1;
      }
      longestStreakDays = Math.max(longestStreakDays, run);
      prevKey = key;
    }

    let peakHour: number | null = null;
    let peakHourPlays = -1;
    for (let h = 0; h < 24; h++) {
      if (clock[h]! > peakHourPlays) {
        peakHourPlays = clock[h]!;
        peakHour = h;
      }
    }
    if (peakHourPlays <= 0) peakHour = null;

    const taste: WrappedStats['taste'] = dnaWeight > 0
      ? (() => {
          const energy = energySum / dnaWeight;
          const brightness = brightSum / dnaWeight;
          return { energy, brightness, mood: wrappedMoodLabel(energy, brightness) };
        })()
      : null;

    return {
      range,
      label,
      generatedAt: now,
      rangeStart: start,
      rangeEnd: end,
      totals: {
        plays: rows.length,
        durationSec,
        uniqueTracks: uniqueTracks.size,
        uniqueArtists: uniqueArtists.size,
        discoveries,
        loved: lovedTracks.size,
      },
      topTracks: [...trackPlays.entries()]
        .map(([id, t]) => ({ id, title: t.title, artist: t.artist, plays: t.plays }))
        .sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title))
        .slice(0, 10),
      topArtists: [...artistAgg.entries()]
        .map(([artist, a]) => ({ artist, plays: a.plays, durationSec: a.duration }))
        .sort((a, b) => b.plays - a.plays || a.artist.localeCompare(b.artist))
        .slice(0, 10),
      topAlbums: [...albumAgg.values()]
        .sort((a, b) => b.plays - a.plays || a.album.localeCompare(b.album))
        .slice(0, 8),
      genres: [...genreAgg.entries()]
        .map(([genre, plays]) => ({ genre, plays }))
        .sort((a, b) => b.plays - a.plays || a.genre.localeCompare(b.genre))
        .slice(0, 8),
      listeningClock: clock,
      peakHour,
      busiestDay,
      longestStreakDays,
      taste,
    };
  }

  // --- Local-first social objects -----------------------------------------
  private normalizePrivacy(value: unknown): SocialPrivacy {
    return value === 'friends' || value === 'public' ? value : 'local';
  }

  private mapReviewRow(row: {
    id: number;
    target_type: string;
    target_key: string;
    title: string;
    body: string;
    rating: number | null;
    privacy: string;
    created_at: number;
    updated_at: number;
  }): Review {
    return {
      id: row.id,
      targetType: (row.target_type as ReviewTargetType) ?? 'track',
      targetKey: row.target_key,
      title: row.title ?? '',
      body: row.body ?? '',
      rating: row.rating == null ? null : Number(row.rating),
      privacy: this.normalizePrivacy(row.privacy),
      createdAt: Math.trunc(row.created_at),
      updatedAt: Math.trunc(row.updated_at),
    };
  }

  getReviews(target?: { type: ReviewTargetType; key: string }): Review[] {
    const rows = target
      ? this.many<Parameters<typeof this.mapReviewRow>[0]>(
          `SELECT * FROM reviews WHERE target_type = ? AND target_key = ? ORDER BY updated_at DESC`,
          [target.type, String(target.key)],
        )
      : this.many<Parameters<typeof this.mapReviewRow>[0]>(`SELECT * FROM reviews ORDER BY updated_at DESC`);
    return rows.map((row) => this.mapReviewRow(row));
  }

  getReviewById(id: number): Review | null {
    const row = this.one<Parameters<typeof this.mapReviewRow>[0]>(`SELECT * FROM reviews WHERE id = ?`, [Math.trunc(id)]);
    return row ? this.mapReviewRow(row) : null;
  }

  saveReview(input: ReviewInput): Review {
    if (!input || (input.targetType !== 'track' && input.targetType !== 'album' && input.targetType !== 'artist')) {
      throw new Error('saveReview requires a valid targetType');
    }
    const now = Date.now();
    const privacy = this.normalizePrivacy(input.privacy);
    const rating = input.rating == null ? null : Math.max(0, Math.min(100, Number(input.rating) || 0));
    const title = String(input.title ?? '');
    const body = String(input.body ?? '');
    const targetKey = String(input.targetKey ?? '');
    let id = input.id ? Math.trunc(input.id) : 0;
    if (id && this.one<{ id: number }>(`SELECT id FROM reviews WHERE id = ?`, [id])) {
      this.db.run(
        `UPDATE reviews SET target_type = ?, target_key = ?, title = ?, body = ?, rating = ?, privacy = ?, updated_at = ? WHERE id = ?`,
        [input.targetType, targetKey, title, body, rating, privacy, now, id],
      );
    } else {
      this.db.run(
        `INSERT INTO reviews (target_type, target_key, title, body, rating, privacy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.targetType, targetKey, title, body, rating, privacy, now, now],
      );
      id = this.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
    }
    this.scheduleFlush();
    const saved = this.getReviewById(id);
    if (!saved) throw new Error('Review was not saved.');
    return saved;
  }

  deleteReview(id: number): void {
    this.db.run(`DELETE FROM reviews WHERE id = ?`, [Math.trunc(id)]);
    this.scheduleFlush();
  }

  private listItems(listId: number): ListItem[] {
    return this.many<{ id: number; list_id: number; track_id: number | null; label: string; note: string; position: number }>(
      `SELECT * FROM list_items WHERE list_id = ? ORDER BY position ASC, id ASC`,
      [Math.trunc(listId)],
    ).map((row) => ({
      id: row.id,
      listId: row.list_id,
      trackId: row.track_id == null ? null : Math.trunc(row.track_id),
      label: row.label ?? '',
      note: row.note ?? '',
      position: Math.trunc(row.position),
    }));
  }

  getLists(): ListSummary[] {
    return this.many<{
      id: number;
      title: string;
      description: string;
      ranked: number;
      privacy: string;
      created_at: number;
      updated_at: number;
      item_count: number;
    }>(
      `SELECT l.*, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count
         FROM lists l ORDER BY l.updated_at DESC`,
    ).map((row) => ({
      id: row.id,
      title: row.title ?? '',
      description: row.description ?? '',
      ranked: row.ranked !== 0,
      privacy: this.normalizePrivacy(row.privacy),
      itemCount: Math.trunc(row.item_count),
      createdAt: Math.trunc(row.created_at),
      updatedAt: Math.trunc(row.updated_at),
    }));
  }

  getList(id: number): ListDetail | null {
    const summary = this.getLists().find((l) => l.id === Math.trunc(id));
    if (!summary) return null;
    return { ...summary, items: this.listItems(summary.id) };
  }

  saveList(input: ListInput): ListSummary {
    const now = Date.now();
    const privacy = this.normalizePrivacy(input.privacy);
    const title = String(input.title ?? 'Untitled list') || 'Untitled list';
    const description = String(input.description ?? '');
    const ranked = input.ranked === false ? 0 : 1;
    let id = input.id ? Math.trunc(input.id) : 0;
    if (id && this.one<{ id: number }>(`SELECT id FROM lists WHERE id = ?`, [id])) {
      this.db.run(
        `UPDATE lists SET title = ?, description = ?, ranked = ?, privacy = ?, updated_at = ? WHERE id = ?`,
        [title, description, ranked, privacy, now, id],
      );
    } else {
      this.db.run(
        `INSERT INTO lists (title, description, ranked, privacy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [title, description, ranked, privacy, now, now],
      );
      id = this.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
    }
    this.scheduleFlush();
    const saved = this.getLists().find((l) => l.id === id);
    if (!saved) throw new Error('List was not saved.');
    return saved;
  }

  deleteList(id: number): void {
    this.db.run(`DELETE FROM lists WHERE id = ?`, [Math.trunc(id)]);
    this.scheduleFlush();
  }

  addListItem(input: ListItemInput): ListItem {
    const listId = Math.trunc(input.listId);
    if (!this.one<{ id: number }>(`SELECT id FROM lists WHERE id = ?`, [listId])) {
      throw new Error('addListItem: list does not exist');
    }
    const nextPos = (this.one<{ pos: number }>(`SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM list_items WHERE list_id = ?`, [listId])?.pos) ?? 0;
    this.db.run(
      `INSERT INTO list_items (list_id, track_id, label, note, position) VALUES (?, ?, ?, ?, ?)`,
      [listId, input.trackId == null ? null : Math.trunc(input.trackId), String(input.label ?? ''), String(input.note ?? ''), nextPos],
    );
    const id = this.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
    this.db.run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [Date.now(), listId]);
    this.scheduleFlush();
    return this.listItems(listId).find((i) => i.id === id)!;
  }

  removeListItem(id: number): void {
    const item = this.one<{ list_id: number }>(`SELECT list_id FROM list_items WHERE id = ?`, [Math.trunc(id)]);
    this.db.run(`DELETE FROM list_items WHERE id = ?`, [Math.trunc(id)]);
    if (item) this.db.run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [Date.now(), item.list_id]);
    this.scheduleFlush();
  }

  reorderListItems(listId: number, orderedIds: number[]): void {
    const lid = Math.trunc(listId);
    this.db.run('BEGIN');
    try {
      orderedIds.forEach((itemId, index) => {
        this.db.run(`UPDATE list_items SET position = ? WHERE id = ? AND list_id = ?`, [index, Math.trunc(itemId), lid]);
      });
      this.db.run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [Date.now(), lid]);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleFlush();
  }

  getProfile(): UserProfile {
    this.db.run(`INSERT OR IGNORE INTO profile (id, updated_at) VALUES (1, ?)`, [Date.now()]);
    const row = this.one<{ display_name: string; bio: string; favorites: string; default_privacy: string; updated_at: number }>(
      `SELECT display_name, bio, favorites, default_privacy, updated_at FROM profile WHERE id = 1`,
    );
    let favorites: string[] = [];
    if (row?.favorites) {
      try {
        const parsed = JSON.parse(row.favorites) as unknown;
        if (Array.isArray(parsed)) favorites = parsed.map((x) => String(x)).slice(0, 5);
      } catch {
        favorites = [];
      }
    }
    return {
      displayName: row?.display_name ?? '',
      bio: row?.bio ?? '',
      favorites,
      defaultPrivacy: this.normalizePrivacy(row?.default_privacy),
      updatedAt: Math.trunc(row?.updated_at ?? 0),
    };
  }

  saveProfile(input: UserProfileInput): UserProfile {
    const current = this.getProfile();
    const now = Date.now();
    const displayName = input.displayName === undefined ? current.displayName : String(input.displayName);
    const bio = input.bio === undefined ? current.bio : String(input.bio);
    const favorites = (input.favorites === undefined ? current.favorites : input.favorites).map((x) => String(x)).slice(0, 5);
    const defaultPrivacy = input.defaultPrivacy === undefined ? current.defaultPrivacy : this.normalizePrivacy(input.defaultPrivacy);
    this.db.run(
      `UPDATE profile SET display_name = ?, bio = ?, favorites = ?, default_privacy = ?, updated_at = ? WHERE id = 1`,
      [displayName, bio, JSON.stringify(favorites), defaultPrivacy, now],
    );
    this.scheduleFlush();
    return this.getProfile();
  }

  // Build a self-contained, offline-shareable HTML profile page from local
  // data. No network, no upload — the export the social roadmap requires before
  // any account service exists.
  buildProfileBundleHtml(opts: { now?: number } = {}): string {
    const profile = this.getProfile();
    const lists = this.getLists().map((l) => ({ ...l, items: this.listItems(l.id) }));
    const reviews = this.getReviews();
    const insights = this.getListeningInsights({ now: opts.now });
    const esc = htmlEscape;
    const topArtists = insights.topArtists
      .slice(0, 10)
      .map((a) => `<li>${esc(a.artist)} <span class="muted">· ${a.plays} plays</span></li>`)
      .join('');
    const favoritesHtml = profile.favorites.length
      ? `<ul class="favorites">${profile.favorites.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      : '<p class="muted">No favorites picked yet.</p>';
    const listsHtml = lists.length
      ? lists
          .map(
            (l) =>
              `<section class="card"><h3>${esc(l.title)}${l.ranked ? ' <span class="muted">(ranked)</span>' : ''}</h3>` +
              (l.description ? `<p>${esc(l.description)}</p>` : '') +
              `<ol>${l.items.map((i) => `<li>${esc(i.label || (i.trackId ? `Track #${i.trackId}` : 'Item'))}${i.note ? ` <span class="muted">— ${esc(i.note)}</span>` : ''}</li>`).join('')}</ol></section>`,
          )
          .join('')
      : '<p class="muted">No lists yet.</p>';
    const reviewsHtml = reviews.length
      ? reviews
          .map(
            (r) =>
              `<section class="card"><h3>${esc(r.title || `${r.targetType} review`)}${r.rating != null ? ` <span class="score">${r.rating.toFixed(0)}/100</span>` : ''}</h3>` +
              `<p class="muted">${esc(r.targetType)} · ${esc(r.targetKey)}</p>` +
              `<p>${esc(r.body)}</p></section>`,
          )
          .join('')
      : '<p class="muted">No reviews yet.</p>';

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(profile.displayName || 'NewAmp')} · NewAmp profile</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a0c0a;color:#eef2ee;font:16px/1.5 Inter,system-ui,sans-serif;padding:40px}
.wrap{max-width:880px;margin:0 auto}
h1{font-size:44px;margin:0 0 4px}
h2{color:#39ff14;font:700 14px/1 "JetBrains Mono",monospace;letter-spacing:.18em;text-transform:uppercase;margin:36px 0 12px}
h3{margin:0 0 6px}
.muted{color:rgba(238,242,238,.55)}
.score{color:#39ff14;font-weight:700}
.card{background:#13110f;border:1px solid #232323;border-radius:10px;padding:16px;margin-bottom:12px}
ul,ol{margin:0;padding-left:20px}
.favorites{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.favorites li{background:#39ff1418;border:1px solid #39ff1440;border-radius:8px;padding:8px 12px}
footer{margin-top:48px;color:rgba(238,242,238,.4);font:600 14px "JetBrains Mono",monospace}
</style></head>
<body><div class="wrap">
<h1>${esc(profile.displayName || 'Anonymous listener')}</h1>
${profile.bio ? `<p>${esc(profile.bio)}</p>` : ''}
<h2>Five bags</h2>${favoritesHtml}
<h2>Top artists</h2><ul>${topArtists || '<li class="muted">No plays yet.</li>'}</ul>
<h2>Lists</h2>${listsHtml}
<h2>Reviews</h2>${reviewsHtml}
<footer>Exported from NewAmp · local-first music · no account, no cloud</footer>
</div></body></html>`;
  }

  clearListeningHistory(): void {
    this.db.run(`DELETE FROM play_history`);
    this.db.run(`DELETE FROM skip_history`);
    this.scheduleFlush();
  }

  getTrackBookmarks(trackId: number): TrackBookmark[] {
    return this.many<BookmarkRow>(
      `SELECT * FROM track_bookmarks WHERE track_id = ? ORDER BY position, id`,
      [Math.trunc(trackId)],
    ).map(rowToBookmark);
  }

  saveTrackBookmark(input: SaveTrackBookmarkInput): TrackBookmark {
    const trackId = Math.trunc(input.trackId);
    const existingTrack = this.one<{ id: number }>(`SELECT id FROM tracks WHERE id = ?`, [trackId]);
    if (!existingTrack) throw new Error('Cannot bookmark a missing track.');

    const position = roundBookmarkPosition(input.position);
    const label = normalizeBookmarkLabel(input.label, position);
    const now = Date.now();
    let id = input.id ? Math.trunc(input.id) : 0;

    const existing = id
      ? this.one<{ id: number }>(
          `SELECT id FROM track_bookmarks WHERE id = ? AND track_id = ?`,
          [id, trackId],
        )
      : null;

    if (existing) {
      this.db.run(
        `UPDATE track_bookmarks SET position = ?, label = ?, updated_at = ? WHERE id = ?`,
        [position, label, now, id],
      );
    } else {
      this.db.run(
        `INSERT INTO track_bookmarks (track_id, position, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [trackId, position, label, now, now],
      );
      id = this.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
    }

    this.scheduleFlush();
    const saved = this.one<BookmarkRow>(`SELECT * FROM track_bookmarks WHERE id = ?`, [id]);
    if (!saved) throw new Error('Bookmark was not saved.');
    return rowToBookmark(saved);
  }

  deleteTrackBookmark(id: number): void {
    this.db.run(`DELETE FROM track_bookmarks WHERE id = ?`, [Math.trunc(id)]);
    this.scheduleFlush();
  }

  getCachedGuitarTabs(trackId: number): CachedGuitarTab[] {
    return this.many<CachedGuitarTabRow>(
      `SELECT * FROM guitar_tab_cache WHERE track_id = ? ORDER BY updated_at DESC, id DESC`,
      [Math.trunc(trackId)],
    ).map(rowToCachedGuitarTab);
  }

  saveCachedGuitarTab(trackId: number, document: GuitarTabDocument): CachedGuitarTab {
    const id = Math.trunc(trackId);
    const existingTrack = this.one<{ id: number }>(`SELECT id FROM tracks WHERE id = ?`, [id]);
    if (!existingTrack) throw new Error('Cannot cache a guitar tab for a missing track.');
    if (!['ultimate-guitar', 'local'].includes(document.source) || !document.url.trim()) {
      throw new Error('Only NewAmp guitar tab documents can be cached.');
    }

    const now = Date.now();
    this.db.run(
      `INSERT INTO guitar_tab_cache (track_id, url, title, artist, kind, document, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(track_id, url) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         kind = excluded.kind,
         document = excluded.document,
         updated_at = excluded.updated_at`,
      [
        id,
        document.url,
        document.title || 'Guitar Tab',
        document.artist || 'Unknown Artist',
        document.kind || 'Tab',
        JSON.stringify(document),
        now,
        now,
      ],
    );
    this.scheduleFlush();

    const row = this.one<CachedGuitarTabRow>(
      `SELECT * FROM guitar_tab_cache WHERE track_id = ? AND url = ?`,
      [id, document.url],
    );
    if (!row) throw new Error('Guitar tab cache row was not saved.');
    return rowToCachedGuitarTab(row);
  }

  private writePlaylistCover(id: number, sourcePath: string): string {
    const source = resolvePath(sourcePath);
    if (!existsSync(source)) throw new Error('Playlist icon image was not found.');
    const stat = statSync(source);
    if (!stat.isFile()) throw new Error('Playlist icon must be an image file.');
    if (stat.size > 12 * 1024 * 1024) throw new Error('Playlist icon image must be 12 MB or smaller.');
    const ext = normalizedPlaylistCoverExt(source);
    if (!ext) throw new Error('Playlist icon must be a PNG, JPEG, WebP, GIF, BMP, or AVIF image.');
    const data = readFileSync(source);
    const hash = createHash('sha1').update(data).digest('hex').slice(0, 16);
    const destination = join(this.playlistArtDir, `playlist-${Math.trunc(id)}-${hash}${ext}`);
    writeFileSync(destination, data);
    return destination;
  }

  private uniquePlaylistName(baseName: string, excludeId: number): string {
    let candidate = baseName;
    let suffix = 2;
    while (true) {
      const existing = this.one<{ id: number }>(
        `SELECT id FROM playlists WHERE name = ? COLLATE NOCASE LIMIT 1`,
        [candidate],
      );
      if (!existing || existing.id === excludeId) return candidate;
      candidate = `${baseName} ${suffix}`;
      suffix += 1;
    }
  }

  private getPlaylist(id: number): SavedPlaylist | null {
    const row = this.one<{
      id: number;
      name: string;
      cover_art_path: string | null;
      cover_art_updated_at: number | null;
      track_count: number;
      duration: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT p.id,
              p.name,
              p.cover_art_path,
              p.cover_art_updated_at,
              COUNT(pt.track_id) AS track_count,
              COALESCE(SUM(t.duration), 0) AS duration,
              p.created_at,
              p.updated_at
         FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = pt.track_id
        WHERE p.id = ?
        GROUP BY p.id`,
      [id],
    );
    return row
      ? {
          id: row.id,
          name: row.name,
          trackCount: row.track_count,
          duration: row.duration,
          hasCoverArt: row.cover_art_path ? 1 : 0,
          coverArtUpdatedAt: row.cover_art_path ? row.cover_art_updated_at : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  private getSmartRule(id: number): SmartPlaylistRule | null {
    const row = this.one<SmartRuleRow>(`SELECT * FROM smart_rules WHERE id = ?`, [id]);
    return row ? rowToSmartRule(row) : null;
  }

  private resolveTrackByPath(path: string): { id: number } | null {
    const exact = this.one<{ id: number }>(`SELECT id FROM tracks WHERE path = ?`, [path]);
    if (exact) return exact;
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return this.one<{ id: number }>(
      `SELECT id FROM tracks WHERE lower(replace(path, '\\', '/')) = ? LIMIT 1`,
      [normalized],
    );
  }

  getArt(trackId: number): { mime: string; data: Buffer } | null {
    const row = this.one<{ art_hash: string | null; album: string | null; album_artist: string | null }>(
      `SELECT art_hash, album, album_artist FROM tracks WHERE id = ?`,
      [trackId],
    );
    if (!row) return null;
    let artHash = row.art_hash;
    if (!artHash && row.album && row.album_artist) {
      const fallback = this.one<{ art_hash: string | null }>(
        `SELECT art_hash
         FROM tracks
         WHERE album = ? AND album_artist = ? AND art_hash IS NOT NULL AND art_hash != ''
         ORDER BY COALESCE(disc_no, 1), COALESCE(track_no, 999999), id
         LIMIT 1`,
        [row.album, row.album_artist],
      );
      artHash = fallback?.art_hash ?? null;
    }
    if (!artHash) return null;
    // Find the file. We don't store mime in the DB, so probe common extensions.
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const p = join(this.artDir, `${artHash}${ext}`);
      if (existsSync(p)) {
        try {
          const data = readFileSync(p);
          return { mime: extToMime(ext), data };
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private one<T>(sql: string, params: ReadonlyArray<unknown> = []): T | null {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as unknown as import('sql.js').BindParams);
      if (stmt.step()) {
        return stmt.getAsObject() as unknown as T;
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  private many<T = RawRow>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    const out: T[] = [];
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as unknown as import('sql.js').BindParams);
      while (stmt.step()) out.push(stmt.getAsObject() as unknown as T);
      return out;
    } finally {
      stmt.free();
    }
  }
}

function mimeToExt(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

function extToMime(ext: string): string {
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function normalizedPlaylistCoverExt(path: string): string | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpeg') return '.jpg';
  if (['.jpg', '.png', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) return ext;
  return null;
}

function normalizePruneTargets(targets: string[] | undefined): PruneTarget[] {
  if (!targets?.length) return [];
  const out: PruneTarget[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    if (typeof target !== 'string' || !target.trim()) continue;
    const resolved = resolvePath(target);
    let kind: PruneTarget['kind'] = extname(resolved) ? 'file' : 'dir';
    try {
      const stat = statSync(resolved);
      kind = stat.isDirectory() ? 'dir' : 'file';
    } catch {
      // Deleted watcher events often point at paths that no longer stat.
    }
    const key = normalizedPruneKey(resolved);
    const seenKey = `${kind}:${key}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    out.push({ kind, key });
  }

  return out;
}

function matchesPruneTargets(path: string, targets: PruneTarget[]): boolean {
  const key = normalizedPruneKey(path);
  return targets.some((target) => {
    if (target.kind === 'file') return key === target.key;
    return key === target.key || key.startsWith(`${target.key}/`);
  });
}

function normalizedPruneKey(path: string): string {
  return resolvePath(path).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function playlistCoverMime(path: string): string | null {
  const ext = normalizedPlaylistCoverExt(path);
  if (ext === '.jpg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.avif') return 'image/avif';
  return null;
}

function normalizePlaylistName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  return trimmed || `Playlist ${new Date().toLocaleString()}`;
}

function trackSortOrder(sort: string | undefined): string {
  switch (sort) {
    case 'recent':
      return 'last_played DESC, mtime DESC, artist COLLATE NOCASE, title COLLATE NOCASE';
    case 'plays':
      return 'play_count DESC, title COLLATE NOCASE, artist COLLATE NOCASE';
    case 'loved':
      return 'loved DESC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
    case 'added':
      return 'mtime DESC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
    case 'rating':
      return 'rating DESC, loved DESC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
    case 'title':
      return 'title COLLATE NOCASE, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no';
    case 'year':
      return 'year IS NULL, year DESC, album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
    case 'genre':
      return 'genre IS NULL, genre COLLATE NOCASE, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
    case 'duration':
      return 'duration IS NULL, duration DESC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
    case 'album':
      return 'album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
    case 'artist':
    default:
      return 'artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE';
  }
}

export function albumSortOrder(sort: string | undefined, randomSeed: number | undefined): string {
  const artistOrder = 'album_artist COLLATE NOCASE, year IS NULL, year, album COLLATE NOCASE';
  switch (sort) {
    case 'album':
      return 'album COLLATE NOCASE, album_artist COLLATE NOCASE, year IS NULL, year';
    case 'year-desc':
      return 'year IS NULL, year DESC, album_artist COLLATE NOCASE, album COLLATE NOCASE';
    case 'year-asc':
      return 'year IS NULL, year ASC, album_artist COLLATE NOCASE, album COLLATE NOCASE';
    case 'recent':
      return 'MAX(mtime) DESC, album_artist COLLATE NOCASE, album COLLATE NOCASE';
    case 'plays':
      return 'SUM(play_count) DESC, MAX(last_played) DESC, album_artist COLLATE NOCASE, album COLLATE NOCASE';
    case 'duration':
      return 'duration DESC, album_artist COLLATE NOCASE, album COLLATE NOCASE';
    case 'tracks':
      return 'track_count DESC, duration DESC, album_artist COLLATE NOCASE, album COLLATE NOCASE';
    case 'random': {
      const seed = normalizeAlbumRandomSeed(randomSeed);
      // Three-term polynomial scramble. Two seeds that differ by ~1ms must
      // produce visibly different per-album orderings — the plain polynomial
      // used in earlier releases collapsed close `Date.now()` values that
      // happened to share a `% 991` / `% 7919` residue.
      //
      // Earlier 1.5.2 used a XOR mask, but SQLite has no XOR operator
      // (its bitwise set is `&`, `|`, `~`, `<<`, `>>`), so `MIN(id) ^ mask`
      // failed at parse time with `unrecognized token: "^"`. This version
      // sticks to `*`, `+`, `%` and bounds every intermediate term so the
      // product never overflows int64 even on libraries with huge MIN(id).
      //
      //   46337² = 2_147_114_569 < 2^31 → `(MIN(id) % 46337)²` < 2^31
      //   a < 32_749, b < 1_000_003, c < 2^31 → each term < 2^46 (safe in int64)
      //
      // Knuth multiplicative hash (2654435761 ≈ φ × 2^32) decorrelates
      // close seeds before deriving multipliers. `Math.imul` is the JS-safe
      // way to get a 32-bit multiplication; without it, large seeds overflow
      // JS's int53 ceiling and lose precision.
      const knuth = 2_654_435_761;
      const h1 = (Math.imul(seed, knuth) >>> 0) % 2_147_483_647;
      const h2 = (Math.imul(h1, knuth) >>> 0) % 2_147_483_647;
      const h3 = (Math.imul(h2, knuth) >>> 0) % 2_147_483_647;
      const a = 1 + (h1 % 32_749);     // prime near 2^15
      const b = 1 + (h2 % 1_000_003);  // prime near 10^6
      const c = h3;                    // 0..2^31-2
      return `ABS(
        ((MIN(id) % 46337) * (MIN(id) % 46337) * ${a}) % 2147483647
        + ((MIN(id) % 46337) * ${b}) % 2147483647
        + ${c}
      ) % 2147483647, MAX(id) % 9973, album_artist COLLATE NOCASE, album COLLATE NOCASE`;
    }
    case 'artist':
    default:
      return artistOrder;
  }
}

export function normalizeAlbumRandomSeed(seed: number | undefined): number {
  if (!Number.isFinite(seed)) return 1;
  // Mod, don't clamp. Date.now() is currently ~1.7e12 (≈ 2^40); the old
  // `Math.min(2_147_483_646, ...)` clamped every realistic seed to the
  // ceiling, so two calls 1ms apart hashed to the same normalized value
  // and the "random" sort was deterministic across the whole session.
  // Mod preserves the entropy of the low 31 bits.
  const truncated = Math.trunc(Math.abs(Number(seed)));
  return Math.max(1, truncated % 2_147_483_647);
}

function parseTrackSearchQuery(input: string): ParsedTrackSearch {
  const knownFields = new Set([
    'title',
    'artist',
    'album',
    'albumartist',
    'genre',
    'year',
    'format',
    'ext',
    'missing',
    'has',
    'quality',
    'codec',
    'replaygain',
    'rg',
    'loved',
    'avoid',
    'autoplay',
    'auto',
    'rating',
    'stars',
    'path',
    'tag',
    'untagged',
  ]);
  const tokens = tokenizeSearch(input);
  const terms: string[] = [];
  const filters: TrackSearchToken[] = [];

  for (const token of tokens) {
    const colon = token.indexOf(':');
    if (colon > 0) {
      const field = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1).trim();
      if (knownFields.has(field) && value) {
        filters.push({ field, value });
        continue;
      }
    }
    const term = token.trim();
    if (term) terms.push(term);
  }

  return { terms, filters };
}

function normalizeBookmarkLabel(label: string | null | undefined, position: number): string {
  const trimmed = label?.replace(/\s+/g, ' ').trim();
  return (trimmed || `Bookmark ${formatBookmarkPosition(position)}`).slice(0, 120);
}

function roundBookmarkPosition(position: number): number {
  const value = Number(position);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 100) / 100;
}

function formatBookmarkPosition(position: number): string {
  const seconds = Math.max(0, Math.floor(position));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function tokenizeSearch(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaping = false;

  for (const ch of input.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (quote && ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function trackSearchWhere(search: ParsedTrackSearch): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  for (const filter of search.filters) {
    applyTrackSearchFilter(filter, where, params);
  }

  for (const term of search.terms) {
    const q = likeParam(term);
    where.push(
      '(lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(album) LIKE ? OR lower(COALESCE(genre, "")) LIKE ? OR lower(path) LIKE ?)',
    );
    params.push(q, q, q, q, q);
  }

  return { where, params };
}

function applyTrackSearchFilter(
  filter: TrackSearchToken,
  where: string[],
  params: unknown[],
): void {
  const field = filter.field;
  const value = filter.value.trim();
  if (!field || !value) return;

  if (field === 'title') return pushTextFilter(where, params, 'title', value);
  if (field === 'artist') return pushTextFilter(where, params, 'artist', value);
  if (field === 'album') return pushTextFilter(where, params, 'album', value);
  if (field === 'albumartist') return pushTextFilter(where, params, 'album_artist', value);
  if (field === 'genre') return pushTextFilter(where, params, 'COALESCE(genre, "")', value);
  if (field === 'path') return pushTextFilter(where, params, 'path', value);
  if (field === 'format' || field === 'ext') {
    const ext = value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;
    where.push('lower(path) LIKE ?');
    params.push(`%${escapeLike(ext)}`);
    return;
  }
  if (field === 'quality' || field === 'codec') return pushQualityFilter(where, params, value);
  if (field === 'replaygain' || field === 'rg') return pushReplayGainFilter(where, value);
  if (field === 'year') return pushYearFilter(where, params, value);
  if (field === 'loved') {
    where.push(truthySearchValue(value) ? 'loved = 1' : 'loved = 0');
    return;
  }
  if (field === 'avoid' || field === 'autoplay' || field === 'auto') {
    where.push(truthySearchValue(value) ? 'avoid_auto_play = 1' : 'avoid_auto_play = 0');
    return;
  }
  if (field === 'rating' || field === 'stars') return pushRatingFilter(where, params, value);
  if (field === 'missing') return pushMissingFilter(where, value, false);
  if (field === 'has') return pushMissingFilter(where, value, true);
  if (field === 'tag') {
    where.push(`EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = tracks.id AND tt.tag_name = ?)`);
    params.push(value.toLowerCase());
    return;
  }
  if (field === 'untagged') {
    if (truthySearchValue(value)) {
      where.push(`NOT EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = tracks.id)`);
    } else {
      where.push(`EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = tracks.id)`);
    }
    return;
  }
}

function pushTextFilter(where: string[], params: unknown[], column: string, value: string): void {
  where.push(`lower(${column}) LIKE ?`);
  params.push(likeParam(value));
}

function pushYearFilter(where: string[], params: unknown[], value: string): void {
  const range = /^(\d{4})-(\d{4})$/.exec(value);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    where.push('year IS NOT NULL AND year BETWEEN ? AND ?');
    params.push(Math.min(min, max), Math.max(min, max));
    return;
  }

  const comparison = /^(>=|<=|>|<)(\d{4})$/.exec(value);
  if (comparison) {
    where.push(`year IS NOT NULL AND year ${comparison[1]} ?`);
    params.push(Number(comparison[2]));
    return;
  }

  const year = Number(value);
  if (Number.isFinite(year)) {
    where.push('year = ?');
    params.push(Math.trunc(year));
  }
}

function pushRatingFilter(where: string[], params: unknown[], value: string): void {
  const comparison = /^(>=|<=|>|<|=)?\s*([0-5](?:\.\d+)?)$/.exec(value);
  if (!comparison) return;
  const op = comparison[1] || '=';
  const rating = normalizeTrackRating(Number(comparison[2]));
  where.push(`rating ${op} ?`);
  params.push(rating);
}

function pushQualityFilter(where: string[], params: unknown[], value: string): void {
  const key = value.toLowerCase().replace(/[\s_]+/g, '-');
  if (key === 'lossless') return pushExtensionSetFilter(where, params, [...PCM_LOSSLESS_EXTENSIONS, ...DSD_EXTENSIONS]);
  if (key === 'lossy') return pushExtensionSetFilter(where, params, LOSSY_EXTENSIONS);
  if (key === 'dsd') return pushExtensionSetFilter(where, params, DSD_EXTENSIONS);
  if (key === 'fallback' || key === 'ffmpeg' || key === 'ffmpeg-fallback') {
    return pushExtensionSetFilter(where, params, FFMPEG_FALLBACK_EXTENSIONS);
  }
  if (key === 'low' || key === 'low-bitrate') {
    const extWhere = extensionSetSql(LOSSY_EXTENSIONS);
    where.push(`bitrate IS NOT NULL AND bitrate > 0 AND bitrate < 192000 AND ${extWhere.sql}`);
    params.push(...extWhere.params);
    return;
  }
  if (key === 'hires' || key === 'hi-res') {
    const dsdWhere = extensionSetSql(DSD_EXTENSIONS);
    const losslessWhere = extensionSetSql(PCM_LOSSLESS_EXTENSIONS);
    where.push(`(${dsdWhere.sql} OR (sample_rate IS NOT NULL AND sample_rate >= 88200 AND ${losslessWhere.sql}))`);
    params.push(...dsdWhere.params, ...losslessWhere.params);
    return;
  }
  if (key === 'unknown') {
    return pushExtensionSetFilter(
      where,
      params,
      [...PCM_LOSSLESS_EXTENSIONS, ...DSD_EXTENSIONS, ...LOSSY_EXTENSIONS, ...CONTAINER_AUDIO_EXTENSIONS],
      true,
    );
  }
}

function pushReplayGainFilter(where: string[], value: string): void {
  const key = value.toLowerCase();
  const ready = `(replaygain_track_db IS NOT NULL OR replaygain_album_db IS NOT NULL)`;
  if (/^(1|true|yes|ready|present|has|on)$/.test(key)) {
    where.push(ready);
    return;
  }
  if (/^(0|false|no|missing|none|off)$/.test(key)) {
    where.push(`NOT ${ready}`);
  }
}

function pushExtensionSetFilter(
  where: string[],
  params: unknown[],
  extensions: readonly string[],
  negate = false,
): void {
  const extWhere = extensionSetSql(extensions);
  where.push(negate ? `NOT (${extWhere.sql})` : extWhere.sql);
  params.push(...extWhere.params);
}

function extensionSetSql(extensions: readonly string[]): { sql: string; params: string[] } {
  const unique = [...new Set(extensions.map((ext) => ext.toLowerCase().replace(/^\./, '')))];
  return {
    sql: `(${unique.map(() => 'lower(path) LIKE ?').join(' OR ')})`,
    params: unique.map((ext) => `%.${escapeLike(ext)}`),
  };
}

function pushMissingFilter(where: string[], value: string, has: boolean): void {
  const key = value.toLowerCase();
  const clauses: Record<string, string> = {
    artist: `(trim(artist) = '' OR lower(trim(artist)) IN ('unknown artist', 'unknown'))`,
    album: `trim(album) = ''`,
    year: `year IS NULL`,
    art: `has_art = 0`,
    duration: `(duration IS NULL OR duration <= 0)`,
    genre: `(genre IS NULL OR trim(genre) = '')`,
    bpm: `bpm IS NULL`,
    key: `(key IS NULL OR trim(key) = '')`,
    replaygain: `(replaygain_track_db IS NULL AND replaygain_album_db IS NULL)`,
  };
  const clause = clauses[key];
  if (!clause) return;
  where.push(has ? `NOT (${clause})` : clause);
}

function truthySearchValue(value: string): boolean {
  return /^(1|true|yes|y|on|loved)$/i.test(value.trim());
}

function normalizeTrackRating(value: unknown): number {
  const rating = Math.round(Number(value));
  if (!Number.isFinite(rating)) return 0;
  return Math.max(0, Math.min(5, rating));
}

function normalizeTrackRatingScore(value: unknown): number | null {
  if (value == null) return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  // Quantize to one decimal place so SQLite never persists noisy floats.
  const clamped = Math.max(0, Math.min(100, score));
  return Math.round(clamped * 10) / 10;
}

function normalizeReplayGainDb(value: unknown): number | null {
  const db = Number(value);
  if (!Number.isFinite(db)) return null;
  return Math.max(-30, Math.min(30, Number(db.toFixed(2))));
}

function normalizeFileStatePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function uniqueNormalizedFolders(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeFolderPath(path);
    if (!normalized) continue;
    const key = folderKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function summarizeChildFolders(rows: FolderTrackRow[], parent: string): FolderSummary[] {
  const children = new Map<string, FolderSummaryAccumulator>();
  for (const row of rows) {
    const trackFolder = folderOfTrackPath(row.path);
    if (!trackFolder) continue;
    const child = immediateChildFolder(trackFolder, parent);
    if (!child) continue;

    const key = folderKey(child);
    let acc = children.get(key);
    if (!acc) {
      acc = {
        path: child,
        parentPath: parent,
        childFolderKeys: new Set(),
        trackCount: 0,
        totalTrackCount: 0,
        duration: 0,
        artFromTrackId: null,
      };
      children.set(key, acc);
    }

    acc.totalTrackCount += 1;
    acc.duration += Math.max(0, row.duration ?? 0);
    if (acc.artFromTrackId == null && row.has_art) acc.artFromTrackId = row.id;
    if (foldersEqual(trackFolder, child)) acc.trackCount += 1;
    const grandchild = immediateChildFolder(trackFolder, child);
    if (grandchild) acc.childFolderKeys.add(folderKey(grandchild));
  }
  return sortFolders([...children.values()].map(folderAccumulatorToSummary));
}

function summarizeFolder(rows: FolderTrackRow[], folderPath: string, parentPath: string | null): FolderSummary {
  const folder = normalizeFolderPath(folderPath) ?? folderPath;
  const childFolders = new Set<string>();
  let trackCount = 0;
  let totalTrackCount = 0;
  let duration = 0;
  let artFromTrackId: number | null = null;

  for (const row of rows) {
    const trackFolder = folderOfTrackPath(row.path);
    if (!trackFolder || !trackPathIsInFolder(row.path, folder, true)) continue;
    totalTrackCount += 1;
    duration += Math.max(0, row.duration ?? 0);
    if (artFromTrackId == null && row.has_art) artFromTrackId = row.id;
    if (foldersEqual(trackFolder, folder)) trackCount += 1;
    const child = immediateChildFolder(trackFolder, folder);
    if (child) childFolders.add(folderKey(child));
  }

  return {
    path: folder,
    name: folderDisplayName(folder),
    parentPath: normalizeFolderPath(parentPath),
    childFolderCount: childFolders.size,
    trackCount,
    totalTrackCount,
    duration,
    artFromTrackId,
  };
}

function folderAccumulatorToSummary(acc: FolderSummaryAccumulator): FolderSummary {
  return {
    path: acc.path,
    name: folderDisplayName(acc.path),
    parentPath: normalizeFolderPath(acc.parentPath),
    childFolderCount: acc.childFolderKeys.size,
    trackCount: acc.trackCount,
    totalTrackCount: acc.totalTrackCount,
    duration: acc.duration,
    artFromTrackId: acc.artFromTrackId,
  };
}

function deriveCatalogRoots(rows: FolderTrackRow[]): string[] {
  const roots = new Map<string, string>();
  for (const row of rows) {
    const root = catalogRootForTrackPath(row.path);
    if (root) roots.set(folderKey(root), root);
  }
  return [...roots.values()];
}

function catalogRootForTrackPath(path: string): string | null {
  const folder = folderOfTrackPath(path);
  if (!folder) return null;
  const compact = trimFolderTrailingSlash(folder);
  const drive = /^([A-Za-z]:)(?:\\(.+))?$/.exec(compact);
  if (drive) {
    const first = drive[2]?.split('\\').filter(Boolean)[0];
    return first ? `${drive[1]}\\${first}` : `${drive[1]}\\`;
  }
  const first = compact.split('\\').filter(Boolean)[0];
  return first || null;
}

function trackPathIsInFolder(path: string, folder: string, recursive: boolean): boolean {
  const trackFolder = folderOfTrackPath(path);
  if (!trackFolder) return false;
  if (foldersEqual(trackFolder, folder)) return true;
  return recursive && folderIsInside(trackFolder, folder);
}

function folderTrackPathPrefixParam(folder: string): string {
  return `${escapeFolderLikePattern(folderKey(folder))}\\%`;
}

function folderOfTrackPath(path: string): string | null {
  const normalized = normalizePathForFolder(path);
  const index = normalized.lastIndexOf('\\');
  if (index < 0) return null;
  const folder = normalized.slice(0, index);
  return normalizeFolderPath(folder);
}

function immediateChildFolder(trackFolderPath: string, parentFolderPath: string): string | null {
  const trackFolder = normalizeFolderPath(trackFolderPath);
  const parentFolder = normalizeFolderPath(parentFolderPath);
  if (!trackFolder || !parentFolder || foldersEqual(trackFolder, parentFolder)) return null;
  if (!folderIsInside(trackFolder, parentFolder)) return null;
  const parentCompact = trimFolderTrailingSlash(parentFolder);
  const childPrefix = parentCompact.endsWith('\\') ? parentCompact : `${parentCompact}\\`;
  const remainder = trimFolderTrailingSlash(trackFolder).slice(childPrefix.length);
  const childName = remainder.split('\\').filter(Boolean)[0];
  return childName ? joinFolderPath(parentCompact, childName) : null;
}

function folderIsInside(childFolderPath: string, parentFolderPath: string): boolean {
  const childKey = folderKey(childFolderPath);
  const parentKey = folderKey(parentFolderPath);
  return childKey.startsWith(`${parentKey}\\`);
}

function foldersEqual(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b);
}

function folderKey(path: string): string {
  return trimFolderTrailingSlash(normalizeFolderPath(path) ?? path).toLowerCase();
}

function normalizeFolderPath(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizePathForFolder(value).replace(/\\+$/g, '');
  if (!normalized) return null;
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  return normalized;
}

function normalizePathForFolder(value: string): string {
  return value.trim().replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
}

function trimFolderTrailingSlash(path: string): string {
  const normalized = normalizeFolderPath(path) ?? path;
  if (/^[A-Za-z]:\\$/.test(normalized)) return normalized.slice(0, -1);
  return normalized.replace(/\\+$/g, '');
}

function joinFolderPath(parent: string, childName: string): string {
  const compact = trimFolderTrailingSlash(parent);
  return /^[A-Za-z]:$/.test(compact) ? `${compact}\\${childName}` : `${compact}\\${childName}`;
}

function folderDisplayName(folderPath: string): string {
  const compact = trimFolderTrailingSlash(folderPath);
  if (/^[A-Za-z]:$/.test(compact)) return `${compact}\\`;
  return compact.split('\\').filter(Boolean).pop() ?? folderPath;
}

function sortFolders(folders: FolderSummary[]): FolderSummary[] {
  return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function likeParam(value: string): string {
  return `%${escapeLike(value.toLowerCase())}%`;
}

function escapeFolderLikePattern(value: string): string {
  return value.replace(/[|%_]/g, (ch) => `|${ch}`);
}

function summaryQueryLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 100000, 100000));
}

function summaryQueryOffset(value: number | undefined): number {
  return Math.max(0, value ?? 0);
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (ch) => `\\${ch}`);
}

function isUnknownArtistName(value: string): boolean {
  return !value.trim() || /^(unknown artist|unknown)$/i.test(value.trim());
}

function normalizeDuplicateText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s+remaster(?:ed)?(?:\s+\d{4})?/g, '')
    .trim();
}

function duplicateExactMatchCount(tracks: Array<Pick<Track, 'duration' | 'size'>>): number {
  const buckets = new Map<string, number>();
  for (const track of tracks) {
    const duration = track.duration == null || track.duration <= 0 ? null : Math.round(track.duration);
    const size = track.size == null || track.size <= 0 ? null : Math.round(track.size);
    if (duration == null || size == null) continue;
    const key = `${duration}:${size}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const max = Math.max(0, ...buckets.values());
  return max >= 2 ? max : 0;
}

function parsePlaylistPaths(content: string, baseDir?: string): string[] {
  if (/^\s*\[playlist\]/im.test(content) || /^\s*File\d+\s*=/im.test(content)) {
    return parsePlsPaths(content, baseDir);
  }
  return parseM3uPaths(content, baseDir);
}

function parseM3uPaths(content: string, baseDir?: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (!baseDir || isAbsolute(line) || /^[a-zA-Z]:[\\/]/.test(line)) return line;
      return resolvePath(baseDir, line);
    });
}

function parsePlsPaths(content: string, baseDir?: string): string[] {
  const entries: Array<{ index: number; path: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*File(\d+)\s*=\s*(.+?)\s*$/i);
    if (!match) continue;
    const index = Number(match[1]);
    const path = match[2]?.trim();
    if (!Number.isFinite(index) || !path) continue;
    entries.push({ index, path: resolvePlaylistPath(path, baseDir) });
  }
  return entries.sort((a, b) => a.index - b.index).map((entry) => entry.path);
}

function resolvePlaylistPath(path: string, baseDir?: string): string {
  if (!baseDir || isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return path;
  return resolvePath(baseDir, path);
}

function normalizeSmartRuleInput(input: SmartPlaylistRuleInput): Omit<SmartPlaylistRule, 'id' | 'createdAt' | 'updatedAt'> {
  const minYear = finiteNumber(input.minYear);
  const maxYear = finiteNumber(input.maxYear);
  const minBpm = finiteNumber(input.minBpm);
  const maxBpm = finiteNumber(input.maxBpm);
  const minRating = finiteNumber(input.minRating);
  return {
    name: normalizePlaylistName(input.name),
    mood: normalizeSmartMood(input.mood),
    count: Math.max(1, Math.min(200, Math.trunc(Number(input.count) || 30))),
    genreQuery: input.genreQuery?.replace(/\s+/g, ' ').trim() || null,
    searchQuery: input.searchQuery?.replace(/\s+/g, ' ').trim() || null,
    minYear: minYear == null ? null : Math.trunc(minYear),
    maxYear: maxYear == null ? null : Math.trunc(maxYear),
    minBpm,
    maxBpm,
    minRating: minRating == null ? null : normalizeTrackRating(minRating),
    lovedOnly: !!input.lovedOnly,
    unplayedOnly: !!input.unplayedOnly,
  };
}

function normalizeSuggestedGenre(value: string | null | undefined): string | null {
  const genre = (value ?? '')
    .replace(/[;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!genre || genre.length > 48 || /^\d+$/.test(genre)) return null;
  return genre;
}

function cleanSuggestedSearchText(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 96) return null;
  return text;
}

function moodForStationText(text: string): SmartPlaylistMood {
  const value = text.toLowerCase();
  if (/(ambient|classical|folk|acoustic|piano|instrumental|soul|jazz)/.test(value)) return 'focus';
  if (/(downtempo|dream|slow|night|chill|trip hop)/.test(value)) return 'night';
  if (/(punk|metal|hardcore|rock|dance|electronic|techno|house|hip hop|rap|funk)/.test(value)) return 'drive';
  return 'focus';
}

function slugId(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'station';
}

function smartRuleParams(rule: Omit<SmartPlaylistRule, 'id' | 'createdAt' | 'updatedAt'>): Array<string | number | null> {
  return [
    rule.name,
    rule.mood,
    rule.count,
    rule.genreQuery,
    rule.searchQuery,
    rule.minYear,
    rule.maxYear,
    rule.minBpm,
    rule.maxBpm,
    rule.minRating,
    rule.lovedOnly ? 1 : 0,
    rule.unplayedOnly ? 1 : 0,
  ];
}

function smartRuleWhere(rule: SmartPlaylistRule): { where: string; params: unknown[] } {
  const where: string[] = ['avoid_auto_play = 0'];
  const params: unknown[] = [];
  const genreWords = (rule.genreQuery ?? '')
    .split(/[,\s]+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);

  if (genreWords.length) {
    where.push(`(${genreWords.map(() => 'lower(COALESCE(genre, "")) LIKE ?').join(' OR ')})`);
    params.push(...genreWords.map((word) => `%${word}%`));
  }
  if (rule.searchQuery) {
    const searchWhere = trackSearchWhere(parseTrackSearchQuery(rule.searchQuery));
    where.push(...searchWhere.where);
    params.push(...searchWhere.params);
  }
  if (rule.minYear != null) {
    where.push('year IS NOT NULL AND year >= ?');
    params.push(rule.minYear);
  }
  if (rule.maxYear != null) {
    where.push('year IS NOT NULL AND year <= ?');
    params.push(rule.maxYear);
  }
  if (rule.minBpm != null) {
    where.push('bpm IS NOT NULL AND bpm >= ?');
    params.push(rule.minBpm);
  }
  if (rule.maxBpm != null) {
    where.push('bpm IS NOT NULL AND bpm <= ?');
    params.push(rule.maxBpm);
  }
  if (rule.minRating != null) {
    where.push('rating >= ?');
    params.push(rule.minRating);
  }
  if (rule.lovedOnly) where.push('loved = 1');
  if (rule.unplayedOnly) where.push('play_count = 0');

  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

interface TasteContext {
  seed: Track | null;
  artistAffinity: Map<string, number>;
  genreAffinity: Map<string, number>;
  /**
   * (albumArtist|album) -> rating_score (0..100). Lookup happens at
   * scoring time so highly-rated albums float their songs up in mixes —
   * essentially the "love the album, surface its songs" signal that was
   * missing while album rating overwrote track ratings.
   */
  albumRatingScores: Map<string, number>;
}

function buildTasteContext(
  tracks: Track[],
  seed: Track | null,
  albumRatingScores: Map<string, number>,
): TasteContext {
  const artistAffinity = new Map<string, number>();
  const genreAffinity = new Map<string, number>();
  for (const track of tracks) {
    const signal = tasteSignal(track);
    if (signal <= 0) continue;
    addTasteSignal(artistAffinity, normalizeTasteKey(track.artist), signal);
    for (const genre of genreTokens(track.genre)) addTasteSignal(genreAffinity, genre, signal);
  }
  return { seed, artistAffinity, genreAffinity, albumRatingScores };
}

/**
 * Album rating contribution to the per-track taste score. Capped at 2.0
 * so it nudges ordering without overpowering the per-song rating signal:
 *   - 100/100 album → +2.0
 *   - 75/100 album  → +1.5
 *   - 50/100 album  → +1.0
 *   - unrated       → +0.0
 * Linear is fine — non-linearity here would just amplify noise.
 */
function albumRatingBoost(track: Track, context: TasteContext): number {
  if (!track.album || !track.albumArtist) return 0;
  const score = context.albumRatingScores.get(albumKey(track.albumArtist, track.album));
  if (score == null) return 0;
  return Math.max(0, Math.min(2, (score / 100) * 2));
}

function scoreTasteTrack(track: Track, context: TasteContext): number {
  const loved = track.loved ? 8 : 0;
  const rating = (track.rating ?? 0) * 1.4;
  const played = Math.log10((track.playCount || 0) + 1) * 2.4;
  const discovery = track.playCount === 0 ? 1.8 : 0;
  const skipPenalty = tasteSkipPenalty(track);
  const artistAffinity = Math.min(5, (context.artistAffinity.get(normalizeTasteKey(track.artist)) ?? 0) * 0.22);
  const genreAffinity = Math.min(5, genreTokens(track.genre).reduce((sum, genre) => sum + (context.genreAffinity.get(genre) ?? 0), 0) * 0.14);
  const seedAffinity = scoreSeedAffinity(track, context.seed);
  const albumRating = albumRatingBoost(track, context);
  return loved + rating + played + discovery + artistAffinity + genreAffinity + seedAffinity + albumRating - skipPenalty;
}

function tasteSignal(track: Track): number {
  return Math.max(0, (track.loved ? 8 : 0) + (track.rating ?? 0) * 1.4 + Math.log10((track.playCount || 0) + 1) * 2 - tasteSkipPenalty(track));
}

function tasteSkipPenalty(track: Track): number {
  const skipped = Math.min(8, Math.log10((track.skipCount || 0) + 1) * 4);
  const freshSkip = track.lastSkipped && (!track.lastPlayed || track.lastSkipped >= track.lastPlayed) ? 2.5 : 0;
  return skipped + freshSkip;
}

function scoreSeedAffinity(track: Track, seed: Track | null): number {
  if (!seed) return 0;
  let score = 0;
  if (normalizeTasteKey(track.artist) && normalizeTasteKey(track.artist) === normalizeTasteKey(seed.artist)) score += 3;
  if (normalizeTasteKey(track.album) && normalizeTasteKey(track.album) === normalizeTasteKey(seed.album)) score += 1.2;
  const seedGenres = new Set(genreTokens(seed.genre));
  if (genreTokens(track.genre).some((genre) => seedGenres.has(genre))) score += 2;
  if (track.bpm && seed.bpm) score += Math.max(0, 1.5 - Math.abs(track.bpm - seed.bpm) / 16);
  return score;
}

function addTasteSignal(map: Map<string, number>, key: string, value: number): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + value);
}

function genreTokens(value: string | null): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[;,/|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeTasteKey(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function uniqueTracksById(tracks: Track[]): Track[] {
  const seen = new Set<number>();
  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
}

function isTasteMixCandidate(track: Track): boolean {
  return !track.avoidAutoPlay && !!track.path && (track.duration == null || track.duration > 20);
}

function normalizeMixCount(value: number | null | undefined): number {
  return Math.max(1, Math.min(200, Math.trunc(Number(value) || 30)));
}

function scoreSmartTrack(track: Track, rule: SmartPlaylistRule): number {
  const genre = (track.genre ?? '').toLowerCase();
  const bpm = track.bpm ?? 0;
  const loved = track.loved ? 1.4 : 0;
  const rating = (track.rating ?? 0) * 0.22;
  const played = Math.log10((track.playCount || 0) + 1);
  const skipped = Math.min(1.4, Math.log10((track.skipCount || 0) + 1) * 0.9);
  const fresh = track.playCount === 0 ? 1 : 0;
  const duration = track.duration ?? 0;

  if (rule.mood === 'drive') {
    return loved + rating + played + bpmBand(bpm, 105, 155) + genreMatch(genre, ['rock', 'metal', 'punk', 'dance', 'electronic']) - skipped;
  }
  if (rule.mood === 'night') {
    return loved + rating + bpmBand(bpm, 65, 112) + genreMatch(genre, ['ambient', 'jazz', 'soul', 'trip', 'downtempo', 'electronic']) - skipped;
  }
  if (rule.mood === 'deep-cuts') {
    return fresh * 2 + rating + (track.lastPlayed ? 0 : 0.8) + (track.loved ? 0.6 : 0) - played * 0.35 - skipped;
  }
  return loved + rating + bpmBand(bpm, 70, 130) + (duration > 120 ? 0.3 : 0) + genreMatch(genre, ['ambient', 'classical', 'jazz', 'instrumental', 'electronic']) - skipped;
}

function normalizeSmartMood(mood: string): SmartPlaylistMood {
  if (mood === 'drive' || mood === 'night' || mood === 'deep-cuts') return mood;
  return 'focus';
}

function bpmBand(bpm: number, min: number, max: number): number {
  if (!bpm) return 0.35;
  if (bpm >= min && bpm <= max) return 1.2;
  const center = (min + max) / 2;
  return Math.max(0, 1 - Math.abs(bpm - center) / center);
}

function genreMatch(genre: string, words: string[]): number {
  return words.some((word) => genre.includes(word)) ? 0.9 : 0;
}

function sortInsightBuckets<T extends { plays: number; duration: number; skips: number }>(a: T, b: T): number {
  return b.plays - a.plays || b.duration - a.duration || b.skips - a.skips;
}

function startOfLocalDay(value: number): number {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function wrappedWindow(range: WrappedRange, now: number): { start: number; end: number; label: string } {
  const d = new Date(now);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  switch (range) {
    case 'day':
      return { start: startOfLocalDay(now), end: now, label: 'Today' };
    case 'week':
      return { start: startOfLocalDay(now) - 6 * 86_400_000, end: now, label: 'This Week' };
    case 'month':
      return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: now, label: `${months[d.getMonth()]} ${d.getFullYear()}` };
    case 'year':
      return { start: new Date(d.getFullYear(), 0, 1).getTime(), end: now, label: `${d.getFullYear()}` };
    case 'all':
    default:
      return { start: 0, end: now, label: 'All Time' };
  }
}

function htmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrappedMoodLabel(energy: number, brightness: number): string {
  const e = energy >= 0.6 ? 'high' : energy >= 0.35 ? 'mid' : 'low';
  const b = brightness >= 0.6 ? 'bright' : brightness >= 0.35 ? 'warm' : 'dark';
  const table: Record<string, string> = {
    'high-bright': 'Bright & Energetic',
    'high-warm': 'Driving & Warm',
    'high-dark': 'Heavy & Dark',
    'mid-bright': 'Upbeat & Clear',
    'mid-warm': 'Easy Groove',
    'mid-dark': 'Moody Mid-tempo',
    'low-bright': 'Airy & Calm',
    'low-warm': 'Mellow & Warm',
    'low-dark': 'Late-night & Deep',
  };
  return table[`${e}-${b}`] ?? 'Eclectic';
}

function localDateKey(value: number): string {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function stableJitter(id: number): number {
  return ((Math.sin(id * 12.9898) * 43758.5453) % 1) * 0.001;
}

function finiteNumber(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanMetadataText(value: unknown, fallback: string): string {
  const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return cleaned.slice(0, 500) || fallback;
}

function cleanOptionalMetadataText(value: unknown): string | null {
  const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return cleaned ? cleaned.slice(0, 500) : null;
}

function normalizeLyricsText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 512 * 1024);
}

function finiteYear(value: number | null | undefined): number | null {
  const n = finiteNumber(value);
  return n != null && n >= 1877 && n <= 3000 ? Math.trunc(n) : null;
}

function finitePositiveInteger(value: number | null | undefined): number | null {
  const n = finiteNumber(value);
  return n != null && n > 0 ? Math.trunc(n) : null;
}

function finitePositiveNumber(value: number | null | undefined): number | null {
  const n = finiteNumber(value);
  return n != null && n > 0 ? n : null;
}

// Reference to avoid unused-import warnings in some build configs.
void statSync;
void createWriteStream;
void fsp;
void extname;
