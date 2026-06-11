// Unit test for fluidForcesFromFrame (pure audio→impulse mapping; no GL).
// esbuild harness like eviland-director-test. Run: node scripts/eviland-fluid-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-fluid-test-result.txt');
writeFileSync(RESULT, '[eviland-fluid-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-fluid.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-fluid-bundle.mjs'), logLevel: 'silent',
});
const {
  fluidForcesFromFrame,
  createFluidForceSource,
  dyeDissipationFromFrame,
  MAX_FLUID_FORCES,
} = await import(pathToFileURL(resolve('tmp/eviland-fluid-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// The pooled factory returns the same backing array each call (its FluidForce
// entries are pool slots reused across calls). Tests that hold results past
// the next forces() call must snapshot first; `snap` deep-copies the values
// we assert on into plain literals.
const snap = (arr) =>
  arr.map((f) => ({
    x: f.x, y: f.y, dx: f.dx, dy: f.dy, radius: f.radius,
    color: f.color ? [f.color[0], f.color[1], f.color[2]] : undefined,
    dye: f.dye,
  }));
// Convenience: build a fresh factory + call forces(frame) + snapshot in one
// go. Each call gets its own factory so the snare alternator state in earlier
// tests can't leak into later ones (the determinism check at the end deals
// with that explicitly).
const collect = (f) => snap(createFluidForceSource().forces(f));

function frame(over = {}) {
  return {
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.3, centroid: 0.4, flatness: 0.3, crest: 0.3, rolloff: 0.5,
    width: 0.4, pan: 0, novelty: 0.1, beatPhase: 0.2, beatConfidence: 0.3, bpm: 120,
    sectionId: 0, sectionChanged: false, sectionReturn: -1,
    bands: new Array(24).fill(0.2),
    onsets: [],
    ...over,
  };
}
const mag = (f) => Math.hypot(f.dx, f.dy);

// Silent frame: only the baseline bass/pan entries (small) — never empty-crash.
const quiet = collect(frame());
log.push(`quiet forces: ${quiet.length}`);
if (quiet.length > 4) fail('quiet frame should produce at most a few baseline forces');
if (quiet.some((f) => !Number.isFinite(f.x + f.y + f.dx + f.dy + f.radius))) fail('non-finite force fields');

// Kick onset → multiple outward radial spokes anchored low-center.
const kick = collect(frame({ onsets: [{ band: 1, group: 'kick', intensity: 1, sharpness: 0.8 }], kick: 1 }));
const spokes = kick.filter((f) => f.y < 0.5 && mag(f) > 0.001);
log.push(`kick spokes: ${spokes.length}`);
if (spokes.length < 4) fail('kick should emit ≥4 radial spokes in the lower half');
// Outward: each spoke's direction points away from the shared anchor.
const cx = spokes.reduce((s, f) => s + f.x, 0) / spokes.length;
const cy = spokes.reduce((s, f) => s + f.y, 0) / spokes.length;
if (!spokes.every((f) => (f.x - cx) * f.dx + (f.y - cy) * f.dy >= -1e-6)) fail('kick spokes must point outward from their anchor');

// Snare onset → exactly one strong angled jet, off-center.
const snare = collect(frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }], snare: 1 }));
const jets = snare.filter((f) => mag(f) > 0.001 && Math.abs(f.x - 0.5) > 0.05);
log.push(`snare jets: ${jets.length}`);
if (jets.length !== 1) fail(`snare should emit exactly 1 off-center jet, got ${jets.length}`);

// Hat onset → small top-edge entries.
const hat = collect(frame({ onsets: [{ band: 20, group: 'hat', intensity: 0.8, sharpness: 1 }], hat: 0.8 }));
if (!hat.some((f) => f.y > 0.7)) fail('hat should emit top-edge turbulence');

// Anticipation inhale: high confidence, phase just before the beat → inward pull.
const inhale = collect(frame({ bpm: 124, beatConfidence: 0.8, beatPhase: 0.92 }));
const inward = inhale.filter((f) => {
  const rx = f.x - 0.5, ry = f.y - 0.5;
  return rx * f.dx + ry * f.dy < -1e-6; // pointing toward center
});
log.push(`inhale inward forces: ${inward.length}`);
if (inward.length < 2) fail('pre-beat inhale should emit inward forces');

// Cap: a maximal everything-at-once frame stays within MAX_FLUID_FORCES.
const busy = collect(frame({
  onsets: [
    { band: 1, group: 'kick', intensity: 1, sharpness: 1 },
    { band: 7, group: 'snare', intensity: 1, sharpness: 1 },
    { band: 20, group: 'hat', intensity: 1, sharpness: 1 },
    { band: 21, group: 'hat', intensity: 1, sharpness: 1 },
    { band: 12, group: 'vocal', intensity: 1, sharpness: 1 },
  ],
  kick: 1, snare: 1, hat: 1, bass: 1, pan: 0.5, bpm: 128, beatConfidence: 0.9, beatPhase: 0.9,
}));
log.push(`busy forces: ${busy.length} (cap ${MAX_FLUID_FORCES})`);
if (busy.length > MAX_FLUID_FORCES) fail(`forces exceed cap: ${busy.length} > ${MAX_FLUID_FORCES}`);

// ─── DYE FIELD ASSERTIONS ───────────────────────────────────────────────
// (1) Backward-compat: the existing baseline/inhale forces stay velocity-only.
// The inhale spokes and bass shear never carried dye in the pre-dye seam; they
// still mustn't. The pan-bias force is allowed to carry a faint ambient dye.
{
  const inhaleOnly = collect(frame({ bpm: 120, beatConfidence: 0.9, beatPhase: 0.92 }));
  const colorless = inhaleOnly.filter(f => !f.color && (f.dye ?? 0) === 0);
  if (colorless.length === 0) fail('inhale-only frame should still emit colorless velocity forces (backward compat)');
  log.push(`inhale-only colorless forces: ${colorless.length}`);
}

// (2) Kick onset → forces with positive dye + color in the kick voice's hue.
const kickFrame = frame({ onsets: [{ band: 1, group: 'kick', intensity: 1, sharpness: 0.8 }], kick: 1, bass: 0.5 });
const kickForces = collect(kickFrame);
const kickDyed = kickForces.filter(f => f.color && (f.dye ?? 0) > 0);
log.push(`kick dyed forces: ${kickDyed.length}`);
if (kickDyed.length < 6) fail('kick should emit ≥6 dye-carrying forces (one large + spokes)');
if (!kickDyed.every(f => f.color.every(c => c >= 0 && c <= 1.001))) fail('kick dye color out of [0,1]');

// (3) Snare onset → exactly one bright dye splat with its jet.
const snareFrame = frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }], snare: 1 });
const snareForces = collect(snareFrame);
const snareDyed = snareForces.filter(f => f.color && (f.dye ?? 0) > 0);
if (snareDyed.length !== 1) fail(`snare should emit exactly 1 dyed splat, got ${snareDyed.length}`);
// snare dye should be bright/whitish (high luma)
if (snareDyed[0]) {
  const [r,g,b] = snareDyed[0].color;
  const luma = 0.299*r + 0.587*g + 0.114*b;
  if (luma < 0.75) fail(`snare dye expected near-white, luma=${luma.toFixed(2)}`);
}

// (4) Hat onset → two small top-edge dye splats (band-keyed hue).
const hatFrame = frame({ onsets: [{ band: 21, group: 'hat', intensity: 0.8, sharpness: 1 }], hat: 0.8 });
const hatDyed = collect(hatFrame).filter(f => f.color && (f.dye ?? 0) > 0 && f.y > 0.7);
if (hatDyed.length !== 2) fail(`hat should emit 2 top-edge dyed splats, got ${hatDyed.length}`);

// (5) Vocal/other onsets emit dye-only splats (dx=dy=0) — preserves the
//    snare "exactly one off-center jet" invariant when vocal is also firing.
const vocalFrame = frame({ onsets: [{ band: 12, group: 'vocal', intensity: 1, sharpness: 1 }], vocal: 1 });
const vocalForces = collect(vocalFrame);
const vocalDyed = vocalForces.filter(f => f.color && (f.dye ?? 0) > 0);
if (vocalDyed.length !== 1) fail(`vocal should emit exactly 1 dye-only splat, got ${vocalDyed.length}`);
if (vocalDyed[0] && (vocalDyed[0].dx !== 0 || vocalDyed[0].dy !== 0)) fail('vocal dye splat must be velocity-zero (preserves jet count)');

// (6) Determinism — same frame in, same forces out (positions + dye).
const a = collect(frame({ onsets: [{ band: 5, group: 'other', intensity: 0.8, sharpness: 0.5 }] }));
const b = collect(frame({ onsets: [{ band: 5, group: 'other', intensity: 0.8, sharpness: 0.5 }] }));
const eq = a.length === b.length && a.every((f, i) =>
  f.x === b[i].x && f.y === b[i].y &&
  f.dx === b[i].dx && f.dy === b[i].dy &&
  ((f.color?.[0] ?? -1) === (b[i].color?.[0] ?? -1)));
if (!eq) fail('emitter positions/dye must be deterministic for identical frames');

// (7) Different band → different position AND different hue (the "song-aware"
//    differentiator). Two band-13 vs band-19 onsets in the same voice slot
//    must produce different x/y AND different color tuples.
const f13 = collect(frame({ onsets: [{ band: 13, group: 'vocal', intensity: 1, sharpness: 1 }] }))
  .filter(f => f.color && (f.dye ?? 0) > 0)[0];
const f19 = collect(frame({ onsets: [{ band: 19, group: 'other', intensity: 1, sharpness: 1 }] }))
  .filter(f => f.color && (f.dye ?? 0) > 0)[0];
if (!f13 || !f19) {
  fail('per-band dye splats missing');
} else {
  if (f13.y === f19.y) fail('different bands must map to different vertical positions');
  if (f13.color[0] === f19.color[0] && f13.color[1] === f19.color[1] && f13.color[2] === f19.color[2]) {
    fail('different bands must map to different hues');
  }
}

// ─── POOL CONTRACT (FINDINGS #4 + #7) ──────────────────────────────────
// (P1) A single factory reuses the same backing array across calls; tests that
// hold raw references past the next call must snapshot first. Prove the live
// array IS shared (same identity) and that its FluidForce entries get
// overwritten — this is the contract documented on createFluidForceSource.
{
  const src = createFluidForceSource();
  const r1 = src.forces(frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }] }));
  const r1IdentitySnap = r1; // alias, not a copy
  const r1ValueSnap = snap(r1);
  const r2 = src.forces(frame({ onsets: [{ band: 1, group: 'kick', intensity: 1, sharpness: 1 }], kick: 1 }));
  if (r1IdentitySnap !== r2) fail('pooled source must return the same backing array across calls (identity contract)');
  // Slot 0 must be a kick-shaped entry now (kick emits a centered dye splat),
  // proving the snare slot from r1 has been recycled in-place.
  if (r1ValueSnap.length > 0 && r2.length > 0 && r1ValueSnap[0].x === r2[0].x && r1ValueSnap[0].y === r2[0].y) {
    fail('snare→kick recycle did not change slot 0 (pool aliasing not happening as expected)');
  }
  // …and that the *snapshot* of r1 still holds the snare-shaped values.
  if (r1ValueSnap.length === 0) fail('snapshot lost its data');
  log.push(`pool contract: shared array reused, slot 0 recycled across calls`);
}

// (P2) Two independent factories never alias — distinct call sites get
// independent pools and snareSide alternators.
{
  const sA = createFluidForceSource();
  const sB = createFluidForceSource();
  const fa = sA.forces(frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }] }));
  const fb = sB.forces(frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }] }));
  if (fa === fb) fail('two factories must not share backing arrays');
  // Their FluidForce slot objects also must be independent.
  if (fa.length > 0 && fb.length > 0 && fa[0] === fb[0]) fail('two factories must not share pool slots');
  log.push('pool isolation: independent factories have independent pools');
}

// (P3) Singleton wrapper still works for the in-app call site (eviland.ts):
// fluidForcesFromFrame() must produce the same values as a fresh factory for
// the SAME first call (snare alternator starts at 1 in both).
{
  // Note: the module-level singleton has accumulated state from earlier calls
  // in this test run if we'd been calling it. We HAVEN'T, so its snareSide is
  // still 1; same as a fresh factory.
  const wrapperFirst = snap(fluidForcesFromFrame(
    frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }] })));
  const freshFirst = snap(createFluidForceSource().forces(
    frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }] })));
  if (wrapperFirst.length !== freshFirst.length) fail('wrapper and fresh factory produced different counts');
  for (let i = 0; i < wrapperFirst.length; i++) {
    if (wrapperFirst[i].x !== freshFirst[i].x || wrapperFirst[i].y !== freshFirst[i].y) {
      fail(`wrapper/fresh divergence at slot ${i}`);
      break;
    }
  }
  log.push('singleton wrapper: matches fresh-factory output on first call');
}

// (8) Silence gate: dye dissipation rises with frame.energy (loud lingers, quiet drains).
const dissQuiet = dyeDissipationFromFrame(frame({ energy: 0 }));
const dissLoud  = dyeDissipationFromFrame(frame({ energy: 1 }));
log.push(`dyeDissipation quiet=${dissQuiet.toFixed(3)} loud=${dissLoud.toFixed(3)}`);
if (!(dissQuiet < dissLoud)) fail('dyeDissipation must rise with energy (silence drains, loudness lingers)');
if (dissQuiet < 0.9 || dissQuiet > 0.97) fail(`dyeDissipation@0 expected ~0.94, got ${dissQuiet}`);
if (dissLoud < 0.985 || dissLoud > 1)   fail(`dyeDissipation@1 expected near 1, got ${dissLoud}`);

const report = log.join('\n') + '\n' + (pass ? '[eviland-fluid-test] PASS' : '[eviland-fluid-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
