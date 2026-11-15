// Covers the music-server stream proxy's recovery from stalled and dropped bodies, same-server
// redirects, the empty-search browse fallback, and readable TLS/network error causes.
// Run: node scripts/music-servers-resume-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/music-servers-resume-test-result.txt');
await build({
  entryPoints: [resolve('electron/music-servers.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: resolve('tmp/music-servers-resume-bundle.mjs'),
  logLevel: 'silent',
});
const { MusicServerRegistry, browseMusicServerSongs, testMusicServerConnection } = await import(
  pathToFileURL(resolve('tmp/music-servers-resume-bundle.mjs')).href
);

const log = [];
let pass = true;
const fail = (message) => {
  pass = false;
  log.push('FAIL: ' + message);
};

const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const hits = {};
const ranges = [];
let port = 0;

function sendRange(req, res, mode) {
  const range = /^bytes=(\d+)-(\d+)?$/.exec(String(req.headers.range ?? ''));
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Number(range[2]) : bytes.length - 1;
  if (range) ranges.push(String(req.headers.range));
  const body = bytes.subarray(start, end + 1);
  const ignoresRange = mode === 'ignore' && start > 0;
  const headers = {
    'content-type': 'audio/mpeg',
    'content-length': String(ignoresRange ? bytes.length : body.length),
    'accept-ranges': 'bytes',
    etag: '"stable"',
  };
  if (range && !ignoresRange) headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
  res.writeHead(range && !ignoresRange ? 206 : 200, headers);
  if (ignoresRange) {
    // A server that ignores Range and answers 200 again cannot be spliced.
    res.end(bytes);
    return;
  }
  if (mode === 'drop' && start === 0) {
    res.write(body.subarray(0, 10));
    setTimeout(() => res.socket.destroy(), 20);
    return;
  }
  if (mode === 'stall' && start === 0) {
    res.write(body.subarray(0, 12));
    return;
  }
  if (mode === 'ignore' && start === 0) {
    res.write(body.subarray(0, 8));
    setTimeout(() => res.socket.destroy(), 20);
    return;
  }
  if (mode === 'flaky' && start < 24) {
    // Every attempt delivers a little and then loses the connection, four times in a row.
    res.write(body.subarray(0, 8));
    setTimeout(() => res.socket.destroy(), 20);
    return;
  }
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, headers, body) => res.writeHead(status, headers).end(body);
  const jsonOk = (payload) => send(200, { 'content-type': 'application/json' }, JSON.stringify({ 'subsonic-response': { status: 'ok', ...payload } }));

  const itemMatch = /^\/jf\/Audio\/([a-z]+)\/stream$/.exec(url.pathname);
  if (itemMatch) {
    const mode = itemMatch[1];
    sendRange(req, res, mode);
    return;
  }
  if (url.pathname === '/redirect/Audio/plain/stream') {
    send(301, { location: `http://127.0.0.1:${port}/redirect/Audio/plain/stream/?static=true` });
    return;
  }
  if (url.pathname === '/redirect/Audio/plain/stream/') {
    sendRange(req, res, 'plain');
    return;
  }
  if (url.pathname === '/elsewhere/Audio/plain/stream') {
    send(301, { location: 'https://music.example.net/Audio/plain/stream?api_key=secret-token' });
    return;
  }
  if (url.pathname === '/browse/rest/search3.view') {
    jsonOk({ searchResult3: {} });
    return;
  }
  if (url.pathname === '/browse/rest/getAlbumList2.view') {
    const offset = Number(url.searchParams.get('offset'));
    if (url.searchParams.get('type') !== 'alphabeticalByName') fail('album list should be alphabetical');
    jsonOk({
      albumList2: offset === 0
        ? { album: [{ id: 'a1', songCount: 2 }, { id: 'a2', songCount: 2 }, { id: 'a3', songCount: 1 }] }
        : {},
    });
    return;
  }
  if (url.pathname === '/browse/rest/getAlbum.view') {
    const id = url.searchParams.get('id');
    hits[`album-${id}`] = (hits[`album-${id}`] ?? 0) + 1;
    const songs = { a1: ['s1', 's2'], a2: ['s3', 's4'], a3: ['s5'] }[id] ?? [];
    jsonOk({ album: { id, song: songs.map((songId) => ({ id: songId, title: songId, suffix: 'mp3' })) } });
    return;
  }
  res.writeHead(404).end('missing');
});
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
port = server.address().port;

const jellyfin = (path) => ({
  id: 'jf-resume',
  provider: 'jellyfin',
  name: 'Test',
  baseUrl: `http://127.0.0.1:${port}/${path}`,
  username: 'u',
  serverName: null,
  serverVersion: null,
  userId: 'user-1',
  serverId: null,
  authenticatedAt: 0,
  secret: { provider: 'jellyfin', username: 'u', accessToken: 'jf-token', userId: 'user-1', serverId: null },
});
const stream = (path, item, init) => new MusicServerRegistry(async () => jellyfin(path))
  .stream(new Request(`newamp://server/jf-resume/${item}/song.mp3`, init), { timeoutMs: 3000, idleTimeoutMs: 400 });

try {
  const plain = await stream('jf', 'plain');
  if ((await plain.text()) !== bytes.toString()) fail('plain stream should pass through');

  const dropped = await stream('jf', 'drop');
  if (dropped.status !== 200) fail(`dropped stream should keep its status, got ${dropped.status}`);
  const droppedText = await dropped.text();
  if (droppedText !== bytes.toString()) fail(`dropped body should be completed by a Range request, got ${JSON.stringify(droppedText)}`);
  if (!ranges.includes(`bytes=10-${bytes.length - 1}`)) fail(`resume should ask for the missing tail, saw ${ranges.join(',')}`);
  log.push('a body cut off mid-song is continued with Range: bytes=<sent>-');

  const stalled = await stream('jf', 'stall', { headers: { Range: 'bytes=0-' } });
  if (stalled.status !== 206) fail(`stalled ranged stream should be 206, got ${stalled.status}`);
  if ((await stalled.text()) !== bytes.toString()) fail('stalled body should be completed after the idle timeout');
  log.push('a stalled body is abandoned after the idle timeout and continued');

  const exhausted = await stream('jf', 'ignore');
  let exhaustedError = null;
  try {
    await exhausted.text();
  } catch (err) {
    exhaustedError = err;
  }
  if (!exhaustedError) fail('a body that cannot be resumed should end in an error, not a short song');
  else if (!/did not resume/.test(String(exhaustedError.message ?? exhaustedError))) fail(`unexpected resume error: ${exhaustedError.message ?? exhaustedError}`);
  log.push('retries are bounded and the stream fails once they are used');

  const flaky = await stream('jf', 'flaky');
  const flakyText = await flaky.text();
  if (flakyText !== bytes.toString()) fail(`separated drops should each be resumed, got ${JSON.stringify(flakyText)}`);
  log.push('the retry limit applies to consecutive failures, not to the whole song');

  const redirected = await stream('redirect', 'plain');
  if (redirected.status !== 200 || (await redirected.text()) !== bytes.toString()) fail('trailing-slash redirect should be followed');
  log.push('a same-endpoint redirect is followed');

  const elsewhere = await stream('elsewhere', 'plain');
  const elsewhereText = await elsewhere.text();
  if (elsewhere.status !== 502) fail(`cross-host redirect should fail with 502, got ${elsewhere.status}`);
  if (!elsewhereText.includes('https://music.example.net')) fail(`redirect error should name the target origin: ${elsewhereText}`);
  if (/secret-token|api_key/.test(elsewhereText)) fail('redirect error must not echo the Location query');
  log.push('a cross-host redirect names the new origin and leaks nothing');

  const browse = await browseMusicServerSongs({
    id: 'sub-browse',
    provider: 'subsonic',
    name: 'Browse',
    baseUrl: `http://127.0.0.1:${port}/browse`,
    username: 'u',
    serverName: null,
    serverVersion: null,
    userId: null,
    serverId: null,
    authenticatedAt: 0,
    secret: { provider: 'subsonic', username: 'u', password: 'p' },
  }, { offset: 1, limit: 3 }, { timeoutMs: 3000 });
  const ids = browse.songs.map((song) => song.itemId).join(',');
  if (ids !== 's2,s3,s4') fail(`empty search should fall back to album paging, got ${ids}`);
  if (hits['album-a1'] !== 1 || hits['album-a3']) fail('fallback should fetch only the albums it needs');
  if (browse.nextOffset !== 4) fail(`fallback page should offer the next offset, got ${browse.nextOffset}`);
  log.push('an empty search3 falls back to getAlbumList2 + getAlbum with song offsets');

  const closedPort = await new Promise((resolvePromise) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: freed } = probe.address();
      probe.close(() => resolvePromise(freed));
    });
  });
  try {
    await testMusicServerConnection({
      provider: 'subsonic',
      baseUrl: `https://127.0.0.1:${closedPort}`,
      username: 'u',
      password: 'p',
    }, { timeoutMs: 2000 });
    fail('connection to a closed port should fail');
  } catch (err) {
    if (!/ECONNREFUSED/.test(err.message)) fail(`network failure should carry its cause, got ${err.message}`);
  }
  log.push('"fetch failed" carries the underlying cause');
} catch (err) {
  fail('threw: ' + (err?.stack || err));
} finally {
  server.closeAllConnections?.();
  server.close();
}

writeFileSync(RESULT, log.join('\n') + '\n' + (pass ? 'PASS' : 'FAILED') + '\n');
console.log(log.join('\n'));
console.log(pass ? 'PASS' : 'FAILED');
process.exit(pass ? 0 : 1);
