import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  nextSmartShuffle,
  previousSmartShuffle,
  resetSmartShuffleHistory,
} from '../dist-electron/shared/smart-shuffle.js';
import { nextHandoffIndex } from '../dist-electron/shared/playback-handoff.js';

const queueLength = 5;
let history = resetSmartShuffleHistory(queueLength, 0);
const played = [0];
for (const pick of [0, 0.99, 0.5, 0.25]) {
  const result = nextSmartShuffle({ queueLength, currentIndex: played.at(-1), history }, () => pick);
  assert.notEqual(result.index, played.at(-1), 'shuffle should not repeat the current track when alternatives exist');
  assert.equal(played.includes(result.index), false, 'shuffle should not repeat before the bag is exhausted');
  played.push(result.index);
  history = result.history;
}
assert.deepEqual([...played].sort((a, b) => a - b), [0, 1, 2, 3, 4], 'one shuffle cycle should visit every queued position once');

const nextCycle = nextSmartShuffle({ queueLength, currentIndex: played.at(-1), history }, () => 0);
assert.notEqual(nextCycle.index, played.at(-1), 'new shuffle cycles should still avoid immediate repeats');
assert.deepEqual(nextCycle.history, [played.at(-1), nextCycle.index], 'new shuffle cycle should keep only current plus chosen track');

const previous = previousSmartShuffle({ queueLength, currentIndex: nextCycle.index, history: nextCycle.history });
assert.equal(previous.index, played.at(-1), 'previous should follow smart-shuffle history');
assert.deepEqual(previous.history, [played.at(-1)]);

assert.deepEqual(resetSmartShuffleHistory(3, 99), [2], 'history reset should clamp oversized current indices');
assert.equal(nextSmartShuffle({ queueLength: 1, currentIndex: 0, history: [0] }, () => 0.5).index, 0);
assert.equal(nextHandoffIndex({ queueLength: 5, index: 1, mode: 'shuffle' }), null, 'handoff should not guess the wrong next track during shuffle');

const [storeSource, handoffSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/playback-handoff.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(storeSource, /nextSmartShuffle/, 'player store should use smart shuffle for next track selection');
assert.match(storeSource, /previousSmartShuffle/, 'player store should use smart shuffle history for previous track selection');
assert.match(handoffSource, /isShuffleMode\(input\.mode\)/, 'handoff helper should special-case shuffle mode (including shuffle+repeat combos)');
assert.match(packageSource, /smoke:smart-shuffle/, 'package scripts should include smart shuffle smoke');

console.log(JSON.stringify({ ok: true, played, nextCycle, previous }, null, 2));
