// Adoption is the one-time step that keeps metadata edits made before edits
// were tracked. It has to keep real in-app edits and nothing else:
//  - the same file handed over twice (overlapping roots, a folder plus a file
//    inside it, one folder written two ways) must not abort the scan; it used
//    to re-insert the adopted override and hit the table's primary key, which
//    rolled back that batch on every scan;
//  - a file retagged outside NewAmp (Picard, Mp3tag) since its last scan wins:
//    only an unchanged file can show a stored difference was an in-app edit;
//  - a failed tag read is a filename guess. It must not replace what the
//    library has, move an override's file value, or be adopted as an "edit";
//  - adopted fields can be handed back to the files in bulk;
//  - an edit made before a queued track's file has been read doesn't know the
//    file's value, and "reset to file" waits until it does;
//  - a value that differs only in how it was read (case, spacing, Unicode
//    form, empty vs missing, genre separators) is not adopted.
// Tagged FLAC fixtures come from the bundled ffmpeg.
// Run: npm run build:electron && node scripts/library-adoption-test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import initSqlJs from 'sql.js';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner, readTrackFile } from '../dist-electron/electron/scanner.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-adoption-test');
const music = join(root, 'music');
const artistDir = join(music, 'Artist');
const dbPath = join(root, 'library.db');
await rm(root, { recursive: true, force: true });
await mkdir(artistDir, { recursive: true });
const SQL = await initSqlJs();

function tagFile(path, tags) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.4'];
  for (const [key, value] of Object.entries(tags)) args.push('-metadata', `${key}=${value}`);
  args.push('-c:a', 'flac', path);
  const result = spawnSync(ffmpeg, args, { stdio: 'pipe' });
  assert.equal(result.status, 0, `ffmpeg failed for ${path}: ${result.stderr}`);
}

// A library as the previous version left it: the rows exist, edits made in
// the app were written straight into the columns, nothing recorded them, and
// the adoption step hasn't run yet.
function rewindToBeforeOverrides(legacyEdits) {
  const db = new SQL.Database(readFileSync(dbPath));
  db.run('DELETE FROM track_metadata_overrides');
  db.run('DELETE FROM track_metadata_adoption');
  db.run(`DELETE FROM library_meta WHERE key = 'metadata_overrides_adoption_v1'`);
  for (const [path, columns] of legacyEdits) {
    for (const [column, value] of Object.entries(columns)) {
      db.run(`UPDATE tracks SET ${column} = ? WHERE path = ?`, [value, path]);
    }
  }
  writeFileSync(dbPath, db.export());
  db.close();
}

const kept = join(artistDir, '01 Kept.flac'); // unchanged file with an in-app edit
const retagged = join(artistDir, '02 Retagged.flac'); // edited in-app, then retagged outside
const broken = join(artistDir, '03 Broken.flac'); // tags become unreadable later
const guessed = join(artistDir, '04 Guessed.flac'); // an older version failed to read it
tagFile(kept, { title: 'Kept Tag Title', artist: 'Tag Artist', album: 'Tag Album', genre: 'Rock', date: '1999', track: '1' });
tagFile(retagged, { title: 'Before Retag', artist: 'Tag Artist', album: 'Tag Album', genre: 'Rock', date: '1999', track: '2' });
tagFile(broken, { title: 'Broken Tag Title', artist: 'Tag Artist', album: 'Tag Album', genre: 'Jazz', date: '1999', track: '3' });
tagFile(guessed, { title: 'Guessed Real Title', artist: 'Real Artist', album: 'Tag Album', genre: 'Rock', date: '1999', track: '4' });

{
  const library = await LibraryStore.open(dbPath);
  await new Scanner(library, () => {}).start([music]);
  assert.equal(library.getStats().tracks, 4);
  const [brokenTrack] = library.getTracksByPaths([broken]);
  library.recordPlay(brokenTrack.id);
  library.close();
}
rewindToBeforeOverrides([
  [kept, { title: 'My Kept Title', genre: null }],
  [retagged, { title: 'My Old Edit' }],
  // What the old scanner stored when it couldn't read the tags.
  [guessed, { title: '04 Guessed', artist: 'Unknown Artist', album: '', album_artist: 'Unknown Artist', genre: null, year: null, track_no: null }],
]);

const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, () => {});
const byPath = (path) => library.getTracksByPaths([path])[0];

// 1. Retagged outside NewAmp: its size/mtime changed, so an ordinary scan
//    re-reads it, and the new tags win over the old stored value.
{
  tagFile(retagged, { title: 'Picard Title Longer Than Before', artist: 'Tag Artist', album: 'Tag Album', genre: 'Rock', date: '1999', track: '2' });
  await scanner.start([music]);
  const track = byPath(retagged);
  assert.equal(track.title, 'Picard Title Longer Than Before', 'an external retag must win over an unconfirmed old value');
  assert.deepEqual(track.editedFields, []);
}

// 2. The same files handed over twice in one scan: nested roots and the same
//    root with the other slash. An unchanged file's old edit is adopted once.
{
  const sameRootOtherSlashes = process.platform === 'win32' ? music.replace(/\\/g, '/') : `${music}/`;
  await scanner.start([music, artistDir, sameRootOtherSlashes, kept], { force: true });
  assert.equal(library.getStats().tracks, 4, 'no duplicate rows');
  const track = byPath(kept);
  assert.equal(track.title, 'My Kept Title', 'an in-app edit on an unchanged file is adopted');
  assert.equal(track.genre, null, 'a cleared field is adopted as cleared');
  assert.deepEqual(track.editedFields, ['title', 'genre']);
}

// 3. A stored row that is itself a failed read's guess holds no edits: the
//    real tags come through instead of 'Unknown Artist' being pinned.
{
  const track = byPath(guessed);
  assert.equal(track.title, 'Guessed Real Title', 'a filename-guess title must not be adopted as an edit');
  assert.equal(track.artist, 'Real Artist', "'Unknown Artist' must not be adopted as an edit");
  assert.equal(track.genre, 'Rock');
  assert.deepEqual(track.editedFields, []);
}

// 4. Tags that stop parsing: the track keeps everything it had, its edit keeps
//    the right file value, and size/mtime stay so the next scan retries.
{
  const before = byPath(broken);
  library.applyManualMetadataPatch(before.id, { genre: 'My Genre' });
  const stamp = await stat(broken);
  await writeFile(broken, Buffer.alloc(4096, 0x5a)); // no longer a FLAC file
  await utimes(broken, stamp.atime, new Date(stamp.mtimeMs + 60_000));
  await scanner.start([music]);
  let track = byPath(broken);
  assert.equal(track.title, 'Broken Tag Title', 'a failed read must not rename the track after its file');
  assert.equal(track.artist, 'Tag Artist', "a failed read must not make it 'Unknown Artist'");
  assert.equal(track.genre, 'My Genre');
  assert.equal(track.playCount, 1);
  assert.equal(track.size, before.size, 'size/mtime stay, so the next scan tries the file again');
  assert.equal(track.mtime, before.mtime);
  track = library.applyManualMetadataPatch(track.id, { resetToFile: ['genre'] });
  assert.equal(track.genre, 'Jazz', "the edit's file value is still the real tag, not a guess");
  // Fixed file: read again, normally.
  tagFile(broken, { title: 'Broken Tag Title Fixed', artist: 'Tag Artist', album: 'Tag Album', genre: 'Jazz', date: '1999', track: '3' });
  await scanner.start([music]);
  assert.equal(byPath(broken).title, 'Broken Tag Title Fixed');
}

// 5. Adopted fields go back to the files in bulk; edits made since stay.
{
  assert.equal(library.getLibraryHealth().adoptedEdits, 2, 'title and genre of the kept track');
  library.applyManualMetadataPatch(byPath(retagged).id, { album: 'My Album Edit' });
  assert.equal(library.resetAdoptedMetadataOverrides(), 2);
  const track = byPath(kept);
  assert.equal(track.title, 'Kept Tag Title');
  assert.equal(track.genre, 'Rock');
  assert.deepEqual(track.editedFields, []);
  assert.equal(byPath(retagged).album, 'My Album Edit', 'a manual edit is not adopted and stays');
  assert.equal(library.getLibraryHealth().adoptedEdits, 0);
}
library.close();

// 6. An edit on a track still queued for adoption, before its file is read:
//    the column may hold an old edit, so the override's file value is unknown
//    and a reset waits. Reading the file (what main does before an edit)
//    settles it.
{
  rewindToBeforeOverrides([[kept, { title: 'Old Edit Again' }]]);
  const lib = await LibraryStore.open(dbPath);
  try {
    const id = lib.getTracksByPaths([kept])[0].id;
    assert.equal(lib.pathNeedingFileRead(id), kept);
    lib.applyManualMetadataPatch(id, { title: 'New Edit' });
    let track = lib.applyManualMetadataPatch(id, { resetToFile: ['title'] });
    assert.equal(track.title, 'New Edit', 'no known file value yet: the reset must not restore the old edit as if it were the tag');
    assert.deepEqual(track.editedFields, ['title']);
    const reading = await readTrackFile(kept);
    lib.upsertTracks([reading]);
    assert.equal(lib.pathNeedingFileRead(id), null);
    track = lib.applyManualMetadataPatch(id, { resetToFile: ['title'] });
    assert.equal(track.title, 'Kept Tag Title', 'once read, reset restores the real tag');
  } finally {
    lib.close();
  }
}

// 7. The library's own guard, without the scanner's de-duplication in front of
//    it: one upsert batch naming a queued track twice (a .cue dropped beside
//    its audio, a watcher batch with a folder and a file in it).
{
  rewindToBeforeOverrides([[kept, { title: 'Twice Edited' }]]);
  const lib = await LibraryStore.open(dbPath);
  try {
    const reading = await readTrackFile(kept);
    lib.upsertTracks([reading, { ...reading }]);
    const track = lib.getTracksByPaths([kept])[0];
    assert.equal(track.title, 'Twice Edited');
    assert.deepEqual(track.editedFields, ['title']);
    assert.equal(lib.getStats().tracks, 4);
  } finally {
    lib.close();
  }
}

// 8. A difference that is only in how a value was read is not an edit:
//    letter case, surrounding or repeated spaces, Unicode normalization form,
//    empty versus missing, and the separator between genres. Such a field
//    takes the file's value and keeps following it. A real difference on the
//    same track is still adopted.
{
  const driftDir = join(root, 'drift');
  const driftDb = join(driftDir, 'library.db');
  await mkdir(driftDir, { recursive: true });
  const acute = String.fromCodePoint(0x301);
  const eAcute = String.fromCodePoint(0xe9);
  const capitalEAcute = String.fromCodePoint(0xc9);
  const reading = (name, fields = {}) => ({
    path: join(driftDir, `${name}.flac`),
    title: 'Hello World',
    artist: 'Tag Artist',
    album: 'Tag Album',
    albumArtist: 'Tag Artist',
    trackNo: 1,
    discNo: 1,
    year: 1999,
    genre: 'Rock',
    duration: 100,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 5000,
    mtime: 1_700_000_000_000,
    art: null,
    dev: 1,
    ...fields,
  });
  // [name, the file's tags, what the library stored before edits were tracked]
  const cases = [
    ['case', {}, { title: 'HELLO WORLD' }, 'title', 'Hello World'],
    ['spaces', {}, { artist: '  Tag   Artist ' }, 'artist', 'Tag Artist'],
    ['nfd', { album: `Caf${eAcute} Society` }, { album: `Cafe${acute} Society` }, 'album', `Caf${eAcute} Society`],
    ['empty', { genre: null }, { genre: '' }, 'genre', null],
    ['separators', { genre: 'Rock / Pop' }, { genre: 'Rock;Pop' }, 'genre', 'Rock / Pop'],
    ['together', { albumArtist: `${capitalEAcute}sta Banda` }, { album_artist: ` E${acute}STA  banda` }, 'albumArtist', `${capitalEAcute}sta Banda`],
  ];
  const readings = [...cases.map(([name, tags]) => reading(name, tags)), reading('edited')];

  let lib = await LibraryStore.open(driftDb);
  lib.upsertTracks(readings);
  lib.close();
  const db = new SQL.Database(readFileSync(driftDb));
  db.run('DELETE FROM track_metadata_overrides');
  db.run('DELETE FROM track_metadata_adoption');
  db.run(`DELETE FROM library_meta WHERE key = 'metadata_overrides_adoption_v1'`);
  for (const [name, , columns] of cases) {
    for (const [column, value] of Object.entries(columns)) {
      db.run(`UPDATE tracks SET ${column} = ? WHERE path = ?`, [value, join(driftDir, `${name}.flac`)]);
    }
  }
  // A real edit, next to a case-only difference on the same track.
  db.run(`UPDATE tracks SET title = 'My Real Edit', genre = 'ROCK' WHERE path = ?`, [join(driftDir, 'edited.flac')]);
  writeFileSync(driftDb, db.export());
  db.close();

  lib = await LibraryStore.open(driftDb);
  try {
    lib.upsertTracks(readings); // the first read since the upgrade, files unchanged
    for (const [name, , , field, fileValue] of cases) {
      const track = lib.getTracksByPaths([join(driftDir, `${name}.flac`)])[0];
      assert.deepEqual(track.editedFields, [], `${name}: a reading variant must not be adopted as an edit`);
      assert.equal(track[field] || null, fileValue, `${name}: the field takes the file's value`);
    }
    const edited = lib.getTracksByPaths([join(driftDir, 'edited.flac')])[0];
    assert.equal(edited.title, 'My Real Edit', 'a real difference is still adopted');
    assert.deepEqual(edited.editedFields, ['title'], 'and only the real difference');
    assert.equal(edited.genre, 'Rock');
    assert.equal(lib.getLibraryHealth().adoptedEdits, 1);

    // Following the file means a later retag shows up.
    lib.upsertTracks([reading('case', { title: 'Retagged', size: 5001 })]);
    assert.equal(lib.getTracksByPaths([join(driftDir, 'case.flac')])[0].title, 'Retagged');
  } finally {
    lib.close();
  }
}

await rm(root, { recursive: true, force: true });
console.log('[library-adoption-test] ok: duplicates, retags, failed reads, unknown file values and reading variants are all safe');
