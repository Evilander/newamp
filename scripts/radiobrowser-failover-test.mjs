// radio-browser picked ONE random mirror per call with no retry/fallback and
// no timeout — a down or hung mirror made radio search die silently. This
// mocks globalThis.fetch to simulate failing/hanging mirrors and asserts:
// (1) a request tries every mirror before giving up, (2) it succeeds as
// soon as ANY mirror responds, (3) each mirror request carries a timeout.
// Run: node scripts/radiobrowser-failover-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('src/api/radiobrowser.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/radiobrowser-bundle.mjs'), logLevel: 'silent',
  alias: { '@shared': resolve('shared') },
});
const { searchStations, topTags } = await import(pathToFileURL(resolve('tmp/radiobrowser-bundle.mjs')).href);

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const originalFetch = globalThis.fetch;
function mockFetch(behavior) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const hasTimeoutSignal = init?.signal != null;
    if (!hasTimeoutSignal) fail(`request to ${url} should carry an abort signal (timeout)`);
    const outcome = behavior(url, calls.length);
    if (outcome === 'throw') throw new Error('network error');
    if (outcome === 'error') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => outcome };
  };
  return calls;
}

// --- All 4 mirrors fail: searchStations should reject only after trying
// every distinct mirror, not just one.
{
  const calls = mockFetch(() => 'throw');
  let threw = false;
  try {
    await searchStations({ name: 'jazz' });
  } catch {
    threw = true;
  }
  if (!threw) fail('searchStations should reject when every mirror fails');
  const distinctHosts = new Set(calls.map((u) => new URL(u).host));
  log.push(`all-fail: ${calls.length} attempts across ${distinctHosts.size} distinct hosts`);
  if (distinctHosts.size !== 4) fail(`should have tried all 4 distinct mirrors before giving up, tried ${distinctHosts.size}`);
}

// --- topTags preserves its original "return [] on failure" contract, but
// only after trying every mirror.
{
  const calls = mockFetch(() => 'throw');
  const tags = await topTags(10);
  if (!Array.isArray(tags) || tags.length !== 0) fail('topTags should still resolve to [] when every mirror fails (not throw)');
  const distinctHosts = new Set(calls.map((u) => new URL(u).host));
  if (distinctHosts.size !== 4) fail(`topTags should also try all 4 mirrors before giving up, tried ${distinctHosts.size}`);
}

// --- The first few mirrors fail, a later one succeeds: the request should
// still resolve successfully (real failover, not just "try once and stop").
{
  const stations = [{ stationuuid: 'abc', name: 'Test FM', url_resolved: 'http://x', homepage: '', favicon: '', country: '', language: '', tags: '', bitrate: 128, codec: 'MP3' }];
  const calls = mockFetch((_url, attempt) => (attempt < 3 ? 'throw' : stations));
  const result = await searchStations({ name: 'jazz' });
  if (result.length !== 1 || result[0].id !== 'abc') fail('searchStations should succeed once any mirror responds, even after earlier mirrors failed');
  log.push(`failover-then-success: succeeded on attempt ${calls.length}`);
}

globalThis.fetch = originalFetch;

// --- Source assertions ---
const source = readFileSync(resolve('src/api/radiobrowser.ts'), 'utf8');
if (!/AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/.test(source)) fail('each mirror attempt should carry a timeout via AbortSignal.timeout');
if (!/async function fetchWithFailover/.test(source)) fail('a shared failover helper should exist');
if (!/pushToast\(\{ tone: 'error', title: 'Station search failed'/.test(readFileSync(resolve('src/components/views/RadioView.tsx'), 'utf8'))) {
  fail('RadioView should surface a toast when the whole directory is unreachable, not just show an empty list silently');
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:radiobrowser-failover"/.test(packageSource)) fail('package.json should expose the radiobrowser failover test');

console.log(log.join('\n') + '\n' + (pass ? '[radiobrowser-failover-test] PASS' : '[radiobrowser-failover-test] FAIL'));
process.exitCode = pass ? 0 : 1;
