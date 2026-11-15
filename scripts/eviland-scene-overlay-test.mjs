// What the scene overlay hands to a scene: how much of the field beneath it
// the scene covers (u_occlusion), a kick counter a pattern can safely re-roll
// on (u_kickCount, never faster than about three a second), and clocks that
// wrap before they reach float32 so a session left running all day keeps its
// resolution. Runs the real overlay against a stand-in GL context that records
// uniform uploads; shader compilation is covered by the scene smoke.
// Run: node scripts/eviland-scene-overlay-test.mjs
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/eviland-scene-overlay-test-bundle.mjs');
await build({
  entryPoints: [resolve('src/visualizer/scene-overlay.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
});
const { createSceneOverlay, wrapClock, CLOCK_WRAP_SECONDS } = await import(pathToFileURL(outfile).href);
const scenesOut = resolve('tmp/eviland-scene-overlay-test-scenes.mjs');
await build({
  entryPoints: [resolve('src/visualizer/scenes/index.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: scenesOut, logLevel: 'silent',
});
const { SCENES } = await import(pathToFileURL(scenesOut).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

/** A GL context that accepts every call the overlay makes and records the uniforms of each draw. */
function fakeGl() {
  const state = { last: {}, draws: [], fragments: [], bound: null };
  const sources = new Map();
  const impl = {
    getExtension: () => null,
    createVertexArray: () => ({}),
    createShader: () => ({}),
    createProgram: () => ({ shaders: [] }),
    shaderSource: (shader, text) => { shader.text = text; },
    attachShader: (program, shader) => program.shaders.push(shader),
    linkProgram: (program) => { state.fragments.push(program.shaders.map((s) => s.text).join('\n')); },
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getUniformLocation: (_program, name) => ({ name }),
    useProgram: (program) => { state.bound = program; },
    uniform1f: (loc, v) => { state.last[loc.name] = v; },
    uniform1fv: (loc, v) => { state.last[loc.name] = Array.from(v); },
    drawArrays: () => { state.draws.push({ ...state.last, program: state.bound }); },
  };
  const gl = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in impl) return impl[prop];
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1;
      return () => ({});
    },
  });
  return { gl, state, sources };
}

const ONSETS = {
  kick: [{ band: 1, group: 'kick', intensity: 0.9, sharpness: 0.8 }],
  bass: [{ band: 1, group: 'bass', intensity: 0.9, sharpness: 0.8 }],
  snare: [{ band: 8, group: 'snare', intensity: 0.7, sharpness: 0.6 }],
};
function frameWith(over = {}) {
  return {
    bands: new Float32Array(24).fill(0.3),
    onsets: [],
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.5, centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.4, pan: 0,
    beatPhase: 0, beatConfidence: 0.5, bpm: 120, novelty: 0,
    sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
    ...over,
  };
}
const PALETTE = { accent: [0.5, 0.5, 1], light: [0.9, 0.9, 1], dark: [0.1, 0.1, 0.3], bg: [0, 0, 0.02] };

function overlayFor(sceneId) {
  const { gl, state } = fakeGl();
  const overlay = createSceneOverlay({ width: 64, height: 64 }, { gl, syncCompile: true, seedKey: 'overlay-test' });
  overlay.setScene(sceneId);
  return { overlay, state };
}

// --- wrapClock ------------------------------------------------------------
{
  if (wrapClock(10) !== 10) fail('a small clock was changed');
  if (wrapClock(-5) !== -5) fail('a negative clock was changed');
  if (!(CLOCK_WRAP_SECONDS > 3600 * 4 && CLOCK_WRAP_SECONDS < 3600 * 10)) fail(`wrap period ${CLOCK_WRAP_SECONDS} s is outside 4-10 hours`);
  let worst = 0;
  for (const k of [1, 2, 3, 5, 8, 13, 24]) {
    for (const t of [CLOCK_WRAP_SECONDS - 0.01, CLOCK_WRAP_SECONDS + 0.01, 3 * CLOCK_WRAP_SECONDS + 7.3, 40 * CLOCK_WRAP_SECONDS + 0.5]) {
      worst = Math.max(worst, Math.abs(Math.sin(wrapClock(t) * k) - Math.sin(t * k)));
    }
  }
  if (worst > 1e-6) fail(`sin(k * clock) jumps by ${worst} across a wrap`);
  for (const t of [0, 1e3, 5e4, 1e6, 4e7]) {
    const wrapped = wrapClock(t);
    if (Math.abs(wrapped) >= CLOCK_WRAP_SECONDS) fail(`wrapClock(${t}) = ${wrapped} is not under one period`);
    // Resolution a float32 has at the wrapped value.
    const ulp = wrapped === 0 ? 0 : 2 ** (Math.floor(Math.log2(Math.abs(wrapped))) - 23);
    if (ulp > 0.002) fail(`float32 spacing at ${wrapped} is ${ulp}`);
  }
  log.push(`clock wraps every ${(CLOCK_WRAP_SECONDS / 3600).toFixed(1)} h; whole-number sines carry on through it`);
}

// --- the uniforms the shaders get ----------------------------------------
{
  const { overlay, state } = overlayFor('glitch-bars');
  overlay.render(frameWith(), PALETTE, 16);
  const source = state.fragments[0] ?? '';
  for (const name of ['u_occlusion', 'u_kickCount', 'bandClock']) {
    if (!source.includes(name)) fail(`the shader prelude does not declare ${name}`);
  }
  if (!/c\.a \* u_fade \* u_occlusion/.test(source)) fail('main() does not scale the stored alpha by u_occlusion');
  if (!/c\.rgb \* c\.a \* u_fade[^*]/.test(source)) fail('the colour is not premultiplied by alpha and fade');
  overlay.dispose();
  log.push('prelude declares u_occlusion, u_kickCount and bandClock; alpha is scaled by occlusion');
}
{
  // Per-band pan reaches the shader: the reactor's values when the frame has
  // them, the whole-frame pan when it does not, scaled by the host's spread.
  const { overlay, state } = overlayFor('glitch-bars');
  overlay.render(frameWith(), PALETTE, 16);
  const source = state.fragments[0] ?? '';
  if (!/uniform float u_bandPan\[24\]/.test(source)) fail('the shader prelude does not declare u_bandPan[24]');
  if (!/float bandPan\(int lo, int hi\)/.test(source)) fail('the shader prelude does not define bandPan(lo, hi)');
  const pans = new Float32Array(24).fill(0).map((_, i) => (i - 11.5) / 12);
  overlay.render(frameWith({ pan: 0.4, bandPan: pans }), PALETTE, 16);
  const sent = state.last.u_bandPan;
  if (!sent || sent.length !== 24 || sent.some((v, i) => Math.abs(v - pans[i]) > 1e-6)) fail('u_bandPan is not the frame bandPan');
  overlay.render(frameWith({ pan: 0.4 }), PALETTE, 16);
  if (!state.last.u_bandPan.every((v) => Math.abs(v - 0.4) < 1e-6)) fail('a frame without bandPan does not fall back to its pan');
  overlay.render(frameWith({ pan: 0.4, bandPan: pans }), PALETTE, 16, { framebuffer: null, width: 64, height: 64, stereoSpread: 0.5 });
  if (state.last.u_bandPan.some((v, i) => Math.abs(v - pans[i] * 0.5) > 1e-6)) fail('stereoSpread does not scale u_bandPan');
  const bad = new Float32Array(24).fill(NaN);
  overlay.render(frameWith({ bandPan: bad }), PALETTE, 16);
  if (!state.last.u_bandPan.every((v) => v === 0)) fail('a NaN band pan reached the shader');
  overlay.dispose();
  log.push('u_bandPan carries the band pans, falls back to pan, follows stereoSpread and never sends NaN');
}
{
  let checked = 0;
  for (const def of SCENES) {
    const { overlay, state } = overlayFor(def.id);
    overlay.render(frameWith(), PALETTE, 16);
    const draw = state.draws[state.draws.length - 1];
    overlay.dispose();
    if (!draw) { fail(`${def.id} never drew`); continue; }
    const want = def.occlusion ?? 0.35;
    if (draw.u_occlusion !== want) fail(`${def.id} uploaded occlusion ${draw.u_occlusion}, expected ${want}`);
    checked++;
  }
  log.push(`${checked} scenes upload their occlusion (0.35 unless they say otherwise)`);
}

// --- GLSL the specification leaves undefined -------------------------------
// pow(x, y) is undefined for x < 0, so a square is written x * x (sq() in the
// prelude); smoothstep(a, b, x) is undefined for a >= b, so a falling edge is
// 1.0 - smoothstep(b, a, x). Drivers mostly agree on what these do, but a
// driver that lowers pow to exp2(y * log2(x)) turns a negative base into NaN,
// which a feedback buffer keeps. Nothing on the machines this runs on can
// show that, so the shader text each scene is compiled from is checked for the
// two forms; only edges written as numbers can be read this way.
{
  /** The argument lists of every `name(...)` call in GLSL source, comments removed. */
  const callsOf = (glsl, name) => {
    const code = glsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const calls = [];
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(code))) {
      let depth = 1;
      let arg = '';
      const args = [];
      for (let i = m.index + m[0].length; i < code.length && depth > 0; i++) {
        const ch = code[i];
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) break;
        if (ch === ',' && depth === 1) { args.push(arg.trim()); arg = ''; } else arg += ch;
      }
      args.push(arg.trim());
      calls.push(args);
    }
    return calls;
  };
  const number = (text) => (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/.test(text) ? Number(text) : null);

  // The scan has to see what it is looking for: planted forms are found.
  if (callsOf('x = pow(a - b, 2.0); // pow(c, 2.0)', 'pow').length !== 1) fail('the shader scan misses a pow call or reads a comment');
  if (callsOf('y = smoothstep(f(1.0, 2.0), 0.0, d);', 'smoothstep')[0]?.length !== 3) fail('the shader scan splits a smoothstep call inside a nested call');

  let scanned = 0;
  for (const def of SCENES) {
    const { overlay, state } = overlayFor(def.id);
    overlay.render(frameWith(), PALETTE, 16);
    const source = state.fragments[0] ?? '';
    overlay.dispose();
    if (!source) { fail(`${def.id} compiled no shader source`); continue; }
    for (const [base, power] of callsOf(source, 'pow').filter((args) => args.length === 2)) {
      if (number(power) === 2) fail(`${def.id}: pow(${base}, ${power}) is undefined for a negative base; write sq(${base})`);
    }
    for (const [low, high] of callsOf(source, 'smoothstep').filter((args) => args.length === 3)) {
      const a = number(low);
      const b = number(high);
      if (a !== null && b !== null && a >= b) fail(`${def.id}: smoothstep(${low}, ${high}, ...) has its edges the wrong way round; write 1.0 - smoothstep(${high}, ${low}, ...)`);
    }
    scanned++;
  }
  log.push(`${scanned} scenes: no pow(x, 2.0), no smoothstep with numeric edges that fall`);
}

// --- kick counter ---------------------------------------------------------
{
  const run = (onsetsAt, seconds, dtMs = 16) => {
    const { overlay, state } = overlayFor('glitch-bars');
    const counts = [];
    const frames = Math.round((seconds * 1000) / dtMs);
    for (let i = 0; i < frames; i++) {
      overlay.render(frameWith({ onsets: onsetsAt(i * dtMs) }), PALETTE, dtMs);
      counts.push(state.draws[state.draws.length - 1].u_kickCount);
    }
    overlay.dispose();
    return counts;
  };
  const perSecond = (counts, dtMs = 16) => {
    const window = Math.round(1000 / dtMs);
    let worst = 0;
    for (let i = window; i < counts.length; i++) worst = Math.max(worst, counts[i] - counts[i - window]);
    return worst;
  };
  // A kick on every frame: the counter still moves at about 3 a second. A
  // pixel flips once per count, so even the busiest second is two flashes.
  const storm = run(() => ONSETS.kick, 12);
  const stormRate = perSecond(storm);
  if (stormRate > 4) fail(`a kick on every frame moved the counter ${stormRate} times in one second`);
  if (storm[storm.length - 1] > 12 * 3.2) fail(`the counter reached ${storm[storm.length - 1]} in 12 s of constant kicks`);
  if (storm[storm.length - 1] < 25) fail(`the counter only reached ${storm[storm.length - 1]} in 12 s of constant kicks`);
  // 175 BPM: every kick is counted (343 ms apart is above the minimum gap).
  const period = 60000 / 175;
  const fast = run((ms) => (Math.floor(ms / period) !== Math.floor((ms - 16) / period) ? ONSETS.kick : []), 12);
  if (perSecond(fast) > 4) fail('175 BPM moved the counter more than 4 times in a second');
  const expected = Math.floor(12000 / period);
  if (Math.abs(fast[fast.length - 1] - expected) > 2) fail(`175 BPM: counted ${fast[fast.length - 1]} kicks, expected about ${expected}`);
  // Bass onsets count; snares do not.
  const bass = run((ms) => (Math.floor(ms / 500) !== Math.floor((ms - 16) / 500) ? ONSETS.bass : []), 5);
  if (bass[bass.length - 1] < 8) fail('bass onsets are not counted');
  const snare = run((ms) => (Math.floor(ms / 500) !== Math.floor((ms - 16) / 500) ? ONSETS.snare : []), 5);
  if (snare[snare.length - 1] !== 0) fail('snare onsets moved the kick counter');
  // Silence leaves it where it was.
  const silent = run(() => [], 3);
  if (silent[silent.length - 1] !== 0) fail('silence moved the kick counter');
  log.push(`kick counter: at most ${stormRate} a second under a kick every frame, 175 BPM counted ${fast[fast.length - 1]}/${expected}`);
}

// --- kick age -------------------------------------------------------------
{
  // u_kickAge restarts when the count moves and at no other time. A kick that
  // lands inside the minimum gap is not counted, and must not restart it: a
  // scene easing its newest kick in would jump back to the start.
  const { overlay, state } = overlayFor('glitch-bars');
  const dtMs = 16;
  const crossed = (ms, at) => Math.floor((ms - at) / 1000) !== Math.floor((ms - at - dtMs) / 1000);
  const rows = [];
  for (let i = 0; i < Math.round(6000 / dtMs); i++) {
    const ms = i * dtMs;
    // A kick each second from 1 s on, and a second one 112 ms after it.
    const kick = ms >= 1000 && (crossed(ms, 0) || crossed(ms, 112));
    overlay.render(frameWith({ onsets: kick ? ONSETS.kick : [] }), PALETTE, dtMs);
    const draw = state.draws[state.draws.length - 1];
    rows.push({ count: draw.u_kickCount, age: draw.u_kickAge });
  }
  overlay.dispose();
  if (rows[0].age === undefined) fail('the shader prelude does not declare u_kickAge');
  // Before the first kick the age sits at its cap, a value a float32 holds exactly.
  if (rows[0].age !== 600) fail(`before the first kick the age is ${rows[0].age}, not the 600 s cap`);
  let restarts = 0;
  for (let i = 1; i < rows.length; i++) {
    const moved = rows[i].count !== rows[i - 1].count;
    if (moved) {
      restarts++;
      if (rows[i].age > dtMs / 1000 + 1e-6) fail(`the count moved and the age is ${rows[i].age}`);
    } else if (rows[i - 1].age < 60 && Math.abs(rows[i].age - rows[i - 1].age - dtMs / 1000) > 1e-4) {
      fail(`the age went from ${rows[i - 1].age} to ${rows[i].age} on a frame with no counted kick`);
    }
  }
  if (restarts !== 5) fail(`ten kicks in pairs moved the count ${restarts} times, expected 5`);
  log.push(`kick age: restarts on each of ${restarts} counted kicks, runs on through the uncounted ones`);
}

// --- clocks wrap ---------------------------------------------------------
{
  const { overlay, state } = overlayFor('eye-of-storm');
  const dtMs = 100;
  const steps = Math.ceil((CLOCK_WRAP_SECONDS * 1000 * 1.02) / dtMs);
  const hot = frameWith({ energy: 1, pan: -1, bands: new Float32Array(24).fill(1) });
  let previous = null;
  let wrapAt = -1;
  let largestStep = 0;
  for (let i = 1; i <= steps; i++) {
    overlay.render(hot, PALETTE, dtMs);
    const draw = state.draws[state.draws.length - 1];
    state.draws.length = 0;
    if (previous) {
      const jump = draw.u_globalTime - previous.u_globalTime;
      if (jump < 0 && wrapAt < 0) wrapAt = i;
      else largestStep = Math.max(largestStep, jump);
    }
    previous = draw;
  }
  const last = previous;
  const real = (steps * dtMs) / 1000;
  if (wrapAt < 0) fail('u_globalTime never wrapped');
  if (Math.abs(last.u_globalTime - wrapClock(real)) > 1e-3) fail(`u_globalTime ${last.u_globalTime} is not the wrapped clock ${wrapClock(real)}`);
  if (!(last.u_globalTime >= 0 && last.u_globalTime < CLOCK_WRAP_SECONDS)) fail('u_globalTime left [0, period)');
  if (largestStep > 0.1 + 1e-3) fail(`u_globalTime jumped by ${largestStep} outside the wrap`);
  for (const name of ['u_phase', 'u_energyTime', 'u_panTime', 'u_time']) {
    if (!(Math.abs(last[name]) < CLOCK_WRAP_SECONDS)) fail(`${name} = ${last[name]} is past one period`);
  }
  if (!(last.u_bandTime.every((v) => Math.abs(v) < CLOCK_WRAP_SECONDS))) fail('a band clock is past one period');
  if (!(last.u_energyTime > 0 && last.u_panTime < 0)) fail('the signed integrals lost their sign');
  overlay.dispose();
  log.push(`after ${(real / 3600).toFixed(1)} h every clock sits under one period; u_globalTime wrapped once at step ${wrapAt}`);
}

console.log(log.join('\n'));
console.log(pass ? '[eviland-scene-overlay-test] PASS' : '[eviland-scene-overlay-test] FAIL');
process.exitCode = pass ? 0 : 1;
