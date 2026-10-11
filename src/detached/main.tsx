// Detached Eviland visualizer renderer.
//
// This window reproduces the flagship 'eviland-live' composition: the REAL
// MilkDrop field (butterchurn, in the same sandboxed iframe the main window
// uses) with NewAmp's scenes, fluid and causal reactor events drawn into its
// feedback by the iframe's Live pipeline (src/visualizer/eviland-live-pipeline.ts).
// Frames + pre-emphasized time-domain audio bytes arrive over a
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
import { attachFlashGuard, type AttachedFlashGuard } from '../visualizer/flash-guard-host';
import { watchContextFallback, type ContextEvent, type ContextFallbackWatch } from '../visualizer/context-fallback';
import { createFrameFallbackPainter, type FrameFallbackPainter } from '../visualizer/frame-fallback';
import type { DetachedAckPayload, DetachedFramePayload } from '../visualizer/frame-bus';
import type {
  BcAudioMessage,
  BcConfigMessage,
  BcDisposeMessage,
  BcFrameMessage,
  BcInitMessage,
} from '../butterchurn-iframe/protocol';
import { watchDisplayChange } from '../lib/pacedFrame';
import { projectorKeyAction } from './projector-keys';
import {
  PROJECTOR_ACCENT_FALLBACK,
  PROJECTOR_SEEK_STEP,
  projectorAccent,
  projectorSeekTarget,
  projectorVolumeTarget,
  type ProjectorTransport,
} from './projector-controls';

const canvas = document.getElementById('eviland-canvas') as HTMLCanvasElement | null;
const milkdropFrame = document.getElementById('milkdrop-frame') as HTMLIFrameElement | null;

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

if (!canvas || !milkdropFrame) {
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
  accentColor: PROJECTOR_ACCENT_FALLBACK,
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

// Volume slider — the projector frames itself as "the player" when the main
// window is alt-tabbed away, and a player you can't turn down isn't one. The
// 'setVolume' transport command was already wired end-to-end; this is its UI.
const volWrapEl = document.createElement('div');
Object.assign(volWrapEl.style, {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
});
const volIconEl = document.createElement('span');
volIconEl.textContent = '🔉';
Object.assign(volIconEl.style, { fontSize: '12px', opacity: '0.78' });
const volEl = document.createElement('input');
volEl.type = 'range';
volEl.min = '0';
volEl.max = '2';
volEl.step = '0.01';
volEl.value = '0.75';
volEl.title = 'Volume (0–200%)';
volEl.setAttribute('aria-label', 'Volume');
Object.assign(volEl.style, {
  width: '72px',
  pointerEvents: 'auto',
  cursor: 'pointer',
  accentColor: PROJECTOR_ACCENT_FALLBACK,
});
volWrapEl.append(volIconEl, volEl);

let volDragging = false;
let volSendTimer = 0;
function sendVolume(): void {
  const v = Number(volEl.value);
  if (Number.isFinite(v)) {
    void detachedBridge?.transportCommand?.('setVolume', v).catch(() => undefined);
  }
}
volEl.addEventListener('pointerdown', () => {
  volDragging = true;
});
// Live-but-throttled while dragging (one IPC per ~60ms, not per pointermove).
volEl.addEventListener('input', () => {
  if (volSendTimer) return;
  volSendTimer = window.setTimeout(() => {
    volSendTimer = 0;
    sendVolume();
  }, 60);
});
const finishVol = (): void => {
  if (!volDragging) return;
  volDragging = false;
  if (volSendTimer) {
    window.clearTimeout(volSendTimer);
    volSendTimer = 0;
  }
  sendVolume();
};
volEl.addEventListener('pointerup', finishVol);
volEl.addEventListener('pointercancel', finishVol);
volEl.addEventListener('blur', finishVol);

const fsBtn = makeButton('⛶', 'Toggle exclusive fullscreen (F11)', () => {
  toggleFullscreen();
});
const closeBtn = makeButton('✕', 'Close the projector', () => {
  void detachedBridge?.close?.().catch(() => undefined);
});

rightEl.append(timeEl, scrubEl, volWrapEl, fsBtn, closeBtn);

controlsEl.append(trackInfoEl, transportEl, rightEl);
document.body.appendChild(controlsEl);

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Grab bar: this window is frameless — without a drag region it literally
// cannot be moved by mouse (you couldn't even drag it to the monitor you
// wanted to fullscreen it on). A top strip appears with the controls and is
// a native drag region; it disappears with them so the visuals stay primary.
// Hidden in exclusive fullscreen, where there's nothing to drag.
// NOTE: the OS owns mouse events over a drag region (double-click there
// maximizes, per Windows convention) — the hint text advertises F11 instead.
const dragBarEl = document.createElement('div');
dragBarEl.setAttribute('data-newamp-detached-dragbar', '');
Object.assign(dragBarEl.style, {
  position: 'fixed',
  top: '0',
  left: '0',
  right: '0',
  height: '44px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  font: '11px ui-monospace, Menlo, Consolas, monospace',
  letterSpacing: '0.08em',
  color: 'rgba(230,236,245,0.7)',
  background: 'linear-gradient(to bottom, rgba(4,6,10,0.72), rgba(4,6,10,0.0))',
  opacity: '0',
  transition: 'opacity 240ms',
  zIndex: '19',
  cursor: 'grab',
  userSelect: 'none',
});
dragBarEl.textContent = '⋮⋮   drag to move  ·  F11 fullscreen   ⋮⋮';
document.body.appendChild(dragBarEl);

type AppRegionStyle = CSSStyleDeclaration & { webkitAppRegion?: string };
let controlsVisible = false;

function updateDragBar(): void {
  const active = controlsVisible && !isFullscreen;
  dragBarEl.style.opacity = active ? '1' : '0';
  // The drag region must be released when hidden — an invisible strip that
  // still eats clicks would be a mystery dead zone at the top of the video.
  (dragBarEl.style as AppRegionStyle).webkitAppRegion = active ? 'drag' : 'no-drag';
  dragBarEl.style.pointerEvents = active ? 'auto' : 'none';
}
updateDragBar();

function showControls(): void {
  if (!controlsVisible) {
    controlsVisible = true;
    controlsEl.style.opacity = '1';
    updateDragBar();
  }
}
function hideControls(): void {
  if (controlsVisible) {
    controlsVisible = false;
    controlsEl.style.opacity = '0';
    updateDragBar();
  }
}

let lastTransport: ProjectorTransport | null = null;
let lastAccent = PROJECTOR_ACCENT_FALLBACK;
// A volume key press moves the slider at once; the mirrored value that comes
// back a round trip later is stale until it catches up, so it is held off.
let volHoldUntil = 0;
function applyTransportState(transport: ProjectorTransport | null | undefined): void {
  if (!transport) {
    // Explicit idle signal (queue cleared / playback fully stopped): reset the
    // bar instead of freezing on the last track forever.
    if (lastTransport === null) return;
    lastTransport = null;
    titleEl.textContent = '—';
    artistEl.textContent = 'Nothing playing';
    playBtn.textContent = '▶';
    timeEl.textContent = '–:–– / –:––';
    if (!scrubbing) {
      scrubEl.max = '100';
      scrubEl.value = '0';
    }
    return;
  }
  lastTransport = transport;
  const accent = projectorAccent(transport);
  if (accent !== lastAccent) {
    lastAccent = accent;
    scrubEl.style.accentColor = accent;
    volEl.style.accentColor = accent;
  }
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
  if (!volDragging && performance.now() >= volHoldUntil && Number.isFinite(transport.volume)) {
    const mirrored = Math.max(0, Math.min(2, transport.volume));
    if (Math.abs(Number(volEl.value) - mirrored) > 0.005) volEl.value = String(mirrored);
  }
}

async function syncFullscreenState(): Promise<void> {
  if (!detachedBridge?.isFullscreen) return;
  try {
    isFullscreen = await detachedBridge.isFullscreen();
    fsBtn.textContent = isFullscreen ? '⛶' : '⛶'; // glyph stays — title carries the state
    fsBtn.title = isFullscreen ? 'Exit fullscreen (F11 / Esc)' : 'Enter exclusive fullscreen (F11)';
    updateDragBar();
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
      updateDragBar();
    })
    .catch(() => undefined);
}

// 'medium' is the common tier now (the producer pushes the user's real tier
// with the first frame; 'high' is the explicit 4K opt-in). The iframe's Live
// pipeline is built at this tier when init is sent, right after that frame.
let currentQuality: 'high' | 'medium' | 'low' = 'medium';

// --- MilkDrop (butterchurn) field — flagship layer -------------------------
let bcReady = false;
let bcMounted = false;
let bcFailed = false;
let bcInitSent = false;
let lastSampleRate = 44100;

// --- WebGL fallback renderer (created only if the iframe can't host) -------
let renderer: EvilandRenderer | null = null;
let rendererFailed = false;
// The iframe guards the MilkDrop field itself; this guards the fallback.
let flashGuard: AttachedFlashGuard | null = null;
let lastGuardedAt = 0;

// The fallback renderer asks the browser for a lost context back and rebuilds
// on it. If that has not happened within a few seconds the window paints from
// the frames in 2D instead, behind the CPU flash guard.
let contextWatch: ContextFallbackWatch | null = null;
let frameFallback: FrameFallbackPainter | null = null;

function watchRendererContext(): (event: ContextEvent) => void {
  contextWatch?.dispose();
  contextWatch = watchContextFallback(startFrameFallback);
  return contextWatch.onEvent;
}

function startFrameFallback(): void {
  if (frameFallback || !canvas) return;
  flashGuard?.dispose();
  flashGuard = null;
  try {
    renderer?.dispose({ releaseContext: true });
  } catch (err) {
    console.error('[eviland-detached] dispose after context loss failed', err);
  }
  renderer = null;
  rendererFailed = true;
  // A canvas that has held WebGL cannot give a 2D context, so the picture goes
  // on a new one above it.
  const surface = document.createElement('canvas');
  surface.setAttribute('data-newamp-detached-fallback', '');
  Object.assign(surface.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', zIndex: '1' });
  canvas.style.display = 'none';
  canvas.after(surface);
  frameFallback = createFrameFallbackPainter(surface);
}

// A renderer whose output can't be guarded doesn't run: it is dropped here
// and the caller treats it like a renderer that failed to start.
function guardRenderer(): void {
  flashGuard?.dispose();
  flashGuard = renderer && canvas ? attachFlashGuard(canvas.getContext('webgl2'), canvas) : null;
  if (renderer && !flashGuard) {
    renderer.dispose();
    renderer = null;
  }
}

function dprCap(): number {
  // Tier-scaled: the projector often lands on a 4K TV where full-DPR
  // MilkDrop + scene shaders is exactly the "suffers mightily when detached"
  // report. 'high' is the explicit 4K opt-in; everyone else renders at a
  // resolution the compositor upscales imperceptibly for motion visuals.
  if (currentQuality === 'low') return 1;
  const dpr = window.devicePixelRatio || 1;
  return currentQuality === 'medium' ? Math.min(dpr, 1.25) : Math.min(dpr, 2);
}

function fitLayers(): void {
  const w = Math.max(2, window.innerWidth);
  const h = Math.max(2, window.innerHeight);
  const dpr = dprCap();
  renderer?.resize(w, h, dpr);
}

window.addEventListener('resize', fitLayers);
fitLayers();

function startWebglFallback(): void {
  if (renderer || rendererFailed || !canvas) return;
  milkdropFrame!.style.display = 'none';
  renderer = createEvilandRenderer(canvas, { quality: currentQuality, onContextEvent: watchRendererContext() });
  guardRenderer();
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

// Changes after init (display, tier, sample rate). Nothing to send before init:
// that message carries the current values.
function postBcConfig(config: Omit<BcConfigMessage, 'type'>): void {
  if (!bcInitSent || bcFailed) return;
  milkdropFrame!.contentWindow?.postMessage({ type: 'config', ...config } satisfies BcConfigMessage, '*');
}

// A window dragged onto a display with another pixel ratio renders at the new one.
const stopDisplayWatch = watchDisplayChange(() => {
  postBcConfig({ dpr: dprCap() });
  fitLayers();
});

// The init message needs the engine's sample rate, which arrives with the
// first frame payload — init is sent once both are available.
function maybeInitButterchurn(): void {
  if (bcInitSent || !bcReady || bcFailed) return;
  bcInitSent = true;
  const init: BcInitMessage = { type: 'init', sampleRate: lastSampleRate, dpr: dprCap(), eviland: true, quality: currentQuality };
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
  // The tier sets the pixel ratio too (dprCap), so the frame gets both.
  postBcConfig({ quality: next, dpr: dprCap() });
  if (renderer && canvas) {
    flashGuard?.dispose();
    flashGuard = null;
    try {
      renderer.dispose();
    } catch (err) {
      console.error('[eviland-detached] dispose during quality swap failed', err);
    }
    renderer = createEvilandRenderer(canvas, { quality: next, onContextEvent: watchRendererContext() });
    guardRenderer();
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
    // Bit-Perfect output can move the device to another rate between tracks.
    postBcConfig({ sampleRate: lastSampleRate });
  }
  maybeInitButterchurn();

  try {
    // Live transport state (track title, scrub, play/pause) for the floating
    // control bar — piggy-backed on the same 30Hz publish so no round-trip is
    // ever needed. `null` is the explicit idle signal; only `undefined` (key
    // absent — producer had no opinion) is skipped.
    if (payload.transport !== undefined) applyTransportState(payload.transport);

    // MilkDrop field: forward the pre-emphasized time-domain bytes plus the
    // producer's look for this frame. The iframe runs its own render loop and
    // draws the whole Live composition; it keeps painting from these messages
    // when the window is occluded and rAF stops.
    if (!bcFailed && bcReady && payload.wave && payload.wave.length) {
      const audio: BcAudioMessage = {
        type: 'audio',
        samples: payload.wave,
        // Whether a track is playing, so a quiet passage does not read as stopped.
        playing: payload.transport ? payload.transport.isPlaying : payload.transport === null ? false : undefined,
        eviland: payload.operator
          ? {
              frame: payload.frame,
              palette: payload.palette,
              // The iframe blends presets itself; the fade's two full looks
              // (kept on the bus for the Eviland renderer) would only bloat
              // every message. It still gets the slim look the fade is
              // heading to, so it prepares that look as the fade begins.
              config: payload.operator._from ? { ...payload.operator, _from: undefined, _to: undefined } : payload.operator,
              next: payload.operator._to
                ? { seed: payload.operator._to.seed, archetype: payload.operator._to.archetype, composition: payload.operator._to.composition }
                : undefined,
              seed: payload.sceneSeed ?? `track-${payload.trackId ?? 'idle'}`,
              waveMode: payload.waveMode ?? 'auto',
              grade: payload.grade,
            }
          : undefined,
      };
      milkdropFrame!.contentWindow?.postMessage(audio, '*');
    }

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
      if (renderer) {
        try {
          // The producer ships the Director/manual operator look alongside
          // each frame; apply it so the projector is choreographed, not the
          // renderer's flat default. Guarded — a bad config must never stop
          // the render loop.
          if (payload.operator) renderer.setConfig(payload.operator);
          if (payload.wave && payload.wave.length) renderer.setWaveform(payload.wave);
          renderer.render(payload.frame, payload.palette, payload.dtMs, 'host');
        } finally {
          // Even when render throws after drawing, whatever reached the
          // backbuffer is guarded. Wall time since the last guarded frame:
          // payloads can be skipped between two GL passes, and the guard's
          // window is in real seconds.
          const guardedAt = performance.now();
          flashGuard?.apply(lastGuardedAt ? guardedAt - lastGuardedAt : payload.dtMs);
          lastGuardedAt = guardedAt;
        }
      } else {
        frameFallback?.paint(payload.frame, payload.palette, performance.now());
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
let framePort: MessagePort | null = null;
function attachPort(port: MessagePort): void {
  // A main-renderer reload while the projector stays open re-wires a fresh
  // MessageChannelMain pair; close the superseded port instead of leaking one
  // live onmessage closure per reload cycle.
  if (framePort && framePort !== port) {
    try {
      framePort.onmessage = null;
      framePort.close();
    } catch {
      /* ignore */
    }
  }
  framePort = port;
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
  // The stylesheet hides the cursor until the first move, so clearing the
  // inline style here ('') fell back to that and the cursor never came back.
  document.body.style.cursor = 'default';
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
// Cmd, not Ctrl, is the transport modifier on a Mac, so the chord rules are
// the main window's own. Ctrl+Left/Right keep working there.
const hostPlatform = /mac/i.test(navigator.platform || navigator.userAgent) ? 'darwin' : undefined;

// Stepping from the slider's own value keeps a held key adding up between the
// mirrored updates.
function stepVolume(direction: 1 | -1): void {
  const target = projectorVolumeTarget(Number(volEl.value), direction);
  volEl.value = String(target);
  volHoldUntil = performance.now() + 600;
  void detachedBridge?.transportCommand?.('setVolume', target).catch(() => undefined);
}

window.addEventListener('keydown', (event) => {
  const action = projectorKeyAction(event, hostPlatform);
  if (action === 'toggle-fullscreen') {
    event.preventDefault();
    toggleFullscreen();
  } else if (action === 'exit-fullscreen') {
    event.preventDefault();
    if (detachedBridge?.setFullscreen) {
      void detachedBridge.setFullscreen(false).then(() => {
        isFullscreen = false;
        fsBtn.title = 'Enter exclusive fullscreen (F11)';
        updateDragBar();
      }).catch((err: unknown) => {
        console.error('[eviland-detached] setFullscreen(false) failed', err);
      });
    }
  } else if (action === 'toggle-play') {
    event.preventDefault();
    void detachedBridge?.transportCommand?.('togglePlay').catch(() => undefined);
  } else if (action === 'next') {
    event.preventDefault();
    void detachedBridge?.transportCommand?.('next').catch(() => undefined);
  } else if (action === 'previous') {
    event.preventDefault();
    void detachedBridge?.transportCommand?.('prev').catch(() => undefined);
  } else if (action === 'seek-forward' || action === 'seek-backward') {
    if (!lastTransport) return;
    event.preventDefault();
    const target = projectorSeekTarget(lastTransport, action === 'seek-forward' ? PROJECTOR_SEEK_STEP : -PROJECTOR_SEEK_STEP);
    void detachedBridge?.transportCommand?.('seek', target).catch(() => undefined);
  } else if (action === 'volume-up' || action === 'volume-down') {
    event.preventDefault();
    stepVolume(action === 'volume-up' ? 1 : -1);
  }
});

window.addEventListener('beforeunload', () => {
  try {
    stopDisplayWatch();
    contextWatch?.dispose();
    frameFallback?.dispose();
    renderer?.dispose();
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
    compositionActive: bcMounted,
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
