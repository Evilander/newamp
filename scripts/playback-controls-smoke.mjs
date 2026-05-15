import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeSleepTimerMinutes,
  sleepTimerEndTime,
  shouldStopAfterCurrent,
  shouldStopForSleepTimer,
  stopAfterCurrentKey,
} from '../dist-electron/shared/playback-controls.js';

assert.equal(normalizeSleepTimerMinutes(null), null, 'empty sleep timer should clear');
assert.equal(normalizeSleepTimerMinutes(0), null, 'zero sleep timer should clear');
assert.equal(normalizeSleepTimerMinutes(12.4), 12, 'sleep timer should use whole minutes');
assert.equal(normalizeSleepTimerMinutes(999), 480, 'sleep timer should clamp to eight hours');
assert.equal(sleepTimerEndTime(30, 1000), 1000 + 30 * 60_000, 'sleep timer should compute an absolute stop time');

const key = stopAfterCurrentKey(44, 2);
assert.equal(key, '44:2');
assert.equal(
  shouldStopAfterCurrent({
    ended: true,
    stopAfterCurrent: true,
    currentTrackId: 44,
    index: 2,
    lastStopKey: null,
  }),
  true,
  'stop-after-current should intercept a fresh ended event',
);
assert.equal(
  shouldStopAfterCurrent({
    ended: true,
    stopAfterCurrent: true,
    currentTrackId: 44,
    index: 2,
    lastStopKey: key,
  }),
  false,
  'stop-after-current should not re-enter for the same ended event',
);
assert.equal(
  shouldStopForSleepTimer({ playing: true, sleepTimerEndsAt: 5000, now: 5001 }),
  true,
  'sleep timer should stop active playback once expired',
);
assert.equal(
  shouldStopForSleepTimer({ playing: false, sleepTimerEndsAt: 5000, now: 5001 }),
  false,
  'sleep timer should not stop an already paused/stopped deck',
);

const [storeSource, playlistSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/PlaylistView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /stopAfterCurrent/, 'player store should own stop-after-current state');
assert.match(storeSource, /sleepTimerEndsAt/, 'player store should own sleep timer state');
assert.match(storeSource, /shouldStopAfterCurrent/, 'player store should guard ended auto-advance');
assert.match(storeSource, /shouldStopForSleepTimer/, 'player store should stop playback when timer expires');
assert.match(playlistSource, /STOP AFTER CURRENT/, 'Now Queue should expose stop-after-current control');
assert.match(playlistSource, /SLEEP/, 'Now Queue should expose sleep timer controls');
assert.match(packageSource, /smoke:playback-controls/, 'package scripts should include playback controls smoke');

console.log(JSON.stringify({ ok: true, key }, null, 2));
