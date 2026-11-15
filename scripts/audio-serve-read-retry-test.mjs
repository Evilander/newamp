// The decks read a track through audio-serve's range responses. A read that
// fails partway (a network share timing out) used to error the response body,
// and Chromium then gave the track up and the queue moved on. The read is now
// tried again at the same offset until the share answers, so the body arrives
// late but whole. Anything that is not the storage failing still errors. The
// same goes for the stat that opens the response, and for a transcoded body
// (wma, ape, wv, dsf): a decoder that stops on a failed read starts again where
// it stopped instead of the body being padded with silence.
// A stand-in fs/promises wraps the real one and fails reads, opens and stats as
// told; a stand-in ffmpeg cuts a decode short the way a failed read does, in
// the words macOS and Windows give it, without a word, or by giving up.
// Run: node scripts/audio-serve-read-retry-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scriptStandInSpawn } from './lib/script-standin-spawn.mjs';

const root = resolve('tmp', 'audio-serve-read-retry-test', String(process.pid));
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const spawnLog = join(root, 'spawns.log');
await writeFile(spawnLog, '');

// <input>.fail holds {"left": n, "cut": seconds, "how": ...}: the next n PCM
// decodes of that file stop after `cut` seconds. `how` says in what way:
//   (nothing)  with the error a timed-out read gives on macOS, exit 0
//   windows    with the line ffmpeg prints on Windows for a read the system refused, exit 0
//   quiet      with nothing on the log, exit 0: a failed read that is not reported
//   crash      with a message of the stand-in's own, exit 1
//   ends       the file really ends at `cut`: every decode stops there or finds
//              nothing past it, with nothing on the log, exit 0
// "probe": n fails the next n duration probes with a read error. Everything
// else goes to the real ffmpeg. Every run with an input is noted in spawns.log.
const flaky = join(root, 'flaky-ffmpeg.mjs');
await writeFile(flaky, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const at = args.indexOf('-i');
const input = at >= 0 ? args[at + 1] : '';
if (at >= 0) appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(args) + '\\n');
const control = input + '.fail';
const plan = existsSync(control) ? JSON.parse(readFileSync(control, 'utf8')) : { left: 0 };
const pcm = args.includes('pipe:1');
const ssAt = args.indexOf('-ss');
const from = ssAt >= 0 && ssAt < at ? Number(args[ssAt + 1]) : 0;
const decodeFor = (seconds, then) => {
  const cut = [...args.slice(0, at), '-t', String(seconds), ...args.slice(at)];
  spawn(${JSON.stringify(ffmpeg)}, cut, { stdio: ['ignore', 'inherit', 'pipe'] }).on('close', then);
};
if (!pcm && plan.probe > 0) {
  writeFileSync(control, JSON.stringify({ ...plan, probe: plan.probe - 1 }));
  process.stderr.write('[in#0 @ 000001a51ab3c680] Error opening input: Operation timed out\\n');
  process.exit(1);
} else if (!(plan.left > 0) || !pcm) {
  spawn(${JSON.stringify(ffmpeg)}, args, { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
} else if (plan.how === 'ends') {
  if (from >= plan.cut) process.exit(0);
  decodeFor(plan.cut - from, () => process.exit(0));
} else {
  writeFileSync(control, JSON.stringify({ ...plan, left: plan.left - 1 }));
  decodeFor(plan.cut, () => {
    if (plan.how === 'crash') {
      process.stderr.write('stand-in: the decoder gave up\\n');
      process.exit(1);
    }
    if (plan.how === 'windows') process.stderr.write('[in#0/wav @ 000001a51ab3c680] Error during demuxing: Permission denied\\n');
    else if (plan.how !== 'quiet') process.stderr.write(input + ': Operation timed out\\n');
    process.exit(0);
  });
}
`);
await chmod(flaky, 0o755);
process.env.NEWAMP_FFMPEG_PATH = flaky;
// Short, so a share that never answers gives up quickly.
process.env.NEWAMP_READ_OUTAGE_MS = '4000';
// And a file another program holds, quicker still.
process.env.NEWAMP_READ_BUSY_MS = '800';
// How long a share that was given up on stays noted as gone.
process.env.NEWAMP_READ_GIVEN_UP_MS = '20000';

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
      contents: `export const app = { getPath: () => ${JSON.stringify(root)}, isPackaged: false }; export default { app };`,
      loader: 'js',
    }));
    b.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'fsp', namespace: 'stub' }));
    b.onLoad({ filter: /^fsp$/, namespace: 'stub' }, () => ({
      contents: `
        import * as real from 'fs/promises';
        export * from 'fs/promises';
        // globalThis.__readFaults: [{ at, code, times }] — a read starting at
        // or past \`at\` throws \`code\` until it has done so \`times\` times.
        // globalThis.__statFault: { path, code, times } — the same for stat(path);
        // with \`under\` in place of \`path\`, for every path that starts with it.
        // globalThis.__statAnswers: Map of path to what stat answers for it, for
        // files on a share that is not really there.
        // globalThis.__openDelayMs holds every open() back; __openHandles is the
        // set of handles it gave out that haven't been closed.
        // globalThis.__openFaults: [{ code, times, afterReadFailures }] — an open
        // throws \`code\` until it has done so \`times\` times, once that many
        // reads have failed.
        export async function stat(path, ...rest) {
          const fault = globalThis.__statFault;
          if (fault && fault.times > 0 && (path === fault.path || (fault.under && String(path).startsWith(fault.under)))) {
            fault.times -= 1;
            globalThis.__statFailures = (globalThis.__statFailures ?? 0) + 1;
            throw Object.assign(new Error(fault.code), { code: fault.code });
          }
          return globalThis.__statAnswers?.get(path) ?? real.stat(path, ...rest);
        }
        export async function open(path, flags) {
          if (globalThis.__openDelayMs) await new Promise((r) => setTimeout(r, globalThis.__openDelayMs));
          for (const fault of globalThis.__openFaults ?? []) {
            if (fault.times > 0 && (globalThis.__readFailures ?? 0) >= (fault.afterReadFailures ?? 0)) {
              fault.times -= 1;
              throw Object.assign(new Error(fault.code), { code: fault.code });
            }
          }
          const handle = await real.open(path, flags);
          (globalThis.__openHandles ??= new Set()).add(handle);
          const close = handle.close.bind(handle);
          handle.close = async () => {
            globalThis.__openHandles.delete(handle);
            return close();
          };
          const read = handle.read.bind(handle);
          handle.read = async (buffer, offset, length, position) => {
            for (const fault of globalThis.__readFaults ?? []) {
              if (position >= fault.at && fault.times > 0) {
                fault.times -= 1;
                globalThis.__readFailures = (globalThis.__readFailures ?? 0) + 1;
                throw Object.assign(new Error(fault.code), { code: fault.code });
              }
            }
            return read(buffer, offset, length, position);
          };
          return handle;
        }
        export default { ...real, open, stat };`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

await build({
  stdin: { contents: `export { fileBody, fileRangeResponse, seekableTranscodeResponse } from './electron/audio-serve.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['ffmpeg-static'],
  plugins: [stubs, scriptStandInSpawn],
  outfile: join(root, 'bundle.mjs'),
  logLevel: 'silent',
});
const { fileBody, fileRangeResponse, seekableTranscodeResponse } = await import(pathToFileURL(join(root, 'bundle.mjs')).href);

const deadline = setTimeout(() => {
  console.error('audio-serve read retry test timed out');
  process.exit(1);
}, 240_000);

const file = join(root, 'track.mp3');
const bytes = randomBytes(3 * 1024 * 1024 + 123);
await writeFile(file, bytes);
const request = (range, signal) => new Request('newamp://track', { ...(range ? { headers: { Range: range } } : {}), signal });

// Two timed-out reads a megabyte in, then the share answers: the whole file arrives.
globalThis.__readFaults = [{ at: 1024 * 1024, code: 'ETIMEDOUT', times: 2 }];
globalThis.__readFailures = 0;
const started = Date.now();
const whole = await fileRangeResponse(file, request(null));
assert.equal(whole.status, 200);
const wholeBody = Buffer.from(await whole.arrayBuffer());
assert.equal(globalThis.__readFailures, 2, 'both faults were hit');
assert.ok(wholeBody.equals(bytes), `the body is the whole file (${wholeBody.length} of ${bytes.length} bytes)`);
const waited = Date.now() - started;
assert.ok(waited >= 2500, `it waited between tries (${waited} ms)`);

// The same through a range, as the decks ask after a seek.
globalThis.__readFaults = [{ at: 2 * 1024 * 1024, code: 'EIO', times: 1 }];
const ranged = await fileRangeResponse(file, request('bytes=1500000-'));
assert.equal(ranged.status, 206);
assert.equal(ranged.headers.get('Content-Range'), `bytes 1500000-${bytes.length - 1}/${bytes.length}`);
const rangedBody = Buffer.from(await ranged.arrayBuffer());
assert.ok(rangedBody.equals(bytes.subarray(1500000)), 'the ranged body is the rest of the file');

// A failure that isn't the storage (here a permissions error) still errors the body.
globalThis.__readFaults = [{ at: 0, code: 'EACCES', times: 1 }];
const denied = await fileRangeResponse(file, request('bytes=0-'));
await assert.rejects(denied.arrayBuffer(), 'a non-storage error errors the body');

// The stat that opens the response is waited on too: a 404 here would make
// Chromium give the track up.
globalThis.__readFaults = [];
globalThis.__statFault = { path: file, code: 'ETIMEDOUT', times: 2 };
globalThis.__statFailures = 0;
const statStarted = Date.now();
const afterStat = await fileRangeResponse(file, request('bytes=0-99'));
assert.equal(afterStat.status, 206, 'the response came once the stat answered');
assert.equal(globalThis.__statFailures, 2, 'both stat faults were hit');
assert.ok(Date.now() - statStarted >= 2500, 'it waited between tries');
assert.ok(Buffer.from(await afterStat.arrayBuffer()).equals(bytes.subarray(0, 100)));

// A stat that never answers is a 503 once the outage has lasted long enough, not a 404.
globalThis.__statFault = { path: file, code: 'EIO', times: 1000 };
const unavailable = await fileRangeResponse(file, request(null));
assert.equal(unavailable.status, 503, 'a storage error that outlasts the wait is not "not found"');

// Chromium asks again for a response that failed, many times over. The next
// request for the file does not wait the same outage out a second time.
const againStarted = Date.now();
const again = await fileRangeResponse(file, request(null));
assert.equal(again.status, 503, 'still unavailable');
assert.ok(Date.now() - againStarted < 500, `and said so at once (${Date.now() - againStarted} ms)`);

// Once the file has answered, the next outage gets a wait of its own.
globalThis.__statFault = null;
const back = await fileRangeResponse(file, request('bytes=0-9'));
assert.equal(back.status, 206, 'the file answers again');
await back.arrayBuffer();
globalThis.__statFault = { path: file, code: 'ETIMEDOUT', times: 1 };
const freshStarted = Date.now();
const fresh = await fileRangeResponse(file, request('bytes=0-9'));
assert.equal(fresh.status, 206, 'a later outage is waited on again');
assert.ok(Date.now() - freshStarted >= 900, `for as long as it takes (${Date.now() - freshStarted} ms)`);
await fresh.arrayBuffer();
globalThis.__statFault = null;

// A wait nobody is waiting for any more (a seek, a skip) ends.
{
  const left = join(root, 'left.mp3');
  await writeFile(left, bytes.subarray(0, 1000));
  globalThis.__statFault = { path: left, code: 'ETIMEDOUT', times: 1000 };
  const leaving = new AbortController();
  setTimeout(() => leaving.abort(), 200);
  const leftStarted = Date.now();
  const unheard = await fileRangeResponse(left, request(null, leaving.signal));
  assert.equal(unheard.status, 503);
  assert.ok(Date.now() - leftStarted < 2500, `the stat was not waited on to the end of the outage (${Date.now() - leftStarted} ms)`);
  globalThis.__statFault = null;
}

// And the file after it. A share that was waited for and did not come back is
// not waited for again by the next track from it, a file from somewhere else
// gets its wait as ever, and one read from the share makes it a share like
// any other again. The paths stand for a share that is not there: a stat of
// one fails or answers as it is told to.
{
  const share = process.platform === 'win32' ? 'X:\\Gone' : '/Volumes/Gone';
  const onShare = (name) => join(share, name);
  globalThis.__statFault = { under: share, code: 'ETIMEDOUT', times: 1000 };
  const firstStarted = Date.now();
  assert.equal((await fileRangeResponse(onShare('one.mp3'), request(null))).status, 503);
  assert.ok(Date.now() - firstStarted >= 3500, `the first file from it is waited on for the whole outage (${Date.now() - firstStarted} ms)`);
  const nextStarted = Date.now();
  assert.equal((await fileRangeResponse(onShare('two.mp3'), request(null))).status, 503, 'the next file from it is unavailable too');
  assert.ok(Date.now() - nextStarted < 500, `and says so at once (${Date.now() - nextStarted} ms)`);

  globalThis.__statFault = { path: file, code: 'ETIMEDOUT', times: 1 };
  const elsewhereStarted = Date.now();
  const elsewhere = await fileRangeResponse(file, request('bytes=0-9'));
  assert.equal(elsewhere.status, 206, 'a file on another drive is served');
  assert.ok(Date.now() - elsewhereStarted >= 900, `after the wait any first failure gets (${Date.now() - elsewhereStarted} ms)`);
  await elsewhere.arrayBuffer();

  globalThis.__statFault = null;
  globalThis.__statAnswers = new Map([[onShare('three.mp3'), { size: 10, mtimeMs: 0 }], [onShare('two.mp3'), { size: 10, mtimeMs: 0 }]]);
  const answered = await fileRangeResponse(onShare('three.mp3'), request(null));
  assert.equal(answered.status, 200, 'the share answers for a file');
  await answered.body.cancel();
  globalThis.__statFault = { under: share, code: 'ETIMEDOUT', times: 1 };
  const returnedStarted = Date.now();
  const returned = await fileRangeResponse(onShare('two.mp3'), request(null));
  assert.equal(returned.status, 200, 'and is a share like any other again');
  assert.ok(Date.now() - returnedStarted >= 900, `whose next failure is waited on (${Date.now() - returnedStarted} ms)`);
  await returned.body.cancel();
  globalThis.__statFault = null;
  globalThis.__statAnswers = null;
}

// A file that isn't there is a 404 at once.
const missingStarted = Date.now();
const missing = await fileRangeResponse(join(root, 'missing.mp3'), request(null));
assert.equal(missing.status, 404);
assert.ok(Date.now() - missingStarted < 500, 'no waiting for a file that is not there');

// Unless its whole drive is what isn't there: a pulled drive or an unmapped
// share leaves a letter with nothing behind it, and every file on it reads as
// missing. That is waited on, and is not "not found". Only Windows has drive
// letters; elsewhere a volume that went away takes its folder with it.
if (process.platform === 'win32') {
  const free = [...'ZYXWVUTSRQPONMLKJIHGFED'].find((letter) => !existsSync(`${letter}:\\`));
  if (free) {
    const awayStarted = Date.now();
    const away = await fileRangeResponse(`${free}:\\Music\\song.mp3`, request(null));
    assert.equal(away.status, 503, 'a file on a drive that has gone is unavailable, not missing');
    assert.ok(Date.now() - awayStarted >= 2500, `after waiting for the drive (${Date.now() - awayStarted} ms)`);
  }
}

// A share that drops fails the read, and for a moment the file is not there to
// be opened again either. That is the same outage, not a missing file.
globalThis.__readFailures = 0;
globalThis.__readFaults = [{ at: 1024 * 1024, code: 'ECONNRESET', times: 1 }];
globalThis.__openFaults = [{ code: 'ENOENT', times: 1, afterReadFailures: 1 }];
const dropped = await fileRangeResponse(file, request(null));
const droppedBody = Buffer.from(await dropped.arrayBuffer());
assert.equal(globalThis.__openFaults[0].times, 0, 'the open was refused once');
assert.ok(droppedBody.equals(bytes), `the body is the whole file all the same (${droppedBody.length} of ${bytes.length} bytes)`);

// A file that is gone when nothing else was wrong is not waited on.
globalThis.__readFaults = [];
globalThis.__openFaults = [{ code: 'ENOENT', times: 1 }];
const goneStarted = Date.now();
const gone = await fileRangeResponse(file, request(null));
await assert.rejects(gone.arrayBuffer(), 'a file that vanished errors the body');
assert.ok(Date.now() - goneStarted < 500, `at once (${Date.now() - goneStarted} ms)`);
globalThis.__openFaults = [];

// A response cancelled while its file is still opening doesn't leave the file open.
globalThis.__openHandles = new Set();
globalThis.__openDelayMs = 200;
const cancelled = fileBody(file, 0, bytes.length - 1);
await new Promise((r) => setTimeout(r, 50));
await cancelled.cancel();
await new Promise((r) => setTimeout(r, 500));
assert.equal(globalThis.__openHandles.size, 0, 'the file opened after the cancel was closed');
globalThis.__openDelayMs = 0;

// EBUSY on Windows is another program holding the file, which is waited on for
// a moment and not for as long as a share that went away. Elsewhere it is a
// busy device and gets the whole wait.
globalThis.__readFaults = [{ at: 0, code: 'EBUSY', times: 1000 }];
const heldStarted = Date.now();
const held = await fileRangeResponse(file, request(null));
await assert.rejects(held.arrayBuffer(), 'a file that stays busy errors the body');
const heldFor = Date.now() - heldStarted;
if (process.platform === 'win32') assert.ok(heldFor >= 900 && heldFor < 2500, `a held file is given up on in a moment (${heldFor} ms)`);
else assert.ok(heldFor >= 3500, `a busy device is waited on like any storage error (${heldFor} ms)`);
globalThis.__readFaults = [];

// ffmpeg-mode formats: a decode that stops on a failed read is read again from
// where it stopped, so the body is the whole track and not silence after the stop.
const wav = join(root, 'track.wav');
const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=10', '-ac', '2', wav], { encoding: 'utf8' });
if (made.status !== 0) throw new Error(made.stderr);
const reference = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-map', '0:a:0', '-vn', '-acodec', 'pcm_f32le', '-ac', '2', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30 }).stdout;
const PRELUDE = 58;
const control = `${wav}.fail`;

await writeFile(control, JSON.stringify({ left: 2, cut: 3 }));
const transcoded = await seekableTranscodeResponse(wav, request(null));
assert.equal(transcoded.status, 200);
const transcodedBody = Buffer.from(await transcoded.arrayBuffer());
assert.equal(transcodedBody.length, PRELUDE + reference.length, 'the promised length');
assert.ok(transcodedBody.subarray(PRELUDE).equals(reference), 'the transcoded body is the track, with nothing missing or repeated at the two failed reads');

// The same from the middle of a frame, as the decks ask after a seek.
await writeFile(control, JSON.stringify({ left: 1, cut: 2 }));
const from = PRELUDE + 1_000_001;
const rangedPcm = await seekableTranscodeResponse(wav, request(`bytes=${from}-`));
assert.equal(rangedPcm.status, 206);
const rangedPcmBody = Buffer.from(await rangedPcm.arrayBuffer());
assert.ok(rangedPcmBody.equals(reference.subarray(1_000_001)), 'the ranged transcoded body is the rest of the track');

// What ffmpeg prints on Windows for a read the system refused is a failed read like the others.
await writeFile(control, JSON.stringify({ left: 2, cut: 3, how: 'windows' }));
const refused = Buffer.from(await (await seekableTranscodeResponse(wav, request(null))).arrayBuffer());
assert.ok(refused.subarray(PRELUDE).equals(reference), 'a read Windows refused is read again, and the body is the whole track');

// So is one ffmpeg does not report at all: a clean exit, well short of the track's length.
await writeFile(control, JSON.stringify({ left: 1, cut: 3, how: 'quiet' }));
const unreported = Buffer.from(await (await seekableTranscodeResponse(wav, request(null))).arrayBuffer());
assert.ok(unreported.subarray(PRELUDE).equals(reference), 'a decoder that stopped without a word is carried on from where it stopped');

// A decoder that gives up partway errors the body. Silence up to the promised
// length would pass for the rest of the song.
await writeFile(control, JSON.stringify({ left: 1, cut: 3, how: 'crash' }));
const crashed = await seekableTranscodeResponse(wav, request(null));
await assert.rejects(crashed.arrayBuffer(), 'a decoder that gave up at 3 s of 10 errors the body');

// A file that really ends before the length its header gives still gets its
// silence: a second decoder finds nothing after the first, so that is the end.
await writeFile(control, JSON.stringify({ left: 1, cut: 6, how: 'ends' }));
const shorter = Buffer.from(await (await seekableTranscodeResponse(wav, request(null))).arrayBuffer());
const sixSeconds = 6 * 44100 * 8;
assert.equal(shorter.length, PRELUDE + reference.length, 'the promised length');
assert.ok(shorter.subarray(PRELUDE, PRELUDE + sixSeconds).equals(reference.subarray(0, sixSeconds)), 'the six seconds the file holds');
assert.ok(shorter.subarray(PRELUDE + sixSeconds).every((byte) => byte === 0), 'then silence, not an error');
await rm(control);

// A decoder that carries on a lossy track starts a little before the stop:
// the first frames decoded after a seek are not what the track has there.
{
  const mp3 = join(root, 'lossy.mp3');
  const madeMp3 = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=10', '-ac', '2', mp3], { encoding: 'utf8' });
  if (madeMp3.status !== 0) throw new Error(madeMp3.stderr);
  const unbroken = Buffer.from(await (await seekableTranscodeResponse(mp3, request(null))).arrayBuffer()).subarray(PRELUDE);
  await writeFile(`${mp3}.fail`, JSON.stringify({ left: 1, cut: 3 }));
  const carriedOn = Buffer.from(await (await seekableTranscodeResponse(mp3, request(null))).arrayBuffer()).subarray(PRELUDE);
  assert.equal(carriedOn.length, unbroken.length);
  const floats = (pcm) => {
    const out = new Float32Array(pcm.length / 4);
    Buffer.from(out.buffer).set(pcm);
    return out;
  };
  const x = floats(unbroken);
  const y = floats(carriedOn);
  let worst = 0;
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
  assert.ok(worst < 1e-4, `an MP3 carried on after a failed read at 3 s is the track it would have been (largest difference ${worst})`);
}

// The stat before the duration probe is waited on like any other. Falling back
// to the live pipe for it would play the track with no length and no seeking.
globalThis.__statFault = { path: wav, code: 'ETIMEDOUT', times: 2 };
const afterWait = await seekableTranscodeResponse(wav, request(null));
assert.equal(afterWait.status, 200);
assert.equal(afterWait.headers.get('Accept-Ranges'), 'bytes', 'a stat that timed out twice still ends in the seekable response');
assert.equal(afterWait.headers.get('Content-Length'), String(PRELUDE + reference.length));
await afterWait.body.cancel();
{
  const unanswered = join(root, 'unanswered.wav');
  await copyFile(wav, unanswered);
  globalThis.__statFault = { path: unanswered, code: 'ETIMEDOUT', times: 1000 };
  assert.equal((await seekableTranscodeResponse(unanswered, request(null))).status, 503, 'a stat that never answers is a 503, not a track without a length');
  globalThis.__statFault = null;
}

// So is the probe itself when the read of the header fails.
{
  const probed = join(root, 'probed.wav');
  await copyFile(wav, probed);
  await writeFile(`${probed}.fail`, JSON.stringify({ probe: 2 }));
  const afterProbe = await seekableTranscodeResponse(probed, request(null));
  assert.equal(afterProbe.headers.get('Accept-Ranges'), 'bytes', 'a probe whose read failed twice still ends in the seekable response');
  await afterProbe.body.cancel();
  const unprobed = join(root, 'unprobed.wav');
  await copyFile(wav, unprobed);
  await writeFile(`${unprobed}.fail`, JSON.stringify({ probe: 1000 }));
  assert.equal((await seekableTranscodeResponse(unprobed, request(null))).status, 503, 'a probe that can never read the file is a 503');
}

// A file that is not audio is not waited on as if its drive had gone, though
// ffmpeg's word for it ("I/O error") is its word for a failed read too: the
// file reads fine, so the request falls back to the live pipe at once.
{
  const garbage = join(root, 'garbage.wma');
  await writeFile(garbage, Buffer.concat([Buffer.from('fLaC'), Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7919) & 0xff))]));
  const garbageStarted = Date.now();
  const unplayable = await seekableTranscodeResponse(garbage, request(null));
  assert.equal(unplayable.headers.get('Accept-Ranges'), 'none', 'the live pipe, for a file the probe could make nothing of');
  assert.ok(Date.now() - garbageStarted < 2500, `answered at once (${Date.now() - garbageStarted} ms)`);
  await assert.rejects(unplayable.arrayBuffer(), 'and its body errors');
}

// A request that is already gone starts no decoder.
{
  const decodersStarted = async () => (await readFile(spawnLog, 'utf8')).split('\n').filter((line) => line.includes('pipe:1')).length;
  const before = await decodersStarted();
  const gone = new AbortController();
  gone.abort();
  const unwanted = await seekableTranscodeResponse(wav, request(null, gone.signal));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await decodersStarted(), before, 'no decoder for a request that was aborted before it was answered');
  await unwanted.body.cancel().catch(() => undefined);
}

// A share that stays gone errors the body; the song is not padded out in silence.
await writeFile(control, JSON.stringify({ left: 1000, cut: 0.5 }));
const lost = await seekableTranscodeResponse(wav, request(null));
await assert.rejects(lost.arrayBuffer(), 'a decode that keeps failing errors the body');

// Every ffmpeg that was given one of these files was limited to files and pipes.
{
  const runs = (await readFile(spawnLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(runs.some((args) => args.includes('pipe:1')) && runs.some((args) => !args.includes('pipe:1')), 'the decoder and the duration probe both ran');
  for (const args of runs) {
    const whitelist = args.indexOf('-protocol_whitelist');
    assert.ok(whitelist >= 0 && args[whitelist + 1] === 'file,pipe' && whitelist < args.indexOf('-i'), `limited to files and pipes: ${args.join(' ')}`);
  }
}

clearTimeout(deadline);
await rm(root, { recursive: true, force: true });
console.log(`[audio-serve-read-retry-test] ok: whole file after two timed-out reads (${waited} ms), ranged read after an EIO, EACCES still errors, stat retried, one wait per outage, a cancel during open closes the file, transcoded bodies read again, carried on or failed, never padded out after a decoder that stopped early`);
