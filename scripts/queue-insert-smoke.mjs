import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  appendTracksToQueue,
  appendTrackToQueue,
  insertTracksNext,
  insertTrackNext,
} from '../dist-electron/shared/queue-insert.js';

const queue = [track(1), track(2), track(3)];

assert.deepEqual(
  insertTrackNext(queue, 1, track(9)),
  { queue: [track(1), track(2), track(9), track(3)], index: 1 },
  'play next should insert directly after the active track without moving current',
);
assert.deepEqual(
  insertTrackNext(queue, -1, track(9)),
  { queue: [track(9), track(1), track(2), track(3)], index: -1 },
  'play next should put a loaded but idle queue insertion at the front',
);
assert.deepEqual(
  insertTrackNext([], -1, track(9)),
  { queue: [track(9)], index: -1 },
  'play next should work against an empty queue',
);
assert.deepEqual(
  appendTrackToQueue(queue, 1, track(9)),
  { queue: [track(1), track(2), track(3), track(9)], index: 1 },
  'add to queue should append without changing the active track',
);
assert.deepEqual(
  insertTracksNext(queue, 1, [track(8), track(9)]),
  { queue: [track(1), track(2), track(8), track(9), track(3)], index: 1 },
  'play next should preserve track order when inserting a group',
);
assert.deepEqual(
  appendTracksToQueue(queue, 1, [track(8), track(9)]),
  { queue: [track(1), track(2), track(3), track(8), track(9)], index: 1 },
  'add to queue should preserve track order when appending a group',
);
assert.deepEqual(
  insertTracksNext(queue, 1, []),
  { queue, index: 1 },
  'empty play-next groups should be ignored without changing index',
);

const [storeSource, tableSource, albumsSource, artistsSource, lovedSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/AlbumsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/ArtistsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LovedView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /queueTrackNext/, 'player store should expose play-next queue action');
assert.match(storeSource, /addTrackToQueue/, 'player store should expose add-to-queue action');
assert.match(storeSource, /queueTracksNext/, 'player store should expose grouped play-next queue action');
assert.match(storeSource, /addTracksToQueue/, 'player store should expose grouped add-to-queue action');
assert.match(tableSource, /Play next/, 'track tables should expose Play next controls');
assert.match(tableSource, /Add to queue/, 'track tables should expose Add to queue controls');
assert.match(tableSource, /NEXT SELECTED/, 'track tables should expose selected-row play-next controls');
assert.match(tableSource, /QUEUE SELECTED/, 'track tables should expose selected-row queue controls');
assert.match(albumsSource, /Play album next/, 'album detail should expose play-next group control');
assert.match(albumsSource, /Queue album/, 'album detail should expose queue-all group control');
assert.match(artistsSource, /Play artist next/, 'artist detail should expose play-next group control');
assert.match(artistsSource, /Queue artist/, 'artist detail should expose queue-all group control');
assert.match(lovedSource, /Play loaded loved tracks next/, 'loved view should expose play-next group control for loaded favorites');
assert.match(lovedSource, /Queue loaded loved tracks/, 'loved view should expose queue-all group control for loaded favorites');
assert.match(packageSource, /"smoke:queue-insert"/, 'package.json should expose queue insert smoke');

console.log(JSON.stringify({ ok: true }, null, 2));

function track(id) {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Queue Insert',
    album: 'Smoke',
    albumArtist: 'Queue Insert',
    path: `B:/music/${id}.mp3`,
    trackNo: id,
    discNo: null,
    year: 2026,
    genre: null,
    duration: 180,
    bitrate: 320000,
    sampleRate: 44100,
    size: 1,
    mtime: 1,
    hasArt: 0,
    loved: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
  };
}
