// artistFacts.ts (up to ~60 sequential Wikipedia requests per unknown
// artist) and albumFacts.ts (up to ~16, plus a fallback into the artist
// chain) had no negative caching — an artist/album that will never be found
// re-ran the full serial lookup chain on every track change, every time.
// This mocks fetch (always "no results") and a real-shaped localStorage,
// calls each fetch function twice for the same never-found name, and
// asserts the SECOND call makes zero network requests.
// Run: node scripts/fact-negative-cache-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });

class MemoryStorage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, v); }
  removeItem(k) { this.data.delete(k); }
  clear() { this.data.clear(); }
}
globalThis.localStorage = new MemoryStorage();

let fetchCallCount = 0;
globalThis.fetch = async () => {
  fetchCallCount++;
  return { ok: true, json: async () => ({ query: { pages: {} } }) };
};

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

async function bundle(entry, outfile) {
  await build({
    entryPoints: [resolve(entry)],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve(outfile), logLevel: 'silent',
    alias: { '@shared': resolve('shared') },
  });
  return import(pathToFileURL(resolve(outfile)).href);
}

// --- artistFacts.ts ---
{
  const { fetchArtistFacts } = await bundle('src/api/artistFacts.ts', 'tmp/artist-facts-bundle.mjs');
  fetchCallCount = 0;
  const first = await fetchArtistFacts('Definitely Not A Real Artist Xyzzy123');
  const firstCallCount = fetchCallCount;
  log.push(`artistFacts: first lookup made ${firstCallCount} fetch call(s), result=${first}`);
  if (firstCallCount === 0) fail('test setup: the first lookup should have made at least one fetch call');
  if (first !== null) fail('an unfindable artist should resolve to null');

  fetchCallCount = 0;
  const second = await fetchArtistFacts('Definitely Not A Real Artist Xyzzy123');
  log.push(`artistFacts: second lookup made ${fetchCallCount} fetch call(s), result=${second}`);
  if (fetchCallCount !== 0) fail(`the second lookup for the same never-found artist should be served entirely from the negative cache (0 fetch calls), got ${fetchCallCount}`);
  if (second !== null) fail('the negative-cached result should still resolve to null');
}

// --- albumFacts.ts ---
{
  const { fetchAlbumFacts } = await bundle('src/api/albumFacts.ts', 'tmp/album-facts-bundle.mjs');
  fetchCallCount = 0;
  const first = await fetchAlbumFacts('Definitely Not A Real Album Xyzzy123', 'Some Artist');
  const firstCallCount = fetchCallCount;
  log.push(`albumFacts: first lookup made ${firstCallCount} fetch call(s), result=${first}`);
  if (firstCallCount === 0) fail('test setup: the first album lookup should have made at least one fetch call');

  fetchCallCount = 0;
  const second = await fetchAlbumFacts('Definitely Not A Real Album Xyzzy123', 'Some Artist');
  log.push(`albumFacts: second lookup made ${fetchCallCount} fetch call(s), result=${second}`);
  if (fetchCallCount !== 0) fail(`the second lookup for the same never-found album should be served entirely from the negative cache (0 fetch calls), got ${fetchCallCount}`);
}

// --- An outage must NOT be recorded as a confirmed miss. Every candidate comes
// back empty when Wikipedia is down, rate-limiting, or unreachable, which looks
// exactly like "not found" unless the code tracks whether a request actually
// landed. Caching that would hide real facts until the entry expired. ---
{
  const { fetchArtistFacts } = await bundle('src/api/artistFacts.ts', 'tmp/artist-facts-outage-bundle.mjs');
  localStorage.clear();

  fetchCallCount = 0;
  globalThis.fetch = async () => {
    fetchCallCount += 1;
    throw new Error('network down');
  };
  const during = await fetchArtistFacts('Outage Test Artist');
  log.push(`artistFacts: during outage made ${fetchCallCount} fetch call(s), result=${during}`);
  if (during !== null) fail('an outage should still resolve to null for the caller');
  if (fetchCallCount === 0) fail('test setup: the outage case should have attempted at least one request');

  // Connectivity returns. The next lookup must retry rather than serve a
  // "miss" that was only ever an outage.
  fetchCallCount = 0;
  globalThis.fetch = async () => {
    fetchCallCount += 1;
    return { ok: true, json: async () => ({ query: { pages: {} } }) };
  };
  await fetchArtistFacts('Outage Test Artist');
  log.push(`artistFacts: after recovery made ${fetchCallCount} fetch call(s)`);
  if (fetchCallCount === 0) {
    fail('a lookup after an outage must retry, not read a negative-cache entry written during the outage');
  }

  // A genuine miss (server answered, no pages) must still be negative-cached.
  localStorage.clear();
  fetchCallCount = 0;
  await fetchArtistFacts('Genuinely Absent Artist Xyzzy');
  const firstMiss = fetchCallCount;
  fetchCallCount = 0;
  await fetchArtistFacts('Genuinely Absent Artist Xyzzy');
  log.push(`artistFacts: genuine miss cached (${firstMiss} calls, then ${fetchCallCount})`);
  if (firstMiss === 0) fail('test setup: the genuine-miss lookup should have made requests');
  if (fetchCallCount !== 0) fail('a genuine miss must still be negative-cached');
}

// --- Source assertions ---
const artistSource = readFileSync(resolve('src/api/artistFacts.ts'), 'utf8');
const albumSource = readFileSync(resolve('src/api/albumFacts.ts'), 'utf8');
for (const [name, source] of [['artistFacts.ts', artistSource], ['albumFacts.ts', albumSource]]) {
  if (!/NEGATIVE_CACHE_TTL_MS/.test(source)) fail(`${name} should define a negative-cache TTL`);
  if (!/fact: \w+ \| null/.test(source)) fail(`${name}'s cache entry type should allow a null fact (negative cache marker)`);
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:fact-negative-cache"/.test(packageSource)) fail('package.json should expose the fact negative-cache test');

console.log(log.join('\n') + '\n' + (pass ? '[fact-negative-cache-test] PASS' : '[fact-negative-cache-test] FAIL'));
process.exitCode = pass ? 0 : 1;
