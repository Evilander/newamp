import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  playbackErrorKey,
  resolvePlaybackErrorAdvance,
} from '../dist-electron/shared/playback-error.js';

assert.equal(
  playbackErrorKey({ currentTrackId: 42, index: 3, error: 'Audio error (code 4)' }),
  '42:3:Audio error (code 4)',
  'playback error key should identify the failed queue slot',
);

assert.deepEqual(
  resolvePlaybackErrorAdvance({
    error: 'Audio error (code 4)',
    currentTrackId: 42,
    index: 0,
    queueLength: 3,
    mode: 'normal',
    lastErrorKey: null,
  }),
  { key: '42:0:Audio error (code 4)', shouldAdvance: true, shouldStop: false },
  'middle-of-queue playback errors should advance',
);

assert.deepEqual(
  resolvePlaybackErrorAdvance({
    error: 'Audio error (code 4)',
    currentTrackId: 42,
    index: 2,
    queueLength: 3,
    mode: 'normal',
    lastErrorKey: null,
  }),
  { key: '42:2:Audio error (code 4)', shouldAdvance: false, shouldStop: true },
  'normal mode should stop after a failed final queue item',
);

assert.deepEqual(
  resolvePlaybackErrorAdvance({
    error: 'Audio error (code 4)',
    currentTrackId: 42,
    index: 2,
    queueLength: 3,
    mode: 'repeat-one',
    lastErrorKey: null,
  }),
  { key: '42:2:Audio error (code 4)', shouldAdvance: true, shouldStop: false },
  'repeat-one should not loop forever on a broken track',
);

assert.deepEqual(
  resolvePlaybackErrorAdvance({
    error: 'Audio error (code 4)',
    currentTrackId: 42,
    index: 0,
    queueLength: 1,
    mode: 'repeat-all',
    lastErrorKey: null,
  }),
  { key: '42:0:Audio error (code 4)', shouldAdvance: false, shouldStop: true },
  'single-track queues should stop instead of retrying the same broken item',
);

assert.deepEqual(
  resolvePlaybackErrorAdvance({
    error: 'Audio error (code 4)',
    currentTrackId: 42,
    index: 0,
    queueLength: 3,
    mode: 'normal',
    lastErrorKey: '42:0:Audio error (code 4)',
  }),
  { key: '42:0:Audio error (code 4)', shouldAdvance: false, shouldStop: false },
  'duplicate media error events should not schedule duplicate skips',
);

const [pkgSource, releaseGateSource, engineSource, storeSource, transportSource] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/Transport.tsx', import.meta.url), 'utf8'),
]);

assert.match(pkgSource, /smoke:playback-error/, 'package scripts should expose playback error smoke');
assert.match(releaseGateSource, /smoke:playback-error/, 'release gate should include playback error smoke');
assert.match(engineSource, /error: null/, 'engine stop/new playback should clear stale playback errors');
assert.match(storeSource, /resolvePlaybackErrorAdvance/, 'player store should route audio element errors through the shared policy');
assert.match(storeSource, /advanceAfterPlaybackError/, 'player store should auto-advance after playback errors');
assert.match(storeSource, /lastPlaybackErrorKey/, 'player store should dedupe repeated media error events');
assert.match(transportSource, /data-newamp-playback-error/, 'transport should render playback error status');

console.log(JSON.stringify({ ok: true }, null, 2));
