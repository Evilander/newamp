// Runtime unit test for the Eviland Auto-Pilot frame-budget governor
// (no GPU, no timers). Bundles eviland-governor.ts for Node, drives it with
// synthetic frame-cost streams, and asserts the step-down/step-up ladder,
// hysteresis, and cooldown behavior are exactly as designed.
// Run: node scripts/eviland-governor-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/governor-test-result.txt');
writeFileSync(RESULT, '[governor-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-governor.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/governor-bundle.mjs'), logLevel: 'silent',
});
const { createGovernor } = await import(pathToFileURL(resolve('tmp/governor-bundle.mjs')).href);

let failures = 0;
function check(name, cond, detail = '') {
  const line = `${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  writeFileSync(RESULT, line + '\n', { flag: 'a' });
  if (!cond) failures += 1;
}

// Drive `gov` with painted frames of constant `costMs` for `seconds` of
// simulated time at a 33.3ms cadence, starting at `t0`. Returns the
// timestamp after the run.
function run(gov, t0, seconds, costMs, stepMs = 33.3) {
  const frames = Math.round((seconds * 1000) / stepMs);
  let t = t0;
  for (let i = 0; i < frames; i += 1) {
    t += stepMs;
    gov.endFrame(t, costMs);
  }
  return t;
}

// ── 1. Cruise: comfortable frames never step down ─────────────────────────
{
  const gov = createGovernor({ costBudgetMs: 8 });
  run(gov, 0, 30, 4); // 30s of 4ms frames
  const s = gov.snapshot();
  check('cruise holds full quality', s.level === 0 && s.scale === 1 && s.verdict === 'cruise',
    `level=${s.level} scale=${s.scale}`);
}

// ── 2. Sustained pain steps down (after dwell, not instantly) ─────────────
{
  const gov = createGovernor({ costBudgetMs: 8, downDwellMs: 1500, stepCooldownMs: 3000 });
  let t = run(gov, 0, 0.7, 14); // ~0.7s over budget: dwell not met yet
  check('no step before dwell', gov.snapshot().level === 0, `level=${gov.snapshot().level}`);
  t = run(gov, t, 1.5, 14); // past 1.5s total
  const s = gov.snapshot();
  check('steps down after sustained over-budget', s.level === 1 && s.scale === 0.85,
    `level=${s.level} scale=${s.scale}`);
  check('verdict reads trimming', s.verdict === 'trimming', s.verdict);
}

// ── 3. Cooldown prevents step stacking; floor is reached under lasting pain ─
{
  const gov = createGovernor({ costBudgetMs: 8, downDwellMs: 1500, stepCooldownMs: 3000 });
  run(gov, 0, 60, 20); // a full minute of heavy frames
  const s = gov.snapshot();
  check('reaches the floor level', s.verdict === 'floor', `level=${s.level}`);
  check('floor trims fps too', s.intervalMul > 1, `intervalMul=${s.intervalMul}`);
  check('intervalMs stretches base cadence', gov.intervalMs(33.3) > 33.3,
    `intervalMs=${gov.intervalMs(33.3).toFixed(1)}`);
  // Steps are rate-limited: 4 ladder steps need >= 3 cooldowns + dwells; in
  // 60s that's fine, but the count must be exactly the ladder depth, not
  // one per frame.
  check('steps are discrete and rate-limited', s.steps === 4, `steps=${s.steps}`);
}

// ── 4. Recovery: headroom steps back up, slowly ────────────────────────────
{
  const gov = createGovernor({ costBudgetMs: 8, downDwellMs: 1500, upDwellMs: 10_000, stepCooldownMs: 3000 });
  let t = run(gov, 0, 10, 20); // 10s heavy → some steps down
  const trimmed = gov.snapshot().level;
  check('trimmed under load', trimmed >= 1, `level=${trimmed}`);
  t = run(gov, t, 8, 3); // 8s of cheap frames: below upDwell
  check('no premature step up', gov.snapshot().level === trimmed,
    `level=${gov.snapshot().level}`);
  t = run(gov, t, 60, 3); // a minute of proven headroom
  const s = gov.snapshot();
  check('recovers to full quality with headroom', s.level === 0 && s.scale === 1,
    `level=${s.level}`);
}

// ── 5. Hover at budget: no oscillation ─────────────────────────────────────
{
  const gov = createGovernor({ costBudgetMs: 8 });
  run(gov, 0, 10, 20); // trim down
  const trimmed = gov.snapshot().level;
  const before = gov.snapshot().steps;
  // 60s hovering between the up threshold (4.8) and budget (8): the
  // comfortable middle must hold the level steady in both directions.
  run(gov, 60_000, 60, 6);
  const s = gov.snapshot();
  check('no sawtooth in the comfortable middle', s.level === trimmed && s.steps === before,
    `level=${s.level} steps=${s.steps} (was ${before})`);
}

// ── 6. Reset restores full quality immediately ─────────────────────────────
{
  const gov = createGovernor({ costBudgetMs: 8 });
  run(gov, 0, 30, 20);
  gov.reset();
  const s = gov.snapshot();
  check('reset returns to level 0', s.level === 0 && s.scale === 1, `level=${s.level}`);
}

// ── 7. A paint gap (pause/hidden window) breaks the dwell chain ────────────
{
  const gov = createGovernor({ costBudgetMs: 8, downDwellMs: 1500 });
  let t = run(gov, 0, 1.4, 14); // over budget, just under dwell
  t = run(gov, t + 300_000, 0.4, 14); // 5-min pause, brief over-budget resume
  const s = gov.snapshot();
  check('paint gap breaks the dwell chain', s.level === 0,
    `level=${s.level} steps=${s.steps}`);
}

// ── 8. Garbage input is ignored ────────────────────────────────────────────
{
  const gov = createGovernor({ costBudgetMs: 8 });
  gov.endFrame(16, NaN);
  gov.endFrame(33, -5);
  gov.endFrame(50, Infinity);
  const s = gov.snapshot();
  check('non-finite/negative costs ignored', s.level === 0 && s.costMs === 0,
    `costMs=${s.costMs}`);
}

const verdict = failures === 0 ? '[governor-test] ALL PASS' : `[governor-test] ${failures} FAILURE(S)`;
console.log(verdict);
writeFileSync(RESULT, verdict + '\n', { flag: 'a' });
if (failures > 0) process.exitCode = 1;
