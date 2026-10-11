// Library search folds case and accents the way people type, not the way
// SQLite's lower() does (A-Z only). Before the folded columns, "bjork" never
// found "Björk" and "ÓLAFUR" found nothing at all although "Ólafur" did.
//  - foldSearchText: accents, compatibility forms, special letters, Cyrillic;
//    kana voicing marks are left alone, and kana, Hangul and й come out whole,
//    so a short query does not match a longer, different character;
//  - track search, field filters, albums and artists find accented text from
//    plain or upper-case queries, and counts agree with the page;
//  - the path is still matched as typed, and %/_ stay literal;
//  - a metadata edit (and reset to file) keeps the folded copy in step;
//  - a library from before the folded columns existed opens, is backfilled
//    once, and searches the same as a fresh one.
// Run: npm run build:electron && node scripts/library-search-fold-test.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { LibraryStore, foldSearchText } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-search-fold-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

function incoming(path, fields) {
  return {
    path,
    title: 'Untitled',
    artist: 'Unknown Artist',
    album: '',
    albumArtist: '',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: 100,
    bitrate: null,
    sampleRate: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000,
    mtime: 1,
    art: null,
    ...fields,
  };
}

// 1. The fold itself.
{
  const cases = [
    ['Björk', 'bjork'],
    ['ÓLAFUR ARNALDS', 'olafur arnalds'],
    ['Motörhead', 'motorhead'],
    ['Sigur Rós', 'sigur ros'],
    ['Beyoncé', 'beyonce'],
    ['Mötley Crüe', 'motley crue'],
    ['Straße', 'strasse'],
    ['Bjørk', 'bjork'],
    ['Łódź', 'lodz'],
    ['İstanbul', 'istanbul'],
    ['ＡＢＣ', 'abc'],
    ['Ёлка', 'елка'],
    ['Йод', 'йод'],
    ['мой', 'мой'],
    ['Οδυσσέας', 'οδυσσεασ'],
    ['ΟΔΥΣ', 'οδυσ'],
    ['Ελληνικά', 'ελληνικα'],
    // NFD input folds to the same text as NFC.
    ['Café', 'cafe'],
    ['plain ascii', 'plain ascii'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.equal(foldSearchText(input), expected, `fold of ${JSON.stringify(input)}`);
  assert.equal(foldSearchText(null), '');
  assert.equal(foldSearchText(undefined), '');
  // Voicing marks tell kana apart; folding must not merge か and が.
  assert.notEqual(foldSearchText('かわ'), foldSearchText('がわ'));
  assert.equal(foldSearchText('がわ'), foldSearchText('がわ'.normalize('NFC')));
  // The result is whole characters, not a base followed by its mark.
  assert.equal(foldSearchText('がっかい'), 'がっかい'.normalize('NFC'));
  assert.equal(foldSearchText('びじゅつ'.normalize('NFD')), 'びじゅつ'.normalize('NFC'));
  assert.equal(foldSearchText('한국'.normalize('NFD')), '한국'.normalize('NFC'));
  assert.equal(foldSearchText('ﾊﾞｲｵﾘﾝ'), 'バイオリン', 'half-width katakana voicing recomposes');
  assert.equal(foldSearchText('мой'.normalize('NFD')), 'мой');
  assert.notEqual(foldSearchText('мой'), foldSearchText('мои'));
  // A capital sigma at the end of a typed prefix is the same letter as a stored one.
  assert.ok(foldSearchText('Οδυσσέας').startsWith(foldSearchText('ΟΔΥΣ')));
}

// 2. Searching.
const library = await LibraryStore.open(join(root, 'library.db'));
{
  library.upsertTracks([
    incoming('/music/Bjork/Debut/01 Human Behaviour.flac', {
      title: 'Human Behaviour', artist: 'Björk', album: 'Debut', albumArtist: 'Björk', genre: 'Electronic', year: 1993,
    }),
    incoming('/music/Bjork/Debut/02 Crying.flac', {
      title: 'Crying', artist: 'Björk', album: 'Debut', albumArtist: 'Björk', genre: 'Electronic', year: 1993,
    }),
    incoming('/music/Olafur/Re-member/01 Saman.flac', {
      title: 'Saman', artist: 'Ólafur Arnalds', album: 'Re:member', albumArtist: 'Ólafur Arnalds', genre: 'Neo-Classical', year: 2018,
    }),
    incoming('/music/Motorhead/01 Ace of Spades.flac', {
      title: 'Ace of Spades', artist: 'Motörhead', album: 'Ace of Spades', albumArtist: 'Motörhead', genre: 'Metal', year: 1980,
    }),
    incoming('/music/Misc/01 Café Del Mar.flac', {
      title: 'Café Del Mar', artist: 'Energy 52', album: 'Single', albumArtist: 'Energy 52', genre: 'Trance', year: 1993,
    }),
    incoming('/music/Misc/02 100% Pure_Love.flac', {
      title: '100% Pure_Love', artist: 'Crystal Waters', album: 'Single', albumArtist: 'Crystal Waters', genre: 'House', year: 1994,
    }),
    incoming('/music/Misc/03 Plain Song.flac', {
      title: 'Plain Song', artist: 'Plain Artist', album: 'Plain Album', albumArtist: 'Plain Artist', genre: 'Rock', year: 2001,
    }),
    // Only the folder name carries the accent.
    incoming('/music/Café Tacvba/01 Eres.flac', {
      title: 'Eres', artist: 'Unknown Artist', album: '', albumArtist: 'Unknown Artist',
    }),
  ]);

  const titles = (search, extra = {}) => library.getTracks({ search, limit: 100, ...extra }).map((t) => t.title).sort();
  const count = (search) => library.getTrackCount({ search });

  // Plain, accented and upper-case queries all find the same tracks, and the
  // count agrees with the page.
  for (const query of ['bjork', 'björk', 'Björk', 'BJÖRK', 'BJORK', 'bjÖrk']) {
    assert.deepEqual(titles(query), ['Crying', 'Human Behaviour'], `search ${query}`);
    assert.equal(count(query), 2, `count ${query}`);
  }
  for (const query of ['olafur', 'ólafur', 'Ólafur', 'ÓLAFUR', 'OLAFUR']) {
    assert.deepEqual(titles(query), ['Saman'], `search ${query}`);
    assert.equal(count(query), 1, `count ${query}`);
  }
  assert.deepEqual(titles('motorhead'), ['Ace of Spades']);
  assert.deepEqual(titles('MOTÖRHEAD'), ['Ace of Spades']);
  assert.deepEqual(titles('cafe'), ['Café Del Mar'], 'tags fold; a path is matched as typed');
  assert.deepEqual(titles('café'), ['Café Del Mar', 'Eres'], 'an accented query still reaches an accented path');
  assert.deepEqual(titles('Café del mar'), ['Café Del Mar']);
  // Terms are ANDed across fields, as before.
  assert.deepEqual(titles('bjork crying'), ['Crying']);
  assert.deepEqual(titles('bjork metal'), []);

  // Field filters.
  assert.deepEqual(titles('artist:bjork'), ['Crying', 'Human Behaviour']);
  assert.deepEqual(titles('artist:BJÖRK'), ['Crying', 'Human Behaviour']);
  assert.deepEqual(titles('artist:"ólafur arnalds"'), ['Saman']);
  assert.deepEqual(titles('album:remember'), [], 're:member is not remember');
  assert.deepEqual(titles('album:re:member'), ['Saman']);
  assert.deepEqual(titles('title:cafe'), ['Café Del Mar']);
  assert.deepEqual(titles('albumartist:MOTORHEAD'), ['Ace of Spades']);
  assert.deepEqual(titles('genre:NEO-classical'), ['Saman']);

  // %, _ and the plain-ASCII path behaviour are unchanged.
  assert.deepEqual(titles('100%'), ['100% Pure_Love']);
  assert.deepEqual(titles('pure_love'), ['100% Pure_Love']);
  assert.deepEqual(titles('pure_lov_'), [], '_ is literal');
  assert.deepEqual(titles('"Debut/02"'), ['Crying'], 'path substring');
  assert.deepEqual(titles('path:debut'), ['Crying', 'Human Behaviour']);

  // Albums and artists.
  const albums = (search) => library.getAlbums({ search }).map((a) => a.album).sort();
  assert.deepEqual(albums('bjork'), ['Debut']);
  assert.deepEqual(albums('BJÖRK'), ['Debut']);
  assert.deepEqual(albums('olafur'), ['Re:member']);
  assert.deepEqual(albums('ÓLAFUR'), ['Re:member']);
  assert.deepEqual(albums('cafe'), ['Single'], 'an album surfaces for a song title');
  const bySong = library.getAlbums({ search: 'cafe' })[0];
  assert.equal(bySong.matchedOnTrack, true);
  assert.equal(bySong.matchedTrackTitles, 'Café Del Mar');
  const artists = (search) => library.getArtists({ search }).map((a) => a.artist).sort();
  assert.deepEqual(artists('bjork'), ['Björk']);
  assert.deepEqual(artists('BJÖRK'), ['Björk']);
  assert.deepEqual(artists('olafur'), ['Ólafur Arnalds']);
  assert.deepEqual(artists('MOTÖRHEAD'), ['Motörhead']);

  // Smart rules read the genre the same way.
  library.upsertTracks([incoming('/music/Misc/04 Fado.flac', { title: 'Fado', artist: 'X', album: 'Y', albumArtist: 'X', genre: 'Música Portuguesa' })]);
  assert.deepEqual(
    library.runSmartPlaylistRule({ name: 'g', mood: 'focus', count: 50, genreQuery: 'musica' }).map((t) => t.title),
    ['Fado'],
  );
}

// 3. Edits keep the folded copy in step.
{
  const [track] = library.getTracks({ search: 'plain song', limit: 5 });
  const edited = library.applyManualMetadataPatch(track.id, { title: 'Éclair', artist: 'Zoë', genre: 'Chanson' });
  assert.equal(edited.title, 'Éclair');
  assert.deepEqual(library.getTracks({ search: 'eclair' }).map((t) => t.id), [track.id]);
  assert.deepEqual(library.getTracks({ search: 'ZOË' }).map((t) => t.id), [track.id]);
  assert.deepEqual(library.getTracks({ search: 'title:ECLAIR genre:chanson' }).map((t) => t.id), [track.id]);
  assert.deepEqual(library.getTracks({ search: 'title:"plain song"' }).map((t) => t.id), [], 'the old title no longer matches');

  // A rescan of the file (which still says "Plain Song") must not undo the edit's search text.
  library.upsertTracks([incoming(track.path, {
    title: 'Plain Song', artist: 'Plain Artist', album: 'Plain Album', albumArtist: 'Plain Artist', genre: 'Rock', year: 2001,
  })]);
  assert.deepEqual(library.getTracks({ search: 'eclair' }).map((t) => t.id), [track.id], 'edit survives a rescan');
  assert.deepEqual(library.getTracks({ search: 'title:"plain song"' }).map((t) => t.id), []);

  const reset = library.applyManualMetadataPatch(track.id, { resetToFile: ['title', 'artist', 'genre'] });
  assert.equal(reset.title, 'Plain Song');
  assert.deepEqual(library.getTracks({ search: 'title:"plain song"' }).map((t) => t.id), [track.id], 'reset restores the search text');
  assert.deepEqual(library.getTracks({ search: 'title:eclair' }).map((t) => t.id), []);
}
library.close();

// 3b. A short query is not a prefix of a different character. Voiced kana,
// Hangul syllables and Russian й each used to match their base letter, and a
// typed upper-case sigma missed the stored word.
{
  const scripts = await LibraryStore.open(join(root, 'scripts.db'));
  scripts.upsertTracks([
    incoming('/music/s/01.flac', { title: 'びじゅつ', artist: 'Kana Artist' }),
    incoming('/music/s/02.flac', { title: 'がくせい', artist: 'Kana Artist' }),
    incoming('/music/s/03.flac', { title: 'ひかり', artist: 'Kana Artist' }),
    incoming('/music/s/04.flac', { title: '한국', artist: 'Hangul Artist' }),
    incoming('/music/s/05.flac', { title: '하늘', artist: 'Hangul Artist' }),
    incoming('/music/s/06.flac', { title: 'мой друг', artist: 'Cyrillic Artist' }),
    incoming('/music/s/07.flac', { title: 'мои друзья', artist: 'Cyrillic Artist' }),
    incoming('/music/s/08.flac', { title: 'Ёлка', artist: 'Cyrillic Artist' }),
    incoming('/music/s/09.flac', { title: 'Οδυσσέας', artist: 'Greek Artist' }),
  ]);
  const found = (search) => scripts.getTracks({ search, limit: 50 }).map((t) => t.title).sort();
  assert.deepEqual(found('ひ'), ['ひかり'], 'ひ is not the start of び');
  assert.deepEqual(found('び'), ['びじゅつ']);
  assert.deepEqual(found('か'), ['ひかり'], 'か is not the start of が');
  assert.deepEqual(found('が'), ['がくせい']);
  assert.deepEqual(found('title:ひ'), ['ひかり']);
  assert.deepEqual(found('하'), ['하늘'], '하 is not the start of 한');
  assert.deepEqual(found('한'), ['한국']);
  assert.deepEqual(found('мой'), ['мой друг'], 'мой is not мои');
  assert.deepEqual(found('мои'), ['мои друзья']);
  assert.deepEqual(found('Мой'), ['мой друг']);
  assert.deepEqual(found('елка'), ['Ёлка'], 'ё is typed as е');
  for (const query of ['ΟΔΥΣ', 'οδυς', 'οδυσ', 'ΟΔΥΣΣΕΑΣ', 'Οδυσσέας']) {
    assert.deepEqual(found(query), ['Οδυσσέας'], `search ${query}`);
  }
  assert.equal(scripts.getTrackCount({ search: 'ΟΔΥΣ' }), 1);
  scripts.close();
}

// 4. A library from before the folded columns.
{
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
    album_artist TEXT NOT NULL DEFAULT '', track_no INTEGER, disc_no INTEGER, year INTEGER, genre TEXT,
    duration REAL, bitrate INTEGER, sample_rate INTEGER, size INTEGER, mtime INTEGER NOT NULL DEFAULT 0,
    has_art INTEGER NOT NULL DEFAULT 0, loved INTEGER NOT NULL DEFAULT 0, rating INTEGER NOT NULL DEFAULT 0,
    rating_score REAL, avoid_auto_play INTEGER NOT NULL DEFAULT 0, play_count INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER, skip_count INTEGER NOT NULL DEFAULT 0, last_skipped INTEGER, bpm REAL, key TEXT,
    replaygain_track_db REAL, replaygain_album_db REAL, art_hash TEXT, dna_json TEXT, dna_analyzed_at INTEGER,
    missing_since INTEGER, file_dev INTEGER
  )`);
  const insert = db.prepare(
    `INSERT INTO tracks (path, title, artist, album, album_artist, genre, rating, rating_score, play_count, size, mtime)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(['/old/a.flac', 'Jóga', 'Björk', 'Homogenic', 'Björk', 'Electronic', 5, 100, 12, 10, 1]);
  insert.run(['/old/b.flac', 'Gloria', 'Sigur Rós', 'Með suð', 'Sigur Rós', 'Post-Rock', 0, null, 0, 10, 1]);
  insert.run(['/old/c.flac', 'Plain', 'Plain', 'Plain', 'Plain', null, 0, null, 0, 10, 1]);
  insert.free();
  const file = join(root, 'old-shape.db');
  writeFileSync(file, Buffer.from(db.export()));
  db.close();

  const upgraded = await LibraryStore.open(file);
  assert.equal(upgraded.upgradeError, null);
  assert.deepEqual(upgraded.getTracks({ search: 'bjork' }).map((t) => t.title), ['Jóga']);
  assert.deepEqual(upgraded.getTracks({ search: 'SIGUR ROS' }).map((t) => t.title), ['Gloria']);
  assert.deepEqual(upgraded.getTracks({ search: 'med sud' }).map((t) => t.title), ['Gloria'], 'ð folds to d');
  assert.deepEqual(upgraded.getTracks({ search: 'genre:post-rock' }).map((t) => t.title), ['Gloria']);
  assert.equal(upgraded.getTracks({ search: 'plain' }).length, 1);
  assert.deepEqual(upgraded.getArtists({ search: 'bjork' }).map((a) => a.artist), ['Björk']);
  assert.deepEqual(upgraded.getAlbums({ search: 'homogenic' }).map((a) => a.album), ['Homogenic']);
  // Nothing else about the old rows moved.
  const [jora] = upgraded.getTracks({ search: 'bjork' });
  assert.equal(jora.rating, 5);
  assert.equal(jora.ratingScore, 100);
  assert.equal(jora.playCount, 12);
  assert.equal(jora.codec, null, 'codec stays unknown until the file is read');
  // A new row written after the backfill is searchable the same way.
  upgraded.upsertTracks([incoming('/old/d.flac', { title: 'Ágætis byrjun', artist: 'Sigur Rós', album: 'Ágætis byrjun', albumArtist: 'Sigur Rós' })]);
  assert.equal(upgraded.getTracks({ search: 'agaetis' }).length, 1, 'æ folds to ae');
  assert.deepEqual(upgraded.getTracks({ search: 'sigur ros' }).map((t) => t.title).sort(), ['Gloria', 'Ágætis byrjun']);
  upgraded.close();

  // Opening it again does not run the backfill a second time: damage a folded
  // value and see that it is left alone.
  const again = await LibraryStore.open(file);
  assert.deepEqual(again.getTracks({ search: 'sigur ros' }).map((t) => t.title).sort(), ['Gloria', 'Ágætis byrjun']);
  const damaged = again.db;
  damaged.run(`UPDATE tracks SET artist_fold = 'zzz' WHERE path = '/old/b.flac'`);
  // A row an older build wrote after a downgrade has no folded text at all.
  damaged.run(
    `INSERT INTO tracks (path, title, artist, album, album_artist, size, mtime)
     VALUES ('/old/e.flac', 'Hoppípolla', 'Sigur Rós', 'Takk', 'Sigur Rós', 1, 1)`,
  );
  again.toggleLove(1); // any write, so close() saves the damaged value
  again.close();
  const third = await LibraryStore.open(file);
  assert.deepEqual(
    third.getTracks({ search: 'sigur ros' }).map((t) => t.title).sort(),
    ['Hoppípolla', 'Ágætis byrjun'],
    'the full backfill ran once; a row with no folded text is filled in',
  );
  assert.deepEqual(third.getTracks({ search: 'hoppipolla' }).map((t) => t.title), ['Hoppípolla']);
  third.close();
}

console.log('[library-search-fold-test] ok: folding, search, filters, albums, artists, edits and old-library backfill');
