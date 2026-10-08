// Every explicit ffmpeg rate conversion must run on the bundled ffmpeg, and
// report the resampler it actually used.
//
//   npm run build:electron && node scripts/resampler-fallback-test.mjs
//
// The Windows ffmpeg-static build has no libsoxr, so a hardcoded
// `resampler=soxr` fails outright there. This drives the shipped code on real
// media and checks the audio that comes out, not just exit codes:
//   exclusive   the real ExclusiveOutput driver against a fake device that only
//               offers 48 kHz, fed a 44.1 kHz FLAC and a DSD64 file; the ring
//               must receive the 997 Hz / 1 kHz tone at 48 kHz at its source
//               level (±10%), and the negotiated format must name the
//               resampler that ran
//   DSD → PCM   the cached-FLAC recipe, the live WAV pipe and the seekable WAV
//               response, each on a synthesized DSD64 file (1 kHz sine through
//               a second-order sigma-delta modulator); each must yield that
//               tone at 88.2 kHz, at its source level
// Which resampler "should" have run is decided here independently, by asking
// the same ffmpeg binary to run soxr directly.

import assert from 'node:assert/strict';
import ffmpegStatic from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'resampler-fallback-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const ffmpeg = ffmpegStatic;
process.env.NEWAMP_FFMPEG_PATH = ffmpeg;

const dist = (path) => pathToFileURL(resolve('dist-electron', 'electron', path)).href;
const { ExclusiveOutput } = await import(dist('exclusive-output.js'));
const { buildPlaybackFlacArgs, transcodeToWavResponse } = await import(dist('transcode.js'));
const { seekableTranscodeResponse } = await import(dist('audio-serve.js'));
const { probeResampler } = await import(dist('resampler.js'));
// The app warms this probe at startup (transcode-cache.ts); until it answers,
// synchronous callers get swr. Warm it here the same way, or the first case
// negotiates before the answer on a build that has soxr.
await probeResampler(ffmpeg);

// Source levels: ffmpeg's sine generator is 1/8 full scale and its mono →
// stereo upmix is -3 dB; the DSD modulator runs at half scale.
const FLAC_LEVEL = 0.125 * Math.SQRT1_2;
const DSD_LEVEL = 0.5;
const nearLevel = (amplitude, level) => Math.abs(amplitude - level) <= level * 0.1;

const soxrWorks = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.05',
  '-af', 'aresample=resampler=soxr', '-ar', '48000', '-f', 'null', '-']).status === 0;
const expectedKind = soxrWorks ? 'soxr' : 'swr';

// ---------------------------------------------------------------- fixtures

const flacPath = join(root, 'tone-44100.flac');
assert.equal(
  spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=44100:duration=1.5',
    '-ac', '2', '-c:a', 'flac', flacPath]).status,
  0,
  'FLAC fixture',
);

/** DSD64 stereo DSF: a 1 kHz sine at half scale through a 2nd-order sigma-delta modulator. */
function writeDsf(path, seconds) {
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
    // DSF stores one bit per sample, least significant bit first.
    if (y > 0) channel[n >> 3] |= 1 << (n & 7);
  }
  const data = Buffer.alloc(bytesPerChannel * 2);
  for (let b = 0; b < bytesPerChannel / block; b++) {
    channel.copy(data, b * block * 2, b * block, (b + 1) * block);
    channel.copy(data, b * block * 2 + block, b * block, (b + 1) * block);
  }
  const dsd = Buffer.alloc(28);
  dsd.write('DSD ', 0);
  dsd.writeBigUInt64LE(28n, 4);
  dsd.writeBigUInt64LE(BigInt(28 + 52 + 12 + data.length), 12);
  const fmt = Buffer.alloc(52);
  fmt.write('fmt ', 0);
  fmt.writeBigUInt64LE(52n, 4);
  fmt.writeUInt32LE(1, 12); // format version
  fmt.writeUInt32LE(0, 16); // DSD raw
  fmt.writeUInt32LE(2, 20); // stereo
  fmt.writeUInt32LE(2, 24); // channels
  fmt.writeUInt32LE(fs, 28);
  fmt.writeUInt32LE(1, 32); // bits per sample: LSB first
  fmt.writeBigUInt64LE(BigInt(samples), 36);
  fmt.writeUInt32LE(block, 44);
  const head = Buffer.alloc(12);
  head.write('data', 0);
  head.writeBigUInt64LE(BigInt(12 + data.length), 4);
  writeFileSync(path, Buffer.concat([dsd, fmt, head, data]));
}
const dsfPath = join(root, 'tone-dsd64.dsf');
writeDsf(dsfPath, 1);

// ---------------------------------------------------------------- analysis

/** Least-squares amplitude of a `hz` sinusoid in `x` (sampled at `rate`), skipping filter edges. */
function toneAmplitude(x, rate, hz) {
  const lo = Math.floor(x.length * 0.1);
  const hi = Math.floor(x.length * 0.9);
  let ss = 0;
  let cc = 0;
  let sc = 0;
  let ys = 0;
  let yc = 0;
  for (let i = lo; i < hi; i++) {
    const w = (2 * Math.PI * hz * i) / rate;
    const s = Math.sin(w);
    const c = Math.cos(w);
    ss += s * s;
    cc += c * c;
    sc += s * c;
    ys += x[i] * s;
    yc += x[i] * c;
  }
  const det = ss * cc - sc * sc;
  return Math.hypot((ys * cc - yc * sc) / det, (yc * ss - ys * sc) / det);
}

function leftFromInterleaved(read, frames, channels) {
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) out[f] = read(f * channels);
  return out;
}

/** f32 PCM out of a WAV body (the transcode responses write IEEE float). */
function wavLeft(bytes) {
  let p = 12;
  let rate = 0;
  let channels = 0;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('latin1', p, p + 4);
    const size = bytes.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(p + 10);
      rate = bytes.readUInt32LE(p + 12);
    }
    if (id === 'data') {
      const body = bytes.subarray(p + 8, Math.min(bytes.length, p + 8 + (size === 0xffffffff || size === 0 ? bytes.length : size)));
      const frames = Math.floor(body.length / (4 * channels));
      return { rate, frames, left: leftFromInterleaved((i) => body.readFloatLE(i * 4), frames, channels) };
    }
    p += 8 + size + (size & 1);
  }
  return { rate, frames: 0, left: new Float64Array(0) };
}

async function bodyBytes(response) {
  return Buffer.from(await response.arrayBuffer());
}

const results = { ffmpeg: spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0], soxrAvailable: soxrWorks };
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ---------------------------------------------------------------- exclusive

async function exclusiveDecode(source) {
  let written = Buffer.alloc(0);
  let eos = false;
  const events = [];
  const output = new ExclusiveOutput({ send: (e) => events.push(e), sendTap() {} });
  output.addon = {
    listDevices: () => [],
    probeDevice: () => ({ name: 'Fake 48k DAC', formats: [{ format: 's24', channels: 2, sampleRate: 48000 }] }),
    open: () => ({ deviceName: 'Fake 48k DAC', internalFormat: 's24', internalChannels: 2, internalSampleRate: 48000, capacityFrames: 1 << 20 }),
    close: () => true,
    start: () => true,
    stopDevice: () => true,
    clear: () => true,
    setEos: (value) => {
      eos = value;
      return true;
    },
    write: (buf) => {
      written = Buffer.concat([written, buf]);
      return buf.length;
    },
    stats: () => ({ framesRendered: 0, bufferedFrames: 0, capacityFrames: 1 << 20, underruns: 0, drained: false, running: true }),
  };
  const { negotiated } = await output.play(source, 0, null);
  const started = Date.now();
  while (!eos && Date.now() - started < 20000) await new Promise((r) => setTimeout(r, 20));
  // Let a non-zero exit report itself.
  await new Promise((r) => setTimeout(r, 150));
  output.stop();
  const frames = Math.floor(written.length / 6);
  const left = leftFromInterleaved((i) => {
    const o = i * 3;
    const raw = written[o] | (written[o + 1] << 8) | (written[o + 2] << 16);
    return (raw > 0x7fffff ? raw - 0x1000000 : raw) / 8388608;
  }, frames, 2);
  return { negotiated, frames, left, errors: events.filter((e) => e.type === 'error').map((e) => e.message) };
}

for (const [label, source, hz, seconds, level] of [
  ['exclusive 44.1k FLAC → 48k', { trackId: 1, path: flacPath, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 1.5, lossless: true, dsd: false }, 997, 1.5, FLAC_LEVEL],
  ['exclusive DSD64 → 48k', { trackId: 2, path: dsfPath, sampleRate: 2822400, bitDepth: 1, channels: 2, durationSec: 1, lossless: true, dsd: true }, 1000, 1, DSD_LEVEL],
]) {
  const r = await exclusiveDecode(source);
  const amplitude = toneAmplitude(r.left, 48000, hz);
  results[label] = {
    frames: r.frames,
    toneAmplitude: Number(amplitude.toFixed(4)),
    resampled: r.negotiated.resampled,
    resamplerReported: r.negotiated.resampler ?? '(not reported)',
    errors: r.errors,
  };
  check(r.errors.length === 0, `${label}: decoder errors ${JSON.stringify(r.errors)}`);
  check(Math.abs(r.frames - seconds * 48000) <= 48000 * 0.05, `${label}: ${r.frames} frames reached the device, expected ~${seconds * 48000}`);
  check(nearLevel(amplitude, level), `${label}: ${hz} Hz tone at 48 kHz has amplitude ${amplitude.toFixed(4)}, source ${level.toFixed(4)}`);
  check(r.negotiated.resampled === true, `${label}: negotiation did not flag the resample`);
  check(r.negotiated.resampler === expectedKind, `${label}: badge would say ${r.negotiated.resampler ?? 'nothing'}, ${expectedKind} ran`);
}

// ---------------------------------------------------------------- DSD → PCM

{
  const label = 'DSD cached FLAC (buildPlaybackFlacArgs)';
  const out = join(root, 'dsd-cache.flac');
  const run = spawnSync(ffmpeg, buildPlaybackFlacArgs(dsfPath, out), { encoding: 'utf8' });
  let decoded = { rate: 0, frames: 0, left: new Float64Array(0) };
  if (run.status === 0) {
    const pcm = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'wav', '-c:a', 'pcm_f32le', 'pipe:1'], { maxBuffer: 1 << 28 });
    decoded = wavLeft(pcm.stdout);
  }
  const amplitude = decoded.frames ? toneAmplitude(decoded.left, decoded.rate, 1000) : 0;
  results[label] = { exit: run.status, stderr: run.stderr.trim().split('\n').at(-1) ?? '', rate: decoded.rate, frames: decoded.frames, toneAmplitude: Number(amplitude.toFixed(4)) };
  check(run.status === 0, `${label}: ffmpeg exited ${run.status}: ${results[label].stderr}`);
  check(decoded.rate === 88200 && nearLevel(amplitude, DSD_LEVEL), `${label}: 1 kHz tone at ${decoded.rate} Hz has amplitude ${amplitude.toFixed(4)}, source ${DSD_LEVEL}`);
}

for (const [label, respond] of [
  ['DSD live WAV pipe (transcodeToWavResponse)', () => transcodeToWavResponse(dsfPath, new Request('http://localhost/audio'))],
  ['DSD seekable WAV (seekableTranscodeResponse)', () => seekableTranscodeResponse(dsfPath, new Request('http://localhost/audio'))],
]) {
  const bytes = await bodyBytes(await respond());
  const decoded = wavLeft(bytes);
  const amplitude = decoded.frames > 1000 ? toneAmplitude(decoded.left, decoded.rate, 1000) : 0;
  let peak = 0;
  for (const v of decoded.left) peak = Math.max(peak, Math.abs(v));
  results[label] = { bytes: bytes.length, rate: decoded.rate, frames: decoded.frames, peak: Number(peak.toFixed(4)), toneAmplitude: Number(amplitude.toFixed(4)) };
  check(decoded.rate === 88200 && decoded.frames >= 88200 * 0.9, `${label}: ${decoded.frames} frames at ${decoded.rate} Hz`);
  check(nearLevel(amplitude, DSD_LEVEL), `${label}: 1 kHz tone amplitude ${amplitude.toFixed(4)} (peak ${peak.toFixed(4)}), source ${DSD_LEVEL}`);
}

results.expectedResampler = expectedKind;
results.failures = failures;
writeFileSync(join(root, 'report.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (failures.length) {
  console.error(`[resampler-fallback-test] FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.error('[resampler-fallback-test] PASS');
