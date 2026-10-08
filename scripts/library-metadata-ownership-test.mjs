// NewAmp never writes tags into music files, so a metadata edit (typed in, or
// accepted from a MusicBrainz lookup) exists only in the library. A forced
// rescan or a watcher rescan used to overwrite it with the file's tags. Now
// every edited field is an override the scanner can't touch:
//  - edits survive forced rescans, through the real Scanner;
//  - browse, search, filters, sorts, album/artist grouping and smart rules all
//    see the edited value;
//  - fields nobody edited keep following the file when it is retagged;
//  - "reset to file" brings back what the file says (as of the last scan), and
//    setting a field back to the file's value, or retagging the file to match
//    the edit, hands the field back to the file;
//  - a deliberately cleared field stays cleared, until the file is empty too;
//  - MusicBrainz rescues (including a filled-in duration) survive rescans;
//  - metadata export says which fields are edits.
// Run: npm run build:electron && node scripts/library-metadata-ownership-test.mjs
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-metadata-ownership-test');
const music = join(root, 'music');
await rm(root, { recursive: true, force: true });
await mkdir(music, { recursive: true });

const library = await LibraryStore.open(join(root, 'library.db'));

// 1. Real scanner, forced rescans. The fixture isn't real audio, so the file's
//    "tags" are the scanner's fallback: title from the filename, Unknown Artist.
{
  const path = join(music, 'field-recording.mp3');
  await writeFile(path, 'not audio; the scanner falls back to the filename');
  const scanner = new Scanner(library, () => {});
  await scanner.start([music]);
  const [scanned] = library.getTracksByPaths([path]);
  assert.equal(scanned.title, 'field-recording');
  assert.deepEqual(scanned.editedFields, []);

  const edited = library.applyManualMetadataPatch(scanned.id, {
    title: 'User-owned title',
    genre: 'Practice notes genre',
  });
  assert.deepEqual(edited.editedFields, ['title', 'genre']);
  library.setTrackRating(scanned.id, 5);
  library.recordPlay(scanned.id);
  const list = library.savePlaylist({ name: 'Keep this', trackIds: [scanned.id] });

  await scanner.start([music], { force: true });
  await scanner.start([path], { force: true }); // the watcher's rescan of one file
  const after = library.getTrack(scanned.id);
  assert.equal(after.title, 'User-owned title', 'a forced rescan must not revert a title edit');
  assert.equal(after.genre, 'Practice notes genre', 'a forced rescan must not revert a genre edit');
  assert.equal(after.artist, 'Unknown Artist', 'unedited fields still come from the file');
  assert.equal(after.rating, 5);
  assert.equal(after.playCount, 1);
  assert.deepEqual(library.getPlaylistTracks(list.id).map((t) => t.id), [scanned.id]);

  // Reset one field: back to the file, the other edit untouched.
  const reset = library.applyManualMetadataPatch(scanned.id, { resetToFile: ['title'] });
  assert.equal(reset.title, 'field-recording', 'reset to file restores the tag value');
  assert.equal(reset.genre, 'Practice notes genre');
  assert.deepEqual(reset.editedFields, ['genre']);
  await scanner.start([music], { force: true });
  assert.equal(library.getTrack(scanned.id).title, 'field-recording', 'and stays with the file after a rescan');
  library.applyManualMetadataPatch(scanned.id, { resetToFile: ['genre'] });
  assert.equal(library.getTrack(scanned.id).genre, null);
  assert.deepEqual(library.getTrack(scanned.id).editedFields, []);
}

// Direct upserts stand in for the scanner reading a file whose tags change.
const retagPath = join(music, 'retag.flac');
function reading(overrides = {}) {
  return {
    path: retagPath,
    title: 'Tag Title',
    artist: 'Tag Artist',
    album: 'Tag Album',
    albumArtist: 'Tag Artist',
    trackNo: 1,
    discNo: 1,
    year: 1999,
    genre: 'Rock',
    duration: 240,
    bitrate: 900_000,
    sampleRate: 44_100,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000,
    mtime: 1_700_000_000_000,
    art: null,
    ...overrides,
  };
}

// 2. Search, filters, sorts and grouping see the edited value.
{
  library.upsertTracks([reading()]);
  const [track] = library.getTracksByPaths([retagPath]);
  library.applyManualMetadataPatch(track.id, {
    title: 'Aardvark Overture',
    artist: 'Edited Artist',
    album: 'Edited Album',
    albumArtist: 'Edited Artist',
    genre: 'Edited Genre',
    year: 2011,
    trackNo: 7,
  });
  library.upsertTracks([reading({ size: 1001 })]); // a rescan with the same tags

  const ids = (tracks) => tracks.map((t) => t.id);
  assert.ok(ids(library.getTracks({ search: 'Aardvark', limit: 50 })).includes(track.id), 'free-text search');
  assert.ok(!ids(library.getTracks({ search: 'Tag Title', limit: 50 })).includes(track.id), 'the replaced tag no longer matches');
  assert.ok(ids(library.getTracks({ search: 'artist:"Edited Artist"', limit: 50 })).includes(track.id), 'field filter');
  assert.ok(ids(library.getTracks({ search: 'genre:edited', limit: 50 })).includes(track.id));
  assert.ok(ids(library.getTracks({ search: 'year:2011', limit: 50 })).includes(track.id));
  assert.equal(library.getTrackCount({ search: 'Aardvark' }), 1);
  assert.equal(library.getTracks({ sort: 'title', limit: 1 })[0].id, track.id, 'title sort uses the edit');
  assert.ok(library.getAlbums({}).some((album) => album.album === 'Edited Album' && album.albumArtist === 'Edited Artist'));
  assert.ok(!library.getAlbums({}).some((album) => album.album === 'Tag Album'));
  assert.ok(library.getArtists({}).some((artist) => artist.artist === 'Edited Artist'));
  assert.deepEqual(ids(library.getAlbumTracks('Edited Artist', 'Edited Album')), [track.id]);
  assert.ok(
    ids(library.runSmartPlaylistRule({ name: 'Edited', mood: 'focus', count: 50, genreQuery: 'edited' })).includes(track.id),
    'smart rules match the edited genre',
  );

  // 3. The file is retagged. Edited fields keep the user's value; unedited
  //    ones follow the file; reset brings back the file's newest value.
  library.upsertTracks([reading({ title: 'Retagged Title', artist: 'Retagged Artist', discNo: 2, size: 1002 })]);
  const retagged = library.getTrack(track.id);
  assert.equal(retagged.title, 'Aardvark Overture');
  assert.equal(retagged.artist, 'Edited Artist');
  assert.equal(retagged.discNo, 2, 'a field nobody edited follows the retag');
  const restored = library.applyManualMetadataPatch(track.id, { resetToFile: ['title', 'artist'] });
  assert.equal(restored.title, 'Retagged Title', 'reset restores what the file says now, not what it said at edit time');
  assert.equal(restored.artist, 'Retagged Artist');

  // 4. Typing the file's own value hands the field back to the file.
  library.applyManualMetadataPatch(track.id, { album: 'Tag Album' });
  assert.ok(!library.getTrack(track.id).editedFields.includes('album'));
  library.upsertTracks([reading({ title: 'Retagged Title', artist: 'Retagged Artist', album: 'Newer Album', discNo: 2, size: 1003 })]);
  assert.equal(library.getTrack(track.id).album, 'Newer Album');

  // 5. A deliberately cleared field stays cleared.
  library.applyManualMetadataPatch(track.id, { genre: '', year: null, trackNo: null });
  library.upsertTracks([reading({ title: 'Retagged Title', artist: 'Retagged Artist', album: 'Newer Album', size: 1004 })]);
  const cleared = library.getTrack(track.id);
  assert.equal(cleared.genre, null, 'a cleared genre must not come back from the tags');
  assert.equal(cleared.year, null);
  assert.equal(cleared.trackNo, null);
  assert.deepEqual(cleared.editedFields, ['albumArtist', 'genre', 'year', 'trackNo']);

  // Export carries which fields are edits.
  const rows = library.exportTrackMetadata();
  const exported = rows.find((row) => row.path === retagPath);
  assert.deepEqual(exported.editedFields.split(';').sort(), ['albumArtist', 'genre', 'trackNo', 'year']);
  assert.equal(rows.find((row) => row.path.endsWith('field-recording.mp3')).editedFields, null);

  // Once the file is retagged to say what the user said, the field follows the
  // file again: a later retag shows up.
  library.upsertTracks([reading({ title: 'Retagged Title', artist: 'Retagged Artist', album: 'Newer Album', albumArtist: 'Edited Artist', size: 1005 })]);
  assert.ok(!library.getTrack(track.id).editedFields.includes('albumArtist'));
  library.upsertTracks([reading({ title: 'Retagged Title', artist: 'Retagged Artist', album: 'Newer Album', albumArtist: 'Another Artist', size: 1006 })]);
  assert.equal(library.getTrack(track.id).albumArtist, 'Another Artist');
  assert.equal(library.getTrack(track.id).genre, null, 'the other overrides are untouched');
}

// 6. MusicBrainz rescue is owned too, and a filled-in duration survives a file
//    that still yields none.
{
  const barePath = join(music, 'bare.mp3');
  library.upsertTracks([reading({ path: barePath, title: 'bare', artist: 'Unknown Artist', album: '', albumArtist: 'Unknown Artist', trackNo: null, discNo: null, year: null, genre: null, duration: null })]);
  const [bare] = library.getTracksByPaths([barePath]);
  const rescued = library.applyMetadataPatch(bare.id, {
    source: 'musicbrainz',
    recordingId: 'rec',
    releaseId: 'rel',
    title: 'Weird Fishes/Arpeggi',
    artist: 'Radiohead',
    album: 'In Rainbows',
    albumArtist: 'Radiohead',
    year: 2007,
    trackNo: 4,
    discNo: 1,
    duration: 318,
    score: 98,
    confidence: 'high',
  });
  assert.deepEqual(rescued.editedFields, ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNo', 'discNo']);
  library.upsertTracks([reading({ path: barePath, title: 'bare', artist: 'Unknown Artist', album: '', albumArtist: 'Unknown Artist', trackNo: null, discNo: null, year: null, genre: null, duration: null, size: 2 })]);
  const after = library.getTrack(bare.id);
  assert.equal(after.title, 'Weird Fishes/Arpeggi');
  assert.equal(after.artist, 'Radiohead');
  assert.equal(after.album, 'In Rainbows');
  assert.equal(after.year, 2007);
  assert.equal(after.duration, 318, 'the rescued duration is kept while the file yields none');
  library.upsertTracks([reading({ path: barePath, title: 'bare', artist: 'Unknown Artist', album: '', albumArtist: 'Unknown Artist', trackNo: null, discNo: null, year: null, genre: null, duration: 317.6, size: 3 })]);
  assert.equal(library.getTrack(bare.id).duration, 317.6, 'a real measured duration replaces it');
}

// 7. Empty and missing are the same "nothing". A genre the user cleared is
//    stored as null; when the file's genre is retagged to an empty value
//    (some taggers write '' rather than dropping the tag), the column and the
//    file agree and the field stops showing as edited, so a later retag that
//    adds a genre shows up again.
{
  const clearedPath = join(music, 'cleared.flac');
  library.upsertTracks([reading({ path: clearedPath, genre: 'Rock' })]);
  const [track] = library.getTracksByPaths([clearedPath]);
  assert.deepEqual(library.applyManualMetadataPatch(track.id, { genre: '' }).editedFields, ['genre']);
  library.upsertTracks([reading({ path: clearedPath, genre: '', size: 1100 })]);
  const agreed = library.getTrack(track.id);
  assert.deepEqual(agreed.editedFields, [], 'once the file is empty too, the field is no longer an edit');
  assert.ok(!agreed.genre, 'and the genre stays empty');
  library.upsertTracks([reading({ path: clearedPath, genre: 'Jazz', size: 1101 })]);
  assert.equal(library.getTrack(track.id).genre, 'Jazz', 'it follows the file again');
}

// Unknown reset fields from the renderer are ignored, not trusted.
{
  const [track] = library.getTracksByPaths([retagPath]);
  const before = library.getTrack(track.id);
  const after = library.applyManualMetadataPatch(track.id, { resetToFile: ['path', 'rating', '__proto__'] });
  assert.deepEqual({ ...after, editedFields: undefined }, { ...before, editedFields: undefined });
}

library.close();
await rm(root, { recursive: true, force: true });
console.log('[library-metadata-ownership-test] ok: edits are owned, rescans can not revert them, reset returns to the file');
