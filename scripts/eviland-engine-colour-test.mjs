// Unit test for the engine half of the Eviland colour-and-space pass: the
// second accent through palette fades, per-band stereo pan, the stereoSpread
// channel, fluid forces that keep the drop's impact and follow each band's
// pan, the governor's lateness signal, the tint helpers, and a CPU model of
// the POST dither. No GPU. Run: node scripts/eviland-engine-colour-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = resolve('tmp/v3-engine');
mkdirSync(outDir, { recursive: true });
const bundle = async (name, entry) => {
  await build({
    entryPoints: [resolve(entry)], bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve(outDir, `${name}.mjs`), logLevel: 'silent',
  });
  return import(pathToFileURL(resolve(outDir, `${name}.mjs`)).href);
};
const { createEvilandReactor, EVILAND_BANDS, bandPanOf } = await bundle('audio', 'src/visualizer/eviland-audio.ts');
const ops = await bundle('operators', 'src/visualizer/eviland-operators.ts');
const { accentPair } = await bundle('appearance', 'src/visualizer/eviland-appearance.ts');
const { createFluidForceSource, MAX_FLUID_FORCES } = await bundle('fluid', 'src/visualizer/eviland-fluid.ts');
const { createGovernor } = await bundle('governor', 'src/visualizer/eviland-governor.ts');

const log = [];
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// -- Per-band stereo pan ------------------------------------------------------
{
  const SR = 48000;
  const BINS = 1024;
  const binHz = SR / 2048;
  const byteAt = (db) => Math.round(((db + 86) / 76) * 255);
  // Band edges as the reactor computes them: 24 mel bands from 20 Hz to 16 kHz.
  const mel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const edge = (i) => Math.max(1, Math.floor(hz(mel(20) + ((mel(16000) - mel(20)) * i) / 24) / binHz));
  const fill = (arr, band, value) => {
    for (let k = edge(band); k < Math.max(edge(band) + 1, edge(band + 1)); k++) arr[k] = value;
  };

  const settle = (left, right, mono = false) => {
    const reactor = createEvilandReactor({ sampleRate: SR, fftSize: 2048, binCount: BINS });
    const rightFreq = mono ? left : right;
    let frame;
    for (let i = 0; i < 120; i++) frame = reactor.analyze(left, left, left, rightFreq, 16.7, i * 16.7);
    return { bandPan: Array.from(frame.bandPan), pan: frame.pan, frame };
  };

  const left = new Uint8Array(BINS);
  const right = new Uint8Array(BINS);
  // Energy only in the top bands on the left, only in the bottom bands on the
  // right. The top bands span far more bins, so the bottom ones are added until
  // the two channels carry the same total and the scalar pan has nothing to lean on.
  let leftTotal = 0;
  for (let b = 21; b < EVILAND_BANDS; b++) { fill(left, b, byteAt(-25)); }
  for (let k = 0; k < BINS; k++) leftTotal += left[k];
  let rightTotal = 0;
  for (let b = 0; rightTotal < leftTotal && b < 20; b++) {
    fill(right, b, byteAt(-25));
    rightTotal = right.reduce((sum, v) => sum + v, 0);
  }
  const stereo = settle(left, right);
  log.push(`bandPan: top band ${stereo.bandPan[23].toFixed(2)}, bottom band ${stereo.bandPan[0].toFixed(2)}, scalar pan ${stereo.pan.toFixed(2)}`);
  assert.ok(stereo.bandPan[23] <= -0.8, `a left-only top band must pan hard left, got ${stereo.bandPan[23]}`);
  assert.ok(stereo.bandPan[0] >= 0.8, `a right-only bottom band must pan hard right, got ${stereo.bandPan[0]}`);
  assert.ok(Math.abs(bandPanOf(stereo.frame, 23) - stereo.bandPan[23]) < 1e-6, 'bandPanOf reads the band');
  // A band with nothing in it has no position.
  assert.ok(Math.abs(stereo.bandPan[20]) < 0.05, `an empty band (20) stays at the centre, got ${stereo.bandPan[20]}`);
  // Opposite sides with similar energy: the single scalar pan cannot tell them apart.
  assert.ok(Math.abs(stereo.pan) < 0.5, `scalar pan averages the two sides, got ${stereo.pan}`);

  // A mono source: one channel silent -> no stereo information anywhere.
  const mono = settle(left, new Uint8Array(BINS));
  assert.ok(mono.bandPan.every((v) => v === 0), `a mono source has no band pan, got ${mono.bandPan.join(',')}`);

  // Relaxes to the centre when the band goes quiet, and a frame without bandPan falls back to pan.
  assert.equal(bandPanOf({ pan: 0.4 }, 5), 0.4);
  assert.equal(bandPanOf({ pan: 0.4, bandPan: new Float32Array(24).fill(-0.2) }, 5), Math.fround(-0.2));
  const reactor = createEvilandReactor({ sampleRate: SR, fftSize: 2048, binCount: BINS });
  const silent = new Uint8Array(BINS);
  let frame;
  for (let i = 0; i < 60; i++) frame = reactor.analyze(left, left, left, right, 16.7, i * 16.7);
  const loud = frame.bandPan[23];
  for (let i = 60; i < 300; i++) frame = reactor.analyze(silent, silent, silent, silent, 16.7, i * 16.7);
  log.push(`bandPan relaxes: ${loud.toFixed(2)} -> ${frame.bandPan[23].toFixed(2)} after 4 s of silence`);
  assert.ok(Math.abs(frame.bandPan[23]) < 0.02, 'pan relaxes toward the centre in silence');
}

// -- Onset refractory clock survives long uptime -----------------------------
{
  const SR = 48000;
  const BINS = 1024;
  const reactor = createEvilandReactor({ sampleRate: SR, fftSize: 2048, binCount: BINS });
  const quiet = new Uint8Array(BINS);
  const hit = new Uint8Array(BINS).fill(200);
  // 12 days of uptime: a float32 millisecond clock rounds to 128 ms there.
  const base = 12 * 24 * 3600 * 1000 + 1;
  let t = base;
  const step = (bytes) => { t += 16.7; return reactor.analyze(bytes, bytes, bytes, bytes, 16.7, t); };
  for (let i = 0; i < 30; i++) step(quiet);
  let onsets = 0;
  for (let i = 0; i < 6; i++) { onsets += step(hit).onsets.length; for (let j = 0; j < 8; j++) step(quiet); }
  const stamped = step(quiet);
  assert.ok(stamped.onsets.length === 0);
  assert.ok(onsets > 0, 'onsets still fire after 12 days of uptime');
}

// -- Tempo smoothing is per second, not per frame -----------------------------
{
  const SR = 48000;
  const BINS = 1024;
  const run = (dt) => {
    const reactor = createEvilandReactor({ sampleRate: SR, fftSize: 2048, binCount: BINS });
    const silent = new Uint8Array(BINS);
    const kick = new Uint8Array(BINS);
    for (let k = 1; k < 12; k++) kick[k] = 230;
    let t = 0;
    let frame;
    // 120 BPM kicks for 6 s.
    for (let ms = 0; ms < 6000; ms += dt) {
      t += dt;
      const onBeat = Math.abs((t % 500)) < dt;
      frame = reactor.analyze(onBeat ? kick : silent, onBeat ? kick : silent, onBeat ? kick : silent, onBeat ? kick : silent, dt, t);
    }
    return frame.bpm;
  };
  const a = run(1000 / 60);
  const b = run(1000 / 30);
  log.push(`bpm after 6 s of 120 BPM kicks: ${a.toFixed(1)} at 60 Hz, ${b.toFixed(1)} at 30 Hz`);
  assert.ok(Math.abs(a - b) < 6, `tempo lock must not depend on the frame rate (${a} vs ${b})`);
}

// -- Second accent through palette fades -------------------------------------
{
  const base = ops.defaultConfig();
  const pal = (accent, accent2) => ({
    bg: [0.02, 0.02, 0.03], dark: [0.1, 0.05, 0.2], accent, light: [0.9, 0.9, 1], ...(accent2 ? { accent2 } : {}),
  });
  const a = { ...ops.cloneConfig(base), palette: pal([0.9, 0.2, 0.2], [0.2, 0.3, 0.9]) };
  const b = { ...ops.cloneConfig(base), palette: pal([0.2, 0.8, 0.3], [0.9, 0.7, 0.1]) };
  const lone = { ...ops.cloneConfig(base), palette: pal([0.2, 0.8, 0.3]) };

  // Endpoints come back exactly, and the midpoint is its own colour, not either side's.
  assert.deepEqual(ops.lerpConfig(a, b, 0).palette.accent2, a.palette.accent2);
  assert.deepEqual(ops.lerpConfig(a, b, 1).palette.accent2, b.palette.accent2);
  const mid = ops.lerpConfig(a, b, 0.5).palette.accent2;
  assert.ok(mid.some((v, i) => !close(v, a.palette.accent2[i], 0.05)) && mid.some((v, i) => !close(v, b.palette.accent2[i], 0.05)), 'the midpoint is a blend');

  // A side without a second accent stands in with its analogous partner
  // (accentPair, decided by the look's seed), so an old look fades from and
  // into the colour the renderer would show for it.
  const partner = (config) => [...accentPair(config.palette, config.seed)];
  const loneStart = ops.lerpConfig(lone, a, 0).palette.accent2;
  assert.deepEqual(loneStart, partner(lone), 'a one-accent look starts its fade on its own partner');
  assert.notDeepEqual(loneStart, lone.palette.accent, 'the partner is a second hue, not a copy of the first accent');
  const from = ops.lerpConfig(lone, a, 1).palette.accent2;
  assert.deepEqual(from, a.palette.accent2);
  const grow = ops.lerpConfig(lone, a, 0.5).palette.accent2;
  assert.ok(Array.isArray(grow) && grow.every(Number.isFinite), 'a one-accent look fades into a two-accent look');
  assert.ok(grow.some((v, i) => !close(v, partner(lone)[i], 0.05)) && grow.some((v, i) => !close(v, a.palette.accent2[i], 0.05)), 'the midpoint of that fade is a blend of the partner and the second accent');

  // Two old looks fade through their partners: each end matches its own side's
  // accentPair, so neither end has a snap to find. Neither side leaves no
  // second accent behind.
  const other = { ...ops.cloneConfig(base), seed: 'another-old-look', palette: pal([0.9, 0.3, 0.2]) };
  const bothOld = (t) => ops.lerpConfig(lone, other, t).palette;
  assert.ok(bothOld(0.5).accent2, 'a fade between two one-accent looks has a second accent');
  assert.deepEqual(bothOld(0).accent2, partner(lone), 'the fade starts on the first look\'s partner');
  assert.deepEqual(bothOld(1).accent2, partner(other), 'the fade ends on the second look\'s partner');
  assert.notDeepEqual(partner(lone), partner(other), 'the two looks have different partners to fade between');
  const midOld = bothOld(0.5).accent2;
  assert.ok(midOld.every(Number.isFinite) && midOld.some((v, i) => !close(v, partner(lone)[i], 0.02)) && midOld.some((v, i) => !close(v, partner(other)[i], 0.02)), 'the midpoint is a blend of the two partners');
  const same = ops.lerpConfig(lone, { ...lone }, 0.5).palette.accent2;
  assert.ok(same.every((v, i) => close(v, partner(lone)[i], 1e-3)), 'a fade between a look and itself stays on its partner');

  // The in-place variant matches, reuses its arrays and clears a stale second accent.
  const scratch = ops.cloneConfig(a);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    ops.lerpConfigInto(scratch, a, b, t);
    const ref = ops.lerpConfig(a, b, t).palette;
    for (const key of ['bg', 'dark', 'accent', 'light', 'accent2']) {
      scratch.palette[key].forEach((v, i) => assert.ok(close(v, ref[key][i], 1e-9), `${key} at t=${t}`));
    }
  }
  const slot = scratch.palette.accent2;
  ops.lerpConfigInto(scratch, a, b, 0.3);
  assert.equal(scratch.palette.accent2, slot, 'the second accent reuses its array');
  // Neither side has a second accent: the stale one is replaced by the sides'
  // partner, the same colour lerpConfig gives, not left behind or dropped.
  ops.lerpConfigInto(scratch, lone, other, 0.3);
  const refOld = ops.lerpConfig(lone, other, 0.3).palette.accent2;
  assert.ok(scratch.palette.accent2.every((v, i) => close(v, refOld[i], 1e-9)), 'a stale second accent gives way to the derived partner when neither side has one');
  assert.equal(scratch.palette.accent2, slot, 'and the second accent still reuses its array');
  ops.lerpConfigInto(scratch, lone, other, 0);
  assert.ok(scratch.palette.accent2.every((v, i) => close(v, partner(lone)[i], 1e-9)), 'the in-place fade starts on the first look\'s partner');
  ops.lerpConfigInto(scratch, lone, other, 1);
  assert.ok(scratch.palette.accent2.every((v, i) => close(v, partner(other)[i], 1e-9)), 'and ends on the second look\'s partner');
  ops.lerpConfigInto(scratch, a, a, 0.2);
  assert.ok(scratch.palette.accent2, 'and a two-accent look keeps its own');
}

// -- stereoSpread -------------------------------------------------------------
{
  const dyn = ops.createDynamics();
  const frame = { kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0, energy: 0.5, centroid: 0.5, flatness: 0.5, crest: 0.5, rolloff: 0.5, width: 0.5, pan: 0, novelty: 0, beatPhase: 0, beatConfidence: 0 };
  const config = ops.defaultConfig();
  ops.evalConfig(config, frame, 0, dyn, 16.7);
  assert.equal(dyn.stereoSpread, 1, 'a look without the channel places the image as mixed');
  assert.equal(ops.createDynamics().stereoSpread, 1);
  config.stereoSpread = { base: 0 };
  ops.evalConfig(config, frame, 0, dyn, 16.7);
  assert.equal(dyn.stereoSpread, 0);
  config.stereoSpread = { base: 9 };
  ops.evalConfig(config, frame, 0, dyn, 16.7);
  assert.equal(dyn.stereoSpread, 1.5, 'clamped');
  const a = ops.defaultConfig();
  const b = { ...ops.defaultConfig(), stereoSpread: { base: 0 } };
  assert.ok(close(ops.lerpConfig(a, b, 0.5).stereoSpread.base, 0.5), 'fades from the neutral 1 to 0');
  const into = ops.defaultConfig();
  ops.lerpConfigInto(into, a, b, 0.25);
  assert.ok(close(into.stereoSpread.base, 0.75));
  ops.lerpConfigInto(into, a, a, 0.25);
  assert.equal(into.stereoSpread, undefined, 'absent on both sides clears');
}

// -- OKLCh tint helpers -------------------------------------------------------
{
  const blue = [0.15, 0.3, 0.95];
  const turned = [0, 0, 0];
  ops.turnColorInto(turned, blue, 40);
  const back = [0, 0, 0];
  ops.turnColorInto(back, turned, -40);
  blue.forEach((v, i) => assert.ok(close(v, back[i], 0.03), 'turning and turning back returns the colour'));
  // +-40 degrees round a blue keeps blue dominant (the diversity gate's own assertion).
  for (const deg of [-40, -20, 20, 40]) {
    const out = [0, 0, 0];
    ops.turnColorInto(out, blue, deg);
    assert.ok(out[2] > out[0] && out[2] > out[1] * 0.9, `blue stays blue at ${deg} degrees: ${out.map((v) => v.toFixed(2))}`);
  }
  // A shade keeps the hue: the channel ratios of a dark colour do not slide toward red.
  const dark = [0.05, 0.08, 0.2];
  const up = [0, 0, 0];
  const down = [0, 0, 0];
  ops.shadeColorInto(up, dark, 0.08);
  ops.shadeColorInto(down, dark, -0.08);
  assert.ok(up[2] > dark[2] && down[2] < dark[2], 'lighter and darker');
  assert.ok(up[2] > up[0] && down[2] > down[0], 'both stay blue-dominant');
  const inPlace = [...dark];
  ops.shadeColorInto(inPlace, inPlace, 0.08);
  inPlace.forEach((v, i) => assert.ok(close(v, up[i], 1e-9)), 'in place');
  log.push(`shade of ${dark}: +0.08 -> ${up.map((v) => v.toFixed(3))}, -0.08 -> ${down.map((v) => v.toFixed(3))}`);
}

// -- Fluid forces ------------------------------------------------------------
{
  const frame = (over = {}) => ({
    bands: new Float32Array(24), onsets: [], kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0, energy: 0.6, centroid: 0.5,
    flatness: 0.9, noisiness: 0.5, crest: 0.3, rolloff: 0.5, width: 0.4, pan: 0, bpm: 0, beatPhase: 0, beatConfidence: 0,
    novelty: 0, sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null, ...over,
  });
  const onsets = (...list) => list.map(([band, group]) => ({ band, group, intensity: 1, sharpness: 1 }));
  const snapshot = (forces) => forces.map((f) => ({ x: f.x, y: f.y, dx: f.dx, dy: f.dy, dye: f.dye ?? 0, color: f.color ? [...f.color] : undefined }));

  // The drop's impact survives the busiest frame there is.
  const busy = frame({
    pan: 0.5, bass: 1, kick: 1, bpm: 128, beatConfidence: 0.9, beatPhase: 0.9,
    onsets: onsets([0, 'kick'], [1, 'kick'], [2, 'kick'], [6, 'snare'], [7, 'snare'], [8, 'snare'], [9, 'snare'],
      [19, 'hat'], [20, 'hat'], [21, 'hat'], [22, 'hat'], [23, 'hat'], [10, 'vocal'], [12, 'vocal'], [14, 'vocal'], [4, 'bass'], [16, 'other']),
    score: { anticipation: 1, blackout: 0, impact: 1, impactStart: true, tier: 'drop', keyShift: 0, arc: 0.5, downbeat: true, toBoundary: 8 },
  });
  const forces = snapshot(createFluidForceSource().forces(busy));
  assert.ok(forces.length <= MAX_FLUID_FORCES);
  // Ten outward jets of the impact ring carry dye 1.2 and unit-length velocity at 1.1 strength.
  const impact = forces.filter((f) => f.dye > 1 && Math.hypot(f.dx, f.dy) > 1);
  assert.equal(impact.length, 10, `all ten impact spokes survive a full pool, got ${impact.length}`);
  const pull = forces.filter((f) => !f.color && Math.hypot(f.dx, f.dy) > 0 && f.y !== 0.15);
  assert.ok(pull.length >= 6, 'and the build pull');
  // Only one shockwave however many kick bands fire.
  const kickDye = forces.filter((f) => f.dye > 0.3 && f.dye < 1 && f.y >= 0.25 && f.y <= 0.35);
  assert.ok(kickDye.length <= 7 + 1, `one kick shockwave per frame, got ${kickDye.length} kick-height splats`);
  log.push(`busy drop frame: ${forces.length}/${MAX_FLUID_FORCES} forces, ${impact.length} impact spokes, ${pull.length} pull`);

  // No allocation in steady state: the pool's colour tuples are reused across velocity-only and dyed uses.
  const src = createFluidForceSource();
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const out = src.forces(i % 2 ? busy : frame({ bpm: 120, beatConfidence: 0.9, beatPhase: 0.92 }));
    for (const f of out) if (f.color) seen.add(f.color);
  }
  assert.ok(seen.size <= MAX_FLUID_FORCES, `the colour tuples are the pool's own (${seen.size} distinct)`);

  // A hat panned hard right throws its splats to the right half; at pan 0 they straddle the centre.
  const hatAt = (bandPan, spread) => {
    const bp = new Float32Array(24);
    bp[21] = bandPan;
    return snapshot(createFluidForceSource().forces(frame({ onsets: onsets([21, 'hat']), bandPan: bp }), undefined, 1 / 60, spread))
      .filter((f) => f.y > 0.8);
  };
  const right = hatAt(1, 1);
  const centred = hatAt(0, 1);
  const flat = hatAt(1, 0);
  const meanX = (list) => list.reduce((s, f) => s + f.x, 0) / list.length;
  log.push(`hat splat mean x: pan +1 ${meanX(right).toFixed(2)}, pan 0 ${meanX(centred).toFixed(2)}, spread 0 ${meanX(flat).toFixed(2)}`);
  assert.ok(meanX(right) > 0.7, 'a right-panned hat lands right');
  assert.ok(close(meanX(centred), 0.5, 0.01), 'centred');
  assert.ok(close(meanX(flat), 0.5, 0.01), 'stereoSpread 0 flattens the image');

  // The kick anchors where its own band sits, whatever the whole mix does.
  const kickAt = (bp) => {
    const arr = new Float32Array(24);
    arr[1] = bp;
    return snapshot(createFluidForceSource().forces(frame({ pan: -0.9, onsets: onsets([1, 'kick']), bandPan: arr }), undefined, 1 / 60, 1))
      .find((f) => f.dye > 0 && f.dx === 0 && f.dy === 0).x;
  };
  assert.ok(kickAt(0.8) > 0.6 && close(kickAt(0), 0.5, 1e-6), 'a right-panned kick anchors right even in a left-heavy mix');

  // With a second accent the dye ramp runs dark -> accent -> accent2 -> light; without one it is the old ramp.
  const palette = (accent2) => ({ bg: [0, 0, 0], dark: [0, 0, 0.2], accent: [1, 0, 0], light: [1, 1, 1], ...(accent2 ? { accent2 } : {}) });
  const rampAt = (pal, y) => {
    const src2 = createFluidForceSource();
    const out = src2.forces(frame({ onsets: onsets([12, 'vocal']) }), pal);
    const f = out.find((o) => o.color);
    return { y: f.y, color: [...f.color] };
  };
  const withTwo = rampAt(palette([0, 1, 0]));
  const withOne = rampAt(palette(undefined));
  assert.ok(withTwo.y > 0.4 && withTwo.y < 0.6);
  assert.ok(withTwo.color[1] > withTwo.color[0] * 0.3, 'the middle of the ramp leans to the second accent');
  assert.notDeepEqual(withTwo.color, withOne.color);
}

// -- Governor lateness --------------------------------------------------------
{
  // A GPU-bound loop: the CPU spends 2 ms issuing calls but frames arrive 55 ms apart when 33.3 were asked for.
  const gpuBound = createGovernor({ costBudgetMs: 8 });
  let t = 0;
  for (let i = 0; i < 400; i++) {
    gpuBound.intervalMs(33.3);
    t += 55;
    gpuBound.endFrame(t, 2);
  }
  const snap = gpuBound.snapshot();
  log.push(`governor, GPU-bound: level ${snap.level}, lateness ${snap.lateness.toFixed(2)}`);
  assert.ok(snap.level > 0, 'a loop that keeps falling behind steps down even when the CPU cost looks fine');

  // Frames on time at a low cost never step.
  const fine = createGovernor({ costBudgetMs: 8 });
  t = 0;
  for (let i = 0; i < 600; i++) {
    fine.intervalMs(33.3);
    t += 33.4;
    fine.endFrame(t, 2);
  }
  assert.equal(fine.snapshot().level, 0);

  // An idle visualizer waking up: one long gap among on-time frames decides nothing.
  const wake = createGovernor({ costBudgetMs: 8 });
  t = 0;
  for (let i = 0; i < 300; i++) {
    wake.intervalMs(33.3);
    t += i % 100 === 99 ? 400 : 33.4;
    wake.endFrame(t, 2);
  }
  assert.equal(wake.snapshot().level, 0, 'an occasional long idle gap is not lateness');

  // A callback that never reads intervalMs gets the cost-only behaviour it always had.
  const legacy = createGovernor({ costBudgetMs: 8 });
  t = 0;
  for (let i = 0; i < 400; i++) { t += 55; legacy.endFrame(t, 2); }
  assert.equal(legacy.snapshot().level, 0);

  // A step taken only because of lateness is not undone for a minute.
  const hold = createGovernor({ costBudgetMs: 8 });
  t = 0;
  let stepped = -1;
  for (let i = 0; i < 2000; i++) {
    const level = hold.snapshot().level;
    hold.intervalMs(33.3);
    t += level > 0 ? 33.4 : 55;
    hold.endFrame(t, 2);
    if (stepped < 0 && hold.snapshot().level > 0) stepped = t;
    if (stepped > 0 && t - stepped < 55_000) assert.ok(hold.snapshot().level > 0, 'holds the step for a minute');
  }
  assert.ok(stepped > 0);
}

// -- Source pins --------------------------------------------------------------
{
  const engine = readFileSync(resolve('src/visualizer/eviland.ts'), 'utf8');
  const spectrum = engine.slice(engine.indexOf('const SPECTRUM_FRAG'), engine.indexOf('const WAVE_FRAG'));
  assert.match(spectrum, /uniform float u_bandPan\[24\]/, 'the spectrum shader takes the band pans');
  assert.match(spectrum, /uniform float u_spread/);
  assert.doesNotMatch(engine, /getExtension\('OES_texture_float_linear'\)/, 'half-float filtering is core WebGL2');
  assert.doesNotMatch(engine, /Math\.max\(0\.2, [rgb]\)/, 'the sun has no per-channel floor');
}

// -- POST dither: a CPU model of the shader's interleaved gradient noise ------
{
  const ign = (x, y, frame) => {
    const t = (frame % 1024) * 0.618034;
    const fract = (v) => v - Math.floor(v);
    return fract(52.9829189 * fract(0.06711056 * x + 0.00583715 * y + t));
  };
  // One IGN sample through the triangular inverse CDF. (Two samples at an
  // offset are the same sequence shifted, so their sum is not triangular.)
  const grain = (x, y, frame) => {
    const u = ign(x, y, frame);
    return u < 0.5 ? Math.sqrt(2 * u) - 1 : 1 - Math.sqrt(2 - 2 * u);
  };
  // The long end of a trail across a 1920-wide frame: a slow gradient rising
  // 20 levels of 255, quantised to 8 bits. What the eye sees as a contour is
  // the error of the local average, so the metric is the RMS of 8x8 block means
  // of (quantised - true): about 0.29 of a level for a plain quantiser, whose
  // error is a sawtooth that no averaging removes, and far less for a dither.
  const W = 1920;
  const H = 64;
  const level = (x) => 4 + (x / W) * 20;
  let seed = 12345;
  const white = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const noise = {
    none: () => 0,
    hash: () => white() + white() - 1,
    ign: (x, y, frame) => grain(x, y, frame),
  };
  const blockError = (kind, frame) => {
    let sum = 0;
    let blocks = 0;
    for (let by = 0; by < H; by += 8) {
      for (let bx = 0; bx < W; bx += 8) {
        let err = 0;
        for (let y = by; y < by + 8; y++) {
          for (let x = bx; x < bx + 8; x++) {
            const exact = level(x);
            err += Math.round(exact + noise[kind](x + 0.5, y + 0.5, frame)) - exact;
          }
        }
        sum += (err / 64) ** 2;
        blocks += 1;
      }
    }
    return Math.sqrt(sum / blocks);
  };
  const rms = { none: 0, hash: 0, ign: 0 };
  const frames = [0, 7, 31, 100];
  for (const kind of Object.keys(rms)) rms[kind] = Math.sqrt(frames.reduce((s2, f) => s2 + blockError(kind, f) ** 2, 0) / frames.length);
  let mean = 0;
  let square = 0;
  let count = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let frame = 0; frame < 30; frame++) for (let x = 0; x < 256; x++) for (let y = 0; y < 64; y++) {
    const g = grain(x + 0.5, y + 0.5, frame);
    mean += g; square += g * g; count += 1; lo = Math.min(lo, g); hi = Math.max(hi, g);
  }
  mean /= count;
  const variance = square / count - mean * mean;
  log.push(`dither model, RMS error of 8x8 block means (levels): none ${rms.none.toFixed(3)}, per-pixel hash ${rms.hash.toFixed(3)}, interleaved gradient noise ${rms.ign.toFixed(3)}; grain mean ${mean.toFixed(3)}, variance ${variance.toFixed(3)} (triangular 0.167), range ${lo.toFixed(2)}..${hi.toFixed(2)}`);
  assert.ok(rms.none > 0.25, 'the undithered gradient bands');
  assert.ok(rms.ign < rms.none / 3, `the dither breaks the bands up (${rms.ign} vs ${rms.none})`);
  assert.ok(rms.ign <= rms.hash, 'and bands no more than the per-pixel hash it replaces');
  assert.ok(Math.abs(mean) < 0.05, 'zero-mean grain');
  assert.ok(Math.abs(variance - 1 / 6) < 0.02, `the grain is as wide as a triangular dither of one LSB (${variance})`);
  assert.ok(lo >= -1 && hi <= 1, 'one LSB either way');
}

console.log(log.join('\n'));
console.log('[v3-engine-test] PASS');
