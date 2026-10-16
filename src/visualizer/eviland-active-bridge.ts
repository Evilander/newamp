// Tiny pub-sub registry so the FullscreenVisualizer badge can read whichever
// MemoryBridge is currently driving the on-screen <Visualizer mode="eviland">.
// The bridge is owned by Visualizer.tsx's effect (per-track), so we can't put
// it on a React context without restructuring the effect lifecycle. A module-
// level "active bridge" pointer + a tiny subscribe surface is the cheapest
// correct shape — it matches the pattern eviland-producer.ts uses for its
// activeStop singleton.
//
// This half of the bridge registry is what usePlayerStore reaches at startup
// (the notify* calls below), so it imports no bridge code, only its types. The
// keyed bridge cache that needs createMemoryBridge is in
// eviland-memory-bridge-registry.ts, which re-exports all of this.
import type { MemoryBridge, MemoryBridgeState } from './eviland-memory-bridge';

let activeBridge: MemoryBridge | null = null;
const listeners = new Set<(bridge: MemoryBridge | null) => void>();

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

/** Test-only: forget the active bridge and every listener. Production code never calls this. */
export function __resetActiveBridgeForTests(): void {
  activeBridge = null;
  listeners.clear();
}
