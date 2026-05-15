import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const smokeRoot = resolve('tmp', 'home-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const coverPath = join(smokeRoot, 'home-playlist-icon.png');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { title: 'Home Seed', artist: 'Dashboard', album: 'Start Here', bpm: 120, key: 'C', loved: true, rating: 5, mtime: 3000 },
  { title: 'Newest Import', artist: 'Dashboard', album: 'Start Here', bpm: 122, key: 'A minor', loved: false, rating: 0, mtime: 5000 },
  { title: 'Heavy Repeat', artist: 'Rotation', album: 'Daily', bpm: 126, key: 'G', loved: false, rating: 4, mtime: 2000 },
  { title: 'Deep Cut', artist: 'Archive', album: 'Crate', bpm: 98, key: 'D minor', loved: false, rating: 3, mtime: 1000 },
];

for (const fixture of fixtures) {
  await writeFile(join(musicRoot, `${fixture.title}.mp3`), '');
}
await writeFile(
  coverPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIAgDZF4gAAAABJRU5ErkJggg==',
    'base64',
  ),
);

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
    mtime: fixture.mtime,
    art: null,
  })));

  const tracks = library.getTracks({ sort: 'album', limit: 20 });
  const byTitle = new Map(tracks.map((track) => [track.title, track]));
  for (const fixture of fixtures) {
    const track = byTitle.get(fixture.title);
    assert.ok(track, `${fixture.title} should exist`);
    if (fixture.loved) library.toggleLove(track.id);
    if (fixture.rating) library.setTrackRating(track.id, fixture.rating);
  }

  const heavy = byTitle.get('Heavy Repeat');
  assert.ok(heavy, 'heavy fixture should exist');
  library.recordPlay(heavy.id, 1778826300000);
  library.recordPlay(heavy.id, 1778826301000);
  library.recordPlay(heavy.id, 1778826302000);

  const seed = byTitle.get('Home Seed');
  assert.ok(seed, 'seed fixture should exist');
  library.recordPlay(seed.id, 1778826303000);

  const fresh = library.getTracks({ sort: 'added', limit: 4, offset: 0 });
  assert.equal(fresh[0].title, 'Newest Import', 'Home fresh imports should use newest file mtime');

  const history = library.getListeningHistory({ limit: 4, offset: 0 });
  assert.equal(history[0].track.title, 'Home Seed', 'Home history should surface latest play first');

  const played = library.getTracks({ sort: 'plays', limit: 4, offset: 0 });
  assert.equal(played[0].title, 'Heavy Repeat', 'Home heavy rotation should use play counts');

  const loved = library.getTracks({ sort: 'loved', limit: 4, offset: 0 });
  assert.equal(loved[0].title, 'Home Seed', 'Home loved rail should use loved rows');

  const harmonic = library.buildHarmonicMix({ seedTrackId: seed.id, count: 4 });
  assert.ok(harmonic.length >= 3, 'Home harmonic rail should have playable candidates');

  const playlist = library.savePlaylist({
    name: 'Home Smoke Playlist',
    trackIds: harmonic.map((track) => track.id),
    coverImagePath: coverPath,
  });
  assert.equal(playlist.trackCount, harmonic.length, 'Home playlist launcher should rely on normal playlists');
  assert.equal(playlist.hasCoverArt, 1, 'Home playlist launcher should preserve custom playlist icons');
  assert.equal(library.getPlaylistTracks(playlist.id).length, harmonic.length, 'Home can load saved playlist tracks');
  assert.equal(library.getPlaylistCover(playlist.id)?.mime, 'image/png', 'Home playlist icons should be retrievable');

  const smartRule = library.saveSmartPlaylistRule({
    name: 'Home Smoke Smart Rule',
    mood: 'focus',
    count: 3,
    genreQuery: 'Electronic',
  });
  const smartRuleTracks = library.runSmartPlaylistRule(smartRule.id);
  assert.equal(smartRuleTracks.length, 3, 'Home should be able to launch saved smart rules as dynamic playlists');
  const suggestions = library.getSuggestedSmartPlaylistRules();
  assert.ok(suggestions.some((suggestion) => suggestion.title === 'Electronic Radio'), 'Home should receive library-built suggested stations');
} finally {
  library.close();
}

const [appSource, sidebarSource, storeSource, homeSource, packageSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/HomeView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /'home'/, 'player store should expose Home view mode');
assert.match(storeSource, /view: 'home'/, 'Home should be the default start view');
assert.match(sidebarSource, /Home/, 'Sidebar should include Home navigation');
assert.match(appSource, /HomeView/, 'App should route to HomeView');
assert.match(homeSource, /getStats/, 'Home should show library stats');
assert.match(homeSource, /getLibraryHealth/, 'Home should surface library health');
assert.match(homeSource, /getListeningHistory/, 'Home should surface listening history');
assert.match(homeSource, /buildHarmonicMix/, 'Home should expose harmonic launch recommendations');
assert.match(homeSource, /Fresh Imports/, 'Home should expose scan-derived fresh imports');
assert.match(homeSource, /getPlaylists/, 'Home should launch saved playlists');
assert.match(homeSource, /getSmartPlaylistRules/, 'Home should load saved smart playlist rules');
assert.match(homeSource, /getSuggestedSmartPlaylistRules/, 'Home should load suggested smart playlist stations');
assert.match(homeSource, /runSmartPlaylistRule/, 'Home should launch saved smart playlist rules');
assert.match(homeSource, /setAutoDjSmartRuleId/, 'Home should arm Auto DJ from saved smart playlist rules');
assert.match(homeSource, /Station Active/, 'Home should show active station state');
assert.match(homeSource, /STOP RADIO/, 'Home should expose active station stop controls');
assert.match(homeSource, /Smart Rule Radio/, 'Home should start continuous Smart Rule Radio');
assert.match(homeSource, /RADIO/, 'Home should expose smart-rule radio launchers');
assert.match(homeSource, /Suggested Stations/, 'Home should expose suggested station launchers');
assert.match(homeSource, /SMART/, 'Home should label dynamic smart-rule launchers');
assert.match(homeSource, /savePlaylist/, 'Home should save generated sets as playlists');
assert.match(homeSource, /getPlaylistCoverUrl/, 'Home should render saved playlist icons');
assert.match(homeSource, /hasCoverArt/, 'Home should branch playlist rows on custom icon state');
assert.match(homeSource, /EMPTY/, 'Home should distinguish empty custom playlists from playable playlists');
assert.match(packageSource, /smoke:home/, 'package scripts should expose home smoke');

console.log(JSON.stringify({ ok: true }, null, 2));
