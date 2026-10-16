// Keyed bridge cache for the on-screen <Visualizer mode="eviland">. The
// active-bridge pointer, its subscribers and the notify* routing are in
// eviland-active-bridge.ts.
//
// SAME-TRACK REMOUNT SURVIVAL:
// The Visualizer effect deps include palette/quality/performance/reactivity.
// Toggling any of those mid-song re-runs the effect: cleanup fires
// flushAndDispose('unmount') and the new effect immediately constructs a
// fresh bridge + director. React cleanup can't await, so an in-flight flush
// can race the new bridge's loadOrSeed read — losing or double-bridging
// buffered learning. To kill that race we keep the bridge ALIVE in this
// registry, keyed by trackId. The Visualizer asks for the bridge by trackId
// on mount; if one already exists for that track it's re-attached, otherwise
// a fresh one is minted via the factory. On track change the old keyed entry
// is flushed-and-disposed exactly once, then a new entry is created for the
// new track. This means a palette/quality/etc remount is a CHEAP no-op for
// the bridge: same instance, same in-memory state, no IPC round-trip.
import type { MemoryBridge, MemoryBridgeOptions } from './eviland-memory-bridge';
import { createMemoryBridge as defaultCreateBridge } from './eviland-memory-bridge';
import { __resetActiveBridgeForTests, getActiveBridge } from './eviland-active-bridge';

// The startup chunk imports eviland-active-bridge directly; re-exported here
// so the badge, the Visualizer and the tests keep one import for the registry.
export * from './eviland-active-bridge';

// trackId → bridge cache. Keys are numeric trackIds; null-trackId bridges are
// never cached (non-library plays are one-shot — they have no row to persist
// to, so caching them across remounts wouldn't help and could lock the badge
// state to a stale "no plan" view).
const bridgesByTrackId = new Map<number, MemoryBridge>();

// ---------------------------------------------------------------------------
// Keyed bridge cache.
//
// acquireBridgeForTrack:
//   - trackId null → returns a fresh, uncached bridge (non-library play).
//   - trackId has a cached bridge → returns that bridge (re-attached on remount).
//   - otherwise → creates via factory, caches, returns.
//
// releaseBridgeForTrack:
//   - flushAndDispose the cached bridge and drop the cache entry. Use this on
//     true track change or full unmount of the eviland branch.
//
// Both functions are pure registry plumbing; the Visualizer effect owns
// lifecycle (when to acquire, when to release). The activeBridge pointer
// (publishActiveBridge) is updated by the Visualizer as part of acquire, not
// here, so a same-track remount doesn't accidentally re-publish (which would
// emit a needless state event to subscribers).
//
// LRU CAP (leak fix): the Visualizer's cleanup deliberately does NOT call
// releaseBridgeForTrack on unmount (see the same-track-remount survival note
// above) — but that means switching the visualizer MODE away from eviland
// (not a track change, a full unmount) leaves the current track's bridge
// cached with nothing left to ever release it; publishActiveBridge(null)
// fires on that same unmount, so it isn't even the protected "active" entry
// anymore. Repeating mode-switch-away/back cycles across a session orphans
// one bridge per cycle, unbounded. acquireBridgeForTrack sweeps this: the map
// is capped at MAX_CACHED_BRIDGES, and adding a new entry over the cap
// flush-and-disposes the least-recently-acquired entry — skipping the one
// just acquired and whichever bridge is currently published as active — via
// the map's own iteration order (re-inserted to MRU position on every acquire
// of an existing entry, so iteration order IS recency order).
// ---------------------------------------------------------------------------

/** Cached bridges beyond this count get swept on the next acquire. */
export const MAX_CACHED_BRIDGES = 4;

export type MemoryBridgeFactory = (opts: MemoryBridgeOptions) => MemoryBridge;

/**
 * Get or create the bridge for a given trackId. Returns the existing cached
 * bridge if one is already registered for this trackId; otherwise mints one
 * via the supplied factory (defaults to createMemoryBridge) and caches it.
 */
export function acquireBridgeForTrack(
  opts: MemoryBridgeOptions,
  factory: MemoryBridgeFactory = defaultCreateBridge,
): MemoryBridge {
  const { trackId } = opts;
  if (trackId == null) return factory(opts);
  const existing = bridgesByTrackId.get(trackId);
  if (existing) {
    // Re-insert to bump this entry to the MRU (last) position — Map iteration
    // order is insertion order, so this is what makes iteration order double
    // as recency order for the LRU sweep below.
    bridgesByTrackId.delete(trackId);
    bridgesByTrackId.set(trackId, existing);
    return existing;
  }
  const bridge = factory(opts);
  bridgesByTrackId.set(trackId, bridge);
  evictLruIfOverCap(trackId);
  return bridge;
}

/**
 * Flush-and-dispose the least-recently-acquired cached bridge when the cache
 * is over MAX_CACHED_BRIDGES, protecting `skipTrackId` (the entry that just
 * triggered this sweep) and the currently-published active bridge (the one
 * driving a mounted, on-screen visualizer). Fire-and-forget, same as
 * releaseBridgeForTrack's track-change path — eviction must never block
 * acquireBridgeForTrack. Evicts at most one entry per call; if every cached
 * entry is protected the cache stays over cap until the next acquire.
 */
function evictLruIfOverCap(skipTrackId: number): void {
  if (bridgesByTrackId.size <= MAX_CACHED_BRIDGES) return;
  const activeTrackId = getActiveBridge()?.getState().trackId ?? null;
  for (const [trackId, bridge] of bridgesByTrackId) {
    if (trackId === skipTrackId) continue;
    if (activeTrackId != null && trackId === activeTrackId) continue;
    bridgesByTrackId.delete(trackId);
    void bridge.flushAndDispose('unmount').catch(() => false);
    return;
  }
}

/**
 * Flush + dispose the cached bridge for this trackId and drop it from the
 * cache. Returns the dispose promise so callers can await persistence (the
 * track-change path does NOT await; the unmount path may).
 *
 * If the trackId is null or no bridge is cached, this is a cheap no-op.
 */
export function releaseBridgeForTrack(
  trackId: number | null,
  reason: 'track-change' | 'unmount' = 'unmount',
): Promise<boolean> {
  if (trackId == null) return Promise.resolve(false);
  const cached = bridgesByTrackId.get(trackId);
  if (!cached) return Promise.resolve(false);
  bridgesByTrackId.delete(trackId);
  // flushAndDispose is idempotent + returns false if there's nothing to write.
  return cached.flushAndDispose(reason).catch(() => false);
}

/** Drop a bridge from the keyed cache WITHOUT flushing (badge reset path). */
export function dropBridgeForTrack(trackId: number | null): void {
  if (trackId == null) return;
  bridgesByTrackId.delete(trackId);
}

/** Test-only: reset the keyed cache. Production code never calls this. */
export function __resetBridgeRegistryForTests(): void {
  bridgesByTrackId.clear();
  __resetActiveBridgeForTests();
}
