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
const { fluidForcesFromFrame, MAX_FLUID_FORCES } = await import(pathToFileURL(resolve('tmp/eviland-fluid-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

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
const quiet = fluidForcesFromFrame(frame());
log.push(`quiet forces: ${quiet.length}`);
if (quiet.length > 4) fail('quiet frame should produce at most a few baseline forces');
if (quiet.some((f) => !Number.isFinite(f.x + f.y + f.dx + f.dy + f.radius))) fail('non-finite force fields');

// Kick onset → multiple outward radial spokes anchored low-center.
const kick = fluidForcesFromFrame(frame({ onsets: [{ band: 1, group: 'kick', intensity: 1, sharpness: 0.8 }], kick: 1 }));
const spokes = kick.filter((f) => f.y < 0.5 && mag(f) > 0.001);
log.push(`kick spokes: ${spokes.length}`);
if (spokes.length < 4) fail('kick should emit ≥4 radial spokes in the lower half');
// Outward: each spoke's direction points away from the shared anchor.
const cx = spokes.reduce((s, f) => s + f.x, 0) / spokes.length;
const cy = spokes.reduce((s, f) => s + f.y, 0) / spokes.length;
if (!spokes.every((f) => (f.x - cx) * f.dx + (f.y - cy) * f.dy >= -1e-6)) fail('kick spokes must point outward from their anchor');

// Snare onset → exactly one strong angled jet, off-center.
const snare = fluidForcesFromFrame(frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }], snare: 1 }));
const jets = snare.filter((f) => mag(f) > 0.001 && Math.abs(f.x - 0.5) > 0.05);
log.push(`snare jets: ${jets.length}`);
if (jets.length !== 1) fail(`snare should emit exactly 1 off-center jet, got ${jets.length}`);

// Hat onset → small top-edge entries.
const hat = fluidForcesFromFrame(frame({ onsets: [{ band: 20, group: 'hat', intensity: 0.8, sharpness: 1 }], hat: 0.8 }));
if (!hat.some((f) => f.y > 0.7)) fail('hat should emit top-edge turbulence');

// Anticipation inhale: high confidence, phase just before the beat → inward pull.
const inhale = fluidForcesFromFrame(frame({ bpm: 124, beatConfidence: 0.8, beatPhase: 0.92 }));
const inward = inhale.filter((f) => {
  const rx = f.x - 0.5, ry = f.y - 0.5;
  return rx * f.dx + ry * f.dy < -1e-6; // pointing toward center
});
log.push(`inhale inward forces: ${inward.length}`);
if (inward.length < 2) fail('pre-beat inhale should emit inward forces');

// Cap: a maximal everything-at-once frame stays within MAX_FLUID_FORCES.
const busy = fluidForcesFromFrame(frame({
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

const report = log.join('\n') + '\n' + (pass ? '[eviland-fluid-test] PASS' : '[eviland-fluid-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
