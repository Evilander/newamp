// The grouping rules (shared/album-identity.ts) on synthetic folders. Each case
// builds the tracks of one or two folders the way a scan would hand them over
// and checks which of them end up in one album, what the album is called and
// why it was grouped that way. The careful cases come from a real 58,000-track
// library: flagged-but-single-artist compilations, real band names that contain
// "&" and ",", and a collaboration whose guests outnumber its owner's own tracks.
// Run: node scripts/album-identity-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/album-identity-test-bundle.mjs');
await build({
  entryPoints: [resolve('shared/album-identity.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  logLevel: 'silent',
});
const discsOut = resolve('tmp/album-discs-test-bundle.mjs');
await build({
  entryPoints: [resolve('shared/album-discs.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: discsOut,
  logLevel: 'silent',
});
const { splitIntoDiscs } = await import(pathToFileURL(discsOut).href);
const identity = await import(pathToFileURL(outfile).href);
const {
  computeAlbumIdentities,
  provisionalIdentity,
  keyForPair,
  keyFold,
  baseFold,
  stripDiscMarker,
  stripFeatTail,
  containerFingerprint,
  artistKeyOf,
  artistSortKey,
  INFER_MIN_TRACKS,
  BUCKET_MIN_TRACKS,
} = identity;

let nextId = 1;
let nextFile = 1;
// One track as a scan stores it. `aa` is the file's ALBUMARTIST tag; the
// album_artist column holds it, or the track artist when the file named none.
function track(folder, over = {}) {
  const { aa = null, cmp = false, known = true, edited = false, ...rest } = over;
  const artist = rest.artist ?? 'Artist';
  return {
    id: nextId++,
    path: `K:/music/${folder}/${String(nextFile++).padStart(4, '0')}.mp3`,
    album: 'Album',
    artist,
    albumArtist: aa ?? artist,
    albumArtistTag: aa,
    tagsKnown: known,
    albumArtistEdited: edited,
    compilation: cmp,
    discNo: null,
    year: null,
    albumArtistSort: null,
    artistSort: null,
    ...rest,
  };
}
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
function run(tracks, splits) {
  const result = computeAlbumIdentities(tracks, splits);
  const albums = new Map();
  for (const t of tracks) {
    const id = result.identities.get(t.id);
    const list = albums.get(id.albumKey) ?? [];
    list.push({ track: t, id });
    albums.set(id.albumKey, list);
  }
  return { ...result, albums, of: (t) => result.identities.get(t.id) };
}
const albumCount = (tracks, splits) => run(tracks, splits).albums.size;
const sameAlbum = (r, ...tracks) => new Set(tracks.map((t) => r.of(t).albumKey)).size === 1;

// -- folds ---------------------------------------------------------------------
{
  assert.equal(baseFold('  Wilco   '), 'wilco');
  assert.equal(baseFold('Björk'), 'bjork');
  assert.equal(baseFold('Sigur Rós'), 'sigur ros');
  assert.equal(baseFold('Motörhead'), 'motorhead');
  assert.equal(keyFold('The Beatles'), keyFold('Beatles, The'));
  assert.equal(keyFold('Beatles, The'), 'beatles');
  assert.equal(keyFold('Robbers & Cowards'), keyFold('Robbers and Cowards'));
  assert.equal(keyFold("I'm Not There"), keyFold('Im Not There'));
  assert.equal(keyFold('R.E.M.'), keyFold('REM'));
  assert.equal(keyFold('Hello, World!'), keyFold('hello world'));
  // Titles that are nothing but punctuation stay apart, and so do titles that differ in a mark that is part of the letter.
  assert.notEqual(keyFold('!!!'), keyFold('???'));
  assert.notEqual(keyFold('\u304b\u304d'), keyFold('\u304c\u304d'), 'a dakuten changes the word');
  assert.notEqual(keyFold('\u3042'), keyFold('\u3044'));
  // The artist list folds only case, accents and spacing.
  assert.equal(artistKeyOf('  Cindy Lee '), artistKeyOf('Cindy Lee'));
  assert.equal(artistKeyOf('AdriAnne Lenker'), artistKeyOf('Adrianne Lenker'));
  assert.notEqual(artistKeyOf('The Beatles'), artistKeyOf('Beatles'));
  assert.equal(artistSortKey('The Beatles'), 'beatles');
  assert.equal(artistSortKey('The Beatles', 'Beatles, The'), 'beatles, the');
  assert.equal(artistSortKey('Aphex Twin'), 'aphex twin');
}

// -- disc markers and feat. tails ------------------------------------------------
{
  assert.deepEqual(stripDiscMarker('Being There (disc 2)'), { stem: 'Being There', disc: 2 });
  assert.deepEqual(stripDiscMarker('Garage, Inc. (CD1)'), { stem: 'Garage, Inc.', disc: 1 });
  assert.deepEqual(stripDiscMarker('B`Day (Deluxe Edition) CD2'), { stem: 'B`Day (Deluxe Edition)', disc: 2 });
  assert.deepEqual(stripDiscMarker('Our Tired, Our Poor, Our Huddled Masses - Disc 3: Jefferson'), {
    stem: 'Our Tired, Our Poor, Our Huddled Masses',
    disc: 3,
  });
  assert.deepEqual(stripDiscMarker('Greatest Hits [Disc One]'), { stem: 'Greatest Hits', disc: 1 });
  assert.equal(stripDiscMarker('Dance Disc 1999').stem, 'Dance Disc 1999', 'a year is not a disc number');
  assert.equal(stripDiscMarker('CD1').stem, 'CD1', 'a title that is only a marker is kept');
  assert.equal(stripDiscMarker('Plain Title').disc, null);
  assert.equal(stripFeatTail('Daft Punk feat. Pharrell Williams'), 'Daft Punk');
  assert.equal(stripFeatTail('Daft Punk (ft. Todd Edwards)'), 'Daft Punk');
  assert.equal(stripFeatTail('Artist [featuring Someone]'), 'Artist');
  assert.equal(stripFeatTail('Soft Cell'), 'Soft Cell', '"ft" inside a name is not a tail');
  assert.equal(stripFeatTail('Daft Punk'), 'Daft Punk');
  assert.equal(stripFeatTail('Tyler, The Creator'), 'Tyler, The Creator');
  assert.equal(stripFeatTail('Iron & Wine'), 'Iron & Wine');
}

// -- R1: case, accents, spacing ---------------------------------------------------
{
  const a = many(8, () => track('Death Cab/Narrow Stairs', { album: 'Narrow Stairs', artist: 'Death Cab for Cutie' }));
  const b = many(9, () => track('Death Cab/Narrow Stairs', { album: 'Narrow Stairs', artist: 'Death Cab For Cutie' }));
  const r = run([...a, ...b]);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(a[0]).albumArtistDisplay, 'Death Cab For Cutie', 'the spelling most tracks use is the one shown');
  assert.equal(r.of(a[0]).albumKind, 'album');

  const wilco = [
    ...many(6, () => track('Wilco/A Ghost Is Born', { album: 'A Ghost Is Born', artist: 'Wilco' })),
    ...many(6, () => track('Wilco/A Ghost Is Born', { album: 'A Ghost is Born', artist: 'WILCO' })),
  ];
  assert.equal(albumCount(wilco), 1);
  // Trailing spaces never reach the display text.
  const spaced = many(4, () => track('Band/Unplugged', { album: 'Unplugged in the Studio   ', artist: 'Band' }));
  assert.equal(run(spaced).of(spaced[0]).albumDisplay, 'Unplugged in the Studio');
  const accents = [
    ...many(4, () => track('x/y', { album: 'Voyage', artist: 'Bjork' })),
    ...many(4, () => track('x/y', { album: 'Voyage', artist: 'Bj\u00f6rk' })),
  ];
  assert.equal(albumCount(accents), 1);
}

// -- R2: disc markers in titles, disc folders -------------------------------------
{
  const one = many(3, (i) => track('Wilco/Being There', { album: 'Being There', artist: 'Wilco', trackNo: i + 1 }));
  const two = many(3, (i) => track('Wilco/Being There', { album: 'Being There (disc 2)', artist: 'Wilco', trackNo: i + 1 }));
  const r = run([...one, ...two]);
  assert.equal(r.albums.size, 1, 'a title that ends in a disc marker joins its first disc');
  assert.equal(r.of(two[0]).albumDisplay, 'Being There');
  assert.equal(r.of(two[0]).discInferred, 2, 'the disc comes from the marker');
  assert.equal(r.of(one[0]).discInferred, null);
  assert.match(r.of(one[0]).albumReason, /Joined 2 discs/);

  const garage = [
    ...many(3, () => track('Garage', { album: 'Garage, Inc. (CD1)', artist: 'Black Sabbath' })),
    ...many(3, () => track('Garage', { album: 'Garage, Inc. (CD2)', artist: 'Black Sabbath' })),
  ];
  assert.equal(albumCount(garage), 1);
  const lincoln = [
    track('Dir', { album: 'Our Tired, Our Poor - Disc 1: Lincoln', artist: 'Various Folks', aa: 'Various Artists' }),
    track('Dir', { album: 'Our Tired, Our Poor - Disc 3: Jefferson', artist: 'Other Folks', aa: 'Various Artists' }),
  ];
  assert.equal(albumCount(lincoln), 1);

  // Disc folders: CD1 and CD2 under one album folder are one album, numbered from the folder.
  const cd1 = many(4, (i) => track('Artist/Album/CD1', { album: 'Album', artist: 'Artist', trackNo: i + 1 }));
  const cd2 = many(4, (i) => track('Artist/Album/CD2', { album: 'Album', artist: 'Artist', trackNo: i + 1 }));
  const folders = run([...cd1, ...cd2]);
  assert.equal(folders.albums.size, 1);
  assert.deepEqual(cd1.map((t) => folders.of(t).discInferred), [1, 1, 1, 1]);
  assert.deepEqual(cd2.map((t) => folders.of(t).discInferred), [2, 2, 2, 2]);
  // A disc number in the file always wins over the folder's.
  const tagged = track('Artist/Album/CD1', { album: 'Album', artist: 'Artist', discNo: 2 });
  assert.equal(run([tagged, ...cd1]).of(tagged).discInferred, null);
  // "Disc 2" as a folder is part of its parent's album, not an album called "Disc 2".
  const disc = many(3, () => track('Artist/Album/Disc 2', { album: 'Other', artist: 'Artist' }));
  assert.equal(run(disc).of(disc[0]).discInferred, 2);
  // Unrelated albums in sibling folders stay apart.
  assert.equal(albumCount([...cd1, ...many(4, () => track('Artist/Other Album', { album: 'Other Album', artist: 'Artist' }))]), 2);
}

// -- R3: The, "&", punctuation -----------------------------------------------------
{
  assert.equal(
    albumCount([
      ...many(3, () => track('Lucero/a', { album: 'Robbers and Cowards', artist: 'Lucero' })),
      ...many(3, () => track('Lucero/b', { album: 'Robbers & Cowards', artist: 'Lucero' })),
    ]),
    1,
  );
  assert.equal(
    albumCount([
      ...many(3, () => track('Wrens/a', { album: 'The Meadowlands', artist: 'The Wrens' })),
      ...many(3, () => track('Wrens/b', { album: 'Meadowlands', artist: 'Wrens' })),
    ]),
    1,
  );
  assert.equal(
    albumCount([
      ...many(3, () => track('C/a', { album: 'Shine A Light', artist: 'Constantines' })),
      ...many(3, () => track('C/b', { album: 'Shine A Light', artist: 'The Constantines' })),
    ]),
    1,
  );
  // Different albums by the same artist stay different.
  assert.equal(
    albumCount([
      ...many(3, () => track('a/1', { album: 'Love', artist: 'Cult' })),
      ...many(3, () => track('a/2', { album: 'Love Songs', artist: 'Cult' })),
    ]),
    2,
  );
  // Same title, different artists: two albums.
  assert.equal(
    albumCount([
      ...many(3, () => track('a/1', { album: 'Greatest Hits', artist: 'Queen' })),
      ...many(3, () => track('b/1', { album: 'Greatest Hits', artist: 'ABBA' })),
    ]),
    2,
  );
  // Non-Latin titles are not collapsed into one empty string.
  const jp = ['\u3042', '\u3044', '\u3046'].flatMap((title) => many(2, () => track(`t/${title}`, { album: title, artist: 't\u00e9' })));
  assert.equal(albumCount(jp), 3);
  const bangs = ['!!!', '???'].flatMap((title) => many(2, () => track(`x/${title}`, { album: title, artist: 'Chk' })));
  assert.equal(albumCount(bangs), 2);
}

// -- R4: feat. tails, Unknown Artist ------------------------------------------------
{
  const own = many(5, () => track('Daft Punk/RAM', { album: 'RAM', artist: 'Daft Punk' }));
  const guest = track('Daft Punk/RAM', { album: 'RAM', artist: 'Daft Punk feat. Pharrell Williams' });
  const r = run([...own, guest]);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(guest).albumArtistDisplay, 'Daft Punk');
  // A name that contains "ft" is left alone.
  const soft = many(4, () => track('Soft Cell/Non-Stop', { album: 'Non-Stop Erotic Cabaret', artist: 'Soft Cell' }));
  assert.equal(run(soft).of(soft[0]).albumArtistDisplay, 'Soft Cell');
  // A track with no artist casts no vote and joins the folder's one real artist.
  const beck = many(5, () => track('Beck/Odelay', { album: 'Odelay', artist: 'Beck' }));
  const unknown = many(2, () => track('Beck/Odelay', { album: 'Odelay', artist: 'Unknown Artist' }));
  const u = run([...beck, ...unknown]);
  assert.equal(u.albums.size, 1);
  assert.equal(u.of(unknown[0]).albumArtistDisplay, 'Beck');
  // A folder of nothing but unknown artists is one album by Unknown Artist.
  const nobody = many(4, () => track('Voice Memos', { album: 'Memos', artist: 'Unknown Artist' }));
  const n = run(nobody);
  assert.equal(n.albums.size, 1);
  assert.equal(n.of(nobody[0]).albumArtistDisplay, 'Unknown Artist');
  // Unknown artists do not count toward the three artists a compilation needs.
  const pair = [
    track('Mix', { album: 'Mix', artist: 'A' }),
    track('Mix', { album: 'Mix', artist: 'B' }),
    track('Mix', { album: 'Mix', artist: 'Unknown Artist' }),
    track('Mix', { album: 'Mix', artist: 'Unknown Artist' }),
  ];
  assert.notEqual(run(pair).of(pair[0]).albumKind, 'compilation');
}

// -- R5: the folder's album artist tag reaches its untagged tracks ------------------
{
  const tagged = many(4, () => track('Beck/Song Reader', { album: 'Song Reader', artist: 'Various', aa: 'Beck' }));
  const bare = many(2, () => track('Beck/Song Reader', { album: 'Song Reader', artist: 'Jack White' }));
  const r = run([...tagged, ...bare]);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(bare[0]).albumArtistDisplay, 'Beck');
  assert.match(r.of(bare[0]).albumReason, /Grouped under Beck, the album artist most of these files name\. 2 tracks had none\./);
  // Under half tagged: the inheritance does not apply.
  const few = [
    track('x/y', { album: 'Z', artist: 'Aa', aa: 'Owner' }),
    ...many(4, (i) => track('x/y', { album: 'Z', artist: `Solo ${i}` })),
  ];
  assert.notEqual(run(few).of(few[1]).albumArtistDisplay, 'Owner');
}

// -- R6: the compilation flag ------------------------------------------------------
{
  const covers = many(40, (i) => track('Rough Trade/Covers', { album: 'Rough Trade Shops: Covers Vol. 1', artist: `Band ${i}`, cmp: true }));
  const r = run(covers);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(covers[0]).albumKind, 'compilation');
  assert.equal(r.of(covers[0]).albumArtistDisplay, 'Various Artists');
  assert.match(r.of(covers[0]).albumReason, /Grouped as a compilation: 40 tracks carry the compilation flag/);

  // Flagged, but every file names one real album artist: it stays that artist's (272 tracks like this in the audit).
  const neil = many(10, (i) => track('Neil Young/Archives', { album: 'Archives Vol. III', artist: `Neil Young ${i % 2 ? '& Crazy Horse' : ''}`.trim(), aa: 'Neil Young Archives', cmp: true }));
  const n = run(neil);
  assert.equal(n.albums.size, 1);
  assert.equal(n.of(neil[0]).albumKind, 'album');
  assert.equal(n.of(neil[0]).albumArtistDisplay, 'Neil Young Archives');

  // Flagged and the files say Various Artists.
  const va = [
    ...many(3, (i) => track('Soundtrack', { album: 'OST', artist: `Cast ${i}`, aa: 'Various Artists', cmp: true })),
    ...many(3, (i) => track('Soundtrack', { album: 'OST', artist: `Other ${i}`, cmp: true })),
  ];
  const v = run(va);
  assert.equal(v.albums.size, 1);
  assert.equal(v.of(va[0]).albumArtistDisplay, 'Various Artists');
  // Flagged with three or more different album artists.
  const diverse = ['A', 'B', 'C'].flatMap((aa) => many(2, () => track('Mixed', { album: 'Mixed', artist: aa, aa, cmp: true })));
  assert.equal(albumCount(diverse), 1);
  // Flagged on fewer than half the tracks: the flag alone does not decide; the artists do.
  const sparse = [
    track('Folder', { album: 'Folder', artist: 'One', cmp: true }),
    ...many(7, (i) => track('Folder', { album: 'Folder', artist: `Other ${i}` })),
  ];
  assert.equal(run(sparse).of(sparse[0]).albumKind, 'compilation', 'seven artists and no tags: inferred');
  const sparseSame = [
    track('Folder2', { album: 'Folder2', artist: 'One', cmp: true }),
    ...many(7, () => track('Folder2', { album: 'Folder2', artist: 'One' })),
  ];
  assert.equal(run(sparseSame).of(sparseSame[0]).albumKind, 'album');
  // Before a row has been read for the flag, it is not guessed at.
  const unread = many(2, (i) => track('Unread', { album: 'Unread', artist: `A${i}`, cmp: true, known: false }));
  assert.equal(run(unread).of(unread[0]).albumKind, 'album');
}

// -- R7: a compilation inferred from the folder --------------------------------------
{
  const a = (artists) => artists.map((artist) => track('Comp', { album: 'Comp', artist }));
  const four = a(['A', 'A', 'B', 'C']);
  assert.equal(run(four).of(four[0]).albumKind, 'compilation', '4 tracks, 3 artists, none above half');
  assert.match(run(four).of(four[0]).albumReason, /4 tracks by 3 different artists, with no album artist in the files/);
  assert.equal(INFER_MIN_TRACKS, 4);
  const three = a(['A', 'B', 'C']);
  assert.equal(run(three).albums.size, 3, 'three tracks are three albums, not a compilation');
  const twoArtists = a(['A', 'A', 'B', 'B', 'A', 'B']);
  assert.equal(run(twoArtists).albums.size, 2, 'two artists are not enough');
  const crowd = a(Array.from({ length: 22 }, (_, i) => `Artist ${i}`));
  assert.equal(run(crowd).albums.size, 1);
  // Under half for the busiest artist is a compilation, however many tracks it has.
  const half = a(['A', 'A', 'A', 'B', 'C', 'D', 'E']);
  assert.equal(run(half).of(half[0]).albumKind, 'compilation', '3 of 7 is under half');
  // Above half but under 60%: not a compilation, and nobody owns the folder either.
  const between = a(['A', 'A', 'A', 'A', 'B', 'C', 'D']);
  assert.equal(run(between).albums.size, 4, '4 of 7 is neither a compilation nor an owner');
}

// -- R9: one artist owns the folder, the rest are guests -------------------------------
{
  const own = many(6, () => track('Owner/Album', { album: 'Album', artist: 'Owner' }));
  const guests = ['G1', 'G2', 'G3', 'G4'].map((artist) => track('Owner/Album', { album: 'Album', artist }));
  const r = run([...own, ...guests]);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(guests[0]).albumArtistDisplay, 'Owner');
  assert.equal(r.of(guests[0]).albumKind, 'album');
  assert.match(r.of(guests[0]).albumReason, /Grouped under Owner, who is on 60% of these tracks/);
  // Two artists splitting a folder evenly: two albums, nobody owns it.
  const split = [...many(5, () => track('Split', { album: 'Split', artist: 'Left' })), ...many(5, () => track('Split', { album: 'Split', artist: 'Right' }))];
  assert.equal(albumCount(split), 2);
  // A collaboration whose guests outnumber the owner's tracks, with the owner's tag on every file, stays the owner's.
  const collab = [
    ...many(2, () => track('Collab', { album: 'Collab', artist: 'Owner', aa: 'Owner' })),
    ...['G1', 'G2', 'G3', 'G4', 'G5', 'G6'].map((artist) => track('Collab', { album: 'Collab', artist: `Owner feat. ${artist}`, aa: 'Owner' })),
  ];
  const c = run(collab);
  assert.equal(c.albums.size, 1);
  assert.equal(c.of(collab[0]).albumKind, 'album');
  assert.equal(c.of(collab[0]).albumArtistDisplay, 'Owner');
  const guestsOnly = ['G1', 'G2', 'G3'].map((artist) => track('Collab2', { album: 'Collab2', artist, aa: 'Owner' }));
  assert.equal(run([...guestsOnly, track('Collab2', { album: 'Collab2', artist: 'Owner', aa: 'Owner' })]).albums.size, 1);
}

// -- real band names are never split -------------------------------------------------------
{
  const bands = ['Tegan and Sara', 'Iron & Wine', 'Crosby, Stills, Nash & Young', 'Tyler, The Creator'];
  const tracks = bands.flatMap((band) => many(5, () => track(`Bands/${band}`, { album: `${band} Album`, artist: band })));
  const r = run(tracks);
  assert.equal(r.albums.size, 4);
  for (const band of bands) {
    const t = tracks.find((x) => x.artist === band);
    assert.equal(r.of(t).albumArtistDisplay, band);
  }
  const mixed = [
    ...many(3, () => track('IW', { album: 'Our Endless Numbered Days', artist: 'Iron & Wine' })),
    ...many(3, () => track('IW', { album: 'Our Endless Numbered Days', artist: 'Iron and Wine' })),
  ];
  assert.equal(albumCount(mixed), 1);
}

// -- the album artist the user typed is a tag ---------------------------------------------------
{
  const edited = [
    track('E', { album: 'E', artist: 'Aa', albumArtist: 'Chosen', edited: true }),
    track('E', { album: 'E', artist: 'Bb', albumArtist: 'Chosen', edited: true }),
    track('E', { album: 'E', artist: 'Cc', albumArtist: 'Chosen', edited: true }),
    track('E', { album: 'E', artist: 'Dd', albumArtist: 'Chosen', edited: true }),
  ];
  const r = run(edited);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(edited[0]).albumArtistDisplay, 'Chosen');
  // Rows not read for the tag yet: an album artist unlike the track artist stands in for one.
  const proxy = [
    ...many(4, (i) => track('P', { album: 'P', artist: `Guest ${i}`, albumArtist: 'Owner', known: false })),
  ];
  const p = run(proxy);
  assert.equal(p.albums.size, 1);
  assert.equal(p.of(proxy[0]).albumArtistDisplay, 'Owner');
  assert.notEqual(p.of(proxy[0]).albumKind, 'compilation');
}

// -- R10: the same album in two folders ------------------------------------------------------------
{
  const a = many(4, (i) => track('Music/Revolver [LAME V0]', { album: 'Revolver', artist: 'The Beatles', trackNo: i + 1 }));
  const b = many(4, (i) => track('Music/Revolver [24Bit]', { album: 'Revolver', artist: 'The Beatles', trackNo: i + 1 }));
  const r = run([...a, ...b]);
  assert.equal(r.albums.size, 1);
  assert.match(r.of(a[0]).albumReason, /Joined 2 folders that hold the same album/);
  // Loose files in the library root join the artist folder's album.
  const loose = track('', { album: 'Revolver', artist: 'Beatles' });
  assert.ok(sameAlbum(run([...a, loose]), a[0], loose));
  // Two folders of a compilation joined: no tags, many artists in each.
  const left = many(6, (i) => track('Hits.80s.CD1', { album: 'Greatest Hits 80s', artist: `L${i}` }));
  const right = many(6, (i) => track('Hits.80s.CD2', { album: 'Greatest Hits 80s', artist: `R${i}` }));
  const joined = run([...left, ...right]);
  assert.equal(joined.albums.size, 1);
  assert.match(joined.of(left[0]).albumReason, /across 2 folders/);
  // Eight CD folders of a box set in one album folder: one container, eight discs.
  const box = Array.from({ length: 8 }, (_, d) => many(5, (i) => track(`Box/CD${d + 1}`, { album: 'Box', artist: `X${d}-${i}` }))).flat();
  const b8 = run(box);
  assert.equal(b8.albums.size, 1);
  assert.deepEqual([...new Set(box.map((t) => b8.of(t).discInferred))].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
}

// -- R11: a generic title is not one album ---------------------------------------------------------------
{
  const folders = ['a', 'b', 'c'].map((f) => many(5, () => track(`Lil Yachty/${f}`, { album: 'Unreleased', artist: 'Lil Yachty', aa: 'Lil Yachty' })));
  const r = run(folders.flat());
  assert.equal(r.albums.size, 3);
  assert.equal(r.of(folders[0][0]).albumKind, 'bucket');
  assert.match(r.of(folders[0][0]).albumReason, /Several folders use the generic title "Unreleased"/);
  assert.equal(r.of(folders[0][0]).albumDisplay, 'Unreleased');
  // One folder with a generic title and few tracks is just an album.
  const small = many(10, () => track('Only/One', { album: 'Unreleased', artist: 'Solo', aa: 'Solo' }));
  assert.equal(run(small).of(small[0]).albumKind, 'album');
  // But a generic title with a library's worth of tracks is a bucket even in one folder.
  const big = many(BUCKET_MIN_TRACKS, () => track('Big', { album: 'Singles', artist: 'Solo', aa: 'Solo' }));
  assert.equal(run(big).of(big[0]).albumKind, 'bucket');
  // A real title in several folders is the same album, not a bucket.
  const copies = ['x', 'y'].map((f) => many(5, () => track(`Copies/${f}`, { album: 'Nevermind', artist: 'Nirvana' })));
  assert.equal(run(copies.flat()).albums.size, 1);
  // A year as a title is generic.
  const years = ['y1', 'y2'].map((f) => many(3, () => track(`Future/${f}`, { album: '2014/15', artist: 'Future', aa: 'Future' })));
  assert.equal(run(years.flat()).albums.size, 2);
}

// -- the compilation flag on one artist, Unknown Artist votes, discs, split records, generic compilations ----------------
{
  // An artist's own album marked "part of a compilation", with no ALBUMARTIST: still theirs, and two of them never merge.
  const queen = many(8, (i) => track('Queen/Greatest Hits', { album: 'Greatest Hits', artist: 'Queen', cmp: true, trackNo: i + 1 }));
  const abba = many(8, (i) => track('ABBA/Greatest Hits', { album: 'Greatest Hits', artist: 'ABBA', cmp: true, trackNo: i + 1 }));
  const r = run([...queen, ...abba]);
  assert.equal(r.albums.size, 2, 'two single-artist albums, each flagged, stay two albums');
  assert.equal(r.of(queen[0]).albumKind, 'album');
  assert.equal(r.of(queen[0]).albumArtistDisplay, 'Queen');
  assert.equal(r.of(abba[0]).albumArtistDisplay, 'ABBA');
  // A flagged folder of several untagged artists is still the compilation the flag says it is.
  const flagged = many(6, (i) => track('Hits/Now', { album: 'Now', artist: `Act ${i}`, cmp: true }));
  assert.equal(run(flagged).of(flagged[0]).albumKind, 'compilation');
  // Two artists are enough for the flag to decide.
  const duo = [...many(3, () => track('Duo', { album: 'Duo', artist: 'One', cmp: true })), ...many(3, () => track('Duo', { album: 'Duo', artist: 'Two', cmp: true }))];
  assert.equal(run(duo).of(duo[0]).albumKind, 'compilation');
}

{
  // "Unknown Artist" on most of a folder does not outvote the one real artist on the rest.
  const unknown = many(16, () => track('Van/Unplugged', { album: 'Unplugged in the Studio', artist: 'Unknown Artist' }));
  const van = many(2, () => track('Van/Unplugged', { album: 'Unplugged in the Studio', artist: 'Van Morrison' }));
  const r = run([...unknown, ...van]);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(unknown[0]).albumArtistDisplay, 'Van Morrison');
  assert.equal(r.of(van[0]).albumArtistDisplay, 'Van Morrison');
  assert.match(r.of(unknown[0]).albumReason, /Grouped under Van Morrison, the only artist named in this folder\. 16 tracks named none\./);
  // With a real owner and guests, the unknown tracks join the owner and only named tracks count toward the 60%.
  const owner = many(6, () => track('Own/Rec', { album: 'Rec', artist: 'Owner' }));
  const guests = ['G1', 'G2'].map((artist) => track('Own/Rec', { album: 'Rec', artist }));
  const nobody = many(10, () => track('Own/Rec', { album: 'Rec', artist: 'Unknown Artist' }));
  const o = run([...owner, ...guests, ...nobody]);
  assert.equal(o.albums.size, 1);
  assert.equal(o.of(nobody[0]).albumArtistDisplay, 'Owner');
  // Too few named tracks to call anyone the owner.
  const thin = [
    ...many(2, () => track('Thin', { album: 'Thin', artist: 'A' })),
    track('Thin', { album: 'Thin', artist: 'B' }),
    ...many(10, () => track('Thin', { album: 'Thin', artist: 'Unknown Artist' })),
  ];
  assert.equal(run(thin).of(thin[0]).albumKind, 'album');
  assert.notEqual(run(thin).of(thin[0]).albumArtistDisplay, 'Various Artists');
}

{
  // One file naming Various Artists among untagged tracks by many artists: one compilation.
  const one = track('Now 5', { album: 'Now 5', artist: 'Act 0', aa: 'Various Artists' });
  const rest = many(9, (i) => track('Now 5', { album: 'Now 5', artist: `Act ${i + 1}` }));
  const r = run([one, ...rest]);
  assert.equal(r.albums.size, 1);
  assert.equal(r.of(one).albumKind, 'compilation');
  assert.match(r.of(one).albumReason, /1 file names Various Artists as the album artist and the rest name none/);
  // Most of the folder tagged is a different story: the tags decide, not the inference.
  const heavy = [
    ...many(3, (i) => track('Heavy', { album: 'Heavy', artist: `T${i}`, aa: 'Various Artists' })),
    ...many(5, (i) => track('Heavy', { album: 'Heavy', artist: `U${i}` })),
  ];
  assert.ok(run(heavy).albums.size > 1, 'a third of the folder tagged is past the inference limit');
  // A tag that names a real artist does not turn the rest of the folder into a compilation.
  const real = [
    track('Real', { album: 'Real', artist: 'X0', aa: 'Owner' }),
    ...many(9, (i) => track('Real', { album: 'Real', artist: `X${i + 1}` })),
  ];
  assert.notEqual(run(real).of(real[1]).albumKind, 'compilation');
}

{
  // Two bands on one record are not either band's album.
  const furnaces = many(10, () => track('Splits/EP', { album: 'EP', artist: 'The Fiery Furnaces' }));
  const owen = many(4, () => track('Splits/EP', { album: 'EP', artist: 'Owen' }));
  assert.equal(run([...furnaces, ...owen]).albums.size, 1, 'a plain "EP" in a plain folder: the dominant band owns it');
  const titled = [
    ...many(3, () => track('Splits/Sunshine', { album: 'Sunshine at the Drive-In Split EP', artist: 'At The Drive-In' })),
    ...many(4, () => track('Splits/Sunshine', { album: 'Sunshine at the Drive-In Split EP', artist: 'Sunshine' })),
    ...many(3, () => track('Splits/Sunshine', { album: 'Sunshine at the Drive-In Split EP', artist: 'Sunshine' })),
  ];
  assert.equal(run(titled).albums.size, 2, '"split" in the title leaves each band its own tracks');
  const named = [
    ...many(10, () => track('Splits/Fiery Furnaces - Owen', { album: 'EP', artist: 'The Fiery Furnaces' })),
    ...many(4, () => track('Splits/Fiery Furnaces - Owen', { album: 'EP', artist: 'Owen' })),
  ];
  assert.equal(run(named).albums.size, 2, 'a folder that names both bands is a shared record');
  // A collaboration filed under its own name, with a few tracks under each half's name: one album.
  const collab = [
    ...many(9, () => track('Future & Young Thug - Super Slimey - 2017', { album: 'SUPER SLIMEY', artist: 'Future & Young Thug' })),
    ...many(2, () => track('Future & Young Thug - Super Slimey - 2017', { album: 'SUPER SLIMEY', artist: 'Future' })),
    ...many(2, () => track('Future & Young Thug - Super Slimey - 2017', { album: 'SUPER SLIMEY', artist: 'Young Thug' })),
  ];
  const c = run(collab);
  assert.equal(c.albums.size, 1, 'the halves of a duo\'s name are not a second band');
  assert.equal(c.of(collab[0]).albumArtistDisplay, 'Future & Young Thug');
  // The same act spelled two ways in a folder that names it.
  const zappa = [
    ...many(11, () => track('Frank_Zappa_And_The_Mothers_Of_Invention-Freak_Out-1966', { album: 'Freak Out!', artist: 'Frank Zappa And The Mothers Of Invention' })),
    ...many(4, () => track('Frank_Zappa_And_The_Mothers_Of_Invention-Freak_Out-1966', { album: 'Freak Out!', artist: 'Frank Zappa' })),
  ];
  assert.equal(run(zappa).albums.size, 1);
}

{
  // Files that all say disc 1 under titles that name discs 1 and 2: the title orders them.
  const d1 = many(3, (i) => track('Band/Live', { album: 'Live (Disc 1)', artist: 'Band', discNo: 1, trackNo: i + 1 }));
  const d2 = many(3, (i) => track('Band/Live', { album: 'Live (Disc 2)', artist: 'Band', discNo: 1, trackNo: i + 1 }));
  const r = run([...d1, ...d2]);
  assert.equal(r.albums.size, 1);
  assert.deepEqual(d1.map((t) => r.of(t).discInferred), [1, 1, 1]);
  assert.deepEqual(d2.map((t) => r.of(t).discInferred), [2, 2, 2]);
  // Files that number their discs correctly keep their own numbers.
  const e1 = many(3, (i) => track('Band/Studio', { album: 'Studio (Disc 1)', artist: 'Band', discNo: 1, trackNo: i + 1 }));
  const e2 = many(3, (i) => track('Band/Studio', { album: 'Studio (Disc 2)', artist: 'Band', discNo: 2, trackNo: i + 1 }));
  const s = run([...e1, ...e2]);
  assert.deepEqual([...e1, ...e2].map((t) => s.of(t).discInferred), [null, null, null, null, null, null]);
}

{
  // The same generic compilation title in two folders is two compilations.
  const eighties = many(8, (i) => track('Comps/Greatest Hits of the 80s', { album: 'Greatest Hits', artist: `Act ${i}` }));
  const motown = many(8, (i) => track('Comps/Motown Greatest Hits', { album: 'Greatest Hits', artist: `Soul ${i}` }));
  const r = run([...eighties, ...motown]);
  assert.equal(r.albums.size, 2);
  assert.equal(r.of(eighties[0]).albumKind, 'compilation');
  assert.notEqual(r.of(eighties[0]).albumKey, r.of(motown[0]).albumKey);
  assert.equal(r.of(eighties[0]).albumKey.startsWith('greatest hits|~va|@'), true);
  // Disc markers in the titles say it is one set across folders.
  const left = many(6, (i) => track('Comps/Hits A', { album: 'Greatest Hits (Disc 1)', artist: `L${i}` }));
  const right = many(6, (i) => track('Comps/Hits B', { album: 'Greatest Hits (Disc 2)', artist: `R${i}` }));
  assert.equal(run([...left, ...right]).albums.size, 1);
  // A specific title across folders still joins, as before.
  const a = many(6, (i) => track('Comps/Rough Trade 1', { album: 'Rough Trade Shops Covers', artist: `L${i}` }));
  const b = many(6, (i) => track('Comps/Rough Trade 2', { album: 'Rough Trade Shops Covers', artist: `R${i}` }));
  assert.equal(run([...a, ...b]).albums.size, 1);
}

{
  // A sort tag that is the name reordered is used; one that shares no word with the name is a mis-filed tag.
  assert.equal(artistSortKey('Billie Eilish', 'Eilish, Billie'), 'eilish, billie');
  assert.equal(artistSortKey('The Who', 'Who, The'), 'who, the');
  assert.equal(artistSortKey('The Hold Steady', 'Boys and Girls in America: Deluxe Edition'), 'hold steady');
  assert.equal(artistSortKey('Half Japanese', 'Band That Would Be King'), 'half japanese');
  assert.equal(artistSortKey('', 'Anything'), 'anything', 'with no name to check against, the tag stands');
  const steady = many(3, () => track('Steady/Boys', { album: 'Boys and Girls in America', artist: 'The Hold Steady', aa: 'The Hold Steady', albumArtistSort: 'Boys and Girls in America: Deluxe Edition' }));
  assert.equal(run(steady).of(steady[0]).albumSortKey, 'hold steady');
  const eilish = many(3, () => track('Eilish/Happier', { album: 'Happier Than Ever', artist: 'Billie Eilish', aa: 'Billie Eilish', albumArtistSort: 'Eilish, Billie' }));
  assert.equal(run(eilish).of(eilish[0]).albumSortKey, 'eilish, billie');
}

// -- album year, display text, sort name ---------------------------------------------------------------------
{
  const years = [2002, 2002, 2022, 2002, 26, null].map((year) => track('Y', { album: 'Yankee', artist: 'Wilco', year }));
  assert.equal(run(years).of(years[0]).albumYear, 2002, 'the common year, not the earliest or the latest');
  const tie = [1989, 2024].map((year) => track('T', { album: 'Tweez', artist: 'Slint', year }));
  assert.equal(run(tie).of(tie[0]).albumYear, 1989);
  const none = [track('N', { album: 'N', artist: 'N', year: 0 })];
  assert.equal(run(none).of(none[0]).albumYear, null);

  const beatles = many(3, () => track('B', { album: 'Revolver', artist: 'The Beatles', aa: 'The Beatles' }));
  assert.equal(run(beatles).of(beatles[0]).albumSortKey, 'beatles');
  const sorted = many(3, () => track('B2', { album: 'Abbey Road', artist: 'The Beatles', aa: 'The Beatles', albumArtistSort: 'Beatles, The' }));
  assert.equal(run(sorted).of(sorted[0]).albumSortKey, 'beatles, the');
  const va = many(4, (i) => track('V', { album: 'V', artist: `A${i}`, cmp: true }));
  assert.equal(run(va).of(va[0]).albumSortKey, 'various artists');
}

// -- a plain album says nothing about itself -----------------------------------------------------------------------
{
  const plain = many(10, (i) => track('Band/Record', { album: 'Record', artist: 'Band', trackNo: i + 1 }));
  const r = run(plain);
  assert.equal(r.of(plain[0]).albumReason, null);
  assert.equal(r.of(plain[0]).albumKind, 'album');
  assert.equal(r.of(plain[0]).discInferred, null);
}

// -- "show as separate albums" ---------------------------------------------------------------------------------------
{
  const comp = many(6, (i) => track('Mix CD', { album: 'Mix CD', artist: `Artist ${i}` }));
  const other = many(4, () => track('Band/Record', { album: 'Record', artist: 'Band' }));
  assert.equal(albumCount([...comp, ...other]), 2);
  const fingerprint = containerFingerprint(comp[0].path, comp[0].album);
  const split = run([...comp, ...other], new Set([fingerprint]));
  assert.equal(split.albums.size, 7, 'six pieces and the other album');
  assert.equal(split.of(comp[0]).albumKind, 'split');
  assert.equal(split.of(comp[0]).albumArtistDisplay, 'Artist 0');
  assert.match(split.of(comp[0]).albumReason, /Shown as separate albums at your request/);
  assert.equal(split.of(other[0]).albumKind, 'album');
  // The fingerprint does not depend on the file or on the disc marker.
  assert.equal(containerFingerprint('K:/music/Mix CD/0001.mp3', 'Mix CD'), containerFingerprint('K:\\Music\\Mix CD\\other.flac', 'Mix CD (disc 2)'));
}

// -- the answer does not depend on the order tracks arrive in -------------------------------------------------------------
{
  const set = [
    ...many(8, (i) => track('Comp', { album: 'Comp', artist: `Artist ${i}` })),
    ...many(5, () => track('Band/Record', { album: 'Record', artist: 'Band' })),
    ...many(3, () => track('Band/Record', { album: 'Record (disc 2)', artist: 'BAND' })),
    ...many(4, () => track('Odd', { album: 'Odd', artist: 'Solo', aa: 'Solo', cmp: true })),
  ];
  const forward = run(set);
  const shuffled = [...set].sort(() => Math.random() - 0.5);
  const back = run(shuffled);
  for (const t of set) assert.deepEqual(back.of(t), forward.of(t));
}

// -- the pass reports only what changed -------------------------------------------------------------------------------------
{
  const set = many(5, () => track('Band/Record', { album: 'Record', artist: 'Band' }));
  const first = run(set);
  const again = computeAlbumIdentities(set.map((t) => ({ ...t, prev: { ...first.of(t), discInferred: null } })));
  assert.equal(again.summary.changed, 0);
  const moved = computeAlbumIdentities(set.map((t) => ({ ...t, prev: { ...first.of(t), albumKey: 'old key', discInferred: null } })));
  assert.equal(moved.summary.changed, 5);
}

// -- a track on its own gets the plain grouping ------------------------------------------------------------------------------
{
  const t = track('Band/Record', { album: 'Record (CD2)', artist: 'The Band', year: 1999 });
  const p = provisionalIdentity(t);
  assert.equal(p.albumKey, keyForPair('The Band', 'Record'));
  assert.equal(p.albumDisplay, 'Record');
  assert.equal(p.discInferred, 2);
  assert.equal(p.albumYear, 1999);
  assert.equal(keyForPair('Various Artists', 'Mix'), 'mix|~va');
  assert.equal(keyForPair('wilco', 'Summerteeth'), keyForPair('WILCO', 'summerteeth '));
}

// -- the album page cuts a multi-disc album into discs --------------------------------------------------------------
{
  const row = (title, over = {}) => ({ title, discNo: null, discInferred: null, discSubtitle: null, duration: 100, ...over });
  assert.equal(splitIntoDiscs([row('a'), row('b')]), null, 'one disc needs no headings');
  assert.equal(splitIntoDiscs([]), null);
  assert.equal(splitIntoDiscs([row('a', { discNo: 1 }), row('b', { discNo: 1 })]), null);
  const two = splitIntoDiscs([
    row('a', { discNo: 1, discSubtitle: 'First' }),
    row('b', { discNo: 1 }),
    row('c', { discInferred: 2 }),
    row('d', { discInferred: 2, duration: 50 }),
    row('e', { discNo: 2 }),
  ]);
  assert.deepEqual(two.map((d) => [d.disc, d.tracks.length, d.start, d.subtitle, d.duration]), [[1, 2, 0, 'First', 200], [2, 3, 2, null, 250]]);
  // A track with no disc at all counts as disc 1 beside discs that have one.
  const mixed = splitIntoDiscs([row('a'), row('b', { discNo: 2 })]);
  assert.deepEqual(mixed.map((d) => d.disc), [1, 2]);
  // The disc the grouping settled on beats the file's own number.
  const settled = splitIntoDiscs([row('a', { discNo: 1, discInferred: 1 }), row('b', { discNo: 1, discInferred: 2 })]);
  assert.deepEqual(settled.map((d) => d.disc), [1, 2]);
}

console.log('[album-identity-test] ok: folds, disc markers, compilations, buckets, years, overrides and ordering');
