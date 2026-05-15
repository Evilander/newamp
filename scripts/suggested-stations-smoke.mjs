import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const smokeRoot = resolve('tmp', 'suggested-stations-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { title: 'Rock One', artist: 'Signal Rockers', genre: 'Rock', year: 1991, loved: true, rating: 5, plays: 2 },
  { title: 'Rock Two', artist: 'Signal Rockers', genre: 'Rock', year: 1992, loved: false, rating: 4, plays: 1 },
  { title: 'Rock Three', artist: 'Signal Rockers', genre: 'Rock', year: 1993, loved: false, rating: 0, plays: 0 },
  { title: 'Jazz One', artist: 'Jazz Collective', genre: 'Jazz', year: 1964, loved: true, rating: 5, plays: 0 },
  { title: 'Jazz Two', artist: 'Jazz Collective', genre: 'Jazz', year: 1965, loved: false, rating: 0, plays: 0 },
  { title: 'Ambient One', artist: 'Ambient Maker', genre: 'Ambient', year: 2024, loved: false, rating: 4, plays: 0 },
];

for (const fixture of fixtures) await writeFile(join(musicRoot, `${fixture.title}.mp3`), '');

const library = await LibraryStore.open(dbPath);
try {
  library.upsertTracks(fixtures.map((fixture, index) => ({
    path: join(musicRoot, `${fixture.title}.mp3`),
    title: fixture.title,
    artist: fixture.artist,
    album: 'Station Signals',
    albumArtist: fixture.artist,
    trackNo: index + 1,
    discNo: null,
    year: fixture.year,
    genre: fixture.genre,
    duration: 180 + index,
    bitrate: 320000,
    sampleRate: 44100,
    bpm: 90 + index,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000 + index,
    mtime: 1778849000000 + index,
    art: null,
  })));

  const tracks = library.getTracks({ sort: 'album', limit: 20 });
  for (const fixture of fixtures) {
    const track = tracks.find((candidate) => candidate.title === fixture.title);
    assert.ok(track, `${fixture.title} should exist`);
    if (fixture.loved) library.toggleLove(track.id);
    if (fixture.rating) library.setTrackRating(track.id, fixture.rating);
    for (let i = 0; i < fixture.plays; i++) library.recordPlay(track.id, 1778849000000 + i);
  }

  const suggestions = library.getSuggestedSmartPlaylistRules();
  const titles = suggestions.map((suggestion) => suggestion.title);
  assert.ok(titles.includes('Loved Radio'), 'should suggest a loved station');
  assert.ok(titles.includes('High Rated Radio'), 'should suggest a high-rated station');
  assert.ok(titles.includes('Discovery Radio'), 'should suggest an unplayed discovery station');
  assert.ok(titles.includes('Recent Signal Rockers Radio'), 'should suggest a recent-history artist station');
  assert.ok(titles.includes('Rock Radio'), 'should suggest a top genre station');
  assert.ok(titles.includes('1990s Radio'), 'should suggest a dense decade station');
  const recentArtist = suggestions.find((suggestion) => suggestion.title === 'Recent Signal Rockers Radio');
  assert.equal(recentArtist?.rule.searchQuery, 'artist:"Signal Rockers"');
  assert.equal(recentArtist?.rule.mood, 'drive');
  for (const suggestion of suggestions) {
    assert.ok(suggestion.sampleCount > 0, `${suggestion.title} should have playable samples`);
    assert.ok(library.runSmartPlaylistRule(suggestion.rule).length > 0, `${suggestion.title} rule should run`);
  }
} finally {
  library.close();
}

const [sharedTypes, librarySource, mainSource, preloadSource, apiSource, homeSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/HomeView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /SmartPlaylistSuggestion/, 'shared API should expose suggested station types');
assert.match(librarySource, /getSuggestedSmartPlaylistRules/, 'library should generate suggested smart-rule stations');
assert.match(librarySource, /Recent .* Radio/, 'library should generate recent-history artist stations');
assert.match(mainSource, /smart:suggestions/, 'main process should expose suggested stations IPC');
assert.match(preloadSource, /smart:suggestions/, 'preload should expose suggested stations IPC');
assert.match(apiSource, /getSuggestedSmartPlaylistRules/, 'renderer API should expose suggested stations');
assert.match(homeSource, /Suggested Stations/, 'Home should render suggested stations');
assert.match(homeSource, /startSuggestedStation/, 'Home should launch suggested stations');
assert.match(homeSource, /saveSmartPlaylistRule/, 'Home should save suggested stations as reusable smart rules');
assert.match(homeSource, /setAutoDjSmartRuleId/, 'Home should arm Auto DJ from suggested stations');
assert.match(packageSource, /"smoke:suggested-stations"/, 'package scripts should expose suggested station smoke');

console.log(JSON.stringify({ ok: true }, null, 2));
