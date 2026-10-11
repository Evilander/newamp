// Removing a track must take its rows in every table that names it, and a play
// or skip recorded for a track that is gone must leave nothing behind. sql.js
// turns PRAGMA foreign_keys off the first time the database is exported, so
// after that ON DELETE CASCADE does nothing and the removal has to do it.
// Reviews are the exception: their target is text the user typed, and they stay.
// Run: npm run build:electron && node scripts/library-removal-children-test.mjs
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'library-removal-children-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const { LibraryStore } = await import(pathToFileURL(resolve('dist-electron/electron/library.js')).href);

function reading(path) {
  return {
    path,
    title: path.split(/[\\/]/).pop(),
    artist: 'Removal Test',
    album: 'Album',
    albumArtist: 'Removal Test',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: 100,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1,
    mtime: 1,
    art: null,
    dev: null,
  };
}

const CHILD_TABLES = [
  'play_history',
  'skip_history',
  'track_bookmarks',
  'guitar_tab_cache',
  'custom_lyrics',
  'playlist_tracks',
  'track_tags',
  'track_visual_memory',
  'track_metadata_overrides',
  'track_metadata_adoption',
];

function openLibrary(name) {
  return LibraryStore.open(join(root, name));
}

function count(library, sql, ...params) {
  const stmt = library.db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
    return Object.values(stmt.getAsObject())[0];
  } finally {
    stmt.free();
  }
}

const rowsFor = (library, id) =>
  Object.fromEntries(CHILD_TABLES.map((table) => [table, count(library, `SELECT COUNT(*) FROM ${table} WHERE track_id = ?`, id)]));

// One row per table for the track, as the app would have written them (the
// playlist places come from savePlaylist).
function giveChildren(library, id) {
  const now = Date.now();
  library.recordPlay(id);
  library.recordSkip(id, now, 12);
  library.db.run(`INSERT INTO track_bookmarks (track_id, position, label, created_at, updated_at) VALUES (?, 5, 'Here', ?, ?)`, [id, now, now]);
  library.db.run(
    `INSERT INTO guitar_tab_cache (track_id, url, title, artist, kind, document, created_at, updated_at) VALUES (?, 'https://example.test/tab', 't', 'a', 'tab', '{}', ?, ?)`,
    [id, now, now],
  );
  library.db.run(`INSERT INTO custom_lyrics (track_id, plain_lyrics, created_at, updated_at) VALUES (?, 'la', ?, ?)`, [id, now, now]);
  library.db.run(`INSERT OR IGNORE INTO track_tags (track_id, tag_name) VALUES (?, 'stray')`, [id]);
  library.db.run(`INSERT INTO track_visual_memory (track_id, plan_json, version, algo_version, updated_at) VALUES (?, '{}', 1, 1, ?)`, [id, now]);
  library.db.run(
    `INSERT INTO track_metadata_overrides (track_id, field, value_json, source_json, origin, updated_at) VALUES (?, 'title', '"x"', '"y"', 'manual', ?)`,
    [id, now],
  );
  library.db.run(`INSERT OR IGNORE INTO track_metadata_adoption (track_id) VALUES (?)`, [id]);
}

function foreignKeys(library) {
  return library.db.exec('PRAGMA foreign_keys')[0].values[0][0];
}

// --- removal by id, with enforcement off ---------------------------------------
{
  const library = await openLibrary('by-id.db');
  library.upsertTracks([reading(join(root, 'one.flac')), reading(join(root, 'two.flac'))]);
  const [one, two] = ['one.flac', 'two.flac'].map((name) => library.getTracksByPaths([join(root, name)])[0].id);
  const playlist = library.savePlaylist({ name: 'Keeps its place', trackIds: [one, two] });
  giveChildren(library, one);
  giveChildren(library, two);
  const list = library.saveList({ title: 'Favourites' });
  const unlabelled = library.addListItem({ listId: list.id, trackId: one });
  const labelled = library.addListItem({ listId: list.id, trackId: one, label: 'My label', note: 'kept' });
  const other = library.addListItem({ listId: list.id, trackId: two });
  const freeText = library.addListItem({ listId: list.id, trackId: null, label: 'Not a track' });
  const review = library.saveReview({ targetType: 'track', targetKey: 'one.flac', title: 'Mine', body: 'Worth keeping', rating: 80 });

  // The first export is what turns enforcement off for the rest of the session.
  library.exportSnapshot();
  assert.equal(foreignKeys(library), 0, 'export() leaves foreign keys off, so the cascade cannot be relied on');
  for (const table of CHILD_TABLES) assert.ok(rowsFor(library, one)[table] > 0, `fixture: ${table} has a row for the track`);

  assert.deepEqual(library.removeTracksById([one]), [one]);
  assert.deepEqual(
    rowsFor(library, one),
    Object.fromEntries(CHILD_TABLES.map((table) => [table, 0])),
    'nothing in any table still names the removed track',
  );
  for (const table of CHILD_TABLES) assert.ok(rowsFor(library, two)[table] > 0, `${table} keeps the other track's row`);

  const items = Object.fromEntries(library.getList(list.id).items.map((item) => [item.id, item]));
  assert.equal(items[unlabelled.id].trackId, null, 'a list entry on the track is detached');
  assert.equal(items[unlabelled.id].label, 'one.flac', 'and titled after the track when it had no label');
  assert.equal(items[labelled.id].trackId, null);
  assert.equal(items[labelled.id].label, 'My label', 'a label the user wrote stays');
  assert.equal(items[labelled.id].note, 'kept');
  assert.equal(items[other.id].trackId, two, 'an entry on another track is untouched');
  assert.equal(items[freeText.id].label, 'Not a track');
  assert.equal(library.getList(list.id).items.length, 4, 'no entry leaves its list');
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.id), [two]);
  assert.deepEqual(library.getReviews().map((entry) => entry.id), [review.id], 'a review the user wrote stays');

  // Another export, as the next flush would do, and nothing comes back.
  library.exportSnapshot();
  assert.equal(count(library, `SELECT COUNT(*) FROM track_tags WHERE track_id = ?`, one), 0);
  library.close();
}

// --- "Clean missing files" goes through the same removal ----------------------------
{
  const music = join(root, 'music');
  await mkdir(music, { recursive: true });
  await writeFile(join(music, 'kept.flac'), 'x');
  const gone = join(music, 'gone.flac');
  await writeFile(gone, 'x');
  const library = await openLibrary('prune.db');
  library.upsertTracks([reading(join(music, 'kept.flac')), reading(gone)]);
  const goneId = library.getTracksByPaths([gone])[0].id;
  const keptId = library.getTracksByPaths([join(music, 'kept.flac')])[0].id;
  const playlist = library.savePlaylist({ name: 'P', trackIds: [goneId, keptId] });
  giveChildren(library, goneId);
  const list = library.saveList({ title: 'L' });
  const item = library.addListItem({ listId: list.id, trackId: goneId });
  library.exportSnapshot();
  assert.equal(foreignKeys(library), 0);
  await rm(gone);

  const result = library.pruneMissingTracks(undefined, [music]);
  assert.deepEqual(result.removedIds, [goneId]);
  assert.deepEqual(rowsFor(library, goneId), Object.fromEntries(CHILD_TABLES.map((table) => [table, 0])));
  const detached = library.getList(list.id).items.find((entry) => entry.id === item.id);
  assert.equal(detached.trackId, null);
  assert.equal(detached.label, 'gone.flac');
  library.close();
}

// --- a play or a skip for a track that is gone --------------------------------------
{
  const library = await openLibrary('skips.db');
  library.upsertTracks([reading(join(root, 'skipped.flac'))]);
  const id = library.getTracksByPaths([join(root, 'skipped.flac')])[0].id;
  library.recordSkip(id, 1000, 7);
  assert.equal(library.getTrack(id).skipCount, 1, 'a skip on a track that exists is recorded');
  assert.equal(count(library, `SELECT COUNT(*) FROM skip_history WHERE track_id = ?`, id), 1);
  library.recordPlay(id, 1500);
  assert.equal(library.getTrack(id).playCount, 1, 'a play on a track that exists is recorded');
  assert.equal(count(library, `SELECT COUNT(*) FROM play_history WHERE track_id = ?`, id), 1);

  library.exportSnapshot();
  library.removeTracksById([id]);
  library.recordSkip(id, 2000, 9);
  library.recordSkip(987654);
  library.recordSkip(Number.NaN);
  library.recordPlay(id, 2500);
  library.recordPlay(987654);
  library.recordPlay(Number.NaN);
  assert.equal(count(library, `SELECT COUNT(*) FROM skip_history`), 0, 'no skip row for a track that no longer exists');
  assert.equal(count(library, `SELECT COUNT(*) FROM play_history`), 0, 'and no play row either');
  assert.equal(count(library, `SELECT COUNT(*) FROM tracks`), 0);
  library.close();
}

console.log('library-removal-children-test: ok');
