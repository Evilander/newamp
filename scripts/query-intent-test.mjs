// Ask Your Library compiler gate: the 10 canonical phrases compile to the
// expected structured constraints, fully offline. The 2.0-plan acceptance
// bar is 8/10 — this asserts all 10 with exact field checks.
// Run with: npm run test:query-intent

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = resolve('tmp', 'query-intent-test');
await mkdir(outDir, { recursive: true });
const outfile = join(outDir, 'query-intent.mjs');
await build({
  entryPoints: [resolve('shared', 'query-intent.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { compileQueryIntent, looksLikeNaturalQuery } = await import(pathToFileURL(outfile).toString());

// Fixed "now": 2026-07-02 12:00 local.
const NOW = new Date(2026, 6, 2, 12, 0, 0).getTime();
const JAN1 = new Date(2026, 0, 1).getTime();
const DAY = 86_400_000;

const cases = [
  {
    text: 'warm slow stuff from the 70s I haven’t played this year',
    check(r) {
      assert.equal(r.rule.minYear, 1970);
      assert.equal(r.rule.maxYear, 1979);
      assert.equal(r.rule.maxBpm, 95);
      assert.equal(r.rule.dnaBrightnessTarget, 0.3);
      assert.equal(r.rule.notPlayedSinceMs, JAN1);
    },
  },
  {
    text: 'loud stuff I have not played in a while',
    check(r) {
      assert.equal(r.rule.dnaEnergyTarget, 0.85);
      assert.ok(Math.abs(r.rule.notPlayedSinceMs - (NOW - 90 * DAY)) < DAY);
    },
  },
  {
    text: 'gentle jazz from the nineties',
    check(r) {
      assert.equal(r.rule.dnaEnergyTarget, 0.18);
      assert.equal(r.rule.minYear, 1990);
      assert.equal(r.rule.searchQuery, 'jazz');
    },
  },
  {
    text: 'fast loved bangers',
    check(r) {
      assert.equal(r.rule.minBpm, 118);
      assert.equal(r.rule.lovedOnly, true);
    },
  },
  {
    text: 'never played songs before 2000',
    check(r) {
      assert.equal(r.rule.unplayedOnly, true);
      assert.equal(r.rule.maxYear, 1999);
    },
  },
  {
    text: 'highly rated dark electronic',
    check(r) {
      assert.equal(r.rule.minRating, 4);
      assert.equal(r.rule.dnaBrightnessTarget, 0.28);
      assert.equal(r.rule.searchQuery, 'electronic');
    },
  },
  {
    text: 'bright upbeat music from 2010 to 2015',
    check(r) {
      assert.equal(r.rule.dnaBrightnessTarget, 0.75);
      assert.equal(r.rule.minBpm, 118);
      assert.equal(r.rule.minYear, 2010);
      assert.equal(r.rule.maxYear, 2015);
    },
  },
  {
    text: 'forgotten favorites',
    check(r) {
      assert.equal(r.rule.lovedOnly, true);
      assert.ok(Math.abs(r.rule.notPlayedSinceMs - (NOW - 180 * DAY)) < DAY);
    },
  },
  {
    text: 'mellow mid-tempo bowie',
    check(r) {
      assert.equal(r.rule.dnaEnergyTarget, 0.18);
      assert.equal(r.rule.minBpm, 90);
      assert.equal(r.rule.maxBpm, 125);
      assert.equal(r.rule.searchQuery, 'bowie');
    },
  },
  {
    text: 'something calm after 2020 rated 5',
    check(r) {
      assert.equal(r.rule.dnaEnergyTarget, 0.18);
      assert.equal(r.rule.minYear, 2021);
      assert.equal(r.rule.minRating, 5);
    },
  },
];

let passed = 0;
for (const c of cases) {
  const result = compileQueryIntent(c.text, NOW);
  try {
    c.check(result);
    assert.ok(result.chips.length >= 1, 'chips must explain the interpretation');
    passed += 1;
  } catch (err) {
    console.error(`FAIL: "${c.text}"`, JSON.stringify(result.rule), '\n ', err.message);
  }
}

// Mode detection: NL vs direct search vs field grammar.
assert.equal(looksLikeNaturalQuery('warm slow stuff from the 70s'), true);
assert.equal(looksLikeNaturalQuery('bowie'), false, 'single word stays a plain search');
assert.equal(looksLikeNaturalQuery('helter skelter'), false, 'two words stay a plain search');
assert.equal(looksLikeNaturalQuery('artist:hella loud fast'), false, 'field grammar bypasses NL');

assert.equal(passed, cases.length, `${passed}/${cases.length} canonical phrases compiled`);
console.log(`[query-intent-test] PASS (${passed}/${cases.length} phrases)`);
