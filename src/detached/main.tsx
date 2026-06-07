// Detached Eviland visualizer renderer.
//
// This window owns NOTHING but a canvas, a single EvilandRenderer instance,
// and the MessagePort that carries EvilandFrame snapshots from the main
// renderer. No AudioContext, no reactor, no React, no zustand. Audio still
// plays from the main NewAmp window; this window is a pure visual consumer.
//
// Lifecycle:
//   - On load: build the renderer at the current window size.
//   - On 'eviland:frame-port' window event (re-dispatched by preload from
//     the Electron ipcRenderer 'eviland:frame-port' channel): wire onmessage.
//   - On each frame payload: optionally tear down + recreate the renderer
//     when quality changes, then render(frame, palette, dtMs), then ack.
//   - On Esc / F11: ask main to drop fullscreen.

import { createEvilandRenderer, type EvilandRenderer } from '../visualizer/eviland';
import type { DetachedAckPayload, DetachedFramePayload } from '../visualizer/frame-bus';

// window.detachedViz typings come from src/vite-env.d.ts. In the detached
// window the bridge is present (same preload.js) but we still guard each call
// in case a future build splits the preloads.

const canvas = document.getElementById('eviland-canvas') as HTMLCanvasElement | null;

function showFatal(message: string): void {
  const div = document.createElement('div');
  div.className = 'eviland-msg';
  div.textContent = message;
  document.body.replaceChildren(div);
}

if (!canvas) {
  showFatal('Detached visualizer: missing #eviland-canvas.');
  throw new Error('eviland-detached: missing canvas element');
}

let currentQuality: 'high' | 'medium' | 'low' = 'high';
let renderer: EvilandRenderer | null = createEvilandRenderer(canvas, { quality: currentQuality });

if (!renderer) {
  showFatal('No WebGL2 / EXT_color_buffer_float in this window — detached visualizer needs a real GPU.');
  throw new Error('eviland-detached: createEvilandRenderer returned null');
}

function fitCanvas(): void {
  if (!renderer || !canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, window.innerWidth);
  const h = Math.max(2, window.innerHeight);
  renderer.resize(w, h, dpr);
}

window.addEventListener('resize', fitCanvas);
fitCanvas();

function applyQuality(next: 'high' | 'medium' | 'low'): void {
  if (next === currentQuality || !canvas) return;
  try {
    renderer?.dispose();
  } catch (err) {
    console.error('[eviland-detached] dispose during quality swap failed', err);
  }
  renderer = createEvilandRenderer(canvas, { quality: next });
  currentQuality = next;
  if (!renderer) {
    showFatal('Detached visualizer lost its GL context during a quality change.');
    return;
  }
  fitCanvas();
}

function attachPort(port: MessagePort): void {
  port.onmessage = (msg: MessageEvent) => {
    const payload = msg.data as DetachedFramePayload | undefined;
    if (!payload || !payload.frame || !payload.palette) return;
    const nextQuality = payload.config?.quality;
    if (nextQuality && nextQuality !== currentQuality) {
      applyQuality(nextQuality);
    }
    const active = renderer;
    if (!active) return;
    try {
      // The producer ships the Director/manual operator look alongside each
      // frame; apply it so the projector is choreographed, not the renderer's
      // flat default. Guarded — a bad config must never stop the render.
      if (payload.operator) active.setConfig(payload.operator);
      active.render(payload.frame, payload.palette, payload.dtMs);
    } catch (err) {
      console.error('[eviland-detached] render threw', err);
    }
    const ack: DetachedAckPayload = { type: 'ack', t: payload.t };
    try {
      port.postMessage(ack);
    } catch {
      /* port closed mid-render; main side will reattach on next open */
    }
  };
  port.onmessageerror = (err) => {
    console.error('[eviland-detached] port messageerror', err);
  };
  try {
    port.start();
  } catch {
    /* auto-starts on onmessage assignment in modern Chromium */
  }
}

window.addEventListener('eviland:frame-port', (event) => {
  const evt = event as MessageEvent;
  const port = evt.ports && evt.ports[0];
  if (port) attachPort(port);
});

// Cursor auto-hide after 2s of idle — projector mode default. Cursor is
// already hidden via CSS; show it briefly on movement.
let cursorTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.style.cursor = '';
  if (cursorTimer) window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => {
    document.body.style.cursor = 'none';
  }, 2000);
});

// Escape / F11: ask main to drop fullscreen. Pure renderers cannot toggle
// Electron's fullscreen state directly.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'F11') {
    event.preventDefault();
    const bridge = (window as Window & { detachedViz?: { setFullscreen?: (on: boolean) => Promise<void> } }).detachedViz;
    if (bridge && typeof bridge.setFullscreen === 'function') {
      void bridge.setFullscreen(false).catch((err: unknown) => {
        console.error('[eviland-detached] setFullscreen(false) failed', err);
      });
    }
  }
});

window.addEventListener('beforeunload', () => {
  try {
    renderer?.dispose();
  } catch {
    /* ignore on teardown */
  }
});
