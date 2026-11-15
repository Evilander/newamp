// Bit-Perfect Exclusive on a share that fails reads or stalls: the real
// ExclusiveOutput driver with a controllable decoder, device and clock.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceCode = readFileSync(new URL('../electron/exclusive-output.ts', import.meta.url), 'utf8')
  .replace('this.addon = loadAddon();', 'this.addon = null;')
  .replace("import { resamplerFilter, resamplerKindNow } from './resampler.js';", "const resamplerFilter = () => 'aresample'; const resamplerKindNow = () => 'swr';")
  .replace("import { INPUT_PROTOCOLS, resolveFfmpegPath, watchFfmpegInput } from './transcode.js';", "const INPUT_PROTOCOLS = ['-protocol_whitelist', 'file,pipe']; const resolveFfmpegPath = () => 'fixture-ffmpeg'; const watchFfmpegInput = () => {};")
  .replace("import { killChild } from './kill-child.js';", 'const killChild = (child) => { child.killed = true; child.killedByUs = true; };');
const compiled = await build({
  stdin: { contents: sourceCode, loader: 'ts', resolveDir: fileURLToPath(new URL('../electron/', import.meta.url)) },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});

const originalSpawn = cp.spawn;
const originalTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalNow = Date.now;
const originalPerformanceNow = performance.now;
const originalWarn = console.warn;
const originalError = console.error;
const deadline = originalTimeout(() => { console.error('Exclusive resilience tests timed out'); process.exit(1); }, 10000);
deadline.unref();
console.warn = () => {};
console.error = () => {};
let clock = 1_000_000;
let mono = 5_000;
Date.now = () => clock;
performance.now = () => mono;
// Time passing, for the wall clock and the monotonic one alike.
const advance = (ms) => { clock += ms; mono += ms; };
const timers = new Map();
const children = [];
cp.spawn = (_path, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  child.args = args;
  children.push(child);
  return child;
};
syncBuiltinESMExports();
globalThis.setTimeout = (callback, ms) => {
  const handle = { callback, ms, unref() {} };
  timers.set(handle, callback);
  return handle;
};
globalThis.clearTimeout = (handle) => timers.delete(handle);
const { ExclusiveOutput, chooseExclusiveFormat } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const SAMPLE_RATE = 44100;
const FRAME_BYTES = 4;
// How far before where it stopped a resumed decode starts, and drops.
const WARMUP_SEC = 0.25;
const WARMUP_FRAMES = Math.round(WARMUP_SEC * SAMPLE_RATE);

// `ringBytes` makes the ring finite, so a write takes only what fits; what it
// took is what the device is given (`sunk`). `format` s24 has 6-byte frames.
function fixture(options = {}) {
  const format = options.format ?? 's16';
  const frameBytes = format === 's24' ? 6 : FRAME_BYTES;
  let written = 0, rendered = 0, running = false, eos = false, probes = 0, underruns = 0;
  const accepted = [];
  const events = [];
  const calls = [];
  const output = new ExclusiveOutput({ send: (e) => events.push(e), sendTap() {} });
  output.addon = {
    probeDevice: () => { probes++; return { name: 'Test DAC', formats: options.formats ?? [{ format, channels: 2, sampleRate: SAMPLE_RATE }] }; },
    open: (opts) => ({ deviceName: 'Test DAC', internalFormat: format, internalChannels: 2, internalSampleRate: opts.sampleRate, capacityFrames: options.capacityFrames ?? 1000 }),
    close: () => { running = false; calls.push('close'); },
    stats: () => ({ framesRendered: rendered, bufferedFrames: Math.floor(written / frameBytes) - rendered, capacityFrames: options.capacityFrames ?? 1000, underruns, drained: eos && rendered >= written / frameBytes, running }),
    write: (buf) => {
      const room = options.ringBytes == null ? buf.length : Math.max(0, options.ringBytes - (written - rendered * frameBytes));
      const taken = Math.min(buf.length, room);
      accepted.push(Buffer.from(buf.subarray(0, taken)));
      written += taken;
      return taken;
    },
    start: () => { calls.push('start'); if (options.startThrows) throw new Error('ma_device_start: device not available'); running = true; },
    stopDevice: () => { calls.push('stop'); running = false; },
    clear: () => { written = rendered * frameBytes; },
    setEos: (value) => { eos = value; },
  };
  // Two seconds: the longest a track is here that the stand-in decoders can
  // end cleanly in the middle of, so a clean exit is never short of it.
  const source = { trackId: 1, path: '/a.flac', sampleRate: SAMPLE_RATE, channels: 2, bitDepth: format === 's24' ? 24 : 16, durationSec: 2, lossless: true, dsd: false };
  return {
    output, source, events, calls,
    probes: () => probes,
    written: () => written,
    sunk: () => Buffer.concat(accepted),
    render: (n) => { rendered = n; },
    halt: () => { running = false; },
    setUnderruns: (n) => { underruns = n; },
  };
}

const pcm = (frames) => Buffer.alloc(frames * FRAME_BYTES);
// Frames whose first four bytes number them from `from`, so the audio that
// reaches the device can be checked frame by frame.
const tagged = (from, count, frameBytes = FRAME_BYTES) => {
  const out = Buffer.alloc(count * frameBytes, 0xa5);
  for (let i = 0; i < count; i++) out.writeUInt32LE(from + i, i * frameBytes);
  return out;
};
// A read that failed for a reason only a drive gives, and one that a drive and
// a file with damaged data both give (it is settled by asking the file system).
const ioError = (child, path) => child.stderr.emit('data', `[error] ${path}: Operation timed out\n`);
const unclearError = (child, path) => child.stderr.emit('data', `[error] ${path}: Input/output error\n`);
// The file system has answered about a decoder that stopped.
const answered = async (f) => { while (f.output.asking) await new Promise((resolve) => setImmediate(resolve)); };
const ssOf = (child) => { const i = child.args.indexOf('-ss'); return i < 0 ? 0 : Number(child.args[i + 1]); };
const fireTimers = () => { for (const [handle, callback] of [...timers]) { timers.delete(handle); callback(); } };
// A mono WAV of a sine, `bits` deep: the sample values and the file.
function monoWav(bits, count) {
  const bytes = bits / 8;
  const peak = 2 ** (bits - 1) - 1;
  const samples = Array.from({ length: count }, (_, i) => Math.round(0.6 * peak * Math.sin((2 * Math.PI * 997 * i) / SAMPLE_RATE)));
  const data = Buffer.alloc(count * bytes);
  samples.forEach((v, i) => data.writeIntLE(v, i * bytes, bytes));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * bytes, 28);
  header.writeUInt16LE(bytes, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return { samples, file: Buffer.concat([header, data]) };
}
const bundledFfmpeg = createRequire(import.meta.url)('ffmpeg-static');
const kinds = (f) => f.events.map((e) => e.type);
const failedOrLost = (f) => f.events.some((e) => e.type === 'error' || e.type === 'device-lost');

// What the file system can say about a track: its tail reads, or the file is not there.
const media = mkdtempSync(join(tmpdir(), 'newamp-exclusive-'));
const readable = join(media, 'readable.flac');
const missing = join(media, 'missing.flac');
writeFileSync(readable, Buffer.alloc(2048));

try {
  // A read that failed mid-track ends ffmpeg with exit 0: that must not end or
  // skip the track. The decode starts again at the frame it reached.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      f.output.prepareNext({ ...f.source, trackId: 2, path: '/b.flac' });
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE * 2));
      first.stdout.emit('data', Buffer.alloc(3));
      ioError(first, '/a.flac');
      first.emit('close', 0);
      assert.equal(children.length, 1, 'nothing is spawned until the retry delay has passed');
      assert.equal(f.output.eosSent, false, 'a failed read is not the end of the track');
      assert.equal(f.output.pendingSegment, null, 'the next track is not spliced in over it');
      fireTimers();
      const second = children.at(-1);
      assert.notEqual(second, first);
      assert.equal(second.args[second.args.indexOf('-i') + 1], '/a.flac');
      assert.equal(ssOf(second), 2 - WARMUP_SEC, 'it resumes a little before the whole frames already decoded');
      second.stdout.emit('data', pcm(SAMPLE_RATE + WARMUP_FRAMES));
      assert.equal(f.written(), (SAMPLE_RATE * 3) * FRAME_BYTES, 'the partial frame of the failed decode was dropped, and so was the overlap');
      second.emit('close', 0);
      assert.equal(f.output.eosSent, false, 'a clean end of the resumed decode splices the next track');
      assert.equal(children.at(-1).args[children.at(-1).args.indexOf('-i') + 1], '/b.flac');
      assert.equal(kinds(f).includes('error'), false);
      assert.equal(kinds(f).includes('ended'), false);
    } finally { f.output.dispose(); }
  }

  // A non-zero exit mid-track is resumed too, for a short time only.
  {
    const f = fixture();
    try {
      await f.output.play({ ...f.source, durationSec: 240 }, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE));
      first.emit('close', 1);
      fireTimers();
      assert.equal(ssOf(children.at(-1)), 1 - WARMUP_SEC);
      advance(11_000);
      children.at(-1).emit('close', 1);
      assert.equal(timers.size, 0, 'a damaged file stops being retried');
      assert.equal(f.events.at(-1).type, 'error');
      assert.equal(f.events.at(-1).trackId, 1);
      assert.equal(f.events.at(-1).positionSec, undefined, 'a broken file has no position to carry on from: it is skipped');
    } finally { f.output.dispose(); }
  }

  // An outage that outlasts the budget is neither an end nor a skip: the error
  // says where the playhead was, so the renderer carries the track on with the
  // shared player from there. Nothing else about the track is wrong.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      f.render(SAMPLE_RATE / 2);
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      for (let i = 0; i < 3; i++) {
        fireTimers();
        ioError(children.at(-1), '/a.flac');
        children.at(-1).emit('close', 0);
      }
      assert.equal(f.output.eosSent, false);
      assert.ok(timers.size > 0, 'the outage is still being waited out');
      advance(61_000);
      fireTimers();
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      assert.deepEqual(
        f.events.at(-1),
        { type: 'error', trackId: 1, message: 'The drive stopped answering partway through the track.', positionSec: 0.5 },
        'handed over at the playhead, with the reason',
      );
      assert.equal(kinds(f).includes('device-lost'), false, 'the device is fine');
      assert.equal(kinds(f).includes('ended'), false);
      assert.equal(kinds(f).includes('boundary'), false);
      assert.equal(f.output.openFormat, null, 'the device is let go');
      assert.equal((await f.output.play(f.source, 0.5, null)).chained, false, 'and the track can be played here again');
    } finally { f.output.dispose(); }
  }

  // Nothing had played when the drive gave out: the reason says so, and the
  // position is where the track was started.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 2, null);
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      advance(61_000);
      fireTimers();
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      assert.deepEqual(f.events.at(-1), { type: 'error', trackId: 1, message: 'The drive stopped answering.', positionSec: 2 });
    } finally { f.output.dispose(); }
  }

  // A retry that recovers for a second starts a new outage, so a share that
  // drops now and then is never given up on.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      for (let drop = 0; drop < 5; drop++) {
        ioError(children.at(-1), '/a.flac');
        children.at(-1).emit('close', 0);
        advance(40_000);
        fireTimers();
        children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE * 2));
      }
      assert.equal(kinds(f).includes('error'), false, 'recovered outages do not add up');
    } finally { f.output.dispose(); }
  }

  // A decoder hung on a read: nothing to play and no bytes for a while.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE));
      f.render(SAMPLE_RATE);
      advance(5000);
      f.output.pollPlayback();
      assert.equal(first.killedByUs, undefined, 'a decoder that only just went quiet is left alone');
      advance(4000);
      f.output.pollPlayback();
      assert.equal(first.killedByUs, true, 'the hung decoder is stopped');
      first.emit('close', null);
      assert.equal(f.events.some((e) => e.type === 'error'), false, 'its exit is not a second failure');
      fireTimers();
      assert.equal(ssOf(children.at(-1)), 1 - WARMUP_SEC, 'and started again where it got to');
    } finally { f.output.dispose(); }
  }

  // The ring running dry waits for half a second of audio before it goes on.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      f.render(SAMPLE_RATE);
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, true);
      assert.equal(f.calls.at(-1), 'stop', 'the device is held stopped while it refills');
      assert.equal(kinds(f).includes('device-lost'), false, 'a stopped device while refilling is not device loss');
      children.at(-1).stdout.emit('data', pcm(1000));
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, true);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE / 2));
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, false);
      assert.equal(f.calls.at(-1), 'start');
    } finally { f.output.dispose(); }
  }

  // A device that holds audio but stops consuming it is lost, even though it
  // still reports running.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE * 4));
      f.render(1000);
      f.output.pollPlayback();
      advance(1000);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('device-lost'), false);
      f.render(2000);
      f.output.pollPlayback();
      advance(1400);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('device-lost'), false, 'a device that is still moving is fine');
      advance(200);
      f.output.pollPlayback();
      assert.equal(f.events.filter((e) => e.type === 'device-lost').length, 1);
    } finally { f.output.dispose(); }
  }

  // Starting the device can fail; that is the device lost, not a thrown error.
  {
    const f = fixture({ startThrows: true });
    try {
      await f.output.play(f.source, 0, null);
      assert.doesNotThrow(() => children.at(-1).stdout.emit('data', pcm(100)));
      assert.equal(f.events.at(-1).type, 'device-lost');
      assert.equal(f.output.started, false, 'started is only set once the device runs');
      assert.equal(f.output.playing, false);
      assert.equal(f.output.openFormat, null, 'the device is released');
    } finally { f.output.dispose(); }
  }
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(1000));
      f.output.pause();
      f.output.addon.start = () => { throw new Error('ma_device_start: device not available'); };
      await assert.doesNotReject(f.output.resume(null));
      assert.equal(f.events.at(-1).type, 'device-lost');
    } finally { f.output.dispose(); }
  }

  // A prepared track that never decodes leaves no boundary behind it.
  for (const failure of ['io', 'empty']) {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      f.output.prepareNext({ ...f.source, trackId: 2, path: '/b.flac', durationSec: 70 });
      const first = children.at(-1);
      first.stdout.emit('data', pcm(1000));
      first.emit('close', 0);
      const next = children.at(-1);
      assert.notEqual(next, first);
      assert.equal(f.output.status().trackId, 1, 'the next track is not audible before it has audio');
      if (failure === 'io') {
        ioError(next, '/b.flac');
        next.emit('close', 0);
        advance(61_000);
        fireTimers();
        ioError(children.at(-1), '/b.flac');
        children.at(-1).emit('close', 0);
      } else {
        next.emit('close', 0);
      }
      assert.equal(f.output.pendingSegment, null);
      assert.equal(f.output.eosSent, true, 'the first track plays out what is queued');
      f.render(1000);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('boundary'), false, `no boundary for a ${failure} track that never played`);
      const ended = f.events.filter((e) => e.type === 'ended');
      assert.equal(ended.length, 1);
      assert.equal(ended[0].trackId, 1);
    } finally { f.output.dispose(); }
  }

  // The device's formats are asked for once per open, and an explicit device
  // is not asked again for each play.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, 'abcd');
      const asked = f.probes();
      f.output.prepareNext({ ...f.source, trackId: 2, path: '/b.flac' });
      children.at(-1).stdout.emit('data', pcm(1000));
      children.at(-1).emit('close', 0);
      assert.equal(f.probes(), asked, 'the track boundary reuses what the open learned');
      await f.output.play({ ...f.source, trackId: 3, path: '/c.flac' }, 0, 'abcd');
      assert.equal(f.probes(), asked, 'a second play on the same device reuses the answer');
      await f.output.play({ ...f.source, trackId: 4, path: '/d.flac' }, 0, null);
      await f.output.play({ ...f.source, trackId: 5, path: '/e.flac' }, 0, null);
      assert.equal(f.probes(), asked + 2, 'the default device is asked each time');
    } finally { f.output.dispose(); }
  }

  // The visualizer's delay line covers the ring the addon really allocated,
  // which it rounds up well past the 8 s asked for (44.1 kHz s16 gives 11.9 s).
  {
    const capacityFrames = 524288;
    assert.ok(capacityFrames > SAMPLE_RATE * 10, 'the fixture ring is larger than RING_MS worth of frames');
    const f = fixture({ capacityFrames });
    try {
      await f.output.play(f.source, 0, null);
      assert.ok(f.output.tapRingFrames >= capacityFrames + SAMPLE_RATE * 2);
    } finally { f.output.dispose(); }
  }

  // The ring holds more than the store's look-ahead, so the decoder can end
  // before the next track is prepared: the track is still chained on, and the
  // boundary is gapless rather than an end followed by a fresh play.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(1000));
      first.emit('close', 0);
      assert.equal(f.output.eosSent, true, 'nothing was prepared when the decoder ended');
      f.output.prepareNext({ ...f.source, trackId: 2, path: '/b.flac', durationSec: 70 });
      assert.equal(f.output.eosSent, false, 'the end of stream is taken back');
      const next = children.at(-1);
      assert.notEqual(next, first);
      assert.equal(next.args[next.args.indexOf('-i') + 1], '/b.flac');
      assert.equal(ssOf(next), 0);
      next.stdout.emit('data', pcm(1000));
      f.render(1000);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('boundary'), true);
      assert.equal(f.events.find((e) => e.type === 'boundary').trackId, 2);
      assert.equal(kinds(f).includes('ended'), false);
    } finally { f.output.dispose(); }
  }

  // Once the ring has played out, the end is final: a late prepare doesn't
  // reopen it.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(1000));
      children.at(-1).emit('close', 0);
      f.render(1000);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('ended'), true);
      const spawned = children.length;
      f.output.prepareNext({ ...f.source, trackId: 2, path: '/b.flac' });
      assert.equal(children.length, spawned);
      assert.equal(f.output.eosSent, true);
    } finally { f.output.dispose(); }
  }

  // A respawned decoder that hangs before its first byte is not waited on
  // forever: the first-audio timeout runs again for it.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      ioError(first, '/a.flac');
      first.emit('close', 0);
      advance(10_000);
      fireTimers();
      assert.notEqual(children.at(-1), first, 'the decode is tried again');
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('error'), false, 'the respawn gets its own wait');
      advance(16_000);
      f.output.pollPlayback();
      assert.deepEqual(
        f.events.at(-1),
        { type: 'error', trackId: 1, message: 'Timed out waiting for decoded audio.', positionSec: 0 },
        'a read that hangs is handed over with its position, not left to be skipped',
      );
      assert.equal(kinds(f).includes('device-lost'), false);
    } finally { f.output.dispose(); }
  }

  // A seek into a share that does not answer is handed over at the seek
  // target, not skipped.
  {
    const f = fixture();
    try {
      await f.output.play({ ...f.source, durationSec: 240 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      f.render(SAMPLE_RATE / 2);
      f.output.seek(3);
      advance(16_000);
      f.output.pollPlayback();
      assert.deepEqual(f.events.at(-1), { type: 'error', trackId: 1, message: 'Timed out waiting for decoded audio.', positionSec: 3 });
      assert.equal(kinds(f).includes('device-lost'), false);
    } finally { f.output.dispose(); }
  }

  // The last of a track that did not fit in the ring when its decoder ended is
  // still played, ahead of the next track, and the next track starts exactly
  // after it: nothing is dropped and no frame is cut in two. The ring takes
  // whatever fits, so with 6-byte frames a write ends inside one.
  for (const format of ['s16', 's24']) {
    const frameBytes = format === 's24' ? 6 : FRAME_BYTES;
    const f = fixture({ format, ringBytes: 1000 * frameBytes + 2 });
    try {
      await f.output.play(f.source, 0, null);
      f.output.prepareNext({ ...f.source, trackId: 2, path: '/b.flac' });
      const first = children.at(-1);
      first.stdout.emit('data', tagged(0, 800, frameBytes));
      first.stdout.emit('data', tagged(800, 600, frameBytes));
      assert.equal(f.written(), 1000 * frameBytes + 2, 'the ring took what fit');
      assert.equal(f.output.pendingChunk.length, 400 * frameBytes - 2, 'the rest waits for room');
      first.emit('close', 0);
      const next = children.at(-1);
      assert.notEqual(next, first, 'the next track starts while the last of this one is still waiting');
      next.stdout.emit('data', tagged(100_000, 300, frameBytes));
      f.render(1000);
      f.output.pumpTimer._onTimeout();
      const expected = Buffer.concat([tagged(0, 1400, frameBytes), tagged(100_000, 300, frameBytes)]);
      assert.equal(f.sunk().length, expected.length, `${format}: every byte of both tracks reaches the device`);
      assert.equal(f.sunk().length % frameBytes, 0);
      assert.ok(f.sunk().equals(expected), `${format}: the device gets the whole of the first track, then the second from its first frame`);
      f.output.pollPlayback();
      f.render(1399);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('boundary'), false, 'the second track is not audible while the end of the first plays');
      f.render(1400);
      f.output.pollPlayback();
      assert.equal(f.events.find((e) => e.type === 'boundary')?.trackId, 2);
    } finally { f.output.dispose(); }
  }

  // A decode that a failed read stopped carries on exactly where it left off:
  // what the ring had no room for yet is still played, and the join is exact
  // (the resumed decoder starts a little earlier and what it repeats is dropped).
  {
    const f = fixture({ ringBytes: 1000 * FRAME_BYTES });
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', tagged(0, 1500));
      ioError(first, '/a.flac');
      first.emit('close', 0);
      fireTimers();
      const second = children.at(-1);
      assert.equal(ssOf(second), 0, 'with 1500 frames done the overlap reaches back to the start of the file');
      second.stdout.emit('data', tagged(0, 1800));
      f.render(1000);
      f.output.pumpTimer._onTimeout();
      assert.ok(f.sunk().equals(tagged(0, 1800)), 'no frame lost or repeated across the join');
    } finally { f.output.dispose(); }
  }
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', tagged(0, SAMPLE_RATE * 2));
      ioError(first, '/a.flac');
      first.emit('close', 0);
      fireTimers();
      const second = children.at(-1);
      assert.equal(ssOf(second), 2 - WARMUP_SEC);
      const decoded = tagged(SAMPLE_RATE * 2 - WARMUP_FRAMES, WARMUP_FRAMES + 1000);
      for (let at = 0; at < decoded.length; at += 7001) second.stdout.emit('data', decoded.subarray(at, at + 7001));
      assert.ok(f.sunk().equals(tagged(0, SAMPLE_RATE * 2 + 1000)), 'the overlap is dropped however the pipe cuts it');
    } finally { f.output.dispose(); }
  }

  // The output rate is always the device's: raw PCM has no header that would
  // show a decoder running at another rate than the one on record. Opus
  // decodes at 48 kHz whatever rate its header gives.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const args = children.at(-1).args;
      assert.equal(args[args.indexOf('-ar') + 1], String(SAMPLE_RATE));
      assert.equal(args.includes('-af'), false, 'nothing is converted when the rates agree');
    } finally { f.output.dispose(); }
  }
  for (const [deviceRate, resampled] of [[SAMPLE_RATE, true], [48000, false]]) {
    const f = fixture({ formats: [{ format: 's16', channels: 2, sampleRate: deviceRate }] });
    try {
      const opus = { ...f.source, path: '/a.opus', lossless: false };
      const { negotiated } = await f.output.play(opus, 0, null);
      assert.equal(negotiated.sampleRate, deviceRate);
      assert.equal(negotiated.sourceSampleRate, 48000, 'the source is reported at the rate it decodes at');
      assert.equal(negotiated.resampled, resampled);
      assert.equal(negotiated.bitPerfect, false);
      const args = children.at(-1).args;
      assert.equal(args[args.indexOf('-ar') + 1], String(deviceRate));
      assert.equal(args.includes('-af'), resampled);
    } finally { f.output.dispose(); }
  }
  {
    const opus = { trackId: 1, path: '/a.OPUS', sampleRate: 44100, channels: 2, bitDepth: null, durationSec: 4, lossless: false, dsd: false };
    const both = [44100, 48000].map((sampleRate) => ({ format: 's16', channels: 2, sampleRate }));
    assert.equal(chooseExclusiveFormat(opus, both).sampleRate, 48000, 'an Opus file is played at 48 kHz when the device has it');
  }

  // The device can't be reopened when the pause is over: the renderer is told
  // and plays the track from here itself, rather than the transport staying on
  // play with no sound and nothing to press.
  for (const failure of ['open', 'probe']) {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE * 2));
      f.render(SAMPLE_RATE);
      f.output.pause();
      fireTimers();
      assert.equal(f.output.openFormat, null, 'the idle release gave the device back');
      const { open, probeDevice } = f.output.addon;
      if (failure === 'open') f.output.addon.open = () => { throw new Error('ma_device_init: the device is in use'); };
      else f.output.addon.probeDevice = () => { throw new Error('the device is gone'); };
      await assert.doesNotReject(f.output.resume(null));
      assert.deepEqual(f.events.at(-1), { type: 'device-lost', trackId: 1, positionSec: 1 });
      f.output.addon.open = open;
      f.output.addon.probeDevice = probeDevice;
      assert.equal((await f.output.play(f.source, 1, null)).chained, false, 'the replay opens the device again');
    } finally { f.output.dispose(); }
  }

  // A decode that exits cleanly well short of the track is not believed to be
  // its end, whatever ffmpeg's log says. The file system is asked whether the
  // file reads to its end, and one more decoder is started from there; only if
  // that finds nothing more did the track end where its audio did (the length
  // on record was wrong).
  {
    const f = fixture();
    try {
      const long = { ...f.source, path: readable, durationSec: 240 };
      await f.output.play(long, 0, null);
      f.output.prepareNext({ ...long, trackId: 2, path: '/b.flac' });
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE * 2));
      first.emit('close', 0);
      assert.equal(f.output.eosSent, false, 'not the end of the track');
      assert.equal(f.output.pendingSegment, null, 'and the next track is not spliced in over it');
      f.render(SAMPLE_RATE * 2);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('ended'), false);
      await answered(f);
      const second = children.at(-1);
      assert.notEqual(second, first, 'one more decoder, from the same frame');
      assert.equal(ssOf(second), 2 - WARMUP_SEC);
      second.stdout.emit('data', pcm(WARMUP_FRAMES));
      second.emit('close', 0);
      assert.equal(children.at(-1).args[children.at(-1).args.indexOf('-i') + 1], '/b.flac', 'nothing more: the next track follows');
      assert.equal(failedOrLost(f), false);
    } finally { f.output.dispose(); }
  }
  {
    const f = fixture();
    try {
      await f.output.play({ ...f.source, path: readable, durationSec: 240 }, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE * 2));
      first.emit('close', 0);
      await answered(f);
      const second = children.at(-1);
      second.stdout.emit('data', pcm(WARMUP_FRAMES + SAMPLE_RATE));
      second.emit('close', 0);
      assert.equal(f.output.eosSent, false, 'it found more, and stopped short again');
      await answered(f);
      assert.equal(ssOf(children.at(-1)), 3 - WARMUP_SEC);
    } finally { f.output.dispose(); }
  }
  {
    // A seek into a part of the file that does not read.
    const f = fixture();
    try {
      await f.output.play({ ...f.source, path: readable, durationSec: 240 }, 100, null);
      children.at(-1).emit('close', 0);
      assert.equal(f.output.eosSent, false, 'a seek that returns nothing is not the end of the track');
      await answered(f);
      assert.equal(ssOf(children.at(-1)), 100);
      children.at(-1).emit('close', 0);
      assert.equal(f.output.eosSent, true, 'unless it still returns nothing');
      assert.equal(failedOrLost(f), false);
    } finally { f.output.dispose(); }
  }
  {
    // A file whose last bytes can't be read was not read to its end, so there is
    // no end to confirm: it is a failed read, waited on for as long as its kind.
    const f = fixture();
    try {
      await f.output.play({ ...f.source, path: missing, durationSec: 240 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      children.at(-1).emit('close', 0);
      await answered(f);
      assert.ok(f.output.resumeTimer, 'read again after a wait');
      assert.equal(failedOrLost(f), false);
    } finally { f.output.dispose(); }
  }
  {
    // An answer that arrives after something else replaced the decode is ignored.
    const f = fixture();
    try {
      await f.output.play({ ...f.source, path: readable, durationSec: 240 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      children.at(-1).emit('close', 0);
      f.output.seek(10);
      const spawned = children.length;
      await new Promise((resolve) => originalTimeout(resolve, 100));
      assert.equal(children.length, spawned, 'no decoder for a question nobody is waiting on');
      assert.equal(f.output.asking, null);
    } finally { f.output.dispose(); }
  }
  {
    // Within two seconds of the length on record is the end.
    const f = fixture();
    try {
      await f.output.play({ ...f.source, durationSec: 7 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE * 6));
      children.at(-1).emit('close', 0);
      assert.equal(f.output.eosSent, true);
    } finally { f.output.dispose(); }
  }

  // Whose doing a failed read was decides how long it is waited on. A reason
  // only a drive gives is the drive's. One that a damaged file gets too is
  // settled by the file system: a volume that has gone is the drive's, and a
  // file that can't be read (held by another program, refused, gone) or whose
  // data is what failed gets the short wait and, if it doesn't recover, an
  // ordinary error: skipped, not handed over.
  const waitsLong = async (path) => {
    const f = fixture();
    try {
      await f.output.play({ ...f.source, path, durationSec: 240 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      unclearError(children.at(-1), path);
      children.at(-1).emit('close', 0);
      await answered(f);
      for (let i = 0; i < 3; i++) {
        advance(5000);
        fireTimers();
        unclearError(children.at(-1), path);
        children.at(-1).emit('close', 0);
        await answered(f);
      }
      assert.equal(failedOrLost(f), false, 'fifteen seconds in, a damaged file would have been given up on');
      advance(50_000);
      fireTimers();
      unclearError(children.at(-1), path);
      children.at(-1).emit('close', 0);
      await answered(f);
      assert.equal(f.events.at(-1).type, 'error');
      assert.equal(typeof f.events.at(-1).positionSec, 'number', 'handed over, not skipped');
    } finally { f.output.dispose(); }
  };
  const waitsShort = async (path, what) => {
    const f = fixture();
    try {
      await f.output.play({ ...f.source, path, durationSec: 240 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      unclearError(children.at(-1), path);
      children.at(-1).emit('close', 0);
      await answered(f);
      assert.ok(f.output.resumeTimer, `${what}: read again after a wait`);
      advance(11_000);
      fireTimers();
      unclearError(children.at(-1), path);
      children.at(-1).emit('close', 0);
      await answered(f);
      const last = f.events.at(-1);
      assert.equal(last.type, 'error', `${what}: given up on after the short wait`);
      assert.equal(last.positionSec, undefined, `${what}: skipped, not handed over`);
      assert.match(last.message, /Decode failed partway/);
      assert.equal(kinds(f).includes('ended'), false);
    } finally { f.output.dispose(); }
  };
  await waitsShort(missing, 'a file that cannot be read');
  await waitsShort(readable, 'a file whose data failed');
  if (process.platform === 'win32') {
    // A drive letter with nothing behind it is what a pulled drive or an
    // unmapped share leaves; on the other systems every file hangs off one
    // root that is always there, so no path shows it.
    const free = [...'ZYXWVUTSRQPONMLKJIHGFED'].find((letter) => !existsSync(`${letter}:\\`));
    if (free) await waitsLong(`${free}:\\Music\\a.flac`);
  }
  {
    // And a reason only a drive gives needs no question.
    const f = fixture();
    try {
      await f.output.play({ ...f.source, durationSec: 240 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      assert.equal(f.output.asking, null);
      for (let i = 0; i < 3; i++) {
        advance(5000);
        fireTimers();
        ioError(children.at(-1), '/a.flac');
        children.at(-1).emit('close', 0);
      }
      assert.equal(failedOrLost(f), false, 'fifteen seconds in, a damaged file would have been given up on');
      advance(50_000);
      fireTimers();
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      assert.equal(typeof f.events.at(-1).positionSec, 'number');
    } finally { f.output.dispose(); }
  }
  {
    // A damaged file that stops where it nearly ended anyway did play out.
    const f = fixture();
    try {
      await f.output.play({ ...f.source, path: readable, durationSec: 3 }, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE * 2));
      unclearError(children.at(-1), readable);
      children.at(-1).emit('close', 0);
      await answered(f);
      advance(11_000);
      fireTimers();
      unclearError(children.at(-1), readable);
      children.at(-1).emit('close', 0);
      await answered(f);
      assert.equal(f.output.eosSent, true, 'it ends there');
      assert.equal(failedOrLost(f), false);
    } finally { f.output.dispose(); }
  }

  // Pausing while a failed read is being waited out: the wait isn't spent
  // against the drive, nothing is read for a pause, and giving up never plays
  // the next track over it.
  for (const kind of ['drive', 'file']) {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE));
      f.render(SAMPLE_RATE / 2);
      if (kind === 'drive') ioError(first, '/a.flac');
      first.emit('close', kind === 'drive' ? 0 : 1);
      f.output.pause();
      advance(70_000);
      const retry = f.output.resumeTimer;
      timers.delete(retry);
      retry.callback();
      assert.equal(children.at(-1), first, `${kind}: nothing is read while paused`);
      assert.equal(failedOrLost(f), false, `${kind}: and the track is not given up on`);
      await f.output.resume(null);
      const again = children.at(-1);
      assert.notEqual(again, first, 'playing again reads it again');
      assert.equal(ssOf(again), 1 - WARMUP_SEC);
      if (kind === 'drive') ioError(again, '/a.flac');
      again.emit('close', kind === 'drive' ? 0 : 1);
      assert.equal(failedOrLost(f), false, 'the pause was not time the drive was given to answer');
      assert.ok(f.output.resumeTimer, 'it is waited on again');
    } finally { f.output.dispose(); }
  }

  // What was held back for a pause goes when something else replaces the decode.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE));
      ioError(first, '/a.flac');
      first.emit('close', 0);
      f.output.pause();
      const retry = f.output.resumeTimer;
      timers.delete(retry);
      retry.callback();
      f.output.seek(2);
      const spawned = children.length;
      await f.output.resume(null);
      assert.equal(children.length, spawned, 'playing again does not start the decode the seek replaced');
    } finally { f.output.dispose(); }
  }

  // A source that trickles leaves the ring just above empty at every poll
  // while the device keeps coming up short between them: that holds the device
  // stopped until it has refilled, as an empty ring does.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      f.render(SAMPLE_RATE - 2000);
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, false, 'a short ring is not a dry one');
      f.setUnderruns(3);
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, true);
      assert.equal(f.calls.at(-1), 'stop');
    } finally { f.output.dispose(); }
  }
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE * 2));
      f.output.pollPlayback();
      f.setUnderruns(3);
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, false, 'a ring with a refill in it is left alone');
    } finally { f.output.dispose(); }
  }
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      children.at(-1).emit('close', 0);
      f.render(SAMPLE_RATE - 2000);
      f.output.pollPlayback();
      f.setUnderruns(1);
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, false, 'the end of the stream plays out');
    } finally { f.output.dispose(); }
  }

  // A sleep or a clock step during an outage doesn't use up the drive's time.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      clock += 120_000;
      mono += 2_000;
      fireTimers();
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      assert.equal(failedOrLost(f), false);
      assert.ok(f.output.resumeTimer, 'the outage is still being waited out');
    } finally { f.output.dispose(); }
  }

  // A sink that is slow to deliver its first callback after a start is given
  // time; one that has been moving and stops is not.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE * 4));
      f.output.pollPlayback();
      advance(3000);
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('device-lost'), false, 'three seconds without a callback is not loss yet');
      advance(2100);
      f.output.pollPlayback();
      assert.equal(f.events.filter((e) => e.type === 'device-lost').length, 1);
    } finally { f.output.dispose(); }
  }

  // A mono source goes to both channels as it is in the file, the way the
  // shared player plays it. `-ac 2` on its own would mix it in 3 dB down.
  // Run through the real ffmpeg with the arguments the driver builds: every
  // sample comes out unchanged on both channels, and so does the peak.
  for (const [format, bits] of [['s16', 16], ['s24', 24]]) {
    const dir = mkdtempSync(join(tmpdir(), 'newamp-mono-'));
    const f = fixture({ format });
    try {
      const { samples, file } = monoWav(bits, 4410);
      const path = join(dir, 'mono.wav');
      writeFileSync(path, file);
      const { negotiated } = await f.output.play({ ...f.source, path, channels: 1, bitDepth: bits }, 0, null);
      assert.equal(negotiated.upmixed, true, 'a mono source on a stereo device is still reported as adapted');
      assert.equal(negotiated.bitPerfect, false);
      const args = children.at(-1).args;
      assert.equal(args[args.indexOf('-af') + 1], 'aformat=channel_layouts=mono|stereo,pan=stereo|FL=FL+FC|FR=FR+FC');
      const run = cp.spawnSync(bundledFfmpeg, args, { maxBuffer: 1 << 24 });
      assert.equal(run.status, 0, String(run.stderr));
      const bytes = bits / 8;
      const expected = Buffer.alloc(samples.length * 2 * bytes);
      samples.forEach((v, i) => {
        expected.writeIntLE(v, i * 2 * bytes, bytes);
        expected.writeIntLE(v, i * 2 * bytes + bytes, bytes);
      });
      const peaks = [0, 1].map((side) => Math.max(...samples.map((_, i) => Math.abs(run.stdout.readIntLE(i * 2 * bytes + side * bytes, bytes)))));
      assert.deepEqual(peaks, [Math.max(...samples.map(Math.abs)), Math.max(...samples.map(Math.abs))], `${bits}-bit: the peak is the same on both channels`);
      assert.ok(run.stdout.equals(expected), `${bits}-bit: every output sample equals the input sample`);
    } finally {
      f.output.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    // Resampling comes after the mapping; a stereo source has none.
    const f = fixture({ formats: [{ format: 's16', channels: 2, sampleRate: 48000 }] });
    try {
      await f.output.play({ ...f.source, channels: 1 }, 0, null);
      const args = children.at(-1).args;
      assert.equal(args[args.indexOf('-af') + 1], 'aformat=channel_layouts=mono|stereo,pan=stereo|FL=FL+FC|FR=FR+FC,aresample');
      await f.output.play({ ...f.source, trackId: 2, path: '/b.flac', channels: 2 }, 0, null);
      assert.equal(children.at(-1).args.join(' ').includes('pan='), false);
    } finally { f.output.dispose(); }
  }

  // Playback says when it is waiting on audio: the ring ran dry, or a read is
  // being waited out and what is queued is running low. While the ring holds a
  // refill the audio is playing, whatever the share is doing.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      f.render(SAMPLE_RATE / 2);
      f.output.pollPlayback();
      assert.equal(f.events.at(-1).type, 'position');
      assert.equal(f.events.at(-1).buffering, false, 'playing');
      f.render(SAMPLE_RATE);
      f.output.pollPlayback();
      assert.equal(f.output.rebuffering, true);
      assert.equal(f.events.at(-1).buffering, true, 'the ring ran dry');
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      f.output.pollPlayback();
      assert.equal(f.events.at(-1).buffering, false, 'refilled');
    } finally { f.output.dispose(); }
  }
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE * 4));
      ioError(first, '/a.flac');
      first.emit('close', 0);
      f.output.pollPlayback();
      assert.equal(f.events.at(-1).buffering, false, 'a read is being waited out, but four seconds are queued');
      f.render(SAMPLE_RATE * 4 - 1000);
      f.output.pollPlayback();
      assert.equal(f.events.at(-1).buffering, true, 'and now almost none is');
    } finally { f.output.dispose(); }
  }

  // A decoder that produced nothing and failed without a read error says so.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).emit('close', 1);
      assert.equal(f.events.at(-1).type, 'error');
      assert.match(f.events.at(-1).message, /Decode failed \(ffmpeg 1\)/);
      assert.equal(f.events.at(-1).positionSec, undefined);
    } finally { f.output.dispose(); }
  }

  // Whatever started a decoder (a play, a seek, a splice, a resume), ffmpeg was
  // limited to files and pipes before it opened the track.
  assert.ok(children.length > 40);
  for (const child of children) {
    const at = child.args.indexOf('-protocol_whitelist');
    assert.ok(at >= 0 && at < child.args.indexOf('-i'), 'the whitelist comes before the input');
    assert.equal(child.args[at + 1], 'file,pipe');
  }

  assert.equal(timers.size, 0);
  console.log('PASS exclusive output resilience: read-failure resume, short exits, drive and file failures, outage budget and hand-over, pause during an outage, stall watchdog, rebuffering, device stall, start failure, resume failure, splice and resume joins, mono at unity, buffering state, probe cache');
} finally {
  rmSync(media, { recursive: true, force: true });
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
  globalThis.setTimeout = originalTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Date.now = originalNow;
  performance.now = originalPerformanceNow;
  console.warn = originalWarn;
  console.error = originalError;
  originalClearTimeout(deadline);
}
