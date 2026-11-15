// The transcode path on a share that times out. A cached FLAC keeps playing
// when the source can't be statted, an unreadable MP4 is not read as a codec
// verdict, the live WAV ends in an error (not a clean end) when a read fails,
// a failed or stalled encode is not retried on every fetch, old-recipe files
// are dropped, exports leave no half-written file, and silence gets no
// ReplayGain. A stand-in ffmpeg fails, cuts short or stalls on files named for
// it; everything else goes to the real one.
// Run: node scripts/transcode-hardening-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scriptStandInSpawn } from './lib/script-standin-spawn.mjs';

const deadline = setTimeout(() => {
  console.error('transcode hardening test timed out');
  process.exit(1);
}, 180_000);
deadline.unref();

const root = resolve('tmp', 'transcode-hardening-test', String(process.pid));
const media = join(root, 'media');
const cache = join(root, 'cache');
const spawnLog = join(root, 'spawns.log');
const argsLog = join(root, 'args.log');
await rm(root, { recursive: true, force: true });
await mkdir(media, { recursive: true });
await writeFile(spawnLog, '');
await writeFile(argsLog, '');

// A name decides what the stand-in does with a file: "bad" exits 1, "cut" stops
// after two seconds with the error a timed-out read gives, "slow" waits first.
const standIn = join(root, 'standin-ffmpeg.mjs');
await writeFile(standIn, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) {
  console.log('ffmpeg version stand-in');
  process.exit(0);
}
const at = args.indexOf('-i');
const input = at >= 0 ? args[at + 1] : '';
if (at >= 0) appendFileSync(${JSON.stringify(spawnLog)}, input + '\\n');
if (at >= 0) appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const real = (extra, then) => {
  const cutArgs = extra ? [...args.slice(0, at), ...extra, ...args.slice(at)] : args;
  spawn(${JSON.stringify(ffmpeg)}, cutArgs, { stdio: ['ignore', 'inherit', 'pipe'] })
    .on('spawn', function () { this.stderr.pipe(process.stderr); })
    .on('close', (code) => then(code ?? 1));
};
if (/bad/.test(input)) {
  process.stderr.write('stand-in: cannot decode\\n');
  process.exit(1);
} else if (/cut/.test(input)) {
  real(['-t', '2'], () => {
    process.stderr.write('[in#0/wav @ 0x1] Error during demuxing: Operation timed out\\n');
    process.exit(0);
  });
} else if (/slow/.test(input)) {
  setTimeout(() => real(null, (code) => process.exit(code)), 1500);
} else {
  real(null, (code) => process.exit(code));
}
`);
await chmod(standIn, 0o755);
process.env.NEWAMP_FFMPEG_PATH = standIn;

// Storage errors on demand: <path> -> { code, left } for stat, open and realpath.
const failing = { stat: new Map(), open: new Map(), realpath: new Map() };
globalThis.__transcodeHardeningFail = failing;
const fsStub = {
  name: 'fs-stub',
  setup(b) {
    b.onResolve({ filter: /^node:fs\/promises$/ }, (args) =>
      /(mp4-codec|transcode-cache)\.ts$/.test(args.importer) ? { path: 'fs-promises', namespace: 'stub' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        import * as fs from 'node:fs/promises';
        export * from 'node:fs/promises';
        const fail = (kind, path) => {
          const plan = globalThis.__transcodeHardeningFail[kind].get(path);
          if (plan && plan.left > 0) {
            plan.left -= 1;
            throw Object.assign(new Error(plan.code + ': ' + kind + ' ' + path), { code: plan.code });
          }
        };
        export async function stat(path, ...rest) { fail('stat', path); return fs.stat(path, ...rest); }
        export async function open(path, ...rest) { fail('open', path); return fs.open(path, ...rest); }
        export async function realpath(path, ...rest) { fail('realpath', path); return fs.realpath(path, ...rest); }
      `,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};
// The resampler probe's spawn, counted, and failing to start as often as
// globalThis.__resamplerSpawnErrors says (the system out of handles for a moment).
const probeSpawn = {
  name: 'probe-spawn',
  setup(b) {
    b.onResolve({ filter: /^node:child_process$/ }, (args) =>
      args.importer.endsWith('resampler.ts') ? { path: 'child-process', namespace: 'probe-spawn' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'probe-spawn' }, () => ({
      contents: `
        import * as real from 'node:child_process';
        import { EventEmitter } from 'node:events';
        export * from 'node:child_process';
        export function spawn(command, args, options) {
          globalThis.__resamplerSpawns = (globalThis.__resamplerSpawns ?? 0) + 1;
          if (!(globalThis.__resamplerSpawnErrors > 0)) return real.spawn(command, args, options);
          globalThis.__resamplerSpawnErrors -= 1;
          const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => false });
          setImmediate(() => child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })));
          return child;
        }`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};
const bundle = join(root, 'bundle.mjs');
await build({
  stdin: {
    contents: `
      export { mp4SoundCodec } from './electron/mp4-codec.ts';
      export { probeResampler } from './electron/resampler.ts';
      export { getOrTranscodeToFlac, initTranscodeCache, peekCachedFlac } from './electron/transcode-cache.ts';
      export {
        analyzeTrackReplayGain, buildPlaybackFlacArgs, killAllTranscodeFfmpeg, resolvePlaybackMode,
        transcodeToWavResponse, transcodeTrackToAudioFile, watchFfmpegInput, watchFfmpegProgress,
      } from './electron/transcode.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  packages: 'external',
  plugins: [fsStub, probeSpawn, scriptStandInSpawn],
  outfile: bundle,
  logLevel: 'silent',
});
const {
  mp4SoundCodec, probeResampler, getOrTranscodeToFlac, initTranscodeCache, peekCachedFlac,
  analyzeTrackReplayGain, buildPlaybackFlacArgs, killAllTranscodeFfmpeg, resolvePlaybackMode,
  transcodeToWavResponse, transcodeTrackToAudioFile, watchFfmpegInput, watchFfmpegProgress,
} = await import(pathToFileURL(bundle).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawnCount = async (needle) => (await readFile(spawnLog, 'utf8')).split('\n').filter((l) => l && l.includes(needle)).length;
const near = (actual, expected, message, tolerance = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

function sine(name, seconds, extra = []) {
  const path = join(media, name);
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `sine=frequency=440:sample_rate=44100:duration=${seconds}`, '-ac', '2', ...extra, path], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  return path;
}

async function readBody(response) {
  const reader = response.body.getReader();
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

// Files from an earlier recipe are gone after the cache starts; a file of this one stays.
await mkdir(cache, { recursive: true });
await writeFile(join(cache, `${'a'.repeat(40)}.flac`), 'old recipe');
await writeFile(join(cache, `${'b'.repeat(40)}.flac-s32-cl1-v1.flac`), 'older recipe');
initTranscodeCache(cache);
{
  const first = await getOrTranscodeToFlac(join(media, 'nothing-here.wma'));
  assert.deepEqual(first, { ok: false, reason: 'source-missing' }, 'a file that is not there is missing');
  const names = await readdir(cache);
  assert.ok(!names.some((n) => n.startsWith('aaaa') || n.startsWith('bbbb')), `old-recipe files are removed (${names})`);
}

// 1. The cached FLAC keeps playing when the share stops answering for the source.
{
  const song = sine('cached.wav', 3);
  const made = await getOrTranscodeToFlac(song);
  assert.equal(made.ok, true, 'encoded');
  assert.equal(await peekCachedFlac(song), made.path);
  failing.stat.set(song, { code: 'ETIMEDOUT', left: 3 });
  assert.equal(await peekCachedFlac(song), made.path, 'a timed-out stat still finds the cached FLAC');
  assert.deepEqual(await getOrTranscodeToFlac(song), { ok: true, path: made.path }, 'and so does a warm');
  failing.stat.delete(song);
  failing.realpath.set(song, { code: 'EIO', left: 1 });
  assert.equal(await peekCachedFlac(song), made.path, 'a failed realpath does too, instead of keying another entry');

  const unseen = sine('unseen.wav', 2);
  failing.stat.set(unseen, { code: 'ETIMEDOUT', left: 2 });
  assert.equal(await peekCachedFlac(unseen), null, 'a source never cached has nothing to serve');
  assert.deepEqual(await getOrTranscodeToFlac(unseen), { ok: false, reason: 'source-unreadable' }, 'a timeout is not a missing file');
  failing.stat.set(unseen, { code: 'ENOENT', left: 1 });
  assert.deepEqual(await getOrTranscodeToFlac(unseen), { ok: false, reason: 'source-missing' }, 'a missing file is');
}

// 2. A cut-short transcode is not cached and is not retried at once only when the file is at fault.
{
  const bad = sine('bad.wav', 2);
  assert.deepEqual(await getOrTranscodeToFlac(bad), { ok: false, reason: 'transcode-failed' });
  assert.deepEqual(await getOrTranscodeToFlac(bad), { ok: false, reason: 'transcode-failed' });
  assert.deepEqual(await getOrTranscodeToFlac(bad), { ok: false, reason: 'transcode-failed' });
  assert.equal(await spawnCount('bad.wav'), 1, 'a file ffmpeg can not decode is tried once, then left alone for a while');

  const cut = sine('cut.wav', 6);
  assert.equal((await getOrTranscodeToFlac(cut)).ok, false, 'a read that failed partway is refused');
  assert.equal((await getOrTranscodeToFlac(cut)).ok, false);
  assert.equal(await spawnCount('cut.wav'), 2, 'but a share that timed out is asked again at the next request');
}

// 2b. Each failure of one file waits longer than the last: 30 s, 2 min, 10 min.
{
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const stubborn = sine('bad-escalate.wav', 2);
    const tries = async () => (await getOrTranscodeToFlac(stubborn), await spawnCount('bad-escalate.wav'));
    assert.equal(await tries(), 1, 'first failure');
    offset += 31_000;
    assert.equal(await tries(), 2, 'tried again after the first 30 s');
    offset += 31_000;
    assert.equal(await tries(), 2, 'the second failure is not retried after another 31 s');
    offset += 90_000;
    assert.equal(await tries(), 3, 'tried again once 2 min have passed');
    offset += 121_000;
    assert.equal(await tries(), 3, 'the third failure is not retried after 2 min');
    offset += 480_000;
    assert.equal(await tries(), 4, 'tried again once 10 min have passed');
    offset += 599_000;
    assert.equal(await tries(), 4, 'and the wait stays at 10 min');
    offset += 2_000;
    assert.equal(await tries(), 5);
  } finally {
    Date.now = realNow;
  }
}

// 2c. A failed ffmpeg probe is tried again, at most once per 30 s, and not held for the session.
{
  const fresh = await import(`${pathToFileURL(bundle).href}?reprobe`);
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const previous = process.env.NEWAMP_FFMPEG_PATH;
  try {
    process.env.NEWAMP_FFMPEG_PATH = join(root, 'no-such-ffmpeg');
    fresh.initTranscodeCache(join(root, 'cache-reprobe'));
    const song = sine('reprobe.wav', 2);
    assert.deepEqual(await fresh.getOrTranscodeToFlac(song), { ok: false, reason: 'ffmpeg-missing' }, 'no ffmpeg to run');
    process.env.NEWAMP_FFMPEG_PATH = previous;
    assert.deepEqual(await fresh.getOrTranscodeToFlac(song), { ok: false, reason: 'ffmpeg-missing' }, 'not probed again within 30 s');
    offset += 31_000;
    assert.equal((await fresh.getOrTranscodeToFlac(song)).ok, true, 'probed again later, and ffmpeg-mode playback is back');
  } finally {
    process.env.NEWAMP_FFMPEG_PATH = previous;
    Date.now = realNow;
  }
}

// 3. Skipping through tracks drops the warms for the ones skipped.
{
  const songs = Array.from({ length: 9 }, (_, i) => sine(`slow-${i}.wav`, 2));
  const requests = [];
  for (const song of songs) {
    requests.push(getOrTranscodeToFlac(song));
    await sleep(60);
  }
  const results = await Promise.all(requests);
  const ran = (await readFile(spawnLog, 'utf8')).split('\n').filter((l) => l.includes('slow-')).length;
  const done = results.filter((r) => r.ok).length;
  assert.equal(done, ran, 'every encode that started finished');
  assert.ok(ran < songs.length, `not every skipped track was encoded (${ran} of ${songs.length})`);
  assert.ok(results.at(-1).ok, 'the newest request was kept');
}

// 5. The live WAV ends in an error when the read fails, and not when the listener leaves.
{
  const ok = sine('live-ok.wav', 4);
  const whole = await readBody(transcodeToWavResponse(ok, new Request('http://localhost/audio')));
  assert.ok(whole > 4 * 44100 * 8 * 0.9, `a whole track streams to the end (${whole} bytes)`);

  const cut = sine('live-cut.wav', 8);
  const cutResponse = transcodeToWavResponse(cut, new Request('http://localhost/audio'));
  assert.equal(cutResponse.status, 200);
  await assert.rejects(readBody(cutResponse), /failed partway/, 'a read failure is an error, not an end');

  const bad = sine('live-bad.wav', 2);
  await assert.rejects(readBody(transcodeToWavResponse(bad, new Request('http://localhost/audio'))), /exited 1/, 'so is ffmpeg failing');

  const left = sine('live-left.wav', 30);
  const controller = new AbortController();
  const leaving = transcodeToWavResponse(left, new Request('http://localhost/audio', { signal: controller.signal }));
  const reader = leaving.body.getReader();
  assert.ok((await reader.read()).value.byteLength > 0);
  controller.abort();
  let drained = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    drained += value.byteLength;
  }
  assert.ok(drained < 30 * 44100 * 8, 'a listener that left ends the body quietly and early');

  const already = new AbortController();
  already.abort();
  const gone = transcodeToWavResponse(sine('live-gone.wav', 30), new Request('http://localhost/audio', { signal: already.signal }));
  await gone.body.cancel();

  const previous = process.env.NEWAMP_FFMPEG_PATH;
  process.env.NEWAMP_FFMPEG_PATH = join(root, 'no-such-ffmpeg');
  const missing = transcodeToWavResponse(ok, new Request('http://localhost/audio'));
  process.env.NEWAMP_FFMPEG_PATH = previous;
  assert.equal(missing.status, 503, 'an ffmpeg that will not start is an error response, not an empty track');
  await sleep(50);
}

// 6. Exports are whole or absent.
{
  const out = join(root, 'out');
  await mkdir(out, { recursive: true });
  const song = sine('export-ok.wav', 2);
  for (const format of ['wav', 'flac', 'mp3', 'opus']) {
    const target = join(out, `song.${format}`);
    try {
      const result = await transcodeTrackToAudioFile(song, target, format);
      assert.ok(result.bytes > 0 && existsSync(target), `${format} export exists`);
    } catch (err) {
      if (/Unknown encoder|Encoder .* not found/i.test(String(err))) {
        console.warn(`[transcode-hardening-test] this ffmpeg has no ${format} encoder; skipped`);
        continue;
      }
      throw err;
    }
  }
  const cut = sine('export-cut.wav', 6);
  const bad = join(out, 'cut.wav');
  await assert.rejects(transcodeTrackToAudioFile(cut, bad, 'wav'), /failed partway/, 'an export from a failed read is refused');
  assert.ok(!existsSync(bad) && !existsSync(`${bad}.part`), 'and leaves nothing behind');
  const broken = sine('export-bad.wav', 2);
  await assert.rejects(transcodeTrackToAudioFile(broken, join(out, 'bad.flac'), 'flac'));
  assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('bad') || n.startsWith('cut')), [], 'no partial file after ffmpeg fails');
}

// 7. DSD exports are not left at 352.8 kHz.
{
  const writeDsf = (path, seconds) => {
    const fs = 2822400;
    const samples = Math.round(fs * seconds);
    const block = 4096;
    const bytesPerChannel = Math.ceil(samples / 8 / block) * block;
    const channel = Buffer.alloc(bytesPerChannel);
    let s1 = 0;
    let s2 = 0;
    let y = 0;
    for (let n = 0; n < samples; n++) {
      const x = 0.5 * Math.sin((2 * Math.PI * 1000 * n) / fs);
      s1 += x - y;
      s2 += s1 - y;
      y = s2 >= 0 ? 1 : -1;
      if (y > 0) channel[n >> 3] |= 1 << (n & 7);
    }
    const header = Buffer.alloc(92);
    header.write('DSD ', 0, 'latin1');
    header.writeBigUInt64LE(28n, 4);
    header.writeBigUInt64LE(BigInt(92 + bytesPerChannel * 2), 12);
    header.write('fmt ', 28, 'latin1');
    header.writeBigUInt64LE(52n, 32);
    header.writeUInt32LE(1, 40);
    header.writeUInt32LE(0, 44);
    header.writeUInt32LE(2, 48);
    header.writeUInt32LE(2, 52);
    header.writeUInt32LE(fs, 56);
    header.writeUInt32LE(1, 60);
    header.writeBigUInt64LE(BigInt(samples), 64);
    header.writeUInt32LE(block, 72);
    header.write('data', 80, 'latin1');
    header.writeBigUInt64LE(BigInt(12 + bytesPerChannel * 2), 84);
    return writeFile(path, Buffer.concat([header, channel, channel]));
  };
  const dsf = join(media, 'tone.dsf');
  await writeDsf(dsf, 0.5);
  for (const format of ['wav', 'flac']) {
    const target = join(root, `dsd.${format}`);
    await transcodeTrackToAudioFile(dsf, target, format);
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', target], { encoding: 'utf8' });
    assert.match(probe.stderr, /88200 Hz/, `a DSD ${format} export is 88.2 kHz`);
  }
  assert.ok(buildPlaybackFlacArgs(dsf, join(root, 'x.flac')).includes('88200'));
}

// 8. ReplayGain: silence gets none, and the filter no longer oversamples.
{
  const quiet = sine('rg-quiet.wav', 3, ['-filter:a', 'volume=0.2']);
  const analysis = await analyzeTrackReplayGain(quiet);
  assert.ok(analysis.integratedLufs < -18 && analysis.replayGainTrackDb > 0);
  const silence = join(media, 'rg-silence.wav');
  assert.equal(spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', silence]).status, 0);
  await assert.rejects(analyzeTrackReplayGain(silence), /silent/, 'silence is not boosted by 30 dB');
}

// 9. Every ffmpeg reading a library file is limited to files and pipes: each
// one started above for the cache, the live WAV, an export or ReplayGain.
{
  const limited = (args) => {
    const whitelist = args.indexOf('-protocol_whitelist');
    return whitelist >= 0 && args[whitelist + 1] === 'file,pipe' && whitelist < args.indexOf('-i');
  };
  assert.ok(limited(buildPlaybackFlacArgs(join(media, 'a.wma'), join(root, 'a.flac'))));
  const runs = (await readFile(argsLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((args) => args[args.indexOf('-i') + 1].startsWith(media));
  for (const output of ['.flac.part', 'pipe:1', '.wav.part', '-']) {
    assert.ok(runs.some((args) => args.at(-1).endsWith(output)), `an ffmpeg writing ${output} ran`);
  }
  for (const args of runs) assert.ok(limited(args), `limited to files and pipes: ${args.join(' ')}`);
}

// 10. The MP4 verdict: a share that times out is not a verdict, and parallel lookups share one read.
{
  const alac = join(media, 'alac.m4a');
  assert.equal(spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'alac', alac]).status, 0);
  const aac = join(media, 'aac.m4a');
  assert.equal(spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', aac]).status, 0);

  failing.open.set(alac, { code: 'ETIMEDOUT', left: 1 });
  await assert.rejects(mp4SoundCodec(alac), (err) => err.code === 'ETIMEDOUT', 'a timed-out read is thrown, not answered');
  assert.equal(await mp4SoundCodec(alac), 'alac', 'and was not remembered as "no codec"');

  // The routing throws when the share does not answer: the protocol handler waits and retries,
  // and nothing here guesses a mode that would then be remembered.
  const flaky = join(media, 'flaky.m4a');
  await copyFile(alac, flaky);
  failing.open.set(flaky, { code: 'EIO', left: 2 });
  await assert.rejects(resolvePlaybackMode(flaky), (err) => err.code === 'EIO', 'a read the share fails is not answered with a mode');
  await assert.rejects(resolvePlaybackMode(flaky), (err) => err.code === 'EIO');
  assert.equal(await resolvePlaybackMode(flaky), 'ffmpeg', 'once the share answers the file is routed by its codec');
  assert.equal(failing.open.get(flaky).left, 0);

  const aacCopy = join(media, 'aac-flaky.m4a');
  await copyFile(aac, aacCopy);
  failing.open.set(aacCopy, { code: 'ETIMEDOUT', left: 1 });
  await assert.rejects(resolvePlaybackMode(aacCopy), (err) => err.code === 'ETIMEDOUT');
  assert.equal(await resolvePlaybackMode(aacCopy), 'native', 'an AAC file is native once the share answers');

  const shared = join(media, 'shared.m4a');
  await copyFile(aac, shared);
  failing.open.set(shared, { code: 'EIO', left: 0 });
  let opens = 0;
  const original = failing.open.get.bind(failing.open);
  failing.open.get = (path) => {
    if (path === shared) opens += 1;
    return original(path);
  };
  const verdicts = await Promise.all([mp4SoundCodec(shared), mp4SoundCodec(shared), mp4SoundCodec(shared)]);
  assert.deepEqual(verdicts, ['mp4a', 'mp4a', 'mp4a']);
  assert.equal(opens, 1, 'three requests for one file read it once');
  failing.open.get = original;
}

// 11. A run is stopped when it stalls, not for being long, and quit stops every ffmpeg child.
{
  // Children that stand in for an ffmpeg here: one that does nothing, and one that keeps writing a file.
  const idleChild = () => spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const idle = idleChild();
  let why = null;
  const stop = watchFfmpegProgress(idle, (reason) => { why = reason; }, { stallMs: 300, pollMs: 50 });
  await sleep(700);
  assert.match(why ?? '', /no progress/, 'a silent child is called stalled');
  stop();
  idle.kill();

  const busy = join(root, 'growing.bin');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendFileSync } from 'node:fs';
    let wrote = 0;
    const timer = setInterval(() => {
      appendFileSync(${JSON.stringify(busy)}, wrote + '\\n');
      if (++wrote === 14) clearInterval(timer);
    }, 100);`], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Not before its first write: a child that has yet to start is not one that stalled.
  while (!existsSync(busy)) await sleep(20);
  let busyWhy = null;
  const stopBusy = watchFfmpegProgress(writer, (reason) => { busyWhy = reason; }, { outputPath: busy, stallMs: 400, pollMs: 50 });
  await sleep(1100);
  assert.equal(busyWhy, null, 'a growing output file keeps a run alive');
  stopBusy();

  const capped = idleChild();
  let cappedWhy = null;
  const stopCapped = watchFfmpegProgress(capped, (reason) => { cappedWhy = reason; }, { stallMs: Infinity, maxMs: 200, pollMs: 50 });
  await sleep(500);
  assert.match(cappedWhy ?? '', /still running/, 'the absolute cap still ends a run');
  stopCapped();
  capped.kill();

  // A child that takes no notice of being asked to stop, as an ffmpeg blocked
  // on a full pipe takes none: it is stopped all the same.
  const orphan = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); console.log('deaf'); setInterval(() => undefined, 1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((heard) => orphan.stdout.once('data', heard));
  watchFfmpegInput(orphan, join(media, 'orphan.wav'));
  const exited = new Promise((resolveExit) => orphan.once('exit', resolveExit));
  killAllTranscodeFfmpeg();
  await Promise.race([exited, sleep(5000).then(() => { throw new Error('quit left a watched ffmpeg running'); })]);
}

// 12. A resampler probe that could not be started has not found out what this
// ffmpeg can do. It answers with the resampler every build has, and the binary
// is asked again later; an answer of "no soxr" from a probe that never ran
// would otherwise stand until the app was closed.
{
  const binary = join(root, 'another-ffmpeg.mjs');
  await copyFile(standIn, binary);
  await chmod(binary, 0o755);
  const realNow = performance.now.bind(performance);
  let offset = 0;
  performance.now = () => realNow() + offset;
  try {
    globalThis.__resamplerSpawns = 0;
    globalThis.__resamplerSpawnErrors = 1;
    assert.equal(await probeResampler(binary), 'swr', 'the fallback when the probe could not start');
    assert.equal(await probeResampler(binary), 'swr');
    assert.equal(globalThis.__resamplerSpawns, 1, 'not tried again on the very next call');
    offset += 61_000;
    await probeResampler(binary);
    assert.equal(globalThis.__resamplerSpawns, 2, 'tried again a minute later, where a remembered answer would not have been');
    await probeResampler(binary);
    assert.equal(globalThis.__resamplerSpawns, 2, 'and what the binary answered is remembered');
  } finally {
    performance.now = realNow;
  }
}

clearTimeout(deadline);
await rm(root, { recursive: true, force: true });
console.log('[transcode-hardening-test] ok');
process.exit(0);
