// Runtime unit test for the structure detector in the Eviland audio reactor
// (no GPU, no audio hardware). Bundles eviland-audio.ts for Node, feeds a
// synthetic two-phase spectrum (bass-heavy → treble-heavy), and asserts a
// section boundary fires within the relaxed detection window.
// Run: node scripts/eviland-audio-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/audio-test-result.txt');
writeFileSync(RESULT, '[audio-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-audio.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/audio-bundle.mjs'), logLevel: 'silent',
});
const { createEvilandReactor } = await import(pathToFileURL(resolve('tmp/audio-bundle.mjs')).href);

const BINS = 1024;
const reactor = createEvilandReactor({ sampleRate: 48000, fftSize: 2048, binCount: BINS });

// Phase A: energy in the low half of the spectrum. Phase B: energy in the high
// half. The abrupt swap drives the band-vector cosine novelty hard.
function spectrum(highHalf) {
  const buf = new Uint8Array(BINS);
  const lo = highHalf ? BINS / 2 : 0;
  const hi = highHalf ? BINS : BINS / 2;
  for (let i = lo; i < hi; i++) buf[i] = 200;
  return buf;
}

const DT = 16.7;
let now = 0;
let firstBoundaryAt = -1;
// Run 0..8000ms: bass-heavy until 4000ms, then treble-heavy.
for (let i = 0; now <= 8000; i++) {
  const highHalf = now >= 4000;
  const f = spectrum(highHalf);
  const frame = reactor.analyze(f, f, f, f, DT, now);
  if (frame.sectionChanged && firstBoundaryAt < 0) firstBoundaryAt = now;
  now += DT;
}

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
log.push(`firstBoundaryAt=${firstBoundaryAt.toFixed(0)}ms`);
// Relaxed guards (3500ms) must let the 4000ms change fire by ~4500ms.
// The OLD 6000ms guards would push the earliest boundary past 6000ms → fail.
if (firstBoundaryAt < 0) fail('no section boundary detected at all');
else if (firstBoundaryAt < 3500) fail('boundary fired before the min-length guard');
else if (firstBoundaryAt > 5500) fail(`boundary too late (${firstBoundaryAt}ms) — detector not relaxed`);

const report = log.join('\n') + '\n' + (pass ? '[audio-test] PASS' : '[audio-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
