// Lyrics/album-fact/artist-fact caches wrapped localStorage.setItem in a
// try/catch with an EMPTY catch body and no size accounting, LRU, or
// periodic prune — once localStorage filled up, every future write across
// all three caches failed silently forever with zero diagnostics. This
// tests the shared setItemWithPrune fix against a mock Storage (localStorage
// doesn't exist in Node) that throws QuotaExceededError once full, proving
// it evicts the oldest entries under the given prefix and retries instead
// of just giving up.
// Run: node scripts/localstorage-cache-prune-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('src/lib/wiki.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/wiki-bundle.mjs'), logLevel: 'silent',
});
const { setItemWithPrune } = await import(pathToFileURL(resolve('tmp/wiki-bundle.mjs')).href);

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

class MockStorage {
  constructor(quota) {
    this.data = new Map();
    this.quota = quota;
  }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  removeItem(k) { this.data.delete(k); }
  setItem(k, v) {
    const existing = this.data.get(k)?.length ?? 0;
    const projected = [...this.data.values()].reduce((sum, val) => sum + val.length, 0) - existing + v.length;
    if (projected > this.quota) {
      const err = new Error('exceeded the quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.data.set(k, v);
  }
}

const PREFIX = 'newamp:test-cache:v1:';
const entry = (ts) => JSON.stringify({ cachedAt: ts, result: { plainLyrics: 'x'.repeat(40) } });
const parseTs = (raw) => JSON.parse(raw).cachedAt ?? null;
const ENTRY_SIZE = entry(1000).length;

// Fill storage to exactly fit 10 entries, no more — the 11th write below is
// guaranteed to overflow without pruning.
const storage = new MockStorage(ENTRY_SIZE * 10);
for (let i = 0; i < 10; i++) {
  storage.setItem(`${PREFIX}entry-${i}`, entry(1000 + i));
}
const beforeCount = storage.length;
log.push(`entries before prune: ${beforeCount}`);

// Writing one more entry should exceed the mock quota outright.
let threwWithoutPrune = false;
try {
  storage.setItem(`${PREFIX}entry-new`, entry(9999));
} catch {
  threwWithoutPrune = true;
}
if (!threwWithoutPrune) fail('test setup: the mock storage should be full enough that a raw setItem throws');
storage.removeItem(`${PREFIX}entry-new`); // undo any partial state from the throwing attempt

// setItemWithPrune should recover: evict oldest entries under PREFIX, retry, succeed.
setItemWithPrune(storage, `${PREFIX}entry-new`, entry(9999), PREFIX, parseTs, 3);

if (storage.getItem(`${PREFIX}entry-new`) == null) {
  fail('setItemWithPrune should have succeeded after pruning, but the new entry is missing');
}
// The 3 OLDEST entries (entry-0, entry-1, entry-2 — timestamps 1000-1002)
// should have been evicted; newer ones should survive.
for (const i of [0, 1, 2]) {
  if (storage.getItem(`${PREFIX}entry-${i}`) != null) {
    fail(`entry-${i} (one of the oldest) should have been pruned to make room`);
  }
}
for (const i of [7, 8, 9]) {
  if (storage.getItem(`${PREFIX}entry-${i}`) == null) {
    fail(`entry-${i} (recent) should have survived the prune`);
  }
}
log.push(`entries after prune+write: ${storage.length}`);

// Writing to a totally full storage where pruning still can't make enough
// room must not throw out of setItemWithPrune (best-effort contract).
const tinyStorage = new MockStorage(ENTRY_SIZE);
tinyStorage.setItem(`${PREFIX}a`, entry(1));
let threw = false;
try {
  setItemWithPrune(tinyStorage, `${PREFIX}huge`, 'x'.repeat(1000), PREFIX, parseTs, 5);
} catch {
  threw = true;
}
if (threw) fail('setItemWithPrune should never throw out to the caller, even when pruning cannot free enough room');

// --- Source assertions: all three caches actually call the shared helper.
const [lrclibSource, albumSource, artistSource, packageSource] = [
  readFileSync(resolve('src/api/lrclib.ts'), 'utf8'),
  readFileSync(resolve('src/api/albumFacts.ts'), 'utf8'),
  readFileSync(resolve('src/api/artistFacts.ts'), 'utf8'),
  readFileSync(resolve('package.json'), 'utf8'),
];
for (const [name, source] of [['lrclib.ts', lrclibSource], ['albumFacts.ts', albumSource], ['artistFacts.ts', artistSource]]) {
  if (!/setItemWithPrune\(/.test(source)) fail(`${name} should write its cache through setItemWithPrune`);
}
if (!/"test:localstorage-cache-prune"/.test(packageSource)) fail('package.json should expose the localStorage cache prune test');

console.log(log.join('\n') + '\n' + (pass ? '[cache-prune-test] PASS' : '[cache-prune-test] FAIL'));
process.exitCode = pass ? 0 : 1;
