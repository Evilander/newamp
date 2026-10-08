// Flash guard — the photosensitivity limiter every visualizer output passes
// through last.
//
// WCAG 2.3.1 and the Harding / ITU-R BT.1702 tests it comes from count a
// general flash as a pair of opposing changes in relative luminance of 0.1 or
// more where the darker state is below 0.8, and a red flash as a pair of
// opposing transitions to or from saturated red. Content is hazardous when it
// shows more than three of either in any one second over a large enough area
// flashing together.
//
// The guard samples the DISPLAYED image at a grid of point taps (every pixel
// of a small canvas, up to 16x16 per tile of a 32x18 grid on a large one,
// each at a fixed pseudo-random spot in its cell so fine periodic texture
// can't flash between them) and holds every hazard-sized block of it to six
// displayed transitions (three flashes) in any one-second window:
//
//   - A block is HAZARD_AREA of the screen, sized from how much of the screen
//     the canvas covers. HAZARD_AREA assumes a 10° field is at least 4% of the
//     screen: WCAG's own approximation (a 341x256 block on a 1024x768 display)
//     puts 25% of it at 2.8% of the screen, a 27" monitor at 60 cm at about
//     1.1%, so 1% sits under both.
//   - Every tap runs its own peak/valley trackers, on luminance and on red
//     saturation. A block makes a transition when its mean moves by one, or
//     when AREA_FRACTION of its taps complete the same transition together.
//     The mean alone misses flicker whose pixels flash out of step: in a
//     reversing checkerboard, or bright texture over part of a block, opposite
//     phases cancel and the mean stays flat while most of the block flashes.
//     Rises and falls alternate per block, so a transition seen both ways
//     counts once, dated by the last of what saw it.
//   - While a block's input flashes faster than about three a second, each
//     pixel is compressed toward its own recent level: held in a band of
//     2 x BAND_HALF under the lower of its running level and what its darkest
//     recent frames can be lifted to (at most MAX_BOOST). Bright frames are
//     scaled down, dark ones up, so a pumping look keeps its colour and most
//     of its brightness and loses the strobe, out-of-step flicker included.
//     Gain can't lift black, so a pixel flashing up from black is held near
//     black.
//   - A block may start a new rise only while it still has room for the fall
//     that follows (and for any fall the other tracker still owes); past that
//     every tap of it is capped within HOLD of its own last trough, and its
//     mean within HOLD of the mean's. The trackers measure what was actually
//     displayed, so these caps are the guarantee the rest rests on.
//   - Saturated red is only ever pulled toward grey, the same way.
//   - Released blocks ease back to their input instead of popping.
//
// This file is the specification: plain TypeScript on tap grids that the
// tests drive directly and the Canvas 2D fallback runs as-is. flash-guard-gl.ts
// runs the same steps as a few small WebGL2 passes, with the same constants,
// so no route needs a readback.

export const FLASH_GUARD_COLS = 32;
export const FLASH_GUARD_ROWS = 18;
/** Most taps per tile along either axis; a smaller tile has one per pixel. */
export const MAX_TAPS_PER_TILE = 16;
/** Sliding window the transition budget applies to, seconds. */
export const FLASH_WINDOW_S = 1;
/** A transition still counts while it is younger than this: the window, less
 *  a margin far under a frame, so one exactly a window old (60 frames at 60
 *  Hz, which an analyser counts in the next window) is let go however float
 *  rounding added its age up, on the CPU and the GPU alike. */
export const RECENT_S = FLASH_WINDOW_S - 1e-4;
/** Displayed transitions allowed per window: six is three flashes. */
export const MAX_TRANSITIONS = 6;
/** WCAG general flash: opposing luminance changes of at least this much... */
export const GENERAL_DELTA = 0.1;
/** ...where the darker state is below this. */
export const DARK_LIMIT = 0.8;
/** A pixel is saturated red when R / (R + G + B) is at least this (linear). */
export const RED_RATIO = 0.8;
/** Red transitions on the R − G − B scale flash analysers use (20 of 320). */
export const RED_DELTA = 0.0625;
/** How far above its trough a held tap or block may ripple: under the deltas
 *  above, with room for what the taps don't see between them. */
export const HOLD_GENERAL = 0.06;
export const HOLD_RED = 0.04;
/** Input transition rate (decaying count, τ = 1 s) above which the input
 *  itself breaks the limit (steady 3 Hz peaks at about 6.5): the block is
 *  compressed while it does, instead of stuttering through at the maximum
 *  rate. */
export const OVER_RATE = 6.5;
export const RATE_TAU_S = 1;
/** Screen fraction one block covers. */
export const HAZARD_AREA = 0.01;
/** Share of a block's taps that must complete the same transition together
 *  for the block to count one. WCAG's area is a quarter of a 10° field and a
 *  block is no bigger than that quarter, so a quarter of a block errs well on
 *  the small side. */
export const AREA_FRACTION = 0.25;
/** "Together": tap transitions this close in time add up (a wipe that takes a
 *  frame or two to cross a block is one transition, not several small ones). */
export const AREA_TAU_S = 0.025;
/** Half-width of a compressed pixel's band, how slowly its running level
 *  follows the input, and how slowly its floor lets go of a dark frame. */
export const BAND_HALF = 0.025;
export const LEVEL_TAU_S = 0.5;
export const FLOOR_TAU_S = 2;
/** Most a compressed pixel's dark frames are lifted, in linear light. */
export const MAX_BOOST = 2.5;
/** How fast compression and the tap caps let go once they're not needed, per
 *  second, and how fast a released block mean or red level climbs back. */
export const RELEASE_PER_S = 3;
export const RECOVER_GENERAL_PER_S = 1.5;
export const RECOVER_RED_PER_S = 1;
/** Age that marks an empty transition slot. */
export const EMPTY_AGE = 99;

/** One frame's point samples, row by row: linear relative luminance and red saturation. */
export interface TapFrame {
  lum: Float32Array;
  red: Float32Array;
}

export interface TapGrid {
  x: number;
  y: number;
}

export interface BlockShape {
  w: number;
  h: number;
}

/** Block means and the share of each block's taps that rose or fell this frame. */
interface BlockStats {
  lum: Float32Array;
  red: Float32Array;
  riseL: Float32Array;
  fallL: Float32Array;
  riseQ: Float32Array;
  fallQ: Float32Array;
}

export interface FlashGuardState {
  cols: number;
  rows: number;
  /** Taps per axis, and the size in pixels of the image they sample. */
  tapsX: number;
  tapsY: number;
  width: number;
  height: number;
  /** Most a pixel is lifted: MAX_BOOST, or 1 on a route that can only darken. */
  maxBoost: number;

  // Per tap. Trackers keep extremum and phase apart; phase -1 tracks a trough
  // looking for a rise, +1 a peak looking for a fall.
  tapInExtL: Float32Array;
  tapInPhaseL: Int8Array;
  tapInExtQ: Float32Array;
  tapInPhaseQ: Int8Array;
  /** Input luminance followed with τ = LEVEL_TAU_S. */
  level: Float32Array;
  /** Recent input minimum, letting go toward `level` with τ = FLOOR_TAU_S. */
  floor: Float32Array;
  tapOutExtL: Float32Array;
  tapOutPhaseL: Int8Array;
  tapOutExtQ: Float32Array;
  tapOutPhaseQ: Int8Array;
  /** Whether the taps have seen a frame yet: levels start from the first
   *  input, displayed trackers from the first frame shown. */
  inSeeded: boolean;
  outSeeded: boolean;

  // Per block, one for the block around each tile.
  meanInExtL: Float32Array;
  meanInPhaseL: Int8Array;
  meanInExtQ: Float32Array;
  meanInPhaseQ: Int8Array;
  meanOutExtL: Float32Array;
  meanOutPhaseL: Int8Array;
  meanOutExtQ: Float32Array;
  meanOutPhaseQ: Int8Array;
  /** Which way each block's last transition went (-1 fall, +1 rise), input
   *  and displayed, luminance and red. */
  inDirL: Int8Array;
  inDirQ: Int8Array;
  outDirL: Int8Array;
  outDirQ: Int8Array;
  /** Tap transitions adding up toward AREA_FRACTION, four per block: rising
   *  and falling luminance, rising and falling red. */
  areaIn: Float32Array;
  areaOut: Float32Array;
  /** Decaying counts of input transitions, τ = RATE_TAU_S: luminance, red. */
  rate: Float32Array;
  rateQ: Float32Array;
  /** Ages of the last MAX_TRANSITIONS displayed transitions, per block, and
   *  which slot holds each tracker's latest (-1 for none yet). */
  ages: Float32Array;
  lastL: Int8Array;
  lastQ: Int8Array;
  /** How strongly the block is compressed, its taps held, its red held: 1
   *  while needed, then easing to 0 at RELEASE_PER_S. */
  compress: Float32Array;
  holdL: Float32Array;
  holdQ: Float32Array;
  /** Cap on the block's mean luminance and red, easing up after a hold
   *  (Infinity when free). */
  capL: Float32Array;
  capQ: Float32Array;
  /** This frame's plan per block: the most gain its mean cap allows, and its
   *  red desaturation. */
  blockCeil: Float32Array;
  blockDesat: Float32Array;

  // Per tile: what the taps and pixels around it are guarded with, the
  // strictest of every block covering it or a neighbour (the field is
  // bilinear between tile centres, so that margin reaches every pixel).
  ceil: Float32Array;
  desat: Float32Array;
  compressField: Float32Array;
  holdLField: Float32Array;
  holdQField: Float32Array;

  // Scratch.
  tapDirInL: Int8Array;
  tapDirInQ: Int8Array;
  tapDirOutL: Int8Array;
  tapDirOutQ: Int8Array;
  tileSums: Float32Array;
  blockIn: BlockStats;
  blockShown: BlockStats;
}

/** Taps per axis for an image `width` x `height` pixels. */
export function tapGrid(width: number, height: number, cols = FLASH_GUARD_COLS, rows = FLASH_GUARD_ROWS): TapGrid {
  return {
    x: Math.max(cols, Math.min(Math.round(width), cols * MAX_TAPS_PER_TILE)),
    y: Math.max(rows, Math.min(Math.round(height), rows * MAX_TAPS_PER_TILE)),
  };
}

/**
 * The pixel column (or row) that tap `i` of `taps` samples on a `size`-pixel
 * axis, `at` 256ths of the way across its cell (128: the middle). Integer
 * arithmetic, so the GPU picks the same pixel. With a tap per pixel, the
 * pixel is the tap's own.
 */
export function tapPixel(i: number, taps: number, size: number, at = 128): number {
  return Math.min(size - 1, Math.floor(((i * 256 + at) * size) / (taps * 256)));
}

/**
 * Where in its cell tap (i, j) samples, as two bytes (x low, y next) of an
 * integer hash of its index. A regular lattice of taps aliases with periodic
 * texture: at two pixels per tap it would sample only odd columns, and a
 * strobe on the even ones would go unseen. Fixed per tap, so its trackers
 * follow one pixel. The GLSL tapHash() is this, bit for bit.
 */
export function tapHash(i: number, j: number): number {
  let h = (Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** The pixel column tap (i, j) samples in an image `width` wide. */
export function tapX(i: number, j: number, tapsX: number, width: number): number {
  return tapPixel(i, tapsX, width, tapHash(i, j) & 255);
}

/** The pixel row tap (i, j) samples in an image `height` high. */
export function tapY(i: number, j: number, tapsY: number, height: number): number {
  return tapPixel(j, tapsY, height, (tapHash(i, j) >>> 8) & 255);
}

/** The tile column (or row) that tap `i` belongs to. */
export function tileOfTap(i: number, taps: number, count: number): number {
  return Math.floor((i * count) / taps);
}

export function createTapFrame(taps: TapGrid): TapFrame {
  return { lum: new Float32Array(taps.x * taps.y), red: new Float32Array(taps.x * taps.y) };
}

function createBlockStats(n: number): BlockStats {
  return {
    lum: new Float32Array(n),
    red: new Float32Array(n),
    riseL: new Float32Array(n),
    fallL: new Float32Array(n),
    riseQ: new Float32Array(n),
    fallQ: new Float32Array(n),
  };
}

/**
 * Guard state for an image `width` x `height` pixels sampled at `taps` (by
 * default tapGrid's). `maxBoost` is 1 for a route that can only darken.
 */
export function createFlashGuardState(
  width: number,
  height: number,
  options: { taps?: TapGrid; maxBoost?: number; cols?: number; rows?: number } = {},
): FlashGuardState {
  const cols = options.cols ?? FLASH_GUARD_COLS;
  const rows = options.rows ?? FLASH_GUARD_ROWS;
  const taps = options.taps ?? tapGrid(width, height, cols, rows);
  const t = taps.x * taps.y;
  const n = cols * rows;
  const state: FlashGuardState = {
    cols,
    rows,
    tapsX: taps.x,
    tapsY: taps.y,
    width,
    height,
    maxBoost: options.maxBoost ?? MAX_BOOST,
    tapInExtL: new Float32Array(t),
    tapInPhaseL: new Int8Array(t),
    tapInExtQ: new Float32Array(t),
    tapInPhaseQ: new Int8Array(t),
    level: new Float32Array(t),
    floor: new Float32Array(t),
    tapOutExtL: new Float32Array(t),
    tapOutPhaseL: new Int8Array(t),
    tapOutExtQ: new Float32Array(t),
    tapOutPhaseQ: new Int8Array(t),
    inSeeded: false,
    outSeeded: false,
    meanInExtL: new Float32Array(n),
    meanInPhaseL: new Int8Array(n),
    meanInExtQ: new Float32Array(n),
    meanInPhaseQ: new Int8Array(n),
    meanOutExtL: new Float32Array(n),
    meanOutPhaseL: new Int8Array(n),
    meanOutExtQ: new Float32Array(n),
    meanOutPhaseQ: new Int8Array(n),
    inDirL: new Int8Array(n),
    inDirQ: new Int8Array(n),
    outDirL: new Int8Array(n),
    outDirQ: new Int8Array(n),
    areaIn: new Float32Array(n * 4),
    areaOut: new Float32Array(n * 4),
    rate: new Float32Array(n),
    rateQ: new Float32Array(n),
    ages: new Float32Array(n * MAX_TRANSITIONS),
    lastL: new Int8Array(n),
    lastQ: new Int8Array(n),
    compress: new Float32Array(n),
    holdL: new Float32Array(n),
    holdQ: new Float32Array(n),
    capL: new Float32Array(n),
    capQ: new Float32Array(n),
    blockCeil: new Float32Array(n),
    blockDesat: new Float32Array(n),
    ceil: new Float32Array(n),
    desat: new Float32Array(n),
    compressField: new Float32Array(n),
    holdLField: new Float32Array(n),
    holdQField: new Float32Array(n),
    tapDirInL: new Int8Array(t),
    tapDirInQ: new Int8Array(t),
    tapDirOutL: new Int8Array(t),
    tapDirOutQ: new Int8Array(t),
    tileSums: new Float32Array(n * 7),
    blockIn: createBlockStats(n),
    blockShown: createBlockStats(n),
  };
  resetFlashGuardState(state);
  return state;
}

export function resetFlashGuardState(state: FlashGuardState): void {
  // A new surface appears over black, so every block tracker starts at a
  // trough of 0: the first bright frame is a rise, as a viewer would see it.
  for (const a of [state.meanInExtL, state.meanInExtQ, state.meanOutExtL, state.meanOutExtQ]) a.fill(0);
  for (const a of [state.meanInPhaseL, state.meanInPhaseQ, state.meanOutPhaseL, state.meanOutPhaseQ]) a.fill(-1);
  for (const a of [state.inDirL, state.inDirQ, state.outDirL, state.outDirQ]) a.fill(-1);
  state.areaIn.fill(0);
  state.areaOut.fill(0);
  state.rate.fill(0);
  state.rateQ.fill(0);
  state.ages.fill(EMPTY_AGE);
  state.lastL.fill(-1);
  state.lastQ.fill(-1);
  state.compress.fill(0);
  state.holdL.fill(0);
  state.holdQ.fill(0);
  state.capL.fill(Infinity);
  state.capQ.fill(Infinity);
  state.blockCeil.fill(state.maxBoost);
  state.blockDesat.fill(1);
  state.ceil.fill(state.maxBoost);
  state.desat.fill(1);
  state.compressField.fill(0);
  state.holdLField.fill(0);
  state.holdQField.fill(0);
  resetFlashGuardTaps(state);
}

/**
 * Forget the tap history only (the image size changed): the taps start over
 * while every block keeps its budget. Like a new surface, each tap starts at
 * a trough of 0, so a bright tap's first frame counts as a rise: a guess that
 * can only spend budget, never hide a flash.
 */
export function resetFlashGuardTaps(state: FlashGuardState): void {
  state.inSeeded = false;
  state.outSeeded = false;
  state.tapInExtL.fill(0);
  state.tapInPhaseL.fill(-1);
  state.tapInExtQ.fill(0);
  state.tapInPhaseQ.fill(-1);
  // No tap is capped before anything has been shown through this grid.
  state.tapOutPhaseL.fill(1);
  state.tapOutPhaseQ.fill(1);
  state.tapOutExtL.fill(1);
  state.tapOutExtQ.fill(1);
  state.tapDirInL.fill(0);
  state.tapDirInQ.fill(0);
  state.tapDirOutL.fill(0);
  state.tapDirOutQ.fill(0);
}

/**
 * Follow the image to a new size. When that changes the tap grid the taps
 * start over (resetFlashGuardTaps); every block keeps its trackers and budget,
 * so a resize mid-strobe doesn't hand it a fresh allowance.
 */
export function resizeFlashGuard(state: FlashGuardState, width: number, height: number, taps = tapGrid(width, height, state.cols, state.rows)): void {
  state.width = width;
  state.height = height;
  if (taps.x === state.tapsX && taps.y === state.tapsY) return;
  const t = taps.x * taps.y;
  state.tapsX = taps.x;
  state.tapsY = taps.y;
  for (const key of ['tapInExtL', 'tapInExtQ', 'level', 'floor', 'tapOutExtL', 'tapOutExtQ'] as const) state[key] = new Float32Array(t);
  for (const key of ['tapInPhaseL', 'tapInPhaseQ', 'tapOutPhaseL', 'tapOutPhaseQ', 'tapDirInL', 'tapDirInQ', 'tapDirOutL', 'tapDirOutQ'] as const) state[key] = new Int8Array(t);
  resetFlashGuardTaps(state);
}

/**
 * Tiles per block for a canvas whose tiles each cover `tileArea` of the
 * screen: enough of them to make HAZARD_AREA, as square as the grid allows.
 */
export function blockShape(tileArea: number, cols = FLASH_GUARD_COLS, rows = FLASH_GUARD_ROWS): BlockShape {
  const tiles = Math.min(cols * rows, Math.max(1, Math.ceil(HAZARD_AREA / Math.max(1e-9, tileArea) - 1e-6)));
  let w = Math.min(cols, Math.max(1, Math.round(Math.sqrt(tiles))));
  const h = Math.min(rows, Math.max(1, Math.ceil(tiles / w)));
  if (w * h < tiles) w = Math.min(cols, Math.ceil(tiles / h));
  return { w, h };
}

/** First tile of the block around tile `i`, kept whole inside the grid. */
export function blockOrigin(i: number, size: number, count: number): number {
  return Math.max(0, Math.min(count - size, i - Math.floor(size / 2)));
}

/**
 * Advance one peak/valley tracker by one value. Returns +1 when `v` completes
 * a rise of at least `delta` from a trough below `darkLimit`, -1 when it
 * completes a fall of at least `delta` to a value below it, else 0. The GLSL
 * `track()` is this, line for line.
 */
function track(ext: Float32Array, phase: Int8Array, i: number, v: number, delta: number, darkLimit: number): number {
  if (phase[i]! < 0) {
    if (v < ext[i]!) {
      ext[i] = v;
    } else if (v - ext[i]! >= delta && ext[i]! < darkLimit) {
      phase[i] = 1;
      ext[i] = v;
      return 1;
    }
  } else if (v > ext[i]!) {
    ext[i] = v;
  } else if (ext[i]! - v >= delta && v < darkLimit) {
    phase[i] = -1;
    ext[i] = v;
    return -1;
  }
  return 0;
}

/**
 * One block transition, if this frame makes one: the mean's own transition
 * (`mean`, +1 or -1) or AREA_FRACTION of the taps rising or falling together
 * (`rise`, `fall`, added up over AREA_TAU_S in `area` from `at`). Rises and
 * falls alternate, so the same transition seen by the mean and by the taps,
 * or by the taps over two frames, counts once, while a pattern whose halves
 * swap every frame counts every swap. Returns 1 for a new transition, -1 for
 * more evidence of the last one (the taps fell a frame before the mean did),
 * else 0.
 */
function blockTransition(
  dir: Int8Array,
  area: Float32Array,
  i: number,
  at: number,
  mean: number,
  rise: number,
  fall: number,
  keep: number,
): number {
  const up = area[at]! * keep + rise;
  const down = area[at + 1]! * keep + fall;
  area[at] = up;
  area[at + 1] = down;
  const rising = mean > 0 || up >= AREA_FRACTION;
  const falling = mean < 0 || down >= AREA_FRACTION;
  if (dir[i]! < 0 ? rising : falling) {
    dir[i] = -dir[i]!;
    area[dir[i]! > 0 ? at : at + 1] = 0;
    return 1;
  }
  if (dir[i]! < 0 ? falling : rising) {
    area[dir[i]! > 0 ? at : at + 1] = 0;
    return -1;
  }
  return 0;
}

/**
 * Record what a block's tracker saw, `age` seconds ago: a new transition
 * (`seen` 1) over the oldest slot, or more evidence of its last one (-1),
 * which re-dates that one. Dating a transition by its last evidence keeps it
 * in the budget for as long as any analyser could count it. Returns the slot
 * the tracker's latest transition is in.
 */
function record(ages: Float32Array, base: number, seen: number, last: number, age: number): number {
  if (seen > 0) {
    let oldest = 0;
    for (let k = 1; k < MAX_TRANSITIONS; k++) if (ages[base + k]! > ages[base + oldest]!) oldest = k;
    ages[base + oldest] = age;
    return oldest;
  }
  if (seen < 0 && last >= 0) ages[base + last] = age;
  return last;
}

/** Block means and area shares of one tap frame and its transition directions. */
function blockStats(state: FlashGuardState, frame: TapFrame, dirL: Int8Array, dirQ: Int8Array, shape: BlockShape, out: BlockStats): void {
  const { cols, rows, tapsX, tapsY, tileSums } = state;
  tileSums.fill(0);
  for (let j = 0; j < tapsY; j++) {
    const ty = tileOfTap(j, tapsY, rows);
    for (let i = 0; i < tapsX; i++) {
      const t = j * tapsX + i;
      const s = (ty * cols + tileOfTap(i, tapsX, cols)) * 7;
      tileSums[s] = tileSums[s]! + frame.lum[t]!;
      tileSums[s + 1] = tileSums[s + 1]! + frame.red[t]!;
      if (dirL[t]! > 0) tileSums[s + 2] = tileSums[s + 2]! + 1;
      else if (dirL[t]! < 0) tileSums[s + 3] = tileSums[s + 3]! + 1;
      if (dirQ[t]! > 0) tileSums[s + 4] = tileSums[s + 4]! + 1;
      else if (dirQ[t]! < 0) tileSums[s + 5] = tileSums[s + 5]! + 1;
      tileSums[s + 6] = tileSums[s + 6]! + 1;
    }
  }
  for (let y = 0; y < rows; y++) {
    const y0 = blockOrigin(y, shape.h, rows);
    for (let x = 0; x < cols; x++) {
      const x0 = blockOrigin(x, shape.w, cols);
      let l = 0, q = 0, rl = 0, fl = 0, rq = 0, fq = 0, count = 0;
      for (let yy = y0; yy < y0 + shape.h; yy++) {
        for (let xx = x0; xx < x0 + shape.w; xx++) {
          const s = (yy * cols + xx) * 7;
          l += tileSums[s]!;
          q += tileSums[s + 1]!;
          rl += tileSums[s + 2]!;
          fl += tileSums[s + 3]!;
          rq += tileSums[s + 4]!;
          fq += tileSums[s + 5]!;
          count += tileSums[s + 6]!;
        }
      }
      const b = y * cols + x;
      const c = Math.max(1, count);
      out.lum[b] = l / c;
      out.red[b] = q / c;
      out.riseL[b] = rl / c;
      out.fallL[b] = fl / c;
      out.riseQ[b] = rq / c;
      out.fallQ[b] = fq / c;
    }
  }
}

/**
 * One frame of the guard.
 *
 * `input` is this frame's taps before the guard. `shown` is what the previous
 * frame actually displayed at the same taps, after the guard (null on the
 * first frame). `tileArea` is one tile's share of the screen. Updates the
 * per-tile field and the tap state guardedColour() reads.
 */
export function stepFlashGuard(
  state: FlashGuardState,
  input: TapFrame,
  shown: TapFrame | null,
  dtSeconds: number,
  tileArea: number,
): void {
  const { cols, rows } = state;
  const taps = state.tapsX * state.tapsY;
  // A NaN or infinite frame time would poison every decay below for good.
  const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(10, dtSeconds)) : 0;
  const decay = Math.exp(-dt / RATE_TAU_S);
  const keep = Math.exp(-dt / AREA_TAU_S);
  const follow = 1 - Math.exp(-dt / LEVEL_TAU_S);
  const letGo = 1 - Math.exp(-dt / FLOOR_TAU_S);
  const shape = blockShape(tileArea, cols, rows);

  // What the viewer saw last frame, shown `dt` ago, tap by tap. Counted
  // exactly the way an analyser counts (same thresholds, same anchoring).
  if (shown) {
    if (!state.outSeeded) {
      state.tapOutExtL.fill(0);
      state.tapOutPhaseL.fill(-1);
      state.tapOutExtQ.fill(0);
      state.tapOutPhaseQ.fill(-1);
    }
    for (let t = 0; t < taps; t++) {
      state.tapDirOutL[t] = track(state.tapOutExtL, state.tapOutPhaseL, t, shown.lum[t]!, GENERAL_DELTA, DARK_LIMIT);
      state.tapDirOutQ[t] = track(state.tapOutExtQ, state.tapOutPhaseQ, t, shown.red[t]!, RED_DELTA, Infinity);
    }
    state.outSeeded = true;
    blockStats(state, shown, state.tapDirOutL, state.tapDirOutQ, shape, state.blockShown);
  }

  for (let t = 0; t < taps; t++) {
    const x = input.lum[t]!;
    if (!state.inSeeded) {
      state.level[t] = x;
      state.floor[t] = x;
    }
    state.tapDirInL[t] = track(state.tapInExtL, state.tapInPhaseL, t, x, GENERAL_DELTA, DARK_LIMIT);
    state.tapDirInQ[t] = track(state.tapInExtQ, state.tapInPhaseQ, t, input.red[t]!, RED_DELTA, Infinity);
    const level = state.level[t]! + (x - state.level[t]!) * follow;
    state.level[t] = level;
    state.floor[t] = Math.min(x, state.floor[t]! + (level - state.floor[t]!) * letGo);
  }
  state.inSeeded = true;
  blockStats(state, input, state.tapDirInL, state.tapDirInQ, shape, state.blockIn);

  for (let i = 0; i < cols * rows; i++) {
    const base = i * MAX_TRANSITIONS;
    for (let k = base; k < base + MAX_TRANSITIONS; k++) state.ages[k] = Math.min(EMPTY_AGE, state.ages[k]! + dt);

    if (shown) {
      const s = state.blockShown;
      const meanL = track(state.meanOutExtL, state.meanOutPhaseL, i, s.lum[i]!, GENERAL_DELTA, DARK_LIMIT);
      const seenL = blockTransition(state.outDirL, state.areaOut, i, i * 4, meanL, s.riseL[i]!, s.fallL[i]!, keep);
      state.lastL[i] = record(state.ages, base, seenL, state.lastL[i]!, dt);
      const meanQ = track(state.meanOutExtQ, state.meanOutPhaseQ, i, s.red[i]!, RED_DELTA, Infinity);
      const seenQ = blockTransition(state.outDirQ, state.areaOut, i, i * 4 + 2, meanQ, s.riseQ[i]!, s.fallQ[i]!, keep);
      state.lastQ[i] = record(state.ages, base, seenQ, state.lastQ[i]!, dt);
    }

    const b = state.blockIn;
    const x = b.lum[i]!;
    const q = b.red[i]!;
    const meanL = track(state.meanInExtL, state.meanInPhaseL, i, x, GENERAL_DELTA, DARK_LIMIT);
    state.rate[i] = state.rate[i]! * decay + Math.max(0, blockTransition(state.inDirL, state.areaIn, i, i * 4, meanL, b.riseL[i]!, b.fallL[i]!, keep));
    const meanQ = track(state.meanInExtQ, state.meanInPhaseQ, i, q, RED_DELTA, Infinity);
    state.rateQ[i] = state.rateQ[i]! * decay + Math.max(0, blockTransition(state.inDirQ, state.areaIn, i, i * 4 + 2, meanQ, b.riseQ[i]!, b.fallQ[i]!, keep));

    let recent = 0;
    for (let k = base; k < base + MAX_TRANSITIONS; k++) if (state.ages[k]! < RECENT_S) recent++;
    const overL = state.rate[i]! > OVER_RATE;
    const overQ = state.rateQ[i]! > OVER_RATE;
    // A rise needs room for its own fall, and for the fall the other tracker
    // still owes if it is up: the two share one budget.
    const roomL = recent + (state.outDirQ[i]! > 0 ? 1 : 0) <= MAX_TRANSITIONS - 2;
    const roomQ = recent + (state.outDirL[i]! > 0 ? 1 : 0) <= MAX_TRANSITIONS - 2;
    const release = RELEASE_PER_S * dt;
    state.compress[i] = overL ? 1 : Math.max(0, state.compress[i]! - release);
    state.holdL[i] = roomL ? Math.max(0, state.holdL[i]! - release) : 1;
    state.holdQ[i] = roomQ && !overQ ? Math.max(0, state.holdQ[i]! - release) : 1;

    // The mean's own cap, for rises the taps' caps can't see (taps already
    // up, climbing further).
    if (!roomL && state.meanOutPhaseL[i]! < 0 && state.meanOutExtL[i]! < DARK_LIMIT) {
      state.capL[i] = state.meanOutExtL[i]! + HOLD_GENERAL;
    } else if (state.capL[i]! !== Infinity) {
      state.capL[i] = state.capL[i]! + RECOVER_GENERAL_PER_S * dt;
      if (state.capL[i]! >= 1) state.capL[i] = Infinity;
    }
    if ((!roomQ || overQ) && state.meanOutPhaseQ[i]! < 0) {
      state.capQ[i] = state.meanOutExtQ[i]! + HOLD_RED;
    } else if (state.capQ[i]! !== Infinity) {
      state.capQ[i] = state.capQ[i]! + RECOVER_RED_PER_S * dt;
      if (state.capQ[i]! >= 1) state.capQ[i] = Infinity;
    }

    let ceil = state.maxBoost;
    if (state.capL[i]! !== Infinity && x > 1e-6) ceil = Math.min(ceil, state.capL[i]! / x);
    // Gain scales red saturation too, so a block holding red takes no more
    // gain than keeps its red under the cap.
    let desat = 1;
    if (state.capQ[i]! !== Infinity && q > 1e-6) {
      desat = q > state.capQ[i]! ? state.capQ[i]! / q : 1;
      ceil = Math.min(ceil, state.capQ[i]! / (q * desat));
    }
    state.blockCeil[i] = ceil;
    state.blockDesat[i] = desat;
  }

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let ceil = state.maxBoost;
      let desat = 1;
      let compress = 0;
      let holdL = 0;
      let holdQ = 0;
      for (let by = Math.max(0, ty - shape.h - 1); by <= Math.min(rows - 1, ty + shape.h + 1); by++) {
        const y0 = blockOrigin(by, shape.h, rows);
        if (y0 > ty + 1 || y0 + shape.h - 1 < ty - 1) continue;
        for (let bx = Math.max(0, tx - shape.w - 1); bx <= Math.min(cols - 1, tx + shape.w + 1); bx++) {
          const x0 = blockOrigin(bx, shape.w, cols);
          if (x0 > tx + 1 || x0 + shape.w - 1 < tx - 1) continue;
          const b = by * cols + bx;
          ceil = Math.min(ceil, state.blockCeil[b]!);
          desat = Math.min(desat, state.blockDesat[b]!);
          compress = Math.max(compress, state.compress[b]!);
          holdL = Math.max(holdL, state.holdL[b]!);
          holdQ = Math.max(holdQ, state.holdQ[b]!);
        }
      }
      const t = ty * cols + tx;
      state.ceil[t] = ceil;
      state.desat[t] = desat;
      state.compressField[t] = compress;
      state.holdLField[t] = holdL;
      state.holdQField[t] = holdQ;
    }
  }
}

/** Bilinear between per-tile values, tile centres at (i + 0.5), clamped at the edges. */
function sampleTiles(values: Float32Array, cols: number, rows: number, u: number, v: number): number {
  const x = Math.max(0, Math.min(cols - 1, u));
  const y = Math.max(0, Math.min(rows - 1, v));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = values[y0 * cols + x0]! + (values[y0 * cols + x1]! - values[y0 * cols + x0]!) * fx;
  const b = values[y1 * cols + x0]! + (values[y1 * cols + x1]! - values[y1 * cols + x0]!) * fx;
  return a + (b - a) * fy;
}

export interface GuardedPixel {
  /** Luminance gain and pull toward grey (1 = untouched) for the pixel. */
  gain: number;
  desat: number;
}

/**
 * How the guard changes one pixel this frame: pixel (px, py) of the image,
 * linear colour (r, g, b). The GPU composite computes exactly this for every
 * pixel; the spec's taps are the pixels it measures. The tap state it reads
 * (levels, floors, troughs) comes from the taps around the pixel: bilinear for
 * levels, the strictest for caps, so a tap's own cap always applies to it.
 * A pixel within 1e-4 of untouched is left exactly as it was.
 */
export function guardPixel(state: FlashGuardState, px: number, py: number, r: number, g: number, b: number, out: GuardedPixel): GuardedPixel {
  return guardTap(state, px, py, relativeLuminance(r, g, b), redSaturation(r, g, b), out);
}

/** guardPixel() from the pixel's luminance and red saturation alone. */
export function guardTap(state: FlashGuardState, px: number, py: number, x: number, q: number, out: GuardedPixel): GuardedPixel {
  const { cols, rows, tapsX, tapsY } = state;
  const fu = ((px + 0.5) / state.width) * cols - 0.5;
  const fv = ((py + 0.5) / state.height) * rows - 0.5;
  const ceil = sampleTiles(state.ceil, cols, rows, fu, fv);
  const desatField = sampleTiles(state.desat, cols, rows, fu, fv);
  const compress = sampleTiles(state.compressField, cols, rows, fu, fv);
  const holdL = sampleTiles(state.holdLField, cols, rows, fu, fv);
  const holdQ = sampleTiles(state.holdQField, cols, rows, fu, fv);
  out.gain = 1;
  out.desat = 1;
  if (ceil >= 0.9999 && desatField >= 0.9999 && compress <= 1e-4 && holdL <= 1e-4 && holdQ <= 1e-4) return out;

  // The 2x2 taps around the pixel.
  const u = Math.max(0, Math.min(tapsX - 1, ((px + 0.5) * tapsX) / state.width - 0.5));
  const v = Math.max(0, Math.min(tapsY - 1, ((py + 0.5) * tapsY) / state.height - 0.5));
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const i1 = Math.min(tapsX - 1, i0 + 1);
  const j1 = Math.min(tapsY - 1, j0 + 1);
  const cell = [j0 * tapsX + i0, j0 * tapsX + i1, j1 * tapsX + i0, j1 * tapsX + i1];
  const wx = u - i0;
  const wy = v - j0;
  const weights = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy];

  let y = x;
  if (compress > 1e-4) {
    let level = 0;
    let floor = 0;
    for (let k = 0; k < 4; k++) {
      level += state.level[cell[k]!]! * weights[k]!;
      floor += state.floor[cell[k]!]! * weights[k]!;
    }
    const top = Math.min(level + BAND_HALF, floor * state.maxBoost + 2 * BAND_HALF);
    const banded = Math.min(Math.max(x, top - 2 * BAND_HALF), top, x * state.maxBoost);
    y = x + (banded - x) * compress;
  }
  if (holdL > 1e-4) {
    let cap = Infinity;
    for (const t of cell) {
      if (state.tapOutPhaseL[t]! < 0 && state.tapOutExtL[t]! < DARK_LIMIT) cap = Math.min(cap, state.tapOutExtL[t]! + HOLD_GENERAL);
    }
    if (y > cap) y -= (y - cap) * holdL;
  }
  y = Math.min(y, x * ceil);
  const gain = x > 1e-6 ? y / x : 1;
  let desat = desatField;
  if (holdQ > 1e-4 && q > 1e-6) {
    let cap = Infinity;
    for (const t of cell) if (state.tapOutPhaseQ[t]! < 0) cap = Math.min(cap, state.tapOutExtQ[t]! + HOLD_RED);
    const scaled = q * gain * desat;
    if (scaled > cap) desat *= 1 - (1 - cap / scaled) * holdQ;
  }
  if (Math.abs(gain - 1) >= 1e-4 || desat < 0.9999) {
    out.gain = gain;
    out.desat = desat;
  }
  return out;
}

/**
 * Apply a guardPixel() result to a linear colour, as the GPU does: pull toward
 * the grey of equal luminance (which is what takes saturated red down), then
 * scale, which keeps the colour. A lift stops where the brightest channel
 * would clip, so it never shifts a hue. Writes into `out`.
 */
export function applyGuard(r: number, g: number, b: number, guarded: GuardedPixel, out: Float32Array): Float32Array {
  const l = relativeLuminance(r, g, b);
  const dr = l + (r - l) * guarded.desat;
  const dg = l + (g - l) * guarded.desat;
  const db = l + (b - l) * guarded.desat;
  const peak = Math.max(dr, dg, db);
  const k = peak * guarded.gain > 1 ? 1 / peak : guarded.gain;
  out[0] = dr * k;
  out[1] = dg * k;
  out[2] = db * k;
  return out;
}

// ── Colour helpers (sRGB-encoded 0..1 in, linear out) ──────────────────────

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Linear R − G − B where the pixel is saturated red, else 0. */
export function redSaturation(r: number, g: number, b: number): number {
  const sum = r + g + b;
  return sum > 0 && r >= RED_RATIO * sum ? Math.max(0, r - g - b) : 0;
}

export const LINEAR_BYTE = Float32Array.from({ length: 256 }, (_, v) => srgbToLinear(v / 255));

/**
 * Point-sample taps from RGBA bytes `width` x `height` (row 0 first, in
 * whatever order the caller's pixels come; the guard only needs it to be the
 * same every frame), each at tapX/tapY. Each tap reads one pixel, linearised:
 * no averaging, so fine bright texture reads as bright as it is.
 */
export function tapsFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  out: TapFrame,
  tapsX: number,
  tapsY: number,
): void {
  for (let j = 0; j < tapsY; j++) {
    for (let i = 0; i < tapsX; i++) {
      const p = (tapY(i, j, tapsY, height) * width + tapX(i, j, tapsX, width)) * 4;
      const r = LINEAR_BYTE[rgba[p]!]!;
      const g = LINEAR_BYTE[rgba[p + 1]!]!;
      const b = LINEAR_BYTE[rgba[p + 2]!]!;
      out.lum[j * tapsX + i] = relativeLuminance(r, g, b);
      out.red[j * tapsX + i] = redSaturation(r, g, b);
    }
  }
}
