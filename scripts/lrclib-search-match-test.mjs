// LRCLIB's /search fallback took arr[0] with no comparison to the track's
// duration or album, then cached whatever it got for 30 days — a
// same-titled but different song could get cached and served for a month.
// pickBestSearchResult is a module-private helper (not exported — it's an
// internal implementation detail of fetchLyrics), so this extracts its
// actual source text and runs it standalone against known fixtures — the
// exact shipped logic, not a reimplementation.
// Run: node scripts/lrclib-search-match-test.mjs
import { transform } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const source = readFileSync(resolve('src/api/lrclib.ts'), 'utf8');
const fnMatch = source.match(/function pickBestSearchResult\([\s\S]*?\n\}/);
const normalizeMatch = source.match(/function normalizeCachePart\([\s\S]*?\n\}/);
const toleranceMatch = source.match(/const DURATION_TOLERANCE_S = \d+;/);

if (!fnMatch) fail('pickBestSearchResult should exist in lrclib.ts');
if (!normalizeMatch) fail('normalizeCachePart (a pickBestSearchResult dependency) should exist in lrclib.ts');
if (!toleranceMatch) fail('DURATION_TOLERANCE_S (a pickBestSearchResult dependency) should exist in lrclib.ts');

if (fnMatch && normalizeMatch && toleranceMatch) {
  const standaloneTs = `${toleranceMatch[0]}\n${normalizeMatch[0]}\n${fnMatch[0]}\nexport { pickBestSearchResult };\n`;
  const { code: standalone } = await transform(standaloneTs, { loader: 'ts', format: 'esm' });
  const standaloneFile = resolve('tmp/pick-best-search-result.mjs');
  writeFileSync(standaloneFile, standalone);
  const { pickBestSearchResult } = await import(pathToFileURL(standaloneFile).href);

  const wrongDuration = { trackName: 'Same Title', artistName: 'A', albumName: 'Wrong Album', duration: 999, plainLyrics: 'wrong song lyrics' };
  const rightDuration = { trackName: 'Same Title', artistName: 'A', albumName: 'Right Album', duration: 213, plainLyrics: 'correct song lyrics' };
  const byDuration = pickBestSearchResult([wrongDuration, rightDuration], { duration: 214 });
  if (byDuration !== rightDuration) {
    fail(`should prefer the result whose duration is close to the requested one (within tolerance), got albumName=${byDuration?.albumName}`);
  }

  const wrongAlbum = { trackName: 'Same Title', artistName: 'A', albumName: 'Some Other Album' };
  const rightAlbum = { trackName: 'Same Title', artistName: 'A', albumName: 'The Real Album' };
  const byAlbum = pickBestSearchResult([wrongAlbum, rightAlbum], { album: 'The Real Album' });
  if (byAlbum !== rightAlbum) {
    fail(`should prefer the result whose album matches when duration isn't decisive, got albumName=${byAlbum?.albumName}`);
  }

  const onlyOption = { trackName: 'Same Title', artistName: 'A' };
  const fallback = pickBestSearchResult([onlyOption], {});
  if (fallback !== onlyOption) fail('with no duration/album to compare, should still fall back to the first result');

  const empty = pickBestSearchResult([], { duration: 200 });
  if (empty !== null) fail('an empty results array should return null');
}

if (!/const result = pickBestSearchResult\(arr, opts\);/.test(source)) {
  fail('fetchLyrics should route the search fallback through pickBestSearchResult, not arr[0]');
}
if (/const result = arr\[0\] \?\? null;/.test(source)) {
  fail('the old blind arr[0] pick should be gone');
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:lrclib-search-match"/.test(packageSource)) fail('package.json should expose the lrclib search match test');

console.log(log.join('\n') + '\n' + (pass ? '[lrclib-search-match-test] PASS' : '[lrclib-search-match-test] FAIL'));
process.exitCode = pass ? 0 : 1;
