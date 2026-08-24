import { handoffKey } from './playback-handoff.js';
import { nextSmartShuffle } from './smart-shuffle.js';

/**
 * A speculatively-computed shuffle pick, cached across the gap between the
 * gapless-prepare step (fires up to ~10s before a track ends, see
 * shouldPrepareTrackHandoff) and the actual advance (fires at track end).
 * Both steps must agree on the same track: prepare decodes it into the idle
 * deck ahead of time, and a mismatched commit either wastes that decode
 * (gapless playback silently falls back to a hard cut) or, worse, if the
 * queue mutated underneath a stale index, commits whatever now happens to
 * sit at that position instead of the track that was actually prepared.
 *
 * `baseHistory` pins the cache to the exact shuffleHistory array it was
 * derived from. usePlayerStore never mutates that array in place — every
 * queue edit, mode change, and shuffle pick replaces it wholesale (see
 * resetSmartShuffleHistory's call sites) — so a reference mismatch is a
 * reliable "something changed since this was cached" signal without having
 * to track every invalidating action by hand.
 */
export interface ShuffleHandoffCache {
  key: string;
  baseHistory: number[];
  index: number;
  history: number[];
}

export interface ShuffleHandoffPosition {
  trackId: number;
  index: number;
  queueLength: number;
  history: number[];
}

/**
 * Reuse `cache` if it was already computed for this exact position (same
 * track/index, same underlying history array), otherwise compute and return
 * a fresh pick. Callers persist the return value as the new cache.
 */
export function resolveShuffleHandoffPick(
  cache: ShuffleHandoffCache | null,
  position: ShuffleHandoffPosition,
  random?: () => number,
): ShuffleHandoffCache {
  const key = handoffKey(position.trackId, position.index);
  if (cache && cache.key === key && cache.baseHistory === position.history) return cache;
  const decision = nextSmartShuffle(
    { queueLength: position.queueLength, currentIndex: position.index, history: position.history },
    random,
  );
  return { key, baseHistory: position.history, index: decision.index, history: decision.history };
}

/**
 * Whether `cache` is still safe for an automatic advance away from
 * `position` to consume — computed for this exact (track, index, history),
 * and still pointing inside the current queue. A manual next() never checks
 * this: it always invalidates and picks fresh (see usePlayerStore.ts).
 */
export function isShuffleHandoffCacheValid(
  cache: ShuffleHandoffCache | null,
  position: ShuffleHandoffPosition,
): cache is ShuffleHandoffCache {
  if (!cache) return false;
  if (cache.key !== handoffKey(position.trackId, position.index)) return false;
  if (cache.baseHistory !== position.history) return false;
  return cache.index >= 0 && cache.index < position.queueLength;
}
