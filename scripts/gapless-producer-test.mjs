// The main-process producer of the sample-accurate gapless transport
// (electron/gapless-transport.ts) against real ffmpeg, with a scripted
// worklet on the other end of its PCM port:
//   flow control   pushed PCM stays bounded with a chained 60 s track,
//                  with no credits at all and with a consumer at 40x speed
//   decode rates   the decoder's WAV header decides the rate, not the tags
//                  (an Opus file whose OpusHead says 44.1 kHz decodes at 48)
//   chain edits    a prepare that lands before the first segment exists, a
//                  re-point during a resampler drain, a 44.1→48→44.1 chain
//                  and a revoked splice, a seek to the very end
//   lifecycle      only the allowed renderer may open; a closed port, a
//                  crashed renderer or app quit stops the decoders; stop
//                  releases files. Every ffmpeg runs under macOS/Linux kill
//                  semantics on every platform (see the spawn stub), and one
//                  that ignores SIGTERM outright gets SIGKILL. The seekable
//                  WAV stream and Bit-Perfect Exclusive retire theirs alike
//   decode output  mono plays at unity on both channels, a 70 KB tag doesn't
//                  break the WAV header, an iTunes-style AAC (iTunSMPB, no
//                  edit list) stops where its music ends, and durations
//                  follow the decoder when the library's is missing or wrong
// Run: node scripts/gapless-producer-test.mjs

import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { parseFile } from 'music-metadata';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeItunesStyle } from './lib/itunes-aac.mjs';

// Per process: two runs at once (different agents, or a person and CI) must
// not delete each other's fixtures. Removed again on exit.
const root = resolve('tmp', 'gapless-producer-test', String(process.pid));
const media = join(root, 'media');
rmSync(root, { recursive: true, force: true });
mkdirSync(media, { recursive: true });

// Mirrors the producer's constants.
const HIGH_WATER_SEC = 3;
// Past high water, the producer can still take the pipe read that crossed
// it, and whatever an already-exited decoder had left: Node resumes a paused
// child stdout once the child exits, flushing its pipe (one 64 KiB read) and
// its stream buffer, which can hold its 64 KiB high-water mark plus most of
// the read that filled it (98304 bytes measured on Linux, where this ran
// 0.55 s past high water). Four reads bound it.
const PIPE_READ_FRAMES = 65536 / 8;
const pushBound = (rate) => HIGH_WATER_SEC + (4 * PIPE_READ_FRAMES) / rate;

// ---------------------------------------------------------------- bundle

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onResolve({ filter: /^node:child_process$/ }, (args) =>
      args.namespace === 'stub' ? { path: 'node:child_process', external: true } : { path: 'child_process', namespace: 'stub' },
    );
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
      contents: `
        import { MessageChannel } from 'node:worker_threads';
        import { EventEmitter } from 'node:events';
        export const app = { once() {}, on() {} };
        class MessagePortMain extends EventEmitter {
          constructor(port) {
            super();
            this.port = port;
            port.on('message', (data) => this.emit('message', { data, ports: [] }));
            port.on('close', () => this.emit('close'));
          }
          start() {}
          postMessage(message) { this.port.postMessage(message); }
          close() { this.port.close(); }
        }
        export class MessageChannelMain {
          constructor() {
            const { port1, port2 } = new MessageChannel();
            this.port1 = new MessagePortMain(port1);
            this.port2 = port2;
          }
        }`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
    // Every ffmpeg the producer starts, whether it has exited, and the
    // signals it was sent. Kills follow what ffmpeg does on macOS and Linux,
    // on every platform: its SIGTERM handler is SA_RESTART, so one blocked
    // writing into a pipe the producer has paused never sees the signal. A
    // polite kill lands only once our end of its stdout is closed (the
    // write then fails); SIGKILL always lands. On Windows a real kill is
    // TerminateProcess, which would hide a leak that only shows up there.
    // posix.wedged ignores polite kills outright: an ffmpeg stuck where a
    // closed pipe can't reach it, such as a read from a hung network share.
    b.onLoad({ filter: /^child_process$/, namespace: 'stub' }, () => ({
      contents: `
        import * as real from 'node:child_process';
        export const spawned = [];
        export const posix = { wedged: false };
        export function spawn(...args) {
          const child = real.spawn(...args);
          const record = { args: args[1], exited: false, signals: [], exitedAt: null };
          child.on('exit', () => { record.exited = true; record.exitedAt = Date.now(); });
          const kill = child.kill.bind(child);
          child.kill = (signal = 'SIGTERM') => {
            record.signals.push(signal);
            if (signal === 'SIGKILL' || signal === 9) return kill('SIGKILL');
            if (posix.wedged) return true;
            if (!child.stdout || child.stdout.destroyed) return kill(signal);
            child.stdout.once('close', () => kill(signal));
            return true;
          };
          spawned.push(record);
          return child;
        }
        export const spawnSync = real.spawnSync;
        export const execFile = real.execFile;`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

await build({
  stdin: {
    contents: `export { closeAllGaplessSessions, registerGaplessTransport } from './electron/gapless-transport.ts';
      export { killChild } from './electron/kill-child.ts';
      export { seekableTranscodeResponse } from './electron/audio-serve.ts';
      export { ExclusiveOutput } from './electron/exclusive-output.ts';
      export { posix, spawn, spawned } from 'node:child_process';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['ffmpeg-static'],
  plugins: [stubs],
  outfile: join(root, 'bundle.mjs'),
  logLevel: 'silent',
});
const { closeAllGaplessSessions, ExclusiveOutput, killChild, posix, registerGaplessTransport, seekableTranscodeResponse, spawn, spawned } = await import(pathToFileURL(join(root, 'bundle.mjs')).href);

// ---------------------------------------------------------------- fixtures

function encode(name, seconds, rate, codecArgs, frequency = 440) {
  const path = join(media, name);
  const r = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=${seconds}`,
    '-ac', '2', ...codecArgs, path,
  ], { windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  return path;
}
const flac = (name, seconds, rate, frequency) => encode(name, seconds, rate, ['-c:a', 'flac'], frequency);
const m4a = (name, seconds, rate) => encode(name, seconds, rate, ['-c:a', 'aac', '-b:a', '192k']);

// Ogg CRC-32: polynomial 0x04c11db7, no reflection, zero init.
const OGG_CRC = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
function oggCrc(page) {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

/**
 * What opusenc writes for a 44.1 kHz source: OpusHead records the input rate
 * (44100), while every Opus decoder runs at 48 kHz. ffmpeg's own encoder
 * writes 48000 there, so the field is patched and the page CRC redone.
 */
function opusWith44kHeader() {
  const path = encode('opus-44k-header.opus', 2, 48000, ['-c:a', 'libopus', '-b:a', '128k']);
  const bytes = readFileSync(path);
  const segments = bytes[26];
  const body = 27 + segments;
  if (bytes.toString('latin1', 0, 4) !== 'OggS' || bytes.toString('latin1', body, body + 8) !== 'OpusHead') {
    throw new Error('unexpected Ogg layout');
  }
  let pageLength = body;
  for (let i = 0; i < segments; i++) pageLength += bytes[27 + i];
  bytes.writeUInt32LE(44100, body + 12);
  bytes.writeUInt32LE(0, 22);
  bytes.writeUInt32LE(oggCrc(bytes.subarray(0, pageLength)), 22);
  writeFileSync(path, bytes);
  return path;
}

/**
 * AAC laid out the way iTunes and Apple's encoders ship it (iTunSMPB, no
 * edit list), from an ffmpeg encode. A rising chirp, so a misplaced start or
 * end can't line up by accident.
 */
function itunesAac(name, frames, rate) {
  const path = join(media, name);
  const pcm = new Float32Array(frames * 2);
  for (let n = 0; n < frames; n++) {
    const t = n / rate;
    pcm[2 * n] = pcm[2 * n + 1] = 0.3 * Math.sin(2 * Math.PI * (55 * t + 20 * t * t));
  }
  const r = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'aac', '-b:a', '192k', '-use_editlist', '0', '-map_metadata', '-1', '-fflags', '+bitexact', path,
  ], { input: Buffer.from(pcm.buffer), windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  return { path, ...makeItunesStyle(path, frames) };
}

/** Frames ffmpeg decodes from `path` on its own, padding included. */
function ffmpegFrames(path) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  return r.stdout.length / 8;
}

// ---------------------------------------------------------------- harness

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const report = {};
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
// A case that throws is a failure; the cases after it still run.
async function section(run) {
  try {
    await run();
  } catch (err) {
    failures.push(String(err?.message ?? err));
  }
}

function source(trackId, path, sampleRate, extra = {}) {
  return { trackId, path, sampleRate, bitDepth: null, channels: 2, durationSec: null, lossless: true, dsd: false, ...extra };
}

/**
 * The producer's IPC with one renderer. `tracks` maps track id to a source
 * (or to a function returning one after a delay). The fake worklet keeps
 * every marker with the frame it landed on, and the left channel if asked.
 */
async function transport(tracks, { allowSender, keepPcm = false } = {}) {
  const handlers = {};
  registerGaplessTransport(
    { handle: (name, fn) => { handlers[name] = fn; } },
    async (id) => {
      const entry = tracks[id];
      return typeof entry === 'function' ? entry() : entry ?? null;
    },
    allowSender,
  );
  const sender = new EventEmitter();
  // `received` counts every frame posted (what credits are measured
  // against); `frames` is the stream position, which a cut moves back to
  // where the revoked segment started, as the worklet does.
  // `durations` holds every duration correction, by token, in arrival order.
  const w = { port: null, portData: null, received: 0, frames: 0, marks: [], durations: {}, left: [], right: [], consumed: 0, credited: 0, maxQueued: 0, ended: false };
  sender.postMessage = (_channel, data, ports) => {
    w.port = ports[0];
    w.portData = data;
  };
  const event = { sender };
  w.opened = await handlers['gapless:open'](event);
  w.port?.on('message', (m) => {
    if (m.t === 'pcm') {
      w.received += m.pcm.length / 2;
      w.frames += m.pcm.length / 2;
      if (keepPcm) {
        w.left.push(m.pcm.filter((_, i) => i % 2 === 0));
        w.right.push(m.pcm.filter((_, i) => i % 2 === 1));
      }
      w.maxQueued = Math.max(w.maxQueued, w.received - w.consumed);
      return;
    }
    if (m.t === 'dur') {
      (w.durations[m.token] ??= []).push(m.durationSec);
      return;
    }
    if (m.t === 'end') w.ended = true;
    if (m.t === 'cut') {
      const start = w.marks.findLast((mark) => mark.t === 'seg' && mark.token === m.token);
      if (start) w.frames = Math.min(w.frames, start.at);
    }
    w.marks.push({ t: m.t, token: m.token, at: w.frames, sourceRate: m.sourceRate, resampler: m.resampler, durationSec: m.durationSec });
  });
  const firstSpawn = spawned.length;
  return {
    w,
    sender,
    event,
    handlers,
    start: (request) => handlers['gapless:start'](event, { gen: 1, token: 1, trackId: 1, startAt: 0, gain: 1, sampleRate: 48000, next: null, ...request }),
    prepare: (gen, after, next) => handlers['gapless:prepare-next'](event, gen, after, next),
    stop: (gen) => handlers['gapless:stop'](event, gen),
    children: () => spawned.slice(firstSpawn),
    /** Play at `speed`x real time, crediting like the worklet, until the stream ends. */
    async consume(gen, rate, speed, timeoutMs = 20000) {
      const started = Date.now();
      while (!(w.ended && w.consumed >= w.received)) {
        if (Date.now() - started > timeoutMs) throw new Error(`consumer timed out: ${JSON.stringify({ received: w.received, frames: w.frames, consumed: w.consumed, credited: w.credited, ended: w.ended, marks: segs(w) })}`);
        await sleep(10);
        w.consumed = Math.min(w.received, w.consumed + Math.round((rate * speed * 10) / 1000));
        if (w.consumed - w.credited >= 4096 || (w.ended && w.consumed >= w.received)) {
          w.credited = w.consumed;
          w.port.postMessage({ t: 'credit', gen, consumed: w.consumed });
        }
      }
    },
    /** Wait until no more PCM arrives for `quietMs`. */
    async settle(quietMs = 500, timeoutMs = 6000) {
      const started = Date.now();
      let last = -1;
      let since = Date.now();
      while (Date.now() - started < timeoutMs) {
        await sleep(50);
        if (w.received !== last) {
          last = w.received;
          since = Date.now();
        } else if (Date.now() - since >= quietMs) return;
      }
    },
    close() {
      w.port?.close();
    },
  };
}

// Under the producer's 2 s SIGKILL grace: an exit inside this came from
// closing the pipes, not from the escalation.
const PROMPT_EXIT_MS = 1500;

async function exitedAll(children, timeoutMs = PROMPT_EXIT_MS) {
  const started = Date.now();
  while (children.some((c) => !c.exited) && Date.now() - started < timeoutMs) await sleep(20);
  return children.every((c) => c.exited);
}

/** Left and right channels of everything the fake worklet kept. */
function channels(w) {
  const join = (parts) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  return { left: join(w.left), right: join(w.right) };
}

const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

function segs(w) {
  return w.marks.map((m) => `${m.t}${m.token != null ? `:${m.token}` : ''}@${m.at}`);
}

// ---------------------------------------------------------------- flow control

console.error('[gapless-producer] flow control');
await section(async () => {
  const b60m4a = m4a('b60.m4a', 60, 48000);
  const b60flac = flac('b60.flac', 60, 48000);
  const rows = [];
  const lengths = [
    ...['3.00', '3.02', '3.04', '3.06', '3.08', '3.10', '3.12', '3.14', '3.16', '3.18'].map((a) => ['m4a', a]),
    ...['3.00', '3.04', '3.08', '3.12'].map((a) => ['flac', a]),
  ];
  // A consumer that never credits: after A (around the 3 s high-water mark,
  // swept across a pipe read) the chained 60 s B must not stream in.
  for (const [codec, a] of lengths) {
    const aPath = codec === 'm4a' ? m4a(`a${a}.m4a`, a, 48000) : flac(`a${a}.flac`, a, 48000);
    const t = await transport({ 1: source(1, aPath, 48000), 2: source(2, codec === 'm4a' ? b60m4a : b60flac, 48000) });
    const result = await t.start({ next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
    await t.settle();
    const pushedSec = t.w.received / 48000;
    rows.push({ a: `${codec} ${a}s`, pushedSec: Number(pushedSec.toFixed(3)) });
    check(result.ok, `no-credit ${codec} ${a}: start failed ${result.error}`);
    check(pushedSec <= pushBound(48000), `no-credit ${codec} ${a}: pushed ${pushedSec.toFixed(3)} s with no credits (bound ${pushBound(48000).toFixed(3)})`);
    await t.stop(2);
    t.close();
    check(await exitedAll(t.children()), `no-credit ${codec} ${a}: ffmpeg still running after stop`);
  }
  report.noCredit = { boundSec: Number(pushBound(48000).toFixed(3)), maxPushedSec: Math.max(...rows.map((r) => r.pushedSec)), rows };

  // A consumer at 40x crediting every 4096 frames, A lengths across a read.
  const credited = [];
  for (const a of ['12.00', '12.10', '12.20', '12.30', '12.40']) {
    const t = await transport({ 1: source(1, flac(`a${a}.flac`, a, 48000), 48000), 2: source(2, b60flac, 48000) });
    const result = await t.start({ next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
    check(result.ok, `credited ${a}: start failed ${result.error}`);
    if (!result.ok) console.error('START', a, result);
    await t.consume(1, 48000, 40);
    const queued = t.w.maxQueued / 48000;
    credited.push({ a: `flac ${a}s`, totalSec: Number((t.w.frames / 48000).toFixed(3)), maxQueuedSec: Number(queued.toFixed(3)) });
    check(t.w.frames === Math.round((Number(a) + 60) * 48000), `credited ${a}: ${t.w.frames} frames, expected A + B`);
    check(queued <= pushBound(48000), `credited ${a}: ${queued.toFixed(3)} s queued (bound ${pushBound(48000).toFixed(3)})`);
    await t.stop(2);
    t.close();
  }
  report.credited = { maxQueuedSec: Math.max(...credited.map((r) => r.maxQueuedSec)), rows: credited };
});

// ---------------------------------------------------------------- chain edits

console.error('[gapless-producer] chain edits');
await section(async () => {
  // start(A) and prepare-next(B) back to back, B's plan resolving first: the
  // prepare lands before the first segment exists and must still chain.
  const aPath = flac('pend-a.flac', 3, 48000);
  const bPath = flac('pend-b.flac', 2, 48000, 660);
  const t = await transport({
    1: async () => {
      await sleep(30);
      return source(1, aPath, 48000);
    },
    2: source(2, bPath, 48000),
  });
  const started = t.start({});
  const prepared = t.prepare(1, 1, { token: 2, trackId: 2, startAt: 0, gain: 1 });
  await Promise.all([started, prepared]);
  await t.consume(1, 48000, 40);
  report.pendingBeforeBegin = { markers: segs(t.w), totalSec: t.w.frames / 48000 };
  check(segs(t.w).join(' ') === `seg:1@0 seg:2@${3 * 48000} end@${5 * 48000}`, `pending prepare: ${segs(t.w).join(' ')}`);
  await t.stop(2);
  t.close();
});
await section(async () => {
  // 44.1 → 48 → 44.1 kHz at a 48 kHz context: one resampler, drained at each
  // rate change, and every boundary on the frame the previous track ended.
  const a = flac('mix-a-44.flac', 2, 44100, 440);
  const b = flac('mix-b-48.flac', 2, 48000, 550);
  const c = flac('mix-c-44.flac', 2, 44100, 660);
  const t = await transport({ 1: source(1, a, 44100), 2: source(2, b, 48000), 3: source(3, c, 44100) }, { keepPcm: true });
  await t.start({ next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
  // Like the renderer: what follows B is prepared once B is on the stream.
  const playing = t.consume(1, 48000, 10);
  while (!t.w.marks.some((m) => m.t === 'seg' && m.token === 2)) await sleep(5);
  await t.prepare(1, 2, { token: 3, trackId: 3, startAt: 0, gain: 1 });
  await playing;
  const markers = segs(t.w).join(' ');
  const left = new Float32Array(t.w.left.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of t.w.left) {
    left.set(part, offset);
    offset += part.length;
  }
  let longestQuiet = 0;
  let run = 0;
  for (let i = 1000; i < left.length - 1000; i++) {
    run = Math.abs(left[i]) < 1e-6 ? run + 1 : 0;
    longestQuiet = Math.max(longestQuiet, run);
  }
  const rates = t.w.marks.filter((m) => m.t === 'seg').map((m) => `${m.sourceRate}/${m.resampler}`);
  report.mixedRates = { markers, rates, longestQuietSamples: longestQuiet };
  check(markers === 'seg:1@0 seg:2@96000 seg:3@192000 end@288000', `mixed rates: ${markers}`);
  check(rates.length === 3 && rates[0].startsWith('44100/') && rates[1] === '48000/none' && rates[2].startsWith('44100/') && !rates[0].endsWith('/none'), `mixed rates: segment rates ${rates.join(', ')}`);
  // A sine crosses zero every ~40 samples; a gap or a dropped filter tail
  // would show as a longer silent run.
  check(longestQuiet <= 2, `mixed rates: ${longestQuiet} silent samples inside the stream`);
  await t.stop(2);
  t.close();
});
await section(async () => {
  // A 44.1 kHz A with a 48 kHz B already spliced in, re-pointed at a 44.1 kHz
  // C: B is cut on the frame it started, C starts there on a fresh resampler.
  const a = flac('rev-a-44.flac', 1, 44100, 440);
  const b = flac('rev-b-48.flac', 4, 48000, 550);
  const c = flac('rev-c-44.flac', 2, 44100, 660);
  const t = await transport({ 1: source(1, a, 44100), 2: source(2, b, 48000), 3: source(3, c, 44100) });
  await t.start({ next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
  await sleep(150);
  await t.prepare(1, 1, { token: 3, trackId: 3, startAt: 0, gain: 1 });
  await t.consume(1, 48000, 40);
  const markers = segs(t.w).join(' ');
  report.revokedSplice = { markers, totalFrames: t.w.frames };
  check(/^seg:1@0 seg:2@48000 cut:2@\d+ seg:3@48000 end@144000$/.test(markers) || /^seg:1@0 cut:2@\d+ seg:3@48000 end@144000$/.test(markers),
    `revoked splice: ${markers}`);
  await t.stop(2);
  t.close();
});
await section(async () => {
  // Un-chain, then re-point while the resampler holding A's tail drains: the
  // re-point is newer than the cut and must apply once the drain finishes.
  const a = flac('drain-a-44.flac', 1, 44100, 440);
  const b = flac('drain-b-44.flac', 3, 44100, 550);
  const c = flac('drain-c-44.flac', 2, 44100, 660);
  const t = await transport({ 1: source(1, a, 44100), 2: source(2, b, 44100), 3: source(3, c, 44100) });
  await t.start({ next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
  await sleep(150);
  await t.prepare(1, 1, null);
  await t.prepare(1, 1, { token: 3, trackId: 3, startAt: 0, gain: 1 });
  await t.consume(1, 48000, 40);
  const markers = segs(t.w).join(' ');
  report.repointDuringDrain = { markers, totalFrames: t.w.frames };
  check(/seg:3@48000 end@144000$/.test(markers), `re-point during drain: ${markers}`);
  await t.stop(2);
  t.close();
});
await section(async () => {
  // A 50 ms 48 kHz track after a resampled 44.1 kHz one, with the worklet
  // full: the resampler can't drain until credit comes back, and the short
  // decoder exits (its pipe flushed) before its segment can be placed.
  const a = flac('flush-a-44.flac', 4, 44100, 440);
  const b = flac('flush-b-48.flac', 0.05, 48000, 660);
  const t = await transport({ 1: source(1, a, 44100), 2: source(2, b, 48000) });
  await t.start({ next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
  await t.consume(1, 48000, 2);
  const markers = segs(t.w).join(' ');
  report.shortTrackAcrossRateSwitch = { markers };
  check(markers === 'seg:1@0 seg:2@192000 end@194400', `short track across a rate switch: ${markers}`);
  await t.stop(2);
  t.close();
});
await section(async () => {
  // A seek to exactly the end: the track has played out. Alone, the stream
  // just ends; with a chained track, that track follows at once.
  const a = flac('end-a.flac', 2, 48000, 440);
  const b = flac('end-b.flac', 1, 48000, 660);
  let t = await transport({ 1: source(1, a, 48000, { durationSec: 2 }) });
  const alone = await t.start({ startAt: 2 });
  await t.settle(300, 3000);
  report.seekToEnd = { alone: { ok: alone.ok, error: alone.error ?? null, markers: segs(t.w) } };
  check(alone.ok && segs(t.w).join(' ') === 'seg:1@0 end@0', `seek to end: ${JSON.stringify(alone)} ${segs(t.w).join(' ')}`);
  await t.stop(2);
  t.close();
  t = await transport({ 1: source(1, a, 48000, { durationSec: 2 }), 2: source(2, b, 48000) });
  const chained = await t.start({ startAt: 2, next: { token: 2, trackId: 2, startAt: 0, gain: 1 } });
  await t.consume(1, 48000, 40);
  report.seekToEnd.chained = { ok: chained.ok, markers: segs(t.w) };
  check(chained.ok && segs(t.w).join(' ') === 'seg:1@0 seg:2@0 end@48000', `seek to end, chained: ${segs(t.w).join(' ')}`);
  await t.stop(2);
  t.close();
});

// ---------------------------------------------------------------- decode rates

console.error('[gapless-producer] decode rates');
await section(async () => {
  const opus = opusWith44kHeader();
  const tagged = (await parseFile(opus, { duration: false, skipCovers: true })).format.sampleRate;
  report.decodeRates = { opusTagRate: tagged, cases: [] };
  // The fixture has to reproduce the mislabel, or the case proves nothing.
  check(tagged === 44100, `opus fixture: music-metadata reads ${tagged}, expected the OpusHead's 44100`);
  for (const ctxRate of [48000, 44100]) {
    const t = await transport({ 1: source(1, opus, tagged, { lossless: false }) });
    const result = await t.start({ sampleRate: ctxRate });
    await t.consume(1, ctxRate, 40);
    const decoder = t.children().find((c) => c.args.includes('-i') && !c.args.includes('pipe:0'));
    const resampler = t.children().find((c) => c.args.includes('pipe:0'));
    const row = {
      contextRate: ctxRate,
      reported: { sourceSampleRate: result.sourceSampleRate, resampler: result.resampler },
      decoderForcesRate: decoder?.args.includes('-ar') ?? null,
      resamplerRuns: resampler
        ? `${resampler.args[resampler.args.indexOf('-ar') + 1]}→${resampler.args[resampler.args.lastIndexOf('-ar') + 1]}`
        : null,
      frames: t.w.frames,
    };
    report.decodeRates.cases.push(row);
    check(result.ok && result.sourceSampleRate === 48000, `opus @${ctxRate}: reported source rate ${result.sourceSampleRate}`);
    check(row.decoderForcesRate === false, `opus @${ctxRate}: the decoder was told a rate`);
    if (ctxRate === 48000) {
      check(result.resampler === 'none' && !resampler, `opus @48000: resampled (${result.resampler}) a 48 kHz decode`);
    } else {
      check(result.resampler !== 'none' && !!resampler && resampler.args.includes('48000'), `opus @44100: 48 kHz decode not resampled by the transport (${result.resampler})`);
    }
    await t.stop(2);
    t.close();
  }
  // Tags that report a core rate (HE-AAC's implicit SBR) against a decoder
  // that runs at twice it. The bundled ffmpeg has no HE-AAC encoder (its
  // aac encoder is LC only), so a FLAC stands in for the mislabelled file.
  const f44 = flac('core-rate.flac', 1, 44100);
  const t = await transport({ 1: source(1, f44, 22050) });
  const result = await t.start({ sampleRate: 44100 });
  await t.consume(1, 44100, 40);
  report.decodeRates.coreRateTag = { tagged: 22050, reported: result.sourceSampleRate, resampler: result.resampler, frames: t.w.frames };
  check(result.sourceSampleRate === 44100 && result.resampler === 'none' && t.w.frames === 44100, `core-rate tag: ${JSON.stringify(report.decodeRates.coreRateTag)}`);
  await t.stop(2);
  t.close();
});

// ---------------------------------------------------------------- decode output

console.error('[gapless-producer] decode output');
await section(async () => {
  // A mono file plays on both channels at its own level, the way Chromium's
  // decoders upmix it (L = R = M). `-ac 2` mixed it in 3 dB down.
  const mono = join(media, 'mono-1k.flac');
  let r = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1',
    '-af', 'volume=0.5', '-ac', '1', '-c:a', 'flac', mono,
  ], { windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', mono, '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 26, windowsHide: true });
  const reference = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
  const t = await transport({ 1: { ...source(1, mono, 48000), channels: 1 } }, { keepPcm: true });
  await t.start({});
  await t.consume(1, 48000, 40);
  const { left, right } = channels(t.w);
  let maxDiff = 0;
  for (let n = 0; n < reference.length; n++) maxDiff = Math.max(maxDiff, Math.abs(left[n] - reference[n]), Math.abs(right[n] - reference[n]));
  report.mono = {
    sourcePeak: peak(reference),
    leftPeak: peak(left),
    rightPeak: peak(right),
    levelDb: Number((20 * Math.log10(peak(left) / peak(reference))).toFixed(3)),
    maxDiffFromSource: maxDiff,
    frames: left.length,
  };
  check(left.length === reference.length && maxDiff === 0, `mono: not the source on both channels at unity ${JSON.stringify(report.mono)}`);
  await t.stop(2);
  t.close();
});
await section(async () => {
  // A 70 KB Vorbis comment. With tags in its WAV header, ffmpeg outgrew its
  // IO buffer, couldn't seek back on the pipe to size the LIST chunk, and the
  // header never parsed.
  const metadata = join(media, 'big-comment.txt');
  writeFileSync(metadata, `;FFMETADATA1\ncomment=${'lyrics and liner notes '.repeat(3200)}\n`);
  const big = join(media, 'big-comment.flac');
  const r = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-f', 'ffmetadata', '-i', metadata, '-map', '0:a', '-map_metadata', '1', '-ac', '2', '-c:a', 'flac', big,
  ], { windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  // ffmpeg files a comment as DESCRIPTION; take the longest tag.
  const tags = (await parseFile(big, { duration: false, skipCovers: true })).native.vorbis ?? [];
  const commentBytes = Math.max(0, ...tags.map((tag) => String(tag.value).length));
  const t = await transport({ 1: source(1, big, 48000) });
  const result = await t.start({});
  await t.consume(1, 48000, 40);
  report.bigComment = { commentBytes, ok: result.ok, error: result.error ?? null, frames: t.w.frames };
  check(commentBytes > 65536, `big comment: the fixture's comment is only ${commentBytes} bytes`);
  check(result.ok && t.w.frames === 48000, `big comment: ${JSON.stringify(report.bigComment)}`);
  await t.stop(2);
  t.close();
});
await section(async () => {
  // iTunes-style AAC: iTunSMPB and no edit list. ffmpeg skips the priming on
  // its own; the transport has to stop before the padding, from the start
  // and after a seek.
  const frames = 2 * 48000 + 777;
  const apple = itunesAac('itunes-style.m4a', frames, 48000);
  const raw = ffmpegFrames(apple.path);
  const rows = [];
  for (const startAt of [0, 1]) {
    const t = await transport({ 1: source(1, apple.path, 48000, { lossless: false }) });
    const result = await t.start({ startAt });
    await t.consume(1, 48000, 40);
    rows.push({ startAt, ok: result.ok, frames: t.w.frames, expected: frames - startAt * 48000 });
    await t.stop(2);
    t.close();
  }
  report.itunesAac = { musicFrames: frames, padding: apple.padding, ffmpegAloneFrames: raw, rows };
  // The fixture must carry padding ffmpeg plays, or the case proves nothing.
  check(raw === frames + apple.padding && apple.padding > 0, `itunes aac: ffmpeg alone decodes ${raw} frames, expected music + ${apple.padding} padding`);
  for (const row of rows) check(row.ok && row.frames === row.expected, `itunes aac: ${JSON.stringify(row)}`);
});
await section(async () => {
  // Durations. No library duration: the decoder's header length arrives
  // while the track is still decoding. A library row 98 s too long: the
  // exact decoded length replaces it when the decoder finishes.
  let t = await transport({ 1: source(1, join(media, 'b60.flac'), 48000, { durationSec: null }) });
  const missing = await t.start({});
  await t.settle(300, 3000);
  const early = { start: missing.durationSec, corrections: t.w.durations[1] ?? [], decoderRunning: t.children().some((c) => !c.exited) };
  await t.stop(2);
  t.close();
  const two = flac('dur-2s.flac', 2, 48000);
  t = await transport({ 1: source(1, two, 48000, { durationSec: 100 }) });
  const wrong = await t.start({});
  await t.consume(1, 48000, 40);
  const late = { start: wrong.durationSec, corrections: t.w.durations[1] ?? [] };
  await t.stop(2);
  t.close();
  report.durations = { missing: early, wrong: late };
  const known = early.start ?? early.corrections.at(-1);
  check(early.decoderRunning && Math.abs(known - 60) < 0.02, `durations: no early length for a track the library has none for ${JSON.stringify(early)}`);
  check(late.start === 100 && late.corrections.at(-1) === 2, `durations: a wrong library length was not corrected ${JSON.stringify(late)}`);
});

// ---------------------------------------------------------------- lifecycle

console.error('[gapless-producer] lifecycle');
await section(async () => {
  // Only the main window's renderer may take the PCM port.
  const main = new EventEmitter();
  let t = await transport({}, { allowSender: (sender) => sender === main });
  const other = { opened: t.w.opened, port: t.w.port };
  const refused = await t.start({});
  report.openGuard = { otherOpened: other.opened, portPosted: !!other.port, start: refused.error ?? null };
  check(other.opened === 0 && !other.port && !refused.ok, `open guard: another renderer got ${JSON.stringify(report.openGuard)}`);
  t = await transport({}, { allowSender: () => true });
  check(t.w.opened > 0 && t.w.portData?.id === t.w.opened, `open: port id ${JSON.stringify(t.w.portData)} vs ${t.w.opened}`);
  t.close();
});
await section(async () => {
  // The worklet end of the port closes (renderer reload, node torn down):
  // the session stops decoding for nobody.
  const long = join(media, 'b60.flac');
  let t = await transport({ 1: source(1, long, 48000) });
  await t.start({});
  await sleep(200);
  t.close();
  const closed = await exitedAll(t.children());
  // The renderer process crashes: same.
  t = await transport({ 1: source(1, long, 48000) });
  await t.start({});
  await sleep(200);
  t.sender.emit('render-process-gone', {}, { reason: 'crashed' });
  const crashed = await exitedAll(t.children());
  t.close();
  // App quit: main's will-quit handler closes every session. On Windows a
  // child ffmpeg would otherwise outlive the app.
  t = await transport({ 1: source(1, long, 48000) });
  await t.start({});
  await sleep(200);
  closeAllGaplessSessions();
  const quit = await exitedAll(t.children());
  report.teardown = { portClosedStopsFfmpeg: closed, rendererGoneStopsFfmpeg: crashed, quitStopsFfmpeg: quit };
  check(closed, 'port close: ffmpeg kept running for a closed port');
  check(crashed, 'render-process-gone: ffmpeg kept running for a crashed renderer');
  check(quit, 'app quit: ffmpeg kept running after closeAllGaplessSessions()');
  t.close();
});
await section(async () => {
  // The other ways a paused decoder or resampler is retired: a newer start
  // (a skip), a stop with the resampler running, and a revoked splice (the
  // chained decoder cut out of the stream). Nothing credits, so every pipe
  // sits paused at high water, the producer's normal state.
  const a44 = flac('kill-a44.flac', 60, 44100);
  const short44 = flac('kill-short44.flac', 2, 44100, 550);
  const b44 = flac('kill-b44.flac', 60, 44100, 660);
  const t = await transport({
    1: source(1, join(media, 'b60.flac'), 48000),
    2: source(2, a44, 44100),
    3: source(3, short44, 44100),
    4: source(4, b44, 44100),
  });
  const isResampler = (c) => c.args.includes('pipe:0');
  let mark = spawned.length;
  await t.start({ gen: 1, token: 1, trackId: 1 });
  await sleep(300);
  const first = spawned.slice(mark);
  mark = spawned.length;
  await t.start({ gen: 2, token: 2, trackId: 2 });
  const skip = await exitedAll(first);
  await sleep(300);
  const resampled = spawned.slice(mark);
  await t.stop(3);
  const stop = await exitedAll(resampled);
  mark = spawned.length;
  await t.start({ gen: 4, token: 4, trackId: 3, next: { token: 5, trackId: 4, startAt: 0, gain: 1 } });
  // The 2 s track decodes at once; the chained 60 s one starts and stalls.
  const chainedStarted = Date.now();
  while (!spawned.slice(mark).some((c) => c.args.includes(b44)) && Date.now() - chainedStarted < 3000) await sleep(20);
  await sleep(300);
  const chained = spawned.slice(mark).filter((c) => c.args.includes(b44));
  await t.prepare(4, 4, null);
  const revoke = await exitedAll(chained);
  await t.stop(5);
  const rest = await exitedAll(spawned.slice(mark));
  report.teardownPaths = {
    skipStopsDecoder: skip,
    stopStopsDecoderAndResampler: stop,
    resamplerRan: resampled.some(isResampler),
    revokeStopsChainedDecoder: revoke,
    chainedDecoderRan: chained.length === 1,
    stopAfterRevoke: rest,
  };
  check(skip, 'skip: the replaced decoder kept running');
  check(resampled.some(isResampler) && stop, `stop: decoder or resampler kept running ${JSON.stringify(resampled.map((c) => ({ resampler: isResampler(c), exited: c.exited })))}`);
  check(chained.length === 1 && revoke, `revoked splice: the chained decoder kept running (${chained.length} started)`);
  check(rest, 'stop after a revoke: ffmpeg kept running');
  t.close();
});
await section(async () => {
  // The seekable WAV responses (electron/audio-serve.ts) and Bit-Perfect
  // Exclusive (electron/exclusive-output.ts) pause ffmpeg for backpressure
  // too, and must retire it the same way. Nothing reads the response past
  // two chunks; the fake exclusive device fills after 64 KiB.
  const long = join(media, 'b60.flac');
  let mark = spawned.length;
  const abort = new AbortController();
  const response = await seekableTranscodeResponse(long, new Request('http://localhost/audio', { signal: abort.signal }));
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  await sleep(500);
  const served = spawned.slice(mark).filter((c) => c.args.includes('pipe:1'));
  abort.abort();
  const servedExited = await exitedAll(served);
  mark = spawned.length;
  let room = 64 * 1024;
  const output = new ExclusiveOutput({ send() {}, sendTap() {} });
  output.addon = {
    probeDevice: () => ({ name: 'Test DAC', formats: [{ format: 's16', channels: 2, sampleRate: 48000 }] }),
    open: () => ({ deviceName: 'Test DAC', internalFormat: 's16', internalChannels: 2, internalSampleRate: 48000 }),
    close() {},
    stats: () => ({ framesRendered: 0, bufferedFrames: 16384, capacityFrames: 16384, underruns: 0, drained: false, running: true }),
    write: (buf) => {
      const n = Math.min(buf.length, room);
      room -= n;
      return n;
    },
    start() {},
    stopDevice() {},
    clear() {},
    setEos() {},
  };
  let exclusive = { decoders: 0, paused: null, exited: false };
  try {
    await output.play(source(1, long, 48000, { bitDepth: 16 }), 0, null);
    await sleep(500);
    const decoders = spawned.slice(mark).filter((c) => c.args.includes('pipe:1'));
    exclusive = { decoders: decoders.length, paused: output.ffmpeg?.stdout.isPaused() ?? null, exited: false };
    output.stop();
    exclusive.exited = await exitedAll(decoders);
  } finally {
    output.dispose();
  }
  report.teardownElsewhere = { seekableWav: { decoders: served.length, exitedOnAbort: servedExited }, exclusive };
  check(served.length === 1 && servedExited, `seekable WAV: ffmpeg kept running after the request was aborted ${JSON.stringify(report.teardownElsewhere)}`);
  check(exclusive.decoders === 1 && exclusive.paused === true && exclusive.exited, `exclusive: ffmpeg kept running after stop ${JSON.stringify(report.teardownElsewhere)}`);
});
await section(async () => {
  // Stuck somewhere a closed pipe can't reach, a child ignores SIGTERM for
  // good; killChild escalates to SIGKILL after its grace period.
  posix.wedged = true;
  try {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const record = spawned.at(-1);
    await sleep(200);
    const killedAt = Date.now();
    killChild(child);
    const exited = await exitedAll([record], 5000);
    const afterMs = record.exitedAt != null ? record.exitedAt - killedAt : null;
    report.killEscalation = { exited, afterMs, signals: record.signals };
    check(exited && record.signals.join(',') === 'SIGTERM,SIGKILL' && afterMs >= 1500, `kill escalation: ${JSON.stringify(report.killEscalation)}`);
  } finally {
    posix.wedged = false;
  }
});
await section(async () => {
  // A paused stream (no credits) holds its file open; Windows then refuses to
  // rename or delete it. Stopping the stream (what a long pause now does)
  // releases it.
  const file = join(media, 'lock-test.flac');
  copyFileSync(join(media, 'b60.flac'), file);
  const t = await transport({ 1: source(1, file, 48000) });
  await t.start({});
  await t.settle(300, 3000);
  let whileHeld = 'ok';
  try {
    renameSync(file, `${file}.moved`);
    renameSync(`${file}.moved`, file);
  } catch (err) {
    whileHeld = err.code;
  }
  await t.stop(2);
  await exitedAll(t.children());
  let afterStop = 'ok';
  try {
    renameSync(file, `${file}.moved`);
  } catch (err) {
    afterStop = err.code;
  }
  report.fileLock = { platform: process.platform, renameWhileHeld: whileHeld, renameAfterStop: afterStop };
  check(afterStop === 'ok', `file lock: rename after stop failed with ${afterStop}`);
  t.close();
});

console.log(JSON.stringify(report, null, 2));
// A case that threw never stopped its stream; as on app quit, nothing may
// outlive this process (on Windows a child ffmpeg would, holding fixtures).
closeAllGaplessSessions();
check(await exitedAll(spawned, 5000), `${spawned.filter((c) => !c.exited).length} ffmpeg process(es) still running at exit`);
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
} catch {
  /* tmp/ is scratch; a later run starts in its own directory */
}
if (failures.length) {
  console.error(`[gapless-producer] FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.error('[gapless-producer] PASS');
process.exit(0);
