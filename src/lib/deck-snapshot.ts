// Deck Snapshot — the polaroid.
//
// The compact decks (record player, jukebox, cassette, …) are the app's most
// "send this to a friend" visuals, but the window is frameless so sharing one
// used to mean cropping an OS screenshot. This module takes the raw
// webContents.capturePage PNG of the compact window (IPC 'deck:snapshot') and
// prints it onto an instant-photo frame on an offscreen canvas:
//
//   - skin-toned paper border (colors sampled from the LIVE skin tokens —
//     --panel / --ink / --line / --muted — never hardcoded, so every skin
//     signs its own photo)
//   - caption strip: '{title} — {artist}'
//   - the deck skin's display name printed small, like a camera model stamp
//   - micro-line: 'NewAmp · github.com/evilander/newamp'
//
// Deck native window sizes vary per skin (decks/types.ts) and captures arrive
// at devicePixelRatio scale, so every frame dimension is proportional to the
// captured bitmap — the composer never assumes a shape.
//
// Delivery reuses the house capture plumbing: media:copy-png for the
// clipboard, media:save-capture for the save dialog, pushToast for status.

import { api } from './api';
import { pushToast } from './toast';

export interface DeckSnapshotCaption {
  /** Track title; empty string when nothing is loaded. */
  title: string;
  /** Track artist; empty string when unknown. */
  artist: string;
  /** Deck skin display name (decks/types.ts label), e.g. 'Record Player'. */
  skinLabel: string;
}

interface PolaroidPalette {
  paper: string;
  ink: string;
  line: string;
  muted: string;
  fontDisplay: string;
  fontMono: string;
}

/** Matches the :root defaults in styles/tokens.css; used only when sampling fails. */
const FALLBACK_PALETTE: PolaroidPalette = {
  paper: '#141b14',
  ink: '#cfead0',
  line: '#2a3a2a',
  muted: '#7a9c7a',
  fontDisplay: "'Inter', system-ui, sans-serif",
  fontMono: "'JetBrains Mono', 'Consolas', monospace",
};

const MICRO_LINE = 'NewAmp · github.com/evilander/newamp';

function readToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

/** Sample the live skin tokens the polaroid gets printed with. */
function samplePalette(): PolaroidPalette {
  if (typeof window === 'undefined' || typeof document === 'undefined') return FALLBACK_PALETTE;
  const styles = window.getComputedStyle(document.documentElement);
  return {
    paper: readToken(styles, '--panel', FALLBACK_PALETTE.paper),
    ink: readToken(styles, '--ink', FALLBACK_PALETTE.ink),
    line: readToken(styles, '--line', FALLBACK_PALETTE.line),
    muted: readToken(styles, '--muted', FALLBACK_PALETTE.muted),
    fontDisplay: readToken(styles, '--font-display', FALLBACK_PALETTE.fontDisplay),
    fontMono: readToken(styles, '--font-mono', FALLBACK_PALETTE.fontMono),
  };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolvePromise, rejectPromise) => {
    const image = new Image();
    image.onload = () => resolvePromise(image);
    image.onerror = () => rejectPromise(new Error('Deck snapshot image failed to decode'));
    image.src = dataUrl;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Ellipsize `text` until it fits `maxWidth` with the current ctx font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out.trimEnd()}…`;
}

/**
 * Print a raw compact-window capture onto the polaroid frame. Returns a PNG
 * data URL, or null if a 2D context is unavailable.
 */
export async function composeDeckPolaroid(
  captureDataUrl: string,
  caption: DeckSnapshotCaption,
): Promise<string | null> {
  const photo = await loadImage(captureDataUrl);
  const palette = samplePalette();

  // Frame proportions track the capture's own scale, clamped so the slim
  // 820x112 windowshade still gets a readable caption strip and a HiDPI
  // 1080px jukebox capture doesn't grow comic borders.
  const unit = Math.max(photo.width, photo.height);
  const border = Math.round(clamp(unit * 0.035, 18, 48));
  const captionH = Math.round(clamp(unit * 0.16, 84, 168));

  const width = photo.width + border * 2;
  const height = photo.height + border + captionH;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Paper + edge line.
  ctx.fillStyle = palette.paper;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  // Photo well — hairline frame around the pasted capture.
  ctx.drawImage(photo, border, border);
  ctx.lineWidth = 1;
  ctx.strokeRect(border - 0.5, border - 0.5, photo.width + 1, photo.height + 1);

  const innerLeft = border;
  const innerRight = width - border;
  const innerWidth = innerRight - innerLeft;
  const stripTop = border + photo.height;

  // Caption: '{title} — {artist}'.
  const captionLine = caption.title
    ? caption.artist
      ? `${caption.title} — ${caption.artist}`
      : caption.title
    : 'Nothing playing';
  const titleSize = Math.round(clamp(captionH * 0.3, 18, 44));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = palette.ink;
  ctx.font = `700 ${titleSize}px ${palette.fontDisplay}`;
  ctx.fillText(fitText(ctx, captionLine, innerWidth), innerLeft, stripTop + captionH * 0.46);

  // Micro row: brand line on the left, deck skin as the camera-model print on
  // the right. Shrink the mono size until both fit side by side (narrow decks
  // like the 420px jukebox need a step or two down).
  const model = caption.skinLabel.toUpperCase();
  let microSize = Math.round(clamp(captionH * 0.15, 10, 20));
  const gap = Math.round(captionH * 0.18);
  while (microSize > 9) {
    ctx.font = `600 ${microSize}px ${palette.fontMono}`;
    const needed = ctx.measureText(MICRO_LINE).width + gap + ctx.measureText(model).width;
    if (needed <= innerWidth) break;
    microSize -= 1;
  }
  ctx.font = `600 ${microSize}px ${palette.fontMono}`;
  const microBaseline = stripTop + captionH * 0.8;
  ctx.fillStyle = palette.muted;
  const modelWidth = ctx.measureText(model).width;
  ctx.fillText(
    fitText(ctx, MICRO_LINE, Math.max(0, innerWidth - modelWidth - gap)),
    innerLeft,
    microBaseline,
  );
  ctx.textAlign = 'right';
  ctx.fillText(model, innerRight, microBaseline);

  return canvas.toDataURL('image/png');
}

// Button and Ctrl+Shift+S can race; the flow also opens a modal save dialog,
// so a second trigger mid-flight must coalesce into a no-op.
let snapshotInFlight = false;

/**
 * Full Deck Snapshot flow: capture the compact window over IPC, print the
 * polaroid, copy it to the clipboard, then offer the standard save dialog
 * (clipboard already has the PNG if the user cancels). Returns true when a
 * polaroid was produced.
 */
export async function captureDeckSnapshot(caption: DeckSnapshotCaption): Promise<boolean> {
  if (snapshotInFlight) return false;
  snapshotInFlight = true;
  try {
    const raw = await api.captureDeckSnapshotPng();
    if (!raw) {
      pushToast({
        tone: 'warn',
        title: 'Snapshot unavailable',
        detail: 'Deck capture needs the desktop app.',
      });
      return false;
    }
    const framed = await composeDeckPolaroid(raw, caption);
    if (!framed) {
      pushToast({ tone: 'error', title: 'Snapshot failed' });
      return false;
    }
    const copied = await api.copyPngToClipboard(framed);
    if (copied) pushToast({ tone: 'ok', title: 'Snapshot copied to clipboard' });
    const base64 = framed.slice(framed.indexOf(',') + 1);
    const defaultName = caption.title
      ? `NewAmp ${caption.skinLabel} - ${caption.title}`
      : `NewAmp ${caption.skinLabel}`;
    const saved = await api.saveCaptureBytes({
      base64,
      defaultName,
      filterName: 'PNG image',
      ext: 'png',
    });
    if (saved) pushToast({ tone: 'ok', title: 'Snapshot saved', detail: saved });
    return true;
  } catch (err) {
    console.error('[newamp] deck snapshot failed', err);
    pushToast({ tone: 'error', title: 'Snapshot failed' });
    return false;
  } finally {
    snapshotInFlight = false;
  }
}
