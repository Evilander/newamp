// Main-process song-score analyser: real ffmpeg decode of a generated WAV,
// analysis, the on-disk cache, request de-duplication, cue-sheet slices and
// the "no score" answers. Run: npm run test:score-analyzer
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'score-analyzer-test');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'cache'), { recursive: true });

const { initScoreCache, getSongScore } = await import(
  pathToFileURL(resolve('dist-electron/electron/score-analyzer.js')).href
);

/** 16-bit mono WAV: a click + tone on every beat, louder in the second half. */
function wav(seconds, bpm, sampleRate = 44100) {
  const total = Math.round(seconds * sampleRate);
  const pcm = Buffer.alloc(total * 2);
  const beat = 60 / bpm;
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const sinceBeat = t % beat;
    const loud = t > seconds / 2 ? 1 : 0.35;
    const click = Math.exp(-sinceBeat * 40) * Math.sin(2 * Math.PI * 70 * sinceBeat) * 0.8;
    const tone = Math.sin(2 * Math.PI * 220 * t) * 0.15 + (t > seconds / 2 ? Math.sin(2 * Math.PI * 1760 * t) * 0.12 : 0);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, (click + tone) * loud)) * 32767), i * 2);
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

const song = join(root, 'song.wav');
await writeFile(song, wav(64, 128));
const stub = join(root, 'stub.wav');
await writeFile(stub, wav(6, 128));

initScoreCache(join(root, 'cache'));

// Two simultaneous requests for one track share one analysis.
const startedCold = Date.now();
const [first, twin] = await Promise.all([getSongScore({ path: song }), getSongScore({ path: song })]);
const coldMs = Date.now() - startedCold;
assert.ok(first, 'a 64 s track should produce a score');
assert.equal(first, twin, 'concurrent requests for one track must share a single analysis');
assert.ok(Math.abs(first.bpm - 128) < 3, `bpm ${first.bpm}, expected ~128`);
assert.ok(Math.abs(first.duration - 64) < 0.5, `duration ${first.duration}, expected ~64`);
assert.ok(first.sections.length >= 2, 'the level change at the midpoint should split the track');
assert.ok(first.sections.some((s) => Math.abs(s.start - 32) < 2.5), `a section should start near 32 s (got ${first.sections.map((s) => s.start)})`);

// Cached on disk, and the second read is served from there.
const files = (await readdir(join(root, 'cache'))).filter((name) => name.endsWith('.json'));
assert.equal(files.length, 1, `expected one cached score, found ${files.length}`);
const startedWarm = Date.now();
const again = await getSongScore({ path: song });
const warmMs = Date.now() - startedWarm;
assert.deepEqual(again, first, 'cached score must round-trip unchanged');
assert.ok(warmMs < Math.max(60, coldMs / 3), `cache read took ${warmMs}ms vs ${coldMs}ms cold`);

// A cue-sheet slice is its own, shorter, score.
const slice = await getSongScore({ path: song, cueStart: 30, cueEnd: 60 });
assert.ok(slice, 'a 30 s cue slice should produce a score');
assert.ok(Math.abs(slice.duration - 30) < 0.5, `cue slice duration ${slice.duration}, expected ~30`);
assert.equal((await readdir(join(root, 'cache'))).filter((name) => name.endsWith('.json')).length, 2, 'the slice is cached separately');

// Things that can't have a score answer null instead of throwing.
assert.equal(await getSongScore({ path: stub }), null, 'a 6 s clip has no structure to score');
assert.equal(await getSongScore({ path: join(root, 'missing.flac') }), null, 'a missing file must resolve null');
assert.equal(await getSongScore({ path: '' }), null, 'an empty path must resolve null');
const garbage = join(root, 'garbage.mp3');
await writeFile(garbage, Buffer.from('this is not audio'));
assert.equal(await getSongScore({ path: garbage }), null, 'an undecodable file must resolve null');

console.log(`[score-analyzer-test] PASS (cold ${coldMs}ms, warm ${warmMs}ms, bpm ${first.bpm}, sections ${first.sections.map((s) => s.start).join('/')})`);
