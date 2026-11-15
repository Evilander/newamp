// A read that fails partway through a file (a network share timing out)
// makes ffmpeg log the error and exit 0, as if the file ended there. The
// seek-bar waveform, the library analysis, the song score and the DNA decode
// used to keep what they had as the whole track: a waveform drawn over part
// of the bar, loudness, tempo and a score from the first minute, and a file
// marked as undecodable for the session. A playback transcode was cached as
// a shorter track for good. Here a stand-in ffmpeg cuts the decode of a file
// short that way while a control file says so; everything else goes to the
// real ffmpeg. A title, a tag or a file name that reads like an error must not
// count as one. Which lines count is checked against what ffmpeg prints on
// Windows as well as on macOS and Linux: the reason differs, the line does not.
// Run: node scripts/read-failure-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scriptStandInSpawn } from './lib/script-standin-spawn.mjs';

const deadline = setTimeout(() => {
  console.error('read failure test timed out');
  process.exit(1);
}, 240_000);
deadline.unref();

const root = resolve('tmp', 'read-failure-test', String(process.pid));
const media = join(root, 'media');
const waveforms = join(root, 'waveforms');
const scores = join(root, 'scores');
const spawnLog = join(root, 'spawns.log');
await rm(root, { recursive: true, force: true });
await mkdir(media, { recursive: true });
await writeFile(spawnLog, '');

// <input>.fail holds {"left": n, "cut": seconds, "reason": text}: the next n
// decodes of that file stop after `cut` seconds with the error a failed read
// gives, for the reason named (a timed-out read if none is). "hang": n makes
// the next n decodes sit there instead. Every run is noted in spawns.log.
const flaky = join(root, 'flaky-ffmpeg.mjs');
await writeFile(flaky, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const at = args.indexOf('-i');
const input = at >= 0 ? args[at + 1] : '';
appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(args) + '\\n');
const control = input + '.fail';
const plan = existsSync(control) ? JSON.parse(readFileSync(control, 'utf8')) : { left: 0 };
if (plan.hang > 0) {
  writeFileSync(control, JSON.stringify({ ...plan, hang: plan.hang - 1 }));
  setInterval(() => undefined, 1e6);
} else if (!(plan.left > 0)) {
  spawn(${JSON.stringify(ffmpeg)}, args, { stdio: 'inherit' }).on('close', (code) => process.exit(code ?? 1));
} else {
  writeFileSync(control, JSON.stringify({ ...plan, left: plan.left - 1 }));
  const cut = [...args.slice(0, at), '-t', String(plan.cut), ...args.slice(at)];
  spawn(${JSON.stringify(ffmpeg)}, cut, { stdio: ['ignore', 'inherit', 'pipe'] }).on('close', () => {
    process.stderr.write('[in#0/wav @ 000001a51ab3c680] Error during demuxing: ' + (plan.reason ?? 'Operation timed out') + '\\n');
    process.exit(0);
  });
}
`);
await chmod(flaky, 0o755);
process.env.NEWAMP_FFMPEG_PATH = flaky;
// Short, so a waveform decode that hangs is given up on quickly.
process.env.NEWAMP_WAVEFORM_TIMEOUT_MS = '4000';
// Short, so an outage that never ends is given up on quickly, and a file
// another program holds quicker still.
process.env.NEWAMP_READ_OUTAGE_MS = '3000';
process.env.NEWAMP_READ_BUSY_MS = '300';

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
      export {
        isReadFailureLine, isStorageError, isStorageReadFailure, logReadFailure, logShowsReadFailure, probeFileRead, readFailureKind, retryStorageErrors,
        rememberStorageGone, setStorageRoots, storageAnswered, storageKnownGone, storageOutageMs, storageRootOf, volumeAway,
        watchReadFailureKind, watchReadFailures, BUSY_FILE_OUTAGE_MS, STORAGE_GIVEN_UP_MS, STORAGE_OUTAGE_MS,
      } from './electron/read-failure.ts';
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
  plugins: [fsStub, scriptStandInSpawn],
  outfile: bundle,
  logLevel: 'silent',
});
const {
  getWaveform, initWaveformCache, killAllWaveformFfmpeg, waveformCacheKey,
  analyzeTrack, getSongScore, initScoreCache, analyzeTrackDna, AnalysisReadFailedError,
  isReadFailureLine, isStorageError, isStorageReadFailure, logReadFailure, logShowsReadFailure, probeFileRead, readFailureKind, retryStorageErrors,
  rememberStorageGone, setStorageRoots, storageAnswered, storageKnownGone, storageOutageMs, storageRootOf, volumeAway,
  watchReadFailureKind, watchReadFailures, BUSY_FILE_OUTAGE_MS, STORAGE_GIVEN_UP_MS, STORAGE_OUTAGE_MS,
  getOrTranscodeToFlac, initTranscodeCache, analyzeTrackReplayGain,
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

  // What the bundled ffmpeg prints on Windows when the system refuses a read
  // partway through a file: the same lines, with the reasons the Windows C
  // runtime has for it. On those lines any reason counts but the ones that
  // mean the data is bad or finished, or that ffmpeg was told to stop.
  const windows = 'K:\\Music\\Artist\\01 Song.flac';
  const refused = [
    '[in#0/flac @ 000001a51ab3c680] [error] Error during demuxing: Permission denied',
    '[in#0/flac @ 000001a51ab3c680] [error] Error retrieving a packet from demuxer: Permission denied',
    '[in#0/flac @ 0000025675ddc640] Error during demuxing: Permission denied',
    '[in#0/wav @ 0000029b550fc680] [error] Error during demuxing: Invalid argument',
    '[in#0/mp3 @ 00000166eac3c5c0] [error] Error during demuxing: Bad file descriptor',
    '[in#0/ogg @ 000001542e7cc5c0] [error] Error during demuxing: No such file or directory',
    '[in#0/wv @ 000001cccb14c680] [error] Error during demuxing: I/O error',
    '[in#0/asf @ 000001607a20c5c0] [error] Error retrieving a packet from demuxer: Error number -138 occurred',
    '[in#0 @ 00000245c0bfc5c0] [error] Error opening input: Invalid argument',
    '[fatal] Error opening input files: Bad file descriptor',
  ];
  for (const line of refused) assert.ok(isReadFailureLine(line, windows), `a read failure: ${line}`);
  const notRefused = [
    // Logged below warning level, wherever ffmpeg puts the level.
    '[in#0/flac @ 000001a51ab3c680] [info] something: Input/output error',
    '[out#0/wav @ 0000029b55107600] [info] video:0kB audio:13760kB subtitle:0kB other streams:0kB',
    // The data, not a read.
    '[flac @ 000001a51aba3680] [error] invalid residual',
    '[aist#0:0/flac @ 000001a51ab3ebc0] [error] Decoding error: Invalid data found when processing input',
    '[in#0/mp3 @ 00000166eac3c5c0] [error] Error during demuxing: End of file',
    '[in#0/mp3 @ 00000166eac3c5c0] [error] Error during demuxing: Immediate exit requested',
    // A file that is missing or refused when it is opened is the file's own, as far as a log can say.
    '[in#0 @ 00000245c0bfc5c0] [error] Error opening input: No such file or directory',
    '[in#0 @ 00000213cac7c5c0] [error] Error opening input: Permission denied',
    `[error] Error opening input file ${windows}.`,
    '[fatal] Error opening input files: No such file or directory',
    '[in#0 @ 00000184d370c640] Error opening input: Invalid data found when processing input',
    // An invalid argument that has nothing to do with reading the input.
    '[out#0/wav @ 0000029b55107600] [error] Could not write header: Invalid argument',
  ];
  for (const line of notRefused) assert.ok(!isReadFailureLine(line, windows), `not a read failure: ${line}`);
  // Which reasons only the storage gives, and which leave it open whose doing
  // the failed read was: Windows has one reason for a drive that is not ready
  // and a file another program holds, and ffmpeg answers "I/O error" on its
  // own account for a file that ends early.
  const timedOut = '[in#0/flac @ 000001a51ab3c680] [error] Error during demuxing: Operation timed out';
  assert.equal(readFailureKind(timedOut, windows), 'storage');
  assert.equal(readFailureKind(yes[0], input), 'storage');
  assert.equal(readFailureKind(refused[0], windows), 'unclear');
  assert.equal(readFailureKind(refused[6], windows), 'unclear');
  assert.equal(readFailureKind(`${windows}: Input/output error`, windows), 'unclear');
  assert.equal(readFailureKind(refused[7], windows), 'unclear', 'a reason nobody has seen before is a failed read all the same');
  assert.equal(logReadFailure(`${refused[7]}\n${notRefused.join('\n')}\n`, windows), 'unclear');
  assert.equal(logReadFailure(`${refused[7]}\n${timedOut}\n`, windows), 'storage', "the storage's, if any line says so");
  assert.equal(logReadFailure(notRefused.join('\n'), windows), null);
  assert.ok(isReadFailureLine(refused[1], 'x'), 'a path one letter long is not taken out of the words of the line');
  const kinds = { stderr: new EventEmitter() };
  const kindSeen = watchReadFailureKind(kinds, windows);
  kinds.stderr.emit('data', `${notRefused.join('\n')}\n${refused[7]}\n`);
  assert.equal(kindSeen(), 'unclear');
  kinds.stderr.emit('data', `${timedOut}\n`);
  assert.equal(kindSeen(), 'storage');
}

// 0b. Which filesystem errors are the storage's.
for (const code of ['ETIMEDOUT', 'EIO', 'ENXIO', 'ENODEV', 'ESHUTDOWN', 'ENOLINK', 'EREMOTEIO', 'EAGAIN', 'EBUSY']) {
  assert.ok(isStorageError(Object.assign(new Error(code), { code })), `${code} is the storage's`);
}
for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ESHORT']) {
  assert.ok(!isStorageError(Object.assign(new Error(code), { code })), `${code} is the file's`);
}
assert.ok(!isStorageError(new Error('no code')) && !isStorageError(null), 'an error without a code is not');

// And how long each is waited out. On Windows EBUSY is another program holding
// the file, which is waited on for a moment; anywhere else it is a busy device.
{
  const errno = (code) => Object.assign(new Error(code), { code });
  const heldLocally = process.platform === 'win32';
  assert.ok(BUSY_FILE_OUTAGE_MS < STORAGE_OUTAGE_MS);
  assert.equal(storageOutageMs(errno('ETIMEDOUT')), STORAGE_OUTAGE_MS);
  assert.equal(storageOutageMs(errno('EBUSY')), heldLocally ? BUSY_FILE_OUTAGE_MS : STORAGE_OUTAGE_MS);
  let tries = 0;
  const began = Date.now();
  await assert.rejects(retryStorageErrors(async () => {
    tries += 1;
    throw errno('EBUSY');
  }), (err) => err.code === 'EBUSY');
  const waited = Date.now() - began;
  if (heldLocally) assert.ok(tries === 2 && waited < 2500, `a file another program holds is given up on in a moment (${tries} tries, ${waited} ms)`);
  else assert.ok(tries >= 3 && waited >= 2900, `a busy device is waited on for the whole outage (${tries} tries, ${waited} ms)`);
}

function fixture(name, seconds) {
  const path = join(media, name);
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:beep_factor=4:sample_rate=44100:duration=${seconds}`, '-ac', '2', path], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  return path;
}
const failReads = (path, left, cut, reason) => writeFile(`${path}.fail`, JSON.stringify({ left, cut, reason }));
const near = (value, target, what) => assert.ok(Math.abs(value - target) < 0.5, `${what}: ${value.toFixed(2)} s, wanted ${target}`);
const cachedWaveforms = async () => (await readdir(waveforms)).filter((name) => name.endsWith('.json'));

// 0c. What the file system itself says about a file a decoder could not read.
{
  const there = fixture('probe.wav', 1);
  assert.equal(await probeFileRead(there), 'readable');
  assert.equal(await probeFileRead(join(media, 'not-here.wav')), 'file', 'a file missing from a folder that is there is the file');
  assert.equal(await volumeAway(there), false);
  // A failed read for a reason that leaves it open is the storage's only if the file can't be read.
  assert.equal(await isStorageReadFailure('storage', there), true);
  assert.equal(await isStorageReadFailure('unclear', there), false, 'the file reads to its end: whatever the decoder met, it was not the drive');
  if (process.platform === 'win32') {
    // A drive letter with nothing behind it is what a pulled drive or an
    // unmapped share leaves, and every file on it reads as missing.
    const free = [...'ZYXWVUTSRQPONMLKJIHGFED'].find((letter) => !existsSync(`${letter}:\\`));
    if (free) {
      assert.equal(await volumeAway(`${free}:\\Music\\a.flac`), true);
      assert.equal(await probeFileRead(`${free}:\\Music\\a.flac`), 'storage', 'a file on a drive that has gone is the storage');
      assert.equal(await isStorageReadFailure('unclear', `${free}:\\Music\\a.flac`), true);
    }
  } else {
    assert.equal(await volumeAway('/no/such/folder/a.flac'), false, 'one root, and it is always there');
  }
}

// 0d. A storage that was waited for and did not come back is remembered, so
// the files after the first are not each waited on in turn.
{
  // Which storage a file is on: a drive letter or a share on Windows, a mount
  // or a library folder elsewhere, and never the root of the whole tree.
  assert.equal(storageRootOf('K:\\Music\\Artist\\a.flac', 'win32'), 'k:\\');
  assert.equal(storageRootOf('\\\\NAS\\Music\\Artist\\a.flac', 'win32'), '\\\\nas\\music\\');
  assert.equal(storageRootOf('/Volumes/NAS/Music/a.flac', 'darwin'), '/volumes/nas');
  assert.equal(storageRootOf('/mnt/nas/Music/a.flac', 'linux'), '/mnt/nas');
  assert.equal(storageRootOf('/media/me/Disk/a.flac', 'linux'), '/media/me/Disk');
  assert.equal(storageRootOf('/run/media/me/Disk/a.flac', 'linux'), '/run/media/me/Disk');
  assert.equal(storageRootOf('/home/me/Music/a.flac', 'linux'), null);
  assert.equal(storageRootOf('/a.flac', 'linux'), null);
  setStorageRoots(['/srv/music', '/Volumes']);
  assert.equal(storageRootOf('/srv/music/Artist/a.flac', 'linux'), '/srv/music', 'the library folder, where the mount is not one that is known');
  assert.equal(storageRootOf('/srv/musical/a.flac', 'linux'), null, 'a folder that only starts the same is another folder');
  assert.equal(storageRootOf('/Volumes/NAS/a.flac', 'darwin'), '/volumes/nas', 'the closer of the mount and the library folder');
  setStorageRoots([]);

  const errno = (code) => Object.assign(new Error(code), { code });
  const [gone, here] = process.platform === 'win32' ? ['K:\\Music', 'L:\\Music'] : ['/Volumes/Gone', '/Volumes/Here'];
  const realNow = performance.now.bind(performance);
  let later = 0;
  performance.now = () => realNow() + later;
  try {
    assert.equal(storageKnownGone(join(gone, 'one.flac')), false, 'nothing is known to be gone to begin with');
    rememberStorageGone(join(gone, 'one.flac'), errno('ETIMEDOUT'));
    assert.equal(storageKnownGone(join(gone, 'Album', 'two.flac')), true, 'the next file on that storage is not waited on');
    assert.equal(storageKnownGone(join(here, 'three.flac')), false, 'a file on another storage is not touched by it');
    storageAnswered(join(gone, 'four.flac'));
    assert.equal(storageKnownGone(join(gone, 'Album', 'two.flac')), false, 'one read from it and the note is gone');
    rememberStorageGone(join(gone, 'one.flac'));
    later += STORAGE_GIVEN_UP_MS - 1000;
    assert.equal(storageKnownGone(join(gone, 'two.flac')), true, 'still noted just before it lapses');
    later += 2000;
    assert.equal(storageKnownGone(join(gone, 'two.flac')), false, 'and it lapses by itself');
    if (process.platform === 'win32') {
      rememberStorageGone(join(gone, 'held.flac'), errno('EBUSY'));
      assert.equal(storageKnownGone(join(gone, 'two.flac')), false, 'a file another program holds says nothing about its drive');
    } else {
      rememberStorageGone('/home/me/Music/a.flac');
      assert.equal(storageKnownGone('/home/me/Music/b.flac'), false, 'a file whose storage nothing names leaves no note');
    }
    // Reading a file to its end is a read like any other.
    const there = fixture('answered.wav', 1);
    setStorageRoots([media]);
    rememberStorageGone(there);
    assert.equal(storageKnownGone(join(media, 'other.wav')), true);
    assert.equal(await probeFileRead(there), 'readable');
    assert.equal(storageKnownGone(join(media, 'other.wav')), false, 'a file that reads to its end clears the note on its storage');
  } finally {
    performance.now = realNow;
    setStorageRoots([]);
  }
}

// 1. Two reads fail, the third works: the seek bar gets the whole track, and that is what is cached.
{
  const song = fixture('waveform.wav', 20);
  await failReads(song, 2, 5);
  const waveform = await getWaveform({ path: song, duration: 20 });
  assert.ok(waveform, 'a waveform once the share answers');
  near(waveform.duration, 20, 'the waveform covers the whole track');
  const again = await getWaveform({ path: song, duration: 20 });
  near(again.duration, 20, 'and the cached one does too');

  // Each of those decodes was limited to files and pipes.
  const decodes = (await readFile(spawnLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((args) => args.includes(song));
  assert.equal(decodes.length, 3, 'three decodes of the file');
  for (const args of decodes) {
    const whitelist = args.indexOf('-protocol_whitelist');
    assert.ok(whitelist >= 0 && args[whitelist + 1] === 'file,pipe' && whitelist < args.indexOf('-i'), `limited to files and pipes: ${args.join(' ')}`);
  }
}

// 1b. The same when the reason given is one of Windows's: a waveform of the
// first five seconds is not what gets drawn, or kept.
{
  const song = fixture('waveform-refused.wav', 20);
  await failReads(song, 2, 5, 'Permission denied');
  const waveform = await getWaveform({ path: song, duration: 20 });
  assert.ok(waveform, 'a waveform once the read is no longer refused');
  near(waveform.duration, 20, 'the waveform covers the whole track');
  near((await getWaveform({ path: song, duration: 20 })).duration, 20, 'and the cached one does too');
}

// 1c. A decode that sits in a read the share never answers is stopped, and
// that is not held against the file: asked again, it decodes.
{
  const song = fixture('hung.wav', 20);
  await writeFile(`${song}.fail`, JSON.stringify({ hang: 1 }));
  assert.equal(await getWaveform({ path: song, duration: 20 }), null, 'no waveform from a decode that had to be stopped');
  const later = await getWaveform({ path: song, duration: 20 });
  assert.ok(later, 'the next request decodes the file instead of answering that it can not be');
  near(later.duration, 20, 'the whole track');
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

  // Nor is one cut short for a reason Windows gives.
  const refused = fixture('transcode-refused.wav', 20);
  await failReads(refused, 1, 5, 'Invalid argument');
  assert.equal((await getOrTranscodeToFlac(refused)).ok, false, 'a transcode cut short by a refused read is not kept');
  const whole = await getOrTranscodeToFlac(refused);
  assert.equal(whole.ok, true, 'the transcode works once the read is no longer refused');
  const wholeDecoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', whole.path, '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 1 << 24 });
  near(wholeDecoded.stdout.length / 2 / 8000, 20, 'and what is cached is the whole track');
}

// 5d. The ReplayGain action.
{
  const song = fixture('replaygain.wav', 20);
  await failReads(song, 1, 5);
  await assert.rejects(analyzeTrackReplayGain(song), /failed partway/, 'no loudness from part of the track');
  assert.ok((await analyzeTrackReplayGain(song)).integratedLufs < 0, 'a loudness once the share answers');
  await failReads(song, 1, 5, 'Bad file descriptor');
  await assert.rejects(analyzeTrackReplayGain(song), /failed partway/, 'nor from part of it when the reason is one Windows gives');
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
