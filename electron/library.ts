// Library store backed by sql.js (pure WASM SQLite) plus filesystem-backed
// album art. We chose sql.js over better-sqlite3 because it removes the
// native compilation dependency, making NewAmp easier to install on any
// Node/Electron combination.

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, writeFileSync, statSync, createWriteStream, type Stats } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
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
  LibraryPruneMissingPreview,
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
  TrackMetadataField,
  TrackMetadataPatchInput,
  TrackBookmark,
  Track,
  RecoveryEvent,
} from '../shared/types.js';
import { albumKey } from '../shared/album-key.js';
import {
  ALBUM_IDENTITY_VERSION,
  SCAN_SCHEMA_VERSION,
  artistKeyOf,
  artistSortKey,
  containerFingerprint,
  keyForPair,
  provisionalIdentity,
  type AlbumKind,
  type TrackTagExtras,
} from '../shared/album-identity.js';
import {
  runRegroupAsync,
  runRegroupSync,
  type ArtistGroup,
  type RatingRemap,
  type RatingTarget,
  type RegroupHost,
  type RegroupResult,
  type RegroupRow,
  type RegroupWrite,
} from './album-identity.js';
import { dnaCosineSimilarity, isValidTrackDna, type TrackDna } from '../shared/audio-dna.js';
import { type VisualMemoryPlan, isValidVisualMemoryPlan, type VisualMemoryStats } from '../shared/visual-memory.js';
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
import {
  atomicWriteFileSync,
  durableWriteFileAsync,
  isTransientIoError,
  quarantineCorruptFile,
  recoveryReason,
  renameOverExistingSync,
} from './recovery.js';
import {
  normalizeHistoryImportPath,
  normalizeHistoryImportText,
  HISTORY_IMPORT_MAX_ENTRIES,
  type HistoryImportEntry,
  type HistoryImportIssue,
  type HistoryImportReport,
} from '../shared/history-import.js';

const SQLITE_HEADER = 'SQLite format 3\0';

// Thrown when the database file stays locked/unreadable after retries — a
// transient IO problem, deliberately NOT treated as corruption, so init()
// surfaces it instead of quarantining a healthy-but-busy file.
export class LibraryUnavailableError extends Error {}

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

// The tracks columns a whole-row read needs: what rowToTrack turns into a
// Track, and nothing else. `SELECT *` also read the folded search copies, the
// art hash, the analysis blob and the album grouping's text columns, none of
// which a track list uses, and decoding them was a good part of what a page of
// tracks cost. The album fields a track carries sit first among the columns
// added after the table first shipped (see ADDED_COLUMNS), so reading them does
// not mean walking past the rest of a row.
const TRACK_COLUMNS = [
  'id', 'path', 'title', 'artist', 'album', 'album_artist', 'track_no', 'disc_no', 'year', 'genre', 'duration',
  'bitrate', 'sample_rate', 'size', 'mtime', 'has_art', 'loved', 'rating', 'rating_score', 'avoid_auto_play',
  'play_count', 'last_played', 'skip_count', 'last_skipped', 'bpm', 'key', 'replaygain_track_db',
  'replaygain_album_db', 'missing_since', 'codec', 'codec_lossless', 'bits_per_sample', 'mb_recording_id',
  'album_key', 'disc_inferred', 'disc_total', 'disc_subtitle',
].join(', ');

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
  art_hash     TEXT,
  dna_json     TEXT,
  dna_analyzed_at INTEGER,
  -- Set when an automatic check found the file gone; cleared when the scanner
  -- sees it again. The row, its id and everything hanging off it are kept.
  missing_since INTEGER,
  -- fs.Stats.dev of the file when last scanned (see missingFileIsConfirmedGone).
  file_dev     INTEGER,
  -- What the file says about its own codec. NULL: no scan has read it yet (an
  -- .m4a with NULL is read again on the next scan). '': read, and it named none.
  codec        TEXT,
  codec_lossless INTEGER,
  bits_per_sample INTEGER,
  -- Set once a rating or play count embedded in the file has been considered
  -- for this row, so a rating cleared in NewAmp does not come back on a rescan.
  tag_stats_imported INTEGER NOT NULL DEFAULT 0,
  mb_recording_id TEXT,
  mb_release_id TEXT,
  mb_artist_id TEXT,
  isrc         TEXT,
  acoustid_id  TEXT,
  -- Search text with case, accents and compatibility forms folded (see
  -- foldSearchText). SQLite's lower() only folds A-Z, so lower(artist) never
  -- matched "bjork" against "Björk" or "ÓLAFUR" against "Ólafur".
  title_fold   TEXT NOT NULL DEFAULT '',
  artist_fold  TEXT NOT NULL DEFAULT '',
  album_fold   TEXT NOT NULL DEFAULT '',
  album_artist_fold TEXT NOT NULL DEFAULT '',
  genre_fold   TEXT NOT NULL DEFAULT '',
  -- What a track carries of its album, first so a track read stops here.
  -- album_key is what makes tracks one album (written by the grouping pass, see
  -- electron/album-identity.ts); the disc is the file's own count and name.
  -- artist_key is the artist with case, accents and spacing folded.
  album_key    TEXT,
  disc_inferred INTEGER,
  disc_total   INTEGER,
  disc_subtitle TEXT,
  artist_key   TEXT NOT NULL DEFAULT '',
  -- Tags the album grouping reads. album_artist keeps its old meaning (the tag,
  -- or the track artist when the file named none); album_artist_tag is what
  -- the file itself said, NULL when it said nothing. scan_schema is the tag
  -- set a row was last read with: 0 means these columns are not known yet.
  album_artist_tag TEXT,
  compilation  INTEGER NOT NULL DEFAULT 0,
  album_artist_sort TEXT,
  artist_sort  TEXT,
  track_total  INTEGER,
  mb_release_group_id TEXT,
  original_year INTEGER,
  artists_json TEXT,
  genres_json  TEXT,
  scan_schema  INTEGER NOT NULL DEFAULT 0,
  -- The rest of what the grouping pass writes: how the album is shown.
  album_display TEXT,
  album_artist_display TEXT,
  album_kind   TEXT NOT NULL DEFAULT 'album',
  album_reason TEXT,
  album_year   INTEGER,
  album_sort_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album_artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album_key ON tracks(album_key);
CREATE INDEX IF NOT EXISTS idx_tracks_artist_key ON tracks(artist_key);
CREATE INDEX IF NOT EXISTS idx_tracks_sort_names ON tracks(artist_key) WHERE artist_sort IS NOT NULL OR album_artist_sort IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_loved  ON tracks(loved);
CREATE INDEX IF NOT EXISTS idx_tracks_rating ON tracks(rating DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_avoid_auto_play ON tracks(avoid_auto_play);
CREATE INDEX IF NOT EXISTS idx_tracks_play   ON tracks(play_count DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_path_normalized ON tracks(lower(replace(path, '\\', '/')));
CREATE INDEX IF NOT EXISTS idx_tracks_missing ON tracks(missing_since) WHERE missing_since IS NOT NULL;

CREATE TABLE IF NOT EXISTS play_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    INTEGER NOT NULL,
  played_at   INTEGER NOT NULL,
  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_history_track ON play_history(track_id);
CREATE INDEX IF NOT EXISTS idx_play_history_track_played ON play_history(track_id, played_at);

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
  folder_path    TEXT,
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
-- individual songs independently. A rating belongs to an album by its key
-- (tracks.album_key): the grouping pass moves album_key when an album's tracks
-- regroup, so a rating follows its album, and two albums that share a title
-- and artist (a split folder, a generic title) keep separate ratings. Read by
-- key, newest row wins. The pair is the text the row was written under; it
-- only finds rows that have not been given a key yet (see
-- upgradeAlbumRatingsTable for the older shape, which was unique on the pair).
-- Note: SQLite NOCASE is ASCII-only — for non-ASCII album titles (e.g.,
-- "ÉLAN"), JS-side lookups using toLowerCase() will fold characters that SQL
-- NOCASE won't. Until the ICU extension is loaded, treat (artist, album)
-- lookups as best-effort case-folded for the ASCII alphabet only.
CREATE TABLE IF NOT EXISTS album_ratings (
  rating_id     INTEGER PRIMARY KEY,
  album_artist  TEXT NOT NULL COLLATE NOCASE,
  album         TEXT NOT NULL COLLATE NOCASE,
  rating        INTEGER NOT NULL DEFAULT 0,
  rating_score  REAL,
  updated_at    INTEGER NOT NULL,
  album_key     TEXT
);
CREATE INDEX IF NOT EXISTS idx_album_ratings_key ON album_ratings(album_key);
CREATE INDEX IF NOT EXISTS idx_album_ratings_pair ON album_ratings(album_artist, album);

-- Albums the user asked to see as separate albums. The fingerprint is the
-- album's folder plus its title (see containerFingerprint), so the choice
-- survives rescans and re-tags. source_key is the album key before the split,
-- which is what "group again" undoes.
CREATE TABLE IF NOT EXISTS album_overrides (
  fingerprint TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  source_key  TEXT NOT NULL DEFAULT '',
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_album_overrides_source ON album_overrides(source_key);

-- The Artists list, written whole by the grouping pass: one row per artist key
-- with the spelling shown, how it sorts and what it holds. Read in place of
-- grouping every track while nothing has changed since the pass.
CREATE TABLE IF NOT EXISTS artist_groups (
  artist_key  TEXT PRIMARY KEY,
  display     TEXT NOT NULL,
  sort_key    TEXT NOT NULL,
  track_count INTEGER NOT NULL,
  album_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artist_groups_sort ON artist_groups(sort_key, artist_key);

-- Per-track visual memory plan: the durable Eviland "remembers your library"
-- record. plan_json is the JSON-encoded VisualMemoryPlan (schema/algoVersion
-- live inside the blob and are also denormalized here for cheap stats queries
-- and bulk algoVersion-aware purges). ON DELETE CASCADE keeps the row tied to
-- the track row's lifetime; sql.js doesn't enforce FKs by default, so
-- pruneMissingTracks also DELETEs from this table explicitly.
CREATE TABLE IF NOT EXISTS track_visual_memory (
  track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  plan_json    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  algo_version INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- User-owned metadata. NewAmp never writes tags into music files, so an edit
-- (typed in, or accepted from a MusicBrainz lookup) exists only here. One row
-- per edited field, kept only while the user's value differs from the file's.
-- The tracks columns always hold the effective value, so every query, sort
-- and search sees the edit without joining this table; the scanner refreshes
-- source_json and leaves the column alone while a row exists.
-- value_json is the user's value (JSON null = deliberately cleared),
-- source_json what the file said at the last scan, which is what "reset to
-- file" restores. source_known is 0 while the file hasn't been read since the
-- override was made on a track still queued for adoption, whose column could
-- have held an old edit rather than the file's value. origin is 'manual',
-- 'musicbrainz' or 'adopted'.
CREATE TABLE IF NOT EXISTS track_metadata_overrides (
  track_id     INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  field        TEXT    NOT NULL,
  value_json   TEXT    NOT NULL,
  source_json  TEXT    NOT NULL,
  source_known INTEGER NOT NULL DEFAULT 1,
  origin       TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (track_id, field)
);

-- Tracks that predate track_metadata_overrides. Their columns may hold edits
-- that were never recorded as edits. The first time the scanner reads each
-- one, if the file is unchanged since it was last scanned, any editable field
-- that differs from it can only be an in-app edit (or parser drift) and
-- becomes an 'adopted' override; if the file changed, it was retagged outside
-- NewAmp and its tags win. The row goes either way.
CREATE TABLE IF NOT EXISTS track_metadata_adoption (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE
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

// Columns added to a table after it first shipped. applySchema adds whichever
// an existing library lacks BEFORE it runs SCHEMA, because SCHEMA's indexes
// can name them: a v1.0 library had no avoid_auto_play, creating its index
// first failed the open, and the library was quarantined as corrupt. Each
// entry must also be in SCHEMA's CREATE TABLE, which is where a new library
// gets it from.
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
  ['tracks', 'rating', 'INTEGER NOT NULL DEFAULT 0'],
  ['tracks', 'rating_score', 'REAL'],
  ['tracks', 'avoid_auto_play', 'INTEGER NOT NULL DEFAULT 0'],
  ['tracks', 'skip_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['tracks', 'last_skipped', 'INTEGER'],
  ['tracks', 'replaygain_track_db', 'REAL'],
  ['tracks', 'replaygain_album_db', 'REAL'],
  ['tracks', 'dna_json', 'TEXT'],
  ['tracks', 'dna_analyzed_at', 'INTEGER'],
  ['tracks', 'missing_since', 'INTEGER'],
  ['tracks', 'file_dev', 'INTEGER'],
  ['tracks', 'codec', 'TEXT'],
  ['tracks', 'codec_lossless', 'INTEGER'],
  ['tracks', 'bits_per_sample', 'INTEGER'],
  ['tracks', 'tag_stats_imported', 'INTEGER NOT NULL DEFAULT 0'],
  ['tracks', 'mb_recording_id', 'TEXT'],
  ['tracks', 'mb_release_id', 'TEXT'],
  ['tracks', 'mb_artist_id', 'TEXT'],
  ['tracks', 'isrc', 'TEXT'],
  ['tracks', 'acoustid_id', 'TEXT'],
  ['tracks', 'title_fold', `TEXT NOT NULL DEFAULT ''`],
  ['tracks', 'artist_fold', `TEXT NOT NULL DEFAULT ''`],
  ['tracks', 'album_fold', `TEXT NOT NULL DEFAULT ''`],
  ['tracks', 'album_artist_fold', `TEXT NOT NULL DEFAULT ''`],
  ['tracks', 'genre_fold', `TEXT NOT NULL DEFAULT ''`],
  // The four a track read needs come first; a row is decoded up to the last
  // column asked for, so the order is part of what a track list costs.
  ['tracks', 'album_key', 'TEXT'],
  ['tracks', 'disc_inferred', 'INTEGER'],
  ['tracks', 'disc_total', 'INTEGER'],
  ['tracks', 'disc_subtitle', 'TEXT'],
  ['tracks', 'artist_key', `TEXT NOT NULL DEFAULT ''`],
  ['tracks', 'album_artist_tag', 'TEXT'],
  ['tracks', 'compilation', 'INTEGER NOT NULL DEFAULT 0'],
  ['tracks', 'album_artist_sort', 'TEXT'],
  ['tracks', 'artist_sort', 'TEXT'],
  ['tracks', 'track_total', 'INTEGER'],
  ['tracks', 'mb_release_group_id', 'TEXT'],
  ['tracks', 'original_year', 'INTEGER'],
  ['tracks', 'artists_json', 'TEXT'],
  ['tracks', 'genres_json', 'TEXT'],
  ['tracks', 'scan_schema', 'INTEGER NOT NULL DEFAULT 0'],
  ['tracks', 'album_display', 'TEXT'],
  ['tracks', 'album_artist_display', 'TEXT'],
  ['tracks', 'album_kind', `TEXT NOT NULL DEFAULT 'album'`],
  ['tracks', 'album_reason', 'TEXT'],
  ['tracks', 'album_year', 'INTEGER'],
  ['tracks', 'album_sort_key', 'TEXT'],
  ['album_ratings', 'album_key', 'TEXT'],
  ['track_metadata_overrides', 'source_known', 'INTEGER NOT NULL DEFAULT 1'],
  ['smart_rules', 'min_rating', 'INTEGER'],
  ['smart_rules', 'search_query', 'TEXT'],
  ['smart_rules', 'folder_path', 'TEXT'],
  ['playlists', 'cover_art_path', 'TEXT'],
  ['playlists', 'cover_art_updated_at', 'INTEGER'],
];

// The editable metadata fields (TrackMetadataPatchInput keys) and the tracks
// column behind each. These are the fields track_metadata_overrides can own.
const METADATA_FIELD_COLUMNS: Readonly<Record<TrackMetadataField, keyof RawRow>> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumArtist: 'album_artist',
  genre: 'genre',
  year: 'year',
  trackNo: 'track_no',
  discNo: 'disc_no',
};
const METADATA_FIELDS = Object.keys(METADATA_FIELD_COLUMNS) as TrackMetadataField[];
// The folded search copy kept beside each editable text column.
const METADATA_FOLD_COLUMNS: Readonly<Partial<Record<TrackMetadataField, string>>> = {
  title: 'title_fold',
  artist: 'artist_fold',
  album: 'album_fold',
  albumArtist: 'album_artist_fold',
  genre: 'genre_fold',
};
// NOT NULL text columns store an empty string where the others store NULL.
const NOT_NULL_TEXT_FIELDS = new Set<TrackMetadataField>(['title', 'artist', 'album', 'albumArtist']);

type MetadataValue = string | number | null;
type MetadataOverrideOrigin = 'manual' | 'musicbrainz' | 'adopted';

interface MetadataOverrideRow {
  track_id: number;
  field: string;
  value_json: string;
  source_json: string;
  source_known: number;
}

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
  missing_since: number | null;
  file_dev: number | null;
  codec: string | null;
  codec_lossless: number | null;
  bits_per_sample: number | null;
  mb_recording_id: string | null;
  album_key?: string | null;
  disc_inferred?: number | null;
  disc_total?: number | null;
  disc_subtitle?: string | null;
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
  folder_path: string | null;
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
  // The path stat'ed when the target was normalized.
  exists: boolean;
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
    missingSince: r.missing_since ?? null,
    codec: r.codec || null,
    codecLossless: r.codec_lossless == null ? null : r.codec_lossless === 1,
    bitsPerSample: r.bits_per_sample ?? null,
    mbRecordingId: r.mb_recording_id ?? null,
    albumKey: r.album_key ?? null,
    discInferred: r.disc_inferred ?? null,
    discTotal: r.disc_total ?? null,
    discSubtitle: r.disc_subtitle ?? null,
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
    // Ask-mode runtime fields — not persisted for saved rules.
    notPlayedSinceMs: null,
    dnaEnergyTarget: null,
    dnaBrightnessTarget: null,
    folderPath: row.folder_path ?? null,
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
  // The file's device (fs.Stats.dev) as the scanner found it. Explicit
  // cleanup uses it to tell a deleted file from one on an unmounted drive.
  dev?: number | null;
  // The tags could not be read and the metadata fields are a filename guess.
  // A track the library already has keeps what it has (see upsertTracks).
  parseFailed?: boolean;
  // The file's own codec name ('' when it read fine but named none), its
  // lossless flag and bit depth. A reading that carries no codec leaves the
  // row's alone.
  codec?: string | null;
  codecLossless?: boolean | null;
  bitsPerSample?: number | null;
  // A rating embedded in the file (POPM, RATING, FMPS_RATING, iTunes rate) as
  // a 0..100 score, and a play count from its tags. They only seed a row that
  // has neither of its own (see upsertTracks).
  fileRatingScore?: number | null;
  filePlayCount?: number | null;
  mbRecordingId?: string | null;
  mbReleaseId?: string | null;
  mbArtistId?: string | null;
  isrc?: string | null;
  acoustidId?: string | null;
  // The tags the album grouping reads. Absent when the file would not parse,
  // or for a track that did not come from reading a file; the row keeps what
  // it has and stays queued for the tag backfill.
  tags?: TrackTagExtras;
}

/** One backfilled row: the tags a scan would have stored, for a row scanned before they were. */
export type TagBackfillRow = { id: number } & TrackTagExtras;

export interface TagBackfillCandidate {
  id: number;
  path: string;
  size: number | null;
  mtime: number;
}

export interface TrackFileState {
  id: number;
  path: string;
  size: number | null;
  mtime: number;
  hasArt: number;
  artHash: string | null;
  artExists: boolean;
  fileDev: number | null;
  // Null until a scan has read the file's codec (see tracks.codec).
  codec: string | null;
}

interface TrackFileStateRow {
  id: number;
  path: string;
  size: number | null;
  mtime: number;
  has_art: number;
  art_hash: string | null;
  file_dev: number | null;
  codec: string | null;
}

interface HistoryImportTrackRow {
  id: number;
  path: string;
  artist: string | null;
  title: string | null;
  album: string | null;
}

interface HistoryImportIndex {
  pathExact: Map<string, HistoryImportTrackRow[]>;
  pathNormalized: Map<string, HistoryImportTrackRow[]>;
  identity: Map<string, HistoryImportTrackRow[]>;
}

interface MatchedHistoryImportEntry {
  trackId: number;
  playedAt: number;
}

export class LibraryStore {
  public readonly recoveryEvents: RecoveryEvent[] = [];
  // Set when library.db is valid but this build could not upgrade it. The
  // file is left untouched and this session runs on a temporary library.
  public upgradeError: string | null = null;
  // Nothing may be written over library.db while upgradeError is set.
  private persistBlocked = false;
  private db!: Database;
  private SQL!: SqlJsStatic;
  private artDir: string;
  private playlistArtDir: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistTimerSlow = false;
  private dirty = false;
  // Guards the async (tmp+rename) flush path: at most one write in flight, with
  // a flag to re-run immediately after if more changes land while it's writing.
  private flushInFlight: Promise<void> | null = null;
  private flushAgain = false;
  // Bumped by every flush (sync or async) that captures a db.export() snapshot.
  // An in-flight async write checks this before its rename so a synchronous
  // quit-path flush (newer data) can never be clobbered by a slower async
  // write (older data) landing after it.
  private flushSeq = 0;
  private closed = false;
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
  private libraryHealthCache: LibraryHealth | null = null;
  // Windows only: every stored path, keyed by its case-folded form, so
  // upsertTracks finds a file's existing spelling without a query per file.
  // Built on first use, extended by upsertTracks, dropped by prune.
  private windowsPathIdentities: Map<string, string[]> | null = null;
  // getVisualMemoryStats() needs totalSections, which requires reading and
  // JSON.parsing every plan_json blob across track_visual_memory. For a 60k
  // library with ~5KB plans that's 150MB of string churn + JSON parsing on
  // the main process every time SettingsView opens (mounting useEffect calls
  // api.getVisualMemoryStats with no debounce). Cache the result; invalidate
  // on any visual-memory write/clear path. Same shape as libraryHealthCache /
  // dnaIndexCache. Null means "stale, recompute on next read".
  private visualMemoryStatsCache: VisualMemoryStats | null = null;
  // Album grouping (electron/album-identity.ts). The epoch moves whenever
  // something that can change which tracks form an album does, and a pass that
  // sees it move stops before it writes over newer data. `identityStale` is
  // "something changed since the last completed pass"; `identityUngrouped` is
  // "this library was opened with rows that have never been given a key".
  private groupingEpoch = 0;
  private identityStale = false;
  // The Artists list the last pass wrote no longer matches the tracks. Tags
  // read by the backfill make the albums stale without making it wrong, so the
  // list keeps being served from the table while the backfill runs.
  private artistListStale = false;
  private identityUngrouped = false;
  // Scans running. Their debounced passes wait for the scan, which runs one itself.
  private regroupHolds = 0;
  private identityPendingPersisted = false;
  private identityRun: Promise<RegroupResult | null> | null = null;
  private regroupTimer: NodeJS.Timeout | null = null;

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
    store.startInitialRegroup();
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
        this.db = await this.loadExistingDatabase();
      } catch (err) {
        if (err instanceof LibraryUnavailableError) throw err;
        const event = quarantineCorruptFile(this.file, 'library', recoveryReason(err));
        if (event) this.recoveryEvents.push(event);
        this.db = new this.SQL.Database();
        recovered = true;
      }
    } else {
      this.db = new this.SQL.Database();
    }
    const applySchema = () => {
      // One transaction, so an upgrade that fails part-way leaves the
      // database exactly as it was loaded.
      this.db.run('BEGIN');
      try {
        for (const [table, column, definition] of ADDED_COLUMNS) this.ensureColumn(table, column, definition);
        this.db.exec(SCHEMA);
        // One-shot DB migrations gated by flags in library_meta.
        this.runOneShotMigrations();
        this.db.run('COMMIT');
      } catch (err) {
        try {
          this.db.run('ROLLBACK');
        } catch {
          /* some failures end the transaction themselves */
        }
        throw err;
      }
      // A no-op inside a transaction.
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
      // The file passed its integrity check, so this is a bug in the upgrade,
      // not damage in the library. Quarantining it here used to hand the user
      // an empty library in place of their history, ratings and playlists.
      // Leave library.db byte-for-byte as it is, run this session on an
      // in-memory library that is never written anywhere, and try the upgrade
      // again on the next launch.
      const reason = recoveryReason(err);
      this.upgradeError = `NewAmp could not upgrade your library (${reason}). The library file was not changed: ${this.file}`;
      console.error(`[newamp] library upgrade failed; leaving ${this.file} untouched:`, err);
      this.recoveryEvents.push({
        store: 'library',
        filePath: this.file,
        backupPath: this.file,
        reason: `upgrade failed, file left untouched: ${reason}`,
        recoveredAt: Date.now(),
      });
      this.persistBlocked = true;
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.dirty = false;
      this.db = new this.SQL.Database();
      applySchema();
    }
    if (recovered) this.flushSync();
  }

  // Loads an existing database file. Transient IO failures (a locked file on
  // a network share, an antivirus or sync client holding it) are retried with
  // backoff and then surfaced as a LibraryUnavailableError — quarantining on
  // those silently reset whole libraries. Only genuine SQLite failures (bad
  // header, unparseable pages, failed integrity check) propagate to init()'s
  // quarantine path.
  private async loadExistingDatabase(): Promise<Database> {
    const attempts = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        const buf = readFileSync(this.file);
        // A non-SQLite header means a truncated/garbage file: real corruption.
        // An empty file is fine — SQLite treats it as a fresh database.
        if (buf.length > 0 && buf.subarray(0, SQLITE_HEADER.length).toString('latin1') !== SQLITE_HEADER) {
          throw new Error('database file header is corrupt (not a SQLite database)');
        }
        const db = new this.SQL.Database(buf);
        // Page-level corruption leaves the file header and the schema intact,
        // so neither the open above nor applySchema() below throws — it only
        // surfaces on the first real read, long after startup has committed to
        // this file. quick_check walks the btree pages (~50ms on a 60k-track
        // library) so a bad DB lands in the recovery path below instead of
        // taking down the main process mid-launch.
        const verdict = db.exec('PRAGMA quick_check')[0]?.values?.[0]?.[0];
        if (verdict !== 'ok') {
          const detail = String(verdict ?? 'no result').split('\n')[0]!.slice(0, 200);
          throw new Error(`database failed integrity check (${detail})`);
        }
        return db;
      } catch (err) {
        if (!isTransientIoError(err)) throw err;
        if (attempt >= attempts) {
          const code = (err as NodeJS.ErrnoException).code;
          throw new LibraryUnavailableError(
            `library database stayed ${code} after ${attempts} attempts — close other apps using it and restart NewAmp`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }

  // Immutable snapshot of the database exactly as it stands in memory right
  // now. Every mutation method runs against `this.db` synchronously — only
  // the write to library.db is batched (800ms, or 30s for the recordPlay/
  // recordSkip "slow" tier) — so this is always current regardless of what a
  // pending flush has or hasn't landed on disk yet. The support-backup
  // coordinator uses this instead of reading library.db off disk, which can
  // lag behind by up to that batching window.
  exportSnapshot(): Buffer {
    // After a failed upgrade the user's library is the untouched file, not
    // this session's temporary one.
    if (this.persistBlocked) return readFileSync(this.file);
    return Buffer.from(this.db.export());
  }

  // Waits out any async flush already in flight. A caller that is about to
  // replace library.db out from under this store (support-backup restore)
  // needs this before doing so: flushAsync's flushSeq check only stops a
  // stale write from starting its rename late — it can't stop one that was
  // already dispatched to the OS from racing a rename issued afterwards by
  // this process. Draining the in-flight write removes that race instead of
  // relying on the sequence check to win it.
  async waitForPendingWrites(): Promise<void> {
    while (this.flushInFlight) {
      await this.flushInFlight.catch(() => {});
    }
  }

  async flushPendingWrites(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistTimerSlow = false;
    }
    if (this.closed) {
      await this.waitForPendingWrites();
      return;
    }
    const hadInFlight = !!this.flushInFlight;
    if (this.dirty || this.flushInFlight) {
      this.flushSync();
    }
    await this.waitForPendingWrites();
    if (!this.closed && (this.dirty || hadInFlight)) this.flushSync();
  }

  close(): void {
    if (this.closed) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistTimerSlow = false;
    }
    if (this.regroupTimer) {
      clearTimeout(this.regroupTimer);
      this.regroupTimer = null;
    }
    if (this.dirty || this.flushInFlight) this.flushSync();
    this.closed = true;
    this.flushAgain = false;
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // recordPlay/recordSkip call this with `slow: true` — they fire on every
  // track change/skip, and a full db.export() + write on that cadence is real
  // main-thread cost. Every other mutation keeps the tight 800ms debounce.
  private scheduleFlush(opts?: { slow?: boolean }): void {
    if (this.closed || this.persistBlocked) return;
    this.dirty = true;
    const slow = !!opts?.slow;
    if (this.persistTimer) {
      // A fast-tier write arriving while a slow-tier flush is pending must not
      // sit behind the full 30s window — cancel and rearm at the fast delay.
      if (!slow && this.persistTimerSlow) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      } else {
        return;
      }
    }
    this.persistTimerSlow = slow;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistTimerSlow = false;
      void this.flushAsync();
    }, slow ? 30_000 : 800);
  }

  // Async atomic flush for the debounced path: db.export() is sql.js's only
  // API and stays synchronous, but the write itself goes through a tmp file +
  // rename so the (potentially multi-MB, 60k-track-library) serialization
  // doesn't block the main thread's event loop.
  private async flushAsync(): Promise<void> {
    if (this.closed || this.persistBlocked || !this.dirty) return;
    if (this.flushInFlight) {
      if (!this.closed) this.flushAgain = true;
      return;
    }
    this.dirty = false;
    const seq = ++this.flushSeq;
    const data = this.db.export();
    // Unique per flush: a quit-path flushSync must never share this path (see
    // atomicWriteFileSync) or its rename can adopt the inode this write is
    // still filling.
    const tmp = `${this.file}.tmp-${process.pid}-${seq}`;
    let tmpHasCompleteSnapshot = false;
    let tmpHandled = false;
    this.flushInFlight = (async () => {
      try {
        await durableWriteFileAsync(tmp, Buffer.from(data));
        tmpHasCompleteSnapshot = true;
        if (seq !== this.flushSeq || this.closed) {
          // A synchronous quit-path flush captured newer state while this
          // write was in flight — drop the stale copy instead of racing it.
          tmpHandled = true;
          await fsp.unlink(tmp).catch(() => {});
          return;
        }
        // Keep the final replace synchronous after the sequence/closed check:
        // there must be no await point where close() can write a newer
        // snapshot, close the DB, then let this stale rename land afterward.
        renameOverExistingSync(tmp, this.file);
        tmpHandled = true;
      } catch (err) {
        console.error('library flush failed', err);
        if (!this.closed) this.dirty = true; // retry on the next scheduled flush
      } finally {
        if (!tmpHandled && !tmpHasCompleteSnapshot) {
          await fsp.unlink(tmp).catch(() => {});
        }
      }
    })();
    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
      const shouldFlushAgain = this.flushAgain && !this.closed;
      this.flushAgain = false;
      if (shouldFlushAgain) {
        void this.flushAsync();
      }
    }
  }

  // Truly synchronous flush for the quit path (close()) — the process may
  // exit immediately after, so this cannot rely on an async write completing.
  // The write lands via tmp file + fsync + rename so a crash mid-write can
  // never leave a truncated library.db behind.
  private flushSync(): void {
    if (this.closed || this.persistBlocked) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistTimerSlow = false;
    }
    this.flushSeq += 1;
    atomicWriteFileSync(this.file, Buffer.from(this.db.export()));
    this.dirty = false;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.many<{ name: string }>(`PRAGMA table_info(${table})`);
    // No rows: the table doesn't exist yet, and SCHEMA creates it complete.
    if (!rows.length || rows.some((row) => row.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    this.scheduleFlush();
  }

  private pathIdentitiesForWindows(): Map<string, string[]> {
    if (!this.windowsPathIdentities) {
      const identities = new Map<string, string[]>();
      for (const row of this.many<{ path: string }>('SELECT path FROM tracks')) {
        const key = normalizeFileStatePath(row.path);
        const bucket = identities.get(key) ?? [];
        bucket.push(row.path);
        identities.set(key, bucket);
      }
      this.windowsPathIdentities = identities;
    }
    return this.windowsPathIdentities;
  }

  upsertTracks(items: IncomingTrack[]): void {
    if (!items.length) return;
    // One reading per path, the last one winning. Overlapping roots, a watcher
    // batch holding a folder and a file inside it, or a .cue dropped with its
    // audio all hand the same file over twice, and the ownership bookkeeping
    // below has to see each track once.
    const paths = new Map<string, string>();
    const normalized = items.map((item) => {
      if (process.platform !== 'win32') return item;
      const key = normalizeFileStatePath(item.path);
      let path = paths.get(key);
      if (!path) {
        // Two indexed queries per file still cost a statement round trip
        // through sql.js each, which was seconds for a 60k first scan; the map
        // answers in constant time. It folds the same way as key (Unicode
        // included, which SQLite's lower() doesn't).
        const matches = this.pathIdentitiesForWindows().get(key) ?? [];
        // The exact spelling wins. Otherwise adopt the one stored case variant;
        // do not merge pre-existing ambiguous identities without an explicit
        // migration. A unique filesystem spelling keeps all its annotations.
        path = matches.includes(item.path) ? item.path : matches.length === 1 ? matches[0]! : item.path;
        paths.set(key, path);
      }
      return path === item.path ? item : { ...item, path };
    });
    const unique = [...new Map(normalized.map((item) => [item.path, item])).values()];

    this.db.run('BEGIN');
    try {
      // Fields the user owns keep the user's value; for those the file's
      // reading only refreshes source_json.
      const rows = this.resolveOwnedMetadata(this.skipFailedRereads(unique));
      // Art applied through the UI (applyAlbumArtToAlbum) has no provenance
      // column, so a rescan can't distinguish it from embedded art — instead
      // any EXISTING art is kept whenever the rescanned file itself carries
      // none, rather than being overwritten with null. Duration likewise: a
      // MusicBrainz lookup fills it in when the file yields none, and a file
      // that still yields none must not erase it. Reading the file at all
      // proves it is there, so the missing mark goes.
      //
      // A rating or play count embedded in the file only seeds a row that has
      // none of its own (nothing rated, never played) and has not been seeded
      // before; whatever the user set in NewAmp wins, and a rating cleared
      // later stays cleared. tag_stats_imported is what remembers that.
      const stmt = this.db.prepare(
        `INSERT INTO tracks
         (path, title, artist, album, album_artist, track_no, disc_no, year, genre,
          duration, bitrate, sample_rate, bpm, key, replaygain_track_db, replaygain_album_db, size, mtime, has_art, art_hash,
          file_dev, codec, codec_lossless, bits_per_sample,
          mb_recording_id, mb_release_id, mb_artist_id, isrc, acoustid_id,
          title_fold, artist_fold, album_fold, album_artist_fold, genre_fold,
          rating, rating_score, play_count, tag_stats_imported,
          album_artist_tag, compilation, album_artist_sort, artist_sort, disc_total, track_total, disc_subtitle,
          mb_release_group_id, original_year, artists_json, genres_json, scan_schema,
          artist_key, album_key, album_display, album_artist_display, album_kind, album_reason, album_year,
          album_sort_key, disc_inferred)
         VALUES (${Array.from({ length: 59 }, () => '?').join(',')})
         ON CONFLICT(path) DO UPDATE SET
           title=excluded.title,
           artist=excluded.artist,
           album=excluded.album,
           album_artist=excluded.album_artist,
           track_no=excluded.track_no,
           disc_no=excluded.disc_no,
           year=excluded.year,
           genre=excluded.genre,
           duration=COALESCE(excluded.duration, tracks.duration),
           bitrate=excluded.bitrate,
           sample_rate=excluded.sample_rate,
           bpm=excluded.bpm,
           key=excluded.key,
           replaygain_track_db=excluded.replaygain_track_db,
           replaygain_album_db=excluded.replaygain_album_db,
           size=excluded.size,
           mtime=excluded.mtime,
           has_art=CASE WHEN excluded.art_hash IS NULL THEN tracks.has_art ELSE excluded.has_art END,
           art_hash=COALESCE(excluded.art_hash, tracks.art_hash),
           missing_since=NULL,
           file_dev=COALESCE(excluded.file_dev, tracks.file_dev),
           codec=COALESCE(excluded.codec, tracks.codec),
           codec_lossless=CASE WHEN excluded.codec IS NULL THEN tracks.codec_lossless ELSE excluded.codec_lossless END,
           bits_per_sample=CASE WHEN excluded.codec IS NULL THEN tracks.bits_per_sample ELSE excluded.bits_per_sample END,
           mb_recording_id=excluded.mb_recording_id,
           mb_release_id=excluded.mb_release_id,
           mb_artist_id=excluded.mb_artist_id,
           isrc=excluded.isrc,
           acoustid_id=excluded.acoustid_id,
           title_fold=excluded.title_fold,
           artist_fold=excluded.artist_fold,
           album_fold=excluded.album_fold,
           album_artist_fold=excluded.album_artist_fold,
           genre_fold=excluded.genre_fold,
           rating=CASE WHEN tracks.tag_stats_imported = 0 AND excluded.tag_stats_imported = 1
                         AND tracks.rating = 0 AND tracks.rating_score IS NULL
                       THEN excluded.rating ELSE tracks.rating END,
           rating_score=CASE WHEN tracks.tag_stats_imported = 0 AND excluded.tag_stats_imported = 1
                               AND tracks.rating = 0 AND tracks.rating_score IS NULL
                             THEN excluded.rating_score ELSE tracks.rating_score END,
           play_count=CASE WHEN tracks.tag_stats_imported = 0 AND excluded.tag_stats_imported = 1
                             AND tracks.play_count = 0 AND tracks.last_played IS NULL
                           THEN excluded.play_count ELSE tracks.play_count END,
           tag_stats_imported=MAX(tracks.tag_stats_imported, excluded.tag_stats_imported),
           artist_key=excluded.artist_key,
           album_artist_tag=CASE WHEN excluded.scan_schema > 0 THEN excluded.album_artist_tag ELSE tracks.album_artist_tag END,
           compilation=CASE WHEN excluded.scan_schema > 0 THEN excluded.compilation ELSE tracks.compilation END,
           album_artist_sort=CASE WHEN excluded.scan_schema > 0 THEN excluded.album_artist_sort ELSE tracks.album_artist_sort END,
           artist_sort=CASE WHEN excluded.scan_schema > 0 THEN excluded.artist_sort ELSE tracks.artist_sort END,
           disc_total=CASE WHEN excluded.scan_schema > 0 THEN excluded.disc_total ELSE tracks.disc_total END,
           track_total=CASE WHEN excluded.scan_schema > 0 THEN excluded.track_total ELSE tracks.track_total END,
           disc_subtitle=CASE WHEN excluded.scan_schema > 0 THEN excluded.disc_subtitle ELSE tracks.disc_subtitle END,
           mb_release_group_id=CASE WHEN excluded.scan_schema > 0 THEN excluded.mb_release_group_id ELSE tracks.mb_release_group_id END,
           original_year=CASE WHEN excluded.scan_schema > 0 THEN excluded.original_year ELSE tracks.original_year END,
           artists_json=CASE WHEN excluded.scan_schema > 0 THEN excluded.artists_json ELSE tracks.artists_json END,
           genres_json=CASE WHEN excluded.scan_schema > 0 THEN excluded.genres_json ELSE tracks.genres_json END,
           scan_schema=MAX(tracks.scan_schema, excluded.scan_schema)`,
      );
      // The grouping columns are left alone on an update: the grouping pass
      // owns them. A row whose album, album artist or artist changed gets the
      // plain grouping back below, until the pass runs again.
      const resetIdentity = this.db.prepare(
        `UPDATE tracks SET album_key=?, album_display=?, album_artist_display=?, album_kind=?, album_reason=?,
                album_year=?, album_sort_key=?, disc_inferred=? WHERE path=?`,
      );
      const priorRows = this.priorIdentityInputs(rows.map((r) => r.path));
      let groupingChanged = false;
      const artHashCache = new WeakMap<Buffer, string>();
      const writtenArtHashes = new Set<string>();
      for (const r of rows) {
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
        const seed = fileStatsSeed(r);
        const prior = priorRows.get(r.path);
        const tags = r.tags;
        const sorts = {
          albumArtistSort: tags ? tags.albumArtistSort : prior?.album_artist_sort ?? null,
          artistSort: tags ? tags.artistSort : prior?.artist_sort ?? null,
        };
        const identity = r.album.trim()
          ? provisionalIdentity({
              path: r.path,
              album: r.album,
              artist: r.artist,
              albumArtist: r.albumArtist,
              year: r.year,
              discNo: r.discNo,
              ...sorts,
            })
          : null;
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
          r.dev ?? null,
          r.codec ?? null,
          r.codecLossless == null ? null : r.codecLossless ? 1 : 0,
          r.bitsPerSample ?? null,
          r.mbRecordingId ?? null,
          r.mbReleaseId ?? null,
          r.mbArtistId ?? null,
          r.isrc ?? null,
          r.acoustidId ?? null,
          foldSearchText(r.title),
          foldSearchText(r.artist),
          foldSearchText(r.album),
          foldSearchText(r.albumArtist),
          foldSearchText(r.genre),
          seed.rating,
          seed.ratingScore,
          seed.playCount,
          seed.imported,
          tags ? tags.albumArtistTag : null,
          tags?.compilation ? 1 : 0,
          sorts.albumArtistSort,
          sorts.artistSort,
          tags?.discTotal ?? null,
          tags?.trackTotal ?? null,
          tags?.discSubtitle ?? null,
          tags?.mbReleaseGroupId ?? null,
          tags?.originalYear ?? null,
          tags?.artists ? JSON.stringify(tags.artists) : null,
          tags?.genres ? JSON.stringify(tags.genres) : null,
          tags ? SCAN_SCHEMA_VERSION : 0,
          artistKeyOf(r.artist),
          identity?.albumKey ?? null,
          identity?.albumDisplay ?? null,
          identity?.albumArtistDisplay ?? null,
          identity?.albumKind ?? 'album',
          identity?.albumReason ?? null,
          identity?.albumYear ?? null,
          identity?.albumSortKey ?? null,
          identity?.discInferred ?? null,
        ]);
        if (!prior || identityInputsChanged(prior, r)) groupingChanged = true;
        if (prior && (identityNeedsReset(prior, r) || (prior.album_key == null) !== !r.album.trim())) {
          resetIdentity.run([
            identity?.albumKey ?? null,
            identity?.albumDisplay ?? null,
            identity?.albumArtistDisplay ?? null,
            identity?.albumKind ?? 'album',
            identity?.albumReason ?? null,
            identity?.albumYear ?? null,
            identity?.albumSortKey ?? null,
            identity?.discInferred ?? null,
            r.path,
          ]);
        }
      }
      stmt.free();
      resetIdentity.free();
      this.db.run('COMMIT');
      if (groupingChanged) this.requestRegroup();
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    if (this.windowsPathIdentities) {
      for (const item of unique) {
        const key = normalizeFileStatePath(item.path);
        const bucket = this.windowsPathIdentities.get(key) ?? [];
        if (!bucket.includes(item.path)) bucket.push(item.path);
        this.windowsPathIdentities.set(key, bucket);
      }
    }
    // upsertTracks writes path/duration/has_art — cached folder-row columns.
    this.invalidateFolderTrackRowsCache();
    this.invalidateLibraryHealthCache();
    this.scheduleFlush();
  }

  // The plain grouping for one track whose album, artist or album artist was
  // just edited, so it lands in the right album at once; the grouping pass
  // refines it a moment later.
  private resetTrackIdentity(trackId: number): void {
    const row = this.one<{
      path: string;
      album: string;
      artist: string;
      album_artist: string;
      year: number | null;
      disc_no: number | null;
      album_artist_sort: string | null;
      artist_sort: string | null;
    }>(
      `SELECT path, album, artist, album_artist, year, disc_no, album_artist_sort, artist_sort FROM tracks WHERE id = ?`,
      [trackId],
    );
    if (!row) return;
    const identity = row.album.trim()
      ? provisionalIdentity({
          path: row.path,
          album: row.album,
          artist: row.artist,
          albumArtist: row.album_artist,
          year: row.year,
          discNo: row.disc_no,
          albumArtistSort: row.album_artist_sort,
          artistSort: row.artist_sort,
        })
      : null;
    this.db.run(
      `UPDATE tracks SET album_key=?, album_display=?, album_artist_display=?, album_kind=?, album_reason=?,
              album_year=?, album_sort_key=?, disc_inferred=? WHERE id=?`,
      [
        identity?.albumKey ?? null,
        identity?.albumDisplay ?? null,
        identity?.albumArtistDisplay ?? null,
        identity?.albumKind ?? 'album',
        identity?.albumReason ?? null,
        identity?.albumYear ?? null,
        identity?.albumSortKey ?? null,
        identity?.discInferred ?? null,
        trackId,
      ],
    );
  }

  private priorIdentityInputs(paths: string[]): Map<string, PriorIdentityRow> {
    const out = new Map<string, PriorIdentityRow>();
    const chunkSize = 500;
    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths.slice(i, i + chunkSize);
      const rows = this.many<PriorIdentityRow>(
        `SELECT path, album, artist, album_artist, album_artist_tag, compilation, disc_no, year,
                album_artist_sort, artist_sort, scan_schema, album_key
           FROM tracks WHERE path IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      );
      for (const row of rows) out.set(row.path, row);
    }
    return out;
  }

  // A reading whose tags failed to parse is a filename guess ("Unknown
  // Artist", title from the file name). For a track the library already has,
  // that guess must not replace its metadata, source values or adoption
  // state: only the missing mark goes, and size/mtime stay as they were so
  // the next scan tries the file again. A new file still gets its guessed row.
  private skipFailedRereads(items: IncomingTrack[]): IncomingTrack[] {
    const failed = items.filter((item) => item.parseFailed).map((item) => item.path);
    if (!failed.length) return items;
    const known = new Set<string>();
    const chunkSize = 500;
    for (let i = 0; i < failed.length; i += chunkSize) {
      const chunk = failed.slice(i, i + chunkSize);
      const rows = this.many<{ path: string }>(
        `SELECT path FROM tracks WHERE path IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      );
      for (const row of rows) known.add(row.path);
    }
    if (!known.size) return items;
    // codec '' marks the file as tried, so a container that never parses is
    // not read again on every scan just because its codec is still unknown.
    for (const path of known) {
      this.db.run(`UPDATE tracks SET missing_since = NULL, codec = COALESCE(codec, '') WHERE path = ?`, [path]);
    }
    return items.filter((item) => !(item.parseFailed && known.has(item.path)));
  }

  // Runs inside upsertTracks' transaction. Returns the rows to write: for each
  // already-known track, fields with an override carry the user's value (and
  // the override's source_json takes the file's). A track still queued for
  // adoption is settled first: if the file is unchanged since its last scan,
  // every field that really differs from it (not just a reading variant, see
  // isReadingVariant) becomes an override; if the file changed, it was
  // retagged and its tags win. Matching is on the exact path, as the upsert's
  // conflict is; callers pass each path once.
  private resolveOwnedMetadata(items: IncomingTrack[]): IncomingTrack[] {
    const anyOwned = this.one<{ n: number }>(
      `SELECT EXISTS (SELECT 1 FROM track_metadata_overrides)
           OR EXISTS (SELECT 1 FROM track_metadata_adoption) AS n`,
    );
    if (!anyOwned?.n) return items;

    const stored = new Map<string, RawRow & { adopt: number }>();
    const overrides = new Map<number, Map<TrackMetadataField, MetadataValue>>();
    const chunkSize = 500;
    for (let i = 0; i < items.length; i += chunkSize) {
      const paths = items.slice(i, i + chunkSize).map((item) => item.path);
      const placeholders = paths.map(() => '?').join(',');
      const rows = this.many<RawRow & { adopt: number }>(
        `SELECT t.id, t.path, t.title, t.artist, t.album, t.album_artist, t.genre, t.year, t.track_no, t.disc_no,
                t.size, t.mtime, a.track_id IS NOT NULL AS adopt
           FROM tracks t
           LEFT JOIN track_metadata_adoption a ON a.track_id = t.id
          WHERE t.path IN (${placeholders})
            AND (a.track_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM track_metadata_overrides o WHERE o.track_id = t.id))`,
        paths,
      );
      for (const row of rows) stored.set(row.path, row);
      if (!rows.length) continue;
      const ids = rows.map((row) => row.id);
      const overrideRows = this.many<MetadataOverrideRow>(
        `SELECT track_id, field, value_json, source_json, source_known FROM track_metadata_overrides
          WHERE track_id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      for (const row of overrideRows) {
        if (!isTrackMetadataField(row.field)) continue;
        const fields = overrides.get(row.track_id) ?? new Map<TrackMetadataField, MetadataValue>();
        fields.set(row.field, parseMetadataJson(row.field, row.value_json));
        overrides.set(row.track_id, fields);
      }
    }
    if (!stored.size) return items;

    const now = Date.now();
    return items.map((item) => {
      const row = stored.get(item.path);
      if (!row) return item;
      const owned = overrides.get(row.id) ?? new Map<TrackMetadataField, MetadataValue>();
      overrides.set(row.id, owned);
      // Only an unchanged file can show that a stored value was an edit: a
      // changed one was retagged (Picard, Mp3tag), and its new tags win. A row
      // that is itself a failed-parse guess holds no edits at all.
      const adopt = !!row.adopt
        && row.size === item.size
        && row.mtime === item.mtime
        && !isFallbackRow(row);
      for (const field of METADATA_FIELDS) {
        const fromFile = item[field] ?? null;
        if (owned.has(field)) {
          // An override only exists while the user's value differs from the
          // file's. Once the file says the same thing (retagged to match, or
          // an adopted value that was the file's all along), the field goes
          // back to following the file.
          if (sameMetadataValue(owned.get(field), fromFile)) {
            this.db.run(`DELETE FROM track_metadata_overrides WHERE track_id = ? AND field = ?`, [row.id, field]);
            owned.delete(field);
          } else {
            this.db.run(
              `UPDATE track_metadata_overrides SET source_json = ?, source_known = 1 WHERE track_id = ? AND field = ?`,
              [JSON.stringify(fromFile), row.id, field],
            );
          }
          continue;
        }
        if (!adopt) continue;
        const kept = (row[METADATA_FIELD_COLUMNS[field]] ?? null) as MetadataValue;
        // A reading variant isn't adopted either: the field takes the file's value.
        if (
          sameMetadataValue(kept, fromFile)
          || isReadingVariant(field, kept, fromFile)
          || isFallbackValue(field, kept, row.path)
        ) continue;
        this.db.run(
          `INSERT INTO track_metadata_overrides (track_id, field, value_json, source_json, source_known, origin, updated_at)
           VALUES (?, ?, ?, ?, 1, 'adopted', ?)
           ON CONFLICT(track_id, field) DO NOTHING`,
          [row.id, field, JSON.stringify(kept), JSON.stringify(fromFile), now],
        );
        owned.set(field, kept);
      }
      if (row.adopt) {
        this.db.run(`DELETE FROM track_metadata_adoption WHERE track_id = ?`, [row.id]);
        row.adopt = 0;
      }
      if (!owned.size) return item;
      const next: IncomingTrack = { ...item };
      for (const [field, value] of owned) assignMetadataValue(next, field, value);
      return next;
    });
  }

  // Owned-field bookkeeping shared by the manual editor and the MusicBrainz
  // rescue, inside their transaction. Only fields present in `next` whose
  // value actually changes are touched: a value that differs from the file
  // becomes (or updates) an override, and a value set back to exactly what
  // the file says drops the override, so the field follows the file again.
  private writeMetadataFields(
    trackId: number,
    current: Track,
    next: Partial<Record<TrackMetadataField, MetadataValue>>,
    origin: MetadataOverrideOrigin,
  ): void {
    const existing = new Map(
      this.many<MetadataOverrideRow>(
        `SELECT track_id, field, value_json, source_json, source_known FROM track_metadata_overrides WHERE track_id = ?`,
        [trackId],
      ).map((row) => [row.field, row]),
    );
    // A track still queued for adoption hasn't been read since edits became
    // tracked, so its columns may hold an old edit instead of the file's value.
    const columnIsFile = !this.one(`SELECT 1 FROM track_metadata_adoption WHERE track_id = ?`, [trackId]);
    const now = Date.now();
    const sets: string[] = [];
    const params: MetadataValue[] = [];
    for (const field of METADATA_FIELDS) {
      if (!(field in next)) continue;
      const value = next[field] ?? null;
      const currentValue = current[field] ?? null;
      if (sameMetadataValue(value, currentValue)) continue;
      const row = existing.get(field);
      const sourceKnown = row ? row.source_known === 1 : columnIsFile;
      const fromFile = row ? parseMetadataJson(field, row.source_json) : currentValue;
      if (sourceKnown && sameMetadataValue(value, fromFile)) {
        this.db.run(`DELETE FROM track_metadata_overrides WHERE track_id = ? AND field = ?`, [trackId, field]);
      } else {
        this.db.run(
          `INSERT INTO track_metadata_overrides (track_id, field, value_json, source_json, source_known, origin, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(track_id, field) DO UPDATE SET
             value_json = excluded.value_json,
             origin = excluded.origin,
             updated_at = excluded.updated_at`,
          [
            trackId,
            field,
            JSON.stringify(value),
            JSON.stringify(sourceKnown ? fromFile : null),
            sourceKnown ? 1 : 0,
            origin,
            now,
          ],
        );
      }
      sets.push(`${METADATA_FIELD_COLUMNS[field]} = ?`);
      params.push(metadataColumnValue(field, value));
      const foldColumn = METADATA_FOLD_COLUMNS[field];
      if (foldColumn) {
        sets.push(`${foldColumn} = ?`);
        params.push(foldSearchText(metadataColumnValue(field, value) as string | null));
      }
      if (field === 'artist') {
        sets.push('artist_key = ?');
        params.push(artistKeyOf(metadataColumnValue(field, value) as string | null));
      }
    }
    if (sets.length) this.db.run(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`, [...params, trackId]);
  }

  // One owned column written back from an override, with the folded copy
  // search reads kept beside it.
  private writeTrackMetadataColumn(trackId: number, field: TrackMetadataField, value: MetadataValue): void {
    const column = metadataColumnValue(field, value);
    const foldColumn = METADATA_FOLD_COLUMNS[field];
    if (field === 'artist') {
      this.db.run(`UPDATE tracks SET artist_key = ? WHERE id = ?`, [artistKeyOf(column as string | null), trackId]);
    }
    if (foldColumn) {
      this.db.run(`UPDATE tracks SET ${METADATA_FIELD_COLUMNS[field]} = ?, ${foldColumn} = ? WHERE id = ?`, [
        column,
        foldSearchText(column as string | null),
        trackId,
      ]);
    } else {
      this.db.run(`UPDATE tracks SET ${METADATA_FIELD_COLUMNS[field]} = ? WHERE id = ?`, [column, trackId]);
    }
  }

  // "Reset to file": the override goes and the column takes the value the
  // file had at the last scan. A field with no override already follows the
  // file and is left alone; one whose file value isn't known yet (see
  // source_known) stays as it is until the file has been read.
  private resetMetadataFields(trackId: number, fields: TrackMetadataField[]): void {
    for (const field of fields) {
      const row = this.one<MetadataOverrideRow>(
        `SELECT track_id, field, value_json, source_json, source_known FROM track_metadata_overrides
          WHERE track_id = ? AND field = ?`,
        [trackId, field],
      );
      if (!row || row.source_known !== 1) continue;
      this.writeTrackMetadataColumn(trackId, field, parseMetadataJson(field, row.source_json));
      this.db.run(`DELETE FROM track_metadata_overrides WHERE track_id = ? AND field = ?`, [trackId, field]);
    }
  }

  // The file behind a track that a metadata edit should read first: one still
  // queued for adoption, or holding an override whose file value is unknown.
  // Main reads it (readTrackFile) and upserts the reading before the edit, so
  // the edit and any reset work from what the file actually says.
  pathNeedingFileRead(trackId: number): string | null {
    const row = this.one<{ path: string }>(
      `SELECT t.path FROM tracks t
        WHERE t.id = ?
          AND (EXISTS (SELECT 1 FROM track_metadata_adoption a WHERE a.track_id = t.id)
               OR EXISTS (SELECT 1 FROM track_metadata_overrides o WHERE o.track_id = t.id AND o.source_known = 0))`,
      [Math.trunc(trackId)],
    );
    return row?.path ?? null;
  }

  // Library Health's "reset adopted edits". Adoption keeps any stored value
  // that really differs from an unchanged file, which can still pin a value
  // an older scanner read differently, or a retag that kept the file's size
  // and date; this hands every adopted field back to the file. Edits made in
  // NewAmp since the upgrade are 'manual' and stay.
  countAdoptedMetadataOverrides(): number {
    return this.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM track_metadata_overrides WHERE origin = 'adopted' AND source_known = 1`,
    )?.n ?? 0;
  }

  resetAdoptedMetadataOverrides(): number {
    const rows = this.many<MetadataOverrideRow>(
      `SELECT track_id, field, value_json, source_json, source_known FROM track_metadata_overrides
        WHERE origin = 'adopted' AND source_known = 1`,
    );
    if (!rows.length) return 0;
    this.db.run('BEGIN');
    try {
      for (const row of rows) {
        if (isTrackMetadataField(row.field)) {
          this.writeTrackMetadataColumn(row.track_id, row.field, parseMetadataJson(row.field, row.source_json));
        }
        this.db.run(`DELETE FROM track_metadata_overrides WHERE track_id = ? AND field = ?`, [row.track_id, row.field]);
      }
      for (const trackId of new Set(rows.map((row) => row.track_id))) this.resetTrackIdentity(trackId);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.invalidateLibraryHealthCache();
    this.requestRegroup(EDIT_REGROUP_DELAY_MS);
    this.scheduleFlush();
    return rows.length;
  }

  private getEditedFields(trackId: number): TrackMetadataField[] {
    const owned = new Set(
      this.many<{ field: string }>(`SELECT field FROM track_metadata_overrides WHERE track_id = ?`, [trackId]).map(
        (row) => row.field,
      ),
    );
    return METADATA_FIELDS.filter((field) => owned.has(field));
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
    // A library opened from an older version has no album keys until the first
    // grouping pass has run, and this is called from places that cannot wait
    // for it. Until then it counts the way the library did before keys, which
    // is close and costs no pass; the callers that show the numbers wait for the
    // pass first (see albumsReady) and get the exact ones.
    const a = this.identityUngrouped
      ? this.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM tracks WHERE album != '' GROUP BY COALESCE(NULLIF(album_artist,''), artist), album)`,
      )
      : this.one<{ n: number }>(`SELECT COUNT(DISTINCT album_key) AS n FROM tracks WHERE album != ''`);
    // The Artists list the grouping pass wrote has one row per artist; until
    // something changes, counting it is cheaper than grouping every track.
    const r = this.identityUngrouped
      ? this.one<{ n: number }>(`SELECT COUNT(DISTINCT artist) AS n FROM tracks WHERE artist != ''`)
      : !this.artistListStale
        ? this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM artist_groups`)
        : this.one<{ n: number }>(`SELECT COUNT(DISTINCT artist_key) AS n FROM tracks WHERE artist_key != ''`);
    const d = this.one<{ d: number }>(`SELECT COALESCE(SUM(duration), 0) AS d FROM tracks`);
    return { tracks: t?.n ?? 0, albums: a?.n ?? 0, artists: r?.n ?? 0, duration: d?.d ?? 0 };
  }

  /**
   * Full library metadata dump for export (JSON/CSV) — audit your tags, feed
   * a spreadsheet, or migrate players without losing listening data.
   * Everything the library knows per track EXCEPT internal caches (art
   * hashes, DNA vectors, visual memory).
   */
  exportTrackMetadata(): Array<{
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
    size: number | null;
    loved: number;
    rating: number;
    ratingScore: number | null;
    playCount: number;
    lastPlayed: number | null;
    skipCount: number;
    bpm: number | null;
    key: string | null;
    replaygainTrackDb: number | null;
    replaygainAlbumDb: number | null;
    codec: string | null;
    bitsPerSample: number | null;
    mbRecordingId: string | null;
    mbReleaseId: string | null;
    mbArtistId: string | null;
    isrc: string | null;
    acoustidId: string | null;
    // Semicolon-separated fields holding the user's value, not the file's.
    // The edits exist nowhere else, so an export has to say which they are.
    editedFields: string | null;
  }> {
    return this.many(
      `SELECT
         path, title, artist, album,
         album_artist AS albumArtist,
         track_no AS trackNo, disc_no AS discNo, year, genre,
         duration, bitrate, sample_rate AS sampleRate, size,
         loved, rating, rating_score AS ratingScore,
         play_count AS playCount, last_played AS lastPlayed,
         skip_count AS skipCount,
         bpm, key,
         replaygain_track_db AS replaygainTrackDb,
         replaygain_album_db AS replaygainAlbumDb,
         NULLIF(codec, '') AS codec, bits_per_sample AS bitsPerSample,
         mb_recording_id AS mbRecordingId, mb_release_id AS mbReleaseId, mb_artist_id AS mbArtistId,
         isrc, acoustid_id AS acoustidId,
         (SELECT group_concat(o.field, ';') FROM track_metadata_overrides o WHERE o.track_id = tracks.id) AS editedFields
       FROM tracks
       ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE`,
    );
  }

  getLibraryHealth(): LibraryHealth {
    if (this.libraryHealthCache) return this.libraryHealthCache;
    const rows = this.many<LibraryHealthRow>(
      `SELECT id, path, title, artist, album, year, duration, bitrate, sample_rate, size, mtime, has_art, replaygain_track_db, replaygain_album_db FROM tracks`,
    );
    // Only containers (.m4a, .mka) need their codec to be told lossless from
    // lossy, so only those rows are asked for it.
    const containerWhere = extensionSetSql(CONTAINER_AUDIO_EXTENSIONS);
    const containerCodecs = new Map(
      this.many<{ id: number; codec: string; codec_lossless: number | null; bits_per_sample: number | null }>(
        `SELECT id, codec, codec_lossless, bits_per_sample FROM tracks WHERE codec IS NOT NULL AND codec != '' AND ${containerWhere.sql}`,
        containerWhere.params,
      ).map((row) => [row.id, row] as const),
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

      const container = containerCodecs.get(row.id);
      const signal = classifyAudioQuality({
        path: row.path,
        bitrate: row.bitrate,
        sampleRate: row.sample_rate,
        duration: row.duration,
        size: row.size,
        replayGainTrackDb: row.replaygain_track_db,
        replayGainAlbumDb: row.replaygain_album_db,
        codec: container?.codec ?? null,
        codecLossless: container?.codec_lossless == null ? null : container.codec_lossless === 1,
        bitsPerSample: container?.bits_per_sample ?? null,
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

    // Offered for playing, so a track whose file is missing is left out.
    const recentlyAdded = this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks WHERE missing_since IS NULL
        ORDER BY mtime DESC, artist COLLATE NOCASE, title COLLATE NOCASE LIMIT 12`,
    ).map(rowToTrack);

    const health: LibraryHealth = {
      totals,
      missing,
      quality,
      duplicateGroups,
      legacyFormats,
      recentlyAdded,
      adoptedEdits: this.countAdoptedMetadataOverrides(),
      generatedAt: Date.now(),
    };
    this.libraryHealthCache = health;
    return health;
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
      `SELECT ${TRACK_COLUMNS} FROM tracks ${whereSql} ORDER BY ${sortKey} LIMIT ? OFFSET ?`,
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
    const row = this.one<RawRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`, [id]);
    if (!row) return null;
    return { ...rowToTrack(row), editedFields: this.getEditedFields(row.id) };
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
      const rows = this.many<RawRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id IN (${placeholders})`, chunk);
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
        `SELECT id, path, size, mtime, has_art, art_hash, file_dev, codec FROM tracks WHERE path IN (${placeholders})`,
        chunk,
      );
      for (const row of rows) out.set(row.path, this.rowToTrackFileState(row));
    }

    // A path the table doesn't hold in this exact spelling may be there in
    // another case or with other separators. That only exists where names
    // compare without case; elsewhere a miss is a new file, and answering it
    // used to cost a read of the whole table for every batch of a first scan.
    if (out.size < unique.length && foldPathCase('A') !== 'A') {
      const identities = this.pathIdentitiesForWindows();
      const requestedBy = new Map<string, string[]>();
      for (const path of unique) {
        if (out.has(path)) continue;
        const spellings = identities.get(normalizeFileStatePath(path));
        const stored = spellings?.[spellings.length - 1];
        if (!stored) continue;
        const requested = requestedBy.get(stored);
        if (requested) requested.push(path);
        else requestedBy.set(stored, [path]);
      }
      const storedPaths = [...requestedBy.keys()];
      for (let i = 0; i < storedPaths.length; i += chunkSize) {
        const chunk = storedPaths.slice(i, i + chunkSize);
        const rows = this.many<TrackFileStateRow>(
          `SELECT id, path, size, mtime, has_art, art_hash, file_dev, codec FROM tracks WHERE path IN (${chunk.map(() => '?').join(',')})`,
          chunk,
        );
        for (const row of rows) {
          for (const path of requestedBy.get(row.path) ?? []) {
            out.set(path, { ...this.rowToTrackFileState(row), path });
          }
        }
      }
    }

    return out;
  }

  private rowToTrackFileState(row: TrackFileStateRow): TrackFileState {
    return {
      id: row.id,
      path: row.path,
      size: row.size,
      mtime: row.mtime,
      hasArt: row.has_art ? 1 : 0,
      artHash: row.art_hash,
      artExists: row.art_hash ? this.artFileExists(row.art_hash) : false,
      fileDev: row.file_dev ?? null,
      codec: row.codec ?? null,
    };
  }

  // The scanner skips unchanged files without reading them, but still learns
  // their device; record it so explicit cleanup can judge them later.
  setTrackDevices(entries: Array<{ id: number; dev: number }>): void {
    if (!entries.length) return;
    this.db.run('BEGIN');
    try {
      for (const entry of entries) {
        this.db.run(`UPDATE tracks SET file_dev = ? WHERE id = ?`, [entry.dev, entry.id]);
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleFlush();
  }

  private artFileExists(hash: string): boolean {
    return ['.jpg', '.jpeg', '.png', '.webp'].some((ext) => existsSync(join(this.artDir, `${hash}${ext}`)));
  }

  // Automatic path (the library watcher): a file that has gone is marked, never
  // deleted. The row keeps its id, history, ratings, bookmarks, edits and
  // playlist places, and the scanner clears the mark when the file is back.
  // A target that is itself gone answers for everything under it without a
  // stat per file: when a network share drops, the watcher hands over its
  // root, and tens of thousands of stats on a dead SMB path would hang the
  // main process. Returns how many tracks were newly marked.
  markTracksMissing(targets: string[]): number {
    const normalizedTargets = normalizePruneTargets(targets);
    if (!normalizedTargets.length) return 0;
    const all = indexPruneTargets(normalizedTargets);
    const gone = indexPruneTargets(normalizedTargets.filter((target) => !target.exists));
    const ids: number[] = [];
    const toCheck: Array<{ id: number; path: string }> = [];
    for (const row of this.many<{ id: number; path: string }>(`SELECT id, path FROM tracks WHERE missing_since IS NULL`)) {
      if (!matchesPruneTargets(row.path, all)) continue;
      if (matchesPruneTargets(row.path, gone)) ids.push(row.id);
      else toCheck.push(row);
    }
    ids.push(...absentTrackIds(toCheck));
    if (!ids.length) return 0;
    this.setMissingSince(ids, Date.now());
    return ids.length;
  }

  // After a scan has walked these roots to the end: tracks under them that
  // the walk didn't find, and whose file isn't there, are marked missing —
  // never deleted. A file deleted while NewAmp was closed has no watcher
  // event, so without this it stayed undimmed and Auto DJ, mixes and smart
  // rules kept queueing it. Folders the walk couldn't list are left alone:
  // not finding a file there proves nothing. A root that has gone since the
  // walk marks nothing. Returns how many tracks were newly marked.
  markUnfoundTracksMissing(walkedRoots: string[], found: string[], unreadableFolders: string[] = []): number {
    // A file handed over as a root (the watcher's rescan of one changed
    // file) has nothing under it, and it was found, so it can't add anything.
    const roots = normalizePruneTargets(walkedRoots).filter((root) => root.exists && root.kind === 'dir');
    if (!roots.length) return 0;
    const rootIndex = indexPruneTargets(roots);
    const unread = indexPruneTargets(normalizePruneTargets(unreadableFolders));
    const foundKeys = new Set(found.map(normalizeFileStatePath));
    const candidates = this.many<{ id: number; path: string }>(`SELECT id, path FROM tracks WHERE missing_since IS NULL`)
      .filter((row) =>
        !foundKeys.has(normalizeFileStatePath(row.path))
        && matchesPruneTargets(row.path, rootIndex)
        && !matchesPruneTargets(row.path, unread));
    const ids = absentTrackIds(candidates);
    if (!ids.length) return 0;
    this.setMissingSince(ids, Date.now());
    return ids.length;
  }

  // The scanner found these files, so any of them marked missing are back.
  // Same exact-then-normalized path matching as getTrackFileStates, so a file
  // the scanner skips as unchanged is still recognized.
  markTracksPresent(paths: string[]): number {
    const missing = this.many<{ id: number; path: string }>(
      `SELECT id, path FROM tracks WHERE missing_since IS NOT NULL`,
    );
    if (!missing.length) return 0;
    const exact = new Map(missing.map((row) => [row.path, row.id]));
    const normalized = new Map(missing.map((row) => [normalizeFileStatePath(row.path), row.id]));
    const ids = new Set<number>();
    for (const path of paths) {
      const id = exact.get(path) ?? normalized.get(normalizeFileStatePath(path));
      if (id != null) ids.add(id);
    }
    if (!ids.size) return 0;
    this.setMissingSince([...ids], null);
    return ids.size;
  }

  private setMissingSince(ids: number[], value: number | null): void {
    const chunkSize = 500;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      this.db.run(
        `UPDATE tracks SET missing_since = ? WHERE id IN (${chunk.map(() => '?').join(',')})`,
        [value, ...chunk],
      );
    }
    // Health's recently-added list leaves missing tracks out.
    this.invalidateLibraryHealthCache();
    this.scheduleFlush();
  }

  // What "Clean missing files" would delete, without deleting it: the renderer
  // shows these counts and asks before anything goes.
  previewPruneMissingTracks(targets?: string[], roots: string[] = []): LibraryPruneMissingPreview {
    const { checked, ids, offline } = this.collectPrunableTracks(targets, roots);
    const count = (table: string): number => {
      let total = 0;
      const chunkSize = 500;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        total += this.one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE track_id IN (${chunk.map(() => '?').join(',')})`,
          chunk,
        )?.n ?? 0;
      }
      return total;
    };
    return {
      checked,
      tracks: ids.length,
      offline,
      plays: count('play_history'),
      skips: count('skip_history'),
      playlistEntries: count('playlist_tracks'),
      bookmarks: count('track_bookmarks'),
      edits: count('track_metadata_overrides'),
    };
  }

  // Missing tracks whose deletion is proven (see missingFileIsConfirmedGone);
  // the rest of the missing ones are counted as offline.
  private collectPrunableTracks(
    targets: string[] | undefined,
    roots: string[],
  ): { checked: number; ids: number[]; offline: number } {
    const tracks = this.many<{ id: number; path: string; file_dev: number | null }>(
      `SELECT id, path, file_dev FROM tracks`,
    );
    const normalizedTargets = indexPruneTargets(normalizePruneTargets(targets));
    const candidates = normalizedTargets.size
      ? tracks.filter((track) => matchesPruneTargets(track.path, normalizedTargets))
      : tracks;
    const probes = new Map<string, DirectoryProbe | null>();
    const ids: number[] = [];
    let offline = 0;
    for (const track of candidates) {
      if (existsSync(track.path)) continue;
      if (missingFileIsConfirmedGone({ path: track.path, fileDev: track.file_dev ?? null }, roots, probes)) {
        ids.push(track.id);
      } else {
        offline += 1;
      }
    }
    return { checked: candidates.length, ids, offline };
  }

  // Destructive, and only ever run by an explicit user action (Library
  // Health's "Clean missing files", after its preview and a backup). A
  // missing file whose storage can't be reached is kept and counted as
  // offline: an unplugged drive must not erase the history of everything on
  // it.
  pruneMissingTracks(targets?: string[], roots: string[] = []): LibraryPruneMissingResult {
    const { checked, ids: missingIds, offline } = this.collectPrunableTracks(targets, roots);
    if (!missingIds.length) return { checked, removed: 0, offline };
    const removedIds = this.removeTracksById(missingIds);
    return { checked, removed: removedIds.length, removedIds, offline };
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

    this.db.run('BEGIN');
    try {
      // The accepted match is the user's choice, so it is owned like a manual
      // edit and a rescan can't revert it.
      this.writeMetadataFields(id, current, { title, artist, album, albumArtist, trackNo, discNo, year }, 'musicbrainz');
      this.resetTrackIdentity(id);
      // Duration is a measurement, not an edit: the lookup only fills a gap,
      // and upsertTracks keeps it for as long as the file yields none.
      if (duration !== current.duration) {
        this.db.run(`UPDATE tracks SET duration = ? WHERE id = ?`, [duration, id]);
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    // duration is one of the cached folder-row columns.
    this.invalidateFolderTrackRowsCache();
    this.invalidateLibraryHealthCache();
    this.requestRegroup(EDIT_REGROUP_DELAY_MS);
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
    const next: Partial<Record<TrackMetadataField, MetadataValue>> = {
      title,
      artist,
      album,
      albumArtist,
      genre,
      year,
      trackNo,
      discNo,
    };
    // A field being reset takes the file's value, whatever else the patch says.
    const reset = Array.isArray(patch.resetToFile) ? patch.resetToFile.filter(isTrackMetadataField) : [];
    for (const field of reset) delete next[field];

    this.db.run('BEGIN');
    try {
      this.resetMetadataFields(id, reset);
      this.writeMetadataFields(id, current, next, 'manual');
      this.resetTrackIdentity(id);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    // artist/album/year feed getLibraryHealth's missing-metadata + duplicate
    // detection — a manual edit must not leave the health card stale.
    this.invalidateLibraryHealthCache();
    this.requestRegroup(EDIT_REGROUP_DELAY_MS);
    this.scheduleFlush();
    return this.getTrack(id);
  }

  // The albums the grid shows. An album is a group of tracks sharing album_key
  // (see shared/album-identity.ts); every field the grid shows is stored on its
  // tracks by the grouping pass, so the group only has to pick one of them.
  getAlbums(opts: CatalogSummaryQueryOptions = {}): AlbumSummary[] {
    this.ensureIdentityKeys();
    const search = String(opts.search ?? '').trim();
    const limit = summaryQueryLimit(opts.limit);
    const offset = summaryQueryOffset(opts.offset);
    const where = ['album_key IS NOT NULL', 'album != \'\''];
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
      const q = foldedLikeParam(search);
      // A compilation matches on any artist on it, and on "various artists".
      matchSelect = `,
              MAX(CASE WHEN album_fold LIKE ? ESCAPE '|' OR COALESCE(NULLIF(album_artist_fold,''), artist_fold) LIKE ? ESCAPE '|' OR artist_fold LIKE ? ESCAPE '|' OR (album_kind = 'compilation' AND 'various artists' LIKE ? ESCAPE '|') OR CAST(year AS TEXT) LIKE ? ESCAPE '|' THEN 1 ELSE 0 END) AS matched_meta,
              MAX(CASE WHEN title_fold LIKE ? ESCAPE '|' THEN 1 ELSE 0 END) AS matched_track,
              GROUP_CONCAT(CASE WHEN title_fold LIKE ? ESCAPE '|' THEN title ELSE NULL END, char(31)) AS matched_titles`;
      matchSelectParams.push(q, q, q, q, q, q, q);
      having.push('(matched_meta = 1 OR matched_track = 1)');
    }
    const excludeKeys = new Set<string>();
    if (typeof opts.excludeAlbumKey === 'string' && opts.excludeAlbumKey) excludeKeys.add(opts.excludeAlbumKey);
    if (typeof opts.excludeAlbum === 'string' && opts.excludeAlbum.trim()) {
      const excludeAlbum = opts.excludeAlbum.trim();
      const excludeAlbumArtist = String(opts.excludeAlbumArtist ?? '').trim();
      if (excludeAlbumArtist) {
        for (const key of this.resolveAlbumKeys(excludeAlbumArtist, excludeAlbum)) excludeKeys.add(key);
      } else {
        where.push('album != ?');
        params.push(excludeAlbum);
      }
    }
    if (excludeKeys.size) {
      where.push(`album_key NOT IN (${[...excludeKeys].map(() => '?').join(',')})`);
      params.push(...excludeKeys);
    }
    if (Number.isFinite(opts.year)) {
      const year = Math.trunc(Number(opts.year));
      const yearWindow = Math.max(0, Math.min(Math.trunc(Number(opts.yearWindow ?? 0)), 10));
      having.push('MAX(album_year) IS NOT NULL AND ABS(MAX(album_year) - ?) <= ?');
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
    // unqualified columns, which became ambiguous once both tables carried
    // them. Run the aggregation query unchanged and merge album ratings in via
    // a single bulk lookup. Same number of round-trips, no JOIN fragility.
    const rows = this.many<AlbumGroupRow>(
      `SELECT album_key,
              MAX(album_display) AS album,
              MAX(album_artist_display) AS album_artist,
              MAX(album_kind) AS album_kind,
              MAX(album_reason) AS album_reason,
              MAX(album_year) AS year,
              MAX(album_sort_key) AS sort_artist,
              COUNT(*) AS track_count,
              COALESCE(SUM(duration), 0) AS duration,
              MIN(CASE WHEN has_art = 1 THEN id ELSE NULL END) AS art_track${matchSelect}
         FROM tracks
        WHERE ${where.join(' AND ')}
        GROUP BY album_key
        ${havingSql}
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?`,
      [...matchSelectParams, ...params, ...havingParams, limit, offset],
    );
    return this.albumSummariesFromRows(rows, Boolean(search));
  }

  // One album by key, the way the grid would list it.
  getAlbumSummary(key: string): AlbumSummary | null {
    this.ensureIdentityKeys();
    const albumKeyValue = String(key ?? '').trim();
    if (!albumKeyValue) return null;
    const rows = this.many<AlbumGroupRow>(
      `SELECT album_key,
              MAX(album_display) AS album,
              MAX(album_artist_display) AS album_artist,
              MAX(album_kind) AS album_kind,
              MAX(album_reason) AS album_reason,
              MAX(album_year) AS year,
              MAX(album_sort_key) AS sort_artist,
              COUNT(*) AS track_count,
              COALESCE(SUM(duration), 0) AS duration,
              MIN(CASE WHEN has_art = 1 THEN id ELSE NULL END) AS art_track
         FROM tracks
        WHERE album_key = ?
        GROUP BY album_key`,
      [albumKeyValue],
    );
    return this.albumSummariesFromRows(rows, false)[0] ?? null;
  }

  private albumSummariesFromRows(rows: AlbumGroupRow[], searching: boolean): AlbumSummary[] {
    const ratings = this.newestRatingsByKey();
    return rows.map((r) => {
      const rating = ratings.get(r.album_key);
      return {
        albumKey: r.album_key,
        album: r.album,
        albumArtist: r.album_artist || 'Unknown Artist',
        sortKey: r.sort_artist ?? '',
        year: r.year,
        trackCount: r.track_count,
        duration: r.duration,
        artFromTrackId: r.art_track,
        rating: rating?.rating ?? 0,
        ratingScore: rating?.ratingScore ?? null,
        albumKind: normalizeAlbumKind(r.album_kind),
        albumReason: r.album_reason ?? null,
        matchedOnTrack: searching ? Boolean(r.matched_track) : undefined,
        // Split on the U+001F unit separator (the SQL GROUP_CONCAT used char(31))
        // — chosen because it cannot occur inside a song title.
        matchedTrackTitles:
          searching && r.matched_titles
            ? Array.from(new Set(r.matched_titles.split(String.fromCharCode(31)))).slice(0, 4).join(' · ')
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

    const keys = this.resolveAlbumKeys(cleanAlbumArtist, cleanAlbum);
    const rows = keys.length
      ? this.many<{ id: number }>(
        `SELECT id FROM tracks WHERE album_key IN (${keys.map(() => '?').join(',')})`,
        keys,
      )
      : [];
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
    this.invalidateLibraryHealthCache();
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

  // Artists grouped on artist_key (case, accents and spacing folded), shown
  // under the spelling most of their tracks use and ordered by the file's sort
  // name when it has one, else the name without a leading "The".
  getArtists(opts: CatalogSummaryQueryOptions = {}): ArtistSummary[] {
    this.ensureIdentityKeys();
    const search = String(opts.search ?? '').trim();
    const limit = summaryQueryLimit(opts.limit);
    const offset = summaryQueryOffset(opts.offset);
    // Nothing has changed since the pass wrote the list, and there is no filter
    // to count only matching tracks for: read it as it was written.
    if (!search && !this.artistListStale && !this.identityUngrouped) {
      return this.many<{ artist_key: string; display: string; sort_key: string; track_count: number; album_count: number }>(
        `SELECT artist_key, display, sort_key, track_count, album_count FROM artist_groups
          ORDER BY sort_key, artist_key LIMIT ? OFFSET ?`,
        [limit, offset],
      ).map((row) => ({
        artistKey: row.artist_key,
        artist: row.display,
        sortKey: row.sort_key,
        trackCount: row.track_count,
        albumCount: row.album_count,
      }));
    }
    return this.listArtists(search).slice(offset, offset + limit);
  }

  private listArtists(search: string): ArtistSummary[] {
    // `artist != ''` is the cheap test: that column is at the front of a row.
    // An artist that folds to nothing (all spaces) is dropped below.
    const where = ['artist != \'\''];
    const params: unknown[] = [];

    if (search) {
      const q = foldedLikeParam(search);
      where.push(`(artist_fold LIKE ? ESCAPE '|' OR album_fold LIKE ? ESCAPE '|')`);
      params.push(q, q);
    }

    // A search counts only the tracks that match, so it is grouped here, but the
    // spelling and sort name of each artist are already written: only the keys
    // need grouping, which is no more work than the library did before. The
    // filter reads folded text no index holds, so the table is scanned in order.
    if (!this.artistListStale && !this.identityUngrouped) {
      return this.many<{ artist_key: string; display: string; sort_key: string; n: number; a: number }>(
        `SELECT m.artist_key, g.display, g.sort_key, m.n, m.a
           FROM (SELECT artist_key, COUNT(*) AS n, COUNT(DISTINCT album_key) AS a
                   FROM tracks NOT INDEXED WHERE ${where.join(' AND ')} GROUP BY artist_key) m
           JOIN artist_groups g ON g.artist_key = m.artist_key
          ORDER BY g.sort_key, g.artist_key`,
        params,
      ).map((row) => ({
        artistKey: row.artist_key,
        artist: row.display,
        sortKey: row.sort_key,
        trackCount: row.n,
        albumCount: row.a,
      }));
    }

    // One pass over (artist_key, artist, album_key); the spellings and album
    // counts fall out of it. Only reached while a pass is due (see getArtists).
    const rows = this.many<{ artist_key: string; artist: string; album_key: string | null; n: number }>(
      `SELECT artist_key, artist, album_key, COUNT(*) AS n
         FROM tracks WHERE ${where.join(' AND ')}
        GROUP BY artist_key, artist, album_key`,
      params,
    );
    const groups = new Map<string, { names: Map<string, number>; tracks: number; albums: Set<string> }>();
    for (const row of rows) {
      if (!row.artist_key) continue;
      let group = groups.get(row.artist_key);
      if (!group) {
        group = { names: new Map(), tracks: 0, albums: new Set() };
        groups.set(row.artist_key, group);
      }
      const name = row.artist.trim();
      group.names.set(name, (group.names.get(name) ?? 0) + row.n);
      group.tracks += row.n;
      if (row.album_key) group.albums.add(row.album_key);
    }
    const sortTags = this.artistSortTags();
    const listed = [...groups].map(([artistKey, group]) => {
      let artist = '';
      let best = -1;
      for (const [name, n] of group.names) {
        if (n > best || (n === best && name < artist)) {
          artist = name;
          best = n;
        }
      }
      return {
        artist,
        artistKey,
        trackCount: group.tracks,
        albumCount: group.albums.size,
        sort: artistSortKey(artist, sortTags.get(artistKey)),
      };
    });
    listed.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.artistKey < b.artistKey ? -1 : a.artistKey > b.artistKey ? 1 : 0));
    return listed.map(({ artist, artistKey, trackCount, albumCount, sort }) => ({ artist, artistKey, sortKey: sort, trackCount, albumCount }));
  }

  // The sort names files carry (ARTISTSORT, and ALBUMARTISTSORT where the album
  // artist is the track artist), by artist key. Only a few rows have one.
  private artistSortTags(): Map<string, string> {
    const out = new Map<string, string>();
    const rows = this.many<{ artist_key: string; s: string | null; a: string | null }>(
      `SELECT artist_key,
              MAX(artist_sort) AS s,
              MAX(CASE WHEN album_artist_fold = artist_fold THEN album_artist_sort END) AS a
         FROM tracks
        WHERE artist_sort IS NOT NULL OR album_artist_sort IS NOT NULL
        GROUP BY artist_key`,
    );
    for (const row of rows) {
      const tag = row.s || row.a;
      if (tag) out.set(row.artist_key, tag);
    }
    return out;
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
    return this.queryFolderRows<RawRow>(folderPath, opts, TRACK_COLUMNS);
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

  private invalidateLibraryHealthCache(): void {
    this.libraryHealthCache = null;
  }

  // An album's tracks, for callers that still hold the pair of strings the
  // library used to group on. The pair is matched to an album key (see
  // resolveAlbumKeys), so an album the grouping has since joined to others
  // still answers to the name a caller read before. Several albums can share a
  // pair (a folder split apart, folders under a generic title); a pair cannot
  // say which, so it gets the one with the most tracks. Callers holding a track
  // or an album summary have the key and should use getAlbumTracksByKey.
  getAlbumTracks(albumArtist: string, album: string): Track[] {
    this.ensureIdentityKeys();
    // The pair as the library stored it finds its album in one statement; the
    // other readings of a pair (see resolveAlbumKeys) only run when it does not.
    const direct = this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks
        WHERE album_key = (
          SELECT album_key FROM tracks
           WHERE album = ? AND COALESCE(NULLIF(album_artist,''), artist) = ? AND album_key IS NOT NULL
           GROUP BY album_key ORDER BY COUNT(*) DESC, album_key LIMIT 1)
        ORDER BY COALESCE(disc_inferred, disc_no, 1), track_no, title, id`,
      [album, albumArtist],
    );
    if (direct.length) return direct.map(rowToTrack);
    return this.tracksOfAlbumKeys(this.resolveAlbumKeys(albumArtist, album).slice(0, 1));
  }

  getAlbumTracksByKey(key: string): Track[] {
    this.ensureIdentityKeys();
    const trimmed = String(key ?? '').trim();
    return trimmed ? this.tracksOfAlbumKeys([trimmed]) : [];
  }

  // Disc, then track number. The disc is the one the grouping settled on (from
  // the title or folder, where the files have none or all say the same), else
  // the file's, and otherwise counts as disc 1.
  private tracksOfAlbumKeys(keys: string[]): Track[] {
    if (!keys.length) return [];
    return this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks
        WHERE album_key IN (${keys.map(() => '?').join(',')})
        ORDER BY album_key, COALESCE(disc_inferred, disc_no, 1), track_no, title, id`,
      keys,
    ).map(rowToTrack);
  }

  getArtistTracks(artist: string): Track[] {
    this.ensureIdentityKeys();
    const key = artistKeyOf(artist);
    if (!key) return [];
    return this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks WHERE artist_key = ?
        ORDER BY year, album COLLATE NOCASE, disc_no, track_no, title`,
      [key],
    ).map(rowToTrack);
  }

  // -- album identity -----------------------------------------------------------

  isClosed(): boolean {
    return this.closed;
  }

  // Queries that group on album_key or artist_key need them to exist. A library
  // opened from an older version has rows that never got one until the first
  // pass runs; a caller that can't wait for it gets it run here instead.
  private ensureIdentityKeys(): void {
    if (this.identityUngrouped && !this.closed) this.regroupAlbumsSync();
  }

  // Called once the library is open: the first launch after an upgrade (or
  // after a quit before a pass could run) groups every track in slices in the
  // background, while the window comes up.
  private startInitialRegroup(): void {
    const meta = (key: string): string | null =>
      this.one<{ value: string }>(`SELECT value FROM library_meta WHERE key = ?`, [key])?.value ?? null;
    if (!this.one(`SELECT 1 FROM tracks LIMIT 1`)) return;
    this.identityPendingPersisted = meta('album_identity_pending') !== null;
    this.identityUngrouped = !!this.one(
      `SELECT 1 FROM tracks
        WHERE (TRIM(album, ${JS_WHITESPACE_SQL}) != '' AND album_key IS NULL)
           OR (TRIM(artist, ${JS_WHITESPACE_SQL}) != '' AND artist_key = '') LIMIT 1`,
    );
    this.identityStale = this.identityPendingPersisted || Number(meta('album_identity_version') ?? 0) !== ALBUM_IDENTITY_VERSION;
    // A list the pass should have written and did not is a pass still due.
    if (
      !this.one(`SELECT 1 FROM artist_groups LIMIT 1`)
      && this.one(`SELECT 1 FROM tracks WHERE artist_key != '' LIMIT 1`)
    ) {
      this.identityStale = true;
    }
    this.artistListStale = this.identityStale;
    if (!this.identityUngrouped && !this.identityStale) return;
    setImmediate(() => {
      void this.regroupAlbums().catch((err) => console.error('[newamp] album grouping failed:', err));
    });
  }

  // Resolves once any grouping pass that is running or due has finished.
  albumsReady(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.identityRun) return this.identityRun.then(() => undefined, () => undefined);
    if (this.identityUngrouped) return this.regroupAlbums().then(() => undefined, () => undefined);
    return Promise.resolve();
  }

  // Something that decides which tracks form an album changed. `tagsOnly` is a
  // change to tags read from files already in the library: the albums may
  // group differently, but no artist appeared or went.
  private markIdentityStale(opts: { tagsOnly?: boolean } = {}): void {
    this.groupingEpoch += 1;
    this.identityStale = true;
    if (!opts.tagsOnly) this.artistListStale = true;
    if (!this.identityPendingPersisted) {
      // Persisted so a quit before the pass runs still gets one at next launch.
      this.db.run(`INSERT OR REPLACE INTO library_meta (key, value) VALUES ('album_identity_pending', '1')`);
      this.identityPendingPersisted = true;
      this.scheduleFlush();
    }
  }

  // A change is due a pass, a couple of seconds after the changes stop coming.
  // A scan runs it itself when it ends.
  private requestRegroup(delayMs = REGROUP_DEBOUNCE_MS): void {
    this.markIdentityStale();
    this.armRegroupTimer(delayMs);
  }

  private armRegroupTimer(delayMs: number): void {
    if (this.closed) return;
    // A scan marks the albums stale with every batch, and a pass started between
    // two batches reads the whole library only to be stopped by the next. It
    // waits for the scan, which regroups once when it ends. An edit made by hand
    // does not wait.
    if (this.regroupHolds > 0 && delayMs === REGROUP_DEBOUNCE_MS) return;
    if (this.regroupTimer) clearTimeout(this.regroupTimer);
    this.regroupTimer = setTimeout(() => {
      this.regroupTimer = null;
      void this.regroupAlbums().catch((err) => console.error('[newamp] album grouping failed:', err));
    }, delayMs);
    this.regroupTimer.unref?.();
  }

  /** A scan is starting: its batches do not each start a grouping pass. */
  holdRegroup(): void {
    this.regroupHolds += 1;
  }

  /** The scan is over. Changes it left unsettled (a cancelled scan) get their pass. */
  releaseRegroup(): void {
    this.regroupHolds = Math.max(0, this.regroupHolds - 1);
    if (!this.regroupHolds && this.identityStale) this.armRegroupTimer(REGROUP_DEBOUNCE_MS);
  }

  /**
   * Groups the library's tracks into albums, in slices that hand the thread
   * back between them. Does nothing when no change is waiting, unless forced.
   * A pass that sees newer changes arrive stops and runs again.
   */
  async regroupAlbums(opts: { force?: boolean } = {}): Promise<RegroupResult | null> {
    if (this.closed) return null;
    if (this.identityRun) {
      await this.identityRun.catch(() => undefined);
      if (this.closed) return null;
    }
    if (!opts.force && !this.identityStale && !this.identityUngrouped) return null;
    if (this.identityRun) return this.identityRun;
    if (this.regroupTimer) {
      clearTimeout(this.regroupTimer);
      this.regroupTimer = null;
    }
    const run: Promise<RegroupResult | null> = (async () => {
      let result: RegroupResult | null = null;
      for (let attempt = 0; attempt < 4 && !this.closed; attempt++) {
        result = await runRegroupAsync(this.regroupHost());
        if (!result.aborted) return result;
        // Something changed under the pass. If nothing is waiting any more, a
        // synchronous pass finished the job; otherwise go again.
        if (!this.identityStale && !this.identityUngrouped) return result;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (!this.closed && this.identityStale) this.requestRegroup();
      return result;
    })().finally(() => {
      if (this.identityRun === run) this.identityRun = null;
    });
    this.identityRun = run;
    return run;
  }

  /** The same pass without yielding, for callers with nothing to give the thread to. */
  regroupAlbumsSync(): RegroupResult {
    const result = runRegroupSync(this.regroupHost());
    // A pass that is waiting for its next slice sees this and stands down.
    this.groupingEpoch += 1;
    return result;
  }

  private regroupHost(): RegroupHost {
    return {
      epoch: () => (this.closed ? -1 : this.groupingEpoch),
      loadSplits: () =>
        new Set(
          this.many<{ fingerprint: string }>(`SELECT fingerprint FROM album_overrides WHERE action = 'split'`).map(
            (row) => row.fingerprint,
          ),
        ),
      loadEditedAlbumArtists: () =>
        new Set(
          this.many<{ track_id: number }>(
            `SELECT track_id FROM track_metadata_overrides WHERE field = 'albumArtist'`,
          ).map((row) => row.track_id),
        ),
      loadRatingTargets: () =>
        this.many<{ rowid: number; album_artist: string; album: string; album_key: string | null }>(
          `SELECT rating_id AS rowid, album_artist, album, album_key FROM album_ratings`,
        ).map((row): RatingTarget => ({
          rowid: row.rowid,
          albumArtist: row.album_artist,
          album: row.album,
          albumKey: row.album_key,
        })),
      loadChunk: (afterId, limit) =>
        this.closed ? [] : this.many<RegroupRow>(
          `SELECT id, path, album, artist, album_artist, album_artist_tag, scan_schema, compilation, disc_no, year,
                  album_artist_sort, artist_sort, artist_key, album_key, album_display, album_artist_display,
                  album_kind, album_reason, album_year, album_sort_key, disc_inferred
             FROM tracks WHERE id > ? ORDER BY id LIMIT ?`,
          [afterId, limit],
        ),
      writeChunk: (rows, remaps) => this.writeIdentityChunk(rows, remaps),
      finish: (artists) => this.finishRegroup(artists),
    };
  }

  // The rating rows that follow their album ride in the same transaction as
  // the first tracks that move, so a pass cut short after that write never
  // leaves a rating on a key no track has.
  private writeIdentityChunk(rows: RegroupWrite[], remaps: RatingRemap[] = []): void {
    this.db.run('BEGIN');
    try {
      for (const remap of remaps) {
        this.db.run(`UPDATE album_ratings SET album_key = ? WHERE rating_id = ?`, [remap.albumKey, remap.rowid]);
      }
      const full = this.db.prepare(
        `UPDATE tracks SET artist_key=?, album_key=?, album_display=?, album_artist_display=?, album_kind=?,
                album_reason=?, album_year=?, album_sort_key=?, disc_inferred=? WHERE id=?`,
      );
      const artistOnly = this.db.prepare(`UPDATE tracks SET artist_key=? WHERE id=?`);
      const cleared = this.db.prepare(
        `UPDATE tracks SET artist_key=?, album_key=NULL, album_display=NULL, album_artist_display=NULL,
                album_kind='album', album_reason=NULL, album_year=NULL, album_sort_key=NULL, disc_inferred=NULL
          WHERE id=?`,
      );
      try {
        for (const row of rows) {
          const identity = row.identity;
          if (identity) {
            full.run([
              row.artistKey,
              identity.albumKey,
              identity.albumDisplay,
              identity.albumArtistDisplay,
              identity.albumKind,
              identity.albumReason,
              identity.albumYear,
              identity.albumSortKey,
              identity.discInferred,
              row.id,
            ]);
          } else if (row.clear) cleared.run([row.artistKey, row.id]);
          else artistOnly.run([row.artistKey, row.id]);
        }
      } finally {
        full.free();
        artistOnly.free();
        cleared.free();
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    // Written in bulk and re-derivable, so it rides the slow flush tier. A
    // rating that moved is the user's own data and does not wait.
    this.scheduleFlush(remaps.length ? undefined : { slow: true });
  }

  private finishRegroup(artists: ArtistGroup[]): void {
    this.db.run('BEGIN');
    try {
      this.db.run(`DELETE FROM artist_groups`);
      const insert = this.db.prepare(
        `INSERT INTO artist_groups (artist_key, display, sort_key, track_count, album_count) VALUES (?, ?, ?, ?, ?)`,
      );
      try {
        for (const group of artists) {
          insert.run([group.artistKey, group.display, group.sortKey, group.trackCount, group.albumCount]);
        }
      } finally {
        insert.free();
      }
      this.db.run(`DELETE FROM library_meta WHERE key = 'album_identity_pending'`);
      this.db.run(`INSERT OR REPLACE INTO library_meta (key, value) VALUES ('album_identity_version', ?)`, [
        String(ALBUM_IDENTITY_VERSION),
      ]);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.identityStale = false;
    this.artistListStale = false;
    this.identityUngrouped = false;
    this.identityPendingPersisted = false;
    this.invalidateLibraryHealthCache();
    this.scheduleFlush();
  }

  /**
   * The album keys a (album artist, album) pair stands for, most tracks first.
   * The pair is tried as the library stored it, then as the grouping would
   * write it (folds applied, a compilation under "Various Artists"), then as
   * the album is shown. An album the grouping has split by folder has several.
   */
  resolveAlbumKeys(albumArtist: string, album: string): string[] {
    this.ensureIdentityKeys();
    const exact = this.many<{ album_key: string }>(
      `SELECT album_key, COUNT(*) AS n FROM tracks
        WHERE album = ? AND COALESCE(NULLIF(album_artist,''), artist) = ? AND album_key IS NOT NULL
        GROUP BY album_key ORDER BY n DESC, album_key`,
      [album, albumArtist],
    );
    if (exact.length) return exact.map((row) => row.album_key);
    const artist = String(albumArtist ?? '').trim();
    const title = String(album ?? '').trim();
    if (!artist || !title) return [];
    const base = keyForPair(artist, title);
    // A bucket or a split album's key is the plain key plus a suffix that starts with '!' or '@'.
    const near = this.many<{ album_key: string }>(
      `SELECT album_key, COUNT(*) AS n FROM tracks
        WHERE album_key = ? OR (album_key >= ? AND album_key < ?)
        GROUP BY album_key ORDER BY n DESC, album_key`,
      [base, `${base}|!`, `${base}|A`],
    );
    if (near.length) return near.map((row) => row.album_key);
    const shown = this.many<{ album_key: string }>(
      `SELECT album_key, COUNT(*) AS n FROM tracks
        WHERE album_display = ? COLLATE NOCASE AND album_artist_display = ? COLLATE NOCASE AND album_key IS NOT NULL
        GROUP BY album_key ORDER BY n DESC, album_key`,
      [title, artist],
    );
    return shown.map((row) => row.album_key);
  }

  // -- the tag backfill ---------------------------------------------------------

  /** Whether any row has not been read with the current tag set yet. */
  tagBackfillPending(): boolean {
    return !!this.one(
      `SELECT 1 FROM tracks WHERE scan_schema < ? AND missing_since IS NULL LIMIT 1`,
      [SCAN_SCHEMA_VERSION],
    );
  }

  /** The next rows after `afterId` that still need their tags read. */
  getTagBackfillBatch(limit: number, afterId: number): TagBackfillCandidate[] {
    return this.many<TagBackfillCandidate>(
      `SELECT id, path, size, mtime FROM tracks
        WHERE id > ? AND scan_schema < ? AND missing_since IS NULL
        ORDER BY id LIMIT ?`,
      [Math.trunc(afterId), SCAN_SCHEMA_VERSION, Math.max(1, Math.trunc(limit))],
    );
  }

  /** Stores tags read from unchanged files. Touches nothing else on the row. Returns rows written. */
  applyTagBackfill(rows: TagBackfillRow[]): number {
    if (!rows.length || this.closed) return 0;
    this.db.run('BEGIN');
    let written = 0;
    try {
      const stmt = this.db.prepare(
        `UPDATE tracks SET album_artist_tag=?, compilation=?, album_artist_sort=?, artist_sort=?, disc_total=?,
                track_total=?, disc_subtitle=?, mb_release_group_id=?, original_year=?, artists_json=?, genres_json=?,
                scan_schema=?
          WHERE id=? AND scan_schema < ?`,
      );
      try {
        for (const row of rows) {
          stmt.run([
            row.albumArtistTag,
            row.compilation ? 1 : 0,
            row.albumArtistSort,
            row.artistSort,
            row.discTotal,
            row.trackTotal,
            row.discSubtitle,
            row.mbReleaseGroupId,
            row.originalYear,
            row.artists ? JSON.stringify(row.artists) : null,
            row.genres ? JSON.stringify(row.genres) : null,
            SCAN_SCHEMA_VERSION,
            row.id,
            SCAN_SCHEMA_VERSION,
          ]);
          written += this.db.getRowsModified();
        }
      } finally {
        stmt.free();
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    if (written) {
      this.markIdentityStale({ tagsOnly: true });
      // Re-derivable from the files, so a quit before the write lands only costs a re-read.
      this.scheduleFlush({ slow: true });
    }
    return written;
  }

  /** Records that every row has been read with the current tag set (rows skipped as changed stay queued). */
  finishTagBackfill(): void {
    if (this.tagBackfillPending()) return;
    this.db.run(`INSERT OR REPLACE INTO library_meta (key, value) VALUES ('scan_schema', ?)`, [
      String(SCAN_SCHEMA_VERSION),
    ]);
    this.scheduleFlush();
  }

  // -- split an album ------------------------------------------------------------

  /**
   * "Show as separate albums": every folder the album's tracks sit in is
   * remembered (by folder and title, so it survives rescans) and its tracks
   * group by their own album artist again, the way the library did before the
   * grouping looked at folders. With `split` false, undoes it for the album
   * and for the pieces that came from the same original. Resolves when the
   * albums have been regrouped.
   */
  async setAlbumSplit(key: string, split: boolean): Promise<number> {
    await this.albumsReady();
    const albumKeyValue = String(key ?? '').trim();
    if (!albumKeyValue) return 0;
    const rows = this.many<{ path: string; album: string; label: string | null }>(
      `SELECT path, album, album_display AS label FROM tracks WHERE album_key = ?`,
      [albumKeyValue],
    );
    if (!rows.length) return 0;
    const prints = new Map<string, string>();
    for (const row of rows) prints.set(containerFingerprint(row.path, row.album), row.label ?? row.album);
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      if (split) {
        for (const [fingerprint, label] of prints) {
          this.db.run(
            `INSERT OR REPLACE INTO album_overrides (fingerprint, action, source_key, label, created_at)
             VALUES (?, 'split', ?, ?, ?)`,
            [fingerprint, albumKeyValue, label, now],
          );
        }
      } else {
        const fingerprints = [...prints.keys()];
        const marks = fingerprints.map(() => '?').join(',');
        const sources = this.many<{ source_key: string }>(
          `SELECT DISTINCT source_key FROM album_overrides WHERE fingerprint IN (${marks})`,
          fingerprints,
        ).map((row) => row.source_key);
        this.db.run(`DELETE FROM album_overrides WHERE fingerprint IN (${marks})`, fingerprints);
        for (const source of sources) {
          if (source) this.db.run(`DELETE FROM album_overrides WHERE source_key = ?`, [source]);
        }
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.markIdentityStale();
    this.scheduleFlush();
    await this.regroupAlbums({ force: true });
    return prints.size;
  }

  /** Containers the user has asked to see apart. */
  listAlbumOverrides(): Array<{ fingerprint: string; action: string; sourceKey: string; label: string; createdAt: number }> {
    return this.many<{ fingerprint: string; action: string; source_key: string; label: string; created_at: number }>(
      `SELECT fingerprint, action, source_key, label, created_at FROM album_overrides ORDER BY created_at, fingerprint`,
    ).map((row) => ({
      fingerprint: row.fingerprint,
      action: row.action,
      sourceKey: row.source_key,
      label: row.label,
      createdAt: row.created_at,
    }));
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
      `SELECT ${TRACK_COLUMNS} FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
          AND missing_since IS NULL
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
      `SELECT ${TRACK_COLUMNS} FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
          AND missing_since IS NULL
        ORDER BY mtime DESC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE
        LIMIT 3000`,
    ).map(rowToTrack);
    const underplayedCandidates = this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
          AND missing_since IS NULL
          AND play_count <= 1
        ORDER BY mtime ASC, year IS NULL, year ASC, artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE
        LIMIT 4000`,
    ).map(rowToTrack);
    const albumCandidates = this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
          AND missing_since IS NULL
        ORDER BY album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE
        LIMIT 6000`,
    ).map(rowToTrack);
    const tracks = currentTrack && !currentTrack.avoidAutoPlay && !currentTrack.missingSince
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
                  min_bpm = ?, max_bpm = ?, min_rating = ?, loved_only = ?, unplayed_only = ?, folder_path = ?,
                  updated_at = ?
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
                    min_bpm = ?, max_bpm = ?, min_rating = ?, loved_only = ?, unplayed_only = ?, folder_path = ?,
                    updated_at = ?
              WHERE id = ?`,
            [normalized.mood, normalized.count, normalized.genreQuery, normalized.searchQuery,
              normalized.minYear, normalized.maxYear,
              normalized.minBpm, normalized.maxBpm, normalized.minRating, normalized.lovedOnly ? 1 : 0,
              normalized.unplayedOnly ? 1 : 0, normalized.folderPath, now, id],
          );
        } else {
          this.db.run(
            `INSERT INTO smart_rules
             (name, mood, count, genre_query, search_query, min_year, max_year, min_bpm, max_bpm,
              min_rating, loved_only, unplayed_only, folder_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // Tag playlists are generated sets (tags come from rules), so a track whose
    // file is missing is left out like it is from every other generated pool.
    const rows = this.many<{ track_id: number }>(
      `SELECT tt.track_id FROM track_tags tt
         JOIN tracks t ON t.id = tt.track_id
        WHERE tt.tag_name = ? AND t.missing_since IS NULL`,
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
    // The preview stands for the tag playlist, which leaves missing tracks
    // out (getTrackIdsByTag), so its count and samples do too.
    const rows = this.many<RawRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE missing_since IS NULL LIMIT ${limit}`);
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
          `SELECT ${TRACK_COLUMNS} FROM tracks WHERE id IN (${targetIds.map(() => '?').join(',') || '0'})${limitSql}`,
          targetIds,
        )
      : this.many<RawRow>(`SELECT ${TRACK_COLUMNS} FROM tracks${limitSql}`);

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

  runSmartPlaylistRule(input: number | SmartPlaylistRuleInput, sampleCount = 0): Track[] {
    const rule = typeof input === 'number'
      ? this.getSmartRule(Math.trunc(input))
      : { ...normalizeSmartRuleInput(input), id: 0, createdAt: 0, updatedAt: 0 };
    if (!rule) return [];
    if (rule.folderPath) {
      return this.runFolderRule(rule, Math.max(0, Math.trunc(sampleCount))).map(rowToTrack);
    }

    const { where, params } = smartRuleWhere(rule);
    const candidates = this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks ${where} LIMIT 10000`,
      params,
    ).map(rowToTrack);

    // DNA re-rank ("warm", "loud", "gentle"…): proximity to the requested
    // perceptual targets boosts ordering. Deliberately a boost, never a
    // filter — un-analyzed tracks still surface, just lower.
    const wantsDna = rule.dnaEnergyTarget != null || rule.dnaBrightnessTarget != null;
    const dnaIndex = wantsDna ? this.buildDnaIndex() : null;
    const dnaBoost = (track: Track): number => {
      if (!dnaIndex) return 0;
      const dna = dnaIndex.get(track.id);
      if (!dna) return 0;
      let boost = 0;
      if (rule.dnaEnergyTarget != null) {
        boost += (1 - Math.min(1, Math.abs(dna.rms - rule.dnaEnergyTarget) * 2)) * 1.4;
      }
      if (rule.dnaBrightnessTarget != null) {
        boost += (1 - Math.min(1, Math.abs(dna.brightness - rule.dnaBrightnessTarget) * 2)) * 1.4;
      }
      return boost;
    };

    return candidates
      .map((track) => ({
        track,
        score: scoreSmartTrack(track, rule) + dnaBoost(track) + stableJitter(track.id),
      }))
      .sort((a, b) =>
        b.score - a.score ||
        (a.track.artist || '').localeCompare(b.track.artist || '') ||
        (a.track.title || '').localeCompare(b.track.title || ''),
      )
      .slice(0, rule.count)
      .map((item) => item.track);
  }

  // The LIKE prefix is a cheap first pass; trackPathIsInFolder decides, so a
  // sibling folder whose name starts the same ("To Listen Later") is dropped.
  private folderRuleStatement(
    rule: SmartPlaylistRule,
    columns: string,
    ordered = true,
  ): import('sql.js').Statement | null {
    const folder = normalizeFolderPath(rule.folderPath);
    if (!folder) return null;
    const { where, params } = smartRuleWhere(rule);
    // Counting does not need folder order, and sorting every matching row to
    // then throw the order away is most of the work for a large folder.
    const order = ordered
      ? `ORDER BY lower(replace(path, '/', '\\')) COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE, id`
      : '';
    const stmt = this.db.prepare(
      `SELECT ${columns} FROM tracks
        ${where ? `${where} AND` : 'WHERE'} lower(replace(path, '/', '\\')) LIKE ? ESCAPE '|'
        ${order}`,
    );
    try {
      stmt.bind([...params, folderTrackPathPrefixParam(folder)] as unknown as import('sql.js').BindParams);
    } catch (err) {
      // An unbound statement still holds wasm memory, and leaking one here
      // can fail the next close().
      stmt.free();
      throw err;
    }
    return stmt;
  }

  // A folder rule is the folder itself: every track under it, in the same
  // order the Folders view lists them, narrowed by the rule's other filters.
  // `sample` takes that many at random instead (Auto DJ asks for a handful of
  // candidates; it would otherwise carry the whole folder over IPC to drop
  // nearly all of it). Sampling as we step keeps the rows we hold bounded too.
  private runFolderRule(rule: SmartPlaylistRule, sample = 0): RawRow[] {
    const folder = normalizeFolderPath(rule.folderPath);
    const stmt = this.folderRuleStatement(rule, TRACK_COLUMNS);
    if (!folder || !stmt) return [];
    const rows: RawRow[] = [];
    let matched = 0;
    try {
      while (stmt.step() && matched < 100000) {
        const row = stmt.getAsObject() as unknown as RawRow;
        if (!trackPathIsInFolder(row.path, folder, true)) continue;
        matched += 1;
        if (sample <= 0 || rows.length < sample) {
          rows.push(row);
          continue;
        }
        // Reservoir: every matching track keeps an equal chance of the slot.
        const slot = Math.floor(Math.random() * matched);
        if (slot < sample) rows[slot] = row;
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private countFolderRuleMatches(rule: SmartPlaylistRule): number {
    const folder = normalizeFolderPath(rule.folderPath);
    const stmt = this.folderRuleStatement(rule, 'path', false);
    if (!folder || !stmt) return 0;
    let matched = 0;
    try {
      while (stmt.step() && matched < 100000) {
        const { path } = stmt.getAsObject() as unknown as { path: string };
        if (trackPathIsInFolder(path, folder, true)) matched += 1;
      }
      return matched;
    } finally {
      stmt.free();
    }
  }

  private countSmartPlaylistRuleMatches(rule: SmartPlaylistRule): number {
    if (rule.folderPath) return this.countFolderRuleMatches(rule);
    const { where, params } = smartRuleWhere(rule);
    const row = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks ${where}`, params);
    return Math.min(rule.count, Math.max(0, row?.n ?? 0));
  }

  buildHarmonicMix(input: HarmonicMixInput = {}): Track[] {
    const where: string[] = ['path IS NOT NULL', 'avoid_auto_play = 0', 'missing_since IS NULL'];
    const params: unknown[] = [];
    const genreQuery = input.genreQuery?.trim();
    if (genreQuery) {
      where.push(`genre IS NOT NULL AND genre_fold LIKE ? ESCAPE '|'`);
      params.push(foldedLikeParam(genreQuery));
    }
    let candidates = this.many<RawRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks
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
    if (seed && !candidates.some((track) => track.id === seed.id) && !seed.avoidAutoPlay && !seed.missingSince) {
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
      `SELECT ${TRACK_COLUMNS} FROM tracks
        WHERE path IS NOT NULL
          AND avoid_auto_play = 0
          AND missing_since IS NULL
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
    this.upgradeAlbumRatingsTable();
    this.maybeBackfillAlbumRatingsFromTracks();
    this.maybeQueueMetadataAdoption();
    this.maybeBackfillSearchFold();
    this.dropOrphanedTrackRows();
  }

  /**
   * album_ratings used to be unique on the text pair (album_artist, album).
   * Two albums that share a title and artist (the pieces of a split folder,
   * several folders with a generic title) then fought over one row: rating one
   * moved or deleted the other's. Ratings belong to an album key now, so the
   * table is rebuilt without the pair as its primary key. Rows keep their
   * values, keys and order. Nothing happens on a table that already has the
   * new shape.
   */
  private upgradeAlbumRatingsTable(): void {
    const ddl = this.one<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'album_ratings'`,
    )?.sql ?? '';
    if (!/PRIMARY\s+KEY\s*\(\s*album_artist\s*,\s*album\s*\)/i.test(ddl)) return;
    // Older builds can't write ratings into the rebuilt table, so keep the
    // file as it was before this one-way change. The rebuild only reaches
    // disk at the next flush, so the copy on disk is still the old shape.
    this.backupBeforeOneWayUpgrade('before-album-keys');
    this.db.run(`DROP INDEX IF EXISTS idx_album_ratings_key`);
    this.db.run(`DROP INDEX IF EXISTS idx_album_ratings_pair`);
    this.db.run(`ALTER TABLE album_ratings RENAME TO album_ratings_old`);
    this.db.run(
      `CREATE TABLE album_ratings (
         rating_id     INTEGER PRIMARY KEY,
         album_artist  TEXT NOT NULL COLLATE NOCASE,
         album         TEXT NOT NULL COLLATE NOCASE,
         rating        INTEGER NOT NULL DEFAULT 0,
         rating_score  REAL,
         updated_at    INTEGER NOT NULL,
         album_key     TEXT
       )`,
    );
    this.db.run(
      `INSERT INTO album_ratings (album_artist, album, rating, rating_score, updated_at, album_key)
       SELECT album_artist, album, rating, rating_score, updated_at, album_key FROM album_ratings_old ORDER BY rowid`,
    );
    this.db.run(`DROP TABLE album_ratings_old`);
    this.db.run(`CREATE INDEX idx_album_ratings_key ON album_ratings(album_key)`);
    this.db.run(`CREATE INDEX idx_album_ratings_pair ON album_ratings(album_artist, album)`);
    this.scheduleFlush();
  }

  /** Copies library.db beside itself once per tag. A failed copy is logged, not fatal. */
  private backupBeforeOneWayUpgrade(tag: string): void {
    const target = `${this.file}.${tag}.bak`;
    try {
      if (existsSync(this.file) && !existsSync(target)) copyFileSync(this.file, target);
    } catch (err) {
      console.error(`[newamp] could not keep a copy of the library before upgrading it (${target}):`, err);
    }
  }

  /**
   * sql.js export() reopens the connection, which turns PRAGMA foreign_keys
   * back off, so ON DELETE CASCADE only holds for the first moments of a
   * session and a removed track can leave rows behind. Tag rows are derived
   * (recomputeTags rebuilds them) and inflate the tag counts, so any with no
   * track are dropped on open. A list entry that pointed at such a track keeps
   * its label and note and becomes a free-text entry; track ids are never reused.
   */
  private dropOrphanedTrackRows(): void {
    this.db.run(`DELETE FROM track_tags WHERE track_id NOT IN (SELECT id FROM tracks)`);
    let changed = this.db.getRowsModified() > 0;
    this.db.run(`UPDATE list_items SET track_id = NULL WHERE track_id IS NOT NULL AND track_id NOT IN (SELECT id FROM tracks)`);
    changed = changed || this.db.getRowsModified() > 0;
    if (changed) this.scheduleFlush();
  }

  /**
   * Migration: the folded search columns are new, so every track already in
   * the library gets them computed from its current (effective) title, artist,
   * album, album artist and genre. Upserts and metadata edits keep them
   * current afterwards. Bump the flag if foldSearchText ever changes. Once
   * the flag is set, only rows that were written without a fold (by an older
   * build after a downgrade) are filled in.
   */
  private maybeBackfillSearchFold(): void {
    const flagKey = 'search_fold_v2';
    const first = !this.one(`SELECT 1 FROM library_meta WHERE key = ?`, [flagKey]);
    try {
      const rows = this.many<{ id: number; title: string; artist: string; album: string; album_artist: string; genre: string | null }>(
        `SELECT id, title, artist, album, album_artist, genre FROM tracks${
          first ? '' : ` WHERE title_fold = '' AND artist_fold = '' AND (title != '' OR artist != '')`
        }`,
      );
      if (!rows.length && !first) return;
      const stmt = this.db.prepare(
        `UPDATE tracks SET title_fold = ?, artist_fold = ?, album_fold = ?, album_artist_fold = ?, genre_fold = ? WHERE id = ?`,
      );
      try {
        for (const row of rows) {
          stmt.run([
            foldSearchText(row.title),
            foldSearchText(row.artist),
            foldSearchText(row.album),
            foldSearchText(row.album_artist),
            foldSearchText(row.genre),
            row.id,
          ]);
        }
      } finally {
        stmt.free();
      }
      this.db.run(`INSERT OR REPLACE INTO library_meta (key, value) VALUES (?, ?)`, [flagKey, String(Date.now())]);
      this.scheduleFlush();
    } catch (err) {
      // Searching falls back to whatever the columns hold; the next boot tries again.
      console.error('[newamp] search fold backfill failed:', err);
    }
  }

  /**
   * Migration: before track_metadata_overrides existed, a manual edit or a
   * MusicBrainz rescue overwrote the tracks columns directly, and the next
   * forced scan put the file's tags back. Nothing recorded which values were
   * edits, so every track already in the library is queued for adoption: the
   * first time the scanner reads it, any editable field that differs from the
   * file is kept as an override rather than overwritten (see upsertTracks).
   * Differences that are only case, spacing, Unicode form or empty-vs-missing
   * are taken as an older reading and go to the file. Others may still be,
   * and Library Health can hand every adopted field back to its file.
   * A new library queues nothing; the flag makes this run once either way.
   */
  private maybeQueueMetadataAdoption(): void {
    const flagKey = 'metadata_overrides_adoption_v1';
    if (this.one(`SELECT 1 FROM library_meta WHERE key = ?`, [flagKey])) return;
    this.db.run(`INSERT OR IGNORE INTO track_metadata_adoption (track_id) SELECT id FROM tracks`);
    const queued = this.db.getRowsModified();
    this.db.run(`INSERT OR REPLACE INTO library_meta (key, value) VALUES (?, ?)`, [flagKey, String(Date.now())]);
    if (queued > 0) console.log(`[newamp] queued ${queued} tracks for one-time metadata edit adoption`);
    this.scheduleFlush();
  }

  /**
   * Migration: when a user upgrades from 1.5.3 (or earlier), their album
   * ratings live in `tracks.rating_score` because the old AlbumsView
   * cascade wrote the same score across every track in the album. 1.5.4
   * split album rating into its own table but did not backfill, so those
   * users saw their ratings vanish from NowPlayingView + the taste-mix
   * boost. This migration walks the tracks table, finds (artist, album)
   * groups where every track shares the same nonzero rating_score, and
   * inserts a row into album_ratings unless the pair already has one, which
   * preserves any explicit album rating the user has set since 1.5.4.
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
        `INSERT INTO album_ratings (album_artist, album, rating, rating_score, updated_at)
         SELECT g.album_artist, g.album, g.rating, g.rating_score, g.updated_at
           FROM (
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
                    AND MIN(rating_score) = MAX(rating_score)
                ) g
          WHERE NOT EXISTS (
                SELECT 1 FROM album_ratings r
                 WHERE r.album_artist = g.album_artist COLLATE NOCASE AND r.album = g.album COLLATE NOCASE)`,
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
   * Bulk-read every album rating into a Map keyed on album_key, newest row
   * winning. One SQL hit per mix call avoids the N+1 that would otherwise
   * happen if each track looked up its album rating individually.
   */
  buildAlbumRatingIndex(): Map<string, number> {
    const index = new Map<string, number>();
    for (const [key, rating] of this.newestRatingsByKey()) {
      if (rating.ratingScore != null) index.set(key, rating.ratingScore);
    }
    return index;
  }

  // The rating rows by album key. An album can hold more than one row (two
  // albums that regrouped into one each had their own); the newest is the one
  // that counts, and the others stay as they were until a clear removes them.
  private newestRatingsByKey(): Map<string, { rating: number; ratingScore: number | null; updatedAt: number }> {
    const out = new Map<string, { rating: number; ratingScore: number | null; updatedAt: number }>();
    const rows = this.many<{ album_key: string; rating: number; rating_score: number | null; updated_at: number }>(
      `SELECT album_key, rating, rating_score, updated_at FROM album_ratings
        WHERE album_key IS NOT NULL ORDER BY updated_at ASC, rating_id ASC`,
    );
    for (const row of rows) {
      out.set(row.album_key, { rating: row.rating, ratingScore: row.rating_score, updatedAt: row.updated_at });
    }
    return out;
  }

  // The key a rating written for this album lives under: the explicit key if
  // the caller has one, else the album the pair stands for, else the key the
  // pair would get if such an album existed.
  private ratingKeyFor(albumArtist: string, album: string, key?: string | null): string {
    const given = String(key ?? '').trim();
    if (given) return given;
    return this.resolveAlbumKeys(albumArtist, album)[0] ?? keyForPair(albumArtist, album);
  }

  /**
   * Read the stored album rating. Returns null if the album has never been
   * rated. Independent of any per-track rating cascade — the previous "set
   * album rating" cascade overwrote each track's rating, losing the user's
   * per-song nuance. `albumKey` names the album outright; without it the pair
   * is matched to an album.
   */
  getAlbumRating(albumArtist: string, album: string, albumKey?: string | null): AlbumRating | null {
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
    const key = this.ratingKeyFor(a, b, albumKey);
    const row = this.one<{ rating: number; rating_score: number | null; updated_at: number }>(
      `SELECT rating, rating_score, updated_at FROM album_ratings
        WHERE album_key = ? ORDER BY updated_at DESC, rating_id DESC LIMIT 1`,
      [key],
    ) ?? this.one<{ rating: number; rating_score: number | null; updated_at: number }>(
      // A row written before it had a key (it gets one when the albums are grouped).
      `SELECT rating, rating_score, updated_at FROM album_ratings
        WHERE album_key IS NULL AND album_artist = ? COLLATE NOCASE AND album = ? COLLATE NOCASE`,
      [a, b],
    );
    if (!row) return null;
    return {
      albumKey: key,
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
  setAlbumRatingScore(albumArtist: string, album: string, score: number | null, albumKey?: string | null): AlbumRating | null {
    const a = (albumArtist ?? '').trim();
    const b = (album ?? '').trim();
    if (!a || !b) {
      throw new Error(
        `setAlbumRatingScore requires non-empty albumArtist and album (got albumArtist=${JSON.stringify(albumArtist)}, album=${JSON.stringify(album)})`,
      );
    }
    const key = this.ratingKeyFor(a, b, albumKey);
    const nextScore = normalizeTrackRatingScore(score);
    if (nextScore == null) {
      // Every row the album holds goes, or an older one would take over. A row
      // that has no key yet goes only if it is written under this very pair;
      // another album with the same pair keeps the rating it has.
      this.db.run(
        `DELETE FROM album_ratings
          WHERE album_key = ?
             OR (album_key IS NULL AND album_artist = ? COLLATE NOCASE AND album = ? COLLATE NOCASE)`,
        [key, a, b],
      );
      this.scheduleFlush();
      return null;
    }
    const nextStars = Math.max(0, Math.min(5, Math.round(nextScore / 20)));
    const now = Date.now();
    const holder = this.one<{ rating_id: number }>(
      `SELECT rating_id FROM album_ratings WHERE album_key = ? ORDER BY updated_at DESC, rating_id DESC LIMIT 1`,
      [key],
    ) ?? this.one<{ rating_id: number }>(
      // A row written before it had a key takes the key with the new score.
      `SELECT rating_id FROM album_ratings
        WHERE album_key IS NULL AND album_artist = ? COLLATE NOCASE AND album = ? COLLATE NOCASE
        ORDER BY updated_at DESC, rating_id DESC LIMIT 1`,
      [a, b],
    );
    if (holder) {
      this.db.run(
        `UPDATE album_ratings SET rating = ?, rating_score = ?, updated_at = ?, album_key = ? WHERE rating_id = ?`,
        [nextStars, nextScore, now, key, holder.rating_id],
      );
    } else {
      this.db.run(
        `INSERT INTO album_ratings (album_artist, album, rating, rating_score, updated_at, album_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [a, b, nextStars, nextScore, now, key],
      );
    }
    this.scheduleFlush();
    return {
      albumKey: key,
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
    // Analysis decodes the file with ffmpeg; one that is missing would only
    // fail, and come back at the head of the queue every time.
    const rows = this.many<{ id: number }>(
      `SELECT id FROM tracks WHERE dna_json IS NULL AND missing_since IS NULL
        ORDER BY (loved + rating + (rating_score IS NOT NULL)) DESC, mtime DESC LIMIT ?`,
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
    const index = this.buildDnaIndex();
    const scored: Array<{ id: number; score: number }> = [];
    for (const [otherId, otherDna] of index) {
      if (otherId === id) continue;
      const score = dnaCosineSimilarity(sourceDna, otherDna);
      scored.push({ id: otherId, score });
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

  // ── Eviland visual memory persistence ──────────────────────────────────────
  // Mirrors the DNA pattern (setTrackDna/getTrackDna at ~line 2665) intentionally,
  // including silent JSON-parse quarantine. Differences vs DNA:
  //   - Lives in its own table (track_visual_memory) — denormalized version +
  //     algo_version columns let stats queries skip JSON parsing for big libs.
  //   - ON DELETE CASCADE in the schema; sql.js doesn't enforce FKs, so
  //     pruneMissingTracks adds an explicit DELETE for these rows above.
  //   - All write paths end with scheduleFlush() (NOT flushSync) so the 800ms
  //     debounce can coalesce burst writes from the bridge's flush triggers.

  setTrackVisualMemory(id: number, plan: VisualMemoryPlan | null): boolean {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return false;
    if (plan == null) {
      this.db.run(`DELETE FROM track_visual_memory WHERE track_id = ?`, [trackId]);
      if (this.db.getRowsModified() <= 0) return false;
      // Stats cache is computed from track_visual_memory contents — any
      // write/clear here invalidates it. Mirrors the libraryHealthCache pattern.
      this.invalidateVisualMemoryStatsCache();
      this.scheduleFlush();
      return true;
    }
    if (!isValidVisualMemoryPlan(plan)) return false;
    const json = JSON.stringify(plan);
    const now = Date.now();
    this.db.run(
      `INSERT INTO track_visual_memory (track_id, plan_json, version, algo_version, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(track_id) DO UPDATE SET
         plan_json    = excluded.plan_json,
         version      = excluded.version,
         algo_version = excluded.algo_version,
         updated_at   = excluded.updated_at`,
      [trackId, json, plan.schema | 0, plan.algoVersion | 0, now],
    );
    this.invalidateVisualMemoryStatsCache();
    this.scheduleFlush();
    return true;
  }

  getTrackVisualMemory(id: number): VisualMemoryPlan | null {
    const trackId = Math.trunc(Number(id));
    if (!Number.isFinite(trackId) || trackId <= 0) return null;
    const row = this.one<{ plan_json: string | null }>(
      `SELECT plan_json FROM track_visual_memory WHERE track_id = ?`,
      [trackId],
    );
    if (!row?.plan_json) return null;
    try {
      const parsed = JSON.parse(row.plan_json);
      return isValidVisualMemoryPlan(parsed) ? parsed : null;
    } catch {
      // Quarantine the corrupt row the same way DNA does — silent null return
      // is the de-facto contract. The next write replaces the bad blob.
      return null;
    }
  }

  clearTrackVisualMemory(id: number): boolean {
    return this.setTrackVisualMemory(id, null);
  }

  /**
   * Purge every track's visual memory in one statement.
   *
   * SettingsView surfaces this behind a confirm dialog; the operation needs to
   * be O(1) round-trips because a 60k+ library would be unworkable as a loop
   * over clearTrackVisualMemory. Returns the count of removed rows. Calls
   * scheduleFlush so the debounce coalesces this with any in-flight writes.
   */
  clearAllVisualMemory(): number {
    this.db.run(`DELETE FROM track_visual_memory`);
    const removed = this.db.getRowsModified();
    if (removed > 0) {
      this.invalidateVisualMemoryStatsCache();
      this.scheduleFlush();
    }
    return removed;
  }

  getVisualMemoryStats(): VisualMemoryStats {
    // Cached result: SettingsView opens this with no debounce,
    // and the underlying scan is O(rows * blob size) of synchronous JSON
    // parsing on the main process. Same invalidation pattern as
    // libraryHealthCache and dnaIndexCache — null = recompute, otherwise
    // return-by-reference (the value is a plain {tracksWithMemory, …}
    // struct; mutations would corrupt the cache, so callers must treat it
    // as read-only).
    if (this.visualMemoryStatsCache) return this.visualMemoryStatsCache;
    const totalRow = this.one<{ count: number }>(
      `SELECT COUNT(*) as count FROM track_visual_memory`,
    );
    const tracksWithMemory = Number(totalRow?.count ?? 0);
    const oldestRow = this.one<{ updated_at: number | null }>(
      `SELECT MIN(updated_at) as updated_at FROM track_visual_memory`,
    );
    const oldestAt = oldestRow?.updated_at != null ? Number(oldestRow.updated_at) : null;

    // totalSections: sum of sections.length across plan blobs. sql.js can't run
    // json_array_length without the json1 extension, so we parse client-side.
    // Cached, so this only re-runs after a write/clear invalidates the entry.
    let totalSections = 0;
    if (tracksWithMemory > 0) {
      const rows = this.many<{ plan_json: string | null }>(
        `SELECT plan_json FROM track_visual_memory`,
      );
      for (const r of rows) {
        if (!r.plan_json) continue;
        try {
          const parsed = JSON.parse(r.plan_json);
          if (parsed && Array.isArray(parsed.sections)) totalSections += parsed.sections.length;
        } catch {
          /* skip corrupt */
        }
      }
    }

    const stats: VisualMemoryStats = { tracksWithMemory, totalSections, oldestAt };
    this.visualMemoryStatsCache = stats;
    return stats;
  }

  private invalidateVisualMemoryStatsCache(): void {
    this.visualMemoryStatsCache = null;
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
    // replaygain_*_db feed getLibraryHealth's ReplayGain-ready counts.
    this.invalidateLibraryHealthCache();
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
    // Same as recordSkip: a play can land after its track was removed.
    if (!this.one(`SELECT 1 FROM tracks WHERE id = ?`, [trackId])) return;
    const played = Math.max(0, Math.trunc(playedAt));
    this.db.run('BEGIN');
    try {
      // It just played, so the file is there: a missing mark from an earlier
      // outage goes now instead of waiting for a scan.
      this.db.run(
        `UPDATE tracks SET play_count = play_count + 1, last_played = ?, missing_since = NULL WHERE id = ?`,
        [played, trackId],
      );
      this.db.run(`INSERT INTO play_history (track_id, played_at) VALUES (?, ?)`, [trackId, played]);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    // Fires on every track change — slow tier so this never drives the 800ms
    // full-DB flush cadence on its own.
    this.scheduleFlush({ slow: true });
  }

  recordSkip(id: number, skippedAt = Date.now(), position = 0): void {
    const trackId = Math.trunc(id);
    // A skip can arrive for a track that was removed in the meantime; with no
    // row to belong to it would only leave an orphan behind.
    if (!this.one(`SELECT 1 FROM tracks WHERE id = ?`, [trackId])) return;
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
    // Fires on every skip — same slow tier as recordPlay, see there.
    this.scheduleFlush({ slow: true });
  }

  importListeningHistory(entries: HistoryImportEntry[]): HistoryImportReport {
    if (entries.length > HISTORY_IMPORT_MAX_ENTRIES) {
      throw new Error(`History import is limited to ${HISTORY_IMPORT_MAX_ENTRIES.toLocaleString()} entries per batch.`);
    }
    const report: HistoryImportReport = {
      imported: 0,
      duplicates: 0,
      unmatched: 0,
      ambiguous: 0,
      invalid: 0,
      total: entries.length,
      unmatchedSamples: [],
      ambiguousSamples: [],
      invalidSamples: [],
    };
    const index = this.buildHistoryImportIndex();
    const matched: MatchedHistoryImportEntry[] = [];

    entries.forEach((entry, indexInInput) => {
      const issueBase = entryToIssue(entry, entry.row ?? indexInInput + 1);
      const playedAt = Math.trunc(Number(entry.playedAt));
      if (!Number.isFinite(playedAt) || playedAt < 0) {
        report.invalid += 1;
        pushIssue(report.invalidSamples, { ...issueBase, reason: 'missing-or-invalid-timestamp', playedAt: null });
        return;
      }
      const match = matchHistoryImportEntry(entry, index);
      if (match.kind === 'missing') {
        report.unmatched += 1;
        pushIssue(report.unmatchedSamples, { ...issueBase, reason: 'no-library-match', playedAt });
        return;
      }
      if (match.kind === 'ambiguous') {
        report.ambiguous += 1;
        pushIssue(report.ambiguousSamples, { ...issueBase, reason: 'ambiguous-library-match', playedAt });
        return;
      }
      matched.push({ trackId: match.trackId, playedAt });
    });

    const existing = this.getExistingPlayImportKeys(matched);
    const pending = new Set<string>();
    const toInsert: MatchedHistoryImportEntry[] = [];
    for (const item of matched) {
      const key = historyImportPlayKey(item);
      if (existing.has(key) || pending.has(key)) {
        report.duplicates += 1;
        continue;
      }
      pending.add(key);
      toInsert.push(item);
    }

    if (!toInsert.length) return report;

    const byTrack = new Map<number, { count: number; lastPlayed: number }>();
    for (const item of toInsert) {
      const current = byTrack.get(item.trackId);
      if (!current) byTrack.set(item.trackId, { count: 1, lastPlayed: item.playedAt });
      else {
        current.count += 1;
        current.lastPlayed = Math.max(current.lastPlayed, item.playedAt);
      }
    }

    this.db.run('BEGIN');
    try {
      for (const item of toInsert) {
        this.db.run(`INSERT INTO play_history (track_id, played_at) VALUES (?, ?)`, [item.trackId, item.playedAt]);
      }
      for (const [trackId, summary] of byTrack) {
        this.db.run(
          `UPDATE tracks
              SET play_count = play_count + ?,
                  last_played = CASE
                    WHEN last_played IS NULL OR last_played < ? THEN ?
                    ELSE last_played
                  END
            WHERE id = ?`,
          [summary.count, summary.lastPlayed, summary.lastPlayed, trackId],
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    report.imported = toInsert.length;
    this.scheduleFlush({ slow: true });
    return report;
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
    const weekStart = startOfLocalDay(now, -6);
    const playRows = this.many<{
      track_id: number;
      played_at: number;
      artist: string;
      album: string;
      album_artist: string;
      album_key: string | null;
      album_display: string | null;
      album_artist_display: string | null;
      duration: number | null;
    }>(
      `SELECT h.track_id,
              h.played_at,
              t.artist,
              t.album,
              t.album_artist,
              t.album_key,
              t.album_display,
              t.album_artist_display,
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
      album_key: string | null;
      album_display: string | null;
      album_artist_display: string | null;
    }>(
      `SELECT h.track_id,
              h.skipped_at,
              t.artist,
              t.album,
              t.album_artist,
              t.album_key,
              t.album_display,
              t.album_artist_display
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

      // Named and counted the way the album grid has them, so the same album is the same line here.
      const album = row.album_display || row.album || 'Unknown Album';
      const albumArtist = row.album_artist_display || row.album_artist || artist;
      const albumKey = row.album_key ?? `${albumArtist}\u0000${album}`;
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

      // Named and counted the way the album grid has them, so the same album is the same line here.
      const album = row.album_display || row.album || 'Unknown Album';
      const albumArtist = row.album_artist_display || row.album_artist || artist;
      const albumKey = row.album_key ?? `${albumArtist}\u0000${album}`;
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
      const akey = `${albumArtist}\u0000${album}`;
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
      if (prevKey && Date.parse(`${key}T00:00:00Z`) - Date.parse(`${prevKey}T00:00:00Z`) === 86_400_000) {
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
  // data. No network, no upload, no account service needed.
  buildProfileBundleHtml(opts: { now?: number } = {}): string {
    const profile = this.getProfile();
    const lists = this.getLists().filter((list) => list.privacy === 'public')
      .map((l) => ({ ...l, items: this.listItems(l.id) }));
    const reviews = this.getReviews().filter((review) => review.privacy === 'public');
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

  private buildHistoryImportIndex(): HistoryImportIndex {
    const rows = this.many<HistoryImportTrackRow>(
      `SELECT id, path, artist, title, album FROM tracks WHERE path IS NOT NULL`,
    );
    const pathExact = new Map<string, HistoryImportTrackRow[]>();
    const pathNormalized = new Map<string, HistoryImportTrackRow[]>();
    const identity = new Map<string, HistoryImportTrackRow[]>();
    for (const row of rows) {
      const exactPath = historyImportExactPathKey(row.path);
      if (exactPath) addHistoryImportIndexBucket(pathExact, exactPath, row);
      const normalizedPath = normalizeHistoryImportPath(row.path);
      if (normalizedPath) addHistoryImportIndexBucket(pathNormalized, normalizedPath, row);
      const key = historyImportIdentityKey(row.artist, row.title);
      if (!key) continue;
      const bucket = identity.get(key);
      if (bucket) bucket.push(row);
      else identity.set(key, [row]);
    }
    return { pathExact, pathNormalized, identity };
  }

  private getExistingPlayImportKeys(entries: MatchedHistoryImportEntry[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < entries.length; i += 250) {
      const slice = entries.slice(i, i + 250);
      if (!slice.length) continue;
      const params: unknown[] = [];
      const where = slice.map((entry) => {
        params.push(entry.trackId, entry.playedAt);
        return '(track_id = ? AND played_at = ?)';
      });
      const rows = this.many<{ track_id: number; played_at: number }>(
        `SELECT track_id, played_at FROM play_history WHERE ${where.join(' OR ')}`,
        params,
      );
      for (const row of rows) out.add(historyImportPlayKey({ trackId: row.track_id, playedAt: row.played_at }));
    }
    return out;
  }

  // Cover buffers keyed by content hash — the hash IS the file name, so a
  // cached entry can never go stale; eviction is purely a memory cap.
  private readonly artBufferCache = new Map<string, { mime: string; data: Buffer }>();
  private artBufferCacheBytes = 0;
  private static readonly ART_CACHE_MAX_BYTES = 48 * 1024 * 1024;

  getArt(trackId: number): { mime: string; data: Buffer } | null {
    const artHash = this.resolveArtHash(trackId);
    if (!artHash) return null;
    const cached = this.takeCachedArt(artHash);
    if (cached) return cached;
    // Find the file. We don't store mime in the DB, so probe common extensions.
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const p = join(this.artDir, `${artHash}${ext}`);
      if (existsSync(p)) {
        try {
          const data = readFileSync(p);
          return this.rememberArtBuffer(artHash, { mime: extToMime(ext), data });
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Async art read for the newart:// protocol. getArt blocks the single
   * main-process thread on disk (sql.js keeps every query there too), so a
   * burst of cover reads from the album grid can stall unrelated IPC like
   * get-album-tracks behind file IO. Only the SQL stays synchronous here —
   * it's an in-memory lookup.
   */
  async getArtAsync(trackId: number): Promise<{ mime: string; data: Buffer } | null> {
    const artHash = this.resolveArtHash(trackId);
    if (!artHash) return null;
    const cached = this.takeCachedArt(artHash);
    if (cached) return cached;
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const p = join(this.artDir, `${artHash}${ext}`);
      try {
        const data = await fsp.readFile(p);
        return this.rememberArtBuffer(artHash, { mime: extToMime(ext), data });
      } catch {
        continue; // wrong extension — probe the next one
      }
    }
    return null;
  }

  private resolveArtHash(trackId: number): string | null {
    const row = this.one<{ art_hash: string | null; album: string | null; album_key: string | null }>(
      `SELECT art_hash, album, album_key FROM tracks WHERE id = ?`,
      [trackId],
    );
    if (!row) return null;
    let artHash = row.art_hash;
    if (!artHash && row.album && row.album_key) {
      const fallback = this.one<{ art_hash: string | null }>(
        `SELECT art_hash
         FROM tracks
         WHERE album_key = ? AND art_hash IS NOT NULL AND art_hash != ''
         ORDER BY COALESCE(disc_inferred, disc_no, 1), COALESCE(track_no, 999999), id
         LIMIT 1`,
        [row.album_key],
      );
      artHash = fallback?.art_hash ?? null;
    }
    return artHash || null;
  }

  private takeCachedArt(artHash: string): { mime: string; data: Buffer } | null {
    const hit = this.artBufferCache.get(artHash);
    if (!hit) return null;
    // Refresh recency: Map iteration order doubles as the LRU order.
    this.artBufferCache.delete(artHash);
    this.artBufferCache.set(artHash, hit);
    return hit;
  }

  private rememberArtBuffer(
    artHash: string,
    art: { mime: string; data: Buffer },
  ): { mime: string; data: Buffer } {
    const existing = this.artBufferCache.get(artHash);
    if (existing) this.artBufferCacheBytes -= existing.data.byteLength;
    this.artBufferCache.delete(artHash);
    this.artBufferCache.set(artHash, art);
    this.artBufferCacheBytes += art.data.byteLength;
    while (this.artBufferCacheBytes > LibraryStore.ART_CACHE_MAX_BYTES && this.artBufferCache.size > 1) {
      const oldest = this.artBufferCache.keys().next().value;
      if (oldest == null) break;
      const evicted = this.artBufferCache.get(oldest);
      this.artBufferCache.delete(oldest);
      if (evicted) this.artBufferCacheBytes -= evicted.data.byteLength;
    }
    return art;
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

  // Destructive: these tracks leave the library with their plays, skips,
  // ratings, bookmarks, edits and playlist places. The explicit removals
  // (a trash, "Clean missing files") come through here after their backup,
  // by id, so no heuristic about the file's folder can keep a row the user
  // asked to drop. Returns the ids that were actually rows.
  removeTracksById(ids: number[]): number[] {
    const wanted = [...new Set(ids.map((id) => Math.trunc(Number(id))).filter((id) => id > 0))];
    const present: number[] = [];
    const chunkSize = 500;
    for (let i = 0; i < wanted.length; i += chunkSize) {
      const chunk = wanted.slice(i, i + chunkSize);
      for (const row of this.many<{ id: number }>(`SELECT id FROM tracks WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)) {
        present.push(row.id);
      }
    }
    if (!present.length) return [];

    this.db.run('BEGIN');
    try {
      for (const id of present) {
        this.db.run(`DELETE FROM playlist_tracks WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM play_history WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM skip_history WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM track_bookmarks WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM guitar_tab_cache WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM custom_lyrics WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM track_metadata_overrides WHERE track_id = ?`, [id]);
        this.db.run(`DELETE FROM track_metadata_adoption WHERE track_id = ?`, [id]);
        // sql.js does not enforce ON DELETE CASCADE foreign keys; we have to
        // delete the visual memory row explicitly so a vanished track doesn't
        // strand a plan blob in the database.
        this.db.run(`DELETE FROM track_visual_memory WHERE track_id = ?`, [id]);
        // Same for its tags, which would otherwise inflate the tag counts
        // until the next open drops them.
        this.db.run(`DELETE FROM track_tags WHERE track_id = ?`, [id]);
        // A list entry has no foreign key to the track. It stays in its list
        // as a free-text entry, titled after the track when it had no label.
        // Reviews are left alone on purpose: their target is whatever the user
        // typed (a title as often as an id), and the text is theirs to delete.
        this.db.run(
          `UPDATE list_items
              SET label = CASE WHEN label = '' THEN COALESCE((SELECT title FROM tracks WHERE id = ?), '') ELSE label END,
                  track_id = NULL
            WHERE track_id = ?`,
          [id, id],
        );
        this.db.run(`DELETE FROM tracks WHERE id = ?`, [id]);
      }
      this.windowsPathIdentities = null;
      this.invalidateDnaIndexCache();
      this.invalidateFolderTrackRowsCache();
      this.invalidateLibraryHealthCache();
      // The track_visual_memory rows went with the tracks, so the cached
      // section total is stale.
      this.invalidateVisualMemoryStatsCache();
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    // A folder that lost tracks can read as a different album (or a different
    // artist's), so the albums are grouped again.
    this.requestRegroup();
    this.scheduleFlush();
    return present;
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

// Exported with indexPruneTargets and matchesPruneTargets for the timing
// test; nothing outside this module uses them otherwise.
export function normalizePruneTargets(targets: string[] | undefined): PruneTarget[] {
  if (!targets?.length) return [];
  const out: PruneTarget[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    if (typeof target !== 'string' || !target.trim()) continue;
    const resolved = resolvePath(target);
    let kind: PruneTarget['kind'] = extname(resolved) ? 'file' : 'dir';
    let exists = false;
    try {
      const stat = statSync(resolved);
      kind = stat.isDirectory() ? 'dir' : 'file';
      exists = true;
    } catch {
      // Deleted watcher events often point at paths that no longer stat.
    }
    const key = normalizedPruneKey(resolved);
    const seenKey = `${kind}:${key}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    out.push({ kind, key, exists });
  }

  return out;
}

// Target keys as a Set, so a row costs one lookup per path segment rather
// than one comparison per target: the watcher, a prune and a trash all run
// this over every row, and 100k rows against a few thousand targets was
// seconds on the main thread.
export function indexPruneTargets(targets: PruneTarget[]): Set<string> {
  return new Set(targets.map((target) => target.key));
}

export function matchesPruneTargets(path: string, targets: Set<string>): boolean {
  if (!targets.size) return false;
  // A vanished directory can contain a dot and look like a filename. A
  // path-segment prefix is safe for both: real files have no descendants.
  let key = normalizedPruneKey(path);
  for (;;) {
    if (targets.has(key)) return true;
    const cut = key.lastIndexOf('/');
    if (cut < 0) return false;
    key = key.slice(0, cut);
  }
}

// The ids among these tracks whose file isn't there. Each folder is checked
// once before its files: a folder that is gone answers for every track in
// it, so a dropped share costs one stat per folder rather than one per file.
function absentTrackIds(rows: Array<{ id: number; path: string }>): number[] {
  const folderPresent = new Map<string, boolean>();
  const out: number[] = [];
  for (const row of rows) {
    const folder = dirname(row.path);
    let present = folderPresent.get(folder);
    if (present === undefined) {
      present = existsSync(folder);
      folderPresent.set(folder, present);
    }
    if (!present || !existsSync(row.path)) out.push(row.id);
  }
  return out;
}

function normalizedPruneKey(path: string): string {
  return foldPathCase(resolvePath(path).replace(/\\/g, '/').replace(/\/+$/g, ''));
}

// Windows and macOS volumes compare names without case by default; Linux
// ones don't, and folding there points one file's key at another file.
// Same policy as library-watcher.ts.
function foldPathCase(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
}

// A missing file only proves it was deleted when the storage it lived on is
// reachable at that path now. Unplugged drives, dropped shares, empty Linux
// mount points and junctions to an offline NAS all look like missing
// folders, so anything short of that proof is kept and counted offline:
//  - a library root that isn't there at all is an unplugged drive or dropped
//    share far more often than a deleted library: nothing under it counts;
//  - the file's own folder is still there, a real folder with other things
//    in it, on the device the file was on when last scanned (file_dev): the
//    file itself went. The same folder on another device is a drive letter
//    or mount point now used by a different volume, and a copy of a library
//    can have the same folder names without the file;
//  - a track under no configured library root can only be proven deleted by
//    its own folder, there and on the file's device: with nothing to bound
//    the search below, a folder further up (often the drive itself) proves
//    nothing. Renaming a root folder and pointing the root at the new name
//    leaves every track under the old name with no folder of its own;
//  - otherwise the nearest folder above it that still exists must not be a
//    link or junction, and must be on the device the file was on when last
//    scanned. A root that holds a separate mount (/media/$USER, /mnt) fails
//    this while that mount is gone, because what is left at the path belongs
//    to the parent filesystem;
//  - a track scanned before devices were recorded falls back to its library
//    root's device, and only for a populated folder strictly inside the root.
function missingFileIsConfirmedGone(
  track: { path: string; fileDev: number | null },
  roots: string[],
  cache: Map<string, DirectoryProbe | null>,
): boolean {
  const root = containingRoot(track.path, roots);
  const rootProbe = root ? probeDirectory(root, cache) : null;
  if (root && !rootProbe?.isDirectory) return false;

  const parent = dirname(track.path);
  const own = probeDirectory(parent, cache);
  if (own?.realDirectory && own.hasEntries && (track.fileDev == null || own.dev === track.fileDev)) return true;
  if (!root || !rootProbe) return !!own?.realDirectory && track.fileDev != null && own.dev === track.fileDev;

  let ancestor: DirectoryProbe | null = own;
  let dir = parent;
  while (!ancestor) {
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
    ancestor = probeDirectory(dir, cache);
  }
  // A link (or junction) whose target is gone reads as an existing entry with
  // nothing behind it: that is an offline target, not a deletion.
  if (!ancestor.realDirectory) return false;
  if (track.fileDev != null) return ancestor.dev === track.fileDev;

  return ancestor.hasEntries
    && ancestor.dev === rootProbe.dev
    && normalizedPruneKey(ancestor.path).startsWith(`${normalizedPruneKey(root)}/`);
}

interface DirectoryProbe {
  path: string;
  dev: number;
  // Resolves to a directory, links followed.
  isDirectory: boolean;
  // Not a symlink or junction, and it resolves.
  realDirectory: boolean;
  hasEntries: boolean;
}

// Null when nothing is at `dir` at all. A dangling link or junction is an
// entry that isn't a real directory.
function probeDirectory(dir: string, cache: Map<string, DirectoryProbe | null>): DirectoryProbe | null {
  if (cache.has(dir)) return cache.get(dir)!;
  let probe: DirectoryProbe | null = null;
  try {
    const link = lstatSync(dir);
    let stat: Stats | null = null;
    try {
      stat = statSync(dir);
    } catch {
      // dangling link
    }
    probe = {
      path: dir,
      dev: stat ? Number(stat.dev) : Number(link.dev),
      isDirectory: !!stat?.isDirectory(),
      realDirectory: !link.isSymbolicLink() && !!stat?.isDirectory(),
      hasEntries: false,
    };
    if (probe.realDirectory) {
      const handle = opendirSync(dir);
      try {
        probe.hasEntries = handle.readSync() !== null;
      } finally {
        handle.closeSync();
      }
    }
  } catch {
    probe = null;
  }
  cache.set(dir, probe);
  return probe;
}

function containingRoot(path: string, roots: string[]): string | null {
  const key = normalizedPruneKey(path);
  let best: string | null = null;
  let bestLength = -1;
  for (const candidate of roots) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const rootKey = normalizedPruneKey(candidate);
    if ((key === rootKey || key.startsWith(`${rootKey}/`)) && rootKey.length > bestLength) {
      best = candidate;
      bestLength = rootKey.length;
    }
  }
  return best;
}

function isTrackMetadataField(value: unknown): value is TrackMetadataField {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(METADATA_FIELD_COLUMNS, value);
}

const NUMERIC_METADATA_FIELDS = new Set<TrackMetadataField>(['year', 'trackNo', 'discNo']);

function parseMetadataJson(field: TrackMetadataField, json: string): MetadataValue {
  let value: unknown = null;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (NUMERIC_METADATA_FIELDS.has(field)) return typeof value === 'number' && Number.isFinite(value) ? value : null;
  return typeof value === 'string' ? value : null;
}

// What the scanner writes when a file's tags can't be read (scanner.ts
// readMeta/fallbackTrack): the title from the file name, 'Unknown Artist'.
// Adoption never takes such a value for an edit.
const FALLBACK_ARTIST = 'Unknown Artist';

function isFallbackValue(field: TrackMetadataField, value: MetadataValue, path: string): boolean {
  if (field === 'title') return value === basename(path, extname(path));
  if (field === 'artist' || field === 'albumArtist') return value === FALLBACK_ARTIST;
  return false;
}

function isFallbackRow(row: RawRow): boolean {
  return isFallbackValue('title', row.title, row.path)
    && row.artist === FALLBACK_ARTIST
    && !row.album
    && (row.album_artist === FALLBACK_ARTIST || !row.album_artist)
    && row.genre == null
    && row.year == null
    && row.track_no == null
    && row.disc_no == null;
}

// An empty text field reads as null from some tags and '' from others, and
// the NOT NULL columns store '' for a cleared value: all of them mean
// "nothing". The numeric fields never hold ''.
function sameMetadataValue(a: MetadataValue | undefined, b: MetadataValue | undefined): boolean {
  return emptyAsNull(a) === emptyAsNull(b);
}

function emptyAsNull(value: MetadataValue | undefined): MetadataValue {
  return value === '' || value == null ? null : value;
}

// Adoption can't tell an old edit from a value an older reader (or another
// tagger) spelled differently, so it sets aside differences that are only
// letter case, surrounding or repeated whitespace, Unicode normalization form
// (decomposed accents, as macOS and some taggers write them), empty versus
// missing, and for genres the separator between several ("Rock/Pop",
// "Rock; Pop"). Those are far more often the reader than the user, and
// pinning one as an edit would stop the field following its file for good.
function isReadingVariant(field: TrackMetadataField, a: MetadataValue, b: MetadataValue): boolean {
  if (NUMERIC_METADATA_FIELDS.has(field)) return false;
  return readingKey(field, a) === readingKey(field, b);
}

function readingKey(field: TrackMetadataField, value: MetadataValue): string {
  const key = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return field === 'genre' ? key.replace(/\s*[;,/|]\s*/g, ';') : key;
}

// What the tracks column stores for a field's value: the NOT NULL text
// columns hold '' where a cleared value is null.
function metadataColumnValue(field: TrackMetadataField, value: MetadataValue): MetadataValue {
  if (NOT_NULL_TEXT_FIELDS.has(field)) return value == null ? '' : String(value);
  return value;
}

function assignMetadataValue(target: IncomingTrack, field: TrackMetadataField, value: MetadataValue): void {
  (target as unknown as Record<TrackMetadataField, MetadataValue>)[field] = metadataColumnValue(field, value);
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

function matchHistoryImportEntry(
  entry: HistoryImportEntry,
  index: HistoryImportIndex,
): { kind: 'matched'; trackId: number } | { kind: 'missing' } | { kind: 'ambiguous' } {
  const exactPath = historyImportExactPathKey(entry.path);
  if (exactPath) {
    const exactMatches = index.pathExact.get(exactPath) ?? [];
    if (exactMatches.length === 1) return { kind: 'matched', trackId: exactMatches[0]!.id };
    if (exactMatches.length > 1) return { kind: 'ambiguous' };

    const normalizedPath = normalizeHistoryImportPath(entry.path);
    const normalizedMatches = normalizedPath ? index.pathNormalized.get(normalizedPath) ?? [] : [];
    if (normalizedMatches.length === 1) return { kind: 'matched', trackId: normalizedMatches[0]!.id };
    if (normalizedMatches.length > 1) return { kind: 'ambiguous' };
  }

  const identityKey = historyImportIdentityKey(entry.artist, entry.title);
  if (!identityKey) return { kind: 'missing' };
  const candidates = index.identity.get(identityKey) ?? [];
  if (!candidates.length) return { kind: 'missing' };
  const albumKey = normalizeHistoryImportText(entry.album);
  const narrowed = albumKey
    ? candidates.filter((candidate) => normalizeHistoryImportText(candidate.album) === albumKey)
    : candidates;
  if (narrowed.length === 1) return { kind: 'matched', trackId: narrowed[0]!.id };
  if (narrowed.length > 1 || candidates.length > 1) return { kind: 'ambiguous' };
  return { kind: 'missing' };
}

function historyImportExactPathKey(value: string | null | undefined): string | null {
  const path = String(value ?? '').trim().replace(/\\/g, '/');
  return path || null;
}

function addHistoryImportIndexBucket(
  index: Map<string, HistoryImportTrackRow[]>,
  key: string,
  row: HistoryImportTrackRow,
): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(row);
  else index.set(key, [row]);
}

function historyImportIdentityKey(artist: string | null | undefined, title: string | null | undefined): string | null {
  const normalizedArtist = normalizeHistoryImportText(artist);
  const normalizedTitle = normalizeHistoryImportText(title);
  return normalizedArtist && normalizedTitle ? `${normalizedArtist}\0${normalizedTitle}` : null;
}

function historyImportPlayKey(entry: MatchedHistoryImportEntry): string {
  return `${entry.trackId}\0${entry.playedAt}`;
}

function entryToIssue(entry: HistoryImportEntry, row: number): HistoryImportIssue {
  return {
    row,
    reason: 'unknown',
    artist: entry.artist ?? null,
    title: entry.title ?? null,
    album: entry.album ?? null,
    path: entry.path ?? null,
    playedAt: Number.isFinite(Number(entry.playedAt)) ? Math.trunc(Number(entry.playedAt)) : null,
  };
}

function pushIssue(samples: HistoryImportIssue[], issue: HistoryImportIssue): void {
  if (samples.length < 10) samples.push(issue);
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

// The ORDER BY of the album list. It names the list's own result columns:
// sort_artist (the album artist's sort name, without a leading "The"), album,
// year, duration and track_count.
export function albumSortOrder(sort: string | undefined, randomSeed: number | undefined): string {
  const artistOrder = 'sort_artist, year IS NULL, year, album COLLATE NOCASE';
  switch (sort) {
    case 'album':
      return 'album COLLATE NOCASE, sort_artist, year IS NULL, year';
    case 'year-desc':
      return 'year IS NULL, year DESC, sort_artist, album COLLATE NOCASE';
    case 'year-asc':
      return 'year IS NULL, year ASC, sort_artist, album COLLATE NOCASE';
    case 'recent':
      return 'MAX(mtime) DESC, sort_artist, album COLLATE NOCASE';
    case 'plays':
      return 'SUM(play_count) DESC, MAX(last_played) DESC, sort_artist, album COLLATE NOCASE';
    case 'duration':
      return 'duration DESC, sort_artist, album COLLATE NOCASE';
    case 'tracks':
      return 'track_count DESC, duration DESC, sort_artist, album COLLATE NOCASE';
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
      ) % 2147483647, MAX(id) % 9973, sort_artist, album COLLATE NOCASE`;
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
      // Only \" and \\ are escapes; any other backslash is literal, so a
      // typed Windows path like path:"D:\Music\To Listen" keeps its separators.
      if (ch !== quote && ch !== '\\') current += '\\';
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

  if (escaping) current += '\\';
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
    // Tags are searched in their folded columns. The path is matched as typed:
    // LIKE already ignores ASCII case, which is all lower() ever did to it.
    const folded = foldedLikeParam(term);
    where.push(
      `(title_fold LIKE ? ESCAPE '|' OR artist_fold LIKE ? ESCAPE '|' OR album_fold LIKE ? ESCAPE '|' OR genre_fold LIKE ? ESCAPE '|' OR path LIKE ? ESCAPE '|')`,
    );
    params.push(folded, folded, folded, folded, likeParam(term));
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

  if (field === 'title') return pushTextFilter(where, params, 'title_fold', value);
  if (field === 'artist') return pushTextFilter(where, params, 'artist_fold', value);
  if (field === 'album') return pushTextFilter(where, params, 'album_fold', value);
  if (field === 'albumartist') return pushTextFilter(where, params, 'album_artist_fold', value);
  if (field === 'genre') return pushTextFilter(where, params, 'genre_fold', value);
  if (field === 'path') {
    // Either separator matches either: stored paths are native to the OS.
    where.push(`replace(lower(path), '\\', '/') LIKE ? ESCAPE '|'`);
    params.push(likeParam(value.replace(/\\/g, '/')));
    return;
  }
  if (field === 'format' || field === 'ext') {
    const ext = value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;
    where.push(`lower(path) LIKE ? ESCAPE '|'`);
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

// column is one of the folded search columns.
function pushTextFilter(where: string[], params: unknown[], column: string, value: string): void {
  where.push(`${column} LIKE ? ESCAPE '|'`);
  params.push(foldedLikeParam(value));
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
  // An .m4a or .mka can hold either family; the codec flag a scan stored
  // settles the ones it has read (see classifyAudioQuality).
  const containerLossless = extensionSetSql(CONTAINER_AUDIO_EXTENSIONS);
  const containerWith = (lossless: 0 | 1): string => `(${containerLossless.sql} AND codec_lossless = ${lossless})`;
  if (key === 'lossless') {
    const extWhere = extensionSetSql([...PCM_LOSSLESS_EXTENSIONS, ...DSD_EXTENSIONS]);
    where.push(`(${extWhere.sql} OR ${containerWith(1)})`);
    params.push(...extWhere.params, ...containerLossless.params);
    return;
  }
  if (key === 'lossy') {
    const extWhere = extensionSetSql(LOSSY_EXTENSIONS);
    where.push(`(${extWhere.sql} OR ${containerWith(0)})`);
    params.push(...extWhere.params, ...containerLossless.params);
    return;
  }
  if (key === 'dsd') return pushExtensionSetFilter(where, params, DSD_EXTENSIONS);
  if (key === 'fallback' || key === 'ffmpeg' || key === 'ffmpeg-fallback') {
    // So does a container whose first track is not one Chromium decodes
    // (Apple Lossless, AC-3, ...); see containerCodecNeedsFfmpeg.
    const extWhere = extensionSetSql(FFMPEG_FALLBACK_EXTENSIONS);
    const firstTrack = `lower(CASE WHEN instr(codec, '+') > 0 THEN substr(codec, 1, instr(codec, '+') - 1) ELSE codec END)`;
    const notChromium = ['aac', 'mp4a', 'mp3', 'layer 3', 'layer3', 'flac', 'opus']
      .map((name) => `${firstTrack} NOT LIKE '%${name}%'`)
      .join(' AND ');
    where.push(`(${extWhere.sql} OR (${containerLossless.sql} AND codec IS NOT NULL AND trim(${firstTrack}) != '' AND ${notChromium}))`);
    params.push(...extWhere.params, ...containerLossless.params);
    return;
  }
  if (key === 'low' || key === 'low-bitrate') {
    const extWhere = extensionSetSql(LOSSY_EXTENSIONS);
    where.push(`bitrate IS NOT NULL AND bitrate > 0 AND bitrate < 192000 AND (${extWhere.sql} OR ${containerWith(0)})`);
    params.push(...extWhere.params, ...containerLossless.params);
    return;
  }
  if (key === 'hires' || key === 'hi-res') {
    const dsdWhere = extensionSetSql(DSD_EXTENSIONS);
    const losslessWhere = extensionSetSql(PCM_LOSSLESS_EXTENSIONS);
    where.push(
      `(${dsdWhere.sql} OR (sample_rate IS NOT NULL AND sample_rate >= 88200 AND (${losslessWhere.sql} OR ${containerWith(1)})))`,
    );
    params.push(...dsdWhere.params, ...losslessWhere.params, ...containerLossless.params);
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
    sql: `(${unique.map(() => `lower(path) LIKE ? ESCAPE '|'`).join(' OR ')})`,
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
    // missing:file lists what the library watcher found gone; has:file the rest.
    file: `missing_since IS NOT NULL`,
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
  return foldPathCase(path.replace(/\\/g, '/'));
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
  if (!first) return null;
  // A POSIX path keeps its leading separator. Without it the derived root is
  // "home" rather than "/home", which contains none of its own tracks, and
  // the Folders view comes up empty for a library with no configured roots.
  return compact.startsWith('\\') ? `\\${first}` : first;
}

function trackPathIsInFolder(path: string, folder: string, recursive: boolean): boolean {
  const trackFolder = folderOfTrackPath(path);
  if (!trackFolder) return false;
  if (foldersEqual(trackFolder, folder)) return true;
  return recursive && folderIsInside(trackFolder, folder);
}

function folderTrackPathPrefixParam(folder: string): string {
  // sqlLower, not folderKey: this one is handed to SQL. trackPathIsInFolder
  // still makes the final call on every row the prefix lets through.
  const normalized = trimFolderTrailingSlash(normalizeFolderPath(folder) ?? folder);
  return `${escapeFolderLikePattern(sqlLower(normalized))}\\%`;
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

// Windows and macOS treat "Rock" and "rock" as one folder. Linux does not:
// they are two directories, with two sets of tracks, and folding them here
// merged them in the Folders view and made a folder playlist for one pull the
// other's tracks too.
const FOLDER_PATHS_ARE_CASE_SENSITIVE = process.platform !== 'win32' && process.platform !== 'darwin';

function folderKey(path: string): string {
  const normalized = trimFolderTrailingSlash(normalizeFolderPath(path) ?? path);
  return FOLDER_PATHS_ARE_CASE_SENSITIVE ? normalized : normalized.toLowerCase();
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

// SQLite's lower() folds A-Z and nothing else, so a parameter folded in JS
// can never match a row that lower() left alone: searching for a folder named
// "Olafur Arnalds" works and "Ólafur Arnalds" returns nothing at all, because
// the query became "ólafur" while the column stayed "Ólafur". Fold parameters
// the way SQLite does. Comparisons made in JS (trackPathIsInFolder, folderKey)
// keep full case folding; they see both sides.
function sqlLower(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function likeParam(value: string): string {
  return `%${escapeLike(sqlLower(value))}%`;
}

const FOLD_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿]+/g;
const FOLD_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ħ: 'h',
  ı: 'i',
  // A capital sigma lower-cases to the final form at the end of a word, so a
  // typed prefix of "ΟΔΥΣΣΕΑΣ" would end in ς where the stored word has σ.
  ς: 'σ',
};

// Search text: compatibility forms and accents folded away and lower-cased
// with full Unicode rules, so "bjork" finds "Björk" and "ÓLAFUR" finds
// "Ólafur" (SQLite's lower() only folds A-Z). Marks outside the Latin,
// Greek and Cyrillic diacritic blocks stay, so kana voicing marks and
// Indic or Arabic vowel signs still tell words apart, and the text is put
// back together afterwards: a decomposed が would otherwise start with a bare
// か, and 하 would match every syllable that begins with it. Russian й is its
// own letter ("мой" is not "мои"); ё still folds to е, as people type it.
// Stored in the *_fold columns, and applied to the typed query the same way.
export function foldSearchText(value: string | null | undefined): string {
  if (!value) return '';
  if (/^[\x00-\x7f]*$/.test(value)) return value.toLowerCase();
  return value
    .normalize('NFKD')
    .replace(/([Ии])̆/g, (_, base: string) => (base === 'И' ? 'Й' : 'й'))
    .replace(FOLD_MARKS, '')
    .toLowerCase()
    .replace(/[ßæœøđðþłħıς]/g, (ch) => FOLD_LETTERS[ch] ?? ch)
    .normalize('NFC');
}

function foldedLikeParam(value: string): string {
  return `%${escapeLike(foldSearchText(value))}%`;
}

// What an upsert needs to know about the row it is about to update, to tell
// whether the grouping inputs moved.
interface PriorIdentityRow {
  path: string;
  album: string;
  artist: string;
  album_artist: string;
  album_artist_tag: string | null;
  compilation: number;
  disc_no: number | null;
  year: number | null;
  album_artist_sort: string | null;
  artist_sort: string | null;
  scan_schema: number;
  album_key: string | null;
}

// The album, artist or album artist moved: the key the row holds no longer
// describes it, so it starts over from the plain grouping.
function identityNeedsReset(prior: PriorIdentityRow, next: IncomingTrack): boolean {
  return prior.album !== next.album || prior.artist !== next.artist || prior.album_artist !== next.albumArtist;
}

// How long a change waits for more changes before the albums are regrouped.
const REGROUP_DEBOUNCE_MS = 2000;
// An edit made by hand is waited on, so its albums regroup sooner.
const EDIT_REGROUP_DELAY_MS = 250;

// Every character String.prototype.trim() removes. SQL's TRIM(x) takes off
// spaces only, so a title of a lone tab looked unkeyed to SQL, blank to the
// grouping pass, and made every launch regroup the whole library.
const JS_WHITESPACE_SQL = `char(${[
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239,
  8287, 12288, 65279,
].join(',')})`;

interface AlbumGroupRow {
  album_key: string;
  album: string;
  album_artist: string;
  album_kind: string | null;
  album_reason: string | null;
  year: number | null;
  sort_artist: string | null;
  track_count: number;
  duration: number;
  art_track: number | null;
  matched_track?: number;
  matched_titles?: string | null;
}

function normalizeAlbumKind(kind: string | null | undefined): AlbumKind {
  return kind === 'compilation' || kind === 'bucket' || kind === 'split' ? kind : 'album';
}

// Anything the grouping pass reads changed, so another pass is due.
function identityInputsChanged(prior: PriorIdentityRow, next: IncomingTrack): boolean {
  if (identityNeedsReset(prior, next)) return true;
  if (prior.disc_no !== (next.discNo ?? null) || prior.year !== (next.year ?? null)) return true;
  const tags = next.tags;
  if (!tags) return false;
  return prior.scan_schema < SCAN_SCHEMA_VERSION
    || prior.album_artist_tag !== tags.albumArtistTag
    || (prior.compilation === 1) !== tags.compilation
    || prior.album_artist_sort !== tags.albumArtistSort
    || prior.artist_sort !== tags.artistSort;
}

// The rating and play count a reading carries in its tags, as the values a
// new row starts with. imported says there was anything to consider at all.
function fileStatsSeed(r: IncomingTrack): { rating: number; ratingScore: number | null; playCount: number; imported: 0 | 1 } {
  const score = normalizeTrackRatingScore(r.fileRatingScore);
  const stars = score == null ? 0 : Math.max(0, Math.min(5, Math.round(score / 20)));
  const plays = Number(r.filePlayCount);
  const playCount = Number.isFinite(plays) && plays > 0 ? Math.min(Math.trunc(plays), 1_000_000) : 0;
  return {
    rating: stars,
    ratingScore: stars > 0 ? score : null,
    playCount,
    imported: stars > 0 || playCount > 0 ? 1 : 0,
  };
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
  // Escape with '|' (the folder browser's convention) so every consumer can
  // pair its pattern with an `ESCAPE '|'` clause. Without that clause SQLite
  // treats the escape character literally and '%'/'_' stay wildcards.
  return value.replace(/[|%_]/g, (ch) => `|${ch}`);
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
    // Stored as the OS writes it (shown in the UI); runFolderRule normalizes.
    folderPath: typeof input.folderPath === 'string' && input.folderPath.trim() ? input.folderPath.trim() : null,
    notPlayedSinceMs: finiteNumber(input.notPlayedSinceMs),
    dnaEnergyTarget: clamp01OrNull(input.dnaEnergyTarget),
    dnaBrightnessTarget: clamp01OrNull(input.dnaBrightnessTarget),
  };
}

function clamp01OrNull(value: number | null | undefined): number | null {
  const n = finiteNumber(value);
  return n == null ? null : Math.min(1, Math.max(0, n));
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
    rule.folderPath,
  ];
}

function smartRuleWhere(rule: SmartPlaylistRule): { where: string; params: unknown[] } {
  // Generated sets feed Auto DJ and queues: an unavailable file can't play.
  const where: string[] = ['avoid_auto_play = 0', 'missing_since IS NULL'];
  const params: unknown[] = [];
  const genreWords = (rule.genreQuery ?? '')
    .split(/[,\s]+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);

  if (genreWords.length) {
    where.push(`(${genreWords.map(() => `genre_fold LIKE ? ESCAPE '|'`).join(' OR ')})`);
    params.push(...genreWords.map((word) => foldedLikeParam(word)));
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
  if (rule.notPlayedSinceMs != null) {
    // "Haven't played since X": never-played counts too.
    where.push('(last_played IS NULL OR last_played < ?)');
    params.push(rule.notPlayedSinceMs);
  }

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
  if (!track.album) return 0;
  const key = track.albumKey ?? (track.albumArtist ? keyForPair(track.albumArtist, track.album) : null);
  if (!key) return 0;
  const score = context.albumRatingScores.get(key);
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
  return !track.avoidAutoPlay && !track.missingSince && !!track.path && (track.duration == null || track.duration > 20);
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

function startOfLocalDay(value: number, dayOffset = 0): number {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset).getTime();
}

function wrappedWindow(range: WrappedRange, now: number): { start: number; end: number; label: string } {
  const d = new Date(now);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  switch (range) {
    case 'day':
      return { start: startOfLocalDay(now), end: now, label: 'Today' };
    case 'week':
      return { start: startOfLocalDay(now, -6), end: now, label: 'This Week' };
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
