// Pure queue helpers: shuffle cycles that end, history carried across queue edits,
// the playback-error stop rules, and the starter queue Play builds from nothing.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export * from './shared/smart-shuffle';
      export * from './shared/playback-handoff';
      export * from './shared/playback-error';
      export * from './shared/queue-insert';
      export * from './src/lib/today-pick';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const seeded = (seed = 7) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// ---- a shuffle cycle visits every track once, then reports it is exhausted ----
{
  const random = seeded();
  let history = m.resetSmartShuffleHistory(5, 2);
  let current = 2;
  const visited = [2];
  for (let step = 0; step < 4; step += 1) {
    const next = m.nextSmartShuffle({ queueLength: 5, currentIndex: current, history }, random);
    assert.equal(next.exhausted, false, 'picks inside a cycle are not exhausted');
    visited.push(next.index);
    current = next.index;
    history = next.history;
  }
  assert.deepEqual([...visited].sort(), [0, 1, 2, 3, 4], 'one cycle covers the whole queue');
  assert.equal(m.isShuffleCycleComplete(history, 5, current), true);
  const wrapped = m.nextSmartShuffle({ queueLength: 5, currentIndex: current, history }, random);
  assert.equal(wrapped.exhausted, true, 'the pick after the last track opens a new cycle');
  assert.deepEqual(wrapped.history, [current, wrapped.index], 'the new cycle keeps only the current track and the pick');
  assert.equal(m.nextSmartShuffle({ queueLength: 1, currentIndex: 0, history: [0] }).exhausted, true, 'a single track is exhausted after one play');
  assert.equal(m.nextSmartShuffle({ queueLength: 0, currentIndex: -1, history: [] }).exhausted, true);
}

// ---- the pick after the playing track left a shuffle ----
{
  for (let seed = 1; seed <= 20; seed += 1) {
    const pick = m.smartShuffleAfterRemoval({ queueLength: 5, history: [2, 0] }, seeded(seed));
    assert.ok([1, 3, 4].includes(pick.index), `seed ${seed} picked ${pick.index}`);
    assert.equal(pick.exhausted, false);
    assert.deepEqual(pick.history, [2, 0, pick.index]);
  }
  const lastOne = m.smartShuffleAfterRemoval({ queueLength: 4, history: [0, 1, 3] }, () => 0);
  assert.deepEqual(lastOne, { index: 2, history: [0, 1, 3, 2], exhausted: false }, 'the one unplayed track is the pick');
  for (let seed = 1; seed <= 20; seed += 1) {
    const reopened = m.smartShuffleAfterRemoval({ queueLength: 3, history: [1, 0, 2] }, seeded(seed));
    assert.equal(reopened.exhausted, true, 'everything played: a new cycle');
    assert.notEqual(reopened.index, 2, 'it does not repeat the track that played last');
    assert.deepEqual(reopened.history, [reopened.index]);
  }
  assert.deepEqual(m.smartShuffleAfterRemoval({ queueLength: 1, history: [0] }), { index: 0, history: [0], exhausted: true });
  assert.deepEqual(m.smartShuffleAfterRemoval({ queueLength: 0, history: [] }), { index: -1, history: [], exhausted: true });
  const noisy = m.smartShuffleAfterRemoval({ queueLength: 3, history: [7, 1, 1, -2, Number.NaN] }, () => 0);
  assert.deepEqual(noisy, { index: 0, history: [1, 0], exhausted: false }, 'out-of-range and repeated entries are ignored');
}

// ---- cycle bookkeeping ----
{
  assert.equal(m.isShuffleCycleComplete([0, 1], 3, 1), false, 'a short history cannot be complete');
  assert.equal(m.isShuffleCycleComplete([], 3, 0), false);
  assert.equal(m.isShuffleCycleComplete([2, 0, 1], 3, 1), true);
  assert.equal(m.isShuffleCycleComplete([1, 1, 1], 3, 1), false, 'duplicates do not count as played');
  assert.equal(m.shuffleUnplayedCount([4, 0, 2], 6, 2), 3);
  assert.equal(m.shuffleUnplayedCount([], 6, 0), 5, 'the current track counts as played');
  assert.equal(m.shuffleUnplayedCount([0, 1, 2], 3, 2), 0);
}

// ---- history survives queue edits: insert, append, move, remove ----
{
  const history = [4, 0, 2];
  assert.deepEqual(m.remapShuffleHistory(history, m.insertionIndexMap(3, 1)), [5, 0, 2], 'insert shifts only what sits at or after the splice');
  assert.deepEqual(m.remapShuffleHistory(history, m.insertionIndexMap(1, 2)), [6, 0, 4], 'a group insert shifts by its size');
  assert.deepEqual(m.remapShuffleHistory(history, m.insertionIndexMap(6, 2)), [4, 0, 2], 'appending leaves played positions alone');
  assert.deepEqual(m.remapShuffleHistory(history, m.moveIndexMap(6, 0, 5)), [3, 5, 1], 'moving the first track to the end shifts the rest down');
  assert.deepEqual(m.remapShuffleHistory(history, m.moveIndexMap(6, 5, 1)), [5, 0, 3], 'moving the last track up shifts the rest along');
  assert.deepEqual(m.remapShuffleHistory(history, m.moveIndexMap(6, 3, 3)), [4, 0, 2], 'a move onto itself is a no-op');
  assert.deepEqual(m.remapShuffleHistory(history, m.removeIndexMap(6, 3)), [3, 0, 2]);
  assert.deepEqual(m.remapShuffleHistory(history, m.removeIndexMap(6, 4)), [0, 2], 'a removed track leaves the history');
  assert.deepEqual(m.remapShuffleHistory([4, 0, 2], m.removalIndexMap(6, [0, 5])), [3, 1], 'removing several maps each survivor');
  const before = [1, 2];
  const after = m.remapShuffleHistory(before, (i) => i);
  assert.notEqual(after, before, 'the result is a new array, which invalidates a cached handoff pick');
  assert.deepEqual(m.remapShuffleHistory([9, -1, Number.NaN, 2], (i) => i), [9, 2], 'junk entries are dropped');
}

// ---- a 20k-track remap is linear ----
{
  const length = 20000;
  const history = Array.from({ length: length - 1 }, (_, i) => i);
  const started = performance.now();
  const remapped = m.remapShuffleHistory(history, m.removalIndexMap(length, [0, 10, 19999]));
  const elapsed = performance.now() - started;
  assert.equal(remapped.length, length - 3);
  assert.ok(elapsed < 250, `remapping ${length} played tracks took ${elapsed.toFixed(0)}ms`);
}

// ---- handoff has no target once a repeat-off shuffle has played everything ----
{
  const base = { queueLength: 4, index: 1 };
  assert.equal(m.hasHandoffTarget({ ...base, mode: 'shuffle' }), true);
  assert.equal(m.hasHandoffTarget({ ...base, mode: 'shuffle', shuffleCycleComplete: true }), false, 'repeat off: the cycle is over');
  assert.equal(m.hasHandoffTarget({ ...base, mode: 'shuffle-repeat-all', shuffleCycleComplete: true }), true, 'repeat all starts another cycle');
  assert.equal(m.hasHandoffTarget({ ...base, mode: 'shuffle-repeat-one', shuffleCycleComplete: true }), false);
  assert.equal(m.hasHandoffTarget({ ...base, mode: 'repeat-all', index: 3, shuffleCycleComplete: true }), true, 'the flag only matters in shuffle');
  const input = {
    playing: true, duration: 240, currentTime: 232.5, crossfadeMs: 0, queueLength: 4, index: 1,
    currentTrackId: 10, lastHandoffKey: null, mode: 'shuffle',
  };
  assert.equal(m.shouldPrepareTrackHandoff(input), true);
  assert.equal(m.shouldPrepareTrackHandoff({ ...input, shuffleCycleComplete: true }), false, 'no gapless prepare at the end of a cycle');
  assert.equal(
    m.shouldStartTrackHandoff({ ...input, crossfadeMs: 4000, currentTime: 236.2, shuffleCycleComplete: true }),
    false,
    'no crossfade at the end of a cycle',
  );
}

// ---- playback errors stop at the end of a shuffle cycle and after a run of failures ----
{
  const base = { error: 'Audio error (code 4)', currentTrackId: 42, index: 1, queueLength: 6, lastErrorKey: null };
  const key = '42:1:Audio error (code 4)';
  assert.deepEqual(
    m.resolvePlaybackErrorAdvance({ ...base, mode: 'shuffle' }),
    { key, shouldAdvance: true, shouldStop: false },
    'existing decisions keep their exact shape',
  );
  assert.deepEqual(
    m.resolvePlaybackErrorAdvance({ ...base, mode: 'shuffle', shuffleCycleComplete: true }),
    { key, shouldAdvance: false, shouldStop: true },
    'a failed last track of a repeat-off shuffle ends the queue',
  );
  assert.equal(m.resolvePlaybackErrorAdvance({ ...base, mode: 'shuffle-repeat-all', shuffleCycleComplete: true }).shouldAdvance, true);
  assert.equal(m.playbackFailureLimit(20), 8);
  assert.equal(m.playbackFailureLimit(3), 3);
  assert.equal(m.playbackFailureLimit(0), 1);
  const noGiveUp = m.resolvePlaybackErrorAdvance({ ...base, mode: 'repeat-all', consecutiveFailures: 6, queueLength: 20 });
  assert.equal(noGiveUp.shouldAdvance, true, 'the seventh failure still moves on');
  const gaveUp = m.resolvePlaybackErrorAdvance({ ...base, mode: 'repeat-all', consecutiveFailures: 7, queueLength: 20 });
  assert.deepEqual(gaveUp, { key, shouldAdvance: false, shouldStop: true, gaveUp: true }, 'the eighth failure in a row gives up');
  const small = m.resolvePlaybackErrorAdvance({ ...base, mode: 'repeat-all', consecutiveFailures: 2, queueLength: 3 });
  assert.equal(small.gaveUp, true, 'a three-track queue gives up once every track has failed');
}

// ---- Play Next's insertion point is shared with the history remap ----
{
  assert.equal(m.playNextInsertAt(6, 2), 3);
  assert.equal(m.playNextInsertAt(6, -1), 0, 'an idle queue inserts at the front');
  assert.equal(m.playNextInsertAt(0, 0), 0);
}

// ---- starter queue ----
{
  const track = (id, extra = {}) => ({ id, title: `T${id}`, artist: 'A', album: 'B', rating: 0, ratingScore: null, lastPlayed: null, avoidAutoPlay: 0, missingSince: null, ...extra });
  assert.equal(m.starterQueueNeeded({ startIndex: -1, libraryRootCount: 1, pending: false }), true);
  assert.equal(m.starterQueueNeeded({ startIndex: -1, libraryRootCount: 0, pending: false }), false, 'no library: stay silent');
  assert.equal(m.starterQueueNeeded({ startIndex: 0, libraryRootCount: 1, pending: false }), false, 'something is already loaded');
  assert.equal(m.starterQueueNeeded({ startIndex: -1, libraryRootCount: 1, pending: true }), false, 'a request in flight is not asked twice');

  const now = Date.UTC(2026, 9, 11);
  const rated = [track(1, { rating: 5, ratingScore: 100, lastPlayed: now - 90 * 86400000 }), track(2, { rating: 4, ratingScore: 80, lastPlayed: now - 86400000 })];
  const pick = m.pickToday(rated, [], null, now);
  assert.equal(pick.track.id, 1, 'a top-rated track not played in a month wins');
  assert.equal(pick.reason, 'Top-rated · hasn\'t played in 13 weeks');
  assert.equal(m.pickToday([], [], null, now), null);
  assert.equal(m.pickToday(rated, [], 1, now).reason, 'Top-rated · currently loaded', 'with nothing else qualifying, the loaded track is labelled as such');

  const candidates = Array.from({ length: 80 }, (_, i) => track(i + 1, i === 4 ? { missingSince: 5 } : i === 5 ? { avoidAutoPlay: 1 } : {}));
  const queue = m.buildStarterQueue(candidates, rated[0], seeded(), 50);
  assert.equal(queue.length, 50, 'capped at the starter size');
  assert.equal(queue[0].id, 1, 'a rated pick opens the queue');
  assert.equal(new Set(queue.map((t) => t.id)).size, 50, 'no duplicates');
  assert.ok(!queue.some((t) => t.id === 5 || t.id === 6), 'missing and opted-out tracks never start a queue');
  assert.notDeepEqual(queue.slice(1, 6).map((t) => t.id), [2, 3, 4, 7, 8], 'the rest is shuffled');
  const unrated = m.buildStarterQueue(candidates, track(70), seeded(), 10);
  assert.equal(unrated.length, 10);
  assert.ok(!unrated.some((t) => t.id === 5 || t.id === 6), 'an unrated pick leads nothing, but the filters still apply');
  assert.deepEqual(m.buildStarterQueue([], null), []);

  assert.equal(m.starterQueueLead(rated[0]), rated[0], 'a rated pick leads');
  assert.equal(m.starterQueueLead(track(70)), null, 'an unrated fallback does not');
  assert.equal(m.starterQueueLead(track(70, { rating: 3 })).id, 70, 'a star rating counts without a score');
  assert.equal(m.starterQueueLead(track(70, { rating: 5, avoidAutoPlay: 1 })), null);
  assert.equal(m.starterQueueLead(track(70, { rating: 5, missingSince: 5 })), null);
  assert.equal(m.starterQueueLead(null), null);
  // A random that swaps nothing leaves the unrated pick first in the shuffle; it still is not the lead.
  const keepOrder = m.buildStarterQueue(candidates, candidates[0], () => 0.999, 10);
  assert.equal(keepOrder[0].id, 1);
  assert.equal(m.starterQueueLead(candidates[0]), null);
}

console.log('PASS queue helpers: shuffle cycles, history remap, error stop rules, starter queue');
