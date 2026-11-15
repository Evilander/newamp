// Scored tracks in the scene overlay: the drop cut and flash come from the
// conductor's impactStart (not the overlay's own energy guess), a scene's mood
// follows the section tier, the scene a build will cut to is compiled while the
// build climbs, and a plain boundary is crossfaded so the fade's midpoint lands
// on the bar line. Unscored frames keep the live detector. Runs the real overlay
// against a stand-in GL context that records uniform uploads.
// Run: node scripts/eviland-scored-scenes-test.mjs
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
const { createSceneOverlay } = await load('src/visualizer/scene-overlay.ts', 'eviland-v2-scored-overlay-bundle');
const { SCENES } = await load('src/visualizer/scenes/index.ts', 'eviland-v2-scored-scenes-bundle');

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

function fakeGl() {
  const state = { last: {}, draws: [], flashes: [], linked: [], bound: null };
  const impl = {
    getExtension: () => null,
    createVertexArray: () => ({}),
    createShader: () => ({}),
    createProgram: () => ({ shaders: [] }),
    shaderSource: (shader, text) => { shader.text = text; },
    attachShader: (program, shader) => program.shaders.push(shader),
    linkProgram: (program) => { state.linked.push(program.shaders.map((s) => s.text).join('\n')); },
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getUniformLocation: (_program, name) => ({ name }),
    useProgram: (program) => { state.bound = program; },
    uniform1f: (loc, v) => { state.last[loc.name] = v; },
    uniform1fv: (loc, v) => { state.last[loc.name] = Array.from(v); },
    uniform4f: (loc, ...v) => { state.last[loc.name] = v; },
    drawArrays: () => {
      const text = (state.bound?.shaders ?? []).map((s) => s.text).join('\n');
      const def = SCENES.find((s) => text.includes(s.frag));
      if (def) state.draws.push({ id: def.id, fade: state.last.u_fade });
      else state.flashes.push(state.last.u_color);
    },
  };
  const gl = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in impl) return impl[prop];
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1;
      return () => ({});
    },
  });
  return { gl, state };
}

const PALETTE = { accent: [0.5, 0.5, 1], light: [0.9, 0.9, 1], dark: [0.1, 0.1, 0.3], bg: [0, 0, 0.02] };
const DT = 33;
function frame(over = {}, score) {
  return {
    bands: new Float32Array(24).fill(0.3), onsets: [],
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.2, centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.4, pan: 0,
    beatPhase: 0, beatConfidence: 0.8, bpm: 120, novelty: 0,
    sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
    ...over,
    ...(score ? { score: { anticipation: 0, blackout: 0, impact: 0, impactStart: false, tier: 'steady', keyShift: 0, arc: 0.3, downbeat: false, toBoundary: Infinity, ...score } } : {}),
  };
}
function make(seed = 'scored-test') {
  const { gl, state } = fakeGl();
  const overlay = createSceneOverlay({ width: 64, height: 64 }, { gl, syncCompile: true, seedKey: seed, quality: 'low' });
  return { overlay, state };
}
/** Run `ms` of frames; `make(i)` builds each. */
function run(overlay, ms, build) {
  const n = Math.round(ms / DT);
  for (let i = 0; i < n; i++) overlay.render(build(i), PALETTE, DT);
}
/** The draw that carries the incoming scene on the last frame: highest id of the two drawn. */
function lastFrameDraws(state, since) {
  return state.draws.slice(since);
}
const mood = (id) => SCENES.find((s) => s.id === id)?.mood;

// --- a scored drop cuts on impactStart, and flashes -----------------------
{
  const { overlay, state } = make();
  run(overlay, 8000, () => frame({}, {}));
  const before = overlay.currentSceneId();
  state.draws.length = 0; state.flashes.length = 0;
  overlay.render(frame({ sectionId: 1 }, { impactStart: true, impact: 1, tier: 'drop', toBoundary: 20 }), PALETTE, DT);
  const after = overlay.currentSceneId();
  if (after === before) fail('a scored impactStart did not change the scene on its frame');
  const incoming = state.draws.find((d) => d.id === after);
  if (!incoming || incoming.fade !== 0) fail(`the incoming scene did not start at zero on the cut (fade ${incoming?.fade})`);
  if (!state.flashes.length || Math.abs(state.flashes[state.flashes.length - 1][3] - 0.42) > 1e-6) fail(`the drop flash was not full strength: ${JSON.stringify(state.flashes)}`);
  // 240 ms fade: about halfway after 120 ms.
  state.draws.length = 0;
  run(overlay, 99, () => frame({ sectionId: 1 }, { toBoundary: 19.9, tier: 'drop' }));
  const mid = state.draws.filter((d) => d.id === after).pop();
  if (!mid || mid.fade < 0.35 || mid.fade > 0.65) fail(`the cut did not use the 240 ms drop fade (fade ${mid?.fade} after ~130 ms)`);
  run(overlay, 400, () => frame({ sectionId: 1 }, { toBoundary: 19, tier: 'drop' }));
  state.draws.length = 0;
  run(overlay, 100, () => frame({ sectionId: 1 }, { toBoundary: 18, tier: 'drop' }));
  if (state.draws.some((d) => d.id !== after)) fail('the outgoing scene was still drawing after the drop fade');
  log.push(`scored drop: ${before} -> ${after} on the impactStart frame, flash 0.42, fade 240 ms`);
  overlay.dispose();
}

// --- no switch without impactStart ----------------------------------------
{
  const jump = (build) => {
    const { overlay } = make();
    run(overlay, 8000, () => frame({}, build({})));
    const before = overlay.currentSceneId();
    overlay.render(frame({ sectionId: 1, energy: 0.95 }, build({ toBoundary: 20 })), PALETTE, DT);
    return { before, after: overlay.currentSceneId() };
  };
  const noStart = jump((o) => ({ ...o, impactStart: false }));
  if (noStart.before !== noStart.after) fail('an energy jump with a section change but no impactStart cut the scene on a scored track');
  const weak = jump((o) => ({ ...o, impactStart: true, impact: 0.2 }));
  if (weak.before !== weak.after) fail('an impact weaker than the conductor limit cut the scene');
  // Unscored: the old energy rule still cuts.
  const { overlay, state } = make();
  run(overlay, 8000, () => frame({}));
  const before = overlay.currentSceneId();
  state.flashes.length = 0;
  overlay.render(frame({ sectionId: 1, energy: 0.95 }), PALETTE, DT);
  if (overlay.currentSceneId() === before) fail('an unscored energy jump on a section change no longer cuts');
  if (!state.flashes.length || Math.abs(state.flashes[state.flashes.length - 1][3] - 0.42) > 1e-6) fail('an unscored drop did not flash at full strength');
  overlay.dispose();
  log.push('scored: energy jump or weak impact alone = no cut; unscored: the energy rule still cuts and flashes');
}

// --- mood follows the tier --------------------------------------------------
{
  const pick = (tier, seed) => {
    const { overlay } = make(seed);
    run(overlay, 25000, () => frame({}, { tier }));
    overlay.render(frame({ sectionId: 1 }, { tier, toBoundary: 20 }), PALETTE, DT);
    return overlay.currentSceneId();
  };
  let calmOk = 0, highOk = 0, n = 0;
  for (let k = 0; k < 24; k++) {
    const seed = `tier-${k}`;
    const calm = pick('calm', seed);
    const high = pick('climax', seed);
    n++;
    if (mood(calm) === 'calm' || mood(calm) === 'any') calmOk++;
    if (mood(high) === 'high' || mood(high) === 'any') highOk++;
  }
  // 75% of picks are mood-matched, the rest a seeded wildcard.
  if (calmOk < n * 0.6) fail(`calm sections picked a calm or any scene only ${calmOk}/${n} times`);
  if (highOk < n * 0.6) fail(`climax sections picked a high or any scene only ${highOk}/${n} times`);
  log.push(`mood follows the tier: calm ${calmOk}/${n}, climax ${highOk}/${n} mood-matched`);
}

// --- the drop's scene is compiled while the build climbs --------------------
{
  const { overlay, state } = make('queue-test');
  run(overlay, 8000, () => frame({}, {}));
  const linkedBefore = state.linked.length;
  run(overlay, 1000, (i) => frame({}, { anticipation: 0.05 + i * 0.01, toBoundary: 3 - i * 0.033 }));
  const queued = state.linked.slice(linkedBefore);
  if (queued.length < 1) fail('no scene was compiled ahead of the drop');
  overlay.render(frame({ sectionId: 1 }, { impactStart: true, impact: 0.9, tier: 'drop', toBoundary: 20 }), PALETTE, DT);
  const cut = SCENES.find((s) => s.id === overlay.currentSceneId());
  if (!queued.some((text) => text.includes(cut.frag))) fail('the drop did not cut to the scene compiled during the build');
  log.push(`build ahead: ${queued.length} scene compiled before the drop, and the drop cut to it (${cut.id})`);
  overlay.dispose();
}

// --- a plain boundary is crossfaded across the bar line --------------------
{
  const { overlay, state } = make('boundary-test');
  run(overlay, 25000, () => frame({}, {}));
  const before = overlay.currentSceneId();
  state.draws.length = 0;
  let switchedAt = -1;
  let fadeAtBoundary = null;
  const steps = 30;
  let switches = 0;
  let last = before;
  for (let i = 0; i <= steps; i++) {
    const toBoundary = Math.max(0, 0.7 - i * 0.025);
    const atBoundary = i === steps;
    overlay.render(frame({ sectionId: atBoundary ? 1 : 0 }, { toBoundary: atBoundary ? 8 : toBoundary }), PALETTE, 25);
    const now = overlay.currentSceneId();
    if (now !== last) { switches++; if (switchedAt < 0) switchedAt = i; last = now; }
    if (atBoundary) fadeAtBoundary = state.draws.filter((d) => d.id === now).pop()?.fade;
  }
  if (switchedAt < 0 || switchedAt > 2) fail(`the crossfade did not start as the boundary came within 0.7 s (switched at step ${switchedAt})`);
  if (switches !== 1) fail(`the boundary changed the scene ${switches} times (once ahead of it, none at it)`);
  if (fadeAtBoundary === null || fadeAtBoundary < 0.35 || fadeAtBoundary > 0.65) fail(`the incoming scene is at ${fadeAtBoundary} on the bar line, not about halfway`);
  log.push(`boundary crossfade: started ${(steps - switchedAt) * 25} ms ahead, incoming scene at ${fadeAtBoundary?.toFixed(2)} on the bar line, one switch`);
  overlay.dispose();
}

// --- suppressFlash ------------------------------------------------------------
{
  const { overlay, state } = make('suppress-test');
  run(overlay, 8000, () => frame({}, {}));
  state.flashes.length = 0;
  overlay.render(frame({ sectionId: 1 }, { impactStart: true, impact: 1, tier: 'drop', toBoundary: 20 }), PALETTE, DT, { framebuffer: null, width: 64, height: 64, suppressFlash: true });
  for (let i = 0; i < 6; i++) overlay.render(frame({ sectionId: 1 }, { toBoundary: 19 }), PALETTE, DT, { framebuffer: null, width: 64, height: 64, suppressFlash: true });
  if (state.flashes.length) fail('the overlay flashed while the host asked it not to');
  log.push('suppressFlash: no overlay flash while the host stages the drop');
  overlay.dispose();
}

console.log(log.join('\n'));
console.log(pass ? '[eviland-scored-scenes-test] PASS' : '[eviland-scored-scenes-test] FAIL');
process.exit(pass ? 0 : 1);
