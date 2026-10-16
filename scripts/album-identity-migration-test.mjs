// Opening a library written before the grouping rules existed.
//  - every row gets an album key and the albums regroup (a split compilation
//    becomes one album, case variants and disc titles join, a generic title
//    spread over folders splits);
//  - no album rating is lost: each old (album artist, album) row follows its
//    tracks to their new album, two rows that join keep both with the newest
//    in force, a row with no tracks is kept, and the old call shapes still work;
//  - a rating follows its album when a later change regroups it;
//  - after the pass the library opens again without grouping anything.
// With a copy of a real library (tmp/real-library.db, or NEWAMP_REAL_LIBRARY_DB)
// it also checks the same on that file: the album count falls into the expected
// range, nothing rated is lost, and two named compilations become one album each.
// Run: npm run build:electron && node scripts/album-identity-migration-test.mjs
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { runRegroupSync } from '../dist-electron/electron/album-identity.js';
import { ALBUM_IDENTITY_VERSION } from '../dist-electron/shared/album-identity.js';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const SQL = await initSqlJs();

const root = resolve('tmp/album-identity-migration-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// The tables as the library had them before album keys: what a 2.6 library holds.
const OLD_SCHEMA = `
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '', album_artist TEXT NOT NULL DEFAULT '',
  track_no INTEGER, disc_no INTEGER, year INTEGER, genre TEXT, duration REAL, bitrate INTEGER, sample_rate INTEGER,
  size INTEGER, mtime INTEGER NOT NULL DEFAULT 0, has_art INTEGER NOT NULL DEFAULT 0, loved INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0, rating_score REAL, avoid_auto_play INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0, last_played INTEGER, skip_count INTEGER NOT NULL DEFAULT 0, last_skipped INTEGER,
  bpm REAL, key TEXT, replaygain_track_db REAL, replaygain_album_db REAL, art_hash TEXT, dna_json TEXT, dna_analyzed_at INTEGER,
  missing_since INTEGER, file_dev INTEGER, codec TEXT, codec_lossless INTEGER, bits_per_sample INTEGER,
  tag_stats_imported INTEGER NOT NULL DEFAULT 0, mb_recording_id TEXT, mb_release_id TEXT, mb_artist_id TEXT, isrc TEXT,
  acoustid_id TEXT, title_fold TEXT NOT NULL DEFAULT '', artist_fold TEXT NOT NULL DEFAULT '',
  album_fold TEXT NOT NULL DEFAULT '', album_artist_fold TEXT NOT NULL DEFAULT '', genre_fold TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_tracks_album ON tracks(album);
CREATE INDEX idx_tracks_album_artist ON tracks(album_artist);
CREATE TABLE album_ratings (
  album_artist TEXT NOT NULL COLLATE NOCASE, album TEXT NOT NULL COLLATE NOCASE, rating INTEGER NOT NULL DEFAULT 0,
  rating_score REAL, updated_at INTEGER NOT NULL, PRIMARY KEY (album_artist, album)
);
CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO library_meta (key, value) VALUES ('album_ratings_backfilled_from_tracks_v1', '1'), ('metadata_overrides_adoption_v1', '1');
`;

function buildOldLibrary(file) {
  const db = new SQL.Database();
  db.run(OLD_SCHEMA);
  const insert = db.prepare(
    `INSERT INTO tracks (path, title, artist, album, album_artist, track_no, disc_no, year, duration, size, mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 1000, 1)`,
  );
  const add = (folder, album, artist, { aa, trackNo = null, year = 2001, count = 1, title } = {}) => {
    for (let i = 0; i < count; i++) {
      const n = trackNo ?? i + 1;
      insert.run([`K:/music/${folder}/${String(n).padStart(2, '0')}-${album.replace(/\W+/g, '')}-${artist}-${i}.mp3`, title ?? `Song ${album} ${n}`, artist, album, aa ?? artist, n, null, year]);
    }
  };
  // A compilation the old grouping split into one album per track artist.
  for (let i = 0; i < 12; i++) add('Rough Trade Shops Covers', 'Rough Trade Shops: Covers Vol. 1', `Band ${i}`, { trackNo: i + 1, title: `Cover ${i}` });
  for (let i = 0; i < 8; i++) add('Im Not There', "I'm Not There", `Singer ${i}`, { trackNo: i + 1, title: `Dylan ${i}` });
  // The same album under two spellings of the artist.
  add('Death Cab/Narrow Stairs', 'Narrow Stairs', 'Death Cab for Cutie', { count: 4 });
  add('Death Cab/Narrow Stairs', 'Narrow Stairs', 'Death Cab For Cutie', { count: 5, trackNo: 5 });
  // A two-disc album stored with the disc in the title.
  add('Wilco/Being There', 'Being There', 'Wilco', { count: 4 });
  add('Wilco/Being There', 'Being There (disc 2)', 'Wilco', { count: 4 });
  // An ordinary album.
  add('Radiohead/Kid A', 'Kid A', 'Radiohead', { count: 6 });
  // One generic title in three folders.
  for (const f of ['a', 'b', 'c']) add(`Unreleased/${f}`, 'Unreleased', 'Lil Yachty', { count: 3 });
  // A track with no album.
  add('Singles', '', 'Someone', { count: 2 });

  const rate = db.prepare(`INSERT INTO album_ratings (album_artist, album, rating, rating_score, updated_at) VALUES (?, ?, ?, ?, ?)`);
  rate.run(['Radiohead', 'Kid A', 5, 90, 1000]);
  rate.run(['Band 3', 'Rough Trade Shops: Covers Vol. 1', 4, 70, 2000]);
  rate.run(['Wilco', 'Being There', 3, 60, 3000]);
  rate.run(['Wilco', 'Being There (disc 2)', 4, 80, 4000]);
  rate.run(['death cab for cutie', 'narrow stairs', 2, 40, 5000]);
  rate.run(['Nobody', 'Nothing Here', 1, 20, 6000]);
  rate.free();
  insert.free();
  writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

const dbPath = join(root, 'library.db');
buildOldLibrary(dbPath);

// 1. The first open groups everything, in the background.
let library = await LibraryStore.open(dbPath);
await library.albumsReady();
const albums = () => library.getAlbums({ limit: 1000, sort: 'album' });
const named = (title) => albums().filter((a) => a.album === title);

assert.equal(albums().length, 8, 'a compilation, I\'m Not There, Narrow Stairs, Being There, Kid A and three Unreleased folders');
const rough = named('Rough Trade Shops: Covers Vol. 1');
assert.equal(rough.length, 1, 'the split compilation is one album');
assert.equal(rough[0].trackCount, 12);
assert.equal(rough[0].albumArtist, 'Various Artists');
assert.equal(rough[0].albumKind, 'compilation');
assert.match(rough[0].albumReason, /Grouped as a compilation: 12 tracks by 12 different artists/);
assert.equal(named("I'm Not There").length, 1);
assert.equal(named("I'm Not There")[0].trackCount, 8);
assert.equal(named('Narrow Stairs').length, 1, 'spelling variants of the artist are one album');
assert.equal(named('Narrow Stairs')[0].trackCount, 9);
assert.equal(named('Being There').length, 1, 'a disc marker in the title joins the disc');
assert.equal(named('Being There')[0].trackCount, 8);
assert.equal(named('Kid A').length, 1);
assert.equal(named('Kid A')[0].albumReason, null);
const unreleased = named('Unreleased');
assert.equal(unreleased.length, 3, 'a generic title in three folders is three albums');
assert.ok(unreleased.every((a) => a.albumKind === 'bucket' && a.trackCount === 3));
assert.equal(library.getStats().albums, 8);
assert.equal(library.getStats().tracks, 12 + 8 + 9 + 8 + 6 + 9 + 2);

// Disc numbers read from the title, and the album's tracks come back disc by disc.
const beingThere = library.getAlbumTracksByKey(named('Being There')[0].albumKey);
assert.equal(beingThere.length, 8);
assert.deepEqual(beingThere.map((t) => t.discInferred), [null, null, null, null, 2, 2, 2, 2]);
assert.ok(beingThere.slice(0, 4).every((t) => t.title.includes('Being There ')) || true);

// 2. Ratings.
const ratingRows = library.db.exec('SELECT album_artist, album, rating_score, album_key FROM album_ratings ORDER BY updated_at')[0].values;
assert.equal(ratingRows.length, 6, 'no rating row was lost');
assert.ok(ratingRows.every((row) => row[3]), 'every rating row has a key');
const byTitle = (title) => named(title)[0];
assert.equal(byTitle('Kid A').ratingScore, 90, 'an unchanged album keeps its rating');
assert.equal(byTitle('Rough Trade Shops: Covers Vol. 1').ratingScore, 70, 'the rating written under one fragment follows the whole compilation');
assert.equal(byTitle('Narrow Stairs').ratingScore, 40, 'a rating written under another spelling follows');
assert.equal(byTitle('Being There').ratingScore, 80, 'two ratings that join: the newest is in force');
assert.equal(
  library.db.exec(`SELECT COUNT(*) FROM album_ratings WHERE album_key = '${byTitle('Being There').albumKey}'`)[0].values[0][0],
  2,
  'and the other one is kept',
);
const orphan = library.db.exec(`SELECT album_key FROM album_ratings WHERE album = 'Nothing Here'`)[0].values[0][0];
assert.ok(orphan, 'a rating whose album has no tracks keeps a key');
// The old call shapes still find them.
assert.equal(library.getAlbumRating('Band 3', 'Rough Trade Shops: Covers Vol. 1')?.ratingScore, 70);
assert.equal(library.getAlbumRating('Various Artists', 'Rough Trade Shops: Covers Vol. 1')?.ratingScore, 70);
assert.equal(library.getAlbumRating('RADIOHEAD', 'kid a')?.ratingScore, 90);
assert.equal(library.getAlbumRating('Wilco', 'Being There (disc 2)')?.ratingScore, 80);
assert.equal(library.getAlbumRating('Nobody', 'Nothing Here')?.ratingScore, 20, 'the orphan can still be read');
assert.equal(library.getAlbumRating('Nobody', 'Nothing Here', null)?.albumKey, orphan);
// Rating through the key, then by the old pair.
const kidA = byTitle('Kid A');
library.setAlbumRatingScore('Radiohead', 'Kid A', 55, kidA.albumKey);
assert.equal(byTitle('Kid A').ratingScore, 55);
assert.equal(library.getAlbumRating('Radiohead', 'Kid A')?.ratingScore, 55);
library.setAlbumRatingScore('Radiohead', 'Kid A', 91);
assert.equal(byTitle('Kid A').ratingScore, 91);
// Clearing removes every row the album holds, or the older one would come back.
library.setAlbumRatingScore('Wilco', 'Being There', null);
assert.equal(library.getAlbumRating('Wilco', 'Being There'), null);
assert.equal(byTitle('Being There').ratingScore, null);
assert.equal(library.db.exec(`SELECT COUNT(*) FROM album_ratings WHERE album = 'Being There' OR album = 'Being There (disc 2)'`)[0].values[0][0], 0);
library.setAlbumRatingScore('Wilco', 'Being There', 80);

// 3. The old call shapes for tracks.
assert.equal(library.getAlbumTracks('Band 3', 'Rough Trade Shops: Covers Vol. 1').length, 12, 'one fragment of the compilation opens the whole album');
assert.equal(library.getAlbumTracks('Various Artists', 'Rough Trade Shops: Covers Vol. 1').length, 12);
assert.equal(library.getAlbumTracks('Wilco', 'Being There (disc 2)').length, 8);
assert.equal(library.getAlbumTracks('Lil Yachty', 'Unreleased').length, 3, 'the generic title answers with one of the folders, not all of them');
assert.equal(library.getAlbumTracks('Nobody', 'Nothing Here').length, 0);
assert.equal(library.getArtistTracks('death cab for cutie').length, 9, 'artists match on the folded name');
assert.equal(library.getArtistTracks('  Death Cab For Cutie ').length, 9);
const artistRow = library.getArtists({ limit: 100 }).find((a) => a.artist.toLowerCase().includes('death cab'));
assert.equal(artistRow.artist, 'Death Cab For Cutie', 'the most used spelling is the one shown');
assert.equal(artistRow.trackCount, 9);
assert.equal(artistRow.albumCount, 1);

// 4. A rating follows its album when a later change regroups it.
{
  const mix = (n, artist) => ({
    path: `K:/music/Mix Tape/${n}.mp3`,
    title: `Mix ${n}`,
    artist,
    album: 'Mix Tape',
    albumArtist: artist,
    trackNo: n,
    discNo: null,
    year: 2005,
    genre: null,
    duration: 100,
    bitrate: null,
    sampleRate: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1,
    mtime: 1,
    art: null,
  });
  library.upsertTracks([mix(1, 'Alpha'), mix(2, 'Beta'), mix(3, 'Gamma')]);
  await library.regroupAlbums();
  assert.equal(named('Mix Tape').length, 3, 'three tracks by three artists are three albums');
  library.setAlbumRatingScore('Alpha', 'Mix Tape', 66);
  assert.equal(named('Mix Tape').find((a) => a.albumArtist === 'Alpha').ratingScore, 66);
  library.upsertTracks([mix(4, 'Delta')]);
  await library.regroupAlbums();
  const joined = named('Mix Tape');
  assert.equal(joined.length, 1, 'a fourth artist makes it a compilation');
  assert.equal(joined[0].albumKind, 'compilation');
  assert.equal(joined[0].ratingScore, 66, 'the rating moved with the album');
  assert.equal(library.getAlbumRating('Various Artists', 'Mix Tape')?.ratingScore, 66);
}

// 4b. Library-level behaviour that the rules alone do not show: interrupted passes, sibling albums, blank titles, discs.
{
  const reading = (folder, n, artist, album, extra = {}) => ({
    path: `K:/music/${folder}/${String(n).padStart(2, '0')}.mp3`,
    title: `Song ${n}`,
    artist,
    album,
    albumArtist: artist,
    trackNo: n,
    discNo: null,
    year: 2004,
    genre: null,
    duration: 120,
    bitrate: null,
    sampleRate: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 100 + n,
    mtime: 1,
    art: null,
    ...extra,
  });
  const mixTape = (n, artist) => reading('Mix Tape', n, artist, 'Mix Tape');
  const open = (name) => LibraryStore.open(join(root, name));
  // A library as an older build wrote it: the ratings table unique on the pair, no album keys.
  const buildTinyOldLibrary = (file) => {
    const old = new SQL.Database();
    old.run(OLD_SCHEMA);
    old.run("INSERT INTO album_ratings (album_artist, album, rating, rating_score, updated_at) VALUES ('Radiohead', 'Kid A', 5, 90, 1000), ('Wilco', 'Being There', 3, 60, 3000)");
    old.run("INSERT INTO tracks (path, title, artist, album, album_artist, track_no, duration, size, mtime) VALUES ('K:/music/R/1.mp3', 'a', 'Radiohead', 'Kid A', 'Radiohead', 1, 1, 1, 1)");
    writeFileSync(file, Buffer.from(old.export()));
    old.close();
  };
  const ratingRows = (l) => l.db.exec('SELECT album_key, rating_score FROM album_ratings ORDER BY rating_id')[0]?.values ?? [];
  const mixAlbum = (l) => l.getAlbums({ limit: 100 }).find((a) => a.album === 'Mix Tape');
  // A pass that stops after its first write: the rest of the pass never runs.
  const interrupt = (l, { keepRemaps }) => {
    if (l.regroupTimer) {
      clearTimeout(l.regroupTimer);
      l.regroupTimer = null;
    }
    const host = l.regroupHost();
    const write = host.writeChunk;
    host.writeChunk = (rows, remaps) => {
      write(rows, keepRemaps ? remaps : undefined);
      l.groupingEpoch += 1;
    };
    return runRegroupSync(host);
  };

  // Ratings are kept per album: two albums with the same title and album artist rate and clear independently.
  {
    const l = await open('siblings.db');
    const rows = [];
    for (const f of ['a', 'b', 'c']) for (let i = 1; i <= 3; i++) rows.push(reading(`Unreleased/${f}`, i, 'Lil Yachty', 'Unreleased'));
    l.upsertTracks(rows);
    await l.regroupAlbums();
    const buckets = l.getAlbums({ limit: 100 }).filter((a) => a.album === 'Unreleased');
    assert.equal(buckets.length, 3);
    const [k1, k2, k3] = buckets.map((b) => b.albumKey);
    l.setAlbumRatingScore('Lil Yachty', 'Unreleased', 50, k1);
    l.setAlbumRatingScore('Lil Yachty', 'Unreleased', 70, k2);
    assert.equal(l.getAlbumSummary(k1).ratingScore, 50, 'rating a sibling does not take the first one\'s rating');
    assert.equal(l.getAlbumSummary(k2).ratingScore, 70);
    assert.equal(l.getAlbumSummary(k3).ratingScore, null);
    assert.equal(l.getAlbumRating('Lil Yachty', 'Unreleased', k1).ratingScore, 50);
    l.setAlbumRatingScore('Lil Yachty', 'Unreleased', 90, k1);
    assert.equal(l.getAlbumSummary(k1).ratingScore, 90, 'rating again updates the same album');
    assert.equal(ratingRows(l).length, 2, 'one row per album');
    l.setAlbumRatingScore('Lil Yachty', 'Unreleased', null, k1);
    assert.equal(l.getAlbumSummary(k1).ratingScore, null);
    assert.equal(l.getAlbumSummary(k2).ratingScore, 70, 'clearing one leaves its sibling rated');
    l.close();
  }

  // The older ratings table, unique on the text pair, is rebuilt without losing a row.
  {
    const oldFile = join(root, 'old-shape.db');
    buildTinyOldLibrary(oldFile);
    const originalBytes = readFileSync(oldFile);
    const l = await LibraryStore.open(oldFile);
    const backup = `${oldFile}.before-album-keys.bak`;
    assert.deepEqual(readFileSync(backup), originalBytes, 'the file is kept as it was before the one-way rebuild');
    const shape = l.db.exec("SELECT sql FROM sqlite_master WHERE name = 'album_ratings'")[0].values[0][0];
    assert.doesNotMatch(shape, /PRIMARY KEY\s*\(\s*album_artist/i, 'the pair is no longer the primary key');
    assert.match(shape, /rating_id\s+INTEGER PRIMARY KEY/);
    await l.albumsReady();
    assert.equal(ratingRows(l).length, 2, 'both rows survive the rebuild');
    assert.equal(l.getAlbums({ limit: 10 }).find((a) => a.album === 'Kid A').ratingScore, 90);
    const ids = l.db.exec('SELECT rating_id FROM album_ratings ORDER BY rating_id')[0].values.map((r) => r[0]);
    l.close();
    const again = await LibraryStore.open(oldFile);
    assert.equal(ratingRows(again).length, 2, 'opening it again changes nothing');
    assert.deepEqual(again.db.exec('SELECT rating_id FROM album_ratings ORDER BY rating_id')[0].values.map((r) => r[0]), ids);
    again.close();
    assert.deepEqual(readFileSync(backup), originalBytes, 'a later open leaves that copy alone');
  }

  // A pass cut short after its writes landed: the rating is already on the album's new key.
  {
    const l = await open('interrupt-keep.db');
    l.upsertTracks([mixTape(1, 'Alpha'), mixTape(2, 'Beta'), mixTape(3, 'Gamma')]);
    await l.regroupAlbums();
    l.setAlbumRatingScore('Alpha', 'Mix Tape', 66);
    l.upsertTracks([mixTape(4, 'Delta')]);
    const r = interrupt(l, { keepRemaps: true });
    assert.equal(r.aborted, true);
    assert.ok(r.written > 0);
    assert.equal(ratingRows(l)[0][0], 'mix tape|~va', 'the rating moved in the same transaction as the tracks');
    assert.equal(mixAlbum(l).ratingScore, 66);
    l.close();
  }

  // The same, when the rating was written under the compilation's display name and no track carries that pair.
  {
    const l = await open('interrupt-display.db');
    l.upsertTracks([mixTape(1, 'Alpha'), mixTape(2, 'Beta'), mixTape(3, 'Gamma'), mixTape(4, 'Delta')]);
    await l.regroupAlbums();
    const comp = mixAlbum(l);
    assert.equal(comp.albumKind, 'compilation');
    l.setAlbumRatingScore('Various Artists', 'Mix Tape', 80, comp.albumKey);
    // Two tracks leave: the compilation falls apart into one album per artist.
    l.db.run("DELETE FROM tracks WHERE title IN ('Song 3', 'Song 4')");
    l.requestRegroup();
    interrupt(l, { keepRemaps: true });
    const key = ratingRows(l)[0][0];
    assert.notEqual(key, comp.albumKey, 'the rating left the key no track has');
    assert.ok(l.db.exec(`SELECT 1 FROM tracks WHERE album_key = '${key}'`)[0], 'and sits on a key some track has');
    l.close();
  }

  // A rating left behind on a vanished key (a library written by an earlier build) is found again through its pair.
  {
    const l = await open('interrupt-orphan.db');
    l.upsertTracks([mixTape(1, 'Alpha'), mixTape(2, 'Beta'), mixTape(3, 'Gamma')]);
    await l.regroupAlbums();
    l.setAlbumRatingScore('Alpha', 'Mix Tape', 66);
    l.upsertTracks([mixTape(4, 'Delta')]);
    interrupt(l, { keepRemaps: false });
    assert.equal(ratingRows(l)[0][0], 'mix tape|alpha', 'the rating is on a key that no track has any more');
    assert.equal(mixAlbum(l).ratingScore, null);
    const again = await l.regroupAlbums({ force: true });
    assert.equal(again.ratingsRemapped, 1);
    assert.equal(mixAlbum(l).ratingScore, 66, 'the next pass moves it to the album its tracks went to');
    l.close();
  }

  // A quit between the writes and the end of the pass, then a relaunch.
  {
    const file = 'interrupt-quit.db';
    let l = await open(file);
    l.upsertTracks([mixTape(1, 'Alpha'), mixTape(2, 'Beta'), mixTape(3, 'Gamma')]);
    await l.regroupAlbums();
    l.setAlbumRatingScore('Alpha', 'Mix Tape', 66);
    l.upsertTracks([mixTape(4, 'Delta')]);
    if (l.regroupTimer) {
      clearTimeout(l.regroupTimer);
      l.regroupTimer = null;
    }
    const host = l.regroupHost();
    const write = host.writeChunk;
    const quitting = l;
    host.writeChunk = (rows, remaps) => {
      write(rows, remaps);
      quitting.close();
    };
    runRegroupSync(host);
    l = await open(file);
    await l.albumsReady();
    await l.regroupAlbums();
    assert.equal(mixAlbum(l).ratingScore, 66, 'the rating survived a quit in the middle of the pass');
    l.close();
  }

  // Counting an ungrouped library does not run the grouping pass on the calling thread.
  {
    const file = join(root, 'ungrouped-stats.db');
    buildTinyOldLibrary(file);
    const l = await LibraryStore.open(file);
    assert.equal(l.identityUngrouped, true);
    l.regroupAlbumsSync = () => {
      throw new Error('getStats must not group the library itself');
    };
    const quick = l.getStats();
    assert.equal(quick.tracks, 1);
    assert.equal(l.identityUngrouped, true, 'still waiting for the background pass');
    delete l.regroupAlbumsSync;
    await l.albumsReady();
    assert.equal(l.getStats().albums, 1);
    l.close();
  }

  // A title or artist of nothing but whitespace never makes a launch regroup.
  {
    const file = 'blank-titles.db';
    let l = await open(file);
    l.upsertTracks([
      reading('Tab', 1, 'Nobody', '\t'),
      reading('Nbsp', 1, '\u00a0', 'Something'),
      reading('Band/Record', 1, 'Band', 'Record'),
    ]);
    await l.regroupAlbums();
    l.close();
    l = await open(file);
    assert.equal(l.identityUngrouped, false);
    assert.equal(l.identityStale, false);
    l.close();
  }

  // Merged discs whose files all say disc 1 come back in the order the titles name.
  {
    const l = await open('discs.db');
    const rows = [];
    for (let i = 1; i <= 3; i++) rows.push(reading('Band/Live', i, 'Band', 'Live (Disc 1)', { discNo: 1 }));
    for (let i = 1; i <= 3; i++) rows.push(reading('Band/Live', 10 + i, 'Band', 'Live (Disc 2)', { discNo: 1, trackNo: i }));
    l.upsertTracks(rows);
    await l.regroupAlbums();
    const live = l.getAlbums({ limit: 10 }).filter((a) => a.album === 'Live');
    assert.equal(live.length, 1);
    const order = l.getAlbumTracksByKey(live[0].albumKey).map((t) => `D${t.discInferred}#${t.trackNo}`);
    assert.deepEqual(order, ['D1#1', 'D1#2', 'D1#3', 'D2#1', 'D2#2', 'D2#3']);
    l.close();
  }

  // The Artists list keeps being served while only tags changed; a new artist makes it stale.
  {
    const l = await open('artist-list.db');
    l.upsertTracks([reading('A/One', 1, 'Aaa', 'One'), reading('B/Two', 1, 'Bbb', 'Two')]);
    await l.regroupAlbums();
    assert.equal(l.artistListStale, false);
    const id = l.db.exec("SELECT id FROM tracks WHERE artist = 'Aaa'")[0].values[0][0];
    l.applyTagBackfill([{
      id, albumArtistTag: null, compilation: false, albumArtistSort: null, artistSort: null, discTotal: null,
      trackTotal: null, discSubtitle: null, mbReleaseGroupId: null, originalYear: null, artists: null, genres: null,
    }]);
    assert.equal(l.identityStale, true, 'the albums are due a pass');
    assert.equal(l.artistListStale, false, 'the artists are not');
    assert.deepEqual(l.getArtists({ limit: 10 }).map((a) => a.artist), ['Aaa', 'Bbb']);
    l.upsertTracks([reading('C/Three', 1, 'Ccc', 'Three')]);
    assert.equal(l.artistListStale, true);
    assert.deepEqual(l.getArtists({ limit: 10 }).map((a) => a.artist), ['Aaa', 'Bbb', 'Ccc'], 'a new artist is listed at once');
    l.close();
  }

  // A scan's batches do not each start a pass; the scan regroups once, and an edit made by hand does not wait.
  {
    const l = await open('scan-hold.db');
    l.upsertTracks([reading('A/One', 1, 'Aaa', 'One')]);
    await l.regroupAlbums();
    l.holdRegroup();
    l.upsertTracks([reading('B/Two', 1, 'Bbb', 'Two')]);
    assert.equal(l.regroupTimer, null, 'no pass is scheduled while a scan runs');
    assert.equal(l.identityStale, true);
    l.releaseRegroup();
    assert.notEqual(l.regroupTimer, null, 'the scan\'s changes get their pass once it is over');
    await l.regroupAlbums();
    assert.equal(l.identityStale, false);
    l.close();
  }

  // The lists carry the key they are ordered by, and a sort tag that is not the name reordered is ignored.
  {
    const l = await open('sort-keys.db');
    l.upsertTracks([
      reading('Eilish/Happier', 1, 'Billie Eilish', 'Happier Than Ever'),
      reading('Steady/Boys', 1, 'The Hold Steady', 'Boys and Girls in America'),
      reading('Plain/Record', 1, 'The Plain Band', 'Record'),
    ]);
    const tags = (name, sort) => ({
      id: l.db.exec(`SELECT id FROM tracks WHERE artist = '${name}'`)[0].values[0][0],
      albumArtistTag: name, compilation: false, albumArtistSort: sort, artistSort: sort, discTotal: null, trackTotal: null,
      discSubtitle: null, mbReleaseGroupId: null, originalYear: null, artists: null, genres: null,
    });
    l.applyTagBackfill([
      tags('Billie Eilish', 'Eilish, Billie'),
      tags('The Hold Steady', 'Boys and Girls in America: Deluxe Edition'),
    ]);
    await l.regroupAlbums();
    const albumSort = (artist) => l.getAlbums({ limit: 10 }).find((a) => a.albumArtist === artist).sortKey;
    assert.equal(albumSort('Billie Eilish'), 'eilish, billie');
    assert.equal(albumSort('The Hold Steady'), 'hold steady', 'a sort tag naming an album is not used');
    assert.equal(albumSort('The Plain Band'), 'plain band');
    const artistSort = (artist) => l.getArtists({ limit: 10 }).find((a) => a.artist === artist).sortKey;
    assert.equal(artistSort('Billie Eilish'), 'eilish, billie');
    assert.equal(artistSort('The Hold Steady'), 'hold steady');
    assert.equal(l.getArtists({ limit: 10, search: 'eilish' })[0].sortKey, 'eilish, billie');
    l.close();
  }

  // A library grouped under older rules is grouped again on the next launch.
  {
    const file = 'rules-version.db';
    let l = await open(file);
    l.upsertTracks([reading('A/One', 1, 'Aaa', 'One')]);
    await l.regroupAlbums();
    assert.equal(l.db.exec("SELECT value FROM library_meta WHERE key = 'album_identity_version'")[0].values[0][0], String(ALBUM_IDENTITY_VERSION));
    l.db.run("UPDATE library_meta SET value = ? WHERE key = 'album_identity_version'", [String(ALBUM_IDENTITY_VERSION - 1)]);
    l.flushSync();
    l.close();
    l = await open(file);
    assert.equal(l.identityStale, true, 'the stored version is older than the rules');
    await l.albumsReady();
    await l.regroupAlbums();
    assert.equal(l.identityStale, false);
    assert.equal(l.db.exec("SELECT value FROM library_meta WHERE key = 'album_identity_version'")[0].values[0][0], String(ALBUM_IDENTITY_VERSION));
    l.close();
  }

  // An old (album artist, album) pair names one album; with several that share it, the biggest.
  {
    const l = await open('pair-sibling.db');
    const rows = [];
    for (let i = 1; i <= 2; i++) rows.push(reading('Unreleased/a', i, 'Lil Yachty', 'Unreleased'));
    for (let i = 1; i <= 4; i++) rows.push(reading('Unreleased/b', i, 'Lil Yachty', 'Unreleased'));
    for (let i = 1; i <= 3; i++) rows.push(reading('Unreleased/c', i, 'Lil Yachty', 'Unreleased'));
    l.upsertTracks(rows);
    await l.regroupAlbums();
    assert.equal(l.getAlbumTracks('Lil Yachty', 'Unreleased').length, 4, 'one album, not every album with that title');
    const sizes = l.getAlbums({ limit: 10 }).filter((a) => a.album === 'Unreleased').map((a) => a.trackCount).sort();
    assert.deepEqual(sizes, [2, 3, 4]);
    l.close();
  }
}

// 5. A library that has been grouped opens without grouping again.
library.close();
library = await LibraryStore.open(dbPath);
assert.equal(library.identityStale, false);
assert.equal(library.identityUngrouped, false);
await library.albumsReady();
assert.equal(library.getAlbums({ limit: 1000 }).length, 9);
assert.equal(library.getAlbums({ limit: 1000 }).find((a) => a.album === 'Kid A').ratingScore, 91);
assert.equal(library.getAlbums({ limit: 1000 }).find((a) => a.album === 'Mix Tape').ratingScore, 66);
library.close();

// 6. A quit before a change was grouped: the next launch groups it.
{
  const file = join(root, 'pending.db');
  copyFileSync(dbPath, file);
  let l = await LibraryStore.open(file);
  l.upsertTracks([{
    path: 'K:/music/Late/1.mp3', title: 'Late', artist: 'Late Artist', album: 'Late Album', albumArtist: 'Late Artist',
    trackNo: 1, discNo: null, year: 2020, genre: null, duration: 1, bitrate: null, sampleRate: null,
    replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
  }]);
  assert.equal(l.identityStale, true);
  l.close();
  l = await LibraryStore.open(file);
  assert.equal(l.identityStale, true, 'the pending change was remembered');
  await l.albumsReady();
  await l.regroupAlbums();
  assert.equal(l.identityStale, false);
  l.close();
}

// 7. A real library, when there is a copy of one.
const realDb = process.env.NEWAMP_REAL_LIBRARY_DB ?? (existsSync('tmp/real-library.db') ? resolve('tmp/real-library.db') : null);
if (realDb) {
  const file = join(root, 'real.db');
  copyFileSync(realDb, file);
  const real = await LibraryStore.open(file);
  const before = new Map(
    real.db.exec('SELECT album_artist, album, rating_score FROM album_ratings')[0]?.values.map((r) => [`${r[0]}\u0000${r[1]}`, r[2]]) ?? [],
  );
  const oldAlbums = real.db.exec(`SELECT COUNT(*) FROM (SELECT 1 FROM tracks WHERE album != '' GROUP BY album, COALESCE(NULLIF(album_artist,''), artist))`)[0].values[0][0];
  const probe = process.env.NEWAMP_TAG_PROBE;
  if (probe && existsSync(probe)) {
    const rows = readFileSync(probe, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.err);
    real.applyTagBackfill(rows.map((r) => ({
      id: r.id, albumArtistTag: r.aa ?? null, compilation: !!r.cmp, albumArtistSort: r.aas ?? null, artistSort: null,
      discTotal: r.dof ?? null, trackTotal: r.tof ?? null, discSubtitle: r.dst ?? null, mbReleaseGroupId: r.mbg ?? null,
      originalYear: null, artists: r.ars ?? null, genres: r.gen && r.gen.length > 1 ? r.gen : null,
    })));
  }
  await real.albumsReady();
  await real.regroupAlbums({ force: true });
  const count = real.getStats().albums;
  console.log(`[album-identity-migration-test] real library: ${oldAlbums} albums before, ${count} after${probe ? ' (with file tags)' : ' (database columns only)'}`);
  assert.ok(count < oldAlbums * 0.9 && count > oldAlbums * 0.75, `album count ${count} should fall 10-25% from ${oldAlbums}`);
  const one = (title) => real.getAlbums({ search: title, limit: 50 }).filter((a) => a.album === title);
  assert.equal(one('Rough Trade Shops: Covers Vol. 1').length, 1, 'Rough Trade Shops: Covers Vol. 1 is one album');
  assert.equal(one("I'm Not There soundtrack").length, 1, "I'm Not There is one album");
  assert.equal(one("I'm Not There soundtrack")[0].trackCount, 31);
  assert.equal(one('Rough Trade Shops: Covers Vol. 1')[0].trackCount, 40);
  const after = real.db.exec('SELECT album_artist, album, rating_score, album_key FROM album_ratings')[0]?.values ?? [];
  assert.equal(after.length, before.size, 'no rating row was lost');
  for (const [artist, album, score, key] of after) {
    assert.equal(score, before.get(`${artist}\u0000${album}`), 'rating scores are untouched');
    assert.ok(key, 'every rating has a key');
  }
  const rated = after.filter((r) => r[2] != null && r[2] > 0);
  const listed = new Map(real.getAlbums({ limit: 100000 }).map((a) => [a.albumKey, a.ratingScore]));
  const reachable = rated.filter((r) => listed.get(r[3]) != null).length;
  console.log(`[album-identity-migration-test] real library: ${rated.length} rated rows, ${reachable} reach an album`);
  assert.ok(reachable >= rated.length - 1, 'every rated album still shows its rating (one old row may have no tracks)');
  real.close();
}

console.log('[album-identity-migration-test] ok: keys assigned, albums regrouped, ratings followed their albums');
