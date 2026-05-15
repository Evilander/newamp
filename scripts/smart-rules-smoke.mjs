import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'smart-rules-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { name: '01-fast-loved-rock.mp3', title: 'Fast Loved Rock', genre: 'Rock', year: 2001, bpm: 132, playCount: 4, loved: true, rating: 5 },
  { name: '02-slow-loved-jazz.mp3', title: 'Slow Loved Jazz', genre: 'Jazz', year: 1999, bpm: 74, playCount: 2, loved: true, rating: 2 },
  { name: '03-new-punk.mp3', title: 'New Punk', genre: 'Punk Rock', year: 2026, bpm: 148, playCount: 0, loved: false, rating: 4 },
  { name: '04-ambient-focus.mp3', title: 'Ambient Focus', genre: 'Ambient', year: 2024, bpm: 82, playCount: 0, loved: false, rating: 1 },
  { name: '05-clean-twin-rock.mp3', title: 'Clean Twin Rock', genre: 'Rock', year: 1990, bpm: 122, playCount: 0, loved: false, rating: 3 },
  { name: '06-skipped-twin-rock.mp3', title: 'Skipped Twin Rock', genre: 'Rock', year: 1990, bpm: 122, playCount: 0, loved: false, rating: 3 },
];

for (const fixture of fixtures) await writeFile(join(musicRoot, fixture.name), '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks(fixtures.map((fixture, index) => ({
  path: join(musicRoot, fixture.name),
  title: fixture.title,
  artist: 'Smart Rule Fixture',
  album: 'Rules',
  albumArtist: 'Smart Rule Fixture',
  trackNo: index + 1,
  discNo: null,
  year: fixture.year,
  genre: fixture.genre,
  duration: 180 + index,
  bitrate: 320000,
  sampleRate: 44100,
  bpm: fixture.bpm,
  key: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: Date.now(),
  art: null,
})));

const tracks = library.getTracks({ sort: 'album', limit: 20 });
for (const fixture of fixtures) {
  const track = tracks.find((candidate) => candidate.title === fixture.title);
  assert.ok(track, `missing fixture ${fixture.title}`);
  if (fixture.loved) library.toggleLove(track.id);
  library.setTrackRating(track.id, fixture.rating);
  for (let i = 0; i < fixture.playCount; i++) library.recordPlay(track.id);
}

const saved = library.saveSmartPlaylistRule({
  name: 'Loved Drive Rock',
  mood: 'drive',
  count: 4,
  genreQuery: 'rock',
  searchQuery: 'title:"Fast Loved Rock"',
  minYear: 2000,
  maxYear: 2005,
  minBpm: 100,
  maxBpm: 160,
  minRating: 5,
  lovedOnly: true,
});
assert.equal(saved.name, 'Loved Drive Rock');
assert.equal(saved.mood, 'drive');
assert.equal(saved.count, 4);
assert.equal(saved.lovedOnly, true);
assert.equal(saved.minRating, 5);

const generated = library.runSmartPlaylistRule(saved.id);
assert.deepEqual(generated.map((track) => track.title), ['Fast Loved Rock']);

const preview = library.runSmartPlaylistRule({
  name: 'Fresh Energy',
  mood: 'deep-cuts',
  count: 2,
  genreQuery: 'rock',
  minYear: 2020,
  maxYear: 2026,
  minRating: 4,
  unplayedOnly: true,
});
assert.deepEqual(preview.map((track) => track.title), ['New Punk']);

const eraRock = library.runSmartPlaylistRule({
  name: 'Current Era Rock',
  mood: 'drive',
  count: 4,
  genreQuery: 'rock',
  minYear: 2020,
  maxYear: 2026,
});
assert.deepEqual(eraRock.map((track) => track.title), ['New Punk']);

const powerSearchRule = library.runSmartPlaylistRule({
  name: 'Power Query Smart Rule',
  mood: 'drive',
  count: 4,
  searchQuery: 'rating:>=4 loved:false',
});
assert.deepEqual(powerSearchRule.map((track) => track.title), ['New Punk']);

const ratedRock = library.runSmartPlaylistRule({
  name: 'Rated Rock',
  mood: 'drive',
  count: 4,
  genreQuery: 'rock',
  minRating: 4,
});
assert.deepEqual(ratedRock.map((track) => track.title), ['Fast Loved Rock', 'New Punk']);

const skippedTwin = library.getTracks({ search: 'title:"Skipped Twin Rock"', limit: 1 })[0];
assert.ok(skippedTwin, 'skipped twin fixture should exist');
for (let i = 0; i < 8; i++) library.recordSkip(skippedTwin.id, Date.now() + i, 12);
const skipAware = library.runSmartPlaylistRule({
  name: 'Skip Aware Twin Rock',
  mood: 'drive',
  count: 2,
  searchQuery: 'title:"Twin Rock"',
  maxYear: 1999,
});
assert.deepEqual(skipAware.map((track) => track.title), ['Clean Twin Rock', 'Skipped Twin Rock']);

const listed = library.getSmartPlaylistRules();
assert.equal(listed.length, 1);
assert.equal(listed[0].id, saved.id);

const updated = library.saveSmartPlaylistRule({
  ...saved,
  name: 'Loved Drive Edited',
  lovedOnly: false,
});
assert.equal(updated.name, 'Loved Drive Edited');
assert.equal(library.getSmartPlaylistRules()[0]?.name, 'Loved Drive Edited');

library.deleteSmartPlaylistRule(saved.id);
assert.equal(library.getSmartPlaylistRules().length, 0);
library.close();

const [sharedTypes, playlistViewSource, apiSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/PlaylistView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /SmartPlaylistRule/, 'shared API should expose saved smart playlist rules');
assert.match(sharedTypes, /minRating/, 'shared smart rule types should expose minRating');
assert.match(sharedTypes, /minYear/, 'shared smart rule types should expose minYear');
assert.match(sharedTypes, /maxYear/, 'shared smart rule types should expose maxYear');
assert.match(sharedTypes, /searchQuery/, 'shared smart rule types should expose power-search queries');
assert.match(playlistViewSource, /Saved Smart Rules/, 'Now Queue should display saved smart rules');
assert.match(playlistViewSource, /Power search/, 'Now Queue should expose Library power search in smart rules');
assert.match(playlistViewSource, /Min year/, 'Now Queue should expose minimum year in smart rules');
assert.match(playlistViewSource, /Max year/, 'Now Queue should expose maximum year in smart rules');
assert.match(playlistViewSource, /Min rating/, 'Now Queue should expose minimum rating in smart rules');
assert.match(playlistViewSource, /saveSmartPlaylistRule/, 'Now Queue should save smart rules');
assert.match(playlistViewSource, /START SMART RULE RADIO/, 'Now Queue should launch saved smart rules as continuous radio');
assert.match(playlistViewSource, /setAutoDjSmartRuleId/, 'Now Queue should arm Auto DJ from saved smart rules');
assert.match(apiSource, /runSmartPlaylistRule/, 'renderer API should expose smart rule generation');

console.log(JSON.stringify({
  ok: true,
  generated: generated.map((track) => track.title),
  preview: preview.map((track) => track.title),
  eraRock: eraRock.map((track) => track.title),
  powerSearchRule: powerSearchRule.map((track) => track.title),
  ratedRock: ratedRock.map((track) => track.title),
  skipAware: skipAware.map((track) => track.title),
  saved: updated,
}, null, 2));
