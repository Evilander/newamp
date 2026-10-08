// Unit test for the flash guard specification (src/visualizer/flash-guard.ts),
// no GPU. Drives the tap-grid model with synthetic flashes, shows each tap
// exactly the way the GPU composite shows that pixel, and counts what comes
// out with an independent counter written the way flash analysers count: a
// flash is a rise then a fall of at least 0.1 in linear relative luminance
// with the darker state below 0.8 (or 0.0625 of red saturation), counted when
// the pair completes, in every sliding one-second window, starting from black.
//
// Asserts: square-wave flashes at 4, 8 and 15 Hz over a large or medium area
// come out at no more than three flashes a second, at 30, 60 and 144 fps; red
// flashes the same; a 2 Hz pulse and slow pulses pass through untouched; a
// small element, or sparse twinkle that never flashes together, is left
// alone; flicker whose pixels flash out of step (stripes, dots and
// checkerboards, some reversing in counter-phase) is caught and taken under
// the limit pixel by pixel; a strobe that stops is released gradually.
//
// Run: node scripts/flash-guard-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/flash-guard-test-result.txt');
writeFileSync(RESULT, '[flash-guard-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/flash-guard.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/flash-guard-bundle.mjs'), logLevel: 'silent',
});
const guard = await import(pathToFileURL(resolve('tmp/flash-guard-bundle.mjs')).href);
const {
  FLASH_GUARD_COLS: COLS, FLASH_GUARD_ROWS: ROWS, GENERAL_DELTA, DARK_LIMIT, RED_DELTA, MAX_BOOST,
  createFlashGuardState, createTapFrame, stepFlashGuard, guardPixel, applyGuard, tapsFromRgba, tapPixel, tapX, tapY, tileOfTap,
  blockShape, relativeLuminance, redSaturation, srgbToLinear,
} = guard;
const TILES = COLS * ROWS;

const log = [];
let pass = true;
const check = (ok, message) => {
  log.push(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) pass = false;
};

// ── Independent flash counters ──────────────────────────────────────────────

/**
 * Most flashes (completed rise→fall pairs) in any window of `windowFrames`
 * frames of one series. Mirrors the counting in common analysers rather than
 * the guard's own trackers.
 */
function maxFlashesPerWindow(series, windowFrames, delta, red = false) {
  let phase = 0;
  let low = 0;
  let high = -Infinity;
  const completions = [];
  for (let f = 0; f < series.length; f++) {
    const v = series[f];
    if (phase === 0) {
      low = Math.min(low, v);
      if (v - low >= delta && (red || low < DARK_LIMIT)) { phase = 1; high = v; }
    } else {
      high = Math.max(high, v);
      if (high - v >= delta && (red || v < DARK_LIMIT)) { phase = 0; low = v; completions.push(f); }
    }
  }
  let best = 0;
  for (let i = 0, j = 0; i < completions.length; i++) {
    while (completions[i] - completions[j] >= windowFrames) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/** The same count for every tap at once, streamed: per-tap worst window. */
function tapCounter(n, windowFrames, delta, red = false) {
  const phase = new Uint8Array(n);
  const low = new Float32Array(n);
  const high = new Float32Array(n);
  const inWindow = new Uint16Array(n);
  const worst = new Uint16Array(n);
  const ring = Array.from({ length: windowFrames }, () => new Uint8Array(n));
  let frame = 0;
  return {
    add(values) {
      const slot = ring[frame % windowFrames];
      for (let i = 0; i < n; i++) {
        inWindow[i] -= slot[i];
        slot[i] = 0;
        const v = values[i];
        if (!phase[i]) {
          if (v < low[i]) low[i] = v;
          if (v - low[i] >= delta && (red || low[i] < DARK_LIMIT)) { phase[i] = 1; high[i] = v; }
        } else {
          if (v > high[i]) high[i] = v;
          if (high[i] - v >= delta && (red || v < DARK_LIMIT)) {
            phase[i] = 0; low[i] = v; slot[i] = 1; inWindow[i]++;
            if (inWindow[i] > worst[i]) worst[i] = inWindow[i];
          }
        }
      }
      frame++;
    },
    worst: () => worst.reduce((a, b) => Math.max(a, b), 0),
    /** Share of taps that flashed more than three times in some second. */
    over: () => worst.reduce((a, b) => a + (b > 3 ? 1 : 0), 0) / n,
  };
}

// ── Simulation ─────────────────────────────────────────────────────────────

/**
 * Run the guard over `seconds` of a picture `width` x `height` pixels whose
 * taps are every pixel. `fill(t, rgb, taps)` writes each tap's linear colour
 * for time t. Each tap is then shown exactly as the GPU composite shows that
 * pixel, and what was shown feeds the next frame. Returns per-tap flash
 * counts, per-tile mean series, and how much the picture changed.
 */
function simulate(fill, { seconds = 6, fps = 60, width = COLS * 4, height = ROWS * 4, screenFraction = 1 } = {}) {
  const frames = Math.round(seconds * fps);
  const state = createFlashGuardState(width, height);
  const taps = { x: state.tapsX, y: state.tapsY };
  const n = taps.x * taps.y;
  const rgb = new Float32Array(n * 3);
  const input = createTapFrame(taps);
  const shown = createTapFrame(taps);
  const counters = {
    inL: tapCounter(n, fps, GENERAL_DELTA), outL: tapCounter(n, fps, GENERAL_DELTA),
    inQ: tapCounter(n, fps, RED_DELTA, true), outQ: tapCounter(n, fps, RED_DELTA, true),
  };
  const tileOf = new Uint16Array(n);
  const tileCount = new Float32Array(TILES);
  for (let j = 0; j < taps.y; j++) {
    for (let i = 0; i < taps.x; i++) {
      tileOf[j * taps.x + i] = tileOfTap(j, taps.y, ROWS) * COLS + tileOfTap(i, taps.x, COLS);
      tileCount[tileOf[j * taps.x + i]]++;
    }
  }
  const tileIn = Array.from({ length: TILES }, () => new Float32Array(frames));
  const tileOut = Array.from({ length: TILES }, () => new Float32Array(frames));
  const result = { gain: 0, desat: 0 };
  const colour = new Float32Array(3);
  let sumAbs = 0;
  let minGain = Infinity;
  let maxGain = 0;
  let touchedFrames = 0;
  const lateOut = [];
  for (let f = 0; f < frames; f++) {
    fill(f / fps, rgb, taps);
    for (let t = 0; t < n; t++) {
      input.lum[t] = relativeLuminance(rgb[t * 3], rgb[t * 3 + 1], rgb[t * 3 + 2]);
      input.red[t] = redSaturation(rgb[t * 3], rgb[t * 3 + 1], rgb[t * 3 + 2]);
    }
    stepFlashGuard(state, input, f > 0 ? shown : null, 1 / fps, screenFraction / TILES);
    let touched = false;
    for (let j = 0; j < taps.y; j++) {
      const py = tapPixel(j, taps.y, height);
      for (let i = 0; i < taps.x; i++) {
        const t = j * taps.x + i;
        guardPixel(state, tapPixel(i, taps.x, width), py, rgb[t * 3], rgb[t * 3 + 1], rgb[t * 3 + 2], result);
        applyGuard(rgb[t * 3], rgb[t * 3 + 1], rgb[t * 3 + 2], result, colour);
        shown.lum[t] = relativeLuminance(colour[0], colour[1], colour[2]);
        shown.red[t] = redSaturation(colour[0], colour[1], colour[2]);
        if (input.lum[t] > 1e-6) {
          const gain = shown.lum[t] / input.lum[t];
          minGain = Math.min(minGain, gain);
          maxGain = Math.max(maxGain, gain);
        }
        if (result.gain !== 1 || result.desat !== 1) touched = true;
        sumAbs += Math.abs(shown.lum[t] - input.lum[t]);
      }
    }
    if (touched) touchedFrames++;
    for (const k of ['inL', 'outL']) counters[k].add(k === 'inL' ? input.lum : shown.lum);
    counters.inQ.add(input.red);
    counters.outQ.add(shown.red);
    for (let k = 0; k < TILES; k++) { tileIn[k][f] = 0; tileOut[k][f] = 0; }
    for (let t = 0; t < n; t++) {
      tileIn[tileOf[t]][f] += input.lum[t] / tileCount[tileOf[t]];
      tileOut[tileOf[t]][f] += shown.lum[t] / tileCount[tileOf[t]];
    }
    lateOut.push(shown.lum[Math.floor(taps.y / 2) * taps.x + Math.floor(taps.x / 2)]);
  }
  return {
    frames, fps, taps, n, counters, tileIn, tileOut, lateOut,
    change: sumAbs / (n * frames), minGain, maxGain, touchedFrames,
  };
}

/** Per-frame mean of a set of tiles' series. */
function areaSeries(series, tiles, frames) {
  const out = new Float32Array(frames);
  for (const i of tiles) for (let f = 0; f < frames; f++) out[f] += series[i][f] / tiles.size;
  return out;
}

/** Worst flashes in any 1%-of-the-screen window (every tile-aligned block of `shape`). */
function worstRegion(series, shape, fps, frames) {
  let best = 0;
  for (let y0 = 0; y0 <= ROWS - shape.h; y0++) {
    for (let x0 = 0; x0 <= COLS - shape.w; x0++) {
      best = Math.max(best, maxFlashesPerWindow(areaSeries(series, block(x0, y0, shape.w, shape.h), frames), fps, GENERAL_DELTA));
    }
  }
  return best;
}

const square = (hz, t) => (Math.floor(t * hz * 2) % 2 === 0 ? 1 : 0);
const LOW = 0.05;
const HIGH = 0.6;
const block = (x0, y0, w, h) => {
  const set = new Set();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set.add(y * COLS + x);
  return set;
};
const everyTile = block(0, 0, COLS, ROWS);
const grey = (rgb, t, v) => { rgb[t * 3] = v; rgb[t * 3 + 1] = v; rgb[t * 3 + 2] = v; };
/** Tiles in `tiles` follow `level(t)`, the rest sit at a dim 0.08. */
const areaFill = (tiles, level) => (t, rgb, taps) => {
  const v = level(t);
  for (let j = 0; j < taps.y; j++) {
    const ty = tileOfTap(j, taps.y, ROWS);
    for (let i = 0; i < taps.x; i++) grey(rgb, j * taps.x + i, tiles.has(ty * COLS + tileOfTap(i, taps.x, COLS)) ? v : 0.08);
  }
};
const fullShape = blockShape(1 / TILES);

// 1. Large-area square waves.
for (const hz of [2, 4, 8, 15]) {
  const run = simulate(areaFill(everyTile, (t) => (square(hz, t) ? HIGH : LOW)));
  const before = run.counters.inL.worst();
  const after = run.counters.outL.worst();
  if (hz === 2) {
    check(after === before && run.change < 0.002 && run.minGain > 0.999,
      `2 Hz full-screen pulse passes: ${before}→${after} flashes/s, mean |Δ| ${run.change.toFixed(5)}, min gain ${run.minGain.toFixed(4)}`);
  } else {
    check(before > 3 && after <= 3, `${hz} Hz full-screen square: ${before}→${after} flashes/s`);
  }
}

// 2. Frame-rate independence of the limit.
for (const fps of [30, 144]) {
  for (const hz of [8, 15]) {
    const run = simulate(areaFill(everyTile, (t) => (square(hz, t) ? HIGH : LOW)), { fps, seconds: 4 });
    check(run.counters.outL.worst() <= 3, `${hz} Hz full-screen square at ${fps} fps: ${run.counters.inL.worst()}→${run.counters.outL.worst()} flashes/s`);
  }
}

// 3. Medium area (12x8 tiles, 17% of the screen) at 8 Hz.
{
  const tiles = block(10, 5, 12, 8);
  const run = simulate(areaFill(tiles, (t) => (square(8, t) ? HIGH : LOW)));
  check(run.counters.outL.worst() <= 3, `8 Hz over 17% of the screen: ${run.counters.inL.worst()}→${run.counters.outL.worst()} flashes/s`);
}

// 4. Small elements on a fullscreen canvas (blocks of 2x3 tiles = 1% of the
// screen). One tile is a sixth of every block it touches, under
// AREA_FRACTION, and its swing moves no block mean by 0.1: left alone. Four
// tiles (0.7%) are two thirds of a block: limited.
{
  check(fullShape.w * fullShape.h === 6, `fullscreen block is ${fullShape.w}x${fullShape.h} tiles`);
  const one = block(4, 4, 1, 1);
  const run = simulate(areaFill(one, (t) => (square(8, t) ? 0.55 : LOW)));
  check(run.change === 0, `8 Hz element over 0.17% of the screen is left alone: mean |Δ| ${run.change}`);
  const four = block(4, 4, 2, 2);
  const limited = simulate(areaFill(four, (t) => (square(8, t) ? 0.55 : LOW)));
  const area = block(4, 3, fullShape.w, fullShape.h);
  const before = maxFlashesPerWindow(areaSeries(limited.tileIn, area, limited.frames), limited.fps, GENERAL_DELTA);
  const after = maxFlashesPerWindow(areaSeries(limited.tileOut, area, limited.frames), limited.fps, GENERAL_DELTA);
  check(before > 3 && after <= 3 && limited.counters.outL.worst() <= 3,
    `8 Hz element over 0.7% of the screen: ${before}→${after} flashes/s over its 1% block, ${limited.counters.outL.worst()} at any pixel`);
}

// 5. A small canvas (a 400x300 panel on a 1080p screen is 5.8% of it, so a
// block is 10x10 tiles): a 3x3-tile element is left alone, half the canvas
// flashing (2.9% of the screen) is limited.
{
  const shape = blockShape(0.058 / TILES);
  check(shape.w * shape.h >= 100, `5.8% canvas block is ${shape.w}x${shape.h} tiles`);
  const small = block(3, 3, 3, 3);
  const run = simulate(areaFill(small, (t) => (square(8, t) ? HIGH : LOW)), { screenFraction: 0.058 });
  check(run.change === 0, `8 Hz element over 0.09% of the screen on a small canvas is left alone: mean |Δ| ${run.change}`);
  const half = block(0, 0, 16, ROWS);
  const limited = simulate(areaFill(half, (t) => (square(8, t) ? HIGH : LOW)), { screenFraction: 0.058 });
  check(limited.counters.outL.worst() <= 3, `8 Hz over half of a 5.8% canvas (2.9% of the screen): ${limited.counters.inL.worst()}→${limited.counters.outL.worst()} flashes/s`);
}

// 5b. Flicker whose pixels flash out of step. Block means barely move (or
// cancel exactly, in counter-phase), but each pattern flashes over far more
// than AREA_FRACTION of every block, so each must be caught and taken under
// the limit pixel by pixel. Drawn on a 320x180 screen, one tap per pixel.
{
  const W = 320;
  const H = 180;
  const pixelFill = (pixel) => (t, rgb, taps) => {
    for (let j = 0; j < taps.y; j++) {
      const y = tapPixel(j, taps.y, H);
      for (let i = 0; i < taps.x; i++) grey(rgb, j * taps.x + i, pixel(tapPixel(i, taps.x, W), y, t));
    }
  };
  const patterns = [
    // 40% of the columns flash 0 ↔ 0.2 at 10 Hz: every block mean swings 0.08.
    ['stripes, 40% of pixels 0↔0.2 at 10 Hz', (x, y, t) => (x % 5 < 2 && square(10, t) ? 0.2 : 0)],
    // 30% of the pixels flash 0 ↔ 0.3 at 12 Hz: means swing 0.09.
    ['dots, 30% of pixels 0↔0.3 at 12 Hz', (x, y, t) => ((x + 3 * y) % 10 < 3 && square(12, t) ? 0.3 : 0)],
    // An 8 px checkerboard reversing 0 ↔ 0.6 at 8 Hz: every pixel flashes,
    // every block mean stays at 0.3.
    ['8 px checkerboard reversing 0↔0.6 at 8 Hz', (x, y, t) => ((((x >> 3) + (y >> 3)) % 2 === 0) === (square(8, t) === 1) ? 0.6 : 0)],
    // The tile-sized checkerboard, reversing.
    ['tile checkerboard reversing 0.05↔0.6 at 8 Hz', (x, y, t) => {
      const parity = (Math.floor((x * COLS) / W) + Math.floor((y * ROWS) / H)) % 2;
      return square(8, t) === parity ? HIGH : LOW;
    }],
    // A 1 px checkerboard reversing: finer than anything a block mean sees.
    ['1 px checkerboard reversing 0.05↔0.5 at 15 Hz', (x, y, t) => (((x + y) % 2 === 0) === (square(15, t) === 1) ? 0.5 : LOW)],
  ];
  for (const [name, pixel] of patterns) {
    const run = simulate(pixelFill(pixel), { seconds: 4, width: W, height: H });
    const before = run.counters.inL.worst();
    const after = run.counters.outL.worst();
    check(before > 3 && after <= 3 && run.counters.outL.over() === 0,
      `${name}: ${before}→${after} flashes/s at the worst pixel, ${(run.counters.inL.over() * 100).toFixed(0)}%→${(run.counters.outL.over() * 100).toFixed(1)}% of pixels over three a second`);
  }
}

// 5c. Calm texture: sparse twinkle that never flashes together (6% of pixels,
// each on its own phase at 7 Hz) is left alone, however busy each pixel is.
{
  const W = 320;
  const H = 180;
  let seed = 11;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const twinkle = new Float32Array(W * H).map(() => (rand() < 0.06 ? 1 + rand() : 0));
  const run = simulate((t, rgb, taps) => {
    for (let j = 0; j < taps.y; j++) {
      const y = tapPixel(j, taps.y, H);
      for (let i = 0; i < taps.x; i++) {
        const phase = twinkle[y * W + tapPixel(i, taps.x, W)];
        grey(rgb, j * taps.x + i, phase && square(7, t + phase) ? 0.7 : 0.04);
      }
    }
  }, { seconds: 4, width: W, height: H });
  check(run.counters.inL.worst() > 3 && run.change === 0,
    `sparse twinkle (6% of pixels at 7 Hz, out of step) is left alone: ${run.counters.inL.worst()} flashes/s at a pixel, mean |Δ| ${run.change}`);
}

// 6. Slow pulses (sine, 0.5 and 1 Hz, 0.05↔0.6): untouched.
for (const hz of [0.5, 1]) {
  const run = simulate(areaFill(everyTile, (t) => LOW + (HIGH - LOW) * (0.5 - 0.5 * Math.cos(2 * Math.PI * hz * t))));
  check(run.change === 0, `${hz} Hz slow pulse passes untouched: mean |Δ| ${run.change}`);
}

// 7. Red flashes at constant luminance: saturated red ↔ grey of equal luminance.
{
  const redLin = [0.5, 0.02, 0.02];
  const redL = relativeLuminance(...redLin);
  for (const hz of [4, 8]) {
    const run = simulate((t, rgb, taps) => {
      const on = square(hz, t);
      for (let k = 0; k < taps.x * taps.y; k++) {
        if (on) { rgb[k * 3] = redLin[0]; rgb[k * 3 + 1] = redLin[1]; rgb[k * 3 + 2] = redLin[2]; } else grey(rgb, k, redL);
      }
    });
    const before = run.counters.inQ.worst();
    const after = run.counters.outQ.worst();
    check(before > 3 && after <= 3 && run.change < 1e-6,
      `${hz} Hz saturated-red flash: ${before}→${after} red flashes/s, luminance untouched (${run.change.toExponential(1)})`);
  }
}

// 8. Red and luminance together (red ↔ black).
{
  const run = simulate((t, rgb, taps) => {
    const on = square(8, t);
    for (let k = 0; k < taps.x * taps.y; k++) {
      rgb[k * 3] = on ? 0.9 : 0.01; rgb[k * 3 + 1] = on ? 0.05 : 0.01; rgb[k * 3 + 2] = on ? 0.05 : 0.01;
    }
  });
  check(run.counters.outL.worst() <= 3 && run.counters.outQ.worst() <= 3,
    `8 Hz red↔black: ${run.counters.outL.worst()} general, ${run.counters.outQ.worst()} red flashes/s after the guard`);
}

// 9. Full-screen noise, every frame a new random level.
{
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const run = simulate((t, rgb, taps) => {
    const v = rand();
    for (let k = 0; k < taps.x * taps.y; k++) grey(rgb, k, v);
  });
  check(run.counters.outL.worst() <= 3, `full-screen random-level noise: ${run.counters.inL.worst()}→${run.counters.outL.worst()} flashes/s`);
}

// 10. A strobe that reaches different tiles up to a frame apart (a wipe, a
// flash that spreads) is still one flash.
{
  const run = simulate((t, rgb, taps) => {
    for (let i = 0; i < taps.x; i++) {
      const v = square(10, t + (tileOfTap(i, taps.x, COLS) % 3) * 0.007) ? HIGH : LOW;
      for (let j = 0; j < taps.y; j++) grey(rgb, j * taps.x + i, v);
    }
  });
  check(run.counters.outL.worst() <= 3, `10 Hz strobe spread over a frame: ${run.counters.inL.worst()}→${run.counters.outL.worst()} flashes/s`);
}

// 11. Release: a 12 Hz strobe that stops at 3 s is released within 2 s, and
// the climb back never jumps by a full transition in one frame.
{
  const run = simulate(areaFill(everyTile, (t) => (t < 3 ? (square(12, t) ? HIGH : LOW) : HIGH)), { seconds: 6 });
  const series = run.lateOut;
  let releasedAt = -1;
  let biggestStep = 0;
  // From the first frame with a steady input (the frame before still carries
  // the held ripple, which is under a transition by construction).
  for (let f = 3 * run.fps + 1; f < run.frames; f++) {
    biggestStep = Math.max(biggestStep, series[f] - series[f - 1]);
    if (releasedAt < 0 && Math.abs(series[f] - HIGH) < 1e-4) releasedAt = f / run.fps;
  }
  check(releasedAt > 3 && releasedAt < 5 && biggestStep < GENERAL_DELTA / 2,
    `strobe stops at 3 s: back to full level at ${releasedAt.toFixed(2)} s, largest per-frame climb ${biggestStep.toFixed(3)}`);
  check(run.counters.outL.worst() <= 3, `strobe then steady: ${run.counters.outL.worst()} flashes/s at most`);
}

// 12. Beat pumping that is only moderately deep (0.3 ↔ 0.5 at 6 Hz, the
// kind of swing a pumped look makes) is compressed around its level rather
// than held dark: at most three flashes, brightness within 10%, and a steady
// state ripple under a transition.
{
  const run = simulate(areaFill(everyTile, (t) => (square(6, t) ? 0.5 : 0.3)));
  const tile = 5 * COLS + 5;
  const mean = (series) => series.reduce((a, b) => a + b, 0) / series.length;
  const late = run.tileOut[tile].slice(3 * run.fps);
  const ripple = Math.max(...late) - Math.min(...late);
  const kept = mean(run.tileOut[tile]) / mean(run.tileIn[tile]);
  check(run.counters.outL.worst() <= 3 && kept > 0.9 && ripple < GENERAL_DELTA,
    `6 Hz 0.3↔0.5 pumping: ${run.counters.inL.worst()}→${run.counters.outL.worst()} flashes/s, brightness kept ${(kept * 100).toFixed(1)}%, late ripple ${ripple.toFixed(3)}`);
}

// 12b. Deep strobes are held dark, not lifted: nothing is brightened by more
// than MAX_BOOST, and a 0.02 ↔ 0.95 strobe keeps its dark half.
{
  const run = simulate(areaFill(everyTile, (t) => (square(8, t) ? 0.95 : 0.02)));
  const tile = 5 * COLS + 5;
  const lateMax = Math.max(...run.tileOut[tile].slice(3 * run.fps));
  check(run.maxGain <= MAX_BOOST + 1e-6 && lateMax < 0.2 && run.counters.outL.worst() <= 3,
    `0.02↔0.95 strobe: largest gain ${run.maxGain.toFixed(3)} (≤ ${MAX_BOOST}), held under ${lateMax.toFixed(3)}, ${run.counters.outL.worst()} flashes/s`);
}

// 12c. Every 1% window, counted on its mean the way the render gate counts
// it, stays under the limit for a strobe over a third of the screen.
{
  const third = block(0, 0, 11, ROWS);
  const run = simulate(areaFill(third, (t) => (square(9, t) ? 0.7 : 0.03)));
  const after = worstRegion(run.tileOut, fullShape, run.fps, run.frames);
  check(after <= 3, `9 Hz over a third of the screen: ${worstRegion(run.tileIn, fullShape, run.fps, run.frames)}→${after} flashes/s in the worst 1% window`);
}

// 13. Taps from RGBA: every pixel of a small image; on a larger one, one
// pixel per tap, inside the tap's own cell but not on a regular lattice.
{
  const w = COLS * 4;
  const h = ROWS * 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const white = x < 4 && y < 4;
      const red = x >= 4 && x < 8 && y < 4 && (x + y) % 2 === 0;
      rgba[p] = white || red ? 255 : 0;
      rgba[p + 1] = white ? 255 : 0;
      rgba[p + 2] = white ? 255 : 0;
      rgba[p + 3] = 255;
    }
  }
  const taps = { x: w, y: h };
  const frame = createTapFrame(taps);
  tapsFromRgba(rgba, w, h, frame, taps.x, taps.y);
  // Half as many taps as pixels: every tap inside its own 2x2 cell, reading
  // that one pixel unblended, and the taps of one column of the grid spread
  // over both pixel columns of their cells.
  const coarse = { x: w / 2, y: h / 2 };
  const half = createTapFrame(coarse);
  tapsFromRgba(rgba, w, h, half, coarse.x, coarse.y);
  let inCell = true;
  let exact = true;
  const offsets = new Set();
  for (let j = 0; j < coarse.y; j++) {
    for (let i = 0; i < coarse.x; i++) {
      const x = tapX(i, j, coarse.x, w);
      const y = tapY(i, j, coarse.y, h);
      if (x >> 1 !== i || y >> 1 !== j) inCell = false;
      const p = (y * w + x) * 4;
      if (Math.abs(half.lum[j * coarse.x + i] - relativeLuminance(srgbToLinear(rgba[p] / 255), srgbToLinear(rgba[p + 1] / 255), srgbToLinear(rgba[p + 2] / 255))) > 1e-6) exact = false;
      if (i === 3) offsets.add(x - 2 * i);
    }
  }
  check(Math.abs(frame.lum[0] - 1) < 1e-6 && Math.abs(frame.lum[4] - 0.2126) < 1e-6 && Math.abs(frame.red[4] - 1) < 1e-6
    && frame.lum[5] === 0 && Math.abs(srgbToLinear(1) - 1) < 1e-9 && tapPixel(0, 2, w) === w / 4 && inCell && exact && offsets.size === 2,
    `taps from RGBA: white ${frame.lum[0].toFixed(4)}, red lum ${frame.lum[4].toFixed(4)} red ${frame.red[4].toFixed(4)}; half-res taps in their cells ${inCell}, read exactly ${exact}, one grid column samples ${offsets.size} pixel columns`);
}

// 14. A NaN frame time is treated as no time passing, and leaves the guard working.
{
  const state = createFlashGuardState(COLS, ROWS);
  const taps = { x: state.tapsX, y: state.tapsY };
  const input = createTapFrame(taps);
  const shown = createTapFrame(taps);
  const result = { gain: 1, desat: 1 };
  let worst = 0;
  const series = [];
  for (let f = 0; f < 240; f++) {
    input.lum.fill(square(8, f / 60) ? HIGH : LOW);
    stepFlashGuard(state, input, f > 0 ? shown : null, f === 5 ? NaN : 1 / 60, 1 / TILES);
    guardPixel(state, 5, 5, input.lum[0], input.lum[0], input.lum[0], result);
    shown.lum.fill(input.lum[0] * result.gain);
    series.push(shown.lum[0]);
  }
  worst = maxFlashesPerWindow(series, 60, GENERAL_DELTA);
  const finite = [state.rate, state.compress, state.holdL, state.ages].every((a) => a.every(Number.isFinite));
  check(finite && worst <= 3, `NaN frame time: state stays finite (${finite}), ${worst} flashes/s after it`);
}

log.push(pass ? '[flash-guard-test] PASS' : '[flash-guard-test] FAIL');
writeFileSync(RESULT, log.join('\n') + '\n');
console.log(log.join('\n'));
if (!pass) process.exitCode = 1;
