// Eviland frame fan-out + cross-window port bridge.
//
// One reactor produces frames in the main renderer; this bus distributes them
// to (a) zero or more local listeners (e.g. the on-screen <Visualizer/>) and
// (b) the detached visualizer window via a MessageChannelMain port wired by
// the Electron main process.
//
// The sole producer is the headless eviland-producer.ts singleton started by
// App.tsx — the on-screen <Visualizer/> runs its own independent pipeline and
// never publishes here. This module deliberately does no audio or rendering
// on its own; it is pure plumbing.
//
// Backpressure: NONE by design — publishing is fire-and-forget at the
// producer's ~30Hz tick. The original ack-gated inflight window (max 3
// outstanding, consumer acks release slots) froze the projector in
// production: an OCCLUDED Electron renderer stops processing incoming
// MessagePort messages even with backgroundThrottling disabled, so the acks
// returning to the (covered-by-the-projector) main window never landed and
// the window jammed shut. postMessage is async and never blocks the sender;
// the consumer coalesces to the newest frame on its own rAF, so a slow or
// briefly-blocked projector simply skips stale frames instead of starving.
// Acks are still SENT by the consumer for diagnostics, but nothing gates on
// them.
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
  /**
   * Pre-emphasized time-domain bytes (BUTTERCHURN_FFT_SIZE samples). Drives
   * the detached window's MilkDrop (butterchurn) field and the WebGL
   * renderer's waveform layer — without these the projector could only show
   * the bare feedback field, which reads as "black screen" next to the
   * flagship eviland-live composition.
   */
  wave?: Uint8Array;
  /** Engine sample rate — the butterchurn iframe needs it once at init. */
  sampleRate?: number;
  /** Current track id — seeds the detached window's scene-overlay walk. */
  trackId?: number | null;
  /**
   * Lineage-aware scene-overlay seed (`track-<id>::g<gen>-r<rootSeed>`).
   * Preferred over the bare trackId when present, so the projector's scene
   * rotation evolves with the track's visual-memory generation exactly like
   * the on-screen composition.
   */
  sceneSeed?: string | null;
  /**
   * Live playback state for the projector's floating control bar. Piggy-backs
   * on the existing 30Hz publish so the projector never needs to round-trip
   * for what's currently playing. `null` is an explicit "nothing playing"
   * signal — the projector resets its control bar to the idle state instead
   * of freezing on the last track. `undefined` (key absent) means the
   * producer had no opinion this tick.
   */
  transport?: {
    title: string | null;
    artist: string | null;
    album: string | null;
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    /** Perceptual volume 0..2 — mirrored by the projector's volume slider. */
    volume: number;
  } | null;
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
  /** Live counters for smokes/DevTools — never used for control flow. */
  debugStats(): {
    hasPort: boolean;
    seq: number;
    publishCalls: number;
    postErrors: number;
    detaches: number;
    acks: number;
  };
  subscribe(fn: EvilandFrameListener): () => void;
  publish(
    frame: EvilandFrame,
    palette: EvilandPalette,
    dtMs: number,
    operator?: OperatorConfig,
    extras?: {
      wave?: Uint8Array;
      sampleRate?: number;
      trackId?: number | null;
      sceneSeed?: string | null;
      transport?: DetachedFramePayload['transport'];
    },
  ): void;
  hasDetachedConsumer(): boolean;
  onConsumerChange(cb: (hasDetached: boolean) => void): () => void;
  attachDetachedPort(port: MessagePort): void;
  detachPort(): void;
  /** Push a quality change to the detached consumer on the next frame. */
  setDetachedQuality(quality: 'high' | 'medium' | 'low'): void;
}

interface BusState {
  listeners: Set<EvilandFrameListener>;
  consumerChange: Set<(hasDetached: boolean) => void>;
  port: MessagePort | null;
  quality: 'high' | 'medium' | 'low' | null;
  qualityDirty: boolean;
  seq: number;
}

const state: BusState = {
  listeners: new Set(),
  consumerChange: new Set(),
  port: null,
  quality: null,
  qualityDirty: false,
  seq: 0,
};

const debug = { publishCalls: 0, postErrors: 0, detaches: 0, acks: 0 };

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
  debugStats() {
    return {
      hasPort: state.port !== null,
      seq: state.seq,
      ...debug,
    };
  },

  subscribe(fn) {
    state.listeners.add(fn);
    return () => {
      state.listeners.delete(fn);
    };
  },

  publish(frame, palette, dtMs, operator, extras) {
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
    debug.publishCalls += 1;

    const payload: DetachedFramePayload = {
      t: ++state.seq,
      frame,
      palette,
      dtMs,
    };
    if (operator) payload.operator = operator;
    if (extras?.wave) payload.wave = extras.wave; // structured-clone copies it
    if (extras?.sampleRate) payload.sampleRate = extras.sampleRate;
    if (extras?.trackId !== undefined) payload.trackId = extras.trackId;
    if (extras?.sceneSeed !== undefined) payload.sceneSeed = extras.sceneSeed;
    // `null` transport must survive the trip — it's the explicit idle signal.
    if (extras && 'transport' in extras) payload.transport = extras.transport;
    if (state.qualityDirty && state.quality) {
      payload.config = { quality: state.quality };
      state.qualityDirty = false;
    }
    try {
      port.postMessage(payload);
    } catch (err) {
      // The port can be closed mid-frame if the detached window crashed or
      // was destroyed between attach and post. Tear down the port so the
      // next publish doesn't try again.
      debug.postErrors += 1;
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
    // On reattach, the consumer needs the current quality on the first frame
    // (its prior renderer was torn down with the window).
    state.qualityDirty = state.quality !== null;

    port.onmessage = (msg: MessageEvent) => {
      const data = msg.data as DetachedAckPayload | undefined;
      if (data && data.type === 'ack') {
        debug.acks += 1; // diagnostics only — nothing gates on acks
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
    debug.detaches += 1;
    state.port = null;
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
