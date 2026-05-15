import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  moveQueueItem,
  removeQueueItem,
} from '../dist-electron/shared/queue-edit.js';

const queue = [track(1), track(2), track(3), track(4)];

assert.deepEqual(
  moveQueueItem(queue, 2, 3, 1),
  { queue: [track(1), track(4), track(2), track(3)], index: 3 },
  'moving an item before the current track should keep current index attached to the same track',
);
assert.deepEqual(
  moveQueueItem(queue, 2, 2, 0),
  { queue: [track(3), track(1), track(2), track(4)], index: 0 },
  'moving the current track should move current index with it',
);
assert.deepEqual(
  removeQueueItem(queue, 2, 1),
  { queue: [track(1), track(3), track(4)], index: 1, removedCurrent: false },
  'removing a track before current should shift current index backward',
);
assert.deepEqual(
  removeQueueItem(queue, 2, 2),
  { queue: [track(1), track(2), track(4)], index: 2, removedCurrent: true },
  'removing current should select the next playable slot',
);
assert.deepEqual(
  removeQueueItem([track(1)], 0, 0),
  { queue: [], index: -1, removedCurrent: true },
  'removing the only track should empty the queue',
);

const [storeSource, playlistViewSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/PlaylistView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /moveQueuedTrack/, 'player store should expose queue move action');
assert.match(storeSource, /removeQueuedTrack/, 'player store should expose queue remove action');
assert.match(storeSource, /clearQueue/, 'player store should expose queue clear action');
assert.match(playlistViewSource, /Move up/, 'Now Queue should expose move up controls');
assert.match(playlistViewSource, /Remove from queue/, 'Now Queue should expose remove controls');
assert.match(playlistViewSource, /draggedQueueIndex/, 'Now Queue should track the dragged queue row');
assert.match(playlistViewSource, /draggable=\{true\}/, 'Now Queue rows should be draggable for reorder');
assert.match(playlistViewSource, /onDragStart/, 'Now Queue rows should expose drag start handling');
assert.match(playlistViewSource, /onDrop/, 'Now Queue rows should expose drop handling');
assert.match(playlistViewSource, /dataTransfer\.getData\('text\/plain'\)/, 'queue drop should keep a drag payload fallback');
assert.match(playlistViewSource, /moveQueuedTrack\(fromIndex, i\)/, 'dropping a queue row should reuse the queue move action');
assert.doesNotMatch(playlistViewSource, /[\u00c3\u00e2\ufffd]/, 'Now Queue controls should not contain mojibake glyphs');
assert.match(packageSource, /"smoke:queue-edit"/, 'package.json should expose queue edit smoke');

console.log(JSON.stringify({ ok: true }, null, 2));

function track(id) {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Queue Edit',
    album: 'Smoke',
    albumArtist: 'Queue Edit',
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
