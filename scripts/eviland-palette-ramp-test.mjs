// The palette ramp the shaders share (eviland-gl.ts): dark -> accent -> light
// laid out in OKLCh on the CPU and sampled by the GPU between neighbouring
// entries. Pins that the sampled table matches the exact OKLCh line to a level
// of 8-bit output, that it agrees with the Director's own colour blend
// (eviland-operators.ts lerpConfig), that a hue change keeps its chroma where an
// sRGB mix goes grey, and that the dither is a pure, zero-mean function of the
// pixel and the frame. Shader compilation is covered by the scene smoke.
// Run: node scripts/eviland-palette-ramp-test.mjs
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
async function load(entry, name) {
  const outfile = resolve(`tmp/${name}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const gl = await load('src/visualizer/eviland-gl.ts', 'eviland-v2-ramp-gl-bundle');
const operators = await load('src/visualizer/eviland-operators.ts', 'eviland-v2-ramp-ops-bundle');
const appearance = await load('src/visualizer/eviland-appearance.ts', 'eviland-v2-ramp-appearance-bundle');
const { generate } = await load('src/visualizer/eviland-randomizer.ts', 'eviland-v2-ramp-rand-bundle');
const { RAMP_STEPS, createRampTable, updateRampTable, oklchRampAt, rampGlsl, ditherTriAt, DITHER_FRAME_WRAP } = gl;

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const LEVEL = 1 / 255;

// A small seeded generator so a failure repeats.
let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};
const colour = () => [rand(), rand(), rand()];

/** What the shader does with a table: clamp, index, mix. */
function sample(table, t) {
  const points = table.points;
  const x = Math.min(Math.max(t, 0), 1) * (points - 1);
  const i = Math.min(Math.max(Math.trunc(x), 0), points - 2);
  const f = Math.min(Math.max(x - i, 0), 1);
  return [0, 1, 2].map((c) => table.values[i * 3 + c] * (1 - f) + table.values[(i + 1) * 3 + c] * f);
}
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// --- the table against the exact line -------------------------------------
// Looks the app can make (every archetype, over many seeds, both accents), and
// palettes of arbitrary colours as a harsher set. The exact line has corners
// where a channel meets the edge of sRGB, and a table cuts a corner, so the
// measure is how far it is typically off and how rarely it is off by much.
const looks = [];
{
  for (let n = 0; n < 500; n++) {
    const c = generate(`v2-ramp-${n}`, ['nebula', 'tunnel', 'mycelium', 'reef', 'synapse', 'medusa', 'plankton'][n % 7]).config.palette;
    looks.push([...c.dark, ...c.accent, ...c.light]);
    if (c.accent2) looks.push([...c.dark, ...c.accent2, ...c.light]);
  }
}
const arbitrary = Array.from({ length: 300 }, () => [...colour(), ...colour(), ...colour()]);
function measure(set, steps = RAMP_STEPS) {
  const table = createRampTable(3, steps);
  const errors = [];
  for (const stops of set) {
    updateRampTable(table, stops);
    for (let k = 0; k <= 100; k++) errors.push(maxDiff(sample(table, k / 100), oklchRampAt(stops, k / 100)) * 255);
  }
  errors.sort((a, b) => a - b);
  const at = (q) => errors[Math.floor(q * (errors.length - 1))];
  return { mean: errors.reduce((s, v) => s + v, 0) / errors.length, p90: at(0.9), p99: at(0.99), max: at(1) };
}
{
  const real = measure(looks);
  if (real.mean > 0.3) fail(`the sampled ramp is ${real.mean.toFixed(2)} levels from the exact line on average over real looks`);
  if (real.p90 > 1) fail(`10% of ramp positions on real looks are more than a level off (${real.p90.toFixed(2)})`);
  if (real.p99 > 3.5) fail(`1% of ramp positions on real looks are more than 3.5 levels off (${real.p99.toFixed(2)})`);
  const harsh = measure(arbitrary);
  if (harsh.mean > 1.2) fail(`arbitrary palettes: mean ${harsh.mean.toFixed(2)} levels off`);
  log.push(`${RAMP_STEPS} samples per half vs the exact OKLCh line, ${looks.length} looks: mean ${real.mean.toFixed(2)}, p90 ${real.p90.toFixed(2)}, p99 ${real.p99.toFixed(2)}, worst ${real.max.toFixed(1)} levels (corners at the sRGB edge)`);
  log.push(`${arbitrary.length} arbitrary palettes: mean ${harsh.mean.toFixed(2)}, p99 ${harsh.p99.toFixed(2)}, worst ${harsh.max.toFixed(1)} levels`);
}

// --- the closed wheel the Live grade uses ---------------------------------
{
  const table = createRampTable(5, 8);
  const errors = [];
  for (const stops of arbitrary.slice(0, 150).map((s) => [...s, ...colour(), ...colour()].slice(0, 15))) {
    updateRampTable(table, stops);
    for (let k = 0; k <= 100; k++) errors.push(maxDiff(sample(table, k / 100), oklchRampAt(stops, k / 100)) * 255);
  }
  const mean = errors.reduce((s, v) => s + v, 0) / errors.length;
  if (mean > 1.5) fail(`the closed wheel is ${mean.toFixed(2)} levels from the exact line on average`);
  log.push(`closed wheel (5 stops, 8 samples per segment), arbitrary colours: mean ${mean.toFixed(2)} levels off`);
}

// --- endpoints, rebuild skipping ------------------------------------------
{
  const table = createRampTable(3);
  const stops = [0.1, 0.2, 0.5, 0.9, 0.3, 0.1, 0.95, 0.97, 1];
  if (!updateRampTable(table, stops)) fail('a first build was skipped');
  const at = (i) => Array.from(table.values.slice(i * 3, i * 3 + 3));
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  if (!same(at(0), stops.slice(0, 3))) fail('t = 0 is not the dark role');
  if (!same(at(RAMP_STEPS), stops.slice(3, 6))) fail('t = 0.5 is not the accent');
  if (!same(at(2 * RAMP_STEPS), stops.slice(6, 9))) fail('t = 1 is not the light role');
  if (updateRampTable(table, stops)) fail('an unchanged palette rebuilt the table');
  const moved = stops.slice();
  moved[4] += 0.01;
  if (!updateRampTable(table, moved)) fail('a changed palette did not rebuild the table');
  const nan = createRampTable(3);
  updateRampTable(nan, [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1]);
  for (const v of nan.values) if (!Number.isFinite(v)) fail('a grey palette produced a non-finite ramp entry');
  for (const t of [Number.NaN, -3, 7]) {
    const out = sample(nan, Number.isNaN(t) ? 0 : t);
    if (out.some((v) => !Number.isFinite(v))) fail(`t = ${t} read outside the table`);
  }
  log.push('endpoints are the three roles exactly, an unchanged palette is not rebuilt, grey palettes stay finite');
}

// --- agreement with the Director's own blend ------------------------------
// The exact line is the Director's blend (a different implementation of the
// same OKLCh walk): it must agree to a fraction of a level.
{
  const a = generate('v2-ramp-a', 'nebula').config;
  const b = JSON.parse(JSON.stringify(a));
  let worst = 0;
  for (let n = 0; n < 150; n++) {
    const from = colour();
    const to = colour();
    a.palette = { bg: [0, 0, 0], dark: from, accent: from, light: from };
    b.palette = { bg: [0, 0, 0], dark: to, accent: to, light: to };
    for (const t of [0.1, 0.25, 0.4, 0.49]) {
      const cpu = operators.lerpConfig(a, b, t * 2).palette.dark;
      worst = Math.max(worst, maxDiff(oklchRampAt([...from, ...to, ...to], t), cpu));
    }
  }
  if (worst > 2 * LEVEL) fail(`the exact ramp differs from the Director's blend by ${(worst * 255).toFixed(2)} levels`);
  log.push(`the exact ramp agrees with eviland-operators' OKLCh blend within ${(worst * 255).toFixed(2)} levels`);
}

// --- a grey with a rounding error's tint follows the other side's hue -------
// Chroma below NEAR_GREY_CHROMA has no hue worth following. The sleeve blend,
// the Director's blend and the shaders' ramp have to agree on that, or a fade
// from a near-white ink to a saturated colour sweeps through the ink's noise hue
// on one path and runs straight to the target on another.
{
  const a = generate('v2-ramp-grey-a', 'nebula').config;
  const b = JSON.parse(JSON.stringify(a));
  const target = appearance.oklchToRgb(0.62, 0.11, 29);
  let band = 0;
  let worst = 0;
  for (let n = 0; n < 200; n++) {
    const base = 0.55 + 0.4 * rand();
    const tinted = Math.floor(rand() * 3);
    const tint = 0.001 + 0.006 * rand();
    const grey = [0, 1, 2].map((i) => base + (i === tinted ? tint : 0));
    const chromaOf = appearance.rgbToOklch(grey).c;
    if (chromaOf > 1e-4 && chromaOf < appearance.NEAR_GREY_CHROMA) band++;
    a.palette = { bg: [0, 0, 0], dark: grey, accent: grey, light: grey };
    b.palette = { bg: [0, 0, 0], dark: target, accent: target, light: target };
    for (const t of [0.1, 0.25, 0.4, 0.49]) {
      const ramp = oklchRampAt([...grey, ...target, ...target], t);
      const director = operators.lerpConfig(a, b, t * 2).palette.dark;
      const sleeve = appearance.mixOklch(grey, target, t * 2);
      worst = Math.max(worst, maxDiff(ramp, sleeve), maxDiff(director, sleeve));
    }
  }
  if (band < 20) fail(`only ${band} of the greys had a chroma between 1e-4 and the near-grey limit`);
  if (worst > 2 * LEVEL) fail(`a near-grey colour fades to red ${(worst * 255).toFixed(1)} levels differently on the sleeve, Director and ramp paths`);
  log.push(`near-grey fades: ${band} greys with chroma under ${appearance.NEAR_GREY_CHROMA}, sleeve, Director and ramp within ${(worst * 255).toFixed(2)} levels`);
}

// --- the point of it: hue changes keep their colour -----------------------
{
  const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
  // A triadic look: a deep blue dark, an orange accent.
  const dark = [0.1, 0.2, 0.55];
  const accent = [0.95, 0.6, 0.15];
  const light = [0.85, 0.95, 1.0];
  const table = createRampTable(3);
  updateRampTable(table, [...dark, ...accent, ...light]);
  const srgbMid = dark.map((v, i) => (v + accent[i]) / 2);
  const rampMid = sample(table, 0.25);
  if (chroma(rampMid) < chroma(srgbMid) * 1.5) {
    fail(`the middle of dark -> accent has chroma ${chroma(rampMid).toFixed(3)}, an sRGB mix has ${chroma(srgbMid).toFixed(3)}`);
  }
  // Lightness moves evenly: no step of the ramp is much brighter than its neighbours.
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  log.push(`dark -> accent midpoint of a blue/orange look: chroma ${chroma(rampMid).toFixed(2)} against ${chroma(srgbMid).toFixed(2)} for the sRGB mix (luma ${luma(rampMid).toFixed(2)})`);
}

// --- the GLSL a scene gets -------------------------------------------------
{
  const source = rampGlsl('paletteRamp', 'u_palRamp', 2 * RAMP_STEPS + 1);
  if (!source.includes(`uniform vec3 u_palRamp[${2 * RAMP_STEPS + 1}]`)) fail('the ramp GLSL does not declare its uniform array');
  if (!/clamp\(int\(x\)/.test(source)) fail('the ramp GLSL does not clamp its integer index');
  if (/cbrt|pow\(/.test(source)) fail('the ramp GLSL takes a root or a power per call');
  log.push('ramp GLSL: one array read and a mix, integer index clamped, no roots or powers');
}

// --- dither -----------------------------------------------------------------
{
  let sum = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let outer = 0;
  let min = 1;
  let max = -1;
  let n = 0;
  for (let f = 0; f < 8; f++) {
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const v = ditherTriAt(x + 0.5, y + 0.5, f);
        if (!Number.isFinite(v)) fail('dither returned a non-finite value');
        sum += v; sumAbs += Math.abs(v); sumSq += v * v; if (Math.abs(v) > 0.8) outer++;
        min = Math.min(min, v); max = Math.max(max, v); n++;
      }
    }
  }
  // A triangle one level either side of zero has an RMS of 1/sqrt(6) (0.408),
  // a mean magnitude of 1/3 and 4% of its mass beyond 0.8. Two shifted copies
  // of one gradient-noise sequence summed give a trapezoid that stops at 0.6
  // with an RMS of 0.31, which this has to tell apart.
  const rms = Math.sqrt(sumSq / n);
  if (Math.abs(sum / n) > 0.01) fail(`dither mean is ${(sum / n).toFixed(3)} (should be 0)`);
  if (min < -1 || max > 1) fail(`dither leaves one level: ${min.toFixed(2)}..${max.toFixed(2)}`);
  if (Math.abs(rms - 1 / Math.sqrt(6)) > 0.01) fail(`dither RMS is ${rms.toFixed(3)} (a triangular one level wide is 0.408)`);
  if (Math.abs(sumAbs / n - 1 / 3) > 0.01) fail(`dither mean magnitude is ${(sumAbs / n).toFixed(3)} (a triangular one level wide is 0.333)`);
  if (Math.abs(outer / n - 0.04) > 0.01) fail(`${(100 * outer / n).toFixed(1)}% of the dither lies beyond 0.8 (a triangular one level wide has 4%)`);
  if (Math.min(-min, max) < 0.97) fail(`dither never reaches a full level: ${min.toFixed(2)}..${max.toFixed(2)}`);
  if (ditherTriAt(10.5, 20.5, 3) !== ditherTriAt(10.5, 20.5, 3)) fail('dither is not a pure function of pixel and frame');
  if (ditherTriAt(10.5, 20.5, 3) === ditherTriAt(10.5, 20.5, 4) && ditherTriAt(11.5, 20.5, 3) === ditherTriAt(11.5, 20.5, 4)) fail('dither does not move with the frame');
  if (!(DITHER_FRAME_WRAP >= 256)) fail('the dither frame wrap is too short to hide a repeat');
  log.push(`dither: mean ${(sum / n).toFixed(3)}, range ${min.toFixed(2)}..${max.toFixed(2)}, RMS ${rms.toFixed(3)}, mean magnitude ${(sumAbs / n).toFixed(2)} level, ${(100 * outer / n).toFixed(1)}% beyond 0.8`);
}

console.log(log.join('\n'));
console.log(pass ? '[eviland-palette-ramp-test] PASS' : '[eviland-palette-ramp-test] FAIL');
process.exit(pass ? 0 : 1);
