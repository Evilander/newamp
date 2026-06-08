// Detached Eviland visualizer renderer.
//
// This window owns NOTHING but a canvas, a single EvilandRenderer instance, and
// the MessagePort that carries EvilandFrame snapshots from the main renderer's
// headless producer (src/visualizer/eviland-producer.ts). No AudioContext, no
// reactor, no React, no zustand. Audio plays from the main NewAmp window; this
// window is a pure visual consumer.
//
// It is also SELF-DIAGNOSING: a projector that just shows black gives the user
// nothing to act on. A status layer reports the real state — connecting, waiting
// for frames, paused, silent audio, GPU failure, or a render error — and gets
// out of the way once live frames with audio are painting.

import { createEvilandRenderer, type EvilandRenderer } from '../visualizer/eviland';
import type { DetachedAckPayload, DetachedFramePayload } from '../visualizer/frame-bus';

const canvas = document.getElementById('eviland-canvas') as HTMLCanvasElement | null;

// Compact, semi-transparent status pill (bottom-centre) — it must NOT use the
// full-screen opaque `.eviland-msg` style, or it would black out the canvas it
// is reporting on.
const statusEl = document.createElement('div');
statusEl.setAttribute('data-newamp-detached-status', '');
Object.assign(statusEl.style, {
  position: 'fixed',
  left: '0',
  right: '0',
  bottom: '20px',
  margin: '0 auto',
  width: 'fit-content',
  maxWidth: '82vw',
  padding: '8px 14px',
  textAlign: 'center',
  font: '12px ui-monospace, Menlo, Consolas, monospace',
  color: '#cfd6e6',
  background: 'rgba(8,10,16,0.62)',
  borderRadius: '8px',
  pointerEvents: 'none',
  transition: 'opacity 220ms',
  opacity: '0',
  zIndex: '10',
  whiteSpace: 'pre-line',
});

let lastStatusText: string | null = null;
function setStatus(text: string | null): void {
  if (text === lastStatusText) return; // skip the 1.67Hz DOM write when unchanged
  lastStatusText = text;
  if (!text) {
    statusEl.style.opacity = '0';
    return;
  }
  statusEl.textContent = text;
  statusEl.style.opacity = '1';
}

// Hard failure (no canvas / no GPU): show the full-screen message — there is
// nothing to render behind it anyway — and DON'T throw, so the window stays
// alive and the message stays visible.
function fatal(message: string): void {
  console.error('[eviland-detached]', message);
  const div = document.createElement('div');
  div.className = 'eviland-msg';
  div.textContent = message;
  document.body.replaceChildren(div);
}

if (!canvas) {
  fatal('Detached visualizer: missing #eviland-canvas.');
  throw new Error('eviland-detached: missing canvas element');
}

if (document.body) document.body.appendChild(statusEl);
setStatus('Connecting to NewAmp…');

let currentQuality: 'high' | 'medium' | 'low' = 'high';
let renderer: EvilandRenderer | null = createEvilandRenderer(canvas, { quality: currentQuality });

if (!renderer) {
  fatal(
    'This window can’t create the GPU visualizer\n' +
      '(no WebGL2 / float render targets available here).\n' +
      'The main NewAmp window is unaffected.',
  );
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
    fatal('Detached visualizer lost its GL context during a quality change.');
    return;
  }
  fitCanvas();
}

// --- connection / frame / audio tracking (drives the status layer) ---------
let portAttached = false;
let framesRendered = 0;
let lastFrameAt = 0;
let lastEnergy = 0;
let lastRenderError = '';

function attachPort(port: MessagePort): void {
  portAttached = true;
  port.onmessage = (msg: MessageEvent) => {
    const payload = msg.data as DetachedFramePayload | undefined;
    if (!payload || !payload.frame || !payload.palette) return;
    const nextQuality = payload.config?.quality;
    if (nextQuality && nextQuality !== currentQuality) {
      applyQuality(nextQuality);
    }
    const active = renderer;
    if (active) {
      try {
        // The producer ships the Director/manual operator look alongside each
        // frame; apply it so the projector is choreographed, not the renderer's
        // flat default. Guarded — a bad config must never stop the render.
        if (payload.operator) active.setConfig(payload.operator);
        active.render(payload.frame, payload.palette, payload.dtMs);
        framesRendered += 1;
        lastFrameAt = performance.now();
        lastEnergy = payload.frame.energy; // EvilandFrame.energy is a non-optional number
        lastRenderError = '';
      } catch (err) {
        lastRenderError = String((err as Error)?.message ?? err);
        console.error('[eviland-detached] render threw', err);
      }
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

// Watchdog: translate the tracked state into a human-readable status, and clear
// it once frames with real audio energy are painting (so the projector is clean
// while it's actually working).
window.setInterval(() => {
  if (!renderer) return; // fatal GPU message already shown
  const now = performance.now();
  if (lastRenderError) {
    setStatus('Renderer error:\n' + lastRenderError);
    return;
  }
  if (!portAttached) {
    setStatus('Connecting to NewAmp…\nIf this stays, close and reopen the projector.');
    return;
  }
  if (framesRendered === 0) {
    setStatus('Connected — waiting for the first frame from NewAmp.');
    return;
  }
  if (now - lastFrameAt > 1500) {
    setStatus('Paused — the projector resumes when NewAmp plays.');
    return;
  }
  if (lastEnergy < 0.012) {
    setStatus('Live — waiting for audio (silence).');
    return;
  }
  setStatus(null); // rendering with audio → clean projector
}, 600);

// Cursor auto-hide after 2s of idle — projector mode default. Cursor is already
// hidden via CSS; show it briefly on movement.
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
