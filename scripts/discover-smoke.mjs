import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const smokeRoot = resolve('tmp', 'discover-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const now = Date.UTC(2026, 4, 17, 12, 0, 0);

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { title: 'Today Download', artist: 'Fresh Band', album: 'Fresh Tape', year: 2026, genre: 'Indie Rock', mtime: now - 1000, plays: 0, rating: 0 },
  { title: 'Fresh Deep One', artist: 'Fresh Band', album: 'Fresh Tape', year: 2026, genre: 'Indie Rock', mtime: now - 900, plays: 0, rating: 0 },
  { title: 'Loved Yesterday', artist: 'Old Friend', album: 'Comfort Noise', year: 2010, genre: 'Dream Pop', mtime: now - 9000000, plays: 4, rating: 5, loved: true, lastPlayedOffset: 90 },
  { title: 'Forgotten Flame', artist: 'Old Friend', album: 'Comfort Noise', year: 2010, genre: 'Dream Pop', mtime: now - 8000000, plays: 2, rating: 5, loved: true, lastPlayedOffset: 120 },
  { title: 'Album A', artist: 'Album Crew', album: 'Whole Mood', year: 2004, genre: 'Electronic', mtime: now - 7000000, plays: 0, rating: 4, bpm: 112, key: 'C' },
  { title: 'Album B', artist: 'Album Crew', album: 'Whole Mood', year: 2004, genre: 'Electronic', mtime: now - 6990000, plays: 0, rating: 4, bpm: 116, key: 'A minor' },
  { title: 'Album C', artist: 'Album Crew', album: 'Whole Mood', year: 2004, genre: 'Electronic', mtime: now - 6980000, plays: 0, rating: 3, bpm: 118, key: 'G' },
  { title: 'Odd Shelf', artist: 'Private Recording', album: 'Basement Reel', year: 1997, genre: 'Home Recording', mtime: now - 6000000, plays: 0, rating: 0 },
  { title: 'Skip Trap', artist: 'Skip Heavy', album: 'Danger Zone', year: 2020, genre: 'Noise', mtime: now - 5000000, plays: 10, rating: 5, skips: 16 },
  { title: 'Avoid Me', artist: 'Avoid Artist', album: 'Do Not Auto', year: 2021, genre: 'Rock', mtime: now - 4000000, plays: 0, rating: 5, avoid: true },
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
    album: fixture.album,
    albumArtist: fixture.artist,
    trackNo: index + 1,
    discNo: null,
    year: fixture.year,
    genre: fixture.genre,
    duration: 180 + index,
    bitrate: 320000,
    sampleRate: 44100,
    bpm: fixture.bpm ?? null,
    key: fixture.key ?? null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000 + index,
    mtime: fixture.mtime,
    art: null,
  })));

  const tracks = library.getTracks({ sort: 'album', limit: 50 });
  const byTitle = new Map(tracks.map((track) => [track.title, track]));
  for (const fixture of fixtures) {
    const track = byTitle.get(fixture.title);
    assert.ok(track, `${fixture.title} should exist`);
    if (fixture.loved) library.toggleLove(track.id);
    if (fixture.rating) library.setTrackRating(track.id, fixture.rating);
    if (fixture.avoid) library.toggleAvoidAutoPlay(track.id);
    for (let i = 0; i < fixture.plays; i += 1) {
      const playedAt = now - ((fixture.lastPlayedOffset ?? i + 1) * 24 * 60 * 60 * 1000);
      library.recordPlay(track.id, playedAt);
    }
    for (let i = 0; i < (fixture.skips ?? 0); i += 1) {
      library.recordSkip(track.id, now - i * 1000, 12);
    }
  }

  const surface = library.getDiscoverSurface({ seed: 'smoke-seed', limit: 8, lowEndMode: true, now });
  const repeat = library.getDiscoverSurface({ seed: 'smoke-seed', limit: 8, lowEndMode: true, now });
  assert.deepEqual(
    surface.missions.map((mission) => mission.id),
    repeat.missions.map((mission) => mission.id),
    'Discover missions should be deterministic for the same seed',
  );

  assert.equal(surface.modeName, 'Living Library', 'Discover surface should expose the Living Library mode');
  assert.ok(surface.summary.trackCount >= fixtures.length, 'summary should include library scale');
  assert.ok(surface.cards.some((card) => card.id === 'new-download-radar'), 'surface should include new download radar');
  assert.ok(surface.cards.some((card) => card.id === 'forgotten-favorites'), 'surface should include forgotten favorites');
  assert.ok(surface.cards.some((card) => card.id === 'deep-album-run'), 'surface should include deep album run');
  assert.ok(surface.cards.some((card) => card.id === 'weird-shelf'), 'surface should include weird shelf');
  assert.ok(surface.missions.length >= 2, 'surface should build multiple playable missions');

  const allMissionTracks = surface.missions.flatMap((mission) => mission.steps.flatMap((step) => step.tracks));
  assert.ok(allMissionTracks.length > 0, 'missions should contain playable tracks');
  assert.ok(!allMissionTracks.some((track) => track.title === 'Avoid Me'), 'Discover should not recommend avoided tracks');

  const visualMission = surface.missions.find((mission) => mission.id === 'visual-night');
  assert.ok(visualMission, 'surface should include a visual night mission');
  assert.ok(visualMission.visualPlan, 'visual night should include a visual set plan');
  assert.ok(!visualMission.visualPlan.presets.some((preset) => ['neon-waves', 'neon-ribbons', 'plasma-grid', 'burning-cloud'].includes(preset)), 'low-end visual plan should avoid heavy presets');
  assert.ok(
    ['bento', 'winamp-classic', 'winamp-industrial', 'record-player', 'jukebox', 'cassette', 'discman', 'retro-tv'].includes(visualMission.visualPlan.deckSkin),
    'visual plan should choose a real deck skin',
  );

  const playlist = library.savePlaylist({
    name: 'Discover Smoke Mission',
    trackIds: surface.missions[0].steps.flatMap((step) => step.tracks.map((track) => track.id)),
  });
  assert.ok(playlist.trackCount > 0, 'discover missions should save through normal playlists');
} finally {
  library.close();
}

const [appSource, sidebarSource, storeSource, discoverViewSource, quickPlaySource, sharedTypes, preloadSource, apiSource, mainSource, packageSource, releaseGateSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/DiscoverView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/QuickPlayPalette.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /'discover'/, 'player store should expose the Discover view mode');
assert.match(sidebarSource, /Discover/, 'Sidebar should include Discover navigation');
assert.match(appSource, /DiscoverView/, 'App should route to DiscoverView');
assert.match(discoverViewSource, /getDiscoverSurface/, 'Discover view should load native Living Library data');
assert.match(discoverViewSource, /Save as Playlist/, 'Discover missions should be saveable');
assert.match(discoverViewSource, /setFullscreenViz\(true\)/, 'Discover should launch fullscreen visualizer');
assert.match(discoverViewSource, /setCompactMode\(true\)/, 'Discover should launch deck view');
assert.match(quickPlaySource, /Living Library missions/, 'Quick Play should expose Discover as a view target');
assert.match(sharedTypes, /DiscoverSurface/, 'shared API should expose Discover surface types');
assert.match(preloadSource, /library:get-discover-surface/, 'preload should expose Discover IPC');
assert.match(apiSource, /getDiscoverSurface/, 'renderer API should expose Discover');
assert.match(mainSource, /library:get-discover-surface/, 'main process should register Discover IPC');
assert.match(packageSource, /smoke:discover/, 'package scripts should expose Discover smoke');
assert.match(packageSource, /smoke:ui-discover/, 'package scripts should expose UI Discover smoke');
assert.match(releaseGateSource, /smoke:discover/, 'release gate should include native Discover smoke');
assert.match(releaseGateSource, /smoke:ui-discover/, 'release gate should include UI Discover smoke');

console.log(JSON.stringify({ ok: true }, null, 2));
