import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { buildArchiveCompass } from '../dist-electron/shared/archive-compass.js';

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
    bitrate: 128000,
    sampleRate: 44100,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
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
    bitrate: 920000,
    sampleRate: 96000,
    replayGainTrackDb: -7,
    replayGainAlbumDb: -6.2,
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
    bitrate: 96000,
    sampleRate: 44100,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
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
    bitrate: 256000,
    sampleRate: 44100,
    replayGainTrackDb: null,
    replayGainAlbumDb: -5.5,
    size: 1024,
    mtime: 4000,
  },
  {
    name: '05-dsd-master.dsf',
    title: 'DSD Master',
    artist: 'Archive',
    album: 'Needle Drop',
    year: 2025,
    hasArt: true,
    duration: 240,
    bitrate: 5644800,
    sampleRate: 2822400,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 4096,
    mtime: 1500,
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
  bitrate: fixture.bitrate,
  sampleRate: fixture.sampleRate,
  bpm: null,
  key: null,
  replayGainTrackDb: fixture.replayGainTrackDb,
  replayGainAlbumDb: fixture.replayGainAlbumDb,
  size: fixture.size,
  mtime: fixture.mtime,
  art: fixture.hasArt ? art : null,
})));

const health = library.getLibraryHealth();
assert.equal(health.totals.tracks, 5);
assert.equal(health.missing.artist, 1);
assert.equal(health.missing.album, 1);
assert.equal(health.missing.year, 1);
assert.equal(health.missing.art, 2);
assert.equal(health.missing.duration, 1);
assert.equal(health.legacyFormats.find((item) => item.ext === '.wma')?.count, 1);
assert.equal(health.quality.lossless, 2);
assert.equal(health.quality.lossy, 3);
assert.equal(health.quality.hiRes, 2);
assert.equal(health.quality.dsd, 1);
assert.equal(health.quality.ffmpegFallback, 2);
assert.equal(health.quality.lowBitrate, 2);
assert.equal(health.quality.replayGainReady, 2);
assert.equal(health.quality.replayGainMissing, 3);
assert.equal(health.quality.unknown, 0);
const compass = buildArchiveCompass(health);
assert.equal(typeof compass.score, 'number');
assert.ok(['S', 'A', 'B', 'C', 'D', 'F'].includes(compass.grade), 'archive compass should grade the library');
assert.ok(compass.moves.some((move) => /ReplayGain|fossils|DSD/.test(`${move.label} ${move.detail}`)), 'archive compass should turn quality signals into next moves');
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
const missingReviewIds = uniqueIds([
  ...library.getTrackIds({ search: 'missing:artist', limit: 100 }),
  ...library.getTrackIds({ search: 'missing:album', limit: 100 }),
  ...library.getTrackIds({ search: 'missing:year', limit: 100 }),
  ...library.getTrackIds({ search: 'missing:art', limit: 100 }),
  ...library.getTrackIds({ search: 'missing:duration', limit: 100 }),
]);
const missingReviewPlaylist = library.savePlaylist({
  name: 'Missing Metadata Review',
  trackIds: missingReviewIds,
});
assert.equal(missingReviewPlaylist.trackCount, 2, 'missing review playlist should dedupe missing metadata/art candidates');
const legacyReviewPlaylist = library.savePlaylist({
  name: 'Legacy Format Review',
  trackIds: uniqueIds(library.getTrackIds({ search: 'format:wma', limit: 100 })),
});
assert.equal(legacyReviewPlaylist.trackCount, 1, 'legacy review playlist should contain legacy-format tracks');
assert.equal(library.getTrackIds({ search: 'quality:dsd', limit: 100 }).length, 1, 'quality search should find DSD tracks');
assert.equal(library.getTrackIds({ search: 'quality:hires', limit: 100 }).length, 2, 'quality search should find hi-res tracks');
assert.equal(library.getTrackIds({ search: 'quality:low-bitrate', limit: 100 }).length, 2, 'quality search should find low-bitrate tracks');
assert.equal(library.getTrackIds({ search: 'rg:missing', limit: 100 }).length, 3, 'ReplayGain search should find missing gain tracks');
library.close();

const [sharedTypes, archiveCompassSource, mainSource, preloadSource, apiSource, libraryViewSource, homeViewSource, librarySource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/archive-compass.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/HomeView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /LibraryHealth/, 'shared API should expose LibraryHealth');
assert.match(sharedTypes, /LibraryQualityHealth/, 'shared API should expose LibraryQualityHealth');
assert.match(archiveCompassSource, /buildArchiveCompass/, 'shared archive compass should interpret health into a collector view');
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
assert.match(libraryViewSource, /Archive Radar/, 'Library view should surface collector-grade quality health');
assert.match(libraryViewSource, /Compass Moves/, 'Library view should turn health into explicit archive moves');
assert.match(libraryViewSource, /buildArchiveCompass/, 'Library view should render the archive compass');
assert.match(libraryViewSource, /Save archive radar/, 'Library view should make archive-quality issues actionable');
assert.match(libraryViewSource, /Archive Radar Review/, 'Library view should create a named archive-radar review playlist');
assert.match(homeViewSource, /Archive Compass/, 'Home should elevate archive health beyond raw counters');
assert.match(homeViewSource, /buildArchiveCompass/, 'Home should render the archive compass profile');
assert.match(libraryViewSource, /collectTrackIdsByQueries/, 'Library view should collect review playlists from power-search queries');
assert.match(libraryViewSource, /api\.getTrackIds/, 'Library health review playlists should avoid serializing full track rows');
assert.match(librarySource, /LibraryHealthRow/, 'Library health should use a lightweight row shape for full-library scans');
assert.match(librarySource, /SELECT id, path, title, artist, album, year, duration, bitrate, sample_rate, size, mtime, has_art, replaygain_track_db, replaygain_album_db FROM tracks/, 'Library health should avoid hydrating every track for aggregate counts');
assert.match(librarySource, /classifyAudioQuality/, 'Library health should use the shared audio-quality classifier');
assert.match(librarySource, /quality:low-bitrate|low-bitrate/, 'Power search should expose archive quality filters');
assert.match(librarySource, /getTracksByIdsInOrder/, 'Library health should hydrate only the duplicate samples it returns');
assert.match(librarySource, /getTrackIds\(opts: TrackQueryOptions/, 'Library store should expose id-only track queries');

console.log(JSON.stringify({
  ok: true,
  missing: health.missing,
  duplicates: health.duplicateGroups.map((group) => `${group.artist} - ${group.title}`),
  duplicatePlaylist: duplicatePlaylist.trackCount,
  missingReviewPlaylist: missingReviewPlaylist.trackCount,
  legacyReviewPlaylist: legacyReviewPlaylist.trackCount,
  legacyFormats: health.legacyFormats,
  quality: health.quality,
}, null, 2));

function uniqueIds(ids) {
  return [...new Set(ids)];
}
