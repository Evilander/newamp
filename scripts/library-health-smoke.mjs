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
    size: 2048,
    mtime: 1000,
  },
  {
    name: '02-duplicate-b.flac',
    title: 'Same Song',
    artist: 'Twin',
    album: 'B',
    year: 2002,
    hasArt: false,
    duration: 201.2,
    size: 2048,
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
    size: 512,
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
    size: 1024,
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
  size: fixture.size,
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
assert.equal(health.duplicateGroups[0].exactMatchCount, 2, 'same artist/title plus matching duration/size should be an exact duplicate signal');
assert.deepEqual(health.recentlyAdded.map((track) => track.title).slice(0, 2), ['Fresh Import', 'Mystery File']);
const duplicatePlaylist = library.savePlaylist({
  name: 'Duplicate Review',
  trackIds: health.duplicateGroups.flatMap((group) => group.tracks.map((track) => track.id)),
});
assert.equal(duplicatePlaylist.trackCount, 2, 'duplicate review playlist should contain all duplicate candidates');
const missingReviewIds = uniqueTrackIds([
  ...library.getTracks({ search: 'missing:artist', limit: 100 }),
  ...library.getTracks({ search: 'missing:album', limit: 100 }),
  ...library.getTracks({ search: 'missing:year', limit: 100 }),
  ...library.getTracks({ search: 'missing:art', limit: 100 }),
  ...library.getTracks({ search: 'missing:duration', limit: 100 }),
]);
const missingReviewPlaylist = library.savePlaylist({
  name: 'Missing Metadata Review',
  trackIds: missingReviewIds,
});
assert.equal(missingReviewPlaylist.trackCount, 2, 'missing review playlist should dedupe missing metadata/art candidates');
const legacyReviewPlaylist = library.savePlaylist({
  name: 'Legacy Format Review',
  trackIds: uniqueTrackIds(library.getTracks({ search: 'format:wma', limit: 100 })),
});
assert.equal(legacyReviewPlaylist.trackCount, 1, 'legacy review playlist should contain legacy-format tracks');
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
assert.match(libraryViewSource, /exactMatchCount/, 'Library view should surface exact duplicate strength');
assert.match(libraryViewSource, /exact matches/, 'Library Health should distinguish exact-looking duplicate files');
assert.match(libraryViewSource, /Save duplicate review/, 'Library view should make duplicate clusters actionable');
assert.match(libraryViewSource, /Duplicate Review/, 'Library view should create a named duplicate-review playlist');
assert.match(libraryViewSource, /Save missing review/, 'Library view should make missing metadata/art actionable');
assert.match(libraryViewSource, /Missing Metadata Review/, 'Library view should create a named missing-metadata review playlist');
assert.match(libraryViewSource, /Save legacy review/, 'Library view should make legacy formats actionable');
assert.match(libraryViewSource, /Legacy Format Review/, 'Library view should create a named legacy-format review playlist');
assert.match(libraryViewSource, /collectTracksByQueries/, 'Library view should collect review playlists from power-search queries');

console.log(JSON.stringify({
  ok: true,
  missing: health.missing,
  duplicates: health.duplicateGroups.map((group) => `${group.artist} - ${group.title}`),
  duplicatePlaylist: duplicatePlaylist.trackCount,
  missingReviewPlaylist: missingReviewPlaylist.trackCount,
  legacyReviewPlaylist: legacyReviewPlaylist.trackCount,
  legacyFormats: health.legacyFormats,
}, null, 2));

function uniqueTrackIds(tracks) {
  return [...new Set(tracks.map((track) => track.id))];
}
