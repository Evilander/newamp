// Channel plumbing + SEED-CODE STABILITY for the fluid channels. The goldens
// were captured from the randomizer BEFORE fluid/vorticity were added; they
// must never change, proving shared seed codes keep their exact look.
// Run: node scripts/eviland-operators-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-operators-test-result.txt');
writeFileSync(RESULT, '[eviland-operators-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-randomizer.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-rand-bundle.mjs'), logLevel: 'silent',
});
const { generate, mutate, ARCHETYPES } = await import(pathToFileURL(resolve('tmp/eviland-rand-bundle.mjs')).href);
await build({
  entryPoints: [resolve('src/visualizer/eviland-operators.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-ops-bundle.mjs'), logLevel: 'silent',
});
const { defaultConfig, cloneConfig, lerpConfig, createDynamics, evalConfig } = await import(pathToFileURL(resolve('tmp/eviland-ops-bundle.mjs')).href);

function mockFrame(over = {}) {
  return {
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.3, centroid: 0.4, flatness: 0.3, crest: 0.3, rolloff: 0.5,
    width: 0.4, pan: 0, novelty: 0.1, beatPhase: 0, beatConfidence: 0.5,
    ...over,
  };
}

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const close = (a, b) => Math.abs(a - b) < 1e-9;

// --- GOLDENS — DELIBERATELY REGENERATED 2026-06-10 for the 20-archetype
// expansion (plan §3 MilkDrop-variety rotation). The original goldens were
// captured against a 6-archetype rng.pick(ARCHETYPES); growing the list moves
// the same seed to a different archetype, which is the WHOLE POINT of the
// look-space expansion. Determinism itself (same seed → same config every
// run) is still asserted: a drift in these numbers between commits IS a real
// regression. Bake-down lineage:
//   seed   42 lattice      → solarflare  (20-archetype expansion, 2026-06-10)
//   seed 1337 kaleidoscope → nebula      (20-archetype expansion, 2026-06-10)
const GOLDEN = {
  42:   { zoom: 0.012179508161265402, rotate: -0.002692744402214885, swirl: 0.05601735921110958,  hueCycle: 0.00435064187948592,  decay: 0.868650261722505,  warpAmp: 0.0019754798347130418, mirrorMix: 0.5093598034000024, archetype: 'solarflare' },
  1337: { zoom: 0.0023478210328612484, rotate: 0.0005239231539890172, swirl: 0.03044383018743247, hueCycle: 0.005059137693140656, decay: 0.9176422854047269,  warpAmp: 0.0012012546863406897, mirrorMix: 0.2102690623374656, archetype: 'nebula' },
};
for (const seed of [42, 1337]) {
  const c = generate(seed).config;
  const g = GOLDEN[seed];
  for (const k of ['zoom', 'rotate', 'swirl', 'hueCycle', 'decay', 'warpAmp', 'mirrorMix']) {
    if (!close(c[k].base, g[k])) fail(`seed ${seed} ${k}.base drifted: ${c[k].base} != ${g[k]}`);
  }
  if (c.archetype !== g.archetype) fail(`seed ${seed} archetype drifted`);
  log.push(`seed ${seed}: goldens hold (${c.archetype})`);
}

// --- fluid channels exist, in range, everywhere ---
for (const seed of [42, 1337, 7, 'NEON-RIVER']) {
  const c = generate(seed).config;
  if (!c.fluid || typeof c.fluid.base !== 'number') fail(`seed ${seed}: missing fluid channel`);
  if (!c.vorticity || typeof c.vorticity.base !== 'number') fail(`seed ${seed}: missing vorticity channel`);
  if (c.fluid && (c.fluid.base < 0 || c.fluid.base > 1)) fail(`seed ${seed}: fluid.base out of range`);
  if (c.vorticity && (c.vorticity.base < 0 || c.vorticity.base > 30)) fail(`seed ${seed}: vorticity.base out of range`);
}
log.push('fluid/vorticity present + in range across seeds');

// defaultConfig has them; clone/lerp roundtrip them.
const d = defaultConfig();
if (!d.fluid || !d.vorticity) fail('defaultConfig missing fluid channels');
const a = generate(42).config; const b = generate(1337).config;
const mid = lerpConfig(a, b, 0.5);
if (!close(mid.fluid.base, (a.fluid.base + b.fluid.base) / 2)) fail('lerpConfig does not interpolate fluid.base');
const cl = cloneConfig(a);
if (cl.fluid === a.fluid) fail('cloneConfig must deep-copy fluid channel');
if (!close(cl.fluid.base, a.fluid.base)) fail('cloneConfig fluid value mismatch');

// mutate keeps them in safe range.
const m = mutate(a, 1, 99);
if (m.fluid.base < 0 || m.fluid.base > 1) fail('mutate pushed fluid out of range');
log.push('default/clone/lerp/mutate plumbing OK');

// ─── PLAN §2.1 Q-VARS ──────────────────────────────────────────────────────
{
  // Build a config that uses every q-var feature: base, LFO, smooth, bindings,
  // and a channel that reads q1. Determinism: same beatPhase → same q[0].
  const baseCfg = defaultConfig();
  const cfg = {
    ...baseCfg,
    q: [
      { base: 0.25, lfo: { rate: 1, shape: 'sine' } },          // q1: sine tempo-locked
      { base: 0,    lfo: { rate: 2, shape: 'tri'  } },          // q2: triangle 2x
      { base: 0.5,  lfo: { rate: 0.5, shape: 'saw' } },         // q3: saw 0.5x
      { base: 0,    lfo: { rate: 1, shape: 'square' } },        // q4: square
      { base: 0.1,  smooth: 0.8, bindings: [{ feature: 'energy', gain: 0.9 }] }, // q5: smoothed
      { base: 0, bindings: [{ feature: 'q1', gain: 1 }] },      // q6: reads q1
      { base: 0 },                                              // q7: idle
      { base: 0 },                                              // q8: idle
    ],
    // Use q1 in a downstream channel to prove it propagates as a feature.
    zoom: { base: 0, bindings: [{ feature: 'q1', gain: 0.05 }] },
  };
  const out = createDynamics();
  // Frame at beatPhase=0.25 → sine(0.25*1*TAU) = sin(π/2) = 1, so q[0] should be 1.25
  evalConfig(cfg, mockFrame({ beatPhase: 0.25 }), 0.5, out);
  if (Math.abs(out.q[0] - 1.25) > 1e-6) fail(`q1 sine LFO at phase 0.25 expected 1.25, got ${out.q[0]}`);
  // q2 triangle at phase 0.25 (effective phase = 0.5 because rate=2) → peak at 0.5 returns -1+? Let's compute directly.
  // phase = 0.25*2 = 0.5; p = 0.5; (p<0.5 false) → v = 3 - p*4 = 3-2 = 1. base 0 → q[1] = 1.
  if (Math.abs(out.q[1] - 1) > 1e-6) fail(`q2 tri LFO at phase 0.25 expected 1, got ${out.q[1]}`);
  // q3 saw, rate=0.5, phase=0.25*0.5=0.125 → 0.125*2-1 = -0.75; base 0.5 → q[2] = -0.25
  if (Math.abs(out.q[2] - (-0.25)) > 1e-6) fail(`q3 saw LFO at phase 0.25 expected -0.25, got ${out.q[2]}`);
  // q4 square, phase=0.25 → first half → +1; base 0
  if (Math.abs(out.q[3] - 1) > 1e-6) fail(`q4 square LFO at phase 0.25 expected 1, got ${out.q[3]}`);
  // q5 smoothed: prev value was 0 (createDynamics zero-fills); base=0.1 + energy*0.9=0.27 + 0.1 = 0.37; smoothed = 0.8*0 + 0.2*0.37 = 0.074
  if (Math.abs(out.q[4] - (0.8 * 0 + 0.2 * (0.1 + 0.3 * 0.9))) > 1e-6) fail(`q5 EMA first-frame wrong: got ${out.q[4]}`);
  // q6 reads q1 (just-computed → 1.25)
  if (Math.abs(out.q[5] - 1.25) > 1e-6) fail(`q6 should read q1's just-computed value, got ${out.q[5]}`);
  // zoom: base 0 + q1*0.05 = 0.0625; clamped to [-0.12,0.25] → 0.0625
  if (Math.abs(out.zoom - 0.0625) > 1e-6) fail(`zoom should pick up q1 binding, got ${out.zoom}`);

  // Determinism: same frame inputs → same q array.
  const out2 = createDynamics();
  evalConfig(cfg, mockFrame({ beatPhase: 0.25 }), 0.5, out2);
  for (let i = 0; i < 8; i++) {
    if (Math.abs(out.q[i] - out2.q[i]) > 1e-9) fail(`q[${i}] not deterministic across runs`);
  }

  // EMA convergence: feed the same frame many times, q5 should converge to its non-smoothed value.
  const out3 = createDynamics();
  let last = 0;
  for (let i = 0; i < 200; i++) { evalConfig(cfg, mockFrame({ beatPhase: 0.25 }), 0.5, out3); last = out3.q[4]; }
  const target = 0.1 + 0.3 * 0.9; // 0.37
  if (Math.abs(last - target) > 1e-3) fail(`q5 EMA did not converge to ${target}, settled at ${last}`);

  // Clamp safety: a runaway LFO with crazy amp must not escape q's bound.
  const wild = {
    ...baseCfg,
    q: [{ base: 0, lfo: { rate: 1, shape: 'sine', amp: 1000 } }],
  };
  const outW = createDynamics();
  evalConfig(wild, mockFrame({ beatPhase: 0.25 }), 0, outW);
  if (outW.q[0] !== 8) fail(`q clamp top not enforced, got ${outW.q[0]}`);
  log.push('q-vars: shapes correct, determinism + EMA convergence + clamp OK');
}

// ─── PLAN §2.2–§2.5 NEW CHANNELS: clamp ranges + defaults ──────────────────
{
  const cfg = defaultConfig();
  const out = createDynamics();
  evalConfig(cfg, mockFrame(), 0.5, out);
  // Defaults: no new channels set → all radial/decayRGB/centre/echo are neutral.
  if (out.radialZoom !== 0 || out.radialRotate !== 0 || out.radialSwirl !== 0 || out.radialDecay !== 0) {
    fail('default config must produce 0 radial gains');
  }
  if (out.decayR !== 0 || out.decayG !== 0 || out.decayB !== 0) fail('default decayR/G/B must be 0');
  if (out.centreX !== 0.5 || out.centreY !== 0.5) fail('default centre must be 0.5,0.5');
  if (out.echoAlpha !== 0) fail('default echoAlpha must be 0');
  if (out.transition !== 1) fail('default transition must be 1 (no fade)');

  // Clamp: a runaway radial gain (audio-driven huge value) gets clamped.
  const wild = {
    ...cfg,
    radialZoom: { base: 99, bindings: [] },
    centreX: { base: 99, bindings: [] },
    echoAlpha: { base: 99, bindings: [] },
    decayR: { base: 99, bindings: [] },
    _transition: 0.5,
  };
  evalConfig(wild, mockFrame(), 0.5, out);
  if (out.radialZoom !== 0.4) fail(`radialZoom clamp top should be 0.4, got ${out.radialZoom}`);
  if (out.centreX !== 0.8)   fail(`centreX clamp top should be 0.8, got ${out.centreX}`);
  if (out.echoAlpha !== 0.9) fail(`echoAlpha clamp top should be 0.9, got ${out.echoAlpha}`);
  if (out.decayR !== 0.08)   fail(`decayR clamp top should be 0.08, got ${out.decayR}`);
  if (out.transition !== 0.5) fail(`transition pass-through should be 0.5, got ${out.transition}`);

  // Float flip channels round to 0/1 around 0.5.
  const flipCfg = {
    ...cfg,
    echoFlipX: { base: 0.7, bindings: [] },
    echoFlipY: { base: 0.3, bindings: [] },
  };
  evalConfig(flipCfg, mockFrame(), 0.5, out);
  if (out.echoFlipX !== 1 || out.echoFlipY !== 0) fail('echoFlip threshold at 0.5 wrong');

  log.push('new channels: defaults neutral, clamps enforced');
}

// ─── PLAN §2.6 CROSSFADE STAMPING ──────────────────────────────────────────
{
  const a2 = generate(42).config;
  const b2 = generate(1337).config;
  const mid = lerpConfig(a2, b2, 0.5);
  // lerpConfig must NOT stamp _transition itself (the Director decides).
  if (mid._transition !== undefined) fail('lerpConfig must leave _transition undefined; Director stamps for section fades only');
  // But if the Director set it, evalConfig must pass it through.
  const stamped = { ...mid, _transition: 0.3 };
  const out = createDynamics();
  evalConfig(stamped, mockFrame(), 0.5, out);
  if (Math.abs(out.transition - 0.3) > 1e-9) fail('evalConfig must propagate _transition to dynamics.transition');
  log.push('crossfade meta plumbing OK');
}

// ─── PLAN §3 ARCHETYPE DISTINCTNESS ────────────────────────────────────────
// Every archetype must produce a representative dynamics vector that no other
// archetype lives epsilon-close to. This catches lazy near-duplicates forever:
// if a future "carousel" gets retuned to look like "vortex", THIS test fails.
//
// We project to dynamics (the actual GPU-uniform space the renderer reacts to)
// because that's the surface the eye sees. Bindings collapse to base+typical
// audio contribution, q-LFOs evaluate at a fixed phase, etc.
{
  // Determinism: same seed → byte-identical config every run.
  const s1 = JSON.stringify(generate(98765).config);
  const s2 = JSON.stringify(generate(98765).config);
  if (s1 !== s2) fail('determinism broken: same seed produced different configs');

  // Build a representative frame that exercises every audio path.
  const rep = mockFrame({
    kick: 0.6, bass: 0.55, snare: 0.4, hat: 0.35, vocal: 0.4,
    energy: 0.55, centroid: 0.5, flatness: 0.3, crest: 0.45, rolloff: 0.55,
    width: 0.5, pan: 0.2, novelty: 0.35, beatPhase: 0.25, beatConfidence: 0.7,
  });
  const dyn = createDynamics();
  function archetypeVector(name) {
    // Seed each archetype with the same hash so cousins under different seeds
    // don't drown out the archetype-level identity; we want to catch templates
    // that bias toward the same look-space region, not RNG noise.
    const { config } = generate(`distinct::${name}`, name);
    evalConfig(config, rep, 0.5, dyn);
    // Vector: every visible knob normalised to roughly comparable scale.
    return [
      dyn.zoom * 10,
      dyn.rotate * 30,
      dyn.swirl * 8,
      dyn.hueCycle * 40,
      (dyn.decay - 0.88) * 30,            // re-centre around the typical mid-point
      dyn.warpAmp * 600,
      dyn.warpScale * 0.25,
      dyn.mirror * 0.15,
      dyn.mirrorMix * 3,
      dyn.flowX * 800,
      dyn.flowY * 800,
      dyn.fluid * 2.5,
      dyn.vorticity * 0.1,
      dyn.liquidMix * 4,
      dyn.dyeDissipation * 25,
      dyn.bloom * 4,
      dyn.waveMode * 0.5,
      dyn.waveIntensity * 2,
      dyn.waveScale * 4,
      dyn.emitterScale * 1.2,
      dyn.emitterGain * 1.5,
      dyn.radialZoom * 6,
      dyn.radialRotate * 18,
      dyn.radialSwirl * 4,
      dyn.radialDecay * 25,
      dyn.decayR * 30,
      dyn.decayG * 30,
      dyn.decayB * 30,
      (dyn.centreX - 0.5) * 10,
      (dyn.centreY - 0.5) * 10,
      dyn.echoZoom * 6,
      dyn.echoRotate * 6,
      dyn.echoAlpha * 5,
      dyn.echoFlipX * 3,
      dyn.echoFlipY * 3,
      // Palette accent hue, projected to a 2D unit-circle point so wraparound
      // doesn't collapse identical accents at h=0 and h=1.
      ...(() => {
        const p = config.palette;
        if (!p) return [0, 0, 0, 0, 0, 0];
        return [p.accent[0] * 2, p.accent[1] * 2, p.accent[2] * 2, p.dark[0], p.dark[1], p.dark[2]];
      })(),
    ];
  }
  const vecs = ARCHETYPES.map((name) => ({ name, v: archetypeVector(name) }));
  let minD = Infinity;
  let minPair = ['', ''];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      let sum = 0;
      const a = vecs[i].v, b = vecs[j].v;
      for (let k = 0; k < a.length; k++) sum += (a[k] - b[k]) ** 2;
      const d = Math.sqrt(sum);
      if (d < minD) { minD = d; minPair = [vecs[i].name, vecs[j].name]; }
    }
  }
  // Empirically the closest pairs (cousin looks like nebula↔inkwell) sit
  // around d~1.5. 0.9 leaves real room for tuning while still catching lazy
  // near-duplicates (twins would collapse to d<0.3).
  const EPS = 0.9;
  log.push(`archetype distinctness: ${ARCHETYPES.length} looks, closest pair (${minPair.join(' vs ')}) d=${minD.toFixed(3)} (threshold ${EPS})`);
  if (minD < EPS) fail(`two archetypes are visually too close: ${minPair.join(' vs ')} (d=${minD.toFixed(3)} < ${EPS})`);

  // Every archetype must be reachable in at least one tier of the Director
  // is asserted by the director test; here we at least verify every archetype
  // generates a valid config and stamps its own archetype field.
  for (const a of ARCHETYPES) {
    const { config } = generate(`reach::${a}`, a);
    if (config.archetype !== a) fail(`archetype tag drift: requested ${a}, got ${config.archetype}`);
    if (config.decay.base < 0.78 || config.decay.base > 0.97) fail(`${a}: decay.base out of safe range (${config.decay.base})`);
  }
  log.push(`every archetype generates + tags + clamps OK (${ARCHETYPES.length} looks)`);
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-operators-test] PASS' : '[eviland-operators-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
