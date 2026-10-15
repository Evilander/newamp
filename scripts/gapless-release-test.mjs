// releaseGaplessPaths: a move to the Recycle Bin needs the gapless decoder
// off the file. The decoder on a released file is stopped and the stream
// carries on with the chained track; a chained plan on a released file is
// dropped before it starts, and so is a chained decoder that hasn't placed
// its segment yet; the file can be moved afterwards; a file no plan names is
// left alone. Real ffmpeg, a scripted worklet on the port.
// Run: node scripts/gapless-release-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'gapless-release-test', String(process.pid));
const media = join(root, 'media');
await rm(root, { recursive: true, force: true });
await mkdir(media, { recursive: true });

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
      contents: `
        import { MessageChannel } from 'node:worker_threads';
        import { EventEmitter } from 'node:events';
        class MessagePortMain extends EventEmitter {
          constructor(port) {
            super();
            this.port = port;
            port.on('message', (data) => this.emit('message', { data, ports: [] }));
            port.on('close', () => this.emit('close'));
          }
          start() {}
          postMessage(message) { this.port.postMessage(message); }
          close() { this.port.close(); }
        }
        export class MessageChannelMain {
          constructor() {
            const { port1, port2 } = new MessageChannel();
            this.port1 = new MessagePortMain(port1);
            this.port2 = port2;
          }
        }`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

await build({
  stdin: {
    contents: `export { closeAllGaplessSessions, registerGaplessTransport, releaseGaplessPaths } from './electron/gapless-transport.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['ffmpeg-static'],
  plugins: [stubs],
  outfile: join(root, 'bundle.mjs'),
  logLevel: 'silent',
});
const { closeAllGaplessSessions, registerGaplessTransport, releaseGaplessPaths } = await import(pathToFileURL(join(root, 'bundle.mjs')).href);

function fixture(name, seconds) {
  const path = join(media, name);
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`, '-ac', '2', path], { encoding: 'utf8', windowsHide: true });
  if (made.status !== 0) throw new Error(made.stderr);
  return path;
}
const a = fixture('a.wav', 120);
const b = fixture('b.wav', 120);
const c = fixture('c.wav', 120);
// Exactly the producer's high-water mark (30 s): with no credit given, its
// decoder finishes and the chained decoder spawns paused, header unread.
const short = fixture('short.wav', 30);
const e = fixture('e.wav', 120);
const f = fixture('f.wav', 120);
const sources = new Map([
  [1, { trackId: 1, path: a, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 120, lossless: true, dsd: false }],
  [2, { trackId: 2, path: b, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 120, lossless: true, dsd: false }],
  [3, { trackId: 3, path: c, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 120, lossless: true, dsd: false }],
  [4, { trackId: 4, path: short, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 30, lossless: true, dsd: false }],
  [5, { trackId: 5, path: e, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 120, lossless: true, dsd: false }],
  [6, { trackId: 6, path: f, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 120, lossless: true, dsd: false }],
]);

const handlers = {};
registerGaplessTransport({ handle: (name, fn) => { handlers[name] = fn; } }, async (id) => sources.get(id) ?? null);

class Sender extends EventEmitter {
  constructor() {
    super();
    this.port = null;
  }
  postMessage(channel, data, ports) {
    this.port = ports[0];
  }
}

const deadline = setTimeout(() => {
  console.error('gapless release test timed out');
  process.exit(1);
}, 60_000);

async function open() {
  const sender = new Sender();
  const epoch = await handlers['gapless:open']({ sender });
  assert.ok(epoch > 0 && sender.port);
  const port = sender.port;
  const seen = { seg: [], pcm: 0, end: 0, fail: [], cut: [] };
  const waiters = [];
  port.on('message', (msg) => {
    if (msg.t === 'pcm') seen.pcm += msg.pcm.length / 2;
    else if (msg.t === 'seg') seen.seg.push(msg.token);
    else if (msg.t === 'end') seen.end += 1;
    else if (msg.t === 'fail') seen.fail.push(msg);
    else if (msg.t === 'cut') seen.cut.push(msg.token);
    for (const w of waiters.splice(0)) w();
  });
  const until = (check, what) => new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 20_000);
    const poll = () => {
      if (check()) {
        clearTimeout(timer);
        resolveWait();
      } else waiters.push(poll);
    };
    poll();
  });
  const credit = (gen) => port.postMessage({ t: 'credit', gen, consumed: seen.pcm });
  return { sender, port, seen, until, credit };
}

// 1. The decoder on the current track is stopped; the chained track follows.
{
  const t = await open();
  const started = await handlers['gapless:start']({ sender: t.sender }, { gen: 1, token: 1, trackId: 1, startAt: 0, gain: 1, sampleRate: 44100, next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
  assert.equal(started.ok, true, started.error);
  await t.until(() => t.seen.pcm > 44100, 'first audio');
  // No credits: the producer sits at its high-water mark with a.wav open.
  await new Promise((r) => setTimeout(r, 500));
  if (process.platform === 'win32') {
    await assert.rejects(rename(a, join(media, 'a-moved.wav')), 'Windows refuses to move the file the decoder holds');
  }
  await releaseGaplessPaths([a]);
  await rename(a, join(media, 'a-moved.wav'));
  assert.ok(existsSync(join(media, 'a-moved.wav')), 'the released file can be moved');
  assert.deepEqual(t.seen.fail, [], 'the stream did not fail');
  // Let the worklet drain: the chained track is placed after what a.wav gave.
  const beforeNext = t.seen.pcm;
  const pump = setInterval(() => t.credit(1), 20);
  await t.until(() => t.seen.seg.includes(2), 'the chained segment');
  clearInterval(pump);
  assert.deepEqual(t.seen.seg, [1, 2], 'b.wav follows a.wav in the same stream');
  assert.ok(beforeNext > 0);
  assert.equal(t.seen.end, 0);
  handlers['gapless:stop']({ sender: t.sender }, 1);
}

// 2. A chained plan on a released file is dropped before it starts; the
//    current track is untouched and the stream ends after it.
{
  const t = await open();
  const started = await handlers['gapless:start']({ sender: t.sender }, { gen: 2, token: 11, trackId: 3, startAt: 0, gain: 1, sampleRate: 44100, next: { token: 12, trackId: 2, startAt: 0, gain: 1 } });
  assert.equal(started.ok, true, started.error);
  await t.until(() => t.seen.pcm > 44100, 'first audio');
  const pcmBefore = t.seen.pcm;
  await releaseGaplessPaths([b]);
  await rename(b, join(media, 'b-moved.wav'));
  // A file no plan names is left alone: c.wav keeps decoding.
  const pump = setInterval(() => t.credit(2), 20);
  await t.until(() => t.seen.pcm > pcmBefore + 44100 * 5, 'more of c.wav');
  await t.until(() => t.seen.end > 0, 'the end of the stream');
  clearInterval(pump);
  assert.deepEqual(t.seen.seg, [11], 'the dropped plan never started');
  assert.ok(t.seen.pcm >= 44100 * 119, `all of c.wav played (${t.seen.pcm} frames)`);
  handlers['gapless:stop']({ sender: t.sender }, 2);
}

// 3. Nothing open: a release is a no-op that resolves.
await releaseGaplessPaths([c, join(media, 'nothing.wav')]);

// Plays short.wav with `next` chained and waits until its decoder has
// finished and the chained decoder sits paused on the chained file.
async function startShortThen(gen, token, next) {
  const t = await open();
  const started = await handlers['gapless:start']({ sender: t.sender }, { gen, token, trackId: 4, startAt: 0, gain: 1, sampleRate: 44100, next });
  assert.equal(started.ok, true, started.error);
  // Everything but the tail the producer coalesces is on the port.
  await t.until(() => t.seen.pcm >= 44100 * 30 - 4096, 'all of short.wav');
  await new Promise((r) => setTimeout(r, 1000));
  return t;
}

// 4. A chained decoder that has not placed its segment (spawned at the
//    high-water mark, paused before its header) is dropped, not failed:
//    nothing of it reaches the stream, which ends after the current track.
{
  const t = await startShortThen(3, 21, { token: 22, trackId: 5, startAt: 0, gain: 1 });
  if (process.platform === 'win32') {
    await assert.rejects(rename(e, join(media, 'e-moved.wav')), 'the chained decoder holds its file');
  }
  await releaseGaplessPaths([e]);
  await rename(e, join(media, 'e-moved.wav'));
  assert.deepEqual(t.seen.fail, [], 'nothing failed');
  assert.deepEqual(t.seen.seg, [21], 'the dropped segment was never placed');
  const pump = setInterval(() => t.credit(3), 20);
  await t.until(() => t.seen.end > 0, 'the end of the stream');
  clearInterval(pump);
  assert.deepEqual(t.seen.fail, []);
  assert.deepEqual(t.seen.seg, [21]);
  assert.equal(t.seen.pcm, 44100 * 30, `all of short.wav and nothing else played (${t.seen.pcm} frames)`);
  handlers['gapless:stop']({ sender: t.sender }, 3);
}

// 5. ...and the stream is still open to what is named next after the release.
{
  const t = await startShortThen(4, 31, { token: 32, trackId: 6, startAt: 0, gain: 1 });
  await releaseGaplessPaths([f]);
  await rename(f, join(media, 'f-moved.wav'));
  await handlers['gapless:prepare-next']({ sender: t.sender }, 4, 31, { token: 33, trackId: 3, startAt: 0, gain: 1 });
  const pump = setInterval(() => t.credit(4), 20);
  await t.until(() => t.seen.seg.includes(33), 'the re-pointed segment');
  clearInterval(pump);
  assert.deepEqual(t.seen.seg, [31, 33], 'c.wav follows short.wav; f.wav never started');
  assert.deepEqual(t.seen.fail, []);
  assert.equal(t.seen.end, 0);
  handlers['gapless:stop']({ sender: t.sender }, 4);
}

closeAllGaplessSessions();
clearTimeout(deadline);
await new Promise((r) => setTimeout(r, 300));
await rm(root, { recursive: true, force: true });
console.log('PASS gapless release');
