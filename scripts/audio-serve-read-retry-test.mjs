// The decks read a track through audio-serve's range responses. A read that
// fails partway (a network share timing out) used to error the response body,
// and Chromium then gave the track up and the queue moved on. The read is now
// tried again at the same offset until the share answers, so the body arrives
// late but whole. Anything that is not the storage failing still errors. The
// same goes for the stat that opens the response, and for a transcoded body
// (wma, ape, wv, dsf): a decoder that stops on a failed read starts again where
// it stopped instead of the body being padded with silence.
// A stand-in fs/promises wraps the real one and fails reads and stats as told;
// a stand-in ffmpeg cuts a decode short the way a timed-out read does.
// Run: node scripts/audio-serve-read-retry-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'audio-serve-read-retry-test', String(process.pid));
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

// <input>.fail holds {"left": n, "cut": seconds}: the next n PCM decodes of
// that file stop after `cut` seconds with the error a timed-out read gives.
// The duration probe and everything else goes to the real ffmpeg.
const flaky = join(root, 'flaky-ffmpeg.mjs');
await writeFile(flaky, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const at = args.indexOf('-i');
const input = at >= 0 ? args[at + 1] : '';
const control = input + '.fail';
const plan = existsSync(control) ? JSON.parse(readFileSync(control, 'utf8')) : { left: 0 };
if (!(plan.left > 0) || !args.includes('pipe:1')) {
  spawn(${JSON.stringify(ffmpeg)}, args, { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
} else {
  writeFileSync(control, JSON.stringify({ ...plan, left: plan.left - 1 }));
  const cut = [...args.slice(0, at), '-t', String(plan.cut), ...args.slice(at)];
  spawn(${JSON.stringify(ffmpeg)}, cut, { stdio: ['ignore', 'inherit', 'pipe'] }).on('close', () => {
    process.stderr.write(input + ': Operation timed out\\n');
    process.exit(0);
  });
}
`);
await chmod(flaky, 0o755);
process.env.NEWAMP_FFMPEG_PATH = flaky;
// Short, so a share that never answers gives up quickly.
process.env.NEWAMP_READ_OUTAGE_MS = '4000';

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
        // globalThis.__statFault: { path, code, times } — the same for stat(path).
        // globalThis.__openDelayMs holds every open() back; __openHandles is the
        // set of handles it gave out that haven't been closed.
        export async function stat(path, ...rest) {
          const fault = globalThis.__statFault;
          if (fault && fault.times > 0 && path === fault.path) {
            fault.times -= 1;
            globalThis.__statFailures = (globalThis.__statFailures ?? 0) + 1;
            throw Object.assign(new Error(fault.code), { code: fault.code });
          }
          return real.stat(path, ...rest);
        }
        export async function open(path, flags) {
          if (globalThis.__openDelayMs) await new Promise((r) => setTimeout(r, globalThis.__openDelayMs));
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
  plugins: [stubs],
  outfile: join(root, 'bundle.mjs'),
  logLevel: 'silent',
});
const { fileBody, fileRangeResponse, seekableTranscodeResponse } = await import(pathToFileURL(join(root, 'bundle.mjs')).href);

const deadline = setTimeout(() => {
  console.error('audio-serve read retry test timed out');
  process.exit(1);
}, 90_000);

const file = join(root, 'track.mp3');
const bytes = randomBytes(3 * 1024 * 1024 + 123);
await writeFile(file, bytes);
const request = (range) => new Request('newamp://track', range ? { headers: { Range: range } } : {});

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
globalThis.__statFault = null;

// A file that isn't there is a 404 at once.
const missingStarted = Date.now();
const missing = await fileRangeResponse(join(root, 'missing.mp3'), request(null));
assert.equal(missing.status, 404);
assert.ok(Date.now() - missingStarted < 500, 'no waiting for a file that is not there');

// A response cancelled while its file is still opening doesn't leave the file open.
globalThis.__openHandles = new Set();
globalThis.__openDelayMs = 200;
const cancelled = fileBody(file, 0, bytes.length - 1);
await new Promise((r) => setTimeout(r, 50));
await cancelled.cancel();
await new Promise((r) => setTimeout(r, 500));
assert.equal(globalThis.__openHandles.size, 0, 'the file opened after the cancel was closed');
globalThis.__openDelayMs = 0;

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

// A share that stays gone errors the body; the song is not padded out in silence.
await writeFile(control, JSON.stringify({ left: 1000, cut: 0.5 }));
const lost = await seekableTranscodeResponse(wav, request(null));
await assert.rejects(lost.arrayBuffer(), 'a decode that keeps failing errors the body');

clearTimeout(deadline);
await rm(root, { recursive: true, force: true });
console.log(`[audio-serve-read-retry-test] ok: whole file after two timed-out reads (${waited} ms), ranged read after an EIO, EACCES still errors, stat retried, a cancel during open closes the file, transcoded bodies read again`);
