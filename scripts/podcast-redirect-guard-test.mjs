// Unit test for fetchWithHostGuard's redirect handling: every hop must be
// re-validated against the host guard, not just the URL a caller passed in,
// and a redirect loop must be capped rather than followed forever.
//
// The guard blocks loopback, so a plain local server can't stand in for "an
// attacker-controlled public feed". Instead the test uses fetchWithHostGuard's
// test-only overrides: `lookup` resolves made-up public hostnames to the local
// server's address and `allowAddress` vouches for that one loopback answer, so
// http://feeds.example.com:<port>/ really dials the local server. A redirect
// to a genuinely private literal (169.254.169.254) still has to be refused by
// the hostname check before any lookup runs, which is what case 1 proves.
//
// Run: node scripts/podcast-redirect-guard-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

// One local server plays every "public" host; the Host header tells it which
// role it is answering for. Requests to the private redirect target must
// never arrive here (or anywhere) — the guard has to refuse them first.
const seen = [];
const server = createServer((req, res) => {
  const host = String(req.headers.host ?? '').split(':')[0];
  seen.push(`${host}${req.url}`);
  if (host === 'feeds.example.com' && req.url === '/show.xml') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
  } else if (host === 'feeds.example.com' && req.url === '/moved.xml') {
    res.writeHead(301, { location: `http://cdn.example.net:${port}/show-final.xml` }).end();
  } else if (host === 'cdn.example.net' && req.url === '/show-final.xml') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' }).end('<rss><channel><title>OK</title></channel></rss>');
  } else if (host === 'loops.example.com') {
    res.writeHead(302, { location: `http://loops.example.com:${port}/next` }).end();
  } else {
    res.writeHead(404).end();
  }
});
let port = 0;
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
port = server.address().port;

// Resolves the made-up public hostnames to the local server; the guard's
// per-hop hostname and address validation runs before this lookup is used.
const overrides = {
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  allowAddress: (address) => address === '127.0.0.1',
};
const fetchViaLocal = (url) => fetchWithHostGuard(url, { timeoutMs: 5000 }, overrides);

try {
  // 1. A redirect to a private/link-local address must be rejected before the
  //    blocked hop is ever fetched.
  try {
    await fetchViaLocal(`http://feeds.example.com:${port}/show.xml`);
    fail('a redirect to a private address must throw, not resolve');
  } catch (err) {
    if (!/not allowed/i.test(err.message)) fail(`expected a host-not-allowed error, got: ${err.message}`);
    else log.push(`redirect to private address rejected: ${err.message}`);
  }
  if (seen.some((entry) => entry.startsWith('169.254.169.254'))) fail('the private redirect target must never be requested');

  // 2. A redirect to another public host is followed and its body is readable.
  const response = await fetchViaLocal(`http://feeds.example.com:${port}/moved.xml`);
  if (!response.ok) fail(`a redirect to a public host should resolve successfully, got HTTP ${response.status}`);
  const body = await response.text(1024 * 1024);
  if (!body.includes('<title>OK</title>')) fail('final response body should be the redirect target\'s content');
  else log.push('redirect to a public host followed and resolved: ok');

  // 3. A redirect loop is capped, not followed forever.
  const before = seen.length;
  try {
    await fetchViaLocal(`http://loops.example.com:${port}/next`);
    fail('an unbounded redirect loop must eventually throw');
  } catch (err) {
    if (!/too many times/i.test(err.message)) fail(`expected a too-many-redirects error, got: ${err.message}`);
    else log.push(`redirect loop capped after ${seen.length - before} hops: ${err.message}`);
  }
  const hops = seen.length - before;
  if (hops < 2 || hops > 20) fail(`redirect cap should be small and bounded, saw ${hops} hops`);
} finally {
  server.close();
}

const report = log.join('\n') + '\n' + (pass ? '[podcast-redirect-guard-test] PASS' : '[podcast-redirect-guard-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
