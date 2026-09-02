// The audio reactor's structural memory (recentAvg, sectionId, timestamps,
// fingerprints, tempo tracking) used to survive every track change — the
// reactor instance is created once per visualizer mount, not per track, and
// had no reset method. The old track's spectrum/timestamps made the new
// track's very first analyze() call read as a huge jump, likely firing a
// spurious sectionChanged before real structure had even been observed.
// This proves reset() actually clears that state: play a track long enough
// to build real structural memory (sectionId > 0), reset(), then feed a
// single frame at a low "new track" timestamp and assert it reports
// sectionId=0 with no spurious boundary — exactly what a genuinely fresh
// reactor reports on its first frame.
// Run: node scripts/eviland-reactor-reset-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('src/visualizer/eviland-audio.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/reactor-reset-bundle.mjs'), logLevel: 'silent',
});
const { createEvilandReactor } = await import(pathToFileURL(resolve('tmp/reactor-reset-bundle.mjs')).href);

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const BINS = 1024;
function spectrum(highHalf) {
  const buf = new Uint8Array(BINS);
  const lo = highHalf ? BINS / 2 : 0;
  const hi = highHalf ? BINS : BINS / 2;
  for (let i = lo; i < hi; i++) buf[i] = 200;
  return buf;
}
const DT = 16.7;

// A brand-new reactor's first frame, for comparison.
const freshReactor = createEvilandReactor({ sampleRate: 48000, fftSize: 2048, binCount: BINS });
const freshFrame = freshReactor.analyze(spectrum(false), spectrum(false), spectrum(false), spectrum(false), DT, 0);
log.push(`fresh reactor first frame: sectionId=${freshFrame.sectionId} sectionChanged=${freshFrame.sectionChanged} novelty=${freshFrame.novelty.toFixed(3)}`);

// Play "track 1" long enough to build real structural memory: at least one
// section boundary (sectionId > 0) plus a nontrivial recentAvg/tempo state.
const reactor = createEvilandReactor({ sampleRate: 48000, fftSize: 2048, binCount: BINS });
let now = 0;
let sawBoundary = false;
for (; now <= 8000; now += DT) {
  const f = spectrum(now >= 4000);
  const frame = reactor.analyze(f, f, f, f, DT, now);
  if (frame.sectionChanged) sawBoundary = true;
}
const beforeReset = reactor.analyze(spectrum(true), spectrum(true), spectrum(true), spectrum(true), DT, now);
log.push(`before reset: sectionId=${beforeReset.sectionId} (built up over an 8s "track")`);
if (!sawBoundary || beforeReset.sectionId < 1) {
  fail('test setup: track 1 should have built real structural memory (sectionId >= 1) before reset() is even tested');
}

// Reset, then feed a single frame at a LOW nowMs (simulating a new track
// starting from near-zero elapsed time) with the SAME spectrum track 1
// ended on. Without the fix, this would read as a dramatic "jump" (recentAvg
// still reflects track 1's spectrum from a hugely different timestamp) and
// could spuriously fire sectionChanged despite being the very first frame
// of the new track's structural history.
reactor.reset();
const afterReset = reactor.analyze(spectrum(true), spectrum(true), spectrum(true), spectrum(true), DT, 0);
log.push(`after reset, first frame of "track 2": sectionId=${afterReset.sectionId} sectionChanged=${afterReset.sectionChanged} sectionReturn=${afterReset.sectionReturn} novelty=${afterReset.novelty.toFixed(3)}`);

if (afterReset.sectionId !== 0) {
  fail(`reset() should bring sectionId back to 0 (fresh reactor reports ${freshFrame.sectionId}), got ${afterReset.sectionId} — structural memory survived the reset`);
}
if (afterReset.sectionChanged) {
  fail('the first frame after reset() should not fire a spurious sectionChanged, same as a genuinely fresh reactor\'s first frame');
}
if (afterReset.sectionReturn !== -1) {
  fail(`a reset reactor's first frame should report sectionReturn=-1 like a fresh one, got ${afterReset.sectionReturn} — fingerprints from track 1 survived the reset`);
}

// --- Source assertions ---
const audioSource = readFileSync(resolve('src/visualizer/eviland-audio.ts'), 'utf8');
if (!/reset\(\): void \{/.test(audioSource)) fail('EvilandReactor should expose a reset() method');
if (!/fingerprints\.length = 0;/.test(audioSource)) fail('reset() should clear the fingerprints array');
if (!/sectionId = 0;\s*\n\s*sectionStartAt = 0;/.test(audioSource)) fail('reset() should zero sectionId and sectionStartAt');

const visualizerSource = readFileSync(resolve('src/components/Visualizer.tsx'), 'utf8');
if (!/reactor\.reset\(\);/.test(visualizerSource)) {
  fail('Visualizer.tsx should call reactor.reset() on track change, alongside director.reset()');
}

const coreSource = readFileSync(resolve('packages/eviland-core/src/eviland-audio.ts'), 'utf8');
if (coreSource !== audioSource) {
  fail('packages/eviland-core/src/eviland-audio.ts has drifted from src/visualizer/eviland-audio.ts — run node packages/eviland-core/sync.mjs');
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:eviland-reactor-reset"/.test(packageSource)) fail('package.json should expose the eviland reactor reset test');

console.log(log.join('\n') + '\n' + (pass ? '[reactor-reset-test] PASS' : '[reactor-reset-test] FAIL'));
process.exitCode = pass ? 0 : 1;
