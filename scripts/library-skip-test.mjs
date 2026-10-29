// What a library scan leaves alone (electron/library-skip.ts):
//  - "._" AppleDouble files, which macOS writes beside every file it copies to
//    an SMB, NFS or exFAT volume, and the __MACOSX folder of a Mac-made zip.
//    They carry audio extensions and used to become "Unknown Artist" tracks.
//  - macOS packages (Logic and GarageBand projects, the Logic sound library,
//    the Music library) and the Logic/GarageBand and Ableton sample folders in
//    ~/Music. A fresh Mac profile scans ~/Music, and on a Mac with Logic Pro
//    3,095 of the 3,181 "tracks" it found were loops and impulse responses.
//  - Windows' recycle bin at the root of a drive.
//  - Everything else, including Ableton's own recordings and a folder that
//    only looks like a package name in the middle, is still scanned.
//  - The watcher ignores events from the same places.
//  - A library an earlier version filled from those places: the next scan
//    marks those tracks missing even though their files are there, and Clean
//    missing files removes them (and nothing else). Nothing on disk is touched.
//  - ".band" only counts as a GarageBand project inside a GarageBand folder,
//    so an album folder named "Big.Band" is scanned.
//  - A file the storage fails to read for a moment (a network share timing
//    out) gets no guessed "Unknown Artist" row, which later scans would keep
//    because its size and date match; the next scan reads it.
// Run: npm run build:electron && node scripts/library-skip-test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { resolveLibraryWatchTarget } from '../dist-electron/electron/library-watcher.js';
import { isForeignLibraryPath, isSkippedLibraryFile, isSkippedLibraryFolder, isSkippedLibraryPath } from '../dist-electron/electron/library-skip.js';

// 1. The rules on their own.
assert.equal(isSkippedLibraryFile('._01 Intro.mp3'), true);
assert.equal(isSkippedLibraryFile('.hidden.flac'), true);
assert.equal(isSkippedLibraryFile('01 Intro.mp3'), false);
assert.equal(isSkippedLibraryFolder('Jam.band', 'GarageBand'), true);
assert.equal(isSkippedLibraryFolder('Big.Band'), false, 'a dotted album folder is not a GarageBand project');
assert.equal(isSkippedLibraryPath('User Library/kick.wav', 'Ableton'), true, 'the root itself can be the Ableton folder');
for (const name of ['Logic Pro Library.bundle', 'Song.logicx', 'Music Library.musiclibrary', 'NewAmp.app', 'Reverb.vst3', '__MACOSX', 'Audio Music Apps', 'Apple Loops', '$RECYCLE.BIN', 'System Volume Information', '.Trashes']) {
  assert.equal(isSkippedLibraryFolder(name), true, `${name} is skipped`);
}
assert.equal(isSkippedLibraryFolder('User Library', 'Ableton'), true);
assert.equal(isSkippedLibraryFolder('Factory Packs', 'Ableton'), true);
assert.equal(isSkippedLibraryFolder('User Library', 'Music'), false, 'only inside an Ableton folder');
for (const name of ['Live Recordings', 'Radiohead', 'Mr. Bungle', 'Vol. 1', 'Bundle of Joy', 'OK Computer (Deluxe)']) {
  assert.equal(isSkippedLibraryFolder(name), false, `${name} is scanned`);
}
assert.equal(isSkippedLibraryPath('Artist/Album/01.mp3'), false);
assert.equal(isSkippedLibraryPath('Artist/Album/._01.mp3'), true);
assert.equal(isSkippedLibraryPath('__MACOSX/Album/._01.mp3'), true);
assert.equal(isSkippedLibraryPath('Logic/Song.logicx/Media/Audio Files/Bass.wav'), true);
assert.equal(isSkippedLibraryPath('Ableton\\User Library\\Samples\\kick.wav'), true, 'Windows separators too');
assert.equal(isSkippedLibraryPath('Ableton/Live Recordings/take.wav'), false);
assert.equal(isSkippedLibraryPath(''), false);
// What an earlier version may have indexed and can now go: other apps' folders
// and "._" files. A hidden folder is skipped by the walk but not counted, since
// a track there may have been opened on purpose.
assert.equal(isForeignLibraryPath('Artist/Album/._01.mp3'), true);
assert.equal(isForeignLibraryPath('Audio Music Apps/Sampler Instruments/C3.wav'), true);
assert.equal(isForeignLibraryPath('User Library/kick.wav', 'Ableton'), true);
assert.equal(isForeignLibraryPath('.hidden/song.mp3'), false);
assert.equal(isForeignLibraryPath('Artist/.secret take.mp3'), false);
assert.equal(isForeignLibraryPath('Count Basie/Big.Band/01.mp3'), false);

// 2. A scan over a tree that has all of them.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-skip-test');
await rm(root, { recursive: true, force: true });
const music = join(root, 'Music');
const files = {
  kept: [
    'Artist/Album/01 Intro.mp3',
    'Artist/Album/02 Song.flac',
    'Music/Media.localized/Music/Band/Record/01 Track.m4a',
    'Ableton/Live Recordings/2026-10-28 take.wav',
    'Mr. Bungle/Disco Volante/01.mp3',
    'Count Basie/Big.Band/01.mp3',
  ],
  skipped: [
    'Artist/Album/._01 Intro.mp3',
    '__MACOSX/Artist/Album/._02 Song.flac',
    'Logic Pro Library.bundle/Impulse Responses/05 Warped/Drone Tone 35.aif',
    'Logic/Song.logicx/Media/Audio Files/Bass.wav',
    'GarageBand/Jam.band/Media/Audio Files/Guitar.aif',
    'Audio Music Apps/Sampler Instruments/Piano/C3.wav',
    'Music/Music Library.musiclibrary/Preview.m4a',
    'Ableton/User Library/Samples/kick.wav',
    'Ableton/Factory Packs/Core Library/snare.wav',
    '$RECYCLE.BIN/S-1-5-21/old.mp3',
  ],
};
for (const rel of [...files.kept, ...files.skipped]) {
  const full = join(music, ...rel.split('/'));
  await mkdir(dirname(full), { recursive: true });
  // Not real audio: the scanner keeps a row for a file it can't read, so
  // whether a row exists says whether the walk found the file.
  await writeFile(full, 'not audio');
}

const library = await LibraryStore.open(join(root, 'library.db'));
const scanner = new Scanner(library, () => undefined);
await scanner.start([music]);
const paths = (library.db.exec('SELECT path FROM tracks')[0]?.values ?? []).map(([p]) => p);
const rel = (p) => p.slice(music.length + 1).split(sep).join('/');
assert.deepEqual(paths.map(rel).sort(), [...files.kept].sort(), 'the scan finds exactly the kept files');

// 2b. Rows an earlier version indexed: loops scanned while they sat in a
// folder the rules did not cover, then the folder took a name they do.
const loops = join(music, 'Loops');
await mkdir(loops, { recursive: true });
await writeFile(join(loops, 'Drum Loop.aif'), 'not audio');
await scanner.start([music]);
const loopRow = () => library.db.exec(`SELECT id, path, missing_since FROM tracks WHERE path LIKE '%Drum Loop.aif'`)[0]?.values[0];
assert.ok(loopRow(), 'the loop was indexed while its folder was not skipped');
await rename(loops, join(music, 'Apple Loops'));
library.db.run(`UPDATE tracks SET path = ? WHERE id = ?`, [join(music, 'Apple Loops', 'Drum Loop.aif'), loopRow()[0]]);
await scanner.start([music]);
assert.ok(loopRow()[2] != null, 'a track under a skipped folder is marked missing though its file is there');
const keptMissing = library.db.exec('SELECT COUNT(*) FROM tracks WHERE missing_since IS NOT NULL')[0].values[0][0];
assert.equal(keptMissing, 1, 'only that track is marked');
const pruned = library.pruneMissingTracks(undefined, [music]);
assert.equal(pruned.removed, 1, 'Clean missing files removes it');
assert.equal(loopRow(), undefined);
assert.ok(existsSync(join(music, 'Apple Loops', 'Drum Loop.aif')), 'and leaves the file alone');
assert.equal(library.db.exec('SELECT COUNT(*) FROM tracks')[0].values[0][0], files.kept.length, 'every kept track stays');
// A root that itself sits in a skipped-looking folder is the user's choice.
const nested = join(root, '.hidden', 'Music');
await mkdir(nested, { recursive: true });
await writeFile(join(nested, 'song.mp3'), 'not audio');
await scanner.start([music, nested]);
assert.equal(library.db.exec(`SELECT COUNT(*) FROM tracks WHERE path LIKE '%song.mp3' AND missing_since IS NULL`)[0].values[0][0], 1, 'a root under a dot folder is scanned and kept');
library.close?.();

// 3. The watcher drops events from the same places.
assert.equal(resolveLibraryWatchTarget(music, 'Artist/Album/01 Intro.mp3'), join(music, 'Artist', 'Album', '01 Intro.mp3'));
for (const relPath of files.skipped) {
  assert.equal(resolveLibraryWatchTarget(music, relPath), null, `${relPath} is not a watch target`);
}
assert.equal(resolveLibraryWatchTarget(music, 'Logic Pro Library.bundle/Cover.jpg'), null, 'art inside a package is not a cover');

// 4. A read that times out leaves the file for the next scan. Run in its own
// process, so open() can fail before the scanner's modules load.
{
  const share = join(root, 'Share');
  await mkdir(share, { recursive: true });
  await writeFile(join(share, 'steady.mp3'), 'not audio');
  await writeFile(join(share, 'flaky.mp3'), 'not audio');
  const probe = join(root, 'timeout-probe.mjs');
  const dist = (name) => pathToFileURL(join(repoRoot, 'dist-electron', 'electron', name)).href;
  await writeFile(probe, `
    import { promises as fsp } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const realOpen = fsp.open;
    let flaky = process.argv[3] === 'flaky';
    fsp.open = async (path, ...rest) => {
      if (flaky && String(path).endsWith('flaky.mp3')) throw Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
      return realOpen(path, ...rest);
    };
    syncBuiltinESMExports();
    const { LibraryStore } = await import(${JSON.stringify(dist('library.js'))});
    const { Scanner } = await import(${JSON.stringify(dist('scanner.js'))});
    const store = await LibraryStore.open(process.argv[2] + '.db');
    await new Scanner(store, () => undefined).start([process.argv[2]]);
    const rows = store.db.exec('SELECT path, title FROM tracks')[0]?.values ?? [];
    store.close();
    console.log(JSON.stringify(rows.map(([path, title]) => [path.split(/[\\\\/]/).pop(), title]).sort()));
  `);
  const scan = (mode) => JSON.parse(execFileSync(process.execPath, [probe, share, mode], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(scan('flaky'), [['steady.mp3', 'steady']], 'a file that timed out gets no row; one that will not parse still gets its guessed row');
  assert.deepEqual(scan('steady'), [['flaky.mp3', 'flaky'], ['steady.mp3', 'steady']], 'the next scan reads it');
}

await rm(root, { recursive: true, force: true });
console.log('[library-skip-test] ok');
