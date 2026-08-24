// Unit test for fetchWithHostGuard (SSRF guard: redirects must be
// re-validated per hop, not just the initial URL). Mirrors
// scripts/podcast-host-guard-test.mjs's esbuild harness.
//
// Bug: isBlockedPodcastHost was only applied to the URL passed into
// fetch(); Node's fetch follows redirects by default and never re-checks
// the Location header, so a feed hosted at an innocuous public URL could
// 302 to 127.0.0.1 or the cloud metadata endpoint and the guard would never
// see it. Stubs the global fetch so this runs with no real network access:
// a real HTTP server can't stand in for "an attacker-controlled public feed
// that redirects to a private address" in a sandboxed test, since the test
// server itself would have to run on a loopback address that the guard
// would (correctly) already block before any redirect logic runs.
//
// Run: node scripts/podcast-redirect-guard-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/podcast-redirect-guard-test-result.txt');
writeFileSync(RESULT, '[podcast-redirect-guard-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/podcasts.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/podcasts-redirect-bundle.mjs'), logLevel: 'silent',
});
const { fetchWithHostGuard } = await import(pathToFileURL(resolve('tmp/podcasts-redirect-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

function fakeResponse({ status = 200, location = null, body = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
    text: async () => body,
  };
}

const realFetch = globalThis.fetch;
function withMockFetch(mockFn, run) {
  globalThis.fetch = mockFn;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = realFetch; });
}

// 1. A redirect to a private/loopback address must be rejected — and the
//    blocked hop must never actually be fetched (proves the check runs
//    BEFORE the request, not just that the final result looks wrong).
await withMockFetch(
  async (url) => {
    const target = String(url);
    if (target === 'https://feeds.example.com/show.xml') {
      return fakeResponse({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' });
    }
    fail(`must never fetch the redirect target directly: ${target}`);
    return fakeResponse({ status: 200, body: 'should not be reached' });
  },
  async () => {
    try {
      await fetchWithHostGuard('https://feeds.example.com/show.xml');
      fail('a redirect to a private address must throw, not resolve');
    } catch (err) {
      if (!/not allowed/i.test(err.message)) fail(`expected a host-not-allowed error, got: ${err.message}`);
      else log.push(`redirect to private address rejected: ${err.message}`);
    }
  },
);

// 2. A redirect to another public host must be followed and succeed.
await withMockFetch(
  async (url) => {
    const target = String(url);
    if (target === 'https://feeds.example.com/moved.xml') {
      return fakeResponse({ status: 301, location: 'https://cdn.example.net/show-final.xml' });
    }
    if (target === 'https://cdn.example.net/show-final.xml') {
      return fakeResponse({ status: 200, body: '<rss><channel><title>OK</title></channel></rss>' });
    }
    throw new Error(`unexpected fetch target: ${target}`);
  },
  async () => {
    const response = await fetchWithHostGuard('https://feeds.example.com/moved.xml');
    if (!response.ok) fail('a redirect to a public host should resolve successfully');
    const body = await response.text();
    if (!body.includes('<title>OK</title>')) fail('final response body should be the redirect target\'s content');
    else log.push('redirect to a public host followed and resolved: ok');
  },
);

// 3. A redirect loop must be capped, not followed forever / hang.
let hopCount = 0;
await withMockFetch(
  async () => {
    hopCount += 1;
    if (hopCount > 50) throw new Error('redirect loop was not capped — test aborting');
    return fakeResponse({ status: 302, location: 'https://loops.example.com/next' });
  },
  async () => {
    try {
      await fetchWithHostGuard('https://loops.example.com/next');
      fail('an unbounded redirect loop must eventually throw');
    } catch (err) {
      if (!/too many times/i.test(err.message)) fail(`expected a too-many-redirects error, got: ${err.message}`);
      else log.push(`redirect loop capped after ${hopCount} hops: ${err.message}`);
    }
  },
);
if (hopCount < 2 || hopCount > 20) fail(`redirect cap should be small and bounded, saw ${hopCount} hops`);

const report = log.join('\n') + '\n' + (pass ? '[podcast-redirect-guard-test] PASS' : '[podcast-redirect-guard-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
