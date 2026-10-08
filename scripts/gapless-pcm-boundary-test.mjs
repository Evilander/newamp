// PCM-capture regression test for gapless playback on the shared output.
//
//   npm run smoke:gapless-pcm
//
// Generates a continuous signal (a rising chirp plus two steady tones, so any
// dropped, inserted or zeroed sample shows up as a phase jump and a click),
// splits it at a point that lines up with no codec frame, and encodes the two
// halves as FLAC, LAME MP3 and AAC-in-M4A (as ffmpeg writes it, with an edit
// list, and as iTunes does, with only iTunSMPB). Each pair plays A→B through
// the real AudioEngine in real Electron — once through the old deck path, once
// through the sample-accurate transport — while a capture worklet on the master gain
// records the graph's final output. The capture is then aligned against the
// analytic signal on both sides of the boundary:
//   excess samples   lag after the boundary minus lag before it (0 = gapless)
//   zero runs        runs of 16+ silent samples (below -180 dBFS) inside the
//                    music; the 0 dB EQ biquads ring down at 1e-10..1e-19
//                    after a source stops, so "exactly 0.0" would undercount
//   boundary error   residual within ±10 ms of the boundary vs 0.5 s earlier
//   click ratio      peak second difference at the boundary vs 0.5 s earlier
//   exact            transport output vs ffmpeg's own decode, sample for sample
// Behavior cases (pause/resume, a pause long enough to release the decoder,
// seek near a boundary, skip over a chained track, rapid skip, stop, a
// corrupt next file, a revoked chain, a 50 ms chained track the queue reaches
// late, a prepare sent before the first track has started, ReplayGain
// switching on the boundary sample, an output-device change, a 44.1→48→44.1
// kHz chain with and without a revoked splice, and how far ahead of the
// playhead the producer runs with a 60 s track chained) run through the
// transport and are checked the same way. A format sweep (Opus, Vorbis, WAV,
// AIFF, WavPack, ALAC in M4A, and an Opus file whose header claims 44.1 kHz)
// runs the same chain through the transport only.
//
// `--only=flac48-transport,seek` runs a subset.
//
// Electron runs scripts/gapless-pcm-app (scripts/gapless-pcm-harness.mjs),
// which loads the built dist-electron gapless module and preload, so build
// electron first. Results: tmp/gapless-pcm-test/report.json.

import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeItunesStyle } from './lib/itunes-aac.mjs';

const repoRoot = resolve('.');
const root = resolve('tmp', 'gapless-pcm-test');
const mediaDir = join(root, 'media');
const pageDir = join(root, 'page');
const outDir = join(root, 'out');
const marker = '[newamp-gapless-pcm] ';
const CTX_RATE = 48000;
const A_SECONDS = 3.5;
const B_SECONDS = 2.5;
const C_SECONDS = 3;
// Split offset: not a multiple of any codec frame (FLAC 4096, MP3 1152, AAC 1024).
const SPLIT_EXTRA = 37;
const RG_DB = -6.0206;
const SILENCE = 1e-9;
// Past its 3 s high-water mark the producer can still take one 64 KiB pipe
// read, plus what an exited decoder left in its pipe and stream buffer (see
// scripts/gapless-producer-test.mjs).
const QUEUE_BOUND_SEC = 3 + (4 * 8192) / CTX_RATE;

const SIGNALS = {
  main: (t) =>
    0.25 * Math.sin(2 * Math.PI * (55 * t + 20 * t * t)) +
    0.2 * Math.sin(2 * Math.PI * 441.3 * t + 0.7) +
    0.1 * Math.sin(2 * Math.PI * 3001.9 * t + 1.9),
  other: (t) =>
    0.25 * Math.sin(2 * Math.PI * (180 * t - 9 * t * t) + 0.4) +
    0.2 * Math.sin(2 * Math.PI * 733.1 * t + 2.2) +
    0.1 * Math.sin(2 * Math.PI * 2203.7 * t),
};

const CODECS = {
  flac: { ext: 'flac', args: ['-c:a', 'flac', '-sample_fmt', 's16'] },
  mp3: { ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '256k'] },
  aac: { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '256k'] },
  // Rewritten after encoding to iTunes' layout: iTunSMPB and no edit list.
  aacitunes: { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '256k', '-use_editlist', '0', '-map_metadata', '-1', '-fflags', '+bitexact'] },
  opus: { ext: 'opus', args: ['-c:a', 'libopus', '-b:a', '192k'] },
  vorbis: { ext: 'ogg', args: ['-c:a', 'libvorbis', '-q:a', '6'] },
  wav: { ext: 'wav', args: ['-c:a', 'pcm_s24le'] },
  aiff: { ext: 'aiff', args: ['-c:a', 'pcm_s16be'] },
  wavpack: { ext: 'wv', args: ['-c:a', 'wavpack'] },
  alac: { ext: 'm4a', args: ['-c:a', 'alac'] },
};
// Transport-only: the deck path plays several of these through the transcode
// cache, or not at all (ALAC in M4A), so there is no like-for-like "before".
const SWEEP = ['opus', 'vorbis', 'wav', 'aiff', 'wavpack', 'alac'];

if (!ffmpeg) fatal('ffmpeg-static did not resolve a binary for this platform');
if (!existsSync(join(repoRoot, 'dist-electron', 'electron', 'gapless-transport.js'))) {
  fatal('dist-electron is missing the gapless transport; run `npm run build:electron` first');
}

rmSync(root, { recursive: true, force: true });
for (const dir of [mediaDir, pageDir, outDir]) mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------- fixtures

let nextId = 1;
const fixtures = [];
function addFixture(fields) {
  const fixture = { id: nextId++, ...fields };
  fixtures.push(fixture);
  return fixture;
}

function synth(signal, rate, startFrame, frames) {
  const out = new Float32Array(frames * 2);
  for (let n = 0; n < frames; n++) {
    const v = SIGNALS[signal]((startFrame + n) / rate);
    out[2 * n] = v;
    out[2 * n + 1] = v;
  }
  return out;
}

function encode(pcm, rate, codec, path) {
  const r = spawnSync(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', 'pipe:0', ...CODECS[codec].args, path],
    { input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), maxBuffer: 1 << 28, windowsHide: true },
  );
  if (r.status !== 0) fatal(`ffmpeg encode failed for ${path}: ${r.stderr}`);
}

/** Left channel exactly as the transport's decoder produces it. */
function decodeLeft(path, rate) {
  const r = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '2', '-ar', String(rate),
      '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    { maxBuffer: 1 << 28, windowsHide: true },
  );
  if (r.status !== 0) fatal(`ffmpeg decode failed for ${path}: ${r.stderr}`);
  const stereo = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
  const left = new Float32Array(stereo.length / 2);
  for (let n = 0; n < left.length; n++) left[n] = stereo[2 * n];
  return left;
}

function splitPair(codec, rate, variant = '') {
  const split = Math.round(A_SECONDS * rate) + SPLIT_EXTRA;
  const total = Math.round((A_SECONDS + B_SECONDS) * rate);
  const pair = {};
  for (const [half, start, frames] of [['a', 0, split], ['b', split, total - split]]) {
    const path = join(mediaDir, `${codec}${variant}-${rate}-${half}.${CODECS[codec].ext}`);
    encode(synth('main', rate, start, frames), rate, codec, path);
    if (codec === 'aacitunes') makeItunesStyle(path, frames);
    pair[half] = addFixture({ path, sampleRate: rate, duration: frames / rate, frames, codec });
  }
  return { ...pair, rate, codec, split, total };
}

/** Consecutive stretches of the `main` signal, each encoded as FLAC at its own rate. */
function rateChain(name, parts) {
  return parts.map(({ rate, from, to }, i) => {
    const path = join(mediaDir, `${name}-${i}-${rate}.flac`);
    const frames = Math.round((to - from) * rate);
    encode(synth('main', rate, Math.round(from * rate), frames), rate, 'flac', path);
    return addFixture({ path, sampleRate: rate, duration: frames / rate, frames, codec: 'flac' });
  });
}

// Ogg CRC-32: polynomial 0x04c11db7, no reflection, zero init.
const OGG_CRC = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});

/**
 * Rewrite an Opus file's OpusHead input rate to 44100, as opusenc does for a
 * 44.1 kHz source. Tags then read 44.1 kHz; every decoder still runs at 48.
 */
function claim44kInOpusHead(path) {
  const bytes = readFileSync(path);
  const body = 27 + bytes[26];
  if (bytes.toString('latin1', 0, 4) !== 'OggS' || bytes.toString('latin1', body, body + 8) !== 'OpusHead') fatal(`unexpected Ogg layout in ${path}`);
  let pageLength = body;
  for (let i = 0; i < bytes[26]; i++) pageLength += bytes[27 + i];
  bytes.writeUInt32LE(44100, body + 12);
  bytes.writeUInt32LE(0, 22);
  let crc = 0;
  for (const byte of bytes.subarray(0, pageLength)) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  bytes.writeUInt32LE(crc, 22);
  writeFileSync(path, bytes);
}

console.error('[gapless-pcm] generating fixtures');
const pairs = {
  flac48: splitPair('flac', 48000),
  mp348: splitPair('mp3', 48000),
  aac48: splitPair('aac', 48000),
  aacitunes48: splitPair('aacitunes', 48000),
  flac44: splitPair('flac', 44100),
  mp344: splitPair('mp3', 44100),
};
for (const codec of SWEEP) pairs[`${codec}48`] = splitPair(codec, 48000);
pairs.opushdr48 = splitPair('opus', 48000, 'hdr');
claim44kInOpusHead(pairs.opushdr48.a.path);
claim44kInOpusHead(pairs.opushdr48.b.path);
const cPath = join(mediaDir, 'other-48000.flac');
encode(synth('other', 48000, 0, C_SECONDS * 48000), 48000, 'flac', cPath);
const other = addFixture({ path: cPath, sampleRate: 48000, duration: C_SECONDS, codec: 'flac' });
const corruptPath = join(mediaDir, 'corrupt.flac');
writeFileSync(corruptPath, Buffer.concat([Buffer.from('fLaC'), Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7919) & 0xff))]));
const corrupt = addFixture({ path: corruptPath, sampleRate: 48000, duration: 3, codec: 'flac' });
// Shorter than one worklet report: it plays out before the queue gets to it.
const blipPath = join(mediaDir, 'blip-48000.flac');
encode(synth('other', 48000, 0, 2400), 48000, 'flac', blipPath);
const blip = addFixture({ path: blipPath, sampleRate: 48000, duration: 0.05, frames: 2400, codec: 'flac' });
// The flac48 A again, behind a library lookup slow enough that a prepare
// sent right after the start is planned first.
const { id: _flacAId, ...flacA } = pairs.flac48.a;
const slowA = addFixture({ ...flacA, resolveDelayMs: 150 });
const mixed = rateChain('mixed', [
  { rate: 44100, from: 0, to: 2 },
  { rate: 48000, from: 2, to: 4 },
  { rate: 44100, from: 4, to: 6 },
]);
const [revokeA, revokeC] = rateChain('mixrevoke', [
  { rate: 44100, from: 0, to: 2 },
  { rate: 44100, from: 2, to: 4 },
]);
const revokeB = rateChain('mixrevoke-b', [{ rate: 48000, from: 7, to: 9 }])[0];
const [longA, longB] = rateChain('long', [
  { rate: 48000, from: 0, to: 3.04 },
  { rate: 48000, from: 3.04, to: 63.04 },
]);

// ---------------------------------------------------------------- probe page

console.error('[gapless-pcm] bundling probe');
await build({
  entryPoints: [resolve('scripts', 'gapless-pcm-probe.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(pageDir, 'probe.js'),
  define: { 'import.meta.env.DEV': 'false' },
  logLevel: 'silent',
});
copyFileSync(resolve('src', 'audio', 'gapless-processor.js'), join(pageDir, 'gapless-processor.js'));
copyFileSync(resolve('scripts', 'gapless-pcm-capture.js'), join(pageDir, 'gapless-pcm-capture.js'));
// media-src matches the app's: the engine's media-session anchor plays a blob: URL.
writeFileSync(
  join(pageDir, 'probe.html'),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; media-src 'self' blob: newamp:; connect-src 'self' newamp:"><title>gapless pcm probe</title><script type="module" src="./probe.js"></script>`,
);

// ---------------------------------------------------------------- cases

const ref = (fixture) => ({ id: fixture.id, path: fixture.path });
const chainCase = (name, pair, transport, kind = 'chain', extra = {}) => ({
  name,
  kind,
  transport,
  rate: CTX_RATE,
  a: ref(pair.a),
  b: ref(pair.b),
  aDuration: pair.a.duration,
  bDuration: pair.b.duration,
  ...extra,
});
const flac = pairs.flac48;
const cases = [];
for (const key of ['flac48', 'mp348', 'aac48', 'aacitunes48', 'flac44', 'mp344']) {
  cases.push(chainCase(`${key}-deck`, pairs[key], false));
  cases.push(chainCase(`${key}-transport`, pairs[key], true));
}
for (const codec of SWEEP) cases.push(chainCase(`${codec}48-transport`, pairs[`${codec}48`], true));
cases.push(chainCase('opushdr48-transport', pairs.opushdr48, true));
const withC = { c: ref(other), cDuration: other.duration };
const chain = (name, kind, parts) => ({
  name,
  kind,
  transport: true,
  rate: CTX_RATE,
  ...Object.fromEntries(parts.flatMap((fixture, i) => [['abc'[i], ref(fixture)], [`${'abc'[i]}Duration`, fixture.duration]])),
});
cases.push(
  chainCase('replaygain', flac, true, 'replaygain', { gainDb: RG_DB }),
  chainCase('device', flac, true, 'device'),
  chainCase('pause', flac, true, 'pause'),
  chainCase('seek', flac, true, 'seek'),
  chainCase('skip', flac, true, 'skip', withC),
  chainCase('rapid', flac, true, 'rapid', withC),
  chainCase('stop', flac, true, 'stop'),
  { ...chainCase('corrupt', flac, true, 'corrupt', withC), b: ref(corrupt), bDuration: corrupt.duration },
  chainCase('revoke', flac, true, 'revoke', withC),
  chainCase('handoff', flac, true, 'handoff'),
  chainCase('startrace', flac, true, 'startrace'),
  chainCase('park', flac, true, 'park'),
  chain('shortb', 'shortb', [flac.a, blip, other]),
  chain('pending', 'pending', [slowA, flac.b]),
  chain('mixed', 'chain3', mixed),
  chain('mixedrevoke', 'revoke', [revokeA, revokeB, revokeC]),
  chain('longbp', 'longbp', [longA, longB]),
);

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',');
if (only) cases.splice(0, cases.length, ...cases.filter((c) => only.includes(c.name)));
const ran = (name) => cases.some((c) => c.name === name);

const planPath = join(root, 'plan.json');
writeFileSync(planPath, JSON.stringify({ fixtures, cases, pageDir, outDir, timeoutMs: (only ? 2 : 10) * 60 * 1000 }, null, 2));

console.error(`[gapless-pcm] running ${cases.length} cases in Electron`);
const harness = await runHarness();
if (!harness.ok) fatal(`harness failed: ${harness.error}`);

// ---------------------------------------------------------------- analysis

function readCapture(name) {
  const bytes = readFileSync(join(outDir, `${name}.f32`));
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function readResult(name) {
  return JSON.parse(readFileSync(join(outDir, `${name}.json`), 'utf8'));
}

function analytic(signal, rate, frames) {
  const out = new Float64Array(frames);
  for (let n = 0; n < frames; n++) out[n] = SIGNALS[signal](n / rate);
  return out;
}

function firstSignal(x, from = 0) {
  for (let i = from; i < x.length; i++) if (Math.abs(x[i]) > 1e-4) return i;
  return -1;
}

function lastSignal(x) {
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > 1e-4) return i;
  return -1;
}

function zeroRuns(x, from, to) {
  const runs = [];
  let run = -1;
  for (let i = from; i <= to; i++) {
    if (Math.abs(x[i]) < SILENCE) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      if (i - run >= 16) runs.push({ start: run, length: i - run });
      run = -1;
    }
  }
  return runs;
}

/** Lag L (with parabolic sub-sample refinement) where capture[i] best matches ref[i - L]. */
function bestLag(capture, reference, capStart, length, lagMin, lagMax) {
  let capEnergy = 0;
  for (let i = capStart; i < capStart + length; i++) capEnergy += (capture[i] ?? 0) ** 2;
  const scores = new Map();
  let best = { lag: lagMin, score: -Infinity };
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let dot = 0;
    let refEnergy = 0;
    for (let i = capStart; i < capStart + length; i++) {
      const j = i - lag;
      const r = j >= 0 && j < reference.length ? reference[j] : 0;
      dot += (capture[i] ?? 0) * r;
      refEnergy += r * r;
    }
    const score = refEnergy > 0 && capEnergy > 0 ? dot / Math.sqrt(refEnergy * capEnergy) : -1;
    scores.set(lag, score);
    if (score > best.score) best = { lag, score };
  }
  const y0 = scores.get(best.lag - 1);
  const y2 = scores.get(best.lag + 1);
  let frac = 0;
  if (y0 != null && y2 != null) {
    const d = y0 - 2 * best.score + y2;
    if (d < 0) frac = (0.5 * (y0 - y2)) / d;
  }
  return { lag: best.lag, precise: best.lag + frac, score: best.score };
}

const db = (v) => (v > 0 ? Number((20 * Math.log10(v)).toFixed(1)) : -Infinity);

function maxResidual(capture, reference, lag, from, to) {
  let m = 0;
  for (let i = from; i <= to; i++) m = Math.max(m, Math.abs(capture[i] - reference[i - lag]));
  return m;
}

function maxD2(x, from, to) {
  let m = 0;
  for (let i = Math.max(2, from); i <= to; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  return m;
}

/** Boundary metrics for a capture that should hold the `main` signal from t=0 with a boundary at `boundarySec`. */
function boundaryMetrics(capture, rate, boundarySec, totalSec, signal = 'main') {
  const reference = analytic(signal, rate, Math.ceil((totalSec + 2) * rate));
  const first = firstSignal(capture);
  if (first < 0) return { error: 'no signal captured' };
  const start = bestLag(capture, reference, first + 2000, 4096, first - 400, first + 400);
  const lag = start.lag;
  const boundary = Math.round(lag + boundarySec * rate);
  const before = bestLag(capture, reference, boundary - 6000, 4096, lag - 60, lag + 60);
  const after = bestLag(capture, reference, boundary + 3000, 4096, lag - 400, lag + 3000);
  const last = lastSignal(capture);
  const runs = zeroRuns(capture, first, last);
  const win = Math.round(rate * 0.01);
  const base = boundary - Math.round(rate * 0.5);
  return {
    lag,
    excessSamples: Number((after.precise - before.precise).toFixed(3)),
    zeroRuns: runs.length,
    longestZeroRun: runs.reduce((m, r) => Math.max(m, r.length), 0),
    boundaryErrDb: db(maxResidual(capture, reference, before.lag, boundary - win, boundary + win)),
    baselineErrDb: db(maxResidual(capture, reference, before.lag, base - win, base + win)),
    clickRatio: Number((maxD2(capture, boundary - win, boundary + win) / maxD2(capture, base - win, base + win)).toFixed(2)),
    alignment: Number(Math.min(before.score, after.score).toFixed(4)),
  };
}

/** Largest |capture[lag + n] - expected[n]| over all of `expected`, at the best lag within ±3 of `lagGuess`. */
function exactness(capture, expected, lagGuess) {
  let best = { lag: lagGuess, maxDiff: Infinity };
  for (let lag = lagGuess - 3; lag <= lagGuess + 3; lag++) {
    let m = 0;
    for (let n = 0; n < expected.length && m < best.maxDiff; n++) {
      const i = lag + n;
      m = Math.max(m, Math.abs((i >= 0 && i < capture.length ? capture[i] : 0) - expected[n]));
    }
    if (m < best.maxDiff) best = { lag, maxDiff: m };
  }
  return best;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** The first silent run of 16+ samples after `from`, and where signal resumes. */
function gapAfter(capture, from) {
  const runs = zeroRuns(capture, from, capture.length - 1);
  const run = runs[0];
  if (!run) return null;
  const resume = firstSignal(capture, run.start + run.length);
  return { start: run.start, end: resume };
}

const decoded = new Map();
function decodedLeft(fixture) {
  if (!decoded.has(fixture.id)) decoded.set(fixture.id, decodeLeft(fixture.path, fixture.sampleRate));
  return decoded.get(fixture.id);
}

const report = { ffmpeg: spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0], contextRate: CTX_RATE, chains: [], behavior: {} };
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// The transport stops an M4A's decoder where the container says the music
// ends (electron/gapless-trim.ts); ffmpeg itself decodes the encoder's end
// padding too. Every other format plays exactly what ffmpeg decodes.
const playable = (fixture) => {
  const decodedFixture = decodedLeft(fixture);
  return fixture.codec === 'aac' || fixture.codec === 'aacitunes' ? decodedFixture.subarray(0, fixture.frames) : decodedFixture;
};

for (const key of Object.keys(pairs)) {
  const pair = pairs[key];
  const boundarySec = pair.split / pair.rate;
  const totalSec = pair.total / pair.rate;
  const lead = new Float32Array(4000);
  // What the decoder alone does at the boundary: raw ffmpeg output, and with
  // the container's end trim applied.
  const decoderRaw = boundaryMetrics(concat(lead, decodedLeft(pair.a), decodedLeft(pair.b)), pair.rate, boundarySec, totalSec);
  const decoderOnly = concat(playable(pair.a), playable(pair.b));
  const decoderMetrics = boundaryMetrics(concat(lead, decoderOnly), pair.rate, boundarySec, totalSec);
  for (const path of ['deck', 'transport']) {
    const name = `${key}-${path}`;
    if (!ran(name)) continue;
    const result = readResult(name);
    const capture = readCapture(name);
    const metrics = boundaryMetrics(capture, result.rate, boundarySec, totalSec);
    const row = { case: name, codec: pair.codec, sourceRate: pair.rate, contextRate: result.rate, path, ...metrics };
    // play() call to the first captured sample, both in the capture's
    // timeline. Transport only: the deck rows read ~0 here, which a cold media
    // element can't do, so the mark isn't a usable reference for them.
    if (path === 'transport') {
      row.startLatencyMs = Number((((firstSignal(capture) - result.captureMarks.play) / result.rate) * 1000).toFixed(1));
    }
    if (path === 'transport') {
      row.decodeRate = result.info.sourceSampleRate;
      row.resampler = result.info.resampler;
      row.underruns = result.info.underruns;
      if (pair.rate === result.rate) row.exactMaxDiff = exactness(capture, decoderOnly, metrics.lag).maxDiff;
    }
    row.decoderExcessSamples = decoderRaw.excessSamples;
    row.trimmedDecoderExcessSamples = decoderMetrics.excessSamples;
    row.failure = result.failure;
    report.chains.push(row);
    if (path !== 'transport') continue;
    check(!result.failure, `${name}: ${result.failure}`);
    check(row.zeroRuns === 0, `${name}: ${row.zeroRuns} zero runs (longest ${row.longestZeroRun})`);
    // Tags say 44.1 kHz; the decoder runs at 48, which is the context rate.
    if (key === 'opushdr48') {
      check(row.decodeRate === 48000 && row.resampler === 'none', `${name}: reported ${row.decodeRate} Hz, resampler ${row.resampler}`);
    }
    // Lossy files carry whatever their encoder wrote (the ffmpeg-made 44.1k
    // MP3 has a LAME tag 28 samples short); the transport must add nothing.
    const decoderExcess = (decoderMetrics.excessSamples * result.rate) / pair.rate;
    check(Math.abs(row.excessSamples - decoderExcess) <= 1, `${name}: ${row.excessSamples} excess samples at the boundary, decoder alone ${decoderExcess.toFixed(3)}`);
    if (pair.rate === result.rate) check(row.exactMaxDiff <= 1e-6, `${name}: output differs from ffmpeg's decode by ${row.exactMaxDiff}`);
    if (pair.codec === 'flac') {
      check(row.clickRatio <= 2, `${name}: click ratio ${row.clickRatio}`);
      check(row.boundaryErrDb <= row.baselineErrDb + 6, `${name}: boundary error ${row.boundaryErrDb} dB vs baseline ${row.baselineErrDb} dB`);
    }
  }
}

const A = flac.a;
const B = flac.b;
const rate = CTX_RATE;
const decA = decodedLeft(A);
const decB = decodedLeft(B);
const decC = decodedLeft(other);

function behavior(name, analyze) {
  if (!ran(name)) return;
  const result = readResult(name);
  const capture = readCapture(name);
  const out = { failure: result.failure, underruns: result.info.underruns };
  check(!result.failure, `${name}: ${result.failure}`);
  try {
    Object.assign(out, analyze(capture, result));
  } catch (err) {
    out.analysisError = String(err?.message ?? err);
    failures.push(`${name}: analysis failed: ${out.analysisError}`);
  }
  report.behavior[name] = out;
}

behavior('replaygain', (capture) => {
  const g = Math.pow(10, RG_DB / 20);
  const expected = concat(decA, decB.map((v) => Math.fround(v * g)));
  const exact = exactness(capture, expected, firstSignal(capture));
  check(exact.maxDiff <= 1e-6, `replaygain: gain did not switch on the boundary sample (max diff ${exact.maxDiff})`);
  return { gainLinear: g, exactMaxDiff: exact.maxDiff };
});

behavior('device', (capture, result) => {
  const exact = exactness(capture, concat(decA, decB), firstSignal(capture));
  check(exact.maxDiff <= 1e-6, `device: output changed across the device switch (max diff ${exact.maxDiff})`);
  check(result.info.underruns === 0, `device: ${result.info.underruns} underruns`);
  return { outputDevices: result.extra.outputDevices, switched: 'device-switch' in result.marks, exactMaxDiff: exact.maxDiff };
});

behavior('pause', (capture, result) => {
  const first = firstSignal(capture);
  const gap = gapAfter(capture, first);
  if (!gap) throw new Error('no pause gap in the capture');
  const pre = exactness(capture.subarray(0, gap.start), decA.subarray(0, gap.start - first), first);
  const playedFrames = gap.start - pre.lag;
  // Resume must continue on the very next sample: compare the post-pause
  // audio with the source from `playedFrames`, allowing a search of ±64 to
  // measure any skip or repeat.
  const post = capture.subarray(gap.end, gap.end + rate);
  let best = { offset: 0, maxDiff: Infinity };
  for (let offset = -64; offset <= 64; offset++) {
    const expected = decA.subarray(playedFrames + offset, playedFrames + offset + post.length);
    let m = 0;
    for (let n = 0; n < expected.length && m < best.maxDiff; n++) m = Math.max(m, Math.abs(post[n] - expected[n]));
    if (m < best.maxDiff) best = { offset, maxDiff: m };
  }
  const actualSec = playedFrames / rate;
  const reportedErrMs = (result.extra.positionWhilePaused - actualSec) * 1000;
  check(pre.maxDiff <= 1e-6, `pause: audio before the pause is not exact (${pre.maxDiff})`);
  check(best.offset === 0 && best.maxDiff <= 1e-6, `pause: resume skipped/repeated ${best.offset} samples (max diff ${best.maxDiff})`);
  check(Math.abs(reportedErrMs) <= 25, `pause: reported position off by ${reportedErrMs.toFixed(1)} ms`);
  return {
    pausedAtSec: Number(actualSec.toFixed(4)),
    reportedWhilePausedSec: result.extra.positionWhilePaused,
    reportedErrMs: Number(reportedErrMs.toFixed(2)),
    resumeOffsetSamples: best.offset,
    resumeMaxDiff: best.maxDiff,
  };
});

behavior('seek', (capture, result) => {
  const first = firstSignal(capture);
  const gap = gapAfter(capture, first);
  if (!gap) throw new Error('no seek gap in the capture');
  const target = Math.round(result.extra.seekTarget * rate);
  const continuation = concat(decA.subarray(target), decB);
  let best = { offset: 0, maxDiff: Infinity };
  for (let offset = -8; offset <= 8; offset++) {
    const expected = concat(decA.subarray(target + offset), decB);
    let m = 0;
    for (let n = 0; n < expected.length && m < best.maxDiff; n++) {
      const i = gap.end + n;
      m = Math.max(m, Math.abs((i < capture.length ? capture[i] : 0) - expected[n]));
    }
    if (m < best.maxDiff) best = { offset, maxDiff: m };
  }
  const trackOrder = result.events.filter((e) => e.trackId != null).map((e) => e.trackId).filter((id, i, all) => id !== all[i - 1]);
  check(Math.abs(best.offset) <= 1, `seek: landed ${best.offset} samples from the target`);
  check(best.maxDiff <= 1e-6, `seek: A→B after the seek is not sample-exact (max diff ${best.maxDiff})`);
  check(trackOrder.join(',') === `${A.id},${B.id}`, `seek: track order ${trackOrder.join(',')}`);
  return { landingOffsetSamples: best.offset, continuationFrames: continuation.length, exactMaxDiff: best.maxDiff, trackOrder };
});

behavior('skip', (capture) => {
  const first = firstSignal(capture);
  const gap = gapAfter(capture, first);
  if (!gap) throw new Error('no skip gap in the capture');
  const pre = exactness(capture.subarray(0, gap.start), decA.subarray(0, gap.start - first), first);
  const post = exactness(capture, decC, gap.end);
  const trailing = capture.subarray(gap.end + decC.length + 4);
  const leak = trailing.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  check(pre.maxDiff <= 1e-6, `skip: audio before the skip is not exact (${pre.maxDiff})`);
  check(post.lag === gap.end && post.maxDiff <= 1e-6, `skip: C did not start clean from its first sample (lag ${post.lag - gap.end}, diff ${post.maxDiff})`);
  check(leak < SILENCE, `skip: ${leak} of signal after C ended (chained B leaked)`);
  return { preMaxDiff: pre.maxDiff, cMaxDiff: post.maxDiff, afterCPeak: leak };
});

behavior('rapid', (capture, result) => {
  const first = firstSignal(capture);
  let from = first;
  let gap = gapAfter(capture, from);
  let lastStart = first;
  while (gap && gap.end > 0) {
    lastStart = gap.end;
    gap = gapAfter(capture, gap.end);
  }
  const tail = capture.subarray(lastStart, lastSignal(capture) + 1);
  const exact = exactness(tail, decA.subarray(0, tail.length), 0);
  check(result.extra.finalTrackId === A.id, `rapid: engine ended on track ${result.extra.finalTrackId}`);
  check(exact.lag === 0 && exact.maxDiff <= 1e-6, `rapid: final audio is not A from its start (diff ${exact.maxDiff})`);
  check(!result.events.some((e) => e.error), 'rapid: engine reported an error');
  return { outcomes: result.extra.outcomes, finalTrackId: result.extra.finalTrackId, finalSegmentMaxDiff: exact.maxDiff, segments: 1 + (lastStart !== first ? 1 : 0) };
});

behavior('stop', (capture, result) => {
  const first = firstSignal(capture);
  const gap = gapAfter(capture, first);
  if (!gap) throw new Error('no stop gap in the capture');
  const stopIndex = result.captureMarks.stop;
  const silenceLatencyMs = ((gap.start - stopIndex) / rate) * 1000;
  const restart = exactness(capture.subarray(gap.end), decA.subarray(0, Math.round(1.2 * rate)), 0);
  const state = result.extra.stateAfterStop;
  check(silenceLatencyMs <= 60, `stop: audio continued ${silenceLatencyMs.toFixed(1)} ms after stop()`);
  check(!state.playing && state.currentTime === 0, `stop: state after stop ${JSON.stringify(state)}`);
  check(restart.lag === 0 && restart.maxDiff <= 1e-6, `stop: restart is not A from its start (diff ${restart.maxDiff})`);
  return { silenceLatencyMs: Number(silenceLatencyMs.toFixed(2)), restartMaxDiff: restart.maxDiff };
});

behavior('corrupt', (capture, result) => {
  const first = firstSignal(capture);
  const whole = exactness(capture, decA, first);
  const gap = gapAfter(capture, first + decA.length - 1);
  const recovered = gap ? exactness(capture.subarray(gap.end), decC.subarray(0, Math.round(1.2 * rate)), 0) : null;
  const errorState = result.extra.stateAfterCorrupt?.error ?? null;
  check(whole.maxDiff <= 1e-6, `corrupt: A did not play out exactly (${whole.maxDiff})`);
  check(!!result.extra.fallbackAtBoundary, 'corrupt: transport did not report the bad next track at the boundary');
  check(!!(result.extra.corruptError || errorState), 'corrupt: no playback error surfaced for the corrupt track');
  check(result.extra.recoveredOnTransport === true, 'corrupt: the following track did not return to the transport');
  check(recovered && recovered.lag === 0 && recovered.maxDiff <= 1e-6, 'corrupt: recovery track is not exact');
  check(!!result.extra.directError && !!result.extra.directFallback && result.extra.directActive === false,
    `corrupt: a direct play of the corrupt file did not fall back and fail cleanly (${JSON.stringify(result.extra)})`);
  return {
    aMaxDiff: whole.maxDiff,
    fallbackAtBoundary: result.extra.fallbackAtBoundary,
    corruptError: result.extra.corruptError ?? null,
    errorState,
    recoveredOnTransport: result.extra.recoveredOnTransport,
    recoveryMaxDiff: recovered?.maxDiff ?? null,
    directError: result.extra.directError ?? null,
    directFallback: result.extra.directFallback ?? null,
  };
});

behavior('handoff', (capture, result) => {
  // Transport audio up to the handoff, then a deck carries on with the same
  // track from about the same position. How far it lands from where the
  // transport stopped is the lag difference across the handoff; any silence
  // in between is reported, not required (Chromium sometimes starts the deck
  // on the very next sample).
  const reference = analytic('main', rate, Math.ceil(6 * rate));
  const first = firstSignal(capture);
  const start = bestLag(capture, reference, first + 2000, 4096, first - 400, first + 400);
  const handoff = result.captureMarks.handoff;
  const pre = exactness(capture.subarray(0, handoff - 2400), decA.subarray(0, handoff - 2400 - start.lag), start.lag);
  const after = bestLag(capture, reference, handoff + 9600, 4096, start.lag - 7200, start.lag + 7200);
  const driftMs = ((after.precise - start.lag) / rate) * 1000;
  const silent = zeroRuns(capture, handoff - 2400, handoff + 9600);
  check(result.extra.activeBefore === true && result.extra.activeAfter === false, `handoff: transport active ${result.extra.activeBefore} -> ${result.extra.activeAfter}`);
  check(pre.maxDiff <= 1e-6, `handoff: transport audio before the handoff is not exact (${pre.maxDiff})`);
  check(after.score > 0.99 && Math.abs(driftMs) <= 150, `handoff: deck landed ${driftMs.toFixed(1)} ms from the transport's position (score ${after.score})`);
  check(result.extra.stateAfter.playing === true && !result.extra.stateAfter.error, `handoff: state after ${JSON.stringify(result.extra.stateAfter)}`);
  return {
    driftMs: Number(driftMs.toFixed(2)),
    silenceMs: Number(((silent.reduce((n, r) => n + r.length, 0) / rate) * 1000).toFixed(1)),
    deckAlignment: Number(after.score.toFixed(5)),
  };
});

behavior('startrace', (capture, result) => {
  const first = firstSignal(capture);
  const seekTarget = 2 * rate;
  const seeked = exactness(capture.subarray(first), decA.subarray(seekTarget, seekTarget + Math.round(0.6 * rate)), 0);
  const gap = gapAfter(capture, first);
  const resumeIndex = result.captureMarks.resume;
  const silentUntilResume = gap ? firstSignal(capture, gap.start) >= resumeIndex : false;
  const resumed = gap ? exactness(capture.subarray(gap.end), decA.subarray(0, Math.round(0.6 * rate)), 0) : null;
  check(result.extra.seekOutcome === 'started' && result.extra.seekActive === true, `startrace: seek-during-start outcome ${result.extra.seekOutcome}, active ${result.extra.seekActive}`);
  check(seeked.lag === 0 && seeked.maxDiff <= 1e-6, `startrace: the start did not land on the seek target (diff ${seeked.maxDiff})`);
  check(result.extra.pauseOutcome === 'started' && result.extra.pausedState.playing === false, `startrace: pause-during-start state ${JSON.stringify(result.extra.pausedState)}`);
  check(silentUntilResume, 'startrace: audio played before the paused start was resumed');
  check(resumed && resumed.lag === 0 && resumed.maxDiff <= 1e-6, 'startrace: resume after a paused start is not A from its start');
  return { seekLandingMaxDiff: seeked.maxDiff, silentUntilResume, resumeMaxDiff: resumed?.maxDiff ?? null };
});

behavior('revoke', (capture) => {
  const exact = exactness(capture, concat(decA, decC), firstSignal(capture));
  check(exact.maxDiff <= 1e-6, `revoke: A→C is not exact, the revoked B leaked (${exact.maxDiff})`);
  return { exactMaxDiff: exact.maxDiff };
});

const trackOrder = (result) =>
  result.events.filter((e) => e.trackId != null).map((e) => e.trackId).filter((id, i, all) => id !== all[i - 1]);

behavior('park', (capture, result) => {
  const first = firstSignal(capture);
  const gap = gapAfter(capture, first);
  if (!gap) throw new Error('no pause gap in the capture');
  const pre = exactness(capture.subarray(0, gap.start), decA.subarray(0, gap.start - first), first);
  const playedFrames = gap.start - pre.lag;
  // The decoder was released during the pause; resume restarts it at the
  // paused position, which a FLAC seek lands on to the sample.
  const post = capture.subarray(gap.end, gap.end + rate);
  let best = { offset: 0, maxDiff: Infinity };
  for (let offset = -64; offset <= 64; offset++) {
    const expected = decA.subarray(playedFrames + offset, playedFrames + offset + post.length);
    let m = 0;
    for (let n = 0; n < expected.length && m < best.maxDiff; n++) m = Math.max(m, Math.abs(post[n] - expected[n]));
    if (m < best.maxDiff) best = { offset, maxDiff: m };
  }
  const reportedErrMs = (result.extra.positionWhilePaused - playedFrames / rate) * 1000;
  check(result.extra.released === true, 'park: the stream was not released during a 5.6 s pause');
  check(pre.maxDiff <= 1e-6, `park: audio before the pause is not exact (${pre.maxDiff})`);
  check(Math.abs(best.offset) <= 1 && best.maxDiff <= 1e-6, `park: resume skipped/repeated ${best.offset} samples (max diff ${best.maxDiff})`);
  check(Math.abs(reportedErrMs) <= 25, `park: reported position off by ${reportedErrMs.toFixed(1)} ms while released`);
  return { released: result.extra.released, resumeOffsetSamples: best.offset, resumeMaxDiff: best.maxDiff, reportedErrMs: Number(reportedErrMs.toFixed(2)) };
});

behavior('shortb', (capture, result) => {
  const decBlip = decodedLeft(blip);
  const first = firstSignal(capture);
  const ab = exactness(capture, concat(decA, decBlip), first);
  const gap = gapAfter(capture, first + decA.length);
  const c = gap ? exactness(capture.subarray(gap.end), decC.subarray(0, Math.round(1.2 * rate)), 0) : null;
  const order = trackOrder(result);
  // The 50 ms B played out before the queue got to it: it still counts as
  // played and the queue moves on to C instead of stalling.
  check(order.join(',') === `${A.id},${blip.id},${other.id}`, `shortb: track order ${order.join(',')}`);
  check(ab.maxDiff <= 1e-6, `shortb: A→B is not sample-exact (${ab.maxDiff})`);
  check(c && c.lag === 0 && c.maxDiff <= 1e-6, `shortb: C did not start clean after B (${c?.maxDiff})`);
  return { trackOrder: order, abMaxDiff: ab.maxDiff, cMaxDiff: c?.maxDiff ?? null };
});

behavior('pending', (capture) => {
  const exact = exactness(capture, concat(decA, decB), firstSignal(capture));
  check(exact.maxDiff <= 1e-6, `pending: B prepared before A had started was not chained (max diff ${exact.maxDiff})`);
  return { exactMaxDiff: exact.maxDiff };
});

behavior('mixed', (capture, result) => {
  // 44.1 → 48 → 44.1 kHz at a 48 kHz context: the `main` signal should run
  // straight through both rate changes.
  const first = boundaryMetrics(capture, rate, 2, 6);
  const second = boundaryMetrics(capture, rate, 4, 6);
  const { infoA, infoB, infoC } = result.extra;
  for (const [label, m] of [['44.1→48', first], ['48→44.1', second]]) {
    check(Math.abs(m.excessSamples) <= 1.5, `mixed ${label}: ${m.excessSamples} excess samples`);
    check(m.alignment >= 0.999, `mixed ${label}: alignment ${m.alignment}`);
  }
  check(first.zeroRuns === 0, `mixed: ${first.zeroRuns} zero runs`);
  check(infoA?.sourceSampleRate === 44100 && infoA.resampler !== 'none', `mixed: info during A ${JSON.stringify(infoA)}`);
  check(infoB?.sourceSampleRate === 48000 && infoB.resampler === 'none', `mixed: info during B ${JSON.stringify(infoB)}`);
  check(infoC?.sourceSampleRate === 44100 && infoC.resampler !== 'none', `mixed: info during C ${JSON.stringify(infoC)}`);
  return {
    first: { excessSamples: first.excessSamples, alignment: first.alignment, clickRatio: first.clickRatio },
    second: { excessSamples: second.excessSamples, alignment: second.alignment, clickRatio: second.clickRatio },
    zeroRuns: first.zeroRuns,
    resamplerDuring: [infoA?.resampler, infoB?.resampler, infoC?.resampler],
  };
});

behavior('mixedrevoke', (capture) => {
  // A and C are one 44.1 kHz stretch of `main`; the revoked 48 kHz B holds a
  // different stretch, so any of it left in the stream breaks the alignment.
  const m = boundaryMetrics(capture, rate, 2, 4);
  check(Math.abs(m.excessSamples) <= 1.5, `mixedrevoke: ${m.excessSamples} excess samples at A→C`);
  check(m.alignment >= 0.999, `mixedrevoke: alignment ${m.alignment} (the revoked B leaked?)`);
  check(m.zeroRuns === 0, `mixedrevoke: ${m.zeroRuns} zero runs`);
  return { excessSamples: m.excessSamples, alignment: m.alignment, zeroRuns: m.zeroRuns };
});

behavior('longbp', (_capture, result) => {
  const maxQueuedSec = result.extra.maxQueuedFrames / rate;
  check(maxQueuedSec > 1 && maxQueuedSec <= QUEUE_BOUND_SEC, `longbp: the worklet held ${maxQueuedSec.toFixed(3)} s of PCM (bound ${QUEUE_BOUND_SEC.toFixed(3)} s)`);
  return {
    maxQueuedSec: Number(maxQueuedSec.toFixed(3)),
    maxQueuedMiB: Number(((result.extra.maxQueuedFrames * 8) / 2 ** 20).toFixed(2)),
    boundSec: Number(QUEUE_BOUND_SEC.toFixed(3)),
  };
});

report.failures = failures;
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));

const columns = ['case', 'contextRate', 'excessSamples', 'zeroRuns', 'longestZeroRun', 'boundaryErrDb', 'baselineErrDb', 'clickRatio', 'exactMaxDiff', 'decoderExcessSamples', 'trimmedDecoderExcessSamples', 'startLatencyMs', 'resampler'];
console.log(columns.join('\t'));
for (const row of report.chains) console.log(columns.map((c) => row[c] ?? '').join('\t'));
for (const [name, out] of Object.entries(report.behavior)) console.log(`${name}\t${JSON.stringify(out)}`);
if (failures.length) {
  console.error(`[gapless-pcm] FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.error('[gapless-pcm] PASS');

// ---------------------------------------------------------------- helpers

function runHarness() {
  return new Promise((resolvePromise) => {
    const child = spawn(String(electronPath), [join('scripts', 'gapless-pcm-app')], {
      cwd: repoRoot,
      env: { ...process.env, NEWAMP_GAPLESS_PLAN: planPath },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let result = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith(marker)) result = JSON.parse(line.slice(marker.length));
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (err) => resolvePromise({ ok: false, error: String(err) }));
    // The harness enforces its own time limit and always exits.
    child.on('exit', (code) => resolvePromise(result ?? { ok: false, error: `electron exited ${code} without a result` }));
  });
}

function fatal(message) {
  console.error(`[gapless-pcm] ${message}`);
  process.exit(1);
}
