// nextSmartShuffle picked the next candidate via
// indexes(length).filter(i => !history.includes(i)) — an O(history.length)
// array scan run once per candidate, i.e. O(queueLength x history.length)
// for a single advance. Late in a shuffle cycle (history almost as long as
// the queue) that's effectively O(queueLength^2) for ONE track change — a
// multi-second main-thread stall on a large queue. This isolates exactly
// that worst-case single call (history one short of full) and asserts it
// stays fast, proving the Set-based O(queueLength) fix is in place.
// Run with: npm run test:smart-shuffle-perf

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nextSmartShuffle } from '../dist-electron/shared/smart-shuffle.js';

const QUEUE_LENGTH = 40000;
// History covering every index except the current one and one other —
// the worst case: almost the whole queue has already been visited this
// shuffle cycle, so nearly every candidate has to be checked against history.
const currentIndex = 0;
const remaining = 12345;
const history = [];
for (let i = 0; i < QUEUE_LENGTH; i++) {
  if (i === currentIndex || i === remaining) continue;
  history.push(i);
}
history.push(currentIndex);

const startedAt = performance.now();
const result = nextSmartShuffle({ queueLength: QUEUE_LENGTH, currentIndex, history }, () => 0);
const elapsedMs = performance.now() - startedAt;

assert.equal(result.index, remaining, 'the single remaining un-played index should be chosen deterministically');

// Generous ceiling: the O(queueLength) fix resolves this in low single-digit
// milliseconds. The prior O(queueLength x history.length) behavior does
// roughly queueLength^2 work for this exact history shape (~1.6 billion
// comparisons at this size) — comfortably multiple seconds, not under 300ms.
assert.ok(
  elapsedMs < 300,
  `a single nextSmartShuffle call near the end of a ${QUEUE_LENGTH}-track shuffle cycle took ${elapsedMs.toFixed(0)}ms — expected well under 300ms for the O(queueLength) fix`,
);

const smartShuffleSource = await readFile(new URL('../shared/smart-shuffle.ts', import.meta.url), 'utf8');
assert.match(smartShuffleSource, /new Set\(history\)/, 'candidate selection should use a Set for O(1) history membership checks');
assert.doesNotMatch(smartShuffleSource, /!history\.includes\(index\)/, 'candidate selection should no longer scan the history array per candidate');
assert.doesNotMatch(smartShuffleSource, /clean\.includes\(index\)/, 'sanitizeHistory should no longer scan its output array per input entry');

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"test:smart-shuffle-perf"/, 'package.json should expose the smart shuffle perf test');

console.log(JSON.stringify({ ok: true, elapsedMs: Math.round(elapsedMs), queueLength: QUEUE_LENGTH }, null, 2));
