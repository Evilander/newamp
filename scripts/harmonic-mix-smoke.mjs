import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { buildHarmonicMix, harmonicTransitionScore } from '../dist-electron/shared/harmonic-mix.js';

const smokeRoot = resolve('tmp', 'harmonic-mix-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { name: '01-c-pulse.mp3', title: 'C Pulse', artist: 'Seed Artist', bpm: 120, key: 'C', loved: true },
  { name: '02-am-glide.mp3', title: 'A Minor Glide', artist: 'Next Artist', bpm: 122, key: 'A minor', loved: false },
  { name: '03-g-lift.mp3', title: 'G Lift', artist: 'Bridge Artist', bpm: 126, key: 'G', loved: false },
  { name: '04-fsharp-sprint.mp3', title: 'F Sharp Sprint', artist: 'Far Artist', bpm: 170, key: 'F#', loved: false },
  { name: '05-nokey-close.mp3', title: 'No Key Close', artist: 'Metadata Gap', bpm: 121, key: null, loved: false },
];

for (const fixture of fixtures) await writeFile(join(musicRoot, fixture.name), '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks(fixtures.map((fixture, index) => ({
  path: join(musicRoot, fixture.name),
  title: fixture.title,
  artist: fixture.artist,
  album: 'Harmonic Fixtures',
  albumArtist: 'Newamp QA',
  trackNo: index + 1,
  discNo: null,
  year: 2026,
  genre: 'Electronic',
  duration: 180 + index,
  bitrate: 320000,
  sampleRate: 44100,
  bpm: fixture.bpm,
  key: fixture.key,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: Date.now(),
  art: null,
})));

const tracks = library.getTracks({ sort: 'album', limit: 20 });
const byTitle = new Map(tracks.map((track) => [track.title, track]));
const seed = byTitle.get('C Pulse');
assert.ok(seed, 'seed fixture should exist');
library.toggleLove(seed.id);

const pureMix = buildHarmonicMix(tracks, { seedTrackId: seed.id, count: 4 });
assert.deepEqual(
  pureMix.slice(0, 3).map((track) => track.title),
  ['C Pulse', 'A Minor Glide', 'G Lift'],
  'pure harmonic mix should prefer relative/adjacent keys at nearby tempos',
);

const relativeScore = harmonicTransitionScore(byTitle.get('C Pulse'), byTitle.get('A Minor Glide')).score;
const farScore = harmonicTransitionScore(byTitle.get('C Pulse'), byTitle.get('F Sharp Sprint')).score;
assert.ok(relativeScore > farScore, 'relative key transition should outrank distant fast jump');

const libraryMix = library.buildHarmonicMix({ seedTrackId: seed.id, count: 4 });
assert.deepEqual(
  libraryMix.slice(0, 3).map((track) => track.title),
  ['C Pulse', 'A Minor Glide', 'G Lift'],
  'library harmonic mix should use the same transition-aware ordering',
);
library.close();

const [sharedTypes, preloadSource, playlistViewSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/PlaylistView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /HarmonicMixInput/, 'shared API should expose harmonic mix input');
assert.match(preloadSource, /buildHarmonicMix/, 'preload should expose harmonic mix IPC');
assert.match(playlistViewSource, /HARMONIC MIX/, 'Now Queue should expose harmonic mix generation');
assert.match(packageSource, /"smoke:harmonic"/, 'package.json should expose harmonic mix smoke');

console.log(
  JSON.stringify(
    {
      ok: true,
      mix: libraryMix.map((track) => `${track.title} (${track.key ?? 'no key'} / ${track.bpm})`),
      relativeScore,
      farScore,
    },
    null,
    2,
  ),
);
