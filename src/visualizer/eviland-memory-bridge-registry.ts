// Tiny pub-sub registry so the FullscreenVisualizer badge can read whichever
// MemoryBridge is currently driving the on-screen <Visualizer mode="eviland">.
// The bridge is owned by Visualizer.tsx's effect (per-track), so we can't put
// it on a React context without restructuring the effect lifecycle. A module-
// level "active bridge" pointer + a tiny subscribe surface is the cheapest
// correct shape — it matches the pattern eviland-producer.ts uses for its
// activeStop singleton.
//
// SAME-TRACK REMOUNT SURVIVAL (finding #6 from the pre-release review):
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
import type { MemoryBridge, MemoryBridgeOptions, MemoryBridgeState } from './eviland-memory-bridge';
import { createMemoryBridge as defaultCreateBridge } from './eviland-memory-bridge';

let activeBridge: MemoryBridge | null = null;
const listeners = new Set<(bridge: MemoryBridge | null) => void>();

// trackId → bridge cache. Keys are numeric trackIds; null-trackId bridges are
// never cached (non-library plays are one-shot — they have no row to persist
// to, so caching them across remounts wouldn't help and could lock the badge
// state to a stale "no plan" view).
const bridgesByTrackId = new Map<number, MemoryBridge>();

function notify(): void {
  for (const fn of listeners) {
    try { fn(activeBridge); } catch { /* listener errors must not break publishing */ }
  }
}

/** Publish a freshly-loaded bridge so the badge can subscribe to its state. */
export function publishActiveBridge(bridge: MemoryBridge | null): void {
  activeBridge = bridge;
  notify();
}

/** Get the active bridge, if any. Null when no eviland branch is mounted. */
export function getActiveBridge(): MemoryBridge | null {
  return activeBridge;
}

/** Subscribe to bridge replacements (track-change / mount / unmount). */
export function subscribeActiveBridge(
  listener: (bridge: MemoryBridge | null) => void,
): () => void {
  listeners.add(listener);
  try { listener(activeBridge); } catch { /* swallow */ }
  return () => {
    listeners.delete(listener);
  };
}

// Convenience for components: subscribe to the active bridge's state. Re-binds
// when the active bridge swaps so the consumer doesn't need to manage two
// subscriptions.
export function subscribeActiveBridgeState(
  listener: (state: MemoryBridgeState | null) => void,
): () => void {
  let stateUnsub: (() => void) | null = null;
  const bridgeUnsub = subscribeActiveBridge((bridge) => {
    stateUnsub?.();
    if (!bridge) {
      stateUnsub = null;
      try { listener(null); } catch { /* swallow */ }
      return;
    }
    stateUnsub = bridge.subscribe((s) => {
      try { listener(s); } catch { /* swallow */ }
    });
  });
  return () => {
    bridgeUnsub();
    stateUnsub?.();
  };
}

// ---------------------------------------------------------------------------
// Lineage-evolution routing.
//
// usePlayerStore + the Visualizer's eviland rAF call into these notify* fns
// at play/love/skip/sectionReturn boundaries. Each routes to the active bridge
// IFF its trackId matches the event's trackId — wrong-track events and
// no-bridge events are cheap no-ops. This is the production wiring for the
// 8/32/96/256 generation ladder and the love-tick: the bridge's record*
// methods only fire because of these calls.
//
// The trackId match is the load-bearing guard: a track-end event for the song
// the user just left must NOT advance lineage on the song they just started.
// ---------------------------------------------------------------------------

/** Record a completed play for the given trackId on the active bridge (if it matches). */
export function notifyPlayCompleted(trackId: number | null): void {
  if (trackId == null) return;
  const bridge = activeBridge;
  if (!bridge) return;
  if (bridge.getState().trackId !== trackId) return;
  bridge.recordCompletedPlay();
}

/** Record a love-toggle (on) for the given trackId on the active bridge. */
export function notifyLove(trackId: number | null): void {
  if (trackId == null) return;
  const bridge = activeBridge;
  if (!bridge) return;
  if (bridge.getState().trackId !== trackId) return;
  bridge.recordLove();
}

/** Record a skip for the given trackId on the active bridge. */
export function notifySkip(trackId: number | null): void {
  if (trackId == null) return;
  const bridge = activeBridge;
  if (!bridge) return;
  if (bridge.getState().trackId !== trackId) return;
  bridge.recordSkip();
}

/** Record a section-return for the given trackId on the active bridge. */
export function notifySectionReturn(trackId: number | null): void {
  if (trackId == null) return;
  const bridge = activeBridge;
  if (!bridge) return;
  if (bridge.getState().trackId !== trackId) return;
  bridge.recordSectionReturn();
}

// ---------------------------------------------------------------------------
// Keyed bridge cache (finding #6).
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
// ---------------------------------------------------------------------------

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
  if (existing) return existing;
  const bridge = factory(opts);
  bridgesByTrackId.set(trackId, bridge);
  return bridge;
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
  activeBridge = null;
  listeners.clear();
}
