import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const smokeRoot = resolve('tmp', 'mixes-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { title: 'Seed Pulse', artist: 'Mix Seed', bpm: 120, key: 'C', loved: true, rating: 5, plays: 4 },
  { title: 'Relative Glide', artist: 'Mix Next', bpm: 122, key: 'A minor', loved: true, rating: 4, plays: 2 },
  { title: 'Adjacent Lift', artist: 'Mix Bridge', bpm: 126, key: 'G', loved: false, rating: 4, plays: 0 },
  { title: 'Forgotten Light', artist: 'Mix Deep', bpm: 118, key: 'C', loved: false, rating: 3, plays: 0 },
  { title: 'Late Drive', artist: 'Mix Night', bpm: 96, key: 'D minor', loved: false, rating: 5, plays: 1 },
  { title: 'Skipped Favorite', artist: 'Mix Skip', bpm: 124, key: 'C', loved: false, rating: 5, plays: 8, skips: 12, mtime: 1500 },
];

for (const fixture of fixtures) {
  await writeFile(join(musicRoot, `${fixture.title}.mp3`), '');
}

const library = await LibraryStore.open(dbPath);
try {
  library.upsertTracks(fixtures.map((fixture, index) => ({
    path: join(musicRoot, `${fixture.title}.mp3`),
    title: fixture.title,
    artist: fixture.artist,
    album: 'Mix Smoke',
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
    size: 1000 + index,
    mtime: fixture.mtime ?? 2000 + index,
    art: null,
  })));

  const tracks = library.getTracks({ sort: 'album', limit: 20 });
  const byTitle = new Map(tracks.map((track) => [track.title, track]));
  for (const fixture of fixtures) {
    const track = byTitle.get(fixture.title);
    assert.ok(track, `${fixture.title} should exist`);
    if (fixture.loved) library.toggleLove(track.id);
    if (fixture.rating) library.setTrackRating(track.id, fixture.rating);
    for (let i = 0; i < fixture.plays; i += 1) library.recordPlay(track.id, Date.now() - i);
    for (let i = 0; i < (fixture.skips ?? 0); i += 1) library.recordSkip(track.id, Date.now() - i, 10);
  }

  const seed = library.getTracks({ search: 'Seed Pulse', limit: 1, offset: 0 })[0];
  const harmonic = library.buildHarmonicMix({ seedTrackId: seed.id, count: 4 });
  assert.deepEqual(
    harmonic.slice(0, 3).map((track) => track.title),
    ['Seed Pulse', 'Forgotten Light', 'Relative Glide'],
    'mixes should preserve harmonic engine ordering across same-key and relative-key candidates',
  );

  const loved = library.getTracks({ sort: 'loved', limit: 30, offset: 0 });
  assert.equal(loved.length, 2, 'loved mix should use loved catalog rows');

  const freshImports = library.getTracks({ sort: 'added', limit: 30, offset: 0 });
  assert.equal(freshImports[0].title, 'Late Drive', 'fresh imports should sort by newest file mtime');

  const deepCuts = library.runSmartPlaylistRule({
    name: 'Mixes Deep Cuts',
    mood: 'deep-cuts',
    count: 30,
    unplayedOnly: true,
  });
  assert.ok(deepCuts.some((track) => track.title === 'Forgotten Light'), 'deep cuts mix should include unplayed candidates');

  const taste = library.buildTasteMix({ seedTrackId: seed.id, count: 6 });
  assert.equal(taste[0]?.title, 'Seed Pulse', 'taste mix should open from the current seed when provided');
  assert.ok(taste.some((track) => track.title === 'Late Drive'), 'taste mix should include strong rated listening signals');
  assert.ok(
    taste.findIndex((track) => track.title === 'Skipped Favorite') > taste.findIndex((track) => track.title === 'Relative Glide'),
    'taste mix should demote skip-heavy tracks behind cleaner positive signals',
  );

  const saved = library.savePlaylist({
    name: 'Night Drive Mix',
    trackIds: harmonic.map((track) => track.id),
  });
  assert.equal(saved.trackCount, harmonic.length, 'mixes should save through normal playlists');
} finally {
  library.close();
}

const [appSource, sidebarSource, storeSource, mixesViewSource, homeSource, sharedTypes, preloadSource, apiSource, mainSource, packageSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/MixesView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/HomeView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /'mixes'/, 'player store should expose the Mixes view mode');
assert.match(sidebarSource, /Mixes/, 'Sidebar should include Mixes navigation');
assert.match(appSource, /MixesView/, 'App should route to MixesView');
assert.match(mixesViewSource, /buildHarmonicMix/, 'Mixes view should use harmonic mix generation');
assert.match(mixesViewSource, /runSmartPlaylistRule/, 'Mixes view should use smart-rule discovery');
assert.match(mixesViewSource, /Fresh Imports/, 'Mixes view should expose scan-derived fresh imports');
assert.match(mixesViewSource, /Taste Match/, 'Mixes view should expose taste-profile mixes');
assert.match(mixesViewSource, /Recently Played/, 'Mixes view should expose recent listening');
assert.match(mixesViewSource, /Heavy Rotation/, 'Mixes view should expose most-played listening');
assert.match(mixesViewSource, /savePlaylist/, 'Mixes view should save generated mixes');
assert.match(homeSource, /Taste Match/, 'Home should expose taste-profile recommendations');
assert.match(sharedTypes, /TasteMixInput/, 'shared API should expose taste mix input');
assert.match(preloadSource, /buildTasteMix/, 'preload should expose taste mix IPC');
assert.match(apiSource, /buildTasteMix/, 'renderer API should expose taste mix generation');
assert.match(mainSource, /smart:taste-mix/, 'main process should register taste mix IPC');
assert.match(packageSource, /smoke:mixes/, 'package scripts should expose mixes smoke');

console.log(JSON.stringify({ ok: true }, null, 2));
