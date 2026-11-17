import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['shared/discover.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { buildDiscoverSurface } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const now = Date.UTC(2026, 10, 17);
const tracks = Array.from({ length: 240 }, (_, i) => ({
  id: i + 1, path: `/chosen/${i}.flac`, title: `Track ${i}`, artist: `Artist ${Math.floor(i / 4)}`,
  albumArtist: `Artist ${Math.floor(i / 4)}`, album: `Album ${Math.floor(i / 4)}`, albumKey: `album-${Math.floor(i / 4)}`,
  discNo: 1, trackNo: i % 4 + 1, duration: 180, mtime: now - i * 1000,
  genre: i % 2 ? 'Rock' : 'Jazz', year: 1990, loved: true, rating: 5, ratingScore: 100,
  playCount: 0, skipCount: 0, lastPlayed: null, avoidAutoPlay: false,
}));
const ids = list => list.map(track => track.id);
const first = buildDiscoverSurface({ tracks, now, seed: 'run-a', limit: 12 });
assert.deepEqual(first, buildDiscoverSurface({ tracks, now, seed: 'run-a', limit: 12 }), 'same snapshot and seed are reproducible');
for (const card of first.cards) {
  const next = buildDiscoverSurface({ tracks, now, seed: 'run-b', limit: 12, previousTrackIds: ids(card.tracks) });
  const nextCard = next.cards.find(item => item.id === card.id);
  assert.ok(nextCard);
  assert.ok(nextCard.tracks.every(track => !ids(card.tracks).includes(track.id)), `${card.id}: choose new tracks when the lane has room`);
  assert.notDeepEqual(ids(nextCard.tracks).slice(0, 4), ids(card.tracks).slice(0, 4), `${card.id}: openers change`);
  if (card.id === 'deep-album-run') assert.deepEqual(nextCard.tracks.map(track => track.trackNo), [1, 2, 3, 4], 'albums retain musical order');
}
const mission = first.missions.find(item => item.id === 'daily-crate');
const next = buildDiscoverSurface({ tracks, now, seed: 'run-b', limit: 12, previousTrackIds: ids(mission.tracks) });
assert.ok(next.missions.find(item => item.id === 'daily-crate').tracks.every(track => !ids(mission.tracks).includes(track.id)), 'Reshuffle replaces the daily crate, including its fresh openers');
const radar = first.cards.find(card => card.id === 'new-download-radar');
assert.deepEqual(ids(radar.tracks), ids(tracks.slice(0, 12)), 'Radar shows newest first');
assert.deepEqual(ids(buildDiscoverSurface({ tracks, now, seed: 'another-run', limit: 12 }).cards.find(card => card.id === radar.id).tracks), ids(radar.tracks), 'Radar is independent of random seed');
const olderRadar = buildDiscoverSurface({ tracks, now, previousTrackIds: ids(radar.tracks), limit: 12 }).cards.find(card => card.id === radar.id);
assert.deepEqual(ids(olderRadar.tracks), ids(tracks.slice(12, 24)), 'Radar reshuffle shows next newest set in date order');
// A small pile of new files still fills the Radar after Reshuffle: the three
// not shown yet, topped up from the ones that were, newest first.
const fifteen = tracks.slice(0, 15);
const smallRadar = buildDiscoverSurface({ tracks: fifteen, now, limit: 12 }).cards.find(card => card.id === radar.id);
const smallNext = buildDiscoverSurface({ tracks: fifteen, now, limit: 12, previousTrackIds: ids(smallRadar.tracks) }).cards.find(card => card.id === radar.id);
assert.equal(smallNext.tracks.length, 12, 'Radar stays full when few files are new');
assert.ok([13, 14, 15].every(id => ids(smallNext.tracks).includes(id)), 'and includes the files not shown yet');
assert.deepEqual(ids(smallNext.tracks), [...ids(smallNext.tracks)].sort((a, b) => a - b), 'in date order');
for (const size of [0, 1, 2, 5]) {
  const small = buildDiscoverSurface({ tracks: tracks.slice(0, size), now, seed: 'small', previousTrackIds: ids(tracks), limit: 12 });
  for (const card of small.cards) assert.equal(new Set(ids(card.tracks)).size, card.tracks.length, 'small libraries fill without duplicate tracks');
}
console.log('PASS Discover selection: deterministic seed, fresh selections and openers, whole albums, bounded recent pool, small libraries');
