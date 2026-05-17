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
  AlbumSummary,
  ArtistSummary,
  CatalogSummaryQueryOptions,
  CachedGuitarTab,
  CustomLyricsInput,
  FolderSummary,
  GuitarTabDocument,
  HarmonicMixInput,
  LibraryHealth,
  LibraryPruneMissingResult,
  ListeningHistoryItem,
  ListeningInsights,
  LocalLyricsResult,
  MetadataLookupCandidate,
  PlaylistM3uImportResult,
  SavedPlaylist,
  SavePlaylistInput,
  SaveTrackBookmarkInput,
  SmartPlaylistMood,
  SmartPlaylistRule,
  SmartPlaylistRuleInput,
  SmartPlaylistSuggestion,
  TasteMixInput,
  TrackQueryOptions,
  TrackMetadataPatchInput,
  TrackBookmark,
  Track,
  RecoveryEvent,
} from '../shared/types.js';
import { buildHarmonicMix as buildHarmonicMixSequence } from '../shared/harmonic-mix.js';
import { quarantineCorruptFile, recoveryReason } from './recovery.js';

const require = createRequire(import.meta.url);
const LEGACY_FORMATS = new Set([
  '.wma',
  '.aiff',
  '.aif',
  '.alac',
  '.dsf',
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
  size: number | null;
  mtime: number;
  has_art: number;
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
      this.ensureColumn('smart_rules', 'min_rating', 'INTEGER');
      this.ensureColumn('smart_rules', 'search_query', 'TEXT');
      this.ensureColumn('playlists', 'cover_art_path', 'TEXT');
      this.ensureColumn('playlists', 'cover_art_updated_at', 'INTEGER');
      this.db.exec('PRAGMA foreign_keys = ON');
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
      for (const r of items) {
        let artHash: string | null = null;
        if (r.art && r.art.data.length) {
          artHash = createHash('sha1').update(r.art.data).digest('hex');
          this.writeArtIfMissing(artHash, r.art);
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
      `SELECT id, path, title, artist, album, year, duration, size, mtime, has_art FROM tracks`,
    );
    const totals = this.getStats();
    const missing = {
      artist: 0,
      album: 0,
      year: 0,
      art: 0,
      duration: 0,
    };

    const duplicateMap = new Map<string, LibraryHealthRow[]>();
    const legacyMap = new Map<string, number>();
    for (const row of rows) {
      if (isUnknownArtistName(row.artist)) missing.artist += 1;
      if (!row.album.trim()) missing.album += 1;
      if (row.year == null) missing.year += 1;
      if (!row.has_art) missing.art += 1;
      if (row.duration == null || row.duration <= 0) missing.duration += 1;

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

  private getTracksByIdsInOrder(ids: number[]): Track[] {
    return ids
      .map((id) => this.getTrack(id))
      .filter((track): track is Track => !!track);
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

    if (search) {
      const q = likeParam(search);
      where.push(
        '(lower(album) LIKE ? OR lower(COALESCE(NULLIF(album_artist,\'\'), artist)) LIKE ? OR CAST(year AS TEXT) LIKE ?)',
      );
      params.push(q, q, q);
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
    const havingSql = having.length ? `HAVING ${having.join(' AND ')}` : '';

    const rows = this.many<{
      album: string;
      album_artist: string;
      year: number | null;
      track_count: number;
      duration: number;
      art_track: number | null;
    }>(
      `SELECT album,
              COALESCE(NULLIF(album_artist,''), artist) AS album_artist,
              MIN(year) AS year,
              COUNT(*) AS track_count,
              COALESCE(SUM(duration), 0) AS duration,
              MIN(CASE WHEN has_art = 1 THEN id ELSE NULL END) AS art_track
         FROM tracks t
        WHERE ${where.join(' AND ')}
        GROUP BY album, COALESCE(NULLIF(album_artist,''), artist)
        ${havingSql}
        ORDER BY album_artist COLLATE NOCASE, year, album COLLATE NOCASE
        LIMIT ? OFFSET ?`,
      [...params, ...havingParams, limit, offset],
    );
    return rows.map((r) => ({
      album: r.album,
      albumArtist: r.album_artist || 'Unknown Artist',
      year: r.year,
      trackCount: r.track_count,
      duration: r.duration,
      artFromTrackId: r.art_track,
    }));
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
    return this.queryFolderTrackRows(folderPath, opts).map((row) => row.id);
  }

  private queryFolderTrackRows(
    folderPath: string,
    opts: { recursive?: boolean; limit?: number; offset?: number } = {},
  ): RawRow[] {
    const folder = normalizeFolderPath(folderPath);
    if (!folder) return [];
    const recursive = !!opts.recursive;
    const limit = Math.max(1, Math.min(opts.limit ?? 100000, 100000));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.many<RawRow>(
      `SELECT * FROM tracks
        WHERE lower(replace(path, '/', '\\')) LIKE ?`,
      [folderTrackPathPrefixParam(folder)],
    )
      .filter((row) => trackPathIsInFolder(row.path, folder, recursive))
      .sort(compareFolderTracks)
      .slice(offset, offset + limit);
  }

  private getFolderTrackRows(): FolderTrackRow[] {
    return this.many<FolderTrackRow>(`SELECT id, path, duration, has_art FROM tracks`);
  }

  getAlbumTracks(album: string, albumArtist: string): Track[] {
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
      const sampleCount = this.runSmartPlaylistRule(rule).length;
      if (!sampleCount) return;
      suggestions.push({ id, title, subtitle, reason, sampleCount, rule });
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

  buildHarmonicMix(input: HarmonicMixInput = {}): Track[] {
    const where: string[] = ['path IS NOT NULL', 'avoid_auto_play = 0'];
    const params: unknown[] = [];
    const genreQuery = input.genreQuery?.trim();
    if (genreQuery) {
      where.push('genre IS NOT NULL AND lower(genre) LIKE ?');
      params.push(`%${genreQuery.toLowerCase()}%`);
    }
    const candidates = this.many<RawRow>(
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

    if (input.seedTrackId && !candidates.some((track) => track.id === input.seedTrackId)) {
      const seed = this.getTrack(input.seedTrackId);
      if (seed && !seed.avoidAutoPlay) candidates.unshift(seed);
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
    const context = buildTasteContext(unique, opener);
    const scored = unique
      .filter((track) => track.id !== opener?.id)
      .map((track) => ({
        track,
        score: scoreTasteTrack(track, context) + stableJitter(track.id),
      }))
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
    const row = this.one<{ art_hash: string | null }>(
      `SELECT art_hash FROM tracks WHERE id = ?`,
      [trackId],
    );
    if (!row || !row.art_hash) return null;
    // Find the file. We don't store mime in the DB, so probe common extensions.
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const p = join(this.artDir, `${row.art_hash}${ext}`);
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
    'loved',
    'avoid',
    'autoplay',
    'auto',
    'rating',
    'stars',
    'path',
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
  return `${folderKey(folder)}\\%`;
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

function compareFolderTracks(a: RawRow, b: RawRow): number {
  return (
    folderKey(a.path).localeCompare(folderKey(b.path), undefined, { numeric: true, sensitivity: 'base' }) ||
    (a.disc_no ?? 0) - (b.disc_no ?? 0) ||
    (a.track_no ?? 0) - (b.track_no ?? 0) ||
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
  );
}

function likeParam(value: string): string {
  return `%${escapeLike(value.toLowerCase())}%`;
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
}

function buildTasteContext(tracks: Track[], seed: Track | null): TasteContext {
  const artistAffinity = new Map<string, number>();
  const genreAffinity = new Map<string, number>();
  for (const track of tracks) {
    const signal = tasteSignal(track);
    if (signal <= 0) continue;
    addTasteSignal(artistAffinity, normalizeTasteKey(track.artist), signal);
    for (const genre of genreTokens(track.genre)) addTasteSignal(genreAffinity, genre, signal);
  }
  return { seed, artistAffinity, genreAffinity };
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
  return loved + rating + played + discovery + artistAffinity + genreAffinity + seedAffinity - skipPenalty;
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
