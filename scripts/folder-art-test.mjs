import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { chooseFolderArt, isDiscFolderName, isFolderArtImage, looksLikeAlbumFolder } from '../dist-electron/electron/folder-art.js';

// The rule that finds a cover image in an album folder, first on folder
// listings (names are the kind the owner's library holds), then through a real
// scan, including the rescan of rows that were scanned before the image came.

const KB = 1024;
const images = (...entries) => entries.map(([name, size = 200 * KB]) => ({ name, size }));
const folder = (list, subdirs = []) => ({ images: images(...list), subdirs });
const pick = (own, parent = null) => {
  const chosen = chooseFolderArt(own, parent);
  return chosen ? `${chosen.from}:${chosen.image.name}` : null;
};

// Names the rule has always taken still win, in the same order.
assert.equal(pick(folder([['folder.jpg'], ['cover.jpg']])), 'own:cover.jpg');
assert.equal(pick(folder([['Folder.JPG'], ['front.png']])), 'own:Folder.JPG', 'case does not matter');
assert.equal(pick(folder([['art.jpg'], ['album.jpg']])), 'own:art.jpg');
assert.equal(pick(folder([['cover.png'], ['cover.jpg']])), 'own:cover.jpg', 'jpg before png for one name');
assert.equal(pick(folder([['cover.jpg', 40]])), 'own:cover.jpg', 'a named cover is trusted whatever its size');

// More formats and names under the same rule.
assert.equal(pick(folder([['folder.jpeg']])), 'own:folder.jpeg');
assert.equal(pick(folder([['Folder.bmp']])), 'own:Folder.bmp');
assert.equal(pick(folder([['cover.gif']])), 'own:cover.gif');
assert.equal(pick(folder([['front.webp']])), 'own:front.webp');
assert.equal(pick(folder([['AlbumArt.jpg']])), 'own:AlbumArt.jpg');
assert.equal(pick(folder([['Artwork.jpg']])), 'own:Artwork.jpg');
assert.equal(pick(folder([['Album Cover.jpg']])), 'own:Album Cover.jpg');
assert.equal(
  pick(folder([['AlbumArt_{DEFE980E-B143-4E3D-872A-0DB48077A60F}_Large.jpg'], ['AlbumArt_{DEFE980E-B143-4E3D-872A-0DB48077A60F}_Small.jpg', 2 * KB]])),
  'own:AlbumArt_{DEFE980E-B143-4E3D-872A-0DB48077A60F}_Large.jpg',
  'the big Windows Media Player file, not its thumbnail',
);

// No file named like a cover: the one image that is not a back or a booklet.
assert.equal(pick(folder([['Wilco-Schmilco.jpg']])), 'own:Wilco-Schmilco.jpg');
assert.equal(pick(folder([['00-yg-my_krazy_life-(deluxe_edition)-2014.jpg']])), 'own:00-yg-my_krazy_life-(deluxe_edition)-2014.jpg');
assert.equal(pick(folder([['Radiohead - Interview CD.jpg']])), 'own:Radiohead - Interview CD.jpg', 'CD ending a title is not a disc scan');
assert.equal(pick(folder([['00-sam_fender-hypersonic_missiles-cd-2019.jpg']])), 'own:00-sam_fender-hypersonic_missiles-cd-2019.jpg');
assert.equal(
  pick(folder([['Placebo - Sleeping With Ghosts [4743242].png'], ['Placebo - Sleeping With Ghosts [4743242]-Back.png'], ['Placebo - Sleeping With Ghosts [4743242]-Insert.png'], ['Placebo - Sleeping With Ghosts [4743242]-Gatefold.png']])),
  'own:Placebo - Sleeping With Ghosts [4743242].png',
  'the front of a set of scans',
);
assert.equal(pick(folder([['Back to Black.jpg']])), 'own:Back to Black.jpg', 'back inside a title is a title');
assert.equal(pick(folder([['thumb.jpg', 50 * KB]])), 'own:thumb.jpg', 'a thumbnail alone is better than nothing');
assert.equal(pick(folder([['thumb.jpg', 50 * KB], ['Some Album.jpg']])), 'own:Some Album.jpg', 'and loses to a real image');

// Cover-like words beat unremarkable names, and back/booklet/disc scans never win.
assert.equal(pick(folder([['TM - L Front.jpg'], ['TM - L Back.jpg'], ['TM - L CD.jpg'], ['TM - L Inside.jpg']])), 'own:TM - L Front.jpg');
assert.equal(pick(folder([['Mindblow Cover.jpeg'], ['Mindblow Back.jpeg'], ['Mindblow Insert.jpeg']])), 'own:Mindblow Cover.jpeg');
assert.equal(pick(folder([['space_oddity-frontal.jpg'], ['space_oddity_compressed.jpg']])), 'own:space_oddity-frontal.jpg');
assert.equal(
  pick(folder([['flourescent grey booklet1.jpg'], ['flourescent grey booklet2.jpg'], ['FluorescentDemosCover.jpg']])),
  'own:FluorescentDemosCover.jpg',
);
assert.equal(pick(folder([['Back.jpg'], ['Booklet 1&2.jpg'], ['Booklet 3&4.jpg'], ['Booklet outer.jpg']])), null, 'nothing but the back and a booklet');
assert.equal(pick(folder([['back.jpg']])), null);
assert.equal(pick(folder([['cd.jpg']])), null);
assert.equal(pick(folder([['CSNY 1974 disc 2.jpg']])), null, 'a disc scan is not the album');
assert.equal(pick(folder([['black album poster actual size.jpg']])), null);

// What counts as an image file at all.
for (const name of ['a.jpg', 'A.JPG', 'a.jpeg', 'a.png', 'a.webp', 'a.bmp', 'a.gif']) assert.equal(isFolderArtImage(name), true, name);
for (const name of ['._a.jpg', '.hidden.png', 'a.tif', 'a.txt', 'Thumbs.db', 'jpg']) assert.equal(isFolderArtImage(name), false, name);

// No guessing between equally plausible images, and none from junk.
assert.equal(pick(folder([['_65A0476.jpg'], ['_65A0736.jpg']])), null, 'two unremarkable photos');
assert.equal(pick(folder([['Stevie Wonder - I Just Called.jpg'], ['Stevie Wonder - I Just Called (Instrumental).jpg']])), null);
assert.equal(pick(folder([['pic.jpg', 900]])), null, 'too small to be a cover');
assert.equal(pick(folder([['scan.jpg', 40 * 1024 * KB]])), null, 'too big to be worth holding');
assert.equal(pick(folder([])), null);

// A folder of folders is a library root or an artist folder, not an album.
assert.equal(pick(folder([['stray.jpg']], ['Artist One', 'Artist Two'])), null);
assert.equal(pick(folder([['AlbumArt_{DEFE980E-B143-4E3D-872A-0DB48077A60F}_Large.jpg']], ['Artist One'])), null, 'one album\'s file at a root');
assert.equal(pick(folder([['cover.jpg']], ['Artist One', 'Artist Two'])), 'own:cover.jpg', 'a cover.jpg at a root is shared, as it always was');
assert.equal(pick(folder([['Album.jpg']], ['Scans', 'Artwork'])), 'own:Album.jpg');
assert.equal(pick(folder([['Some Album.jpg']], ['Scans', 'Artwork'])), 'own:Some Album.jpg', 'extras folders do not make it a root');
assert.equal(pick(folder([['thumb.jpg', 20 * KB]], ['Pics'])), 'own:thumb.jpg');
assert.equal(looksLikeAlbumFolder(['CD1', 'CD2']), true);
assert.equal(looksLikeAlbumFolder(['CD1', 'Other Album']), false);

// One disc of a set looks one level up too.
const disc = folder([]);
assert.equal(pick(disc, folder([['cover.jpg']], ['CD1', 'CD2'])), 'parent:cover.jpg');
assert.equal(pick(disc, folder([['Album Name.jpg']], ['CD1', 'CD2'])), 'parent:Album Name.jpg');
assert.equal(pick(folder([['cover.png']]), folder([['cover.jpg']], ['CD1'])), 'own:cover.png', 'the disc\'s own cover first');
assert.equal(pick(folder([['Disc 1 scan.jpg']]), folder([['folder.jpg']], ['Disc 1'])), 'parent:folder.jpg', 'a named parent beats a guess in the disc');
assert.equal(pick(disc, folder([['Album Name.jpg']], ['Other Album', 'CD1'])), null, 'the parent of a disc can be an artist folder');
for (const name of ['CD1', 'CD 2', 'Disc 02', 'disk3', 'DVD1', 'Side A', 'Vol. 2', 'CD 1 (Car Chase)', 'Disc 2 - Live']) {
  assert.equal(isDiscFolderName(name), true, `${name} is a disc folder`);
}
for (const name of ['Album', 'Greatest Hits', 'Discovery']) {
  assert.equal(isDiscFolderName(name), false, `${name} is not`);
}

// Through a real scan. The first pass sees no images, so every row is stored
// without art; the images then arrive and the second pass must give them art
// while leaving the other rows unread.
const jpegLike = (tag) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(tag.padEnd(4 * KB, '.')), 0xff, 0xd9]);
const root = await mkdtemp(join(tmpdir(), 'newamp-folder-art-'));
const music = join(root, 'music');
const tracks = {
  single: [join(music, 'Artist One', 'Album Single', '01.mp3'), join(music, 'Artist One', 'Album Single', '02.mp3')],
  pair: [join(music, 'Artist One', 'Album Pair', '01.mp3')],
  discOne: [join(music, 'Artist One', 'Album Set', 'CD1', '01.mp3')],
  discTwo: [join(music, 'Artist One', 'Album Set', 'CD2', '01.mp3')],
  classic: [join(music, 'Artist One', 'Album Classic', '01.mp3')],
  booklet: [join(music, 'Artist One', 'Album Booklet', '01.mp3')],
  twoImages: [join(music, 'Artist One', 'Album Two Candidates', '01.mp3')],
  artistLoose: [join(music, 'Artist Two', 'loose.mp3')],
  albumX: [join(music, 'Artist Two', 'Album X', '01.mp3')],
  rootLoose: [join(music, 'root-loose.mp3')],
};
const allTracks = Object.values(tracks).flat();
for (const path of allTracks) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.from('not really audio'));
}

const wanted = {
  single: jpegLike('single'),
  pair: jpegLike('pair front'),
  set: jpegLike('set'),
  classic: jpegLike('classic'),
};
const library = await LibraryStore.open(join(root, 'library.db'));
try {
  const scan = async () => {
    let done;
    await new Scanner(library, (event) => {
      if (event.done) done = event;
    }).start([music]);
    return done;
  };
  const stateOf = (path) => library.getTrackFileStates([path]).get(path);

  const first = await scan();
  assert.equal(first.parsed, allTracks.length, 'the first scan reads every file');
  for (const path of allTracks) assert.ok(!stateOf(path).hasArt, `${path} starts without art`);

  await writeFile(join(music, 'Artist One', 'Album Single', 'Album Single.jpg'), wanted.single);
  await writeFile(join(music, 'Artist One', 'Album Pair', 'front.jpeg'), wanted.pair);
  await writeFile(join(music, 'Artist One', 'Album Pair', 'back.jpeg'), jpegLike('pair back'));
  await writeFile(join(music, 'Artist One', 'Album Set', 'Album Set.jpg'), wanted.set);
  await writeFile(join(music, 'Artist One', 'Album Classic', 'Cover.JPG'), wanted.classic);
  await writeFile(join(music, 'Artist One', 'Album Booklet', 'Booklet 1&2.jpg'), jpegLike('booklet'));
  await writeFile(join(music, 'Artist One', 'Album Booklet', 'back.jpg'), jpegLike('booklet back'));
  await writeFile(join(music, 'Artist One', 'Album Two Candidates', 'a.jpg'), jpegLike('a'));
  await writeFile(join(music, 'Artist One', 'Album Two Candidates', 'b.jpg'), jpegLike('b'));
  await writeFile(join(music, 'Artist Two', 'artist photo.jpg'), jpegLike('artist'));
  await writeFile(join(music, 'stray.jpg'), jpegLike('stray'));

  const second = await scan();
  const gaining = [...tracks.single, ...tracks.pair, ...tracks.discOne, ...tracks.discTwo, ...tracks.classic];
  assert.equal(second.parsed, gaining.length, 'only the rows whose folder now has a cover are read again');
  assert.equal(second.skipped, allTracks.length - gaining.length, 'the rest are skipped as unchanged');

  const artOf = (path) => {
    const state = stateOf(path);
    return state.hasArt ? library.getArt(state.id)?.data : null;
  };
  for (const path of tracks.single) assert.deepEqual(artOf(path), wanted.single, 'the only image, whatever its name');
  assert.deepEqual(artOf(tracks.pair[0]), wanted.pair, 'front.jpeg, not back.jpeg');
  assert.deepEqual(artOf(tracks.discOne[0]), wanted.set, 'disc 1 takes the image in the folder above');
  assert.deepEqual(artOf(tracks.discTwo[0]), wanted.set, 'disc 2 does too');
  assert.deepEqual(artOf(tracks.classic[0]), wanted.classic, 'Cover.JPG');
  for (const path of [...tracks.booklet, ...tracks.twoImages]) assert.ok(!stateOf(path).hasArt, `${path} has nothing to pick`);
  for (const path of [...tracks.artistLoose, ...tracks.rootLoose]) {
    assert.ok(!stateOf(path).hasArt, `${path} sits beside folders, so a stray image is not its cover`);
  }
  assert.ok(!stateOf(tracks.albumX[0]).hasArt);

  const third = await scan();
  assert.equal(third.parsed, 0, 'a third scan has nothing left to read');
} finally {
  library.close();
  await rm(root, { recursive: true, force: true });
}

console.log('[folder-art-test] ok');
