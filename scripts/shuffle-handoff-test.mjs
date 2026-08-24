import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  resolveShuffleHandoffPick,
  isShuffleHandoffCacheValid,
} from '../dist-electron/shared/shuffle-handoff.js';
import {
  hasHandoffTarget,
  nextHandoffIndex,
  shouldPrepareTrackHandoff,
  shouldStartTrackHandoff,
} from '../dist-electron/shared/playback-handoff.js';
import { nextSmartShuffle } from '../dist-electron/shared/smart-shuffle.js';

// Regression test for finding #19: shuffle mode got neither crossfade nor
// gapless pre-buffering because nextHandoffIndex returned null for every
// shuffle variant, so shouldPrepareTrackHandoff/shouldStartTrackHandoff
// never fired at all. The fix adds a separate eligibility check
// (hasHandoffTarget) plus a store-side cache (shared/shuffle-handoff.ts) so
// the speculative prepare and the eventual commit agree on the same track.

// --- (c) hasHandoffTarget / shouldPrepareTrackHandoff / shouldStartTrackHandoff:
// shuffle is now eligible, repeat-one still blocks it (with or without
// shuffle), and the pre-existing sequential/repeat-all contract is
// untouched.

assert.equal(hasHandoffTarget({ queueLength: 5, index: 1, mode: 'shuffle' }), true, 'plain shuffle should now be eligible for a handoff');
assert.equal(hasHandoffTarget({ queueLength: 4, index: 3, mode: 'shuffle-repeat-all' }), true, 'shuffle-repeat-all should be eligible even at the tail (smart-shuffle resets its bag)');
assert.equal(hasHandoffTarget({ queueLength: 5, index: 2, mode: 'repeat-one' }), false, 'repeat-one has no handoff target');
assert.equal(hasHandoffTarget({ queueLength: 5, index: 2, mode: 'shuffle-repeat-one' }), false, 'repeat-one must still block a handoff even under shuffle');
assert.equal(hasHandoffTarget({ queueLength: 1, index: 0, mode: 'shuffle' }), false, 'a single-track queue has nowhere to hand off to');
// Sequential/repeat-all is unchanged: hasHandoffTarget agrees with
// nextHandoffIndex whenever the latter resolves a real index.
assert.equal(nextHandoffIndex({ queueLength: 4, index: 3, mode: 'repeat-all' }), 0);
assert.equal(hasHandoffTarget({ queueLength: 4, index: 3, mode: 'repeat-all' }), true);
assert.equal(nextHandoffIndex({ queueLength: 4, index: 3, mode: 'normal' }), null);
assert.equal(hasHandoffTarget({ queueLength: 4, index: 3, mode: 'normal' }), false, 'plain mode at the tail (no repeat) has no handoff target either');
// nextHandoffIndex itself keeps its pre-existing shuffle-blind contract —
// it is never asked to guess a specific shuffle index (see smart-shuffle-smoke.mjs).
assert.equal(nextHandoffIndex({ queueLength: 5, index: 1, mode: 'shuffle' }), null);
assert.equal(nextHandoffIndex({ queueLength: 4, index: 3, mode: 'shuffle-repeat-all' }), null);

const baseInput = {
  playing: true,
  duration: 240,
  currentTime: 232.5,
  crossfadeMs: 0,
  queueLength: 5,
  index: 2,
  currentTrackId: 10,
  lastHandoffKey: null,
};

assert.equal(
  shouldPrepareTrackHandoff({ ...baseInput, mode: 'shuffle' }),
  true,
  'gapless prepare should now fire in shuffle mode (this is finding #19)',
);
assert.equal(
  shouldPrepareTrackHandoff({ ...baseInput, mode: 'shuffle-repeat-one' }),
  false,
  'repeat-one must still block gapless prepare even under shuffle',
);
assert.equal(
  shouldStartTrackHandoff({ ...baseInput, mode: 'shuffle', crossfadeMs: 4000, currentTime: 236.2 }),
  true,
  'crossfade should now start in shuffle mode (this is finding #19)',
);
assert.equal(
  shouldStartTrackHandoff({ ...baseInput, mode: 'shuffle-repeat-one', crossfadeMs: 4000, currentTime: 236.2 }),
  false,
  'repeat-one must still block the crossfade start even under shuffle',
);

// --- (a) prepare and commit agree on the same track across a normal advance.
//
// Model the two moments as two separate calls into the pure cache API,
// exactly as usePlayerStore does: the prepare branch calls
// resolveShuffleHandoffPick once (~10s before the track ends) and stores
// the result; autoAdvance(), at the real end of the track, re-validates
// with isShuffleHandoffCacheValid and — if valid — consumes the SAME
// object, never re-rolling nextSmartShuffle.
{
  const history = [2];
  const position = { trackId: 10, index: 2, queueLength: 5, history };

  const prepared = resolveShuffleHandoffPick(null, position, () => 0.5);
  assert.ok(prepared.index >= 0 && prepared.index < 5, 'prepared pick must be a valid queue index');
  assert.notEqual(prepared.index, 2, 'prepared pick should not repeat the currently-playing index');

  // Nothing about the position changed by the time the track actually
  // ends — the cache must still validate.
  assert.equal(isShuffleHandoffCacheValid(prepared, position), true, 'a pick computed for this exact position must still be valid at commit time');

  // Re-entering the prepare branch again before commit (the engine tick
  // fires repeatedly inside the prepare window) must reuse the exact same
  // object rather than re-rolling, even with a different random source —
  // this is the literal "prepare and commit must agree" guarantee.
  const preparedAgain = resolveShuffleHandoffPick(prepared, position, () => 0.999);
  assert.equal(preparedAgain, prepared, 'a still-valid cache must be reused verbatim, not rerolled on a later prepare tick');

  // The commit path only ever needs prepared.index/prepared.history — prove
  // that index actually addresses the track that was decoded ahead of time
  // by construction (resolveShuffleHandoffPick and the store's prepare
  // branch both read state.queue[cache.index]).
  const queue = ['t0', 't1', 't2', 't3', 't4'];
  assert.equal(typeof queue[prepared.index], 'string', 'the cached index must address a real queue slot');
}

// --- (b) the cached pick is invalidated when the queue changes underneath it.
{
  const history = [2];
  const position = { trackId: 10, index: 2, queueLength: 5, history };
  const prepared = resolveShuffleHandoffPick(null, position, () => 0.5);

  // usePlayerStore never mutates shuffleHistory in place — every queue
  // edit (add/remove/move/AutoDJ refill-with-reset) and every mode change
  // reassigns it via resetSmartShuffleHistory, producing a NEW array even
  // when the resulting contents are unchanged. Model that here: same
  // values, different reference.
  const mutatedHistorySameValues = [2];
  assert.notEqual(mutatedHistorySameValues, history, 'sanity: the two history arrays must not be reference-equal');
  assert.equal(
    isShuffleHandoffCacheValid(prepared, { trackId: 10, index: 2, queueLength: 5, history: mutatedHistorySameValues }),
    false,
    'a queue mutation that reassigns shuffleHistory must invalidate the cache even if the resulting array looks the same',
  );

  // A track was removed from the queue, shrinking it below the prepared
  // index. Even a stale cache that (by coincidence) still carried the
  // original history reference must not be reused once its index no
  // longer addresses a real slot — this is the "silently commits the
  // wrong track" failure mode a raw index-only cache would have.
  const shrunkQueueLength = prepared.index; // queue now ends exactly before the prepared slot
  assert.equal(
    isShuffleHandoffCacheValid(prepared, { trackId: 10, index: 2, queueLength: shrunkQueueLength, history }),
    false,
    'a cache whose index no longer fits the current queue length must not be reused',
  );

  // Position itself moved on (natural advance, or the user navigated away
  // and back) — key mismatch invalidates regardless of history/queue length.
  assert.equal(
    isShuffleHandoffCacheValid(prepared, { trackId: 10, index: 3, queueLength: 5, history }),
    false,
    'a cache computed for a different index must not be reused',
  );
  assert.equal(
    isShuffleHandoffCacheValid(prepared, { trackId: 11, index: 2, queueLength: 5, history }),
    false,
    'a cache computed for a different track id must not be reused',
  );

  // A brand-new prepare call after invalidation must compute fresh rather
  // than reuse the stale object.
  const repositionedHistory = [2];
  const fresh = resolveShuffleHandoffPick(prepared, { trackId: 10, index: 2, queueLength: 5, history: repositionedHistory }, () => 0.5);
  assert.notEqual(fresh, prepared, 'an invalidated cache must be recomputed, not returned verbatim');
}

// --- (d) a manual next() during a prepared handoff does not play the wrong track.
//
// usePlayerStore.next() unconditionally clears cachedShuffleHandoff before
// computing anything (see the source assertions below) — a manual skip
// never reads a background pick at all, so it can never inherit one that
// went stale relative to the CURRENT queue. Prove the consequence directly:
// simulate "prepare fired, then the queue mutated, then the user manually
// hit next before autoAdvance ever got a chance to consume the cache" and
// show the only path available (a fresh nextSmartShuffle against the
// live/current position) always lands inside the live queue, never at the
// stale prepared index.
{
  const originalHistory = [2];
  const originalPosition = { trackId: 10, index: 2, queueLength: 5, history: originalHistory };
  const prepared = resolveShuffleHandoffPick(null, originalPosition, () => 0.9);

  // Queue shrinks from 5 to 3 (two tracks removed ahead of the current
  // one) — shuffleHistory is reassigned by the mutation, and the prepared
  // index may now be completely out of range.
  const mutatedHistory = [2 % 3];
  const liveQueueLength = 3;

  // next() (manual path): cache is discarded unconditionally, so it never
  // even reaches a validity check — it goes straight to a fresh pick
  // against the CURRENT (mutated) position, exactly like non-shuffle next()
  // always has.
  const manualPick = nextSmartShuffle(
    { queueLength: liveQueueLength, currentIndex: 2 % liveQueueLength, history: mutatedHistory },
    () => 0.9,
  );
  assert.ok(manualPick.index >= 0 && manualPick.index < liveQueueLength, 'a manual next() must always land inside the live queue');

  // Confirm the stale prepared pick would NOT have been safe to use
  // directly — this is exactly why next() cannot just trust it.
  assert.equal(
    isShuffleHandoffCacheValid(prepared, { trackId: 10, index: 2, queueLength: liveQueueLength, history: mutatedHistory }),
    false,
    'the pre-mutation cache must be invalid against the post-mutation position, confirming next() is right to never consult it',
  );
}

// --- Source assertions: prove the store actually wires the above
// mechanism into next()/autoAdvance()/the prepare branch, not just that
// the pure helpers exist in isolation.
const [storeSource, handoffSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/playback-handoff.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(handoffSource, /export function hasHandoffTarget/, 'playback-handoff should expose the shuffle-eligible gate');
assert.match(storeSource, /import\s*\{\s*\n\s*isShuffleHandoffCacheValid,\s*\n\s*resolveShuffleHandoffPick,/, 'store should import the shuffle handoff cache helpers');

// The prepare branch must actually call resolveShuffleHandoffPick under
// isShuffleMode, not just recompute the sequential index for every mode.
// (isShuffleMode(state.mode) also appears, unrelated, inside
// advanceAfterPlaybackError, so anchor on the literal cache-write line
// itself rather than a loose regex that could match the wrong block.)
assert.ok(
  storeSource.includes('cachedShuffleHandoff = resolveShuffleHandoffPick(cachedShuffleHandoff, {'),
  'the gapless-prepare branch should cache a shuffle pick via resolveShuffleHandoffPick',
);
assert.ok(
  storeSource.includes("if (isShuffleMode(state.mode)) {\r\n          // Cache the pick so autoAdvance() commits the exact track decoded") ||
    storeSource.includes("if (isShuffleMode(state.mode)) {\n          // Cache the pick so autoAdvance() commits the exact track decoded"),
  'the cache write should be gated on isShuffleMode inside the prepare branch specifically',
);

// autoAdvance must gate on isShuffleHandoffCacheValid before consuming the
// cache, and must fall through to next() (which invalidates) otherwise.
assert.match(storeSource, /async function autoAdvance\(/, 'store should define the cache-aware automatic-advance path');
assert.match(storeSource, /isShuffleHandoffCacheValid\(cachedShuffleHandoff, \{/, 'autoAdvance should validate the cache before trusting it');
assert.ok(
  storeSource.includes('cachedShuffleHandoff = null;\r\n  await getState().next();') ||
    storeSource.includes('cachedShuffleHandoff = null;\n  await getState().next();'),
  'autoAdvance should invalidate and fall through to the normal next() when no valid cache exists',
);

// Every automatic call site must route through autoAdvance, not a bare next().
const autoAdvanceCallCount = (storeSource.match(/void autoAdvance\(get, set\)/g) || []).length;
assert.equal(autoAdvanceCallCount, 3, 'all three automatic advance sites (cued-segment end, crossfade start, natural end) should route through autoAdvance');
assert.doesNotMatch(storeSource, /void state\.next\(\)/, 'the crossfade-start branch should no longer call next() directly (it must go through autoAdvance so a valid cache can be consumed)');

// next() itself must unconditionally clear the cache before computing —
// this is the entire proof behind requirement (d) above. Anchor on the
// literal opening of the action so this cannot match some other, unrelated
// "cachedShuffleHandoff = null" reset (e.g. inside autoAdvance itself).
const nextActionStart = storeSource.indexOf('next: async () => {');
assert.ok(nextActionStart >= 0, 'store should still define a next() action');
const nextActionOpening = storeSource.slice(nextActionStart, nextActionStart + 600);
assert.match(nextActionOpening, /clearPlaybackErrorAdvanceTimer\(\);\s*\r?\n\s*const state = get\(\);\s*\r?\n\s*recordManualSkip\(state\);/, 'next() should keep its existing manual-skip bookkeeping');
assert.match(nextActionOpening, /cachedShuffleHandoff = null;/, 'next() should unconditionally invalidate the shuffle handoff cache before computing a fresh pick');
assert.match(nextActionOpening, /const \{ queue, index, mode, shuffleHistory \} = state;/, 'the cache invalidation should happen before next() reads queue/index/mode for its own fresh pick');

assert.match(packageSource, /"test:shuffle-handoff"/, 'package.json should expose the shuffle handoff regression test');

console.log(JSON.stringify({ ok: true }, null, 2));
