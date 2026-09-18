// Song-score test: synthesise a track whose tempo, bar lines, form, build and
// key change are known exactly, then check the analyser recovers them.
// esbuild harness like eviland-director-test. Run: node scripts/eviland-score-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-score-test-result.txt');
writeFileSync(RESULT, '[eviland-score-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-score.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-score-bundle.mjs'), logLevel: 'silent',
});
const { computeSongScore, isValidSongScore, SONG_SCORE_SAMPLE_RATE } = await import(
  pathToFileURL(resolve('tmp/eviland-score-bundle.mjs')).href
);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

/** Paths of every number in `value` that is NaN or ±Infinity. (JSON.stringify would hide them as null.) */
function nonFinitePaths(value, path = 'score') {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => nonFinitePaths(child, `${path}.${key}`));
}

// ── The synthetic song ──────────────────────────────────────────────────────
// 120 BPM, 4/4, six 8-bar sections (16 s each):
//   A verse   C major, kick + bass + soft pad
//   B chorus  C major, louder: + snare, hats, bright stacked chords
//   A, B      repeat
//   C bridge  E major (+4 fifths), no drums, pad; a noise riser over its last
//             4 bars, then ONE BEAT of silence
//   B chorus  lands on the downbeat after the silence
const SR = SONG_SCORE_SAMPLE_RATE;
const BPM = 120;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const SECTION_BARS = 8;
const FORM = ['A', 'B', 'A', 'B', 'C', 'B'];
const total = Math.round(FORM.length * SECTION_BARS * BAR * SR);
const song = new Float32Array(total);

let noiseState = 0x2545f491;
const noise = () => {
  noiseState ^= noiseState << 13; noiseState ^= noiseState >>> 17; noiseState ^= noiseState << 5;
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
};
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
function addTone(at, seconds, hz, gain, harmonics = 1) {
  const start = Math.round(at * SR);
  const n = Math.round(seconds * SR);
  for (let i = 0; i < n && start + i < total; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.01) * Math.min(1, (seconds - t) / 0.05);
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * hz * h * t) / h;
    song[start + i] += v * gain * env;
  }
}
function addKick(at, gain) {
  const start = Math.round(at * SR);
  for (let i = 0; i < SR * 0.18 && start + i < total; i++) {
    const t = i / SR;
    song[start + i] += Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-t * 28)) * t) * Math.exp(-t * 16) * gain;
  }
}
function addNoiseHit(at, seconds, gain, decay) {
  const start = Math.round(at * SR);
  let prev = 0;
  for (let i = 0; i < seconds * SR && start + i < total; i++) {
    const raw = noise();
    const bright = raw - prev; // crude high-pass
    prev = raw;
    song[start + i] += bright * gain * Math.exp((-i / SR) * decay);
  }
}

// I–V–vi–IV, two bars per chord, as semitone offsets from the section tonic.
const PROGRESSION = [0, 7, 9, 5];
FORM.forEach((kind, sectionIndex) => {
  const sectionStart = sectionIndex * SECTION_BARS * BAR;
  const tonic = kind === 'C' ? 64 : 60; // E vs C
  for (let bar = 0; bar < SECTION_BARS; bar++) {
    const barStart = sectionStart + bar * BAR;
    const root = tonic + PROGRESSION[Math.floor(bar / 2) % 4];
    const third = root + (PROGRESSION[Math.floor(bar / 2) % 4] === 9 ? 3 : 4);
    const lastBeatSilent = kind === 'C' && bar === SECTION_BARS - 1;
    const barLength = lastBeatSilent ? BAR - BEAT : BAR;
    const padGain = kind === 'B' ? 0.11 : 0.06;
    const harmonics = kind === 'B' ? 6 : 2;
    for (const note of [root, third, root + 7]) addTone(barStart, barLength, midiHz(note), padGain, harmonics);
    addTone(barStart, barLength, midiHz(root - 24), kind === 'C' ? 0.12 : 0.2, 2);
    for (let beat = 0; beat < 4; beat++) {
      if (lastBeatSilent && beat === 3) continue;
      const at = barStart + beat * BEAT;
      if (kind !== 'C') addKick(at, beat === 0 ? 0.75 : 0.6);
      if (kind === 'B') {
        if (beat === 1 || beat === 3) addNoiseHit(at, 0.16, 0.35, 22);
        addNoiseHit(at, 0.04, 0.14, 90);
        addNoiseHit(at + BEAT / 2, 0.04, 0.12, 90);
      }
    }
  }
  if (kind === 'C') {
    // Riser: noise whose level and brightness climb over the last 4 bars,
    // stopping dead one beat before the chorus.
    const from = sectionStart + (SECTION_BARS - 4) * BAR;
    const to = sectionStart + SECTION_BARS * BAR - BEAT;
    let low = 0;
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
      const progress = (i / SR - from) / (to - from);
      const raw = noise();
      low += (raw - low) * (0.02 + 0.9 * progress * progress);
      song[i] += low * 0.3 * progress;
    }
  }
});
let peak = 0;
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(song[i]));
for (let i = 0; i < total; i++) song[i] = (song[i] / peak) * 0.9;

// ── Analyse ─────────────────────────────────────────────────────────────────
const started = Date.now();
let pauses = 0;
const score = await computeSongScore(song, { sampleRate: SR, pause: async () => { pauses += 1; } });
const elapsedMs = Date.now() - started;
if (!score) {
  fail('no score for a 96 s structured track');
} else {
  log.push(`analysed ${score.duration}s in ${elapsedMs}ms (${pauses} cooperative pauses)`);
  if (!isValidSongScore(score)) fail('score does not validate');
  const broken = nonFinitePaths(score);
  if (broken.length) fail(`non-finite values in the score: ${broken.slice(0, 5).join(', ')}`);
  if (!isValidSongScore(JSON.parse(JSON.stringify(score)))) fail('score does not survive a JSON round trip');
  if (pauses < 4) fail(`pause() was only offered ${pauses} times — a long track would block its host`);

  // Tempo + grid.
  if (Math.abs(score.bpm - BPM) > BPM * 0.02) fail(`bpm ${score.bpm}, expected ${BPM} ±2%`);
  if (score.beatConfidence < 0.35) fail(`beat confidence ${score.beatConfidence} on a drum-machine grid`);
  const drumBeats = score.beats.filter((t) => t > 2 && t < 60);
  const offsets = drumBeats.map((t) => {
    const nearest = Math.round(t / BEAT) * BEAT;
    return t - nearest;
  });
  const meanOffset = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const worst = Math.max(...offsets.map((o) => Math.abs(o)));
  log.push(`beats: ${score.beats.length}, bpm ${score.bpm}, conf ${score.beatConfidence}, mean offset ${(meanOffset * 1000).toFixed(1)}ms, worst ${(worst * 1000).toFixed(1)}ms`);
  if (Math.abs(meanOffset) > 0.02) fail(`beat grid is biased by ${(meanOffset * 1000).toFixed(1)}ms`);
  if (worst > 0.045) fail(`a beat lands ${(worst * 1000).toFixed(1)}ms off the true grid`);

  // Bar lines: the beat the score calls a downbeat must be a real bar start.
  const firstDownbeat = score.beats[score.downbeat];
  const barError = Math.abs(firstDownbeat / BAR - Math.round(firstDownbeat / BAR)) * BAR;
  log.push(`downbeat index ${score.downbeat} at ${firstDownbeat}s, conf ${score.downbeatConfidence}`);
  if (barError > 0.06) fail(`downbeat at ${firstDownbeat}s is not on a bar line`);

  // Form: five boundaries, each within a bar of the truth.
  const truth = [16, 32, 48, 64, 80];
  const starts = score.sections.slice(1).map((s) => s.start);
  log.push(`sections: ${score.sections.map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)} L${s.label} ${s.tier} i=${s.intensity}`).join(' | ')}`);
  for (const t of truth) {
    if (!starts.some((s) => Math.abs(s - t) <= BAR)) fail(`no section boundary within a bar of ${t}s (found ${starts.join(', ')})`);
  }
  // The riser changes the bridge's texture halfway through; hearing its start
  // (72 s) as a boundary too is a fair reading. Anything else is a false split.
  const extras = starts.filter((s) => !truth.some((t) => Math.abs(s - t) <= BAR));
  if (extras.some((s) => Math.abs(s - 72) > BAR)) fail(`unexpected section boundaries at ${extras.join(', ')}s`);

  const sectionAt = (t) => score.sections.find((s) => t >= s.start && t < s.end);
  const [a1, b1, a2, b2, c, b3] = [8, 24, 40, 56, 68, 88].map(sectionAt);
  if ([a1, b1, a2, b2, c, b3].every(Boolean) && Math.abs(b3.start - 80) <= BAR) {
    // Repeats share a label; different material doesn't.
    if (a1.label !== a2.label) fail('the two verses were not recognised as the same material');
    if (b1.label !== b2.label || b1.label !== b3.label) fail('the three choruses were not recognised as the same material');
    if (a1.label === b1.label) fail('verse and chorus share a label');
    if (c.label === a1.label || c.label === b1.label) fail('the bridge was mistaken for earlier material');

    // Intensity is relative to the song: choruses above verses above bridge.
    if (!(b1.intensity > a1.intensity + 0.1)) fail(`chorus (${b1.intensity}) should be clearly more intense than verse (${a1.intensity})`);
    if (!(c.intensity < b1.intensity)) fail('bridge should be less intense than the chorus');
    if (b3.tier !== 'climax' && b3.tier !== 'drop') fail(`final chorus after the build should be a drop/climax, got ${b3.tier}`);
    if (a1.tier === 'climax' || a1.tier === 'drop') fail(`opening verse tiered as ${a1.tier}`);

    // The build into the last chorus: riser + one held beat of silence.
    log.push(`final build: ${JSON.stringify(b3.build)}`);
    if (!b3.build) fail('no build detected before the final chorus');
    else {
      if (b3.build.strength < 0.4) fail(`final build strength ${b3.build.strength} is too timid for a silence-then-drop`);
      if (Math.abs(b3.build.gapSeconds - BEAT) > 0.2) fail(`held silence measured as ${b3.build.gapSeconds}s, expected ~${BEAT}s`);
      if (b3.build.seconds < 3) fail(`build lead of ${b3.build.seconds}s ignores a 4-bar riser`);
    }
    // A verse → chorus step is a lift worth preparing for, but has no silence.
    if (b1.build && b1.build.gapSeconds > 0) fail('phantom silence before the first chorus');

    // Key: home is C, the bridge sits four fifths up (E).
    log.push(`home key ${score.homeKey.tonic}${score.homeKey.minor ? 'm' : ''} (${score.homeKey.confidence}); bridge ${c.key.tonic}${c.key.minor ? 'm' : ''} (${c.key.confidence}) shift ${c.keyShift}`);
    if (score.homeKey.tonic !== 0 || score.homeKey.minor) fail(`home key should be C major, got tonic ${score.homeKey.tonic} minor=${score.homeKey.minor}`);
    if (c.key.tonic !== 4) fail(`bridge key should be E, got tonic ${c.key.tonic}`);
    if (c.keyShift !== 4) fail(`bridge should sit +4 fifths from home, got ${c.keyShift}`);
    if (a1.keyShift !== 0 || b1.keyShift !== 0) fail('home-key sections must not shift the palette');
  }

  // Energy curve: 2 Hz, quiet bridge visibly under the chorus.
  if (Math.abs(score.energy.length - score.duration * 2) > 3) fail(`energy curve has ${score.energy.length} points for ${score.duration}s`);
  const at = (t) => score.energy[Math.round(t * 2)];
  if (!(at(40) > at(70))) fail('energy curve does not show the chorus above the bridge');
}

// A loud passage that stops a beat early and gives way to something QUIETER
// is an ending, not the held breath before a drop: no silence, no impact.
{
  const seconds = 48;
  const fade = new Float32Array(seconds * SR);
  for (let beat = 0; beat * BEAT < seconds; beat++) {
    const at = beat * BEAT;
    const loud = at < 24;
    if (loud && at >= 24 - BEAT) continue; // the last loud beat is silent
    const start = Math.round(at * SR);
    for (let i = 0; i < BEAT * SR && start + i < fade.length; i++) {
      const t = i / SR;
      const kick = loud ? Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-t * 28)) * t) * Math.exp(-t * 16) * 0.7 : 0;
      const pad = Math.sin(2 * Math.PI * 220 * (at + t)) * (loud ? 0.2 : 0.04) + Math.sin(2 * Math.PI * 330 * (at + t)) * (loud ? 0.15 : 0.03);
      fade[start + i] = kick + pad;
    }
  }
  const trailing = await computeSongScore(fade, { sampleRate: SR });
  const quiet = trailing?.sections.find((section) => section.start > 20 && section.start < 28);
  log.push(`trail-off: ${trailing ? trailing.sections.map((x) => `${x.start.toFixed(1)} ${x.tier} ${JSON.stringify(x.build)}`).join(' | ') : 'no score'}`);
  if (!quiet) fail('the loud → quiet change at 24 s was not found');
  else if (quiet.build && (quiet.build.gapSeconds > 0 || quiet.build.strength >= 0.3)) fail(`a trail-off into a quieter section was scored as a drop: ${JSON.stringify(quiet.build)}`);
}

// Too short to have structure → null, not a throw.
const stub = await computeSongScore(new Float32Array(SR * 8), { sampleRate: SR });
if (stub !== null) fail('an 8 s clip should not produce a score');

// Silence and noise must not throw or emit NaNs.
for (const [name, fill] of [['silence', () => 0], ['noise', () => noise() * 0.5]]) {
  const buf = new Float32Array(SR * 40);
  for (let i = 0; i < buf.length; i++) buf[i] = fill();
  const s = await computeSongScore(buf, { sampleRate: SR });
  if (s) {
    const bad = nonFinitePaths(s);
    if (bad.length) fail(`${name}: non-finite values at ${bad.slice(0, 5).join(', ')}`);
  }
  log.push(`${name}: ${s ? `${s.sections.length} sections, beat conf ${s.beatConfidence}` : 'no score'}`);
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-score-test] PASS' : '[eviland-score-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
