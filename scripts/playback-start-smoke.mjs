import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePlaybackStartIndex } from '../dist-electron/shared/playback-start.js';

assert.equal(resolvePlaybackStartIndex(0, -1), -1, 'empty queues should not produce a start index');
assert.equal(resolvePlaybackStartIndex(3, -1), 0, 'idle loaded queues should start at the first track');
assert.equal(resolvePlaybackStartIndex(3, 2), 2, 'valid queued indices should start at the selected track');
assert.equal(resolvePlaybackStartIndex(3, 99), 2, 'oversized queued indices should clamp to the last track');
assert.equal(resolvePlaybackStartIndex(3, 1.8), 1, 'fractional queued indices should truncate before playback');

const [storeSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /resolvePlaybackStartIndex/, 'player store should use the queued playback start helper');
assert.match(storeSource, /state\.queue\.length/, 'transport Play should consider an idle loaded queue');
assert.match(packageSource, /"smoke:playback-start"/, 'package.json should expose playback start smoke');

console.log(JSON.stringify({ ok: true }, null, 2));
