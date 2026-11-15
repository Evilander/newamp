// A read that fails partway through a track (a network share timing out) is
// resumed where it stopped, so the track plays to its end and keeps its
// length. ffmpeg reports such a failure as an error line and still exits 0,
// as if the file had ended there; the transport used to keep what it had
// and shorten the track's duration to match. Then it allowed five resumes per
// track, so a share that dropped every so often ended a long track at its
// sixth drop.
// A stand-in ffmpeg plays the share; FLAKY_MODE picks how it fails:
//   once    decodes the first 20 s, prints the error a timed-out read gives
//           and exits 0; asked to start later (-ss), it decodes the rest
//   every8  every run decodes 8 s from where it starts, then fails the same way
//   gone    the first run fails at 20 s and every later run fails at once
//   seekfail  a run asked to start later (-ss) writes a WAV header with no audio,
//           prints the error and exits 0; the run after that decodes normally
//   seekgone  every run asked to start later does that
//   hang    the first run decodes 20 s and then sits there, pipe open, saying
//           nothing; asked to start later, it decodes the rest
//   damaged  the first run decodes 59 s and exits 1 with an error that is not a
//           read failing; every later run does that at once
//   damagedmid  the same at 30 s
//   openhang  the first run sits there before any output, pipe open, saying
//           nothing; every later one decodes normally
//   openfail  the first run fails before any audio, as an open that timed out does
//   sticky  the first run fails at 20 s as a timed-out read does; every later
//           one fails with an error that is not recognised as the drive's
// Files named flaky*.wav, .mp3 and .m4a behave that way; everything else goes to the real ffmpeg.
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1] ?? '';
const ssAt = args.indexOf('-ss');
const from = ssAt >= 0 && ssAt < args.indexOf('-i') ? Number(args[ssAt + 1]) : 0;
const mode = process.env.FLAKY_MODE;
const flakyInput = /flaky\\d*\\.(wav|mp3|m4a)$/.test(input);
// How many runs of this file came before this one.
const runsFile = input + '.runs';
const run = flakyInput && existsSync(runsFile) ? Number(readFileSync(runsFile, 'utf8')) : 0;
if (flakyInput) writeFileSync(runsFile, String(run + 1));
const fail = (text = 'Operation timed out', code = 0) => {
  process.stderr.write('[error] ' + input + ': ' + text + '\\n');
  process.exit(code);
};
const decodeFor = (seconds, then = fail) => {
  const cut = [...args.slice(0, args.indexOf('-i')), '-t', String(seconds), ...args.slice(args.indexOf('-i'))];
  spawn(${JSON.stringify(ffmpeg)}, cut, { stdio: ['ignore', 'inherit', 'inherit'] }).on('close', () => then());
};
const passThrough = () => spawn(${JSON.stringify(ffmpeg)}, args, { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
// The WAV header the decoder writes before any audio, with none after it.
const emptyHeaderThenFail = () => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(44100 * 8, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(0xffffffff, 40);
  process.stdout.write(header, () => fail());
};
if (!flakyInput) passThrough();
else if (mode === 'once') from > 0 ? passThrough() : decodeFor(20);
else if (mode === 'every8') from + 8 >= 60 ? passThrough() : decodeFor(8);
else if (mode === 'gone') from > 0 ? fail() : decodeFor(20);
else if (mode === 'seekfail') from > 0 && run === 0 ? emptyHeaderThenFail() : passThrough();
else if (mode === 'seekgone') from > 0 ? emptyHeaderThenFail() : passThrough();
else if (mode === 'hang') from > 0 ? passThrough() : decodeFor(20, () => setInterval(() => undefined, 1e6));
else if (mode === 'damaged') from > 0 ? fail('Invalid data found when processing input', 1) : decodeFor(59, () => fail('Invalid data found when processing input', 1));
else if (mode === 'damagedmid') from > 0 ? fail('Invalid data found when processing input', 1) : decodeFor(30, () => fail('Invalid data found when processing input', 1));
else if (mode === 'openhang') run === 0 ? setInterval(() => undefined, 1e6) : passThrough();
else if (mode === 'openfail') run === 0 ? fail('Operation timed out', 1) : passThrough();
else if (mode === 'sticky') run === 0 ? decodeFor(20) : fail('No such file or directory', 1);
else passThrough();
`);
await chmod(flaky, 0o755);
process.env.NEWAMP_FFMPEG_PATH = flaky;
// Short, so the share that never comes back gives up quickly.
process.env.NEWAMP_DECODE_OUTAGE_MS = '4000';
process.env.NEWAMP_DECODE_ERROR_MS = '2000';
// Short, so a decoder that hangs is stopped quickly.
process.env.NEWAMP_DECODE_STALL_MS = '1800';
process.env.NEWAMP_DECODE_OPEN_STALL_MS = '2500';

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
const source = (trackId, name, seconds) => ({ trackId, path: fixture(name, seconds), sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: seconds, lossless: true, dsd: false });
const sources = new Map([
  [1, source(1, 'flaky.wav', SECONDS)],
  [2, source(2, 'steady.wav', 10)],
  [3, source(3, 'flaky2.wav', SECONDS)],
  [4, source(4, 'flaky3.mp3', SECONDS)],
  [5, source(5, 'flaky4.m4a', SECONDS)],
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
}, 150_000);

let gen = 0;
const segment = (token, trackId) => ({ token, trackId, startAt: 0, gain: 1 });
/**
 * Plays track 1 (or `trackId`) through the producer until the stream ends, or
 * until start() gives up when `startFails`. `during` runs once the renderer
 * has been told to wait.
 */
async function play(mode, { startAt = 0, sampleRate = 44100, trackId = 1, next = null, during = null, startFails = false } = {}) {
  process.env.FLAKY_MODE = mode;
  for (const id of sources.keys()) await rm(`${sources.get(id).path}.runs`, { force: true });
  gen += 1;
  const sender = new Sender();
  await handlers['gapless:open']({ sender });
  const port = sender.port;
  const seen = { pcm: 0, end: 0, fail: [], dur: [], wait: [], events: [], segs: [], samples: [] };
  port.on('message', (msg) => {
    if (msg.t === 'pcm') {
      seen.pcm += msg.pcm.length / 2;
      seen.samples.push(msg.pcm);
    }
    else if (msg.t === 'end') seen.end += 1;
    else if (msg.t === 'fail') seen.fail.push(msg);
    else if (msg.t === 'dur') seen.dur.push(msg.durationSec);
    else if (msg.t === 'wait') seen.wait.push(msg.on);
    if (msg.t === 'seg') seen.segs.push(msg.token);
    if (msg.t !== 'pcm' && msg.t !== 'dur') seen.events.push(msg.t === 'wait' ? `wait:${msg.on}` : msg.t);
  });
  const pump = setInterval(() => port.postMessage({ t: 'credit', gen, consumed: seen.pcm }), 20);
  const request = { gen, ...segment(1, trackId), startAt, sampleRate, next };
  const started = await handlers['gapless:start']({ sender }, request);
  if (startFails) {
    assert.equal(started.ok, false, `${mode}: the start gave up instead of resolving`);
    await new Promise((r) => setTimeout(r, 500));
    clearInterval(pump);
    handlers['gapless:stop']({ sender }, gen);
    return { ...seen, started, seconds: seen.pcm / sampleRate };
  }
  assert.equal(started.ok, true, started.error);
  if (during) {
    await new Promise((resolveWait, reject) => {
      const poll = setInterval(() => {
        if (seen.wait.length > 0) {
          clearInterval(poll);
          resolveWait();
        }
      }, 10);
      setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`${mode}: the renderer was never told to wait`));
      }, 20_000);
    });
    await during({ sender, gen });
  }
  await new Promise((resolveWait, reject) => {
    const poll = setInterval(() => {
      if (seen.end > 0) {
        clearInterval(poll);
        resolveWait();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`${mode}: the stream never ended (${(seen.pcm / sampleRate).toFixed(1)} s on the port, ${JSON.stringify(seen.events)})`));
    }, 45_000);
  });
  clearInterval(pump);
  handlers['gapless:stop']({ sender }, gen);
  return { ...seen, started, frames: seen.pcm, seconds: seen.pcm / sampleRate };
}

// Whatever was waited on stops being waited on before the stream says it is
// over, however it is over.
function waitEndsBeforeTheEnd(result) {
  const { events } = result;
  const on = events.lastIndexOf('wait:true');
  if (on < 0) return true;
  const off = events.indexOf('wait:false', on);
  const over = events.findIndex((e) => e === 'end' || e === 'fail');
  return off > on && (over < 0 || off < over);
}

const once = await play('once');
assert.deepEqual(once.fail, [], 'once: the track did not fail');
assert.ok(once.seconds > SECONDS - 0.5 && once.seconds < SECONDS + 0.5, `once: the whole track played after the read failed at 20 s: ${once.seconds.toFixed(2)} s of ${SECONDS}`);
assert.ok(!once.dur.some((d) => d < SECONDS - 1), `once: the track kept its length (duration updates: ${JSON.stringify(once.dur)})`);
assert.deepEqual(once.wait, [true, false], 'once: the renderer heard the wait begin and end');

const every8 = await play('every8');
assert.deepEqual(every8.fail, [], 'every8: the track did not fail');
assert.ok(every8.seconds > SECONDS - 0.5 && every8.seconds < SECONDS + 0.5, `every8: the whole track played through seven failed reads: ${every8.seconds.toFixed(2)} s of ${SECONDS}`);
assert.ok(!every8.dur.some((d) => d < SECONDS - 1), `every8: the track kept its length (duration updates: ${JSON.stringify(every8.dur)})`);
assert.equal(every8.wait.filter(Boolean).length, 7, `every8: one wait per failed read (${JSON.stringify(every8.wait)})`);
assert.equal(every8.wait.at(-1), false, 'every8: the last wait ended');

const gone = await play('gone');
assert.ok(gone.seconds > 19.5 && gone.seconds < 20.5, `gone: the 20 s that were read played: ${gone.seconds.toFixed(2)} s`);
assert.equal(gone.fail.length, 1, `gone: the track failed in-band instead of ending as if it played out (${JSON.stringify(gone.fail)})`);
assert.equal(gone.fail[0].token, 1, 'gone: the failure names the track');
assert.match(gone.fail[0].message, /drive stopped answering/);
assert.deepEqual(gone.wait, [true, false], 'gone: the wait ended when the transport gave up');
assert.ok(!gone.dur.some((d) => d < SECONDS - 1), `gone: the track kept its length (duration updates: ${JSON.stringify(gone.dur)})`);

assert.ok(waitEndsBeforeTheEnd(once) && waitEndsBeforeTheEnd(every8) && waitEndsBeforeTheEnd(gone), 'the wait ended before the stream did');

// A scrub into a track whose read then times out is not the end of the track.
const seekfail = await play('seekfail', { startAt: 30 });
assert.deepEqual(seekfail.fail, [], 'seekfail: the track did not fail');
assert.ok(seekfail.seconds > 29.5 && seekfail.seconds < 30.5, `seekfail: the 30 s after the seek played, not an instant end: ${seekfail.seconds.toFixed(2)} s`);
assert.deepEqual(seekfail.wait, [true, false], 'seekfail: the renderer heard the wait begin and end');
assert.ok(waitEndsBeforeTheEnd(seekfail), 'seekfail: the wait ended before the stream did');

// A drive that never answers the seek fails the start, and doesn't drain as if it played out.
const seekgone = await play('seekgone', { startAt: 30, startFails: true });
assert.equal(seekgone.end, 0, `seekgone: no end for a seek the drive didn't answer (${JSON.stringify(seekgone.events)})`);
assert.match(seekgone.started.error, /drive stopped answering/, `seekgone: ${seekgone.started.error}`);

// A decoder that sends nothing and never exits is stopped and read again.
const hang = await play('hang');
assert.deepEqual(hang.fail, [], 'hang: the track did not fail');
assert.ok(hang.seconds > SECONDS - 0.5 && hang.seconds < SECONDS + 0.5, `hang: the whole track played past the hung decoder: ${hang.seconds.toFixed(2)} s of ${SECONDS}`);
assert.deepEqual(hang.wait, [true, false], `hang: the renderer was told to wait while it hung (${JSON.stringify(hang.wait)})`);
assert.ok(waitEndsBeforeTheEnd(hang), 'hang: the wait ended before the stream did');

// A reopen that fails in a way nobody recognised is still the outage it came after.
const sticky = await play('sticky');
assert.equal(sticky.fail.length, 1, `sticky: the track failed in-band (${JSON.stringify(sticky.fail)})`);
assert.match(sticky.fail[0].message, /drive stopped answering/, `sticky: still the drive's outage (${sticky.fail[0].message})`);
assert.ok(waitEndsBeforeTheEnd(sticky), 'sticky: the wait ended before the stream did');

// A damaged file that stops where it nearly ended anyway ends there and what
// follows plays; one that stops far short of its length fails.
const damaged = await play('damaged');
assert.deepEqual(damaged.fail, [], `damaged: a track that stopped 1 s from its end did not fail (${JSON.stringify(damaged.fail)})`);
assert.ok(damaged.seconds > 58.5 && damaged.seconds < 59.5, `damaged: what it had played: ${damaged.seconds.toFixed(2)} s`);
const damagedMid = await play('damagedmid');
assert.equal(damagedMid.fail.length, 1, `damagedmid: the track failed in-band (${JSON.stringify(damagedMid.fail)})`);
assert.match(damagedMid.fail[0].message, /Decode failed partway/);

// An open that times out is tried again, for the first track and for a chained one.
const openFirst = await play('openfail');
assert.deepEqual(openFirst.fail, [], 'openfail: the track did not fail');
assert.ok(openFirst.seconds > SECONDS - 0.5 && openFirst.seconds < SECONDS + 0.5, `openfail: the track played after its open was tried again: ${openFirst.seconds.toFixed(2)} s`);
const openChained = await play('openfail', { trackId: 2, next: segment(2, 3) });
assert.deepEqual(openChained.fail, [], `openfail chained: nothing failed (${JSON.stringify(openChained.fail)})`);
assert.deepEqual(openChained.segs, [1, 2], 'openfail chained: the second track followed the first');
assert.ok(openChained.seconds > SECONDS + 10 - 0.5, `openfail chained: it played whole: ${openChained.seconds.toFixed(2)} s`);
assert.deepEqual(openChained.wait, [true, false], `openfail chained: the renderer waited for the open (${JSON.stringify(openChained.wait)})`);
assert.ok(waitEndsBeforeTheEnd(openChained), 'openfail chained: the wait ended before the stream did');

// A chained track whose open hangs with no output is stopped and opened again.
const openHang = await play('openhang', { trackId: 2, next: segment(2, 3) });
assert.deepEqual(openHang.fail, [], `openhang: nothing failed (${JSON.stringify(openHang.fail)})`);
assert.deepEqual(openHang.segs, [1, 2], 'openhang: the second track followed the first');
assert.ok(openHang.seconds > SECONDS + 10 - 0.5, `openhang: it played whole: ${openHang.seconds.toFixed(2)} s`);
assert.ok(waitEndsBeforeTheEnd(openHang), 'openhang: the wait ended before the stream did');

// Resuming into a resampler keeps every frame the track has at the new rate.
const plain48 = await play('none', { sampleRate: 48000 });
const once48 = await play('once', { sampleRate: 48000 });
assert.deepEqual(once48.fail, [], 'once48: the track did not fail');
assert.equal(once48.frames, plain48.frames, `once48: the same frames as a track that never failed (${once48.frames} against ${plain48.frames})`);

// A resumed decode of a lossy file carries on from exactly the sample it
// stopped at: the stream is the one a track that never failed gives.
for (const [id, kind] of [[4, 'mp3'], [5, 'm4a']]) {
  const whole = await play('none', { trackId: id });
  const resumed = await play('once', { trackId: id });
  assert.deepEqual(resumed.fail, [], `${kind}: the track did not fail`);
  assert.equal(resumed.frames, whole.frames, `${kind}: as many frames as a track that never failed (${resumed.frames} against ${whole.frames})`);
  const a = Buffer.concat(whole.samples.map((f) => Buffer.from(f.buffer)));
  const b = Buffer.concat(resumed.samples.map((f) => Buffer.from(f.buffer)));
  const x = new Float32Array(a.buffer, a.byteOffset, a.length / 4);
  const y = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  let worst = 0;
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
  assert.ok(worst < 1e-6, `${kind}: the splice at 20 s is exact (largest difference ${worst})`);
}

// The track chained after one that was resumed follows it.
const chained = await play('once', { next: segment(2, 2) });
assert.deepEqual(chained.fail, [], 'chained: nothing failed');
assert.deepEqual(chained.segs, [1, 2], `chained: both tracks were placed, in order (${JSON.stringify(chained.segs)})`);
assert.ok(chained.seconds > SECONDS + 10 - 0.5 && chained.seconds < SECONDS + 10 + 0.5, `chained: the first track whole, then the second: ${chained.seconds.toFixed(2)} s`);
assert.deepEqual(chained.wait, [true, false], 'chained: one wait');

// A queue edit that cuts out the track that is being read again ends the wait.
const cut = await play('gone', {
  trackId: 2,
  next: segment(2, 3),
  during: async ({ sender, gen: at }) => {
    await handlers['gapless:prepare-next']({ sender }, at, 1, null);
  },
});
assert.deepEqual(cut.fail, [], `cut: nothing failed (${JSON.stringify(cut.fail)})`);
assert.ok(cut.events.includes('cut'), `cut: the track was cut out (${JSON.stringify(cut.events)})`);
assert.deepEqual(cut.wait, [true, false], `cut: the wait ended with the cut (${JSON.stringify(cut.wait)})`);
assert.ok(waitEndsBeforeTheEnd(cut), 'cut: the wait ended before the stream did');

clearTimeout(deadline);
await rm(root, { recursive: true, force: true });
console.log(`[gapless-read-resume-test] ok: ${once.seconds.toFixed(2)} s after one failed read, ${every8.seconds.toFixed(2)} s after seven, a share that stayed gone failed the track at ${gone.seconds.toFixed(2)} s, plus seeks into failed reads, a hung decoder, resampling, a chained track and a cut`);
process.exit(0);
