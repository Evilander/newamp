import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'library-health-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  {
    name: '01-duplicate-a.mp3',
    title: 'Same Song',
    artist: 'Twin',
    album: 'A',
    year: 2001,
    hasArt: true,
    duration: 201,
    mtime: 1000,
  },
  {
    name: '02-duplicate-b.flac',
    title: 'Same Song',
    artist: 'Twin',
    album: 'B',
    year: 2002,
    hasArt: false,
    duration: 202,
    mtime: 2000,
  },
  {
    name: '03-unknown.wma',
    title: 'Mystery File',
    artist: 'Unknown Artist',
    album: '',
    year: null,
    hasArt: false,
    duration: null,
    mtime: 3000,
  },
  {
    name: '04-fresh.m4a',
    title: 'Fresh Import',
    artist: 'Clean',
    album: 'Inbox',
    year: 2026,
    hasArt: true,
    duration: 180,
    mtime: 4000,
  },
];

for (const fixture of fixtures) await writeFile(join(musicRoot, fixture.name), '');

const art = {
  mime: 'image/jpeg',
  data: Buffer.from('fake-art'),
};

const library = await LibraryStore.open(dbPath);
library.upsertTracks(fixtures.map((fixture, index) => ({
  path: join(musicRoot, fixture.name),
  title: fixture.title,
  artist: fixture.artist,
  album: fixture.album,
  albumArtist: fixture.artist,
  trackNo: index + 1,
  discNo: null,
  year: fixture.year,
  genre: 'Smoke',
  duration: fixture.duration,
  bitrate: null,
  sampleRate: null,
  bpm: null,
  key: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: fixture.mtime,
  art: fixture.hasArt ? art : null,
})));

const health = library.getLibraryHealth();
assert.equal(health.totals.tracks, 4);
assert.equal(health.missing.artist, 1);
assert.equal(health.missing.album, 1);
assert.equal(health.missing.year, 1);
assert.equal(health.missing.art, 2);
assert.equal(health.missing.duration, 1);
assert.equal(health.legacyFormats.find((item) => item.ext === '.wma')?.count, 1);
assert.equal(health.duplicateGroups.length, 1);
assert.equal(health.duplicateGroups[0].artist, 'Twin');
assert.equal(health.duplicateGroups[0].title, 'Same Song');
assert.equal(health.duplicateGroups[0].tracks.length, 2);
assert.deepEqual(health.recentlyAdded.map((track) => track.title).slice(0, 2), ['Fresh Import', 'Mystery File']);
const duplicatePlaylist = library.savePlaylist({
  name: 'Duplicate Review',
  trackIds: health.duplicateGroups.flatMap((group) => group.tracks.map((track) => track.id)),
});
assert.equal(duplicatePlaylist.trackCount, 2, 'duplicate review playlist should contain all duplicate candidates');
library.close();

const [sharedTypes, mainSource, preloadSource, apiSource, libraryViewSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /LibraryHealth/, 'shared API should expose LibraryHealth');
assert.match(mainSource, /library:get-health/, 'main process should register health IPC');
assert.match(preloadSource, /getLibraryHealth/, 'preload should expose getLibraryHealth');
assert.match(apiSource, /getLibraryHealth/, 'renderer API should expose getLibraryHealth');
assert.match(libraryViewSource, /Library Health/, 'Library view should render a health panel');
assert.match(libraryViewSource, /duplicateGroups/, 'Library view should surface duplicate clusters');
assert.match(libraryViewSource, /Save duplicate review/, 'Library view should make duplicate clusters actionable');
assert.match(libraryViewSource, /Duplicate Review/, 'Library view should create a named duplicate-review playlist');

console.log(JSON.stringify({
  ok: true,
  missing: health.missing,
  duplicates: health.duplicateGroups.map((group) => `${group.artist} - ${group.title}`),
  duplicatePlaylist: duplicatePlaylist.trackCount,
  legacyFormats: health.legacyFormats,
}, null, 2));
