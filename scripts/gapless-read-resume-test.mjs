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
//   quiet   the first run decodes 20 s and exits 0 with nothing on the log, as a
//           failed read that ffmpeg takes for the end of the file does; asked
//           to start later, it decodes the rest
//   quietheld  the first run does that; every later one exits 0 with a WAV
//           header, no audio and nothing on the log, and the file can't be read
//   ratechange  the first run fails at 20 s as a timed-out read does; asked to
//           start later, it decodes at another sample rate
//   resumeslow  the first run fails at 20 s as a timed-out read does; asked to
//           start later, it takes a while to open the file, then decodes the rest
//   stuck   the first run decodes 20 s and then sits there; every later one sits
//           there from the start. None of them can be stopped.
//   opengone  every run fails before any audio, as an open that timed out does
// Files named flaky*.wav, .mp3 and .m4a behave that way; everything else goes to the real ffmpeg.
// On Windows the real ffmpeg is also run, with no stand-in, against files whose
// reads really fail: a second handle locks a byte range, so a read of it is
// refused the way a drive that has stopped delivering refuses it.
// Run: node scripts/gapless-read-resume-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scriptStandInSpawn } from './lib/script-standin-spawn.mjs';

const root = resolve('tmp', 'gapless-read-resume-test', String(process.pid));
const media = join(root, 'media');
await rm(root, { recursive: true, force: true });
await mkdir(media, { recursive: true });

const flaky = join(root, 'flaky-ffmpeg.mjs');
await writeFile(flaky, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1] ?? '';
appendFileSync(${JSON.stringify(join(root, 'runs.log'))}, JSON.stringify(args) + '\\n');
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
// \`extra\` goes in as output options.
const passThrough = (extra = []) => spawn(${JSON.stringify(ffmpeg)}, [...args.slice(0, -1), ...extra, args.at(-1)], { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
const sitThere = () => setInterval(() => undefined, 1e6);
// The WAV header the decoder writes before any audio, with none after it.
const emptyHeaderThen = (then) => {
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
  process.stdout.write(header, () => then());
};
const emptyHeaderThenFail = () => emptyHeaderThen(fail);
// FLAKY_PROBE_DELAY_MS holds up the run that checks which resampler this
// ffmpeg has, as the system's scan of a newly installed binary does.
const probeDelay = args.some((arg) => arg.startsWith('anullsrc')) ? Number(process.env.FLAKY_PROBE_DELAY_MS) || 0 : 0;
if (!flakyInput) setTimeout(passThrough, probeDelay);
else if (mode === 'once') from > 0 ? passThrough() : decodeFor(20);
else if (mode === 'every8') from + 8 >= 60 ? passThrough() : decodeFor(8);
else if (mode === 'gone') from > 0 ? fail() : decodeFor(20);
else if (mode === 'seekfail') from > 0 && run === 0 ? emptyHeaderThenFail() : passThrough();
else if (mode === 'seekgone') from > 0 ? emptyHeaderThenFail() : passThrough();
else if (mode === 'hang') from > 0 ? passThrough() : decodeFor(20, sitThere);
else if (mode === 'damaged') from > 0 ? fail('Invalid data found when processing input', 1) : decodeFor(59, () => fail('Invalid data found when processing input', 1));
else if (mode === 'damagedmid') from > 0 ? fail('Invalid data found when processing input', 1) : decodeFor(30, () => fail('Invalid data found when processing input', 1));
else if (mode === 'openhang') run === 0 ? sitThere() : passThrough();
else if (mode === 'openfail') run === 0 ? fail('Operation timed out', 1) : passThrough();
else if (mode === 'sticky') run === 0 ? decodeFor(20) : fail('No such file or directory', 1);
else if (mode === 'quiet') from > 0 ? passThrough() : decodeFor(20, () => process.exit(0));
else if (mode === 'quietheld') {
  if (from > 0) emptyHeaderThen(() => process.exit(0));
  else decodeFor(20, () => {
    // Where a second handle can't lock the file (see holdTail), taking away
    // the permission to read it is what makes it unreadable.
    if (process.platform !== 'win32') chmodSync(input, 0);
    process.exit(0);
  });
}
else if (mode === 'ratechange') from > 0 ? passThrough(['-ar', '48000']) : decodeFor(20);
else if (mode === 'resumeslow') from > 0 ? setTimeout(passThrough, 2400) : decodeFor(20);
else if (mode === 'stuck') {
  appendFileSync(input + '.pids', process.pid + '\\n');
  run === 0 ? decodeFor(20, sitThere) : sitThere();
}
else if (mode === 'opengone') fail('Operation timed out', 1);
else passThrough();
`);
await chmod(flaky, 0o755);
process.env.NEWAMP_FFMPEG_PATH = flaky;
// Short, so the share that never comes back gives up quickly.
process.env.NEWAMP_DECODE_OUTAGE_MS = '4000';
process.env.NEWAMP_DECODE_ERROR_MS = '2000';
// Short, so a decoder that hangs is stopped quickly. One that has not sent
// its header yet gets longer than 'resumeslow' takes to open the file.
process.env.NEWAMP_DECODE_STALL_MS = '1800';
process.env.NEWAMP_DECODE_OPEN_STALL_MS = '4000';
// Short, so a lookup that never answers fails the start quickly.
process.env.NEWAMP_FIRST_AUDIO_TIMEOUT_MS = '8000';
// A drive that was given up on is noted as gone for a while. Here for no time
// at all, so that one case's outage is not carried into the next; the note
// has cases of its own further down.
process.env.NEWAMP_READ_GIVEN_UP_MS = '1';

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
    // A decoder blocked in a read the system won't interrupt outlives its
    // kill. While globalThis.__decodersCannotBeStopped is set, a kill closes
    // the pipes, as the real one does, and leaves the process running.
    b.onResolve({ filter: /^\.\/kill-child\.js$/ }, () => ({ path: 'kill-child', namespace: 'stub' }));
    b.onLoad({ filter: /^kill-child$/, namespace: 'stub' }, () => ({
      contents: `
        import { killChild as reallyKill } from './electron/kill-child.ts';
        export function killChild(child) {
          if (!globalThis.__decodersCannotBeStopped) return reallyKill(child);
          child.stdout?.destroy();
          child.stderr?.destroy();
        }`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

await build({
  stdin: {
    contents: `
      export { registerGaplessTransport } from './electron/gapless-transport.ts';
      export { setStorageRoots } from './electron/read-failure.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['ffmpeg-static'],
  plugins: [stubs, scriptStandInSpawn],
  outfile: join(root, 'bundle.mjs'),
  logLevel: 'silent',
});
const bundle = pathToFileURL(join(root, 'bundle.mjs')).href;

function fixture(name, seconds, extra = []) {
  const path = join(media, name);
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`, '-ac', '2', ...extra, path], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  return path;
}
const SECONDS = 60;
const source = (trackId, name, seconds, extra) => ({ trackId, path: fixture(name, seconds, extra), sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: seconds, lossless: true, dsd: false });
const sources = new Map([
  [1, source(1, 'flaky.wav', SECONDS)],
  [2, source(2, 'steady.wav', 10)],
  [3, source(3, 'flaky2.wav', SECONDS)],
  [4, source(4, 'flaky3.mp3', SECONDS)],
  [5, source(5, 'flaky4.m4a', SECONDS)],
  // The library thinks this one is a minute long; the file holds 40 s.
  [6, { ...source(6, 'flaky5.wav', 40), durationSec: SECONDS }],
]);
// A track whose lookup never comes back, as one read from a drive that has stopped answering.
const NEVER_ANSWERS = 99;
const lookUp = async (id) => (id === NEVER_ANSWERS ? new Promise(() => undefined) : sources.get(id) ?? null);

function register({ registerGaplessTransport }) {
  const registered = {};
  registerGaplessTransport({ handle: (name, fn) => { registered[name] = fn; } }, lookUp);
  return registered;
}
let handlers = register(await import(bundle));
const runsOf = async (trackId) => Number(await readFile(`${sources.get(trackId).path}.runs`, 'utf8').catch(() => '0'));

class Sender extends EventEmitter {
  postMessage(channel, data, ports) {
    this.port = ports[0];
  }
}

const deadline = setTimeout(() => {
  console.error('gapless read resume test timed out');
  process.exit(1);
}, 300_000);

let gen = 0;
const segment = (token, trackId) => ({ token, trackId, startAt: 0, gain: 1 });
/**
 * Plays track 1 (or `trackId`) through the producer until the stream ends, or
 * until start() gives up when `startFails`. `during` runs once the renderer
 * has been told to wait and the start has answered; `onWait` runs the moment
 * it is first told to wait, answered or not.
 */
async function play(mode, { startAt = 0, sampleRate = 44100, trackId = 1, next = null, during = null, onWait = null, startFails = false } = {}) {
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
    else if (msg.t === 'wait') {
      seen.wait.push(msg.on);
      if (msg.on && seen.wait.length === 1) onWait?.();
    }
    if (msg.t === 'seg') seen.segs.push(msg.token);
    if (msg.t !== 'pcm' && msg.t !== 'dur') seen.events.push(msg.t === 'wait' ? `wait:${msg.on}` : msg.t);
  });
  const pump = setInterval(() => port.postMessage({ t: 'credit', gen, consumed: seen.pcm }), 20);
  const request = { gen, ...segment(1, trackId), startAt, sampleRate, next };
  const asked = Date.now();
  const started = await handlers['gapless:start']({ sender }, request);
  seen.startedAfterMs = Date.now() - asked;
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

// A decoder that has to open the file again after a failed read gets as long
// to do it as one opening it for the first time.
const resumeSlow = await play('resumeslow');
assert.deepEqual(resumeSlow.fail, [], `resumeslow: the track did not fail (${JSON.stringify(resumeSlow.fail)})`);
assert.ok(resumeSlow.seconds > SECONDS - 0.5 && resumeSlow.seconds < SECONDS + 0.5, `resumeslow: the whole track played once the file opened: ${resumeSlow.seconds.toFixed(2)} s of ${SECONDS}`);

// A decoder that comes back at another rate can't carry the track on, and the track has not ended.
const rateChange = await play('ratechange');
assert.equal(rateChange.fail.length, 1, `ratechange: the track failed in-band instead of ending (${JSON.stringify(rateChange.events)})`);
assert.match(rateChange.fail[0].message, /Decode failed partway/);
assert.ok(rateChange.seconds > 19.5 && rateChange.seconds < 20.5, `ratechange: nothing at the other rate reached the stream: ${rateChange.seconds.toFixed(2)} s`);
assert.ok(!rateChange.dur.some((d) => d < SECONDS - 1), `ratechange: the track kept its length (${JSON.stringify(rateChange.dur)})`);

// A failed read that ffmpeg does not report looks like the end of the file:
// a clean exit, well short of the track's length. It is read on from there.
const quiet = await play('quiet');
assert.deepEqual(quiet.fail, [], 'quiet: the track did not fail');
assert.ok(quiet.seconds > SECONDS - 0.5 && quiet.seconds < SECONDS + 0.5, `quiet: the whole track played after a decoder stopped at 20 s without a word: ${quiet.seconds.toFixed(2)} s of ${SECONDS}`);
assert.ok(!quiet.dur.some((d) => d < SECONDS - 1), `quiet: the track kept its length (duration updates: ${JSON.stringify(quiet.dur)})`);
assert.ok(waitEndsBeforeTheEnd(quiet), 'quiet: nothing was still being waited on at the end');

// A file that really is shorter than the library says ends where it ends:
// one more decoder confirms there is nothing after it, and no more than one.
const stale = await play('none', { trackId: 6, next: segment(2, 2) });
assert.deepEqual(stale.fail, [], 'stale length: nothing failed');
assert.deepEqual(stale.segs, [1, 2], 'stale length: the next track followed');
assert.ok(stale.seconds > 50 - 0.5 && stale.seconds < 50 + 0.5, `stale length: 40 s of the first track, then the 10 s of the next: ${stale.seconds.toFixed(2)} s`);
assert.ok(stale.dur.some((d) => Math.abs(d - 40) < 0.1), `stale length: the track's real length was reported (${JSON.stringify(stale.dur)})`);
assert.deepEqual(stale.wait, [], `stale length: the renderer was never told to wait (${JSON.stringify(stale.wait)})`);
assert.equal(await runsOf(6), 2, 'stale length: one decode, and one look past its end');

// A file that is not audio fails at once. ffmpeg's word for it ("I/O error")
// is its word for a read the system failed too; the file itself reads fine,
// so it is not opened again and again as if its drive had gone.
{
  const garbage = join(media, 'garbage.flac');
  await writeFile(garbage, Buffer.concat([Buffer.from('fLaC'), Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7919) & 0xff))]));
  sources.set(7, { trackId: 7, path: garbage, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 3, lossless: true, dsd: false });
  const began = Date.now();
  const direct = await play('none', { trackId: 7, startFails: true });
  assert.match(direct.started.error, /Decode failed/, `garbage: ${direct.started.error}`);
  assert.ok(Date.now() - began < 4000, `garbage: the start failed at once (${Date.now() - began} ms)`);
  const chainBegan = Date.now();
  const afterGood = await play('none', { trackId: 2, next: segment(2, 7) });
  assert.equal(afterGood.fail.length, 1, `garbage chained: it failed in-band (${JSON.stringify(afterGood.events)})`);
  assert.equal(afterGood.fail[0].token, 2, 'garbage chained: the failure names the chained track');
  assert.match(afterGood.fail[0].message, /Decode failed/);
  assert.ok(afterGood.seconds > 9.5 && afterGood.seconds < 10.5, `garbage chained: the track before it played whole: ${afterGood.seconds.toFixed(2)} s`);
  assert.ok(Date.now() - chainBegan < 6000, `garbage chained: without waiting on the drive (${Date.now() - chainBegan} ms)`);
}

// So does a file that is not there. ffmpeg says the same of a file on a drive
// that has gone (a pulled drive, an unmapped share), and that one is the
// drive's doing: it is opened again for a while first. Only Windows has drive
// letters; elsewhere a volume that went away takes its folder with it.
{
  const lost = { trackId: 8, path: join(media, 'not-here.flac'), sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: SECONDS, lossless: true, dsd: false };
  sources.set(8, lost);
  const began = Date.now();
  const missing = await play('none', { trackId: 2, next: segment(2, 8) });
  assert.equal(missing.fail.length, 1, `missing: the chained track failed in-band (${JSON.stringify(missing.events)})`);
  assert.match(missing.fail[0].message, /Decode failed/);
  assert.ok(Date.now() - began < 6000, `missing: at once (${Date.now() - began} ms)`);
  const free = process.platform === 'win32' ? [...'ZYXWVUTSRQPONMLKJIHGFED'].find((letter) => !existsSync(`${letter}:\\`)) : null;
  if (free) {
    sources.set(8, { ...lost, path: `${free}:\\Music\\not-here.flac` });
    const awayBegan = Date.now();
    const away = await play('none', { trackId: 2, next: segment(2, 8) });
    assert.equal(away.fail.length, 1, `drive gone: the chained track failed in-band (${JSON.stringify(away.events)})`);
    assert.match(away.fail[0].message, /drive stopped answering/, 'drive gone: and the failure says whose doing it was');
    assert.ok(Date.now() - awayBegan >= 8000, `drive gone: after it was opened again for a while (${Date.now() - awayBegan} ms)`);
  }
  sources.delete(8);
}

// Windows refuses a read of a byte range another handle has locked, which is
// how a drive that has stopped delivering refuses it. Resolves once the part of
// `path` from `fraction` on is locked, with the function that unlocks it.
function holdTail(path, fraction) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $file = [System.IO.File]::Open($args[0], 'Open', 'ReadWrite', 'ReadWrite')
    $from = [long]($file.Length * [double]$args[1])
    $file.Lock($from, $file.Length - $from)
    [Console]::Out.WriteLine('held')
    [Console]::In.ReadLine() | Out-Null
    $file.Close()`;
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } @args`, path, String(fraction)], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolveHeld, reject) => {
    let out = '';
    let err = '';
    helper.stdout.on('data', (chunk) => {
      out += chunk;
      if (!out.includes('held')) return;
      resolveHeld(() => new Promise((released) => {
        if (helper.exitCode != null) return released();
        helper.once('exit', released);
        helper.stdin.end('\n');
      }));
    });
    helper.stderr.on('data', (chunk) => { err += chunk; });
    helper.on('error', reject);
    helper.on('exit', (code) => reject(new Error(`could not lock ${path}: the helper exited ${code}\n${err}`)));
  });
}
const largestDifference = (a, b) => {
  const left = Buffer.concat(a.samples.map((f) => Buffer.from(f.buffer)));
  const right = Buffer.concat(b.samples.map((f) => Buffer.from(f.buffer)));
  const x = new Float32Array(left.buffer, left.byteOffset, left.length / 4);
  const y = new Float32Array(right.buffer, right.byteOffset, right.length / 4);
  let worst = 0;
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
  return worst;
};

// A decoder that stops without a word while the file can't be read to its end
// has not reached the end, however often it is asked: the track fails where
// it stopped, and is not passed off as a shorter one. Root reads any file, so
// there nothing here can make it unreadable.
if (process.platform === 'win32' || process.getuid?.() !== 0) {
  const path = sources.get(1).path;
  const release = process.platform === 'win32' ? await holdTail(path, 0.4) : () => chmod(path, 0o644);
  let quietHeld;
  try {
    quietHeld = await play('quietheld');
  } finally {
    await release();
  }
  assert.equal(quietHeld.fail.length, 1, `quietheld: the track failed in-band instead of ending (${JSON.stringify(quietHeld.events)})`);
  assert.match(quietHeld.fail[0].message, /partway through the track/);
  assert.ok(quietHeld.seconds > 19.5 && quietHeld.seconds < 20.5, `quietheld: the 20 s that were read played: ${quietHeld.seconds.toFixed(2)} s`);
  assert.ok(!quietHeld.dur.some((d) => d < SECONDS - 1), `quietheld: the track kept its length (duration updates: ${JSON.stringify(quietHeld.dur)})`);
  assert.ok(waitEndsBeforeTheEnd(quietHeld), 'quietheld: the wait ended before the stream did');
}

// A lookup that never comes back fails the start, so the decks get the track.
{
  const began = Date.now();
  const unanswered = await play('none', { trackId: NEVER_ANSWERS, startFails: true });
  assert.match(unanswered.started.error, /Timed out reading the track/, `no answer: ${unanswered.started.error}`);
  assert.ok(Date.now() - began < 12_000, `no answer: the start gave up at its limit (${Date.now() - began} ms)`);
}

// The real ffmpeg, with no stand-in, against reads that really fail. Only on
// Windows: elsewhere a lock on a byte range is advisory and stops no read.
let locked = 'not run on this platform';
if (process.platform === 'win32') {
  process.env.NEWAMP_FFMPEG_PATH = ffmpeg;
  const kinds = [
    ['flac', [], 0],
    ['mp3', [], 1e-6],
    ['ogg', [], 1e-6],
    // The index at the front, as a music store's file has it; ffmpeg writes it at the end, inside what gets locked.
    ['m4a', ['-movflags', '+faststart'], 1e-6],
  ];
  let id = 20;
  for (const [kind, extra, tolerance] of kinds) {
    id += 1;
    sources.set(id, source(id, `real.${kind}`, SECONDS, extra));
    const whole = await play('none', { trackId: id });
    assert.ok(whole.seconds > SECONDS - 0.5 && whole.seconds < SECONDS + 0.5, `${kind}: the file plays whole when nothing is wrong: ${whole.seconds.toFixed(2)} s`);
    // The read fails two fifths of the way in and starts working again a moment after the renderer hears of it.
    const release = await holdTail(sources.get(id).path, 0.4);
    let resumed;
    try {
      resumed = await play('none', { trackId: id, onWait: () => setTimeout(release, 500) });
    } finally {
      await release();
    }
    assert.deepEqual(resumed.fail, [], `${kind}, a read that failed for a while: the track did not fail (${JSON.stringify(resumed.fail)})`);
    assert.ok(!resumed.dur.some((d) => d < SECONDS - 1), `${kind}: the track kept its length (duration updates: ${JSON.stringify(resumed.dur)})`);
    // More than once for a file small enough that a read from another offset gets a little further before it is refused.
    assert.ok(resumed.wait[0] === true && resumed.wait.at(-1) === false, `${kind}: the renderer heard the wait begin and end (${JSON.stringify(resumed.wait)})`);
    assert.ok(waitEndsBeforeTheEnd(resumed), `${kind}: the wait ended before the stream did`);
    assert.equal(resumed.frames, whole.frames, `${kind}: as many frames as when nothing failed (${resumed.frames} against ${whole.frames})`);
    const worst = largestDifference(whole, resumed);
    assert.ok(worst <= tolerance, `${kind}: nothing is missing or repeated where the read failed (largest difference ${worst})`);
  }

  // The read never starts working again: the track fails where it stopped. It
  // does not end there as a shorter track. (The file system says another
  // program holds the file, which is so, and that is not waited on for as
  // long as a drive that went away.)
  const flac = 21;
  let release = await holdTail(sources.get(flac).path, 0.4);
  let lost;
  try {
    lost = await play('none', { trackId: flac });
  } finally {
    await release();
  }
  assert.equal(lost.fail.length, 1, `flac, a read that kept failing: the track failed in-band (${JSON.stringify(lost.events)})`);
  assert.match(lost.fail[0].message, /partway through the track/);
  assert.ok(lost.events.indexOf('fail') < lost.events.indexOf('end'), `flac: the failure came before the end of the stream (${JSON.stringify(lost.events)})`);
  assert.ok(lost.seconds > 10 && lost.seconds < 40, `flac: what could be read played: ${lost.seconds.toFixed(2)} s`);
  assert.ok(!lost.dur.some((d) => d < SECONDS - 1), `flac: the track kept its length (duration updates: ${JSON.stringify(lost.dur)})`);
  assert.ok(waitEndsBeforeTheEnd(lost), 'flac: the wait ended before the stream did');

  // A seek into the part that can't be read fails the start, so the decks get
  // the track. Nothing ends as if it had played out.
  release = await holdTail(sources.get(flac).path, 0.4);
  let unsought;
  try {
    unsought = await play('none', { trackId: flac, startAt: 45, startFails: true });
  } finally {
    await release();
  }
  assert.equal(unsought.end, 0, `flac, a seek into a read that fails: no end (${JSON.stringify(unsought.events)})`);
  assert.match(unsought.started.error, /Decode failed/, `flac: ${unsought.started.error}`);
  process.env.NEWAMP_FFMPEG_PATH = flaky;
  locked = `${kinds.map(([kind]) => kind).join(', ')} resumed exactly after a read the system refused`;
}

// The first run of a newly installed ffmpeg can be slow, and the check for
// which resampler it has is one. A track at the stream's own rate does not
// wait for it; a track that has to be resampled does, and then plays whole.
{
  process.env.FLAKY_PROBE_DELAY_MS = '4000';
  const earlier = handlers;
  handlers = register(await import(`${bundle}?slowprobe`));
  try {
    const direct = await play('none', { trackId: 2 });
    assert.ok(direct.startedAfterMs < 2500, `slow probe: a track that needs no resampler started without it (${direct.startedAfterMs} ms)`);
    assert.ok(direct.seconds > 9.5 && direct.seconds < 10.5, `slow probe: and played whole: ${direct.seconds.toFixed(2)} s`);
    const resampled = await play('none', { trackId: 2, sampleRate: 48000 });
    assert.deepEqual(resampled.fail, [], 'slow probe: a resampled track did not fail');
    assert.ok(Math.abs(resampled.frames / 48000 - 10) < 0.05, `slow probe: a resampled track played whole once the probe answered: ${(resampled.frames / 48000).toFixed(2)} s`);
  } finally {
    handlers = earlier;
    delete process.env.FLAKY_PROBE_DELAY_MS;
  }
}

// A drive that was waited for and did not come back is not waited for again by
// the next track from it, whether that track fails on a read or on being
// opened. Audio from the drive makes it a drive like any other again.
{
  process.env.NEWAMP_READ_GIVEN_UP_MS = '20000';
  const earlier = handlers;
  const noting = await import(`${bundle}?gone`);
  handlers = register(noting);
  // Where no drive letter says which storage a file is on, its library folder does.
  noting.setStorageRoots([media]);
  try {
    const first = await play('seekgone', { startAt: 30, startFails: true });
    assert.match(first.started.error, /drive stopped answering/, `gone drive: ${first.started.error}`);
    assert.ok(first.startedAfterMs >= 3500, `gone drive: the first track is waited on for the whole outage (${first.startedAfterMs} ms)`);
    const next = await play('seekgone', { trackId: 3, startAt: 30, startFails: true });
    assert.match(next.started.error, /drive stopped answering/, `gone drive, next track: ${next.started.error}`);
    assert.ok(next.startedAfterMs < 2000, `gone drive: the next track from it fails at once (${next.startedAfterMs} ms)`);
    const unopened = await play('opengone', { trackId: 3, startFails: true });
    assert.match(unopened.started.error, /drive stopped answering/, `gone drive, a track that will not open: ${unopened.started.error}`);
    assert.ok(unopened.startedAfterMs < 2000, `gone drive: and is not opened again and again (${unopened.startedAfterMs} ms)`);
    const back = await play('once');
    assert.deepEqual(back.fail, [], 'drive back: the track did not fail');
    assert.ok(back.seconds > SECONDS - 0.5 && back.seconds < SECONDS + 0.5, `drive back: a read that fails once it is back is waited on, and the track plays whole: ${back.seconds.toFixed(2)} s`);
    assert.deepEqual(back.wait, [true, false], `drive back: the renderer heard that wait (${JSON.stringify(back.wait)})`);
  } finally {
    handlers = earlier;
    process.env.NEWAMP_READ_GIVEN_UP_MS = '1';
  }
}

// Decoders stuck in a read can't be stopped. No more than two of them are left
// running at once: the file is not read again beside them, and the track fails
// when the outage has lasted too long. A longer outage than above, so there is
// time for more of them to be started if nothing held them back.
{
  process.env.NEWAMP_DECODE_OUTAGE_MS = '12000';
  process.env.NEWAMP_DECODE_STALL_MS = '1000';
  process.env.NEWAMP_DECODE_OPEN_STALL_MS = '1500';
  const first = handlers;
  handlers = register(await import(`${bundle}?stuck`));
  const pids = `${sources.get(1).path}.pids`;
  await rm(pids, { force: true });
  globalThis.__decodersCannotBeStopped = true;
  let stuck;
  try {
    stuck = await play('stuck');
  } finally {
    globalThis.__decodersCannotBeStopped = false;
    for (const pid of (await readFile(pids, 'utf8').catch(() => '')).split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid));
      } catch {
        /* already gone */
      }
    }
    handlers = first;
  }
  assert.equal(await runsOf(1), 2, 'stuck: the file was read again once, and not again beside two decoders that would not stop');
  assert.equal(stuck.fail.length, 1, `stuck: the track failed in-band (${JSON.stringify(stuck.events)})`);
  assert.match(stuck.fail[0].message, /drive stopped answering/);
  assert.ok(waitEndsBeforeTheEnd(stuck), 'stuck: the wait ended before the stream did');
}

// Every decoder started on one of these files was limited to files and pipes.
{
  const decoders = (await readFile(join(root, 'runs.log'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((args) => args[args.indexOf('-i') + 1].startsWith(media));
  assert.ok(decoders.length > 50, `the decoders that ran were noted (${decoders.length})`);
  for (const args of decoders) {
    const whitelist = args.indexOf('-protocol_whitelist');
    assert.ok(whitelist >= 0 && args[whitelist + 1] === 'file,pipe' && whitelist < args.indexOf('-i'), `limited to files and pipes: ${args.join(' ')}`);
  }
}

clearTimeout(deadline);
await rm(root, { recursive: true, force: true });
console.log(`[gapless-read-resume-test] ok: ${once.seconds.toFixed(2)} s after one failed read, ${every8.seconds.toFixed(2)} s after seven, a share that stayed gone failed the track at ${gone.seconds.toFixed(2)} s, plus seeks into failed reads, a hung decoder, resampling, a chained track, a cut, a decoder that stopped without a word, a stale length and stuck decoders; real ffmpeg: ${locked}`);
process.exit(0);
