// NewAmp Remote gate: boots the real RadioBrain server (built output) against
// a stub library and proves the security + remote contract:
//   1. every data route 401s without the token (header or query),
//   2. /remote serves the pairing shell unauthenticated (it carries no data),
//   3. /now round-trips pushed playback state,
//   4. /now/events (SSE) emits the initial snapshot AND live updates,
//   5. POST /control validates the whitelist and forwards commands,
//   6. M3U entries carry the token so external players keep working,
//   7. /audio honors HTTP Range with a real 206 + Content-Range.
// Run with: npm run smoke:remote  (requires build:electron)

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const smokeRoot = resolve('tmp', 'remote-smoke');
const hardTimeout = setTimeout(() => {
  console.error('[remote-smoke] FAILED: timed out');
  process.exit(1);
}, 60000);

const { RadioBrain } = await import(
  pathToFileURL(resolve('dist-electron', 'electron', 'radio-brain.js')).toString()
);

await mkdir(smokeRoot, { recursive: true });
const fakeAudioPath = join(smokeRoot, 'tone.mp3');
await writeFile(fakeAudioPath, Buffer.alloc(4096, 7)); // 4KB of sevens

const TOKEN = 'smoke-token-123';
const controls = [];
let nowState = null;
const nowSubscribers = new Set();

const library = {
  getStats: () => ({ tracks: 1, albums: 1, artists: 1, duration: 180 }),
  getTagSummaries: () => [],
  getTrackIds: () => [42],
  getTrackIdsByTag: () => [],
  getTracksByIdsInOrder: () => [
    { id: 42, title: 'Tone', artist: 'Smoke', duration: 3, path: fakeAudioPath },
  ],
  getTrack: (id) =>
    id === 42 ? { id: 42, title: 'Tone', artist: 'Smoke', duration: 3, path: fakeAudioPath } : null,
  getArt: () => null,
};

const brain = new RadioBrain({
  library,
  port: 17293,
  transcode: () => new Response('nope', { status: 500 }),
  ffmpegFallbackExt: () => false,
  getToken: () => TOKEN,
  getNowPlaying: () => nowState,
  onNowPlaying: (cb) => {
    nowSubscribers.add(cb);
    return () => nowSubscribers.delete(cb);
  },
  control: (cmd, arg) => {
    controls.push({ cmd, arg });
    return true;
  },
});

const status = await brain.start();
assert.equal(status.enabled, true, `server must start: ${status.error}`);
assert.ok(status.remoteUrl?.includes('/remote#'), 'status must expose the pairing URL');
const base = `http://127.0.0.1:17293`;

// 1. Unauthorized everywhere.
for (const path of ['/', '/now', '/library.m3u', '/audio/42', '/art/42']) {
  const res = await fetch(base + path);
  assert.equal(res.status, 401, `${path} without token should 401, got ${res.status}`);
}
const badControl = await fetch(`${base}/control`, { method: 'POST', body: '{"cmd":"togglePlay"}' });
assert.equal(badControl.status, 401, 'control without token should 401');

// 2. Remote shell is public but data-free.
const shell = await fetch(`${base}/remote`);
assert.equal(shell.status, 200);
const shellHtml = await shell.text();
assert.match(shellHtml, /NEWAMP REMOTE/, 'remote shell should render');
assert.ok(!shellHtml.includes(TOKEN), 'remote shell must not embed the token');

// 3. /now with token (header + query both work).
const auth = { headers: { 'x-newamp-token': TOKEN } };
assert.equal((await (await fetch(`${base}/now`, auth)).json()), null, 'no state yet → null');
nowState = {
  trackId: 42, title: 'Tone', artist: 'Smoke', album: 'Test', isPlaying: true,
  position: 12.5, duration: 180, volume: 0.8, at: 1700000000000,
};
const nowRes = await (await fetch(`${base}/now?token=${TOKEN}`)).json();
assert.equal(nowRes.title, 'Tone');
assert.equal(nowRes.isPlaying, true);

// 4. SSE: initial snapshot + live update.
const sse = await fetch(`${base}/now/events?token=${TOKEN}`, { headers: { accept: 'text/event-stream' } });
assert.equal(sse.status, 200);
const reader = sse.body.getReader();
const decoder = new TextDecoder();
let sseBuf = '';
async function readUntil(predicate, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate(sseBuf)) return;
    const { value, done } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
  }
  throw new Error(`SSE never delivered: ${label}`);
}
await readUntil((buf) => buf.includes('"title":"Tone"'), 'initial snapshot');
nowState = { ...nowState, title: 'Second', position: 44 };
for (const cb of nowSubscribers) cb(nowState);
await readUntil((buf) => buf.includes('"title":"Second"'), 'live update');
await reader.cancel().catch(() => undefined);

// 5. Control: valid, invalid, arg pass-through.
const ok = await fetch(`${base}/control`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-newamp-token': TOKEN },
  body: JSON.stringify({ cmd: 'seek', arg: 93 }),
});
assert.equal(ok.status, 200);
assert.deepEqual(controls.at(-1), { cmd: 'seek', arg: 93 });
const bad = await fetch(`${base}/control`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-newamp-token': TOKEN },
  body: JSON.stringify({ cmd: 'formatDisk' }),
});
assert.equal(bad.status, 400, 'non-whitelisted command should 400');

// 6. M3U carries the token.
const m3u = await (await fetch(`${base}/library.m3u?token=${TOKEN}`)).text();
assert.match(m3u, /\/audio\/42\?token=/, 'M3U audio URLs must embed the token');

// 7. Range honored with real 206.
const range = await fetch(`${base}/audio/42?token=${TOKEN}`, { headers: { range: 'bytes=100-199' } });
assert.equal(range.status, 206, 'range request should get 206');
assert.equal(range.headers.get('content-range'), 'bytes 100-199/4096');
assert.equal((await range.arrayBuffer()).byteLength, 100);

await brain.stop();
console.log(JSON.stringify({ ok: true, controls: controls.length }));
clearTimeout(hardTimeout);
// Natural exit (no process.exit): hard-exiting while undici's keep-alive
// sockets are mid-teardown trips a libuv assert on Windows. With the hard
// timeout cleared, node leaves on its own once the last socket closes.
process.exitCode = 0;
