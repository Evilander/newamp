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
// The route's stat is routed through a hook, so a test can make one path answer the way a share
// that timed out does. Anything the hook does not claim goes to the real fs.
const statShim = resolve('tmp/radio-brain-streaming-fs-shim.mjs');
writeFileSync(
  statShim,
  [
    "import * as real from 'node:fs/promises';",
    "export * from 'node:fs/promises';",
    'export const stat = (path, ...rest) => (globalThis.__radioStatHook ? globalThis.__radioStatHook(path, real.stat) : real.stat(path, ...rest));',
  ].join('\n'),
);
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: resolve('tmp/radio-brain-streaming-bundle.mjs'),
  logLevel: 'silent',
  plugins: [{
    name: 'stat-hook',
    setup(builder) {
      builder.onResolve({ filter: /^node:fs\/promises$/ }, (args) => (args.importer.endsWith('radio-brain.ts') ? { path: statShim } : undefined));
    },
  }],
});
const { RadioBrain, pickLocalAddress, fileSizeWithin } = await import(pathToFileURL(resolve('tmp/radio-brain-streaming-bundle.mjs')).href);

const TOKEN = 'streaming-test-token';
const dir = mkdtempSync(join(tmpdir(), 'radio-streaming-'));
const nativePath = join(dir, 'song.flac');
writeFileSync(nativePath, Buffer.alloc(1024, 7));

const stalledPath = join(dir, 'stalled.flac');
const tracks = {
  1: { id: 1, path: join(dir, 'song.wma') },
  2: { id: 2, path: nativePath },
  3: { id: 3, path: stalledPath },
  4: { id: 4, path: join(dir, 'gone.flac') },
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

  // Windows names an adapter the way its driver or owner did. The virtual ones are listed first so
  // that the order they came in cannot be what picks the answer.
  const windowsVirtual = {
    'vEthernet (WSL)': iface('172.28.64.1'),
    'vEthernet (Default Switch)': iface('172.20.0.1'),
    'VirtualBox Host-Only Network': iface('192.168.56.1'),
    'VMware Network Adapter VMnet8': iface('192.168.17.1'),
    'Npcap Loopback Adapter': iface('192.168.99.1'),
    'Local Area Connection* 10': iface('192.168.137.1'),
    Tailscale: iface('100.101.102.103'),
    'ZeroTier One [8056c2e21c000001]': iface('10.147.17.5'),
    'OpenVPN TAP-Windows Adapter V9': iface('10.8.0.2'),
    'Bluetooth Network Connection': iface('192.168.44.1'),
  };
  for (const [wanted, name] of [['192.168.1.50', 'Ethernet'], ['192.168.1.51', 'Ethernet 2'], ['10.0.0.7', 'Wi-Fi'], ['10.0.0.8', 'Wireless Network Connection'], ['10.0.0.9', 'Local Area Connection']]) {
    assert.equal(pickLocalAddress({ ...windowsVirtual, [name]: iface(wanted), 'Loopback Pseudo-Interface 1': iface('127.0.0.1', true) }), wanted, name);
  }
  assert.equal(
    pickLocalAddress({ ...windowsVirtual, 'Realtek PCIe GbE Family Controller': iface('192.168.2.2') }),
    '192.168.2.2',
    'an adapter the list does not know ranks above a virtual one',
  );
  assert.equal(pickLocalAddress(windowsVirtual), '172.28.64.1', 'with nothing else, the first virtual one is better than none');
  // The same on Linux.
  assert.equal(
    pickLocalAddress({ virbr0: iface('192.168.122.1'), tun0: iface('10.8.0.3'), wg0: iface('10.9.0.2'), 'br-1a2b3c4d5e6f': iface('172.18.0.1'), wlp3s0: iface('192.168.1.9') }),
    '192.168.1.9',
  );
  assert.equal(pickLocalAddress({ tailscale0: iface('100.64.0.9'), lxcbr0: iface('10.0.3.1'), enp5s0: iface('192.168.1.10') }), '192.168.1.10');

  // The file's size comes from a stat that is given up on after its time, and while one is still
  // waiting on the drive no other is started.
  assert.equal(await fileSizeWithin('a', 1000, async () => ({ size: 42 })), 42);
  let releaseHung = () => undefined;
  let reads = 0;
  const hung = () => {
    reads += 1;
    return new Promise((resolvePromise) => {
      releaseHung = () => resolvePromise({ size: 7 });
    });
  };
  const started = Date.now();
  await assert.rejects(() => fileSizeWithin('a', 40, hung), (err) => err.code === 'ETIMEDOUT');
  assert.ok(Date.now() - started < 3000, 'a stat that never answers is given up on');
  await assert.rejects(
    () => fileSizeWithin('b', 40, async () => { reads += 1; return { size: 1 }; }),
    (err) => err.code === 'ETIMEDOUT',
  );
  assert.equal(reads, 1, 'no second stat is started behind one that is still waiting');
  releaseHung();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(await fileSizeWithin('c', 1000, async () => ({ size: 9 })), 9, 'stats resume once the drive has answered');
  await assert.rejects(
    () => fileSizeWithin('d', 1000, async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }),
    (err) => err.code === 'ENOENT',
    'an ordinary failure comes through as it is',
  );

  // A track whose drive times out answers 503 and can be asked for again; a missing file is a 404.
  globalThis.__radioStatHook = (path, realStat) => {
    if (path === stalledPath) return Promise.reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    return realStat(path);
  };
  const stalled = await head('/audio/3');
  assert.equal(stalled.statusCode, 503);
  assert.equal(stalled.headers['retry-after'], '5');
  assert.equal((await head('/audio/4')).statusCode, 404);
  assert.equal((await head('/audio/2')).statusCode, 200, 'other tracks are unaffected');
  delete globalThis.__radioStatHook;

  // A request line that cannot be read is a 400 whether or not the token is right, and the routes
  // that need the token still refuse without it.
  const raw = (path, headers = {}) => new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await raw('/%'), 400);
  assert.equal(await raw(`/audio/%E0%A4%A?token=${TOKEN}`), 400);
  assert.equal(await raw('/', { host: 'not a host' }), 400);
  assert.equal(await raw('/'), 401);
  assert.equal(await raw('/remote'), 200);
  console.log('radio-brain-streaming-test: PASS');
} finally {
  await brain.stop();
}
