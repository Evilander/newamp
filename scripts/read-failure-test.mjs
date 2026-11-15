// A read that fails partway through a file (a network share timing out)
// makes ffmpeg log the error and exit 0, as if the file ended there. The
// seek-bar waveform, the library analysis, the song score and the DNA decode
// used to keep what they had as the whole track: a waveform drawn over part
// of the bar, loudness, tempo and a score from the first minute, and a file
// marked as undecodable for the session. A playback transcode was cached as
// a shorter track for good. Here a stand-in ffmpeg cuts the decode of a file
// short that way while a control file says so; everything else goes to the
// real ffmpeg. A title, a tag or a file name that reads like an error must not
// count as one.
// Run: node scripts/read-failure-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform === 'win32') {
  console.log('[read-failure-test] skipped: the stand-in ffmpeg is a script with a shebang');
  process.exit(0);
}

const deadline = setTimeout(() => {
  console.error('read failure test timed out');
  process.exit(1);
}, 120_000);
deadline.unref();

const root = resolve('tmp', 'read-failure-test', String(process.pid));
const media = join(root, 'media');
const waveforms = join(root, 'waveforms');
const scores = join(root, 'scores');
await rm(root, { recursive: true, force: true });
await mkdir(media, { recursive: true });

// <input>.fail holds {"left": n, "cut": seconds}: the next n decodes of that
// file stop after `cut` seconds with the error a timed-out read gives.
const flaky = join(root, 'flaky-ffmpeg.mjs');
await writeFile(flaky, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const at = args.indexOf('-i');
const input = at >= 0 ? args[at + 1] : '';
const control = input + '.fail';
const plan = existsSync(control) ? JSON.parse(readFileSync(control, 'utf8')) : { left: 0 };
if (!(plan.left > 0)) {
  spawn(${JSON.stringify(ffmpeg)}, args, { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
} else {
  writeFileSync(control, JSON.stringify({ ...plan, left: plan.left - 1 }));
  const cut = [...args.slice(0, at), '-t', String(plan.cut), ...args.slice(at)];
  spawn(${JSON.stringify(ffmpeg)}, cut, { stdio: ['ignore', 'inherit', 'pipe'] }).on('close', () => {
    process.stderr.write('[in#0/wav @ 0x1] Error during demuxing: Operation timed out\\n');
    process.exit(0);
  });
}
`);
await chmod(flaky, 0o755);
process.env.NEWAMP_FFMPEG_PATH = flaky;

// The waveform's stat goes through a stand-in too, so a share that times out
// on the stat itself can be played back.
const statFailures = new Map();
globalThis.__readFailureTestStat = statFailures;
const fsStub = {
  name: 'fs-stub',
  setup(b) {
    b.onResolve({ filter: /^node:fs\/promises$/ }, (args) =>
      args.importer.endsWith('waveform-peaks.ts') ? { path: 'fs-promises', namespace: 'stub' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        import * as fs from 'node:fs/promises';
        export * from 'node:fs/promises';
        export async function stat(path, ...rest) {
          const left = globalThis.__readFailureTestStat.get(path) ?? 0;
          if (left > 0) {
            globalThis.__readFailureTestStat.set(path, left - 1);
            throw Object.assign(new Error('ETIMEDOUT: operation timed out, stat ' + path), { code: 'ETIMEDOUT' });
          }
          return fs.stat(path, ...rest);
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
      export { getWaveform, initWaveformCache, killAllWaveformFfmpeg, waveformCacheKey } from './electron/waveform-peaks.ts';
      export { analyzeTrack } from './electron/track-analyzer.ts';
      export { getSongScore, initScoreCache } from './electron/score-analyzer.ts';
      export { analyzeTrackDna } from './electron/dna-analyzer.ts';
      export { AnalysisReadFailedError } from './shared/analysis.ts';
      export { isReadFailureLine, isStorageError, logShowsReadFailure, watchReadFailures } from './electron/read-failure.ts';
      export { getOrTranscodeToFlac, initTranscodeCache } from './electron/transcode-cache.ts';
      export { analyzeTrackReplayGain } from './electron/transcode.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  packages: 'external',
  plugins: [fsStub],
  outfile: bundle,
  logLevel: 'silent',
});
const {
  getWaveform, initWaveformCache, killAllWaveformFfmpeg, waveformCacheKey,
  analyzeTrack, getSongScore, initScoreCache, analyzeTrackDna, AnalysisReadFailedError,
  isReadFailureLine, isStorageError, logShowsReadFailure, watchReadFailures, getOrTranscodeToFlac, initTranscodeCache, analyzeTrackReplayGain,
} = await import(pathToFileURL(bundle).href);

initWaveformCache(waveforms);
initScoreCache(scores);
const transcodes = join(root, 'transcodes');
initTranscodeCache(transcodes);

// 0. Which lines of ffmpeg's log count.
{
  const input = '/music/Host is down/01 Connection Reset.mp3';
  const yes = [
    `${input}: Operation timed out`,
    '[in#0/mp3 @ 0x1] Error during demuxing: Input/output error',
    `[error] ${input}: Connection timed out`,
    '[mp3 @ 0x2] Error opening input: Stale NFS file handle.',
    `${input}: Resource temporarily unavailable`,
    '[in#0/mp3 @ 0x1] Error during demuxing: No such device or address',
    `${input}: Device or resource busy`,
    `${input}: Device not configured`,
  ];
  const no = [
    '    title           : No Route to Host',
    '[info]     comment         : Operation timed out',
    `Input #0, mp3, from '${input}':`,
    `${input}: Invalid data found when processing input`,
    '[info] [mp3 @ 0x3] Estimating duration from bitrate: Operation timed out',
    'Error while decoding stream #0:0: Invalid data found when processing input',
    // A file that was moved or deleted is not the drive: it isn't waited on.
    `${input}: No such file or directory`,
    '[in#0/mp3 @ 0x1] Error during demuxing: Invalid data found when processing input',
  ];
  for (const line of yes) assert.ok(isReadFailureLine(line, input), `a read failure: ${line}`);
  for (const line of no) assert.ok(!isReadFailureLine(line, input), `not a read failure: ${line}`);
  assert.ok(logShowsReadFailure(`${no.join('\n')}\n${yes[1]}\n`, input), 'found among other lines');
  const named = '/music/Live: Host is down';
  assert.ok(!isReadFailureLine(`Error opening input file ${named}.`, named), 'a file named like an error');
  assert.ok(isReadFailureLine(`${named}: Host is down`, named), 'that really failed');

  // However the log is cut into chunks.
  const log = `${no.join('\n')}\n${yes[0]}\nsize=N/A time=00:01:00\n`;
  for (let cut = 1; cut < log.length; cut += 7) {
    const child = { stderr: new EventEmitter() };
    const failed = watchReadFailures(child, input);
    child.stderr.emit('data', Buffer.from(log.slice(0, cut)));
    child.stderr.emit('data', Buffer.from(log.slice(cut)));
    assert.ok(failed(), `found with the log cut at ${cut}`);
  }
  // A character of a non-ASCII path split across two chunks still strips with the path.
  const accented = '/music/Café 日本: Host is down';
  const accentedLine = Buffer.from(`Error opening input file ${accented}.\n`);
  for (let cut = 1; cut < accentedLine.length; cut++) {
    const child = { stderr: new EventEmitter() };
    const failed = watchReadFailures(child, accented);
    child.stderr.emit('data', accentedLine.subarray(0, cut));
    child.stderr.emit('data', accentedLine.subarray(cut));
    assert.ok(!failed(), `a file named like an error is not a failure with its name cut at byte ${cut}`);
  }
  const accentedFailure = Buffer.from(`${accented}: Operation timed out\n`);
  for (let cut = 1; cut < accentedFailure.length; cut++) {
    const child = { stderr: new EventEmitter() };
    const failed = watchReadFailures(child, accented);
    child.stderr.emit('data', accentedFailure.subarray(0, cut));
    child.stderr.emit('data', accentedFailure.subarray(cut));
    assert.ok(failed(), `a real failure on that file is found with its name cut at byte ${cut}`);
  }
  const clean = { stderr: new EventEmitter() };
  const cleanFailed = watchReadFailures(clean, input);
  clean.stderr.emit('data', `${no.join('\n')}\n`);
  assert.ok(!cleanFailed(), 'a log of look-alikes is clean');
  const last = { stderr: new EventEmitter() };
  const lastFailed = watchReadFailures(last, input);
  last.stderr.emit('data', yes[0]);
  assert.ok(lastFailed(), 'a last line without a newline counts');
}

// 0b. Which filesystem errors are the storage's.
for (const code of ['ETIMEDOUT', 'EIO', 'ENXIO', 'ENODEV', 'ESHUTDOWN', 'ENOLINK', 'EREMOTEIO', 'EAGAIN', 'EBUSY']) {
  assert.ok(isStorageError(Object.assign(new Error(code), { code })), `${code} is the storage's`);
}
for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ESHORT']) {
  assert.ok(!isStorageError(Object.assign(new Error(code), { code })), `${code} is the file's`);
}
assert.ok(!isStorageError(new Error('no code')) && !isStorageError(null), 'an error without a code is not');

function fixture(name, seconds) {
  const path = join(media, name);
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:beep_factor=4:sample_rate=44100:duration=${seconds}`, '-ac', '2', path], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  return path;
}
const failReads = (path, left, cut) => writeFile(`${path}.fail`, JSON.stringify({ left, cut }));
const near = (value, target, what) => assert.ok(Math.abs(value - target) < 0.5, `${what}: ${value.toFixed(2)} s, wanted ${target}`);
const cachedWaveforms = async () => (await readdir(waveforms)).filter((name) => name.endsWith('.json'));

// 1. Two reads fail, the third works: the seek bar gets the whole track, and that is what is cached.
{
  const song = fixture('waveform.wav', 20);
  await failReads(song, 2, 5);
  const waveform = await getWaveform({ path: song, duration: 20 });
  assert.ok(waveform, 'a waveform once the share answers');
  near(waveform.duration, 20, 'the waveform covers the whole track');
  const again = await getWaveform({ path: song, duration: 20 });
  near(again.duration, 20, 'and the cached one does too');
}

// 2. The share never answers while it is asked: no waveform, but the file is not marked as one
// that can't be decoded, so the next request, once the share is back, builds it.
{
  const song = fixture('down.wav', 20);
  await failReads(song, 99, 5);
  const before = (await cachedWaveforms()).length;
  assert.equal(await getWaveform({ path: song, duration: 20 }), null, 'nothing drawn from a share that never answered');
  assert.equal((await cachedWaveforms()).length, before, 'nothing cached for it');
  await failReads(song, 0, 5);
  const back = await getWaveform({ path: song, duration: 20 });
  assert.ok(back, 'asked again once the share is back, it decodes');
  near(back.duration, 20, 'the whole track');
}

// 3. The stat itself times out twice.
{
  const song = fixture('stat.wav', 20);
  statFailures.set(song, 2);
  const waveform = await getWaveform({ path: song, duration: 20 });
  assert.ok(waveform, 'a stat that timed out is tried again');
  near(waveform.duration, 20, 'the whole track');
  assert.equal(statFailures.get(song), 0);
}

// 4. The library analysis: a cut-short decode is a read failure, and no waveform is kept from it.
{
  const song = fixture('analysis.wav', 30);
  await failReads(song, 1, 8);
  const want = { loud: true, tempo: true, dna: true, peaks: true };
  await assert.rejects(analyzeTrack({ path: song, want }), (err) => err instanceof AnalysisReadFailedError, 'a read failure, not a result');
  const { size, mtimeMs } = await stat(song);
  const key = waveformCacheKey({ path: song, size, mtimeMs, start: 0, end: null });
  assert.ok(!(await cachedWaveforms()).includes(`${key}.json`), 'no waveform stored from the part that was read');
  const result = await analyzeTrack({ path: song, want });
  near(result.seconds, 30, 'analysed whole once the share answers');
  assert.ok(result.loudness, 'with its loudness');
}

// 5. The song score is not cached from part of the track.
{
  const song = fixture('score.wav', 40);
  await failReads(song, 1, 25);
  assert.equal(await getSongScore({ path: song }), null, 'no score from a decode that stopped at 25 s');
  const score = await getSongScore({ path: song });
  assert.ok(score, 'a score once the share answers');
  near(score.duration, 40, 'of the whole track');
}

// 5b. A track whose tags read like errors is analysed, at the info level that prints them;
// a broken file named like an error is held against it at once, not retried.
{
  const path = join(media, 'tags.wav');
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:beep_factor=4:sample_rate=44100:duration=20',
    '-ac', '2', '-metadata', 'title=No Route to Host', '-metadata', 'comment=Operation timed out', path], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const result = await analyzeTrack({ path, want: { loud: true, tempo: true, dna: false, peaks: false } });
  near(result.seconds, 20, 'a title of "No Route to Host" is analysed');
  assert.ok((await analyzeTrackReplayGain(path)).integratedLufs < 0, 'and has its ReplayGain read');

  const broken = join(media, 'Host is down.wav');
  await writeFile(broken, 'not audio at all');
  const started = Date.now();
  assert.equal(await getWaveform({ path: broken, duration: 20 }), null, 'a broken file has no waveform');
  assert.ok(Date.now() - started < 3000, `and is not retried because of its name (${Date.now() - started} ms)`);
}

// 5c. A playback transcode cut short is not cached; once the share answers, the whole track is.
{
  const song = fixture('transcode.wav', 20);
  await failReads(song, 1, 5);
  const failed = await getOrTranscodeToFlac(song);
  assert.equal(failed.ok, false, 'a cut-short transcode is refused');
  assert.ok(!(await readdir(transcodes)).some((name) => name.endsWith('.flac')), 'and not cached');
  const done = await getOrTranscodeToFlac(song);
  assert.equal(done.ok, true, 'the transcode works once the share answers');
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', done.path, '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 1 << 24 });
  near(decoded.stdout.length / 2 / 8000, 20, 'the cached transcode is the whole track');
}

// 5d. The ReplayGain action.
{
  const song = fixture('replaygain.wav', 20);
  await failReads(song, 1, 5);
  await assert.rejects(analyzeTrackReplayGain(song), /failed partway/, 'no loudness from part of the track');
  assert.ok((await analyzeTrackReplayGain(song)).integratedLufs < 0, 'a loudness once the share answers');
}

// 6. DNA.
{
  const song = fixture('dna.wav', 30);
  await failReads(song, 1, 5);
  await assert.rejects(analyzeTrackDna(song), /failed partway/, 'a read failure, not a DNA of the first seconds');
  assert.ok(await analyzeTrackDna(song), 'a DNA once the share answers');
}

killAllWaveformFfmpeg();
clearTimeout(deadline);
await rm(root, { recursive: true, force: true });
console.log('[read-failure-test] ok');
process.exit(0);
