// What the Eviland engine does with the readings the reactor now gives it:
// the final pass keeps colour in step with how noisy the music is, a trace of
// dye is laid over a look instead of mixed into it, the Live pipeline hands
// evalConfig a section seed in range, shader clocks stay wrapped, and the
// scene overlay calls a drop against the track's own level. No GPU: the
// shader text and the overlay's uniform calls are checked, and the blend is
// run in JS from the same expressions.
// Run: node scripts/eviland-engine-wiring-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp/eviland-engine-wiring-test');
mkdirSync(root, { recursive: true });
const bundle = async (name, contents) => {
  const outfile = resolve(root, `${name}.mjs`);
  await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
};

const engine = await bundle('engine', `export { postSaturation, DYE_LAID_BELOW, COMPOSE_FRAG, SHADER_TIME_WRAP, sectionSeedFor } from './src/visualizer/eviland';`);
const operators = await bundle('operators', `export { sectionSeedFor, evalConfig, createDynamics } from './src/visualizer/eviland-operators';`);
const overlayModule = await bundle('overlay', `export { createSceneOverlay } from './src/visualizer/scene-overlay';`);
const source = (path) => readFileSync(resolve(path), 'utf8');

// ── Saturation follows noisiness ────────────────────────────────────────────
{
  const { postSaturation } = engine;
  assert.ok(Math.abs(postSaturation(0.3) - 1) < 1e-9, 'tonal material keeps its whole palette');
  assert.ok(Math.abs(postSaturation(0) - 1) < 1e-9);
  assert.ok(Math.abs(postSaturation(0.9) - 0.7) < 1e-9, 'noise gives up 30 percent');
  assert.ok(Math.abs(postSaturation(1) - 0.7) < 1e-9);
  let previous = Infinity;
  for (let n = 0; n <= 1.0001; n += 0.01) {
    const s = postSaturation(n);
    assert.ok(s <= previous + 1e-12, `saturation rises at noisiness ${n.toFixed(2)}`);
    previous = s;
  }
  // Measured on real tracks: music reads about 0.3 to 0.85. The old rule
  // (1 - 0.55 * dB-flatness, 0.9 or more for all of it) left about half the colour.
  const oldRule = 1 - 0.55 * 0.9;
  for (let n = 0.3; n <= 0.85; n += 0.05) {
    assert.ok(postSaturation(n) >= 0.7, `noisiness ${n.toFixed(2)} is over-grey`);
    assert.ok(postSaturation(n) > oldRule * 1.3, `noisiness ${n.toFixed(2)} keeps less than 1.3x the old colour`);
  }
  assert.ok(postSaturation(0.4) - postSaturation(0.7) > 0.1, 'a dense mix is told from a sparse one');
  const middle = postSaturation(0.5);
  for (const bad of [undefined, NaN, Infinity, -Infinity, null]) {
    assert.equal(postSaturation(bad), middle, `a frame without a reading (${bad}) takes the middle of the range`);
  }
}

// ── Dye is laid over a faint look, mixed into a dye-led one ─────────────────
{
  const { COMPOSE_FRAG, DYE_LAID_BELOW } = engine;
  assert.equal(DYE_LAID_BELOW, 0.3);
  assert.match(COMPOSE_FRAG, /const float DYE_LAID_BELOW = 0\.30;/, 'the shader takes the threshold from the same constant');
  const shader = COMPOSE_FRAG.replace(/\s+/g, ' ');
  assert.match(shader, /vec3 laid = colour \+ dyeSat \* m;/);
  assert.match(shader, /vec3 mixed = mix\(colour, dyeFull, m\);/);
  assert.match(shader, /colour = mix\(laid, mixed, smoothstep\(DYE_LAID_BELOW, DYE_LAID_BELOW \+ 0\.15, m\)\);/);

  // The same three lines in JS, one channel.
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const blend = (colour, dye, floorCol, m) => {
    const dyeSat = dye / (1 + 0.35 * dye);
    const laid = colour + dyeSat * m;
    const mixed = colour + (Math.max(dyeSat, floorCol) - colour) * m;
    return laid + (mixed - laid) * smooth(0.3, 0.45, m);
  };
  const oldBlend = (colour, dye, floorCol, m) => {
    const dyeSat = dye / (1 + 0.35 * dye);
    return colour + (Math.max(dyeSat, floorCol) - colour) * m;
  };
  for (let m = 0; m < 0.3; m += 0.01) {
    for (const colour of [0, 0.2, 0.8, 2]) {
      for (const dye of [0, 0.05, 0.5, 3]) {
        assert.ok(blend(colour, dye, 0.01, m) >= colour - 1e-12, `a trace of dye (${m.toFixed(2)}) darkened a ${colour} field`);
      }
    }
  }
  // The look that carried a trace of dye used to lose that share of its light.
  assert.ok(oldBlend(0.8, 0, 0.01, 0.25) < 0.8 * 0.8, 'the old mix darkened an empty dye layer');
  assert.ok(blend(0.8, 0, 0.01, 0.25) >= 0.8, 'the laid layer does not');
  for (let m = 0.45; m <= 1.0001; m += 0.05) {
    assert.ok(Math.abs(blend(0.7, 1.2, 0.01, m) - oldBlend(0.7, 1.2, 0.01, m)) < 1e-12, `dye-led looks (${m.toFixed(2)}) still mix as before`);
  }
  for (let m = 0; m < 1; m += 0.0005) {
    assert.ok(Math.abs(blend(0.7, 1.2, 0.01, m + 0.0005) - blend(0.7, 1.2, 0.01, m)) < 2e-3, `the blend steps at liquidMix ${m.toFixed(4)}`);
  }
}

// ── Clocks and section seeds ────────────────────────────────────────────────
{
  const engineSource = source('src/visualizer/eviland.ts');
  assert.doesNotMatch(engineSource, /uniform1f\([^)]*\.time,\s*time\)/, 'a shader clock must be the wrapped shaderTime, never the running total');
  assert.match(engineSource, /const shaderTime = time % SHADER_TIME_WRAP;/);
  assert.equal((engineSource.match(/\.time, shaderTime\)/g) ?? []).length, 3, 'field, terrain and spectrum all get the wrapped clock');
  // A whole multiple of 200 pi seconds is a whole number of turns for every
  // oscillator at a multiple of 0.01 rad/s.
  const turns = engine.SHADER_TIME_WRAP * 0.01 / (2 * Math.PI);
  assert.ok(Math.abs(turns - Math.round(turns)) < 1e-9 && turns >= 1, `${turns} turns of the slowest rate`);
  // The noise drifts jump once per wrap, so it is hours, and a float32 clock
  // still resolves a millisecond that far out.
  assert.ok(engine.SHADER_TIME_WRAP > 3 * 3600, `the noise drifts hop every ${(engine.SHADER_TIME_WRAP / 60).toFixed(0)} minutes`);
  const spacing = 2 ** (Math.floor(Math.log2(engine.SHADER_TIME_WRAP)) - 23);
  assert.ok(spacing <= 0.0011, `float32 spacing at the wrap is ${spacing} s`);

  // Two bundles, so two function objects: one definition means one set of values.
  assert.match(engineSource, /import \{[^}]*\bsectionSeedFor\b[^}]*\} from '\.\/eviland-operators';/, 'the engine takes the seed function from the operators');
  assert.doesNotMatch(engineSource, /function sectionSeedFor/, 'and does not define a second one');
  for (let id = -50; id < 3000; id++) {
    assert.equal(engine.sectionSeedFor(id), operators.sectionSeedFor(id));
    const seed = operators.sectionSeedFor(id);
    assert.ok(seed >= 0 && seed < 1, `section ${id} gave seed ${seed}`);
  }
  for (const bad of [NaN, Infinity, -Infinity, undefined]) {
    const seed = operators.sectionSeedFor(bad);
    assert.ok(seed >= 0 && seed < 1, `section ${bad} gave seed ${seed}`);
  }
  assert.equal(operators.sectionSeedFor(7), operators.sectionSeedFor(7));
  assert.notEqual(operators.sectionSeedFor(3), operators.sectionSeedFor(4));

  const live = source('src/visualizer/eviland-live-pipeline.ts');
  assert.match(live, /evalConfig\(current\.config, frame, sectionSeedFor\(frame\.sectionId\), dyn, dt \* 1000\);/, 'the Live pipeline passes a 0..1 seed, not the raw section number');
  assert.doesNotMatch(live, /evalConfig\([^)]*frame\.sectionId,/, 'and never the raw section number');

  // What the raw number did: a section base rotation grown with the section count.
  const { evalConfig, createDynamics } = operators;
  const config = {
    version: 1, name: 't', spinFromSection: true,
    zoom: { base: 0 }, rotate: { base: 0 }, swirl: { base: 0 }, hueCycle: { base: 0 }, decay: { base: 0.9 },
    warpAmp: { base: 0 }, warpScale: { base: 2 }, mirror: { base: 6 }, mirrorMix: { base: 0 }, flowX: { base: 0 }, flowY: { base: 0 },
    fluid: { base: 0 }, vorticity: { base: 0 }, liquidMix: { base: 0 }, dyeDissipation: { base: 0 }, bloom: { base: 0 },
    waveform: { mode: 'off', intensity: { base: 0 }, thickness: 0.01, scale: 0.3 }, emitterScale: 1, emitterGain: 1,
  };
  const frame = { kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0, energy: 0.3, centroid: 0.5, flatness: 0.5, crest: 0.3, rolloff: 0.5, width: 0.3, pan: 0, novelty: 0, beatPhase: 0, beatConfidence: 0 };
  const out = createDynamics();
  let worst = 0;
  for (let id = 0; id < 40; id++) {
    evalConfig(config, frame, operators.sectionSeedFor(id), out, 16);
    worst = Math.max(worst, Math.abs(out.rotate));
  }
  assert.ok(worst <= 0.0028, `section base rotation reached ${worst} rad/frame`);
}

// ── A drop is a jump on the track's own level ───────────────────────────────
{
  const { createSceneOverlay } = overlayModule;
  function fakeGl() {
    const state = { flashes: 0 };
    const impl = {
      getExtension: () => null,
      createVertexArray: () => ({}),
      createShader: () => ({}),
      createProgram: () => ({ shaders: [] }),
      shaderSource: (shader, text) => { shader.text = text; },
      attachShader: (program, shader) => program.shaders.push(shader),
      getProgramParameter: () => true,
      getShaderParameter: () => true,
      getUniformLocation: (_program, name) => ({ name }),
      uniform4f: (loc) => { if (loc?.name === 'u_color') state.flashes += 1; },
    };
    const gl = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in impl) return impl[prop];
        if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1;
        return () => ({});
      },
    });
    return { gl, state };
  }
  const frameWith = (over = {}) => ({
    bands: new Float32Array(24).fill(0.3), onsets: [],
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.3, centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.4, pan: 0,
    beatPhase: 0, beatConfidence: 0.6, bpm: 120, novelty: 0,
    sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
    ...over,
  });
  const palette = { accent: [0.5, 0.5, 1], light: [0.9, 0.9, 1], dark: [0.1, 0.1, 0.3], bg: [0, 0, 0.02] };
  // Settle on a level, then change section at another one. Returns the flashes drawn.
  function flashesFor({ base, jumpTo, section = true, confidence = 0.6 }) {
    const { gl, state } = fakeGl();
    const overlay = createSceneOverlay({ width: 64, height: 64 }, { gl, syncCompile: true, seedKey: 'drop-test' });
    for (let i = 0; i < 800; i++) overlay.render(frameWith({ energy: base }), palette, 16);
    assert.equal(state.flashes, 0, 'no flash while nothing happens');
    for (let i = 0; i < 12; i++) {
      overlay.render(frameWith({ energy: jumpTo, sectionId: section ? 1 : 0, sectionChanged: section, beatConfidence: confidence }), palette, 16);
    }
    overlay.dispose();
    return state.flashes;
  }
  assert.ok(flashesFor({ base: 0.3, jumpTo: 0.45 }) > 0, 'a section change 50% over the settled level is a drop, though 0.45 is under half scale');
  assert.ok(flashesFor({ base: 0.1, jumpTo: 0.2 }) > 0, 'on a track that sits low, a doubling is a drop');
  assert.equal(flashesFor({ base: 0.3, jumpTo: 0.38 }), 0, 'a small rise is not');
  assert.equal(flashesFor({ base: 0.3, jumpTo: 0.45, section: false }), 0, 'without a section change it is not');
  assert.equal(flashesFor({ base: 0.3, jumpTo: 0.45, confidence: 0.2 }), 0, 'without a beat to land on it is not');
  assert.doesNotMatch(source('src/visualizer/scene-overlay.ts'), /Math\.max\(0\.5, energyEma/, 'no absolute floor on the drop test');
}

console.log(JSON.stringify({ ok: true }, null, 2));
