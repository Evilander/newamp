import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remapResumeIndex } from '../dist-electron/shared/playback-start.js';

// Reproduces the exact A/B/C/D scenario from the audit: queue was
// [A, B, C, D] with the saved index pointing at C (index 2). Track A gets
// deleted before restore. The old code clamped the raw saved index against
// the post-filter length (3) and landed on D — the wrong track. Remapping by
// id must land back on C.
const ids = [101, 102, 103, 104]; // A, B, C, D
const survivingAfterADeleted = new Set([102, 103, 104]); // B, C, D
assert.equal(
  remapResumeIndex(ids, 2, survivingAfterADeleted),
  1, // B=0, C=1, D=2 in the surviving order — C is at index 1
  'deleting an earlier track must not shift the resumed index onto an unrelated track',
);

// Nothing deleted: index passes through unchanged.
assert.equal(remapResumeIndex(ids, 2, new Set(ids)), 2, 'index should be unchanged when nothing was deleted');

// The saved current track itself is gone: fall back to the count of
// surviving entries before the saved position (nearest equivalent spot),
// not a flat clamp against the final length.
const survivingWithCurrentGone = new Set([101, 102, 104]); // A, B, D (C deleted)
assert.equal(
  remapResumeIndex(ids, 2, survivingWithCurrentGone),
  2, // A=0, B=1, D=2 — two tracks (A, B) survived before the saved position
  'when the saved track itself is gone, land on the position after however many earlier tracks survived',
);

// Everything before the saved index is gone: lands at 0, not negative.
assert.equal(
  remapResumeIndex(ids, 3, new Set([104])),
  0,
  'if every earlier track is gone the remap should clamp to the start of the surviving list, not go negative',
);

// No survivors at all: -1 (caller treats this as "nothing to restore").
assert.equal(remapResumeIndex(ids, 1, new Set()), -1, 'no surviving tracks should report -1');

// Empty saved queue: -1.
assert.equal(remapResumeIndex([], 0, new Set()), -1, 'an empty saved queue should report -1');

// --- Source assertions for the two glue-code fixes that can't run outside
// a DOM/Electron renderer (batch IPC call + engine release-on-remove).
const [storeSource, engineSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /remapResumeIndex\(ids, resumeState\.index, new Set\(byId\.keys\(\)\)\)/, 'restorePlaybackSession should remap the resume index by id');
assert.match(storeSource, /api\.getTracksByIds\(ids\)/, 'restorePlaybackSession should fetch the resumed queue with the batch API');
assert.doesNotMatch(
  storeSource,
  /queueTrackIds\.map\(\(id\) => api\.getTrack\(id\)/,
  'restorePlaybackSession should no longer fire one getTrack() IPC call per queued track',
);

assert.match(engineSource, /unload\(\): void \{/, 'AudioEngine should expose an unload() that releases src/trackId');
assert.match(
  engineSource.match(/unload\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? '',
  /src: null,\s*\n\s*trackId: null,/,
  'unload() should clear src and trackId so a later togglePlay() cold-starts instead of resuming a released track',
);

const removeQueuedTrackBody = storeSource.match(/removeQueuedTrack: async \(removeIndex\) => \{[\s\S]*?\n {4}\},/)?.[0] ?? '';
assert.ok(removeQueuedTrackBody, 'removeQueuedTrack action should be present');
assert.match(
  removeQueuedTrackBody,
  /engine\.unload\(\)/,
  'removing the current track while paused must release the engine instead of leaving it holding the removed track',
);

const refillBody = storeSource.match(/refillAutoDjQueue: async \(force = false\) => \{[\s\S]*?\n {4}\},/)?.[0] ?? '';
assert.ok(refillBody, 'refillAutoDjQueue action should be present');
assert.match(
  refillBody,
  /const fresh = get\(\);/,
  'refillAutoDjQueue should re-read state after its await instead of committing onto the pre-await snapshot',
);
assert.match(
  refillBody,
  /set\(\{ queue: \[\.\.\.fresh\.queue, \.\.\.additions\] \}\)/,
  'refillAutoDjQueue should commit its additions onto the freshly re-read queue',
);

assert.match(packageSource, /"test:session-restore-integrity"/, 'package.json should expose the session restore integrity test');

console.log(JSON.stringify({ ok: true }, null, 2));
