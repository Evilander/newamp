// Runtime unit test for the AI Director (no GPU). Bundles the director + its
// deps for Node and asserts the conducting logic: valid configs per tier,
// distinct looks across sections, chorus recall on section return, and clean
// passthrough when disabled. Run: node scripts/eviland-director-test.mjs
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const RESULT = resolve('tmp/director-test-result.txt');
// Always leave a trace, even if we crash before the assertions run.
writeFileSync(RESULT, '[director-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });
process.on('unhandledRejection', (e) => { writeFileSync(RESULT, 'REJECTION: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-director.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/director-bundle.mjs'), logLevel: 'silent',
});
const { createDirector } = await import(pathToFileURL(resolve('tmp/director-bundle.mjs')).href);

function mockFrame(over = {}) {
  return {
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.3, centroid: 0.4, flatness: 0.3, crest: 0.3, rolloff: 0.5,
    width: 0.4, pan: 0, novelty: 0.2, beatPhase: 0, beatConfidence: 0.5, bpm: 120,
    sectionId: 0, sectionChanged: false, sectionReturn: -1,
    bands: new Array(24).fill(0.2), onsets: [],
    ...over,
  };
}

function settle(d, frameOver, n = 240) {
  let c;
  for (let i = 0; i < n; i++) c = d.update(mockFrame(frameOver), 16.7);
  return c;
}

function valid(c) {
  return !!(c && c.zoom && c.decay && c.waveform && c.mirrorMix &&
    typeof c.spinFromSection === 'boolean' && c.palette &&
    Array.isArray(c.palette.accent));
}

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const d = createDirector({ songId: 'unit-test', enabled: true, drift: 0, rotateMs: 0 });

// Section 0 — calm intro.
d.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.08, novelty: 0.1 }), 16.7);
const c0 = settle(d, { sectionId: 0, energy: 0.08 });
log.push(`c0 archetype=${c0?.archetype} valid=${valid(c0)}`);
if (!valid(c0)) fail('c0 invalid');

// Section 1 — peak/drop.
d.update(mockFrame({ sectionChanged: true, sectionId: 1, energy: 0.85, novelty: 0.6 }), 16.7);
const c1 = settle(d, { sectionId: 1, energy: 0.85 });
log.push(`c1 archetype=${c1?.archetype} valid=${valid(c1)}`);
if (!valid(c1)) fail('c1 invalid');

const distinct = JSON.stringify(c0) !== JSON.stringify(c1);
log.push(`c0 != c1 (sections get distinct looks): ${distinct}`);
if (!distinct) fail('sections produced identical looks');

// Section 2 returns to section 0 → should recall c0's look (chorus rhymes).
d.update(mockFrame({ sectionChanged: true, sectionId: 2, sectionReturn: 0, energy: 0.1 }), 16.7);
const cr = settle(d, { sectionId: 2, energy: 0.1 });
const recalled = JSON.stringify(cr?.zoom) === JSON.stringify(c0?.zoom) &&
  JSON.stringify(cr?.palette) === JSON.stringify(c0?.palette);
log.push(`recall on section return == c0: ${recalled}`);
if (!recalled) fail('section return did not recall earlier look');

// Disabled → passthrough of explicitly set config.
d.setEnabled(false);
d.setCurrent(c1);
const cp = d.update(mockFrame({ sectionChanged: true, sectionId: 3, energy: 0.9 }), 16.7);
const passthrough = JSON.stringify(cp?.zoom) === JSON.stringify(c1?.zoom);
log.push(`disabled passthrough keeps set config: ${passthrough}`);
if (!passthrough) fail('disabled director did not passthrough');

// --- timer rotation: with no section changes, the look still rotates ---
{
  const dr = createDirector({ songId: 'rotate-test', enabled: true, rotateMs: 20000, drift: 0 });
  // Opening look.
  dr.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  const opener = settle(dr, { sectionId: 0, energy: 0.5 }, 120); // ~2s, settle the fade
  const seen = new Set([JSON.stringify(opener)]);
  // Run ~50s of steady frames with NO section change. The timer floor must
  // force fresh looks anyway.
  let t = 0;
  while (t < 50000) {
    const c = dr.update(mockFrame({ sectionId: 0, energy: 0.5, sectionChanged: false }), 16.7);
    seen.add(JSON.stringify(c));
    t += 16.7;
  }
  log.push(`timer rotation produced ${seen.size} distinct configs over 50s`);
  if (seen.size < 3) fail('timer rotation did not change the look without section boundaries');
}

// --- intra-section drift: a held look breathes (on) / is frozen (off) ---
{
  // Drift ON: live must change across a held section but stay bounded near target.
  const don = createDirector({ songId: 'drift-on', enabled: true, drift: 0.12, rotateMs: 0 });
  don.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  const settled = settle(don, { sectionId: 0, energy: 0.5 }, 180); // ~3s, finish the fade
  const zoomStart = settled.zoom.base;
  let zoomMax = zoomStart, zoomMin = zoomStart;
  let t = 0;
  while (t < 5000) {
    const c = don.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
    zoomMax = Math.max(zoomMax, c.zoom.base);
    zoomMin = Math.min(zoomMin, c.zoom.base);
    t += 16.7;
  }
  const moved = zoomMax - zoomMin;
  log.push(`drift on: zoom.base moved ${moved.toFixed(4)} over 5s (start ${zoomStart.toFixed(4)})`);
  if (moved <= 1e-4) fail('drift on: held look did not move');
  if (moved > 0.5) fail('drift on: held look moved too far (runaway, not breathing)');

  // Drift OFF: live must be referentially stable frame-to-frame in steady state.
  const doff = createDirector({ songId: 'drift-off', enabled: true, drift: 0, rotateMs: 0 });
  doff.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  settle(doff, { sectionId: 0, energy: 0.5 }, 180);
  const a = doff.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  const b = doff.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  log.push(`drift off: same reference across frames: ${a === b}`);
  if (a !== b) fail('drift off: steady-state config is not referentially stable (GC fast path broken)');
}

const report = log.join('\n') + '\n' + (pass ? '[director-test] PASS' : '[director-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
