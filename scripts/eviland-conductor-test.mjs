// Conductor test: a hand-written score played against a fake clock. Checks the
// cue timeline (sections on the bar line, tiers known up front, repeats sharing
// an id, anticipation → blackout → impact, key glide), seek behaviour, the
// untouched no-score path, and that the Director follows the score's tier.
// esbuild harness like eviland-director-test. Run: node scripts/eviland-conductor-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-conductor-test-result.txt');
writeFileSync(RESULT, '[eviland-conductor-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

async function load(entry, out) {
  await build({
    entryPoints: [resolve(entry)],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve(out), logLevel: 'silent',
  });
  return import(pathToFileURL(resolve(out)).href);
}
const { createConductor, applyScoreCues } = await load('src/visualizer/eviland-conductor.ts', 'tmp/eviland-conductor-bundle.mjs');
const { createDirector } = await load('src/visualizer/eviland-director.ts', 'tmp/eviland-director-for-conductor-bundle.mjs');
const { createDynamics } = await load('src/visualizer/eviland-operators.ts', 'tmp/eviland-operators-for-conductor-bundle.mjs');

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// 120 BPM, bars of four from beat 0. Verse, chorus, verse, then a bridge whose
// last 4 s build into a half-second silence and a final chorus in a new key.
const BEAT = 0.5;
const section = (start, end, label, tier, extra = {}) => ({
  start, end, label, tier, intensity: 0.5, keyShift: 0,
  key: { tonic: 0, minor: false, confidence: 1 }, fingerprint: new Array(24).fill(0.25), build: null, ...extra,
});
const score = {
  v: 1, duration: 80, bpm: 120, beatConfidence: 0.9, downbeat: 0, downbeatConfidence: 0.8,
  beats: Array.from({ length: 160 }, (_, i) => i * BEAT),
  homeKey: { tonic: 0, minor: false, confidence: 1 },
  energy: new Array(160).fill(0.5),
  sections: [
    section(0, 16, 0, 'steady'),
    section(16, 32, 1, 'lift', { build: { seconds: 2, strength: 0.2, gapSeconds: 0 } }),
    section(32, 48, 0, 'steady'),
    section(48, 64, 2, 'calm'),
    section(64, 80, 1, 'climax', { keyShift: 3, build: { seconds: 4, strength: 0.8, gapSeconds: 0.5 } }),
  ],
};

const rawFrame = () => ({
  bands: new Float32Array(24), onsets: [],
  kick: 0.3, bass: 0.3, snare: 0.2, hat: 0.2, vocal: 0.2, energy: 0.2,
  centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.3, pan: 0,
  beatPhase: 0.77, beatConfidence: 0.1, bpm: 93, novelty: 0,
  sectionId: 41, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
});

/** Play [from, to) at 60 fps; returns one snapshot per frame. */
function play(conductor, from, to) {
  const out = [];
  for (let t = from; t < to - 1e-9; t += 1 / 60) {
    const f = conductor.conduct(rawFrame(), t, 1000 / 60);
    out.push({ t, sectionId: f.sectionId, changed: f.sectionChanged, ret: f.sectionReturn, beatPhase: f.beatPhase, bpm: f.bpm, fp: f.sectionFingerprint, ...f.score });
  }
  return out;
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ── No score: the frame is the reactor's, untouched ─────────────────────────
{
  const conductor = createConductor();
  const f = conductor.conduct(rawFrame(), 12, 16);
  if (f.score !== undefined || f.sectionId !== 41 || f.bpm !== 93) fail('a frame was altered with no score bound');
  if (applyScoreCues(createDynamics(), undefined).output !== 1) fail('no cues must mean unit output gain');
}

// ── Straight play-through ───────────────────────────────────────────────────
const conductor = createConductor();
conductor.setScore(score);
const frames = play(conductor, 0, 80);
const changes = frames.filter((f) => f.changed);
log.push(`look changes at ${changes.map((f) => f.t.toFixed(2)).join(', ')}`);

if (changes.length !== 5) fail(`expected 5 look changes (one per section), got ${changes.length}`);
else {
  // Crossfaded sections lead the bar line by a beat; a section that LANDS
  // (strong build) cuts exactly on it. The weak build into section 1 is a
  // crossfade, not a landing.
  const expected = [0, 16 - BEAT, 32 - BEAT, 48 - BEAT, 64];
  changes.forEach((f, i) => { if (!near(f.t, expected[i], 0.02)) fail(`look change ${i} at ${f.t.toFixed(3)}s, expected ${expected[i]}s`); });
  // Repeats share the first occurrence's id and announce themselves as returns.
  if (changes.map((f) => f.sectionId).join() !== '0,1,0,3,1') fail(`section ids ${changes.map((f) => f.sectionId)} — repeats must share the first id`);
  if (changes.map((f) => f.ret).join() !== '-1,-1,0,-1,1') fail(`section returns ${changes.map((f) => f.ret)}`);
  // The tier on the change frame is the tier of the section that is STARTING.
  if (changes.map((f) => f.tier).join() !== 'steady,lift,steady,calm,climax') fail(`tiers at the boundaries: ${changes.map((f) => f.tier)}`);
  // Fingerprint of the section that ended rides on the change frame only.
  if (changes[0].fp !== null || !(changes[1].fp instanceof Float32Array)) fail('sectionFingerprint should carry the ended section on change frames');
  if (frames.some((f) => !f.changed && f.fp !== null)) fail('sectionFingerprint leaked onto a non-boundary frame');
}

// Beat grid replaces the live guess.
const mid = frames.find((f) => near(f.t, 10.25, 0.009));
if (!mid || !near(mid.beatPhase, 0.5, 0.05) || !near(mid.bpm, 120, 0.5)) fail(`beat grid not applied: phase ${mid?.beatPhase} bpm ${mid?.bpm}`);
const downbeats = frames.filter((f) => f.downbeat).map((f) => f.t);
if (!downbeats.length || downbeats.some((t) => !near(t / 2, Math.round(t / 2), 0.02))) fail(`downbeats off the 2 s bar grid: ${downbeats.slice(0, 5).map((t) => t.toFixed(2))}`);
if (Math.abs(downbeats.length - 39) > 1) fail(`expected ~39 bar lines in 80 s, got ${downbeats.length}`);

// Anticipation → blackout → impact around the big landing at 64 s.
const at = (t) => frames.find((f) => near(f.t, t, 0.009));
if (at(59.5).anticipation !== 0) fail('anticipation started before the build window');
if (!(at(61).anticipation > 0 && at(62.5).anticipation > at(61).anticipation && at(63.4).anticipation > at(62.5).anticipation)) fail('anticipation does not climb through the build');
if (at(63.4).anticipation > 0.8 + 1e-6) fail('anticipation exceeded the build strength');
if (at(63.4).blackout !== 0) fail('blackout began before the silence');
if (!(at(63.8).blackout > 0.9)) fail(`blackout ${at(63.8).blackout} during the held silence`);
const landing = frames.filter((f) => f.impactStart);
if (landing.length !== 1 || !near(landing[0].t, 64, 0.02)) fail(`impact should start exactly once at 64 s, got ${landing.map((f) => f.t.toFixed(2))}`);
else if (!near(landing[0].impact, 0.8, 1e-6)) fail(`impact ${landing[0].impact}, expected the build strength 0.8`);
if (!(at(64.5).impact < at(64.1).impact && at(64.5).impact > 0.2)) fail('impact should decay smoothly after landing');
if (at(67).impact > 0.05) fail('impact is still lit three seconds later');
if (at(64.2).anticipation !== 0 || at(64.2).blackout !== 0) fail('build cues must clear once the section lands');
// The weak build into section 1 ramps but must not fire an impact.
if (!(at(15.2).anticipation > 0)) fail('weak build should still raise anticipation');
if (frames.some((f) => f.impactStart && f.t < 60)) fail('a weak build fired an impact');

// Key: glides to +3 fifths (20° each: a sixth of a turn) after the last section starts.
if (at(60).keyShift !== 0) fail('home-key sections must not shift hue');
if (!(at(64.5).keyShift > 0 && at(64.5).keyShift < 1 / 6)) fail(`key shift should be mid-glide half a second in, got ${at(64.5).keyShift}`);
if (!near(at(72).keyShift, 1 / 6, 0.01)) fail(`key shift should settle at 1/6 turn, got ${at(72).keyShift}`);

if (!near(at(40).arc, 0.5, 0.01)) fail(`arc at the midpoint is ${at(40).arc}`);
if (!near(at(60).toBoundary, 4, 0.02) || at(70).toBoundary !== Infinity) fail('toBoundary is wrong');

// ── Seeks ───────────────────────────────────────────────────────────────────
{
  const c = createConductor();
  c.setScore(score);
  play(c, 0, 2);
  // Jump straight into the final chorus: the look must change, with the right
  // id, but a seek is not a drop — no impact flash.
  const f = c.conduct(rawFrame(), 66, 16);
  if (!f.sectionChanged || f.sectionId !== 1 || f.score.tier !== 'climax') fail('seek into the last section did not switch to it');
  if (f.score.impact !== 0 || f.score.impactStart) fail('a seek fired a drop impact');
  if (!near(f.score.keyShift, 1 / 6, 1e-9)) fail('a seek should snap the key shift, not glide from the old section');
  // And back to the verse.
  const back = c.conduct(rawFrame(), 5, 16);
  if (!back.sectionChanged || back.sectionId !== 0 || back.score.keyShift !== 0) fail('seek back did not restore the first section');
}

// ── Past the scored duration the live estimators take over again ────────────
{
  const c = createConductor();
  c.setScore(score);
  play(c, 78, 80);
  const f = c.conduct(rawFrame(), 95, 16);
  if (f.score !== undefined || f.sectionId !== 41) fail('frame still conducted past the end of the score');
}

// ── What the cues do to a look ──────────────────────────────────────────────
{
  const dyn = createDynamics();
  dyn.zoom = 0.01; dyn.decay = 0.9; dyn.emitterGain = 1; dyn.bloom = 0;
  const gain = applyScoreCues(dyn, { ...at(63.4) });
  if (!(dyn.zoom < 0.01 && dyn.decay > 0.9 && dyn.emitterGain < 1)) fail('a build should pull inward, lengthen trails and thin events');
  if (!(gain.output < 1 && gain.saturation < 1)) fail('a build should dim and grey the output');
  const dark = applyScoreCues(createDynamics(), { ...at(63.8) });
  if (!(dark.output < 0.12)) fail(`blackout leaves output gain at ${dark.output}`);
  const hit = createDynamics();
  hit.zoom = 0; hit.bloom = 0; hit.emitterGain = 1;
  const flash = applyScoreCues(hit, { ...landing[0] });
  if (!(flash.output > 1.5 && hit.zoom > 0 && hit.bloom > 0 && hit.emitterGain > 1)) fail('impact should burst outward and flash');
}

// ── The Director takes the incoming section's tier from the score ───────────
{
  const director = createDirector({ songId: 'conductor-test', rotateMs: 0, drift: 0 });
  const c = createConductor();
  c.setScore(score);
  const names = new Map();
  for (let t = 0; t < 80; t += 1 / 30) {
    // Near-silent audio: the causal estimator alone would call every section 'calm'.
    const config = director.update(c.conduct({ ...rawFrame(), energy: 0.05 }, t, 1000 / 30), 1000 / 30);
    // Sample mid-section, well clear of the crossfades around each boundary.
    if (Math.abs((t % 16) - 8) < 1 / 60) names.set(Math.floor(t / 16), config.name);
  }
  const tiers = [...names.values()].map((name) => String(name).split(' • ').pop());
  log.push(`director looks: ${[...names.values()].join(' | ')}`);
  if (tiers.join() !== 'steady,lift,steady,calm,climax') fail(`Director tiers ${tiers} should follow the score`);
  if (names.get(0) !== names.get(2)) fail('the repeated verse did not get its look back');
  // The last chorus repeats the first at a higher tier: same look family, re-tuned.
  const family = (name) => String(name).split(' • ')[0];
  if (family(names.get(1)) !== family(names.get(4))) fail(`the final chorus (${names.get(4)}) lost the first chorus's look (${names.get(1)})`);
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-conductor-test] PASS' : '[eviland-conductor-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
