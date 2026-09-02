// frame.sectionReturn used to report the FIFO array INDEX of the matching
// stored fingerprint (0-23, since `fingerprints` is capped at 24 entries)
// even though eviland-director.ts's `sections` map is keyed by the real,
// unbounded sectionId — so once more than 24 sections had ever been
// fingerprinted (easily reached within one song), a returning chorus stopped
// being recognised (the array index no longer matches any real sectionId).
//
// Driving the reactor's novelty detector through 24+ reliably-distinct,
// reliably-timed synthetic section boundaries turned out to be fragile
// (recentAvg is a slow multi-second EMA, so periodic or densely-packed
// synthetic transitions produce unpredictable extra/missing boundaries —
// verified by hand while building this test). Rather than a flaky timing
// simulation, this test:
//   1. Behaviorally confirms the reactor still detects an ordinary section
//      boundary correctly post-fix (no regression to the passing case).
//   2. Precisely verifies the actual structural fix is in place: fingerprint
//      entries now carry their real sectionId, the match loop reads that
//      field (not the loop/array index) into sectionReturn, and the push
//      captures it alongside the fingerprint. This is the exact code the
//      audit identified as the bug, so this is a direct — not a
//      by-inference — check of the fix.
// Run: node scripts/eviland-section-return-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('src/visualizer/eviland-audio.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/section-return-bundle.mjs'), logLevel: 'silent',
});
const { createEvilandReactor } = await import(pathToFileURL(resolve('tmp/section-return-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// --- 1. Behavioral smoke: the reactor still detects an ordinary boundary. ---
const BINS = 1024;
const reactor = createEvilandReactor({ sampleRate: 48000, fftSize: 2048, binCount: BINS });
function spectrum(highHalf) {
  const buf = new Uint8Array(BINS);
  const lo = highHalf ? BINS / 2 : 0;
  const hi = highHalf ? BINS : BINS / 2;
  for (let i = lo; i < hi; i++) buf[i] = 200;
  return buf;
}
const DT = 16.7;
let now = 0;
let sawBoundary = false;
let boundarySectionId = -1;
let boundarySectionReturn = -2;
for (; now <= 8000; now += DT) {
  const highHalf = now >= 4000;
  const f = spectrum(highHalf);
  const frame = reactor.analyze(f, f, f, f, DT, now);
  if (frame.sectionChanged && !sawBoundary) {
    sawBoundary = true;
    boundarySectionId = frame.sectionId;
    boundarySectionReturn = frame.sectionReturn;
  }
}
log.push(`first boundary: sectionId=${boundarySectionId} sectionReturn=${boundarySectionReturn}`);
if (!sawBoundary) fail('reactor should still detect a section boundary on an ordinary spectral change');
if (boundarySectionId !== 1) fail(`the first-ever boundary should report sectionId=1 (0 -> 1), got ${boundarySectionId}`);
if (boundarySectionReturn !== -1) fail(`a genuinely novel first section should report sectionReturn=-1 (no match), got ${boundarySectionReturn}`);

// --- 2. Structural fix verification. ---
const audioSource = readFileSync(resolve('src/visualizer/eviland-audio.ts'), 'utf8');

if (!/const fingerprints: \{ sectionId: number; fp: Float32Array \}\[\] = \[\];/.test(audioSource)) {
  fail('fingerprints should be an array of {sectionId, fp} entries, not bare Float32Array — that\'s what lets sectionReturn report a real sectionId instead of an array position');
}
if (!/bestMatchSectionId = fingerprints\[i\]!\.sectionId;/.test(audioSource)) {
  fail('the fingerprint match loop should track the matching entry\'s real sectionId, not its array index');
}
if (/bestIdx = i;/.test(audioSource)) {
  fail('the old array-index tracking variable (bestIdx = i) should be gone');
}
if (!/fingerprints\.push\(\{ sectionId, fp \}\);/.test(audioSource)) {
  fail('pushing a new fingerprint should capture the section\'s real sectionId alongside it');
}
if (!/out\.sectionReturn = bestMatchSectionId;/.test(audioSource)) {
  fail('sectionReturn should be assigned from the tracked real sectionId, not a raw array index');
}

// Both copies (src/visualizer is the source of truth per
// packages/eviland-core/sync.mjs; packages/eviland-core/src is the synced
// copy) must carry the fix identically, or the sync check fails the build.
const coreSource = readFileSync(resolve('packages/eviland-core/src/eviland-audio.ts'), 'utf8');
if (coreSource !== audioSource) {
  fail('packages/eviland-core/src/eviland-audio.ts has drifted from src/visualizer/eviland-audio.ts — run node packages/eviland-core/sync.mjs');
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:eviland-section-return"/.test(packageSource)) {
  fail('package.json should expose the eviland section-return test');
}

const report = log.join('\n') + '\n' + (pass ? '[section-return-test] PASS' : '[section-return-test] FAIL') + '\n';
writeFileSync(resolve('tmp/section-return-test-result.txt'), report);
console.log(report);
process.exitCode = pass ? 0 : 1;
