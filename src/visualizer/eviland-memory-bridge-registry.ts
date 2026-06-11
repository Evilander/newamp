// Tiny pub-sub registry so the FullscreenVisualizer badge can read whichever
// MemoryBridge is currently driving the on-screen <Visualizer mode="eviland">.
// The bridge is owned by Visualizer.tsx's effect (per-track), so we can't put
// it on a React context without restructuring the effect lifecycle. A module-
// level "active bridge" pointer + a tiny subscribe surface is the cheapest
// correct shape — it matches the pattern eviland-producer.ts uses for its
// activeStop singleton.

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
