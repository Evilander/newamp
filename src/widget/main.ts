// Desktop widget page. A pure consumer, like the projector: no audio engine,
// no store, no framework. The main process pushes a snapshot of what is
// playing whenever it changes (and at least every five seconds of position);
// between snapshots the position is moved on from the clock. The buttons go
// back through the transport channel to the main window, where the player is.
//
// The page loads no theme stylesheet. Its materials are fixed, like the
// decks', and its one colour is taken from the cover.

import type { DeskWidgetSnapshot } from '@shared/types';
import './widget.css';

declare global {
  interface Window {
    __newampWidgetStats?: { snapshots: number };
  }
}

const bridge = window.deskWidget;

function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`widget markup is missing ${selector}`);
  return el;
}

const root = need<HTMLElement>('#widget');
const disc = need<HTMLElement>('[data-widget-disc]');
const art = need<HTMLImageElement>('[data-widget-art]');
const titleEl = need<HTMLElement>('[data-widget-title]');
const artistEl = need<HTMLElement>('[data-widget-artist]');
const elapsedEl = need<HTMLElement>('[data-widget-elapsed]');
const totalEl = need<HTMLElement>('[data-widget-total]');
const bar = need<HTMLElement>('[data-widget-bar]');
const playButton = need<HTMLButtonElement>('[data-widget-action="togglePlay"]');

const stats = { snapshots: 0 };
window.__newampWidgetStats = stats;

let snapshot: DeskWidgetSnapshot | null = null;
// The track the label shows, so a snapshot of the same track leaves it alone.
let artFor: number | null = null;

function positionNow(): number {
  if (!snapshot) return 0;
  const moved = snapshot.isPlaying ? Math.max(0, (Date.now() - snapshot.at) / 1000) : 0;
  const position = snapshot.position + moved;
  return snapshot.duration > 0 ? Math.min(position, snapshot.duration) : position;
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// The ring, the bar and the tonearm all read the one share of the track played.
function renderPosition(): void {
  const duration = snapshot?.duration ?? 0;
  const position = positionNow();
  const share = duration > 0 ? Math.min(1, position / duration) : 0;
  root.style.setProperty('--w-progress', share.toFixed(4));
  elapsedEl.textContent = formatTime(position);
  totalEl.textContent = duration > 0 ? formatTime(duration) : '';
  bar.setAttribute('aria-valuemax', String(Math.round(duration)));
  bar.setAttribute('aria-valuenow', String(Math.round(position)));
  bar.setAttribute('aria-valuetext', `${formatTime(position)} of ${formatTime(duration)}`);
}

/**
 * The cover's colour as a light: its pixels averaged by how colourful they
 * are, so a patch of colour on a mostly black sleeve still decides it, then
 * lifted until it reads against dark vinyl. Null when the cover cannot be read.
 */
function sampleAccent(image: HTMLImageElement): string | null {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  let data: Uint8ClampedArray;
  try {
    context.drawImage(image, 0, 0, size, size);
    data = context.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
  let red = 0;
  let green = 0;
  let blue = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const weight = chroma * chroma + 1;
    red += r * weight;
    green += g * weight;
    blue += b * weight;
    total += weight;
  }
  if (total === 0) return null;
  const lift = Math.max(1, 210 / Math.max(red / total, green / total, blue / total, 1));
  const channel = (sum: number): number => Math.round(Math.min(255, (sum / total) * lift));
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

function setArt(trackId: number | null): void {
  if (trackId === artFor) return;
  artFor = trackId;
  root.style.removeProperty('--w-accent');
  if (trackId === null) {
    art.removeAttribute('src');
    document.body.dataset.art = 'false';
    return;
  }
  const url = window.newamp.getArtUrl(trackId);
  art.onload = () => {
    if (artFor === trackId) document.body.dataset.art = 'true';
  };
  art.onerror = () => {
    if (artFor === trackId) document.body.dataset.art = 'false';
  };
  art.src = url;
  // Read through a second image: the art scheme is another origin from the
  // page, and only an image fetched as cross-origin can be read back from a
  // canvas. The label still shows if this one fails.
  const probe = new Image();
  probe.crossOrigin = 'anonymous';
  probe.onload = () => {
    if (artFor !== trackId) return;
    const accent = sampleAccent(probe);
    if (accent) root.style.setProperty('--w-accent', accent);
  };
  probe.src = url;
}

function render(next: DeskWidgetSnapshot): void {
  snapshot = next;
  stats.snapshots += 1;
  const loaded = next.title !== null;
  document.body.dataset.layout = next.layout;
  document.body.dataset.playing = String(next.isPlaying);
  document.body.dataset.loaded = String(loaded);
  titleEl.textContent = next.title ?? 'NewAmp';
  artistEl.textContent = loaded ? (next.artist ?? '') : 'Nothing playing';
  playButton.setAttribute('aria-label', next.isPlaying ? 'Pause' : 'Play');
  playButton.title = next.isPlaying ? 'Pause' : 'Play';
  setArt(next.trackId);
  renderPosition();
}

const controlSelector = 'button, [data-widget-bar]';
const onControl = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(controlSelector) !== null;

// --- Moving the window --------------------------------------------------
//
// The page drags its own window. A drag region would be simpler, but it
// swallows clicks, hover and the right-click over everything it covers, and
// the record is nearly the whole widget.
const DRAG_SLOP_PX = 4;
let drag: { pointer: number; startX: number; startY: number; windowX: number; windowY: number; moved: boolean } | null = null;
// A drag ends with a click on whatever was under the pointer; that one is not a press.
let dragJustEnded = false;

root.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || onControl(event.target)) return;
  drag = {
    pointer: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    windowX: window.screenX,
    windowY: window.screenY,
    moved: false,
  };
});

root.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointer) return;
  const dx = event.screenX - drag.startX;
  const dy = event.screenY - drag.startY;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    // The pointer is captured only once it is a drag. Captured from the press,
    // the click that ends a plain press would be delivered here and never
    // reach the record.
    root.setPointerCapture(event.pointerId);
  }
  drag.moved = true;
  // Sent for every move, not once a frame: a widget on the desktop is often
  // partly under other windows, and a covered window's frames are throttled.
  bridge.moveTo(drag.windowX + dx, drag.windowY + dy);
});

function endDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointer) return;
  const moved = drag.moved;
  drag = null;
  if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
  if (!moved) return;
  dragJustEnded = true;
  window.setTimeout(() => {
    dragJustEnded = false;
  }, 0);
}
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);

// --- Controls -----------------------------------------------------------

// A click on the record plays or pauses, a double-click opens NewAmp. The
// single click waits out the double-click interval so opening the app does
// not also pause and resume the music on the way.
const DOUBLE_CLICK_MS = 240;
let discClick: number | null = null;

disc.addEventListener('click', () => {
  if (dragJustEnded || discClick !== null) return;
  discClick = window.setTimeout(() => {
    discClick = null;
    void bridge.transport('togglePlay');
  }, DOUBLE_CLICK_MS);
});

disc.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  void bridge.transport('togglePlay');
});

root.addEventListener('dblclick', (event) => {
  if (onControl(event.target)) return;
  if (discClick !== null) {
    window.clearTimeout(discClick);
    discClick = null;
  }
  bridge.showMain();
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-widget-action]')) {
  const action = button.dataset.widgetAction;
  if (action !== 'prev' && action !== 'next' && action !== 'togglePlay') continue;
  button.addEventListener('click', () => void bridge.transport(action));
}

function seekTo(seconds: number): void {
  if (!snapshot || snapshot.duration <= 0) return;
  const target = Math.min(snapshot.duration, Math.max(0, seconds));
  // Shown at once; the player's own snapshot of the jump follows.
  snapshot = { ...snapshot, position: target, at: Date.now() };
  renderPosition();
  void bridge.transport('seek', target);
}

bar.addEventListener('click', (event) => {
  const rect = bar.getBoundingClientRect();
  if (!snapshot || rect.width <= 0) return;
  seekTo(((event.clientX - rect.left) / rect.width) * snapshot.duration);
});

bar.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  seekTo(positionNow() + (event.key === 'ArrowRight' ? 5 : -5));
});

need<HTMLButtonElement>('[data-widget-menu]').addEventListener('click', () => bridge.showMenu());
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  bridge.showMenu();
});

bridge.onSnapshot(render);
window.setInterval(renderPosition, 500);
// Last, so the first snapshot cannot be sent before the listener above exists.
bridge.ready();
