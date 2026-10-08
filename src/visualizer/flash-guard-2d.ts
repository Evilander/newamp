// Flash guard for Canvas 2D output that has no WebGL2 to present through:
// machines where WebGL is blocklisted, and the 2D fallback painters that run
// when a GPU renderer failed to start. It runs the flash-guard.ts spec on the
// CPU from a small readback: a nearest-neighbour downscale, so every tap is
// one real pixel, linearised on its own (an averaging downscale blends the
// sRGB-encoded values first and reads fine bright texture far too dark). The
// result goes back on with two composite draws: 'saturation' with grey pulls
// red toward grey of equal luminance, 'multiply' scales. A multiply can't
// lift, or treat the pixels of a tile differently, so each tile takes the
// lowest gain any of its taps or its neighbours' taps needs: this route keeps
// the darkening half of compression and holds whole tiles. Whenever anything
// was limited the canvas is sampled again, so the trackers follow what was
// really shown.
//
// Everything a GPU is available for goes through flash-guard-gl.ts instead:
// this path costs a synchronous readback per frame.

import {
  FLASH_GUARD_COLS,
  FLASH_GUARD_ROWS,
  HAZARD_AREA,
  createFlashGuardState,
  createTapFrame,
  guardTap,
  resizeFlashGuard,
  stepFlashGuard,
  tapGrid,
  tapPixel,
  tapsFromRgba,
  tileOfTap,
  type FlashGuardState,
  type GuardedPixel,
  type TapFrame,
  type TapGrid,
} from './flash-guard';

export interface CanvasFlashGuard {
  /** Guard what was just painted on a 2D `canvas`, in place. */
  apply(canvas: HTMLCanvasElement, dtMs: number, screenFraction: number): void;
  reset(): void;
}

const COLS = FLASH_GUARD_COLS;
const ROWS = FLASH_GUARD_ROWS;
/** Taps per tile along each axis: enough to see texture, small enough to read back every frame. */
const TAPS_PER_TILE = 4;

function tapsFor(width: number, height: number): TapGrid {
  const grid = tapGrid(width, height);
  return { x: Math.min(grid.x, COLS * TAPS_PER_TILE), y: Math.min(grid.y, ROWS * TAPS_PER_TILE) };
}

export function createCanvasFlashGuard(): CanvasFlashGuard | null {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  const field = document.createElement('canvas');
  field.width = COLS;
  field.height = ROWS;
  const fieldCtx = field.getContext('2d');
  if (!probeCtx || !fieldCtx) return null;
  const fieldImage = fieldCtx.createImageData(COLS, ROWS);

  let state: FlashGuardState | null = null;
  let input: TapFrame | null = null;
  let shown: TapFrame | null = null;
  const tileGain = new Float32Array(COLS * ROWS);
  const tileDesat = new Float32Array(COLS * ROWS);
  const gain = new Float32Array(COLS * ROWS);
  const desat = new Float32Array(COLS * ROWS);
  const result: GuardedPixel = { gain: 1, desat: 1 };
  let hasShown = false;
  let fresh = true;

  const sample = (canvas: HTMLCanvasElement, out: TapFrame, taps: TapGrid): void => {
    probeCtx.imageSmoothingEnabled = false;
    probeCtx.drawImage(canvas, 0, 0, taps.x, taps.y);
    tapsFromRgba(probeCtx.getImageData(0, 0, taps.x, taps.y).data, taps.x, taps.y, out, taps.x, taps.y);
  };

  // One composite draw of a per-tile field, stretched bilinearly over the
  // canvas like the GPU field. `pixel` fills RGBA for a tile.
  const drawField = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    op: GlobalCompositeOperation,
    pixel: (tile: number, rgba: Uint8ClampedArray, at: number) => void,
  ): void => {
    for (let t = 0; t < COLS * ROWS; t++) pixel(t, fieldImage.data, t * 4);
    fieldCtx.putImageData(fieldImage, 0, 0);
    ctx.globalCompositeOperation = op;
    ctx.drawImage(field, 0, 0, COLS, ROWS, 0, 0, canvas.width, canvas.height);
  };

  return {
    apply(canvas, dtMs, screenFraction) {
      if (screenFraction < HAZARD_AREA || canvas.width < 1 || canvas.height < 1) {
        fresh = true;
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const taps = tapsFor(canvas.width, canvas.height);
      if (fresh || !state) {
        state = createFlashGuardState(canvas.width, canvas.height, { taps, maxBoost: 1 });
        hasShown = false;
        fresh = false;
      } else if (state.width !== canvas.width || state.height !== canvas.height) {
        const regrid = taps.x !== state.tapsX || taps.y !== state.tapsY;
        resizeFlashGuard(state, canvas.width, canvas.height, taps);
        if (regrid) hasShown = false;
      }
      if (!input || input.lum.length !== taps.x * taps.y) {
        input = createTapFrame(taps);
        shown = createTapFrame(taps);
        hasShown = false;
      }
      if (probe.width !== taps.x || probe.height !== taps.y) {
        probe.width = taps.x;
        probe.height = taps.y;
      }
      sample(canvas, input, taps);
      stepFlashGuard(state, input, hasShown ? shown : null, dtMs / 1000, screenFraction / (COLS * ROWS));

      // Each tile: the strictest of its taps (as the GPU would treat each of
      // those pixels), darkening only.
      tileGain.fill(1);
      tileDesat.fill(1);
      for (let j = 0; j < taps.y; j++) {
        const py = tapPixel(j, taps.y, canvas.height);
        const row = tileOfTap(j, taps.y, ROWS) * COLS;
        for (let i = 0; i < taps.x; i++) {
          const t = j * taps.x + i;
          guardTap(state, tapPixel(i, taps.x, canvas.width), py, input.lum[t]!, input.red[t]!, result);
          const tile = row + tileOfTap(i, taps.x, COLS);
          tileGain[tile] = Math.min(tileGain[tile]!, result.gain);
          tileDesat[tile] = Math.min(tileDesat[tile]!, result.desat);
        }
      }
      // The field is stretched bilinearly between tile centres, so each tile
      // also takes its neighbours' limits: every pixel of a limited tile then
      // gets at least that tile's.
      let limitsGain = false;
      let limitsRed = false;
      for (let ty = 0; ty < ROWS; ty++) {
        for (let tx = 0; tx < COLS; tx++) {
          let g = 1;
          let d = 1;
          for (let y = Math.max(0, ty - 1); y <= Math.min(ROWS - 1, ty + 1); y++) {
            for (let x = Math.max(0, tx - 1); x <= Math.min(COLS - 1, tx + 1); x++) {
              g = Math.min(g, tileGain[y * COLS + x]!);
              d = Math.min(d, tileDesat[y * COLS + x]!);
            }
          }
          gain[ty * COLS + tx] = g;
          desat[ty * COLS + tx] = d;
          if (g < 0.9999) limitsGain = true;
          if (d < 0.9999) limitsRed = true;
        }
      }
      if (limitsGain || limitsRed) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = true;
        if (limitsRed) {
          // Grey at (1 - desaturation) opacity: the blend keeps each pixel's
          // luminance and drops its saturation by that share.
          drawField(ctx, canvas, 'saturation', (t, rgba, at) => {
            rgba[at] = rgba[at + 1] = rgba[at + 2] = 128;
            rgba[at + 3] = Math.round((1 - desat[t]!) * 255);
          });
        }
        if (limitsGain) {
          // Canvas compositing multiplies encoded values; k^(1/2.2) there is
          // close to k in linear light for everything but near-black.
          drawField(ctx, canvas, 'multiply', (t, rgba, at) => {
            rgba[at] = rgba[at + 1] = rgba[at + 2] = Math.round(Math.pow(gain[t]!, 1 / 2.2) * 255);
            rgba[at + 3] = 255;
          });
        }
        ctx.restore();
        sample(canvas, shown!, taps);
      } else {
        shown!.lum.set(input.lum);
        shown!.red.set(input.red);
      }
      hasShown = true;
    },

    reset() {
      fresh = true;
    },
  };
}
