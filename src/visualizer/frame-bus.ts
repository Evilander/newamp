// Eviland frame fan-out + cross-window port bridge.
//
// One reactor produces frames in the main renderer; this bus distributes them
// to (a) zero or more local listeners (e.g. the on-screen <Visualizer/>) and
// (b) the detached visualizer window via a MessageChannelMain port wired by
// the Electron main process.
//
// INTEGRATOR HOOK (Visualizer.tsx, eviland branch — owned by the integrator,
// NOT added by this module's author):
//
//   import { frameBus } from '../visualizer/frame-bus';
//   // After: const evFrame = reactor.analyze(...);
//   frameBus.publish(evFrame, palette, dtMs);
//
// Until that one-line call is added, the detached window will stay black —
// that is expected. This module deliberately does no audio or rendering on its
// own; it is pure plumbing.
//
// Backpressure: drop-newest with at most MAX_INFLIGHT frames outstanding to
// the detached consumer. A stuck detached window must never block the main
// rAF loop. ACKs from the consumer release the inflight slot.
//
// Cloning rule: EvilandFrame.bands is a reused Float32Array and
// EvilandFrame.onsets reuses pooled objects. postMessage uses the
// structured-clone algorithm, which deep-copies both — safe across the port,
// but DO NOT stash a reference to the frame and re-post it later. Pass the
// frame straight into publish() each tick.

import type { EvilandFrame } from './eviland-audio';
import type { EvilandPalette } from './eviland';
import type { OperatorConfig } from './eviland-operators';

export type EvilandFrameListener = (
  frame: EvilandFrame,
  palette: EvilandPalette,
  dtMs: number,
) => void;

export interface DetachedFramePayload {
  /** performance.now() at send time. Echoed back as the ack id. */
  t: number;
  frame: EvilandFrame;
  palette: EvilandPalette;
  dtMs: number;
  /**
   * Operator config the consumer should render with. Carries the headless
   * producer's Director/manual look across to the detached window so the
   * projector is choreographed, not the renderer's flat default. Omitted when
   * the producer has no opinion (the consumer then keeps its last config).
   */
  operator?: OperatorConfig;
  /** Sent only on change; the consumer reapplies on each tick. */
  config?: {
    quality?: 'high' | 'medium' | 'low';
  };
}

export interface DetachedAckPayload {
  type: 'ack';
  t: number;
}

export interface FrameBus {
  subscribe(fn: EvilandFrameListener): () => void;
  publish(frame: EvilandFrame, palette: EvilandPalette, dtMs: number, operator?: OperatorConfig): void;
  hasDetachedConsumer(): boolean;
  onConsumerChange(cb: (hasDetached: boolean) => void): () => void;
  attachDetachedPort(port: MessagePort): void;
  detachPort(): void;
  /** Push a quality change to the detached consumer on the next frame. */
  setDetachedQuality(quality: 'high' | 'medium' | 'low'): void;
}

const MAX_INFLIGHT = 3;

interface BusState {
  listeners: Set<EvilandFrameListener>;
  consumerChange: Set<(hasDetached: boolean) => void>;
  port: MessagePort | null;
  inflight: number;
  quality: 'high' | 'medium' | 'low' | null;
  qualityDirty: boolean;
  seq: number;
}

const state: BusState = {
  listeners: new Set(),
  consumerChange: new Set(),
  port: null,
  inflight: 0,
  quality: null,
  qualityDirty: false,
  seq: 0,
};

function notifyConsumerChange(): void {
  const has = state.port !== null;
  for (const cb of state.consumerChange) {
    try {
      cb(has);
    } catch (err) {
      console.error('[frame-bus] consumer-change listener threw', err);
    }
  }
}

export const frameBus: FrameBus = {
  subscribe(fn) {
    state.listeners.add(fn);
    return () => {
      state.listeners.delete(fn);
    };
  },

  publish(frame, palette, dtMs, operator) {
    // Cheap early-out: when nothing is listening (no on-screen subscriber and
    // no detached window) publish is a no-op. Fires up to 60x/s otherwise.
    if (state.listeners.size === 0 && !state.port) return;
    // Local consumers first. A listener throwing must not prevent IPC fan-out.
    for (const listener of state.listeners) {
      try {
        listener(frame, palette, dtMs);
      } catch (err) {
        console.error('[frame-bus] local listener threw', err);
      }
    }
    const port = state.port;
    if (!port) return;
    if (state.inflight >= MAX_INFLIGHT) return; // drop-newest backpressure

    const payload: DetachedFramePayload = {
      t: ++state.seq,
      frame,
      palette,
      dtMs,
    };
    if (operator) payload.operator = operator;
    if (state.qualityDirty && state.quality) {
      payload.config = { quality: state.quality };
      state.qualityDirty = false;
    }
    state.inflight++;
    try {
      port.postMessage(payload);
    } catch (err) {
      // The port can be closed mid-frame if the detached window crashed or
      // was destroyed between attach and post. Roll back the inflight count
      // and tear down the port so the next publish doesn't try again.
      state.inflight = Math.max(0, state.inflight - 1);
      console.error('[frame-bus] postMessage failed; detaching port', err);
      frameBus.detachPort();
    }
  },

  hasDetachedConsumer() {
    return state.port !== null;
  },

  onConsumerChange(cb) {
    state.consumerChange.add(cb);
    return () => {
      state.consumerChange.delete(cb);
    };
  },

  attachDetachedPort(port) {
    if (state.port === port) return;
    if (state.port) {
      try {
        state.port.close();
      } catch {
        /* ignore */
      }
    }
    state.port = port;
    state.inflight = 0;
    // On reattach, the consumer needs the current quality on the first frame
    // (its prior renderer was torn down with the window).
    state.qualityDirty = state.quality !== null;

    port.onmessage = (msg: MessageEvent) => {
      const data = msg.data as DetachedAckPayload | undefined;
      if (data && data.type === 'ack') {
        state.inflight = Math.max(0, state.inflight - 1);
      }
    };
    port.onmessageerror = (err) => {
      console.error('[frame-bus] port messageerror — detaching', err);
      frameBus.detachPort();
    };
    try {
      port.start();
    } catch {
      /* DOM MessagePort auto-starts when onmessage is set; ignore */
    }
    notifyConsumerChange();
  },

  detachPort() {
    const port = state.port;
    if (!port) return;
    state.port = null;
    state.inflight = 0;
    try {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    } catch {
      /* ignore */
    }
    notifyConsumerChange();
  },

  setDetachedQuality(quality) {
    if (state.quality === quality) return;
    state.quality = quality;
    state.qualityDirty = true;
  },
};

// Module-load wiring: the preload bridge re-dispatches the Electron port
// hand-off as a window 'eviland:frame-port' event. We listen here exactly
// once. Guarded for Node import (smoke scripts esbuild-bundle this module
// into headless contexts without a window).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('eviland:frame-port', (event) => {
    const evt = event as MessageEvent;
    const port = evt.ports && evt.ports[0];
    if (port) frameBus.attachDetachedPort(port);
  });
}
