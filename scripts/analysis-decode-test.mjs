// The analysis decode (electron/track-analyzer.ts) against real ffmpeg and stand-in
// executables:
//  - ffmpeg that cannot start is an environment failure, not a failure of the track
//  - ffmpeg killed by a signal nobody sent here is a crash, not an abort
//  - an abort rejects only once the process is gone
//  - a track that owes only tempo, key or DNA is read for its first two minutes,
//    and the tempo does not depend on which fields were owed
//  - loudness is measured on a long track's first twenty minutes only when that is the whole track
// Run: node scripts/analysis-decode-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { scriptStandInSpawn } from './lib/script-standin-spawn.mjs';

const deadline = setTimeout(() => { console.error('analysis decode test timed out'); process.exit(1); }, 120000);
deadline.unref();

const root = resolve('tmp', 'analysis-decode-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

// Bundled under the repo so ffmpeg-static still finds its binary.
const bundlePath = join(root, 'track-analyzer.bundle.mjs');
await build({
  stdin: {
    contents: `
      export * from './electron/track-analyzer';
      export * from './electron/dna-analyzer';
      export * from './electron/score-analyzer';
      export * from './shared/analysis';
    `,
    resolveDir: resolve('.'),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', packages: 'external',
  plugins: [scriptStandInSpawn],
  outfile: bundlePath, logLevel: 'silent',
});
const {
  AnalysisAbortedError, AnalysisCrashedError, AnalysisDrivePendingError, AnalysisEnvironmentError, AnalysisUnavailableError,
  MAX_ANALYSIS_SECONDS, activeAnalysisDecodes, analyzeTrack, analyzeTrackDna, getSongScore, initScoreCache, statWithin,
} = await import(pathToFileURL(bundlePath).href);

const realFfmpeg = createRequire(import.meta.url)('ffmpeg-static');
const ffmpegFile = (name, args) => {
  const file = join(root, name);
  const run = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  assert.equal(run.status, 0, `could not make ${name}: ${run.stderr}`);
  return file;
};

const none = { loud: false, tempo: false, dna: false, peaks: false };

// A stand-in for ffmpeg: a shell script, or where there is no shell to run one
// (Windows) a node script that scriptStandInSpawn starts under node.
const windows = process.platform === 'win32';
async function standIn(name, { sh, node }) {
  const file = join(root, windows ? `${name}.mjs` : `${name}.sh`);
  await writeFile(file, windows ? `${node}\n` : `#!/bin/sh\n${sh}\n`);
  if (!windows) await chmod(file, 0o755);
  return file;
}

const song = ffmpegFile('song.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=200:sample_rate=22050', '-ac', '1']);

// 1. ffmpeg cannot start.
process.env.NEWAMP_FFMPEG_PATH = join(root, 'no-such-ffmpeg');
await assert.rejects(analyzeTrack({ path: song, want: { ...none, loud: true } }), AnalysisEnvironmentError, 'a spawn failure is not a failure of the track');
assert.equal(activeAnalysisDecodes(), 0);

// 2. ffmpeg killed by a signal. Windows has no death by signal: a crash there is
// an exit code (0xC0000005, an access violation). Either way it is a crash, not
// an abort, and nothing is left running.
process.env.NEWAMP_FFMPEG_PATH = await standIn('segv', { sh: 'kill -SEGV $$', node: 'process.exit(0xC0000005);' });
await assert.rejects(analyzeTrack({ path: song, want: { ...none, loud: true } }), AnalysisCrashedError, 'a crash nobody here caused is a crash, not an abort');
assert.equal(activeAnalysisDecodes(), 0);
// An ordinary failed exit is not one.
process.env.NEWAMP_FFMPEG_PATH = await standIn('exit1', { sh: 'exit 1', node: 'process.exit(1);' });
await assert.rejects(
  analyzeTrack({ path: song, want: { ...none, loud: true } }),
  (err) => !(err instanceof AnalysisCrashedError) && !(err instanceof AnalysisAbortedError) && /exited 1/.test(err.message),
  'a failed exit is not a crash',
);

// 3. An abort rejects once the process is gone.
process.env.NEWAMP_FFMPEG_PATH = await standIn('slow', { sh: 'exec sleep 30', node: 'setTimeout(() => {}, 30_000);' });
{
  const abort = new AbortController();
  const pending = analyzeTrack({ path: song, want: { ...none, loud: true }, signal: abort.signal });
  const outcome = pending.then(() => null, (err) => err);
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(activeAnalysisDecodes(), 1, 'the stand-in is running');
  abort.abort();
  assert.ok((await outcome) instanceof AnalysisAbortedError);
  assert.equal(activeAnalysisDecodes(), 0, 'by the time the abort is reported the process has exited');
}

// 4. The real thing.
delete process.env.NEWAMP_FFMPEG_PATH;
{
  const head = await analyzeTrack({ path: song, want: { ...none, tempo: true } });
  assert.ok(head.seconds > 119 && head.seconds < 121, `tempo and key read two minutes, not the whole track (${head.seconds} s)`);
  const dna = await analyzeTrack({ path: song, want: { ...none, dna: true } });
  assert.ok(dna.dna && dna.seconds < 121);
  // Whichever fields are owed, the same excerpt is analysed.
  const both = await analyzeTrack({ path: song, want: { ...none, tempo: true, loud: true } });
  assert.deepEqual(both.tempo, head.tempo, 'the tempo does not depend on which other fields were asked for');
  assert.ok(both.seconds > 199, 'loudness reads the whole track');
  assert.ok(both.loudness && Math.abs(both.loudness.integratedLufs) < 60, 'and measures it');
  const loudOnly = await analyzeTrack({ path: song, want: { ...none, loud: true } });
  assert.ok(loudOnly.seconds > 199 && loudOnly.seconds < 201, `the loudness-only decode reports how far it got (${loudOnly.seconds} s)`);
  assert.ok(loudOnly.loudness);
}

// 5. Longer than the cap: the first twenty minutes are not the track's loudness.
{
  const long = ffmpegFile('long.wav', ['-f', 'lavfi', '-i', `sine=frequency=110:duration=${MAX_ANALYSIS_SECONDS + 100}:sample_rate=8000`, '-ac', '1', '-c:a', 'pcm_u8']);
  const result = await analyzeTrack({ path: long, want: { ...none, loud: true } });
  assert.ok(result.seconds >= MAX_ANALYSIS_SECONDS - 0.5, 'the decode stopped at the cap');
  assert.equal(result.loudness, null, 'no loudness is stored for a track that was only heard in part');
  const exact = await analyzeTrack({ path: long, want: { ...none, tempo: true } });
  assert.ok(exact.tempo, 'tempo and key are still worked out');
}

// 6. A stat that answers, and one that fails.
assert.ok((await statWithin(song)).size > 0);
await assert.rejects(statWithin(join(root, 'missing.wav')), (err) => err instanceof AnalysisUnavailableError || err.code === 'ENOENT');

// 7. A stat that never answers: it is given up on, no second one is started while it hangs, and the next works once it returns.
{
  let started = 0;
  let release;
  const gate = new Promise((done) => { release = done; });
  const slow = async (path) => {
    started += 1;
    await gate;
    return statWithin(path);
  };
  const begun = Date.now();
  await assert.rejects(statWithin(song, 30, slow), AnalysisUnavailableError, 'a stat that does not answer is unreachable');
  assert.ok(Date.now() - begun < 1000, 'and it is given up on at the deadline');
  await assert.rejects(
    statWithin(song, 30, slow),
    (err) => err instanceof AnalysisDrivePendingError && !(err instanceof AnalysisUnavailableError),
    'while it hangs, another is refused, and told apart from a track that cannot be opened',
  );
  assert.equal(started, 1, 'without being started');
  release();
  await new Promise((done) => setTimeout(done, 20));
  assert.ok((await statWithin(song, 30, slow)).size > 0, 'the next stat runs once the hung one has returned');
  assert.equal(started, 2);
}

// 8. ffmpeg exits non-zero. When the operating system would not open the file
// (another program holds it, or it moved since the stat) nothing is known about
// the audio, and it is not written down as undecodable. A file that opened and
// would not decode is an ordinary failure.
{
  const failing = (stderrLine) => standIn('fails', {
    sh: `echo ${JSON.stringify(stderrLine)} >&2; exit 1`,
    node: `process.stderr.write(${JSON.stringify(`${stderrLine}\n`)}); process.exit(1);`,
  });
  for (const line of [
    'song.wav: Permission denied',
    '[in#0 @ 000001] Error opening input: No such file or directory',
    'song.wav: Access is denied.',
  ]) {
    process.env.NEWAMP_FFMPEG_PATH = await failing(line);
    await assert.rejects(analyzeTrack({ path: song, want: { ...none, tempo: true } }), AnalysisUnavailableError, `"${line}" is not a verdict on the track`);
  }
  process.env.NEWAMP_FFMPEG_PATH = await failing('song.wav: Invalid data found when processing input');
  await assert.rejects(
    analyzeTrack({ path: song, want: { ...none, tempo: true } }),
    (err) => !(err instanceof AnalysisUnavailableError) && !(err instanceof AnalysisEnvironmentError) && /ffmpeg exited 1/.test(err.message),
    'a file that opened and would not decode still counts against the track',
  );
  assert.equal(activeAnalysisDecodes(), 0);
}

// 9. Every ffmpeg an analyzer starts is limited to file and pipe inputs, and the
// limit comes before the input it applies to. A stand-in records its arguments.
{
  const argsFile = join(root, 'args.txt');
  process.env.NEWAMP_ARGS_FILE = argsFile;
  process.env.NEWAMP_FFMPEG_PATH = await standIn('record', {
    sh: `printf '%s\\n' "$@" > "$NEWAMP_ARGS_FILE"; exit 1`,
    node: `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.NEWAMP_ARGS_FILE, process.argv.slice(2).join('\\n')); process.exit(1);`,
  });
  initScoreCache(join(root, 'score-cache'));
  const analyzers = {
    'the library analysis (loudness)': () => analyzeTrack({ path: song, want: { ...none, loud: true } }),
    'the library analysis (tempo)': () => analyzeTrack({ path: song, want: { ...none, tempo: true } }),
    'Audio DNA': () => analyzeTrackDna(song),
    'the song score': () => getSongScore({ path: song }),
  };
  for (const [name, run] of Object.entries(analyzers)) {
    await rm(argsFile, { force: true });
    await run().catch(() => undefined);
    const args = (await readFile(argsFile, 'utf8')).split(/\r?\n/);
    const limit = args.indexOf('-protocol_whitelist');
    assert.ok(limit >= 0 && args[limit + 1] === 'file,pipe', `${name} limits ffmpeg to file and pipe inputs`);
    assert.ok(limit < args.indexOf('-i'), `${name}: and before the input`);
  }
}

console.log('[analysis-decode-a7] PASS');
