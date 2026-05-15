import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from '../dist-electron/electron/settings.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'session-smoke');
const settingsPath = join(smokeRoot, 'settings.json');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const settings = new SettingsStore(settingsPath);
const saved = settings.set({
  resumeState: {
    queueTrackIds: [11, 12, 13],
    index: 1,
    currentTime: 87.25,
    mode: 'shuffle',
    updatedAt: 1778803000000,
  },
});
assert.deepEqual(saved.resumeState?.queueTrackIds, [11, 12, 13]);
assert.equal(saved.resumeState?.index, 1);
assert.equal(saved.resumeState?.currentTime, 87.25);
assert.equal(saved.resumeState?.mode, 'shuffle');

const reloaded = new SettingsStore(settingsPath).get();
assert.deepEqual(reloaded.resumeState?.queueTrackIds, [11, 12, 13]);
assert.equal(reloaded.resumeState?.index, 1);
assert.equal(reloaded.resumeState?.currentTime, 87.25);
assert.equal(reloaded.resumeState?.mode, 'shuffle');

const [sharedTypes, storeSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /PlaybackResumeState/, 'shared types should define persisted playback resume state');
assert.match(sharedTypes, /resumeState/, 'AppSettings should include resumeState');
assert.match(storeSource, /restorePlaybackSession/, 'store should restore queue and current track from settings');
assert.match(storeSource, /persistPlaybackSession/, 'store should persist queue, index, time, and mode');
assert.match(storeSource, /resumeAt/, 'store should keep the saved time until playback starts');

console.log(JSON.stringify({
  ok: true,
  resumeState: reloaded.resumeState,
}, null, 2));
