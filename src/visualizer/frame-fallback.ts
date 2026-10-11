// The picture a host paints from Eviland frames when the GPU renderer has no
// context to draw on (see context-fallback.ts): the look's palette, the
// spectrum along the bottom and a ring that follows the kick. Plain Canvas 2D,
// behind the CPU flash guard.
import type { EvilandPalette } from './eviland';
import type { EvilandFrame } from './eviland-audio';
import { guardCanvas2d } from './flash-guard-host';

/** The slice of CanvasRenderingContext2D the picture uses, so it can be drawn against a recording stand-in. */
export interface FallbackContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  stroke(): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
}

const unit = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
const channel = (v: number): number => Math.round(unit(v) * 255);
const rgb = (c: readonly number[]): string => `rgb(${channel(c[0]!)}, ${channel(c[1]!)}, ${channel(c[2]!)})`;
const rgba = (c: readonly number[], a: number): string => `rgba(${channel(c[0]!)}, ${channel(c[1]!)}, ${channel(c[2]!)}, ${unit(a).toFixed(3)})`;

/** Draw one frame at `w` x `h` CSS pixels. Every input is clamped, so a bad frame draws as a quiet one. */
export function drawFrameFallback(
  ctx: FallbackContext,
  w: number,
  h: number,
  frame: EvilandFrame,
  palette: EvilandPalette,
  timeMs: number,
): void {
  const energy = unit(frame.energy);
  const kick = unit(frame.kick);
  const bass = unit(frame.bass);
  const size = Math.min(w, h);

  ctx.fillStyle = rgb(palette.bg);
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, size * (0.35 + 0.35 * energy));
  glow.addColorStop(0, rgba(palette.accent, 0.12 + 0.5 * energy));
  glow.addColorStop(1, rgba(palette.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const count = Math.min(24, frame.bands.length);
  if (count > 0) {
    const slot = w / count;
    for (let i = 0; i < count; i++) {
      const height = unit(frame.bands[i]!) * h * 0.4;
      // Dark at the low end, light at the top, so the bars carry the whole palette.
      ctx.fillStyle = rgba(i < count / 2 ? palette.dark : palette.light, 0.35 + 0.5 * unit(frame.bands[i]!));
      ctx.fillRect(i * slot + slot * 0.1, h - height, slot * 0.8, height);
    }
  }

  ctx.strokeStyle = rgba(palette.accent, 0.35 + 0.5 * kick);
  ctx.lineWidth = 2 + kick * 6;
  ctx.beginPath();
  const sway = Number.isFinite(timeMs) ? Math.sin(timeMs / 600) : 0;
  ctx.arc(w / 2, h / 2, size * (0.16 + 0.1 * bass + 0.08 * kick + 0.01 * sway), 0, Math.PI * 2);
  ctx.stroke();
}

export interface FrameFallbackPainter {
  paint(frame: EvilandFrame, palette: EvilandPalette, nowMs: number): void;
  dispose(): void;
}

/** Paint `canvas` (one that has never held a WebGL context) from frames, behind the flash guard. */
export function createFrameFallbackPainter(canvas: HTMLCanvasElement): FrameFallbackPainter {
  const guard = guardCanvas2d(canvas);
  let lastAt = 0;
  return {
    paint(frame, palette, nowMs) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const cssW = canvas.clientWidth || window.innerWidth;
      const cssH = canvas.clientHeight || window.innerHeight;
      const width = Math.max(2, Math.floor(cssW * dpr));
      const height = Math.max(2, Math.floor(cssH * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFrameFallback(ctx, cssW, cssH, frame, palette, nowMs);
      guard.apply(lastAt ? nowMs - lastAt : 1000 / 30);
      lastAt = nowMs;
    },
    dispose: () => guard.dispose(),
  };
}
