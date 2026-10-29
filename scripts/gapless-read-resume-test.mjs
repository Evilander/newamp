// A read that fails partway through a track (a network share timing out) is
// resumed where it stopped, so the track plays to its end and keeps its
// length. ffmpeg reports such a failure as an error line and still exits 0,
// as if the file had ended there; the transport used to keep what it had
// and shorten the track's duration to match.
// A stand-in ffmpeg decodes the first 20 s of the track, prints the error a
// timed-out read gives and exits 0; asked to start later (-ss), it decodes
// the rest. Everything else goes to the real ffmpeg.
// Run: node scripts/gapless-read-resume-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform === 'win32') {
  console.log('[gapless-read-resume-test] skipped: the stand-in ffmpeg is a script with a shebang');
  process.exit(0);
}

const root = resolve('tmp', 'gapless-read-resume-test', String(process.pid));
const media = join(root, 'media');
await rm(root, { recursive: true, force: true });
await mkdir(media, { recursive: true });

const flaky = join(root, 'flaky-ffmpeg.mjs');
await writeFile(flaky, `#!${process.execPath}
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1] ?? '';
const resumed = args.includes('-ss') && args.indexOf('-ss') < args.indexOf('-i');
if (!input.endsWith('flaky.wav') || resumed) {
  spawn(${JSON.stringify(ffmpeg)}, args, { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
} else {
  const cut = [...args.slice(0, args.indexOf('-i')), '-t', '20', ...args.slice(args.indexOf('-i'))];
  spawn(${JSON.stringify(ffmpeg)}, cut, { stdio: ['ignore', 'inherit', 'inherit'] }).on('close', () => {
    process.stderr.write('[error] ' + input + ': Operation timed out\\n');
    process.exit(0);
  });
}
`);
await chmod(flaky, 0o755);
process.env.NEWAMP_FFMPEG_PATH = flaky;

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
    contents: `export { registerGaplessTransport } from './electron/gapless-transport.ts';`,
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
const { registerGaplessTransport } = await import(pathToFileURL(join(root, 'bundle.mjs')).href);

function fixture(name, seconds) {
  const path = join(media, name);
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`, '-ac', '2', path], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  return path;
}
const SECONDS = 60;
const sources = new Map([
  [1, { trackId: 1, path: fixture('flaky.wav', SECONDS), sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: SECONDS, lossless: true, dsd: false }],
]);

const handlers = {};
registerGaplessTransport({ handle: (name, fn) => { handlers[name] = fn; } }, async (id) => sources.get(id) ?? null);

class Sender extends EventEmitter {
  postMessage(channel, data, ports) {
    this.port = ports[0];
  }
}

const deadline = setTimeout(() => {
  console.error('gapless read resume test timed out');
  process.exit(1);
}, 60_000);

const sender = new Sender();
await handlers['gapless:open']({ sender });
const port = sender.port;
const seen = { pcm: 0, end: 0, fail: [], dur: [] };
port.on('message', (msg) => {
  if (msg.t === 'pcm') seen.pcm += msg.pcm.length / 2;
  else if (msg.t === 'end') seen.end += 1;
  else if (msg.t === 'fail') seen.fail.push(msg);
  else if (msg.t === 'dur') seen.dur.push(msg.durationSec);
});
const pump = setInterval(() => port.postMessage({ t: 'credit', gen: 1, consumed: seen.pcm }), 20);
const started = await handlers['gapless:start']({ sender }, { gen: 1, token: 1, trackId: 1, startAt: 0, gain: 1, sampleRate: 44100, next: null });
assert.equal(started.ok, true, started.error);
await new Promise((resolveWait, reject) => {
  const poll = setInterval(() => {
    if (seen.end > 0) {
      clearInterval(poll);
      resolveWait();
    }
  }, 50);
  setTimeout(() => {
    clearInterval(poll);
    reject(new Error(`the stream never ended (${(seen.pcm / 44100).toFixed(1)} s on the port)`));
  }, 45_000);
});
clearInterval(pump);
handlers['gapless:stop']({ sender }, 1);

const seconds = seen.pcm / 44100;
assert.deepEqual(seen.fail, [], 'the track did not fail');
assert.ok(seconds > SECONDS - 0.5 && seconds < SECONDS + 0.5, `the whole track played after the read failed at 20 s: ${seconds.toFixed(2)} s of ${SECONDS}`);
assert.ok(!seen.dur.some((d) => d < SECONDS - 1), `the track kept its length (duration updates: ${JSON.stringify(seen.dur)})`);

clearTimeout(deadline);
await rm(root, { recursive: true, force: true });
console.log(`[gapless-read-resume-test] ok: ${seconds.toFixed(2)} s of ${SECONDS} played after a read failed at 20 s`);
process.exit(0);
