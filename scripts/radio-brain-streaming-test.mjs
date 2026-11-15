// Radio Brain audio route: transcoded responses honour backpressure, HEAD probes start no
// decode and read no file, and the advertised address skips tunnels and VM bridges.
// Run: node scripts/radio-brain-streaming-test.mjs [path/to/radio-brain.ts]
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const entry = resolve(process.argv[2] ?? 'electron/radio-brain.ts');
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: resolve('tmp/radio-brain-streaming-bundle.mjs'),
  logLevel: 'silent',
});
const { RadioBrain, pickLocalAddress } = await import(pathToFileURL(resolve('tmp/radio-brain-streaming-bundle.mjs')).href);

const TOKEN = 'streaming-test-token';
const dir = mkdtempSync(join(tmpdir(), 'radio-streaming-'));
const nativePath = join(dir, 'song.flac');
writeFileSync(nativePath, Buffer.alloc(1024, 7));

const tracks = {
  1: { id: 1, path: join(dir, 'song.wma') },
  2: { id: 2, path: nativePath },
};
let transcodes = 0;
let produced = 0;
const CHUNK = 64 * 1024;

const brain = new RadioBrain({
  library: {
    getStats: () => ({ tracks: 0, albums: 0, artists: 0 }),
    getTagSummaries: () => [],
    getTrackIds: () => [],
    getTrackIdsByTag: () => [],
    getTracksByIdsInOrder: () => [],
    getTrack: (id) => tracks[id] ?? null,
    getArt: () => null,
  },
  port: 17300 + Math.floor(Math.random() * 500),
  transcode: (_path, signal) => {
    transcodes += 1;
    const body = new ReadableStream({
      pull(controller) {
        if (signal.aborted) {
          controller.close();
          return;
        }
        produced += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  },
  ffmpegFallbackExt: (path) => path.endsWith('.wma'),
  getToken: () => TOKEN,
  getNowPlaying: () => null,
  onNowPlaying: () => () => undefined,
  control: () => true,
});
const status = await brain.start();
assert.equal(status.enabled, true, status.error ?? 'radio brain should start');
const port = status.port;

function head(path) {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `${path}?token=${TOKEN}`, method: 'HEAD' }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise(res));
    });
    req.on('error', reject);
    req.end();
  });
}

try {
  const wavHead = await head('/audio/1');
  assert.equal(wavHead.statusCode, 200);
  assert.equal(wavHead.headers['content-type'], 'audio/wav');
  assert.equal(transcodes, 0, 'HEAD on a transcoded track must not start a decode');
  const flacHead = await head('/audio/2');
  assert.equal(flacHead.statusCode, 200);
  assert.equal(flacHead.headers['content-length'], '1024');
  assert.equal(flacHead.headers['accept-ranges'], 'bytes');

  // A client that stops reading must stall the producer instead of letting it run ahead.
  await new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/audio/1?token=${TOKEN}` }, (res) => {
      res.pause();
      setTimeout(() => {
        try {
          assert.ok(
            produced < 48 * 1024 * 1024,
            `producer ran ${(produced / 1048576).toFixed(0)} MB ahead of a client that read nothing`,
          );
          const before = produced;
          setTimeout(() => {
            try {
              assert.ok(produced - before < 8 * 1024 * 1024, 'producer should stay stalled while the client is paused');
              res.destroy();
              resolvePromise();
            } catch (err) {
              res.destroy();
              reject(err);
            }
          }, 300);
        } catch (err) {
          res.destroy();
          reject(err);
        }
      }, 700);
    });
    req.on('error', () => {});
    req.end();
  });

  const iface = (address, internal = false, family = 'IPv4') => [{ address, family, internal, netmask: '', mac: '', cidr: null }];
  assert.equal(
    pickLocalAddress({
      utun4: iface('100.64.0.2'),
      bridge100: iface('192.168.64.1'),
      en5: iface('10.0.0.9'),
      en0: iface('192.168.1.20'),
      lo0: iface('127.0.0.1', true),
    }),
    '192.168.1.20',
  );
  assert.equal(pickLocalAddress({ utun4: iface('100.64.0.2'), en1: iface('169.254.3.4'), vmnet8: iface('172.16.0.1') }), '100.64.0.2');
  assert.equal(pickLocalAddress({ docker0: iface('172.17.0.1'), eth0: iface('10.1.1.5') }), '10.1.1.5');
  assert.equal(pickLocalAddress({ lo0: iface('127.0.0.1', true) }), 'localhost');
  console.log('radio-brain-streaming-test: PASS');
} finally {
  await brain.stop();
}
