// Detached Eviland visualizer renderer.
//
// This window reproduces the flagship 'eviland-live' composition: the REAL
// MilkDrop field (butterchurn, in the same sandboxed iframe the main window
// uses) underneath, with NewAmp's causal reactor-overlay events composited on
// top. Frames + pre-emphasized time-domain audio bytes arrive over a
// MessagePort from the main renderer's headless producer
// (src/visualizer/eviland-producer.ts). No AudioContext, no React, no zustand
// — audio plays from the main NewAmp window; this window is a pure consumer.
//
// If the iframe can't host butterchurn (load failure / missing GL features),
// we fall back to the bare WebGL2 EvilandRenderer driven by the same frames,
// so the projector never goes dark.
//
// It is also SELF-DIAGNOSING: a projector that just shows black gives the user
// nothing to act on. A status layer reports the real state — connecting,
// waiting for frames, paused, silent audio, GPU failure, or a render error —
// and gets out of the way once live frames are painting.
//
// HANDSHAKE: the frame port is wired by the Electron main process only AFTER
// this module signals 'detached-viz:renderer-ready' (see the bottom of this
// file). Wiring at ready-to-show raced this module's evaluation and could
// drop the port forever — the original "black screen" bug.

import { createEvilandRenderer, type EvilandRenderer } from '../visualizer/eviland';
import { createReactorOverlay, type ReactorOverlay } from '../visualizer/reactor-overlay';
import { createSceneOverlay, type SceneOverlay } from '../visualizer/scene-overlay';
import type { DetachedAckPayload, DetachedFramePayload } from '../visualizer/frame-bus';
import type {
  BcAudioMessage,
  BcDisposeMessage,
  BcFrameMessage,
  BcInitMessage,
} from '../butterchurn-iframe/protocol';

const canvas = document.getElementById('eviland-canvas') as HTMLCanvasElement | null;
const milkdropFrame = document.getElementById('milkdrop-frame') as HTMLIFrameElement | null;
const sceneCanvas = document.getElementById('scene-overlay') as HTMLCanvasElement | null;
const overlayCanvas = document.getElementById('reactor-overlay') as HTMLCanvasElement | null;

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

// Hard failure (no canvas at all): show the full-screen message — there is
// nothing to render behind it anyway — and DON'T throw, so the window stays
// alive and the message stays visible.
function fatal(message: string): void {
  console.error('[eviland-detached]', message);
  const div = document.createElement('div');
  div.className = 'eviland-msg';
  div.textContent = message;
  document.body.replaceChildren(div);
}

if (!canvas || !milkdropFrame || !overlayCanvas) {
  fatal('Detached visualizer: missing layer elements.');
  throw new Error('eviland-detached: missing layer elements');
}

if (document.body) document.body.appendChild(statusEl);
setStatus('Connecting to NewAmp…');

// ---------------------------------------------------------------------------
// Floating control bar: track info + transport + fullscreen + close.
//
// Without this, detaching the visualizer literally takes away every control —
// the projector window has no chrome, no menu, no way to even go exclusive
// fullscreen. The bar is opaque enough to read and translucent enough that
// the visuals remain primary. Auto-hides on cursor idle so the projector is
// uninterrupted while you're watching.
// ---------------------------------------------------------------------------

const detachedBridge = (window as Window & {
  detachedViz?: {
    setFullscreen?: (on: boolean) => Promise<void>;
    toggleFullscreen?: () => Promise<boolean>;
    isFullscreen?: () => Promise<boolean>;
    transportCommand?: (
      cmd: 'togglePlay' | 'next' | 'prev' | 'seek' | 'setVolume',
      arg?: number,
    ) => Promise<void>;
    close?: () => Promise<void>;
    rendererReady?: () => void;
  };
}).detachedViz;

let isFullscreen = false;

const controlsEl = document.createElement('div');
controlsEl.setAttribute('data-newamp-detached-controls', '');
Object.assign(controlsEl.style, {
  position: 'fixed',
  left: '0',
  right: '0',
  bottom: '0',
  padding: '14px 24px 18px',
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr',
  alignItems: 'center',
  gap: '16px',
  font: '13px ui-monospace, Menlo, Consolas, monospace',
  color: '#e6ecf5',
  background: 'linear-gradient(to top, rgba(4,6,10,0.78), rgba(4,6,10,0.0))',
  pointerEvents: 'none',
  opacity: '0',
  transition: 'opacity 240ms',
  zIndex: '20',
  userSelect: 'none',
});

const trackInfoEl = document.createElement('div');
Object.assign(trackInfoEl.style, {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: '0',
  overflow: 'hidden',
});
const titleEl = document.createElement('div');
Object.assign(titleEl.style, {
  fontWeight: '600',
  fontSize: '13px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
titleEl.textContent = '—';
const artistEl = document.createElement('div');
Object.assign(artistEl.style, {
  fontSize: '11px',
  opacity: '0.72',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
artistEl.textContent = '';
trackInfoEl.append(titleEl, artistEl);

const transportEl = document.createElement('div');
Object.assign(transportEl.style, {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
});

function makeButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  Object.assign(btn.style, {
    width: '34px',
    height: '34px',
    borderRadius: '999px',
    border: '1px solid rgba(230,236,245,0.18)',
    background: 'rgba(20,24,34,0.78)',
    color: 'inherit',
    font: 'inherit',
    fontSize: '15px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto',
    transition: 'background 120ms, transform 120ms',
  });
  btn.addEventListener('pointerenter', () => {
    btn.style.background = 'rgba(40,50,72,0.88)';
  });
  btn.addEventListener('pointerleave', () => {
    btn.style.background = 'rgba(20,24,34,0.78)';
  });
  btn.addEventListener('click', onClick);
  return btn;
}

const prevBtn = makeButton('⏮', 'Previous track', () => {
  void detachedBridge?.transportCommand?.('prev').catch(() => undefined);
});
const playBtn = makeButton('▶', 'Play / pause', () => {
  void detachedBridge?.transportCommand?.('togglePlay').catch(() => undefined);
});
playBtn.style.width = '40px';
playBtn.style.height = '40px';
playBtn.style.fontSize = '17px';
const nextBtn = makeButton('⏭', 'Next track', () => {
  void detachedBridge?.transportCommand?.('next').catch(() => undefined);
});
transportEl.append(prevBtn, playBtn, nextBtn);

const rightEl = document.createElement('div');
Object.assign(rightEl.style, {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '12px',
  minWidth: '0',
});

const timeEl = document.createElement('div');
Object.assign(timeEl.style, {
  fontVariantNumeric: 'tabular-nums',
  fontSize: '11px',
  opacity: '0.78',
  whiteSpace: 'nowrap',
});
timeEl.textContent = '–:–– / –:––';

// Uncontrolled-while-dragging scrub bar — same UX as ScrubBar.tsx but inlined
// for the no-React projector. Stops mirroring the playhead during drag, fires
// the seek IPC on commit (input event), resumes mirroring on release.
const scrubEl = document.createElement('input');
scrubEl.type = 'range';
scrubEl.min = '0';
scrubEl.max = '100';
scrubEl.step = '0.1';
scrubEl.value = '0';
Object.assign(scrubEl.style, {
  width: '160px',
  pointerEvents: 'auto',
  cursor: 'pointer',
  accentColor: '#7aa8ff',
});
let scrubbing = false;
scrubEl.addEventListener('pointerdown', () => {
  scrubbing = true;
});
const finishScrub = (): void => {
  if (!scrubbing) return;
  scrubbing = false;
  const t = Number(scrubEl.value);
  if (Number.isFinite(t)) {
    void detachedBridge?.transportCommand?.('seek', t).catch(() => undefined);
  }
};
scrubEl.addEventListener('pointerup', finishScrub);
scrubEl.addEventListener('pointercancel', finishScrub);
scrubEl.addEventListener('blur', finishScrub);

const fsBtn = makeButton('⛶', 'Toggle exclusive fullscreen (F11)', () => {
  toggleFullscreen();
});
const closeBtn = makeButton('✕', 'Close the projector', () => {
  void detachedBridge?.close?.().catch(() => undefined);
});

rightEl.append(timeEl, scrubEl, fsBtn, closeBtn);

controlsEl.append(trackInfoEl, transportEl, rightEl);
document.body.appendChild(controlsEl);

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

let controlsVisible = false;
function showControls(): void {
  if (!controlsVisible) {
    controlsVisible = true;
    controlsEl.style.opacity = '1';
  }
}
function hideControls(): void {
  if (controlsVisible) {
    controlsVisible = false;
    controlsEl.style.opacity = '0';
  }
}

let lastTransport: DetachedFramePayload['transport'] | null = null;
function applyTransportState(transport: DetachedFramePayload['transport'] | undefined): void {
  if (!transport) return;
  lastTransport = transport;
  const title = transport.title || 'Unknown track';
  const artist = transport.artist || '';
  if (titleEl.textContent !== title) titleEl.textContent = title;
  if (artistEl.textContent !== artist) artistEl.textContent = artist;
  const play = transport.isPlaying ? '⏸' : '▶';
  if (playBtn.textContent !== play) playBtn.textContent = play;
  const cur = Math.max(0, transport.currentTime);
  const dur = Math.max(0, transport.duration);
  const nextTime = `${formatTime(cur)} / ${formatTime(dur)}`;
  if (timeEl.textContent !== nextTime) timeEl.textContent = nextTime;
  if (!scrubbing && dur > 0) {
    if (scrubEl.max !== String(dur)) scrubEl.max = String(dur);
    scrubEl.value = String(Math.min(cur, dur));
  } else if (!scrubbing && dur <= 0) {
    scrubEl.value = '0';
  }
}

async function syncFullscreenState(): Promise<void> {
  if (!detachedBridge?.isFullscreen) return;
  try {
    isFullscreen = await detachedBridge.isFullscreen();
    fsBtn.textContent = isFullscreen ? '⛶' : '⛶'; // glyph stays — title carries the state
    fsBtn.title = isFullscreen ? 'Exit fullscreen (F11 / Esc)' : 'Enter exclusive fullscreen (F11)';
  } catch {
    /* projector closing */
  }
}
void syncFullscreenState();

function toggleFullscreen(): void {
  if (!detachedBridge?.toggleFullscreen) return;
  void detachedBridge.toggleFullscreen()
    .then((next) => {
      isFullscreen = next;
      fsBtn.title = next ? 'Exit fullscreen (F11 / Esc)' : 'Enter exclusive fullscreen (F11)';
    })
    .catch(() => undefined);
}

let currentQuality: 'high' | 'medium' | 'low' = 'high';

// --- MilkDrop (butterchurn) field — flagship layer -------------------------
let bcReady = false;
let bcMounted = false;
let bcFailed = false;
let bcInitSent = false;
let lastSampleRate = 44100;

// --- WebGL fallback renderer (created only if the iframe can't host) -------
let renderer: EvilandRenderer | null = null;
let rendererFailed = false;

// --- Reactor overlay (causal per-instrument events over the field) ---------
let overlay: ReactorOverlay | null = createReactorOverlay(overlayCanvas);

// --- Scene overlay (the 25 audio-reactive scenes between field and events) -
let sceneOverlay: SceneOverlay | null = sceneCanvas
  ? createSceneOverlay(sceneCanvas, { quality: 'high', seedKey: 'detached' })
  : null;

function dprCap(): number {
  return currentQuality === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
}

function fitLayers(): void {
  const w = Math.max(2, window.innerWidth);
  const h = Math.max(2, window.innerHeight);
  const dpr = dprCap();
  renderer?.resize(w, h, dpr);
  overlay?.resize(w, h, dpr);
  sceneOverlay?.resize(w, h, dpr);
}

window.addEventListener('resize', fitLayers);
fitLayers();

function startWebglFallback(): void {
  if (renderer || rendererFailed || !canvas) return;
  milkdropFrame!.style.display = 'none';
  renderer = createEvilandRenderer(canvas, { quality: currentQuality });
  if (!renderer) {
    rendererFailed = true;
    fatal(
      'This window can’t create the GPU visualizer\n' +
        '(no WebGL2 / float render targets available here).\n' +
        'The main NewAmp window is unaffected.',
    );
    return;
  }
  fitLayers();
}

// Boot the butterchurn iframe exactly like Visualizer.tsx does. If it fails
// or never mounts, drop to the WebGL renderer so the projector stays alive.
const onBcMessage = (event: MessageEvent): void => {
  if (event.source !== milkdropFrame!.contentWindow) return;
  const msg = event.data as BcFrameMessage | undefined;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') {
    bcReady = true;
    maybeInitButterchurn();
  } else if (msg.type === 'mounted') {
    bcMounted = true;
  } else if (msg.type === 'failed') {
    console.error('[eviland-detached] butterchurn iframe failed to start:', msg.error);
    bcFailed = true;
    startWebglFallback();
  }
};
window.addEventListener('message', onBcMessage);

// The init message needs the engine's sample rate, which arrives with the
// first frame payload — init is sent once both are available.
function maybeInitButterchurn(): void {
  if (bcInitSent || !bcReady || bcFailed) return;
  bcInitSent = true;
  const init: BcInitMessage = { type: 'init', sampleRate: lastSampleRate, dpr: dprCap() };
  milkdropFrame!.contentWindow?.postMessage(init, '*');
}

// dev: http://localhost:5173/butterchurn-iframe.html
// prod: newamp-app://app/butterchurn-iframe.html
milkdropFrame.src = new URL('butterchurn-iframe.html', window.location.href).toString();

const bcMountTimeout = window.setTimeout(() => {
  if (!bcMounted && !bcFailed) {
    console.error('[eviland-detached] butterchurn iframe did not mount within timeout; using WebGL fallback');
    bcFailed = true;
    startWebglFallback();
  }
  // 20s: the full preset catalog (base+Extra+Extra2+MD1) takes a few seconds
  // to parse even on a fast machine; 8s false-failed slow cold boots.
}, 20000);

function applyQuality(next: 'high' | 'medium' | 'low'): void {
  if (next === currentQuality) return;
  currentQuality = next;
  if (renderer && canvas) {
    try {
      renderer.dispose();
    } catch (err) {
      console.error('[eviland-detached] dispose during quality swap failed', err);
    }
    renderer = createEvilandRenderer(canvas, { quality: next });
    if (!renderer) {
      rendererFailed = true;
      if (bcFailed) fatal('Detached visualizer lost its GL context during a quality change.');
      return;
    }
  }
  fitLayers();
}

// --- connection / frame / audio tracking (drives the status layer) ---------
let portAttached = false;
let framesRendered = 0;
let lastFrameAt = 0;
let lastEnergy = 0;
let lastRenderError = '';

// Latest payload awaiting a GL pass — see renderGlLayers().
let glPayload: DetachedFramePayload | null = null;

function handlePayload(payload: DetachedFramePayload): void {
  const nextQuality = payload.config?.quality;
  if (nextQuality && nextQuality !== currentQuality) {
    applyQuality(nextQuality);
  }
  if (payload.sampleRate && payload.sampleRate !== lastSampleRate) {
    lastSampleRate = payload.sampleRate;
  }
  maybeInitButterchurn();

  try {
    // Live transport state (track title, scrub, play/pause) for the floating
    // control bar — piggy-backed on the same 30Hz publish so no round-trip is
    // ever needed.
    if (payload.transport) applyTransportState(payload.transport);

    // MilkDrop field: forward the pre-emphasized time-domain bytes. The iframe
    // runs its own rAF render loop and preset rotation — it only needs audio.
    if (!bcFailed && bcReady && payload.wave && payload.wave.length) {
      const audio: BcAudioMessage = { type: 'audio', samples: payload.wave };
      milkdropFrame!.contentWindow?.postMessage(audio, '*');
    }

    // Reactor overlay: 2D canvas — cheap, never GPU-blocks, renders on every
    // payload so the projector stays demonstrably alive even when occluded.
    overlay?.render(payload.frame, payload.palette, payload.dtMs);

    // GL layers are deferred to the rAF pass below — see renderGlLayers().
    glPayload = payload;

    framesRendered += 1;
    lastFrameAt = performance.now();
    lastEnergy = payload.frame.energy; // EvilandFrame.energy is a non-optional number
    lastRenderError = '';
  } catch (err) {
    lastRenderError = String((err as Error)?.message ?? err);
    console.error('[eviland-detached] render threw', err);
  }
}

// GL layers (scene overlay + WebGL fallback renderer) render ONLY inside
// requestAnimationFrame — deliberately. WebGL command submission BLOCKS the
// renderer main thread once the compositor stops consuming frames (occluded
// window): rendering GL at full rate from the message handler wedged the
// whole window within ~20 frames in production-like conditions. rAF fires
// exactly when the compositor is consuming frames — exactly when GL is safe
// and exactly when someone can actually see the window. While occluded, the
// message loop + 2D layer above keep running; on reveal, scenes resume on the
// next compositor frame with the freshest payload.
function renderGlLayers(): void {
  const payload = glPayload;
  glPayload = null;
  if (payload) {
    try {
      if (sceneOverlay) {
        if (payload.trackId !== undefined) {
          sceneOverlay.setSeedKey(`track-${payload.trackId ?? 'idle'}`);
        }
        sceneOverlay.render(payload.frame, payload.palette, payload.dtMs);
      }
      if (renderer) {
        // The producer ships the Director/manual operator look alongside each
        // frame; apply it so the projector is choreographed, not the
        // renderer's flat default. Guarded — a bad config must never stop the
        // render loop.
        if (payload.operator) renderer.setConfig(payload.operator);
        if (payload.wave && payload.wave.length) renderer.setWaveform(payload.wave);
        renderer.render(payload.frame, payload.palette, payload.dtMs);
      }
    } catch (err) {
      lastRenderError = String((err as Error)?.message ?? err);
      console.error('[eviland-detached] GL render threw', err);
    }
  }
  requestAnimationFrame(renderGlLayers);
}
requestAnimationFrame(renderGlLayers);

// Payloads are handled SYNCHRONOUSLY in onmessage — deliberately. Both rAF
// and setTimeout-based pumps freeze when this window is occluded (rAF loses
// BeginFrames; timer queues get throttled despite backgroundThrottling:false),
// which froze the projector ~0.5s after it lost focus. MessagePort message
// tasks are the one delivery mechanism that empirically keeps running, so the
// render rides directly on them. The producer caps the rate at ~30Hz, and
// payloads arriving while this thread is briefly blocked (butterchurn's
// synchronous preset compile) just queue and replay — a bounded, transient
// burst. Nothing in the producer→projector pipeline may depend on compositor
// frames or timers.
function attachPort(port: MessagePort): void {
  portAttached = true;
  port.onmessage = (msg: MessageEvent) => {
    const payload = msg.data as DetachedFramePayload | undefined;
    if (payload && payload.frame && payload.palette) {
      handlePayload(payload);
    }
    // Diagnostics-only ack — the producer counts but never gates on these.
    const ack: DetachedAckPayload = { type: 'ack', t: typeof payload?.t === 'number' ? payload.t : -1 };
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
    setStatus('Live — visuals react when audio plays.');
    return;
  }
  setStatus(null); // rendering with audio → clean projector
}, 600);

// Cursor auto-hide + control-bar visibility tied together. Idle → cursor and
// controls both disappear so the projector is unobstructed; any movement
// brings them back for 2s, long enough to scrub/click without the bar
// vanishing under the pointer.
let cursorTimer = 0;
function poke(): void {
  document.body.style.cursor = '';
  showControls();
  if (cursorTimer) window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => {
    document.body.style.cursor = 'none';
    hideControls();
  }, 2000);
}
window.addEventListener('mousemove', poke);
// Pointer on the controls themselves must not race the idle timer — keep
// them up while interacting.
controlsEl.addEventListener('pointerenter', () => {
  if (cursorTimer) window.clearTimeout(cursorTimer);
  showControls();
});
controlsEl.addEventListener('pointerleave', poke);

// Double-click anywhere on the canvas area = toggle fullscreen. Mirrors how
// most video players let you go fullscreen, no keyboard required.
window.addEventListener('dblclick', (event) => {
  // Don't fire when double-clicking inside the controls (the buttons handle
  // their own activations and a double-click on the scrub bar shouldn't
  // change fullscreen state).
  if (controlsEl.contains(event.target as Node)) return;
  event.preventDefault();
  toggleFullscreen();
});

// F11 TOGGLES (was: only exited). Escape always exits — it's the universal
// "give me out of fullscreen" gesture.
window.addEventListener('keydown', (event) => {
  if (event.key === 'F11') {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (detachedBridge?.setFullscreen) {
      void detachedBridge.setFullscreen(false).then(() => {
        isFullscreen = false;
        fsBtn.title = 'Enter exclusive fullscreen (F11)';
      }).catch((err: unknown) => {
        console.error('[eviland-detached] setFullscreen(false) failed', err);
      });
    }
  } else if (event.key === ' ' || event.code === 'Space') {
    // Space = play/pause — the projector is "the player" while it's on a
    // second monitor and you've alt-tabbed away from the main window.
    event.preventDefault();
    void detachedBridge?.transportCommand?.('togglePlay').catch(() => undefined);
  } else if (event.key === 'ArrowRight' && event.ctrlKey) {
    event.preventDefault();
    void detachedBridge?.transportCommand?.('next').catch(() => undefined);
  } else if (event.key === 'ArrowLeft' && event.ctrlKey) {
    event.preventDefault();
    void detachedBridge?.transportCommand?.('prev').catch(() => undefined);
  } else if (event.key === 'ArrowRight') {
    if (!lastTransport) return;
    event.preventDefault();
    const target = Math.min(lastTransport.duration, lastTransport.currentTime + 5);
    void detachedBridge?.transportCommand?.('seek', target).catch(() => undefined);
  } else if (event.key === 'ArrowLeft') {
    if (!lastTransport) return;
    event.preventDefault();
    const target = Math.max(0, lastTransport.currentTime - 5);
    void detachedBridge?.transportCommand?.('seek', target).catch(() => undefined);
  }
});

window.addEventListener('beforeunload', () => {
  try {
    renderer?.dispose();
    overlay?.dispose();
    overlay = null;
    sceneOverlay?.dispose();
    sceneOverlay = null;
    const dispose: BcDisposeMessage = { type: 'dispose' };
    milkdropFrame.contentWindow?.postMessage(dispose, '*');
    window.clearTimeout(bcMountTimeout);
  } catch {
    /* ignore on teardown */
  }
});

// Live diagnostics for smokes (and DevTools): the detached window can't be
// asserted from the main renderer, so it reports its own state.
Object.defineProperty(window, '__newampDetachedStats', {
  get: () => ({
    portAttached,
    framesRendered,
    lastEnergy,
    lastRenderError,
    bcReady,
    bcMounted,
    bcFailed,
    webglFallback: renderer !== null,
    overlayActive: overlay !== null,
  }),
});

// Signal the main process that the frame-port listener above is installed —
// it wires the MessageChannelMain pair only on this signal, which makes the
// handshake immune to module-evaluation timing.
{
  const bridge = (window as Window & { detachedViz?: { rendererReady?: () => void } }).detachedViz;
  if (bridge && typeof bridge.rendererReady === 'function') {
    bridge.rendererReady();
  } else {
    console.error('[eviland-detached] detachedViz.rendererReady bridge missing — projector cannot connect');
  }
}
