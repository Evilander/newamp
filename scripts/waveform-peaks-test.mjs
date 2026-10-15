// Main-process waveform builder: the streaming reducer, a real ffmpeg decode of
// a generated WAV (tone, silent gap, quieter tone), the on-disk cache and its
// invalidation, request de-duplication, cue-sheet slices, the queue's
// priorities, cancelling, bounded cache size and child cleanup.
// Run: node scripts/waveform-peaks-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { constants as osConstants, getPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const deadline = setTimeout(() => { console.error('waveform peaks test timed out'); process.exit(1); }, 120000);
deadline.unref();

const root = resolve('tmp', 'waveform-peaks-test');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'cache'), { recursive: true });

// Bundled next to the repo's node_modules so ffmpeg-static still finds its binary.
// stopFfmpegReading rides in the same bundle: it only sees the decodes that were
// registered with the copy of transcode.ts it was bundled with.
const bundlePath = join(root, 'waveform-peaks.bundle.mjs');
await build({
  stdin: {
    contents: `
      export * from './electron/waveform-peaks';
      export { stopFfmpegReading } from './electron/transcode';
      export { reportPlaybackHunger } from './electron/playback-io';
    `,
    resolveDir: resolve('.'),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', packages: 'external',
  outfile: bundlePath, logLevel: 'silent',
});
const peaks = await import(pathToFileURL(bundlePath).href);
const {
  PeakReducer, WAVEFORM_BUCKETS, WAVEFORM_SAMPLE_RATE, activeWaveformDecodes, activeWaveformPids, cancelWaveformWork, getWaveform,
  initWaveformCache, killAllWaveformFfmpeg, stopFfmpegReading, waveformCacheKey, encodeWaveformFile, parseWaveformFile,
  reportPlaybackHunger,
} = peaks;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 16-bit mono WAV from a per-sample function of time. */
function wav(seconds, level, sampleRate = 44100) {
  const total = Math.round(seconds * sampleRate);
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, level(i / sampleRate))) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Raw s16le at the waveform rate. */
function pcm(seconds, level) {
  const total = Math.round(seconds * WAVEFORM_SAMPLE_RATE);
  const out = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) out.writeInt16LE(Math.round(level(i / WAVEFORM_SAMPLE_RATE, i / total) * 32767), i * 2);
  return out;
}

const feed = (reducer, buffer, step) => {
  for (let at = 0; at < buffer.length; at += step) reducer.push(buffer.subarray(at, Math.min(buffer.length, at + step)));
  return reducer.finish();
};
const range = (array, from, to) => Array.from(array.subarray(from, to));
const within = (values, low, high) => values.every((v) => v >= low && v <= high);

// --- The reducer ------------------------------------------------------------

// A sine of known amplitude reads as that peak, and as peak / sqrt(2) in RMS.
{
  const tone = pcm(60, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t));
  const result = feed(new PeakReducer(), tone, tone.length);
  assert.ok(result, 'a minute of tone should reduce');
  assert.equal(result.buckets, WAVEFORM_BUCKETS);
  assert.equal(result.peak.length, WAVEFORM_BUCKETS);
  assert.equal(result.rms.length, WAVEFORM_BUCKETS);
  assert.ok(Math.abs(result.duration - 60) < 0.001, `duration ${result.duration}`);
  assert.ok(within(range(result.peak, 0, WAVEFORM_BUCKETS), 123, 129), `peak ${Math.min(...result.peak)}..${Math.max(...result.peak)}, expected ~128`);
  assert.ok(within(range(result.rms, 0, WAVEFORM_BUCKETS), 87, 93), `rms ${Math.min(...result.rms)}..${Math.max(...result.rms)}, expected ~90`);
}

// Where the bytes are cut must not change anything, including a cut inside a 16-bit sample.
{
  const tone = pcm(9, (t) => 0.8 * Math.sin(2 * Math.PI * 300 * t) * (t < 5 ? 1 : 0.2));
  const whole = feed(new PeakReducer(), tone, tone.length);
  for (const step of [1, 3, 4093]) {
    const pieces = feed(new PeakReducer(), tone, step);
    assert.deepEqual(pieces.peak, whole.peak, `peak differs when fed ${step} bytes at a time`);
    assert.deepEqual(pieces.rms, whole.rms, `rms differs when fed ${step} bytes at a time`);
  }
}

// A rising ramp keeps its shape from a few seconds (no slot merging) to many
// minutes (merged many times): bucket b peaks at (b + 1) / buckets.
for (const seconds of [3, 70, 1500]) {
  const reducer = new PeakReducer();
  const total = seconds * WAVEFORM_SAMPLE_RATE;
  const chunk = Buffer.alloc(40000);
  for (let at = 0; at < total; at += 20000) {
    const n = Math.min(20000, total - at);
    for (let i = 0; i < n; i++) chunk.writeInt16LE(Math.round(((at + i) / total) * 32767), i * 2);
    reducer.push(chunk.subarray(0, n * 2));
  }
  const ramp = reducer.finish();
  assert.ok(ramp, `${seconds}s ramp should reduce`);
  assert.ok(Math.abs(ramp.duration - seconds) < 0.01, `${seconds}s ramp reports ${ramp.duration}`);
  for (const b of [0, 511, 1023, 1535, 2047]) {
    const expected = ((b + 1) / WAVEFORM_BUCKETS) * 255;
    assert.ok(Math.abs(ramp.peak[b] - expected) <= 3, `${seconds}s ramp bucket ${b}: ${ramp.peak[b]}, expected ~${expected.toFixed(0)}`);
  }
  for (let b = 1; b < WAVEFORM_BUCKETS; b++) assert.ok(ramp.peak[b] >= ramp.peak[b - 1] - 1, `${seconds}s ramp must not dip at bucket ${b}`);
  assert.ok(ramp.rms.every((v, b) => v <= ramp.peak[b]), 'rms never exceeds the peak');
}

// Silence reads as zero, and a clip under a second has no waveform.
{
  const quiet = feed(new PeakReducer(), pcm(5, () => 0), 65536);
  assert.ok(quiet.peak.every((v) => v === 0) && quiet.rms.every((v) => v === 0), 'silence is all zeros');
  assert.equal(feed(new PeakReducer(), pcm(0.5, () => 0.5), 65536), null, 'half a second is too short');
  assert.equal(new PeakReducer().finish(), null, 'nothing pushed, nothing to draw');
}

// --- Cache file format -------------------------------------------------------
{
  const reducer = new PeakReducer();
  const data = feed(reducer, pcm(4, (t) => 0.3 * Math.sin(2 * Math.PI * 200 * t)), 8192);
  const text = encodeWaveformFile(data);
  assert.ok(text.length < 8000, `a cache file should stay small (${text.length} bytes)`);
  const back = parseWaveformFile(text);
  assert.deepEqual(back, data, 'encode then parse round-trips');
  assert.equal(back.peak.buffer.byteLength, WAVEFORM_BUCKETS, 'parsed arrays own an exact-size buffer');
  assert.equal(parseWaveformFile('not json'), null);
  assert.equal(parseWaveformFile(JSON.stringify({ ...JSON.parse(text), v: 99 })), null, 'another version is refused');
  assert.equal(parseWaveformFile(JSON.stringify({ ...JSON.parse(text), buckets: 1024 })), null, 'another bucket count is refused');
  assert.equal(parseWaveformFile(JSON.stringify({ ...JSON.parse(text), peak: 'AAAA' })), null, 'a truncated array is refused');
  assert.equal(parseWaveformFile(JSON.stringify({ ...JSON.parse(text), duration: -1 })), null);
}

// The key follows the file and the slice, and folds case where the filesystem does.
{
  const base = { path: 'C:\\Music\\A.flac', size: 100, mtimeMs: 5000.4, start: 0, end: null };
  const key = (parts, platform = 'win32') => waveformCacheKey({ ...base, ...parts }, platform);
  assert.equal(key({}), key({ mtimeMs: 5000.2 }), 'mtime is rounded to the millisecond');
  assert.notEqual(key({}), key({ size: 101 }), 'size is part of the key');
  assert.notEqual(key({}), key({ mtimeMs: 6000 }), 'mtime is part of the key');
  assert.notEqual(key({}), key({ start: 30 }), 'a cue slice has its own key');
  assert.notEqual(key({ start: 30 }), key({ start: 30, end: 60 }));
  assert.equal(key({}), key({ path: 'c:\\music\\a.flac' }), 'Windows folds case');
  assert.notEqual(key({}, 'linux'), key({ path: 'c:\\music\\a.flac' }, 'linux'), 'Linux does not');
}

// --- Real decodes -------------------------------------------------------------
const song = join(root, 'song.wav');
// 0-8 s loud tone, 8-12 s digital silence, 12-20 s a tone at half the level.
await writeFile(song, wav(20, (t) => (t < 8 ? 0.5 : t < 12 ? 0 : 0.25) * Math.sin(2 * Math.PI * (t < 8 ? 440 : 1000) * t)));
const cacheDir = join(root, 'cache');
initWaveformCache(cacheDir);
const cacheFiles = async () => (await readdir(cacheDir)).filter((name) => name.endsWith('.json'));

const coldStart = performance.now();
const [first, twin] = await Promise.all([getWaveform({ path: song }), getWaveform({ path: song })]);
const coldMs = performance.now() - coldStart;
assert.ok(first, 'a 20 s track should produce a waveform');
assert.equal(first, twin, 'concurrent requests for one track share one decode');
assert.equal(first.buckets, WAVEFORM_BUCKETS);
assert.ok(Math.abs(first.duration - 20) < 0.1, `duration ${first.duration}, expected ~20`);
// 20 s over 2048 buckets: the gap is buckets 819 to 1229. Stay 15 buckets (0.15 s) off every edge.
assert.ok(within(range(first.peak, 20, 800), 120, 134), `loud tone peaks ${Math.min(...range(first.peak, 20, 800))}..${Math.max(...range(first.peak, 20, 800))}, expected ~128`);
assert.ok(within(range(first.rms, 20, 800), 84, 96), 'loud tone rms is about peak / sqrt(2)');
assert.ok(within(range(first.peak, 835, 1213), 0, 3), `the silent gap should read ~0, got up to ${Math.max(...range(first.peak, 835, 1213))}`);
assert.ok(within(range(first.rms, 835, 1213), 0, 2), 'and its rms too');
assert.ok(within(range(first.peak, 1245, 2030), 58, 70), `the quiet tone peaks ${Math.min(...range(first.peak, 1245, 2030))}..${Math.max(...range(first.peak, 1245, 2030))}, expected ~64`);
console.log(`cold decode of a 20 s track: ${coldMs.toFixed(0)} ms`);

// Cached on disk, and the second read is served from there.
assert.equal((await cacheFiles()).length, 1, 'one cache file for one track');
const warmStart = performance.now();
const again = await getWaveform({ path: song });
const warmMs = performance.now() - warmStart;
assert.deepEqual(again, first, 'the cached waveform round-trips unchanged');
assert.ok(warmMs < Math.max(40, coldMs / 3), `cache read took ${warmMs.toFixed(0)} ms vs ${coldMs.toFixed(0)} ms cold`);
assert.equal((await cacheFiles()).length, 1, 'a hit writes nothing new');

// A different file at the same path (size and mtime change) is a new entry.
{
  await writeFile(song, wav(20, (t) => 0.9 * Math.sin(2 * Math.PI * 440 * t) * (t < 10 ? 1 : 0)));
  const changed = await getWaveform({ path: song });
  assert.ok(changed, 'the rewritten file decodes');
  assert.ok(within(range(changed.peak, 20, 900), 220, 238), 'the new file is read, not the cached old one');
  assert.ok(within(range(changed.peak, 1100, 2030), 0, 3), 'including its silent second half');
  assert.equal((await cacheFiles()).length, 2, 'the old entry stays until pruning; the new one has its own key');
}

// Same size, only the modified time moves: still invalidated.
{
  const before = (await cacheFiles()).length;
  const when = new Date(Date.now() + 90_000);
  await utimes(song, when, when);
  const touched = await getWaveform({ path: song });
  assert.ok(touched, 'a touched file decodes');
  assert.equal((await cacheFiles()).length, before + 1, 'a new mtime is a new key');
}

// A cache file that is damaged is rebuilt, not trusted.
{
  const [name] = await cacheFiles();
  const damaged = await getWaveform({ path: song });
  for (const file of await cacheFiles()) await writeFile(join(cacheDir, file), '{"v":1,"buckets":2048,"duration":3,"peak":"AAAA","rms":"AAAA"}');
  const rebuilt = await getWaveform({ path: song });
  assert.ok(rebuilt && rebuilt.peak.length === WAVEFORM_BUCKETS, 'a damaged file decodes again');
  assert.deepEqual(rebuilt.peak, damaged.peak, 'to the same answer');
  assert.ok(name);
}

// A cue-sheet slice is its own, shorter waveform.
{
  const slice = await getWaveform({ path: song, cueStart: 12, cueEnd: 16 });
  assert.ok(slice, 'a 4 s cue slice should produce a waveform');
  assert.ok(Math.abs(slice.duration - 4) < 0.1, `cue slice duration ${slice.duration}, expected ~4`);
  assert.ok(within(range(slice.peak, 0, WAVEFORM_BUCKETS), 0, 3), 'the slice covers the silent half only');
  const open = await getWaveform({ path: song, cueStart: 5 });
  assert.ok(Math.abs(open.duration - 15) < 0.1, `a slice with no end runs to the end of the file (${open.duration})`);
  assert.ok(within(range(open.peak, 20, 600), 220, 238) && within(range(open.peak, 1200, 2030), 0, 3), 'and starts where it was told');
}

// Things that can't have a waveform answer null instead of throwing.
{
  assert.equal(await getWaveform({ path: join(root, 'missing.flac') }), null, 'a missing file');
  assert.equal(await getWaveform({ path: '' }), null, 'no path');
  const clip = join(root, 'clip.wav');
  await writeFile(clip, wav(0.4, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t)));
  assert.equal(await getWaveform({ path: clip }), null, 'a clip under a second');
  const text = join(root, 'notes.wav');
  await writeFile(text, 'this is not audio at all');
  assert.equal(await getWaveform({ path: text }), null, 'a file ffmpeg cannot read');
  const startedAt = performance.now();
  assert.equal(await getWaveform({ path: text }), null, 'asked again');
  assert.ok(performance.now() - startedAt < 30, 'a known failure answers without starting ffmpeg again');
  assert.equal(await getWaveform({ path: song, duration: 4 * 3600 }), null, 'a track the library says is over three hours stays plain');
}

// --- Priorities -----------------------------------------------------------------
// The track on screen goes first: prefetches still waiting are dropped, and a
// decode already running for another track is stopped.
const cacheHas = async (path) => {
  const info = await stat(path);
  return (await cacheFiles()).includes(`${waveformCacheKey({ path, size: info.size, mtimeMs: info.mtimeMs, start: 0, end: null })}.json`);
};
// A long file at the decode rate, so ffmpeg is still running when the next request arrives. A
// fast machine can finish it first, so each scenario below runs again on fresh files (a
// finished decode would be served from the cache) until the decode was caught in the act.
const slow = join(root, 'slow.wav');
await writeFile(slow, wav(600, (t) => 0.3 * Math.sin(2 * Math.PI * 200 * t), WAVEFORM_SAMPLE_RATE));
const waitForDecode = async () => {
  for (let tries = 0; tries < 400 && activeWaveformDecodes() === 0; tries++) await sleep(1);
  return activeWaveformDecodes() > 0;
};
let fileCount = 0;
const freshWav = async (seconds, level = (t) => 0.3 * Math.sin(2 * Math.PI * 330 * t), rate = 44100) => {
  const file = join(root, `fresh-${fileCount++}.wav`);
  await writeFile(file, wav(seconds, level, rate));
  return file;
};
const longTrack = () => freshWav(900, (t) => 0.3 * Math.sin(2 * Math.PI * 200 * t), WAVEFORM_SAMPLE_RATE);
/** Runs `scenario(longFile)` until it reports that the long decode was still going when it acted. */
async function whileDecoding(name, scenario) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const long = await longTrack();
    if (await scenario(long)) return;
  }
  assert.fail(`${name}: the decode was over before the test could act, six times`);
}

await whileDecoding('priorities', async (long) => {
  const files = [];
  for (let i = 0; i < 3; i++) files.push(await freshWav(20 + i, (t) => (0.2 + i * 0.1) * Math.sin(2 * Math.PI * 330 * t)));
  const running = getWaveform({ path: long }, { prefetch: true });
  if (!(await waitForDecode())) {
    await running;
    return false;
  }
  const first = getWaveform({ path: files[0] }, { prefetch: true });
  await sleep(3);
  const second = getWaveform({ path: files[1] }, { prefetch: true });
  await sleep(3);
  const urgent = await getWaveform({ path: files[2] });
  const [droppedFirst, droppedSecond, overtaken] = await Promise.all([first, second, running]);
  if (overtaken !== null) return false;
  assert.ok(urgent, 'the track asked for now is built');
  assert.deepEqual([droppedFirst, droppedSecond], [null, null], 'prefetches that were still waiting were dropped');
  assert.ok(await cacheHas(files[2]), 'the urgent track is cached');
  assert.ok(!(await cacheHas(files[1])), 'a dropped prefetch is not');
  assert.equal(activeWaveformDecodes(), 0, 'nothing is left running');

  // A track that was overtaken can be asked for again straight away.
  const retry = await getWaveform({ path: files[0] });
  assert.ok(retry, 'asking again after being dropped decodes it');

  // A prefetch that turns into the track on screen shares one result.
  const ahead = getWaveform({ path: files[1] }, { prefetch: true });
  const needed = getWaveform({ path: files[1] });
  const [a, b] = await Promise.all([ahead, needed]);
  assert.ok(a && a === b, 'a prefetch and the urgent request for the same track share one result');
  return true;
});

// --- Playback comes first -------------------------------------------------------------
// While the gapless stream is short of audio, a decode waits to start, and a
// prefetch already running is stopped without counting as a bad file.
{
  const stream = {};
  const file = await freshWav(12);
  reportPlaybackHunger(stream, true);
  const held = getWaveform({ path: file });
  await sleep(400);
  assert.equal(activeWaveformDecodes(), 0, 'no decode starts while playback is short of audio');
  reportPlaybackHunger(stream, false);
  assert.ok(await held, 'the waiting request decodes once playback is fed');
}
await whileDecoding('prefetch stopped for playback', async (long) => {
  const stream = {};
  const prefetch = getWaveform({ path: long }, { prefetch: true });
  if (!(await waitForDecode())) {
    await prefetch;
    return false;
  }
  reportPlaybackHunger(stream, true);
  const stopped = await prefetch;
  reportPlaybackHunger(stream, false);
  if (stopped !== null) return false;
  assert.equal(activeWaveformDecodes(), 0, 'the prefetch decode was stopped');
  assert.ok(!(await cacheHas(long)), 'nothing was cached for it');
  // Not remembered as a bad file: it decodes when it is the track playing.
  assert.ok(await getWaveform({ path: long }), 'a stopped prefetch decodes when asked for again');
  return true;
});
await whileDecoding('urgent decode kept', async (long) => {
  const stream = {};
  const urgent = getWaveform({ path: long });
  if (!(await waitForDecode())) {
    await urgent;
    return false;
  }
  reportPlaybackHunger(stream, true);
  await sleep(50);
  const still = activeWaveformDecodes();
  reportPlaybackHunger(stream, false);
  assert.equal(still, 1, 'the decode for the track playing is not stopped');
  assert.ok(await urgent, 'and it finishes');
  return true;
});

// --- Decodes run below normal priority --------------------------------------------------
await whileDecoding('priority', async (long) => {
  const pending = getWaveform({ path: long }, { prefetch: true });
  if (!(await waitForDecode())) {
    await pending;
    return false;
  }
  const [pid] = activeWaveformPids();
  let priority = null;
  try {
    priority = getPriority(pid);
  } catch {
    /* it finished between the two calls */
  }
  cancelWaveformWork();
  await pending;
  if (priority === null) return false;
  assert.equal(priority, osConstants.priority.PRIORITY_BELOW_NORMAL, 'the ffmpeg child runs below normal priority');
  return true;
});

// --- Cancelling ----------------------------------------------------------------------------
// Turning the seek bar off stops what is running and what is waiting, and leaves the queue open.
await whileDecoding('cancel', async (long) => {
  const waitingFile = await freshWav(20);
  const running = getWaveform({ path: long }, { prefetch: true });
  if (!(await waitForDecode())) {
    await running;
    return false;
  }
  const queued = getWaveform({ path: waitingFile }, { prefetch: true });
  await sleep(3);
  cancelWaveformWork();
  const [stopped, dropped] = await Promise.all([running, queued]);
  if (stopped !== null) return false;
  assert.equal(dropped, null, 'a decode that was waiting is dropped');
  assert.equal(activeWaveformDecodes(), 0, 'and the child is gone');
  assert.ok(await getWaveform({ path: waitingFile }), 'the queue is still open afterwards');
  assert.ok(await getWaveform({ path: long }), 'a cancelled track is not marked as undecodable');
  return true;
});
{
  // A request that was still checking its file when the work was cancelled never starts.
  const file = await freshWav(20);
  const early = getWaveform({ path: file }, { prefetch: true });
  cancelWaveformWork();
  assert.equal(await early, null, 'a request caught by the cancel answers null');
  assert.equal(activeWaveformDecodes(), 0);
  assert.ok(await getWaveform({ path: file }), 'and is built when asked for again');
}

// --- A decode stopped from outside is not a bad file ----------------------------------------
// The Recycle Bin flow stops ffmpeg children that hold a file open.
await whileDecoding('stopped from outside', async (long) => {
  const pending = getWaveform({ path: long }, { prefetch: true });
  if (!(await waitForDecode())) {
    await pending;
    return false;
  }
  await stopFfmpegReading([long]);
  if ((await pending) !== null) return false;
  assert.equal(activeWaveformDecodes(), 0);
  assert.ok(await getWaveform({ path: long }), 'the file decodes when asked for again; it was not remembered as a failure');
  return true;
});

// --- A cache folder that disappears is made again ----------------------------------------
{
  const gone = join(root, 'vanishing');
  initWaveformCache(gone);
  await getWaveform({ path: join(root, 'missing.flac') }); // resolves once the folder is ready
  await rm(gone, { recursive: true, force: true });
  const file = await freshWav(20);
  assert.ok(await getWaveform({ path: file }), 'the waveform is still built');
  const kept = (await readdir(gone)).filter((name) => name.endsWith('.json'));
  assert.equal(kept.length, 1, 'and cached in the folder that was made again');
  initWaveformCache(cacheDir);
}

// --- A file longer than the cap is not drawn as if it were whole --------------------------
{
  // One sample per second for three hours and a bit: 10 KB on disk, 3 h of audio to ffmpeg.
  const long = await freshWav(10860, () => 0.4, 1);
  const startedAt = performance.now();
  assert.equal(await getWaveform({ path: long }), null, 'unknown length and longer than the cap: the first three hours would pass for all of it');
  console.log(`three-hour cap: ${(performance.now() - startedAt).toFixed(0)} ms`);
  assert.equal(await getWaveform({ path: long, duration: 10860 }), null, 'a known length over the cap');
}

// --- A stopped decode lets go of its file -----------------------------------------
// Stopped for quit while ffmpeg is running.
await whileDecoding('quit', async (long) => {
  initWaveformCache(cacheDir);
  const pending = getWaveform({ path: long }, { prefetch: true });
  if (!(await waitForDecode())) {
    await pending;
    return false;
  }
  killAllWaveformFfmpeg();
  if ((await pending) !== null) return false;
  assert.equal(activeWaveformDecodes(), 0, 'a decode stopped for quit resolves null and its child is gone');
  assert.equal(await getWaveform({ path: song }), null, 'nothing new starts once the app is quitting');
  // On Windows a file ffmpeg still has open cannot be renamed.
  let moved = false;
  for (let attempt = 0; attempt < 40 && !moved; attempt++) {
    try {
      await rename(long, `${long}.moved`);
      moved = true;
    } catch {
      await sleep(50);
    }
  }
  assert.ok(moved, 'the ffmpeg child released the file');
  initWaveformCache(cacheDir);
  assert.ok(await getWaveform({ path: song }), 'initialising the cache again re-opens the queue');
  return true;
});

// --- The cache stays bounded ------------------------------------------------------------
{
  const crowded = join(root, 'crowded');
  await mkdir(crowded, { recursive: true });
  const old = new Date(Date.now() - 86_400_000);
  const names = [];
  for (let i = 0; i < 6100; i++) names.push(`${String(i).padStart(40, '0')}.json`);
  await Promise.all(names.map(async (name, i) => {
    const file = join(crowded, name);
    await writeFile(file, '{}');
    // The first thousand are the least recently used.
    await utimes(file, new Date(old.getTime() + i * 1000), new Date(old.getTime() + i * 1000));
  }));
  await writeFile(join(crowded, 'stale.json.123.part'), 'x');
  await utimes(join(crowded, 'stale.json.123.part'), old, old);
  await writeFile(join(crowded, 'fresh.json.456.part'), 'x');
  initWaveformCache(crowded);
  await getWaveform({ path: join(root, 'missing.flac') }); // resolves once the cache is ready
  let left = 6100;
  for (let attempt = 0; attempt < 60; attempt++) {
    left = (await readdir(crowded)).filter((name) => name.endsWith('.json')).length;
    if (left <= 4880) break;
    await sleep(100);
  }
  assert.ok(left <= 4880 && left > 4000, `pruning should drop the oldest fifth of 6100, ${left} left`);
  const names2 = new Set(await readdir(crowded));
  assert.ok(!names2.has(names[0]), 'the least recently used file went first');
  assert.ok(names2.has(names[6099]), 'the most recently used stayed');
  assert.ok(!names2.has('stale.json.123.part'), 'leftover partial writes are removed');
  assert.ok(names2.has('fresh.json.456.part'), 'but one that may still be written to is left alone');
  initWaveformCache(cacheDir);
}

await stat(song);
console.log('waveform-peaks-test: ok');
