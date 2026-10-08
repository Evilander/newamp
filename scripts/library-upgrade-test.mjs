// Library upgrades must never cost a user their library.
//  - A v1.0.0 library.db (the real v1.0.0 SCHEMA, below) opens with its plays,
//    ratings, loves, history, bookmarks and playlists intact. It used to fail
//    with "no such column: avoid_auto_play" — SCHEMA indexed the column before
//    the migration added it — and got quarantined as corrupt, leaving an empty
//    library.
//  - An upgraded library and a brand-new one end up with the same columns and
//    indexes, so a column added to SCHEMA without a migration (or the other
//    way round) fails here instead of on someone's upgrade.
//  - Metadata edits made before edits were tracked are adopted, once, on the
//    first read of each file that is unchanged since its last scan; a file
//    retagged since then keeps its new tags.
//  - A valid file whose upgrade fails anyway is left byte-for-byte untouched,
//    the session runs on a temporary library that is never written, and the
//    next launch (with the failure gone) opens the original with its data.
// Run: npm run build:electron && node scripts/library-upgrade-test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-upgrade-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const SQL = await initSqlJs();

// electron/library.ts SCHEMA as shipped in v1.0.0 (git a8e1a0e, the parent of
// 3d89705 "Add Auto DJ track avoidance"): no rating_score, no avoid_auto_play,
// no library_meta, no album_ratings, no folder smart rules.
const V1_0_SCHEMA = `
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

const sha1 = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');
const siblings = (dir) => readdirSync(dir).filter((name) => /\.corrupt-|\.tmp/.test(name));

function shapeOf(dbPath) {
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    const tables = db
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)[0]
      .values.map(([name]) => name);
    const columns = Object.fromEntries(
      tables.map((table) => [
        table,
        db.exec(`PRAGMA table_info(${table})`)[0].values.map(([, name]) => name).sort(),
      ]),
    );
    const indexes = db
      .exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`)[0]
      .values.map(([name]) => name);
    return { columns, indexes };
  } finally {
    db.close();
  }
}

// 1. A v1.0.0 library upgrades in place with everything in it.
const v1Path = join(root, 'v1', 'library.db');
{
  await mkdir(join(root, 'v1'), { recursive: true });
  const old = new SQL.Database();
  old.exec(V1_0_SCHEMA);
  old.run(
    `INSERT INTO tracks (path, title, artist, album, album_artist, loved, rating, play_count, last_played, skip_count, size, mtime)
     VALUES ('/music/old.flac', 'Persist me', 'Artist', 'Album', 'Artist', 1, 5, 42, 1700000000000, 3, 4096, 1690000000000)`,
  );
  old.run(
    `INSERT INTO tracks (path, title, artist, album, album_artist, size, mtime)
     VALUES ('/music/second.flac', 'Second', 'Artist', 'Album', 'Artist', 2048, 1690000000000)`,
  );
  old.run(`INSERT INTO play_history (track_id, played_at) VALUES (1, 1700000000000), (1, 1700000100000)`);
  old.run(`INSERT INTO skip_history (track_id, skipped_at, position) VALUES (2, 1700000200000, 12.5)`);
  old.run(`INSERT INTO track_bookmarks (track_id, position, label, created_at, updated_at) VALUES (1, 30, 'Solo', 1, 1)`);
  old.run(`INSERT INTO playlists (name, created_at, updated_at) VALUES ('Keep this', 1, 1)`);
  old.run(`INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 2, 0), (1, 1, 1)`);
  old.run(`INSERT INTO smart_rules (name, mood, count, created_at, updated_at) VALUES ('Old rule', 'focus', 20, 1, 1)`);
  writeFileSync(v1Path, old.export());
  old.close();

  for (const pass of ['upgrade', 'reopen']) {
    const lib = await LibraryStore.open(v1Path);
    try {
      assert.deepEqual(lib.recoveryEvents, [], `${pass}: a valid v1.0 library must not be quarantined`);
      assert.equal(lib.upgradeError, null, `${pass}: the v1.0 upgrade must succeed`);
      assert.equal(lib.getStats().tracks, 2, `${pass}: both tracks survive`);
      const kept = lib.getTrack(1);
      assert.equal(kept.title, 'Persist me');
      assert.equal(kept.playCount, 42);
      assert.equal(kept.rating, 5);
      assert.equal(kept.loved, 1);
      assert.equal(kept.skipCount, 3);
      assert.equal(kept.avoidAutoPlay, 0, 'the added column takes its default');
      assert.equal(kept.missingSince, null);
      assert.equal(lib.getListeningHistory({ limit: 10 }).length, 2, `${pass}: play history survives`);
      assert.deepEqual(lib.getTrackBookmarks(1).map((b) => b.label), ['Solo']);
      assert.deepEqual(lib.getPlaylistTracks(1).map((t) => t.id), [2, 1], `${pass}: playlist order survives`);
      assert.ok(lib.getSmartPlaylistRules().some((rule) => rule.name === 'Old rule'));
    } finally {
      lib.close();
    }
  }
  assert.deepEqual(siblings(join(root, 'v1')), [], 'no quarantine or temp files next to the upgraded library');
}

// 2. Upgraded and fresh libraries have the same shape.
{
  const freshPath = join(root, 'fresh', 'library.db');
  const fresh = await LibraryStore.open(freshPath);
  fresh.close();
  const upgraded = shapeOf(v1Path);
  const created = shapeOf(freshPath);
  assert.deepEqual(upgraded.columns, created.columns, 'every table must have the same columns after an upgrade as when created new');
  assert.deepEqual(upgraded.indexes, created.indexes, 'every index SCHEMA declares must exist after an upgrade');
  assert.ok(created.indexes.includes('idx_tracks_avoid_auto_play'));
  assert.ok(created.indexes.includes('idx_tracks_missing'));

  // A new library has nothing to adopt; the flag still records the step ran.
  const db = new SQL.Database(readFileSync(freshPath));
  assert.equal(db.exec('SELECT COUNT(*) FROM track_metadata_adoption')[0].values[0][0], 0);
  assert.equal(db.exec(`SELECT COUNT(*) FROM library_meta WHERE key = 'metadata_overrides_adoption_v1'`)[0].values[0][0], 1);
  db.close();
}

// 3. Edits made before overrides existed are adopted, not overwritten. The
//    v1.0 track's file is unchanged since its last scan (same size and
//    mtime), yet its stored title and cleared genre differ from what the file
//    says: those were in-app edits, and the first read must keep them. The
//    other track's file changed: it was retagged outside NewAmp, so its tags
//    win.
{
  const lib = await LibraryStore.open(v1Path);
  try {
    const fileSays = (overrides = {}) => ({
      ...incoming('/music/old.flac', 'Original Tag Title'),
      artist: 'Artist',
      album: 'Album',
      albumArtist: 'Artist',
      genre: 'Rock',
      year: null,
      trackNo: null,
      discNo: null,
      size: 4096,
      mtime: 1690000000000,
      ...overrides,
    });
    lib.upsertTracks([
      fileSays(),
      { ...incoming('/music/second.flac', 'Second (Remaster)'), artist: 'Artist', albumArtist: 'Artist', size: 2100, mtime: 1700000500000 },
    ]);
    const retagged = lib.getTrack(2);
    assert.equal(retagged.title, 'Second (Remaster)', 'a file retagged since its last scan wins over the stored value');
    assert.deepEqual(retagged.editedFields, []);
    const adopted = lib.getTrack(1);
    assert.equal(adopted.title, 'Persist me', 'a pre-upgrade title edit survives the first rescan');
    assert.equal(adopted.genre, null, 'a pre-upgrade cleared genre stays cleared');
    assert.deepEqual(adopted.editedFields, ['title', 'genre'], 'only fields that differ from the file are adopted');
    assert.equal(adopted.playCount, 42);
    assert.equal(adopted.rating, 5);

    // Adoption happens once per track: after it, unedited fields follow the file.
    lib.upsertTracks([fileSays({ title: 'Retagged Title', artist: 'Retagged Artist', size: 2 })]);
    const later = lib.getTrack(1);
    assert.equal(later.title, 'Persist me');
    assert.equal(later.artist, 'Retagged Artist', 'a field that matched the file at adoption follows later retags');
    assert.equal(lib.applyManualMetadataPatch(1, { resetToFile: ['title'] }).title, 'Retagged Title');

    // Tracks added after the upgrade are never adopted.
    lib.upsertTracks([incoming('/music/new.flac', 'First tag')]);
    lib.upsertTracks([{ ...incoming('/music/new.flac', 'Second tag'), size: 2 }]);
    const [added] = lib.getTracksByPaths(['/music/new.flac']);
    assert.equal(added.title, 'Second tag');
    assert.deepEqual(added.editedFields, []);
  } finally {
    lib.close();
  }
}

// 4. A valid library whose upgrade fails is left alone, and opens next launch.
{
  const dir = join(root, 'failed-upgrade');
  const failPath = join(dir, 'library.db');
  const seed = await LibraryStore.open(failPath);
  seed.upsertTracks([incoming('/music/precious.flac', 'Precious')]);
  const precious = seed.getTracks()[0];
  seed.setTrackRating(precious.id, 4);
  seed.recordPlay(precious.id);
  seed.savePlaylist({ name: 'Precious list', trackIds: [precious.id] });
  seed.close();

  // Stand-in for a bug in a future upgrade step: a trigger that aborts the
  // one-shot migration's write. The file itself is perfectly valid.
  {
    const db = new SQL.Database(readFileSync(failPath));
    db.run(`DELETE FROM library_meta WHERE key = 'metadata_overrides_adoption_v1'`);
    db.run(`CREATE TRIGGER simulated_upgrade_bug BEFORE INSERT ON library_meta BEGIN SELECT RAISE(ABORT, 'simulated upgrade bug'); END`);
    assert.equal(db.exec('PRAGMA quick_check')[0].values[0][0], 'ok');
    writeFileSync(failPath, db.export());
    db.close();
  }
  const before = sha1(failPath);
  const originalBytes = readFileSync(failPath);

  const session = await LibraryStore.open(failPath);
  try {
    assert.match(session.upgradeError ?? '', /simulated upgrade bug/, 'the failure is reported, not swallowed');
    assert.equal(session.recoveryEvents.length, 1);
    assert.equal(session.recoveryEvents[0].store, 'library');
    assert.equal(session.recoveryEvents[0].backupPath, failPath, 'the original stays where it is');
    assert.match(session.recoveryEvents[0].reason, /upgrade failed/);
    // The session is usable, on a temporary library.
    assert.equal(session.getStats().tracks, 0);
    session.upsertTracks([incoming('/music/session-only.flac', 'Session only')]);
    session.recordPlay(session.getTracks()[0].id);
    assert.ok(session.exportSnapshot().equals(originalBytes), 'a support backup taken now captures the real library');
    await session.flushPendingWrites();
  } finally {
    session.close();
  }
  assert.equal(sha1(failPath), before, 'library.db must be byte-for-byte untouched after a failed upgrade');
  assert.deepEqual(siblings(dir), [], 'nothing quarantined, no temp files');

  // Next launch, with the bug fixed: the original library opens with its data.
  {
    const db = new SQL.Database(readFileSync(failPath));
    db.run('DROP TRIGGER simulated_upgrade_bug');
    writeFileSync(failPath, db.export());
    db.close();
  }
  const fixed = await LibraryStore.open(failPath);
  try {
    assert.equal(fixed.upgradeError, null);
    assert.deepEqual(fixed.recoveryEvents, []);
    const [track] = fixed.getTracks();
    assert.equal(track.title, 'Precious');
    assert.equal(track.rating, 4);
    assert.equal(track.playCount, 1);
    assert.equal(fixed.getPlaylistTracks(fixed.getPlaylists()[0].id)[0].id, track.id);
    assert.equal(fixed.getTracksByPaths(['/music/session-only.flac']).length, 0, 'the temporary session was never written');
  } finally {
    fixed.close();
  }
}

await rm(root, { recursive: true, force: true });
console.log('[library-upgrade-test] ok: v1.0 upgrade keeps data, upgraded == fresh shape, failed upgrade leaves the file untouched');

function incoming(path, title) {
  return {
    path,
    title,
    artist: 'Upgrade Test',
    album: 'Upgrades',
    albumArtist: 'Upgrade Test',
    trackNo: 1,
    discNo: 1,
    year: 2026,
    genre: 'Test',
    duration: 200,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1,
    mtime: 1,
    art: null,
  };
}
