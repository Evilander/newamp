import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'avoid-autoplay-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const paths = [
  join(musicRoot, '01-keeper.mp3'),
  join(musicRoot, '02-avoid-me.mp3'),
  join(musicRoot, '03-deep-cut.mp3'),
  join(musicRoot, '04-harmonic-safe.mp3'),
];

for (const path of paths) await writeFile(path, '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks(paths.map((path, index) => ({
  path,
  title: ['Keeper Signal', 'Avoid Me Signal', 'Deep Cut Signal', 'Harmonic Safe Signal'][index],
  artist: index === 1 ? 'Excluded Artist' : 'Allowed Artist',
  album: 'Avoid Auto DJ Fixtures',
  albumArtist: 'Newamp Fixture',
  trackNo: index + 1,
  discNo: null,
  year: 2026,
  genre: index === 2 ? 'Ambient' : 'Rock',
  duration: 180 + index,
  bitrate: 320000,
  sampleRate: 44100,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: Date.now() + index,
  bpm: index === 2 ? 82 : 124,
  key: index === 3 ? 'G' : 'C',
  art: null,
})));

const all = library.getTracks({ sort: 'title', limit: 10 });
const keeper = all.find((track) => track.title === 'Keeper Signal');
const avoided = all.find((track) => track.title === 'Avoid Me Signal');
const deepCut = all.find((track) => track.title === 'Deep Cut Signal');
assert.ok(keeper && avoided && deepCut, 'fixture tracks should be loaded');
assert.equal(avoided.avoidAutoPlay, 0, 'tracks should default to Auto DJ eligible');

library.toggleLove(keeper.id);
library.toggleLove(avoided.id);
library.setTrackRating(keeper.id, 5);
library.setTrackRating(avoided.id, 5);
library.setTrackRating(deepCut.id, 4);

const avoidedOn = library.toggleAvoidAutoPlay(avoided.id);
assert.equal(avoidedOn?.avoidAutoPlay, 1, 'toggle should mark track as avoided');
assert.equal(library.getTrack(avoided.id)?.avoidAutoPlay, 1, 'avoid flag should be persisted on the track row');

assert.deepEqual(
  library.getTracks({ search: 'avoid:true', sort: 'title', limit: 10 }).map((track) => track.title),
  ['Avoid Me Signal'],
  'power search should find avoided tracks',
);
assert.ok(
  !library.getTracks({ search: 'avoid:false', sort: 'title', limit: 10 }).some((track) => track.id === avoided.id),
  'power search should exclude avoided tracks with avoid:false',
);

const smart = library.runSmartPlaylistRule({
  name: 'Avoid Proof',
  mood: 'drive',
  count: 10,
  lovedOnly: true,
});
assert.deepEqual(
  smart.map((track) => track.title),
  ['Keeper Signal'],
  'smart rules should not return tracks explicitly excluded from Auto DJ',
);

const taste = library.buildTasteMix({ count: 10 });
assert.ok(
  !taste.some((track) => track.id === avoided.id),
  'taste mixes should not include avoided tracks even when they have strong love/rating signals',
);

const harmonic = library.buildHarmonicMix({ seedTrackId: avoided.id, count: 10 });
assert.ok(
  !harmonic.some((track) => track.id === avoided.id),
  'harmonic mixes should not force an avoided seed track into generated playback',
);

const avoidedOff = library.toggleAvoidAutoPlay(avoided.id);
assert.equal(avoidedOff?.avoidAutoPlay, 0, 'toggle should restore Auto DJ eligibility');

library.close();

const [
  sharedTypes,
  librarySource,
  autoDjSource,
  mainSource,
  preloadSource,
  apiSource,
  storeSource,
  libraryViewSource,
  nowPlayingSource,
  packageSource,
  releaseGateSource,
] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/auto-dj.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /avoidAutoPlay/, 'Track type should expose Auto DJ avoidance');
assert.match(sharedTypes, /toggleAvoidAutoPlay/, 'shared API should expose the avoidance toggle');
assert.match(librarySource, /avoid_auto_play/, 'library schema should persist Auto DJ avoidance');
assert.match(librarySource, /avoid_auto_play = 0/, 'generated mixes should filter avoided tracks at query time');
assert.match(autoDjSource, /candidate\.avoidAutoPlay/, 'Auto DJ refill should reject avoided candidates defensively');
assert.match(mainSource, /library:toggle-avoid-autoplay/, 'main process should register avoidance IPC');
assert.match(preloadSource, /toggleAvoidAutoPlay/, 'preload should expose avoidance toggle');
assert.match(apiSource, /toggleAvoidAutoPlay/, 'browser-safe API should include avoidance toggle');
assert.match(storeSource, /toggleAvoidAutoPlay/, 'player store should update current and queued tracks after avoidance changes');
assert.match(libraryViewSource, /data-avoid-autoplay/, 'Library rows should expose Auto DJ avoidance control');
assert.match(nowPlayingSource, /data-now-playing-avoid-autoplay/, 'Now Playing should expose Auto DJ avoidance control');
assert.match(packageSource, /smoke:avoid-autoplay/, 'package scripts should include avoidance smoke');
assert.match(releaseGateSource, /smoke:avoid-autoplay/, 'release gate should include avoidance smoke');

console.log(JSON.stringify({
  ok: true,
  avoided: avoidedOn,
  smartTitles: smart.map((track) => track.title),
  tasteTitles: taste.map((track) => track.title),
  harmonicTitles: harmonic.map((track) => track.title),
}, null, 2));
