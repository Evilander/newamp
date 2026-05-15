import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  nextHandoffIndex,
  shouldPrepareTrackHandoff,
  shouldStartTrackHandoff,
} from '../dist-electron/shared/playback-handoff.js';

assert.equal(nextHandoffIndex({ queueLength: 4, index: 1, mode: 'normal' }), 2);
assert.equal(nextHandoffIndex({ queueLength: 4, index: 3, mode: 'normal' }), null);
assert.equal(nextHandoffIndex({ queueLength: 4, index: 3, mode: 'repeat-all' }), 0);
assert.equal(nextHandoffIndex({ queueLength: 4, index: 2, mode: 'repeat-one' }), null);

assert.equal(
  shouldStartTrackHandoff({
    playing: true,
    duration: 240,
    currentTime: 236.2,
    crossfadeMs: 4000,
    queueLength: 5,
    index: 2,
    mode: 'normal',
    currentTrackId: 10,
    lastHandoffKey: null,
  }),
  true,
  'crossfade should start while the current track is inside the handoff window',
);
assert.equal(
  shouldStartTrackHandoff({
    playing: true,
    duration: 240,
    currentTime: 236.2,
    crossfadeMs: 0,
    queueLength: 5,
    index: 2,
    mode: 'normal',
    currentTrackId: 10,
    lastHandoffKey: null,
  }),
  false,
  'handoff should not run when crossfade is off',
);
assert.equal(
  shouldStartTrackHandoff({
    playing: true,
    duration: 240,
    currentTime: 236.2,
    crossfadeMs: 4000,
    queueLength: 5,
    index: 2,
    mode: 'normal',
    currentTrackId: 10,
    lastHandoffKey: '10:2',
  }),
  false,
  'handoff should run once per track/index pair',
);
assert.equal(
  shouldPrepareTrackHandoff({
    playing: true,
    duration: 240,
    currentTime: 232.5,
    crossfadeMs: 0,
    queueLength: 5,
    index: 2,
    mode: 'normal',
    currentTrackId: 10,
    lastHandoffKey: null,
  }),
  true,
  'gapless mode should preload the next deck before the current track ends',
);
assert.equal(
  shouldPrepareTrackHandoff({
    playing: true,
    duration: 240,
    currentTime: 232.5,
    crossfadeMs: 4000,
    queueLength: 5,
    index: 2,
    mode: 'normal',
    currentTrackId: 10,
    lastHandoffKey: null,
  }),
  false,
  'gapless preload should not duplicate the crossfade handoff path',
);
assert.equal(
  shouldPrepareTrackHandoff({
    playing: true,
    duration: 240,
    currentTime: 232.5,
    crossfadeMs: 0,
    queueLength: 5,
    index: 2,
    mode: 'normal',
    currentTrackId: 10,
    lastHandoffKey: '10:2',
  }),
  false,
  'gapless preload should run once per track/index pair',
);

const [engineSource, storeSource, packageSource] = await Promise.all([
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(engineSource, /prepareNext/, 'AudioEngine should expose a next-deck preload path');
assert.match(engineSource, /preparedNext/, 'AudioEngine should remember the preloaded deck');
assert.match(storeSource, /shouldStartTrackHandoff/, 'player store should use playback handoff policy');
assert.match(storeSource, /shouldPrepareTrackHandoff/, 'player store should use gapless preload policy');
assert.match(storeSource, /engine\.prepareNext/, 'player store should prime the inactive deck near track end');
assert.match(storeSource, /lastHandoffKey/, 'player store should guard duplicate handoffs');
assert.match(packageSource, /"smoke:handoff"/, 'package.json should expose playback handoff smoke');

console.log(JSON.stringify({ ok: true }, null, 2));
