// fetchWithHostGuard is the one HTTP boundary every podcast request goes
// through. These checks pin the properties that used to be missing: bodies
// are capped while they stream in (a server that lies about or omits
// Content-Length cannot get 200 MB into memory before the check runs), a
// download that dies leaves no partial file behind, a server that accepts and
// never answers times out, and a hostname whose DNS answer is private is
// refused before anything is dialled.
//
// Like the redirect test, made-up public hostnames are resolved to the local
// server through the test-only lookup override; the guard's own hostname and
// address checks still run on every hop.
//
// Run: node scripts/podcast-http-boundary-test.mjs
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/podcast-http-boundary-test-result.txt');
writeFileSync(RESULT, '[podcast-http-boundary-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/podcasts.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/podcasts-boundary-bundle.mjs'), logLevel: 'silent',
});
const { fetchWithHostGuard } = await import(pathToFileURL(resolve('tmp/podcasts-boundary-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const downloadDir = resolve('tmp/podcast-http-boundary-downloads');
await rm(downloadDir, { recursive: true, force: true });
mkdirSync(downloadDir, { recursive: true });

const CAP = 64 * 1024; // small stand-in for MAX_FEED_BYTES / MAX_EPISODE_BYTES; the mechanism is what's under test
const chunk = Buffer.alloc(8 * 1024, 0x61);
let bytesServed = 0;
const requests = [];

const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/endless-feed') {
    // No Content-Length, keeps streaming until the client goes away.
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    const pump = () => {
      if (res.destroyed || res.writableEnded) return;
      bytesServed += chunk.length;
      if (bytesServed > CAP * 8) { res.end(); return; } // safety valve so a broken client can't hang the test
      res.write(chunk, () => setImmediate(pump));
    };
    pump();
  } else if (req.url === '/endless-episode') {
    // No Content-Length (chunked), well past the cap. A Content-Length that
    // undercounts is harmless here — Node's client stops reading at the
    // declared length — so the dangerous shape is the one that declares nothing.
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    for (let i = 0; i < (CAP / chunk.length) * 3; i += 1) res.write(chunk);
    res.end();
  } else if (req.url === '/never-answers') {
    // Accepts the connection and never sends headers.
  } else if (req.url === '/feed.xml') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' }).end('<rss><channel><title>Fine</title></channel></rss>');
  } else if (req.url === '/episode.mp3') {
    const audio = Buffer.from('a perfectly ordinary episode');
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) }).end(audio);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;
const base = `http://feeds.example.com:${port}`;

const localOverrides = {
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  allowAddress: (address) => address === '127.0.0.1',
};
const guarded = (path, init = {}) => fetchWithHostGuard(`${base}${path}`, { timeoutMs: 10_000, ...init }, localOverrides);

try {
  // 1. A feed with no Content-Length is cut off the moment it passes the cap.
  {
    bytesServed = 0;
    const response = await guarded('/endless-feed');
    try {
      await response.text(CAP);
      fail('an over-cap feed body must be refused');
    } catch (err) {
      if (!/too large/i.test(err.message)) fail(`expected a too-large error for the feed, got: ${err.message}`);
      else log.push(`endless feed refused after the cap: ${err.message}`);
    }
    // The reader stops as soon as one chunk crosses the cap; give the server a
    // beat to notice the closed socket and then check how far it got.
    await new Promise((r) => setTimeout(r, 200));
    if (bytesServed > CAP * 4) fail(`server kept streaming long after the cap (${bytesServed} bytes served for a ${CAP} byte cap)`);
    else log.push(`server stopped at ${bytesServed} bytes for a ${CAP} byte cap`);
  }

  // 2. A download with no Content-Length is refused while streaming, and the
  //    partial file is removed.
  {
    const dest = join(downloadDir, 'endless.mp3.part');
    const response = await guarded('/endless-episode');
    if (response.headers.get('content-length') !== null) fail('test server should not advertise a Content-Length');
    try {
      await response.saveToFile(dest, CAP);
      fail('an over-cap episode body must be refused');
    } catch (err) {
      if (!/too large/i.test(err.message)) fail(`expected a too-large error for the episode, got: ${err.message}`);
      else log.push(`endless episode refused: ${err.message}`);
    }
    if (existsSync(dest)) fail('a refused download must not leave its partial file behind');
    const strays = readdirSync(downloadDir);
    if (strays.length) fail(`download dir should be empty after a refused download, found ${strays.join(', ')}`);
    else log.push('no partial file left after the refused download');
  }

  // 3. A server that accepts the connection and never answers times out.
  {
    const started = Date.now();
    try {
      await guarded('/never-answers', { connectTimeoutMs: 400, timeoutMs: 5000 });
      fail('a server that never answers must time out');
    } catch (err) {
      const elapsed = Date.now() - started;
      if (!/timed out|too long/i.test(err.message)) fail(`expected a timeout error, got: ${err.message}`);
      else if (elapsed > 3000) fail(`timeout took ${elapsed} ms for a 400 ms connect timeout`);
      else log.push(`silent server timed out in ${elapsed} ms: ${err.message}`);
    }
  }

  // 4. A public-looking hostname whose DNS answer is private is refused before
  //    anything is dialled.
  {
    const before = requests.length;
    try {
      await fetchWithHostGuard(`http://feeds.example.com:${port}/feed.xml`, { timeoutMs: 5000 }, {
        lookup: async () => [{ address: '10.0.0.7', family: 4 }],
      });
      fail('a hostname resolving to a private address must be refused');
    } catch (err) {
      if (!/not allowed/i.test(err.message)) fail(`expected a host-not-allowed error, got: ${err.message}`);
      else log.push(`private DNS answer refused: ${err.message}`);
    }
    if (requests.length !== before) fail('the private-resolving host must never be requested');
    // Mixed answers count too: one private address among public ones is enough to refuse.
    try {
      await fetchWithHostGuard(`http://feeds.example.com:${port}/feed.xml`, { timeoutMs: 5000 }, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }],
      });
      fail('a DNS answer set containing a mapped loopback address must be refused');
    } catch (err) {
      if (!/not allowed/i.test(err.message)) fail(`expected a host-not-allowed error for the mixed answer, got: ${err.message}`);
      else log.push('mixed public/private DNS answer refused');
    }
  }

  // 5. Ordinary requests still work end to end.
  {
    const feed = await guarded('/feed.xml');
    const xml = await feed.text(CAP);
    if (!xml.includes('<title>Fine</title>')) fail('a normal feed should read back intact');
    else log.push('normal feed read intact');

    const dest = join(downloadDir, 'episode.mp3.part');
    const episode = await guarded('/episode.mp3');
    const written = await episode.saveToFile(dest, CAP);
    const onDisk = await readFile(dest);
    if (written !== onDisk.length || String(onDisk) !== 'a perfectly ordinary episode') fail('a normal download should land intact');
    else log.push(`normal download landed intact (${written} bytes)`);
  }
} finally {
  server.closeAllConnections?.();
  server.close();
  await rm(downloadDir, { recursive: true, force: true });
}

const report = log.join('\n') + '\n' + (pass ? '[podcast-http-boundary-test] PASS' : '[podcast-http-boundary-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
