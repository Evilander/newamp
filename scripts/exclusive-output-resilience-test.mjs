// Bit-Perfect Exclusive on a share that fails reads or stalls: the real
// ExclusiveOutput driver with a controllable decoder, device and clock.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceCode = readFileSync(new URL('../electron/exclusive-output.ts', import.meta.url), 'utf8')
  .replace('this.addon = loadAddon();', 'this.addon = null;')
  .replace("import { resamplerFilter, resamplerKindNow } from './resampler.js';", "const resamplerFilter = () => 'aresample'; const resamplerKindNow = () => 'swr';")
  .replace("import { resolveFfmpegPath, watchFfmpegInput } from './transcode.js';", "const resolveFfmpegPath = () => 'fixture-ffmpeg'; const watchFfmpegInput = () => {};")
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
const originalWarn = console.warn;
const originalError = console.error;
const deadline = originalTimeout(() => { console.error('Exclusive resilience tests timed out'); process.exit(1); }, 10000);
deadline.unref();
console.warn = () => {};
console.error = () => {};
let clock = 1_000_000;
Date.now = () => clock;
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
  const handle = { callback, ms };
  timers.set(handle, callback);
  return handle;
};
globalThis.clearTimeout = (handle) => timers.delete(handle);
const { ExclusiveOutput } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const SAMPLE_RATE = 44100;
const FRAME_BYTES = 4;

function fixture(options = {}) {
  let written = 0, rendered = 0, running = false, eos = false, probes = 0;
  const events = [];
  const calls = [];
  const output = new ExclusiveOutput({ send: (e) => events.push(e), sendTap() {} });
  output.addon = {
    probeDevice: () => { probes++; return { name: 'Test DAC', formats: [{ format: 's16', channels: 2, sampleRate: SAMPLE_RATE }] }; },
    open: () => ({ deviceName: 'Test DAC', internalFormat: 's16', internalChannels: 2, internalSampleRate: SAMPLE_RATE, capacityFrames: options.capacityFrames ?? 1000 }),
    close: () => { running = false; calls.push('close'); },
    stats: () => ({ framesRendered: rendered, bufferedFrames: Math.floor(written / FRAME_BYTES) - rendered, capacityFrames: options.capacityFrames ?? 1000, underruns: 0, drained: eos && rendered >= written / FRAME_BYTES, running }),
    write: (buf) => { written += buf.length; return buf.length; },
    start: () => { calls.push('start'); if (options.startThrows) throw new Error('ma_device_start: device not available'); running = true; },
    stopDevice: () => { calls.push('stop'); running = false; },
    clear: () => { written = rendered * FRAME_BYTES; },
    setEos: (value) => { eos = value; },
  };
  const source = { trackId: 1, path: '/a.flac', sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 16, durationSec: 240, lossless: true, dsd: false };
  return {
    output, source, events, calls,
    probes: () => probes,
    written: () => written,
    render: (n) => { rendered = n; },
    halt: () => { running = false; },
  };
}

const pcm = (frames) => Buffer.alloc(frames * FRAME_BYTES);
const ioError = (child, path) => child.stderr.emit('data', `[error] ${path}: Input/output error\n`);
const ssOf = (child) => { const i = child.args.indexOf('-ss'); return i < 0 ? 0 : Number(child.args[i + 1]); };
const fireTimers = () => { for (const [handle, callback] of [...timers]) { timers.delete(handle); callback(); } };
const kinds = (f) => f.events.map((e) => e.type);

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
      assert.equal(ssOf(second), 2, 'it resumes at the whole frames already decoded');
      second.stdout.emit('data', pcm(SAMPLE_RATE));
      assert.equal(f.written(), (SAMPLE_RATE * 3) * FRAME_BYTES, 'the partial frame of the failed decode was dropped');
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
      await f.output.play(f.source, 0, null);
      const first = children.at(-1);
      first.stdout.emit('data', pcm(SAMPLE_RATE));
      first.emit('close', 1);
      fireTimers();
      assert.equal(ssOf(children.at(-1)), 1);
      clock += 11_000;
      children.at(-1).emit('close', 1);
      assert.equal(timers.size, 0, 'a damaged file stops being retried');
      assert.equal(f.events.at(-1).type, 'error');
      assert.equal(f.events.at(-1).trackId, 1);
    } finally { f.output.dispose(); }
  }

  // An outage that outlasts the budget is an error for the track, never an end.
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', pcm(SAMPLE_RATE));
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      for (let i = 0; i < 3; i++) {
        fireTimers();
        ioError(children.at(-1), '/a.flac');
        children.at(-1).emit('close', 0);
      }
      assert.equal(f.output.eosSent, false);
      assert.ok(timers.size > 0, 'the outage is still being waited out');
      clock += 61_000;
      fireTimers();
      ioError(children.at(-1), '/a.flac');
      children.at(-1).emit('close', 0);
      assert.equal(f.events.at(-1).type, 'error');
      assert.match(f.events.at(-1).message, /drive stopped answering/);
      assert.equal(kinds(f).includes('ended'), false);
      assert.equal(kinds(f).includes('boundary'), false);
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
        clock += 40_000;
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
      clock += 5000;
      f.output.pollPlayback();
      assert.equal(first.killedByUs, undefined, 'a decoder that only just went quiet is left alone');
      clock += 4000;
      f.output.pollPlayback();
      assert.equal(first.killedByUs, true, 'the hung decoder is stopped');
      first.emit('close', null);
      assert.equal(f.events.some((e) => e.type === 'error'), false, 'its exit is not a second failure');
      fireTimers();
      assert.equal(ssOf(children.at(-1)), 1, 'and started again where it got to');
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
      clock += 1000;
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('device-lost'), false);
      f.render(2000);
      f.output.pollPlayback();
      clock += 1400;
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('device-lost'), false, 'a device that is still moving is fine');
      clock += 200;
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
        clock += 61_000;
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
      clock += 10_000;
      fireTimers();
      assert.notEqual(children.at(-1), first, 'the decode is tried again');
      f.output.pollPlayback();
      assert.equal(kinds(f).includes('error'), false, 'the respawn gets its own wait');
      clock += 16_000;
      f.output.pollPlayback();
      assert.equal(f.events.at(-1).type, 'error');
      assert.equal(f.events.at(-1).trackId, 1);
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
    } finally { f.output.dispose(); }
  }

  assert.equal(timers.size, 0);
  console.log('PASS exclusive output resilience: read-failure resume, outage budget, stall watchdog, rebuffering, device stall, start failure, dropped splice, probe cache');
} finally {
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
  globalThis.setTimeout = originalTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Date.now = originalNow;
  console.warn = originalWarn;
  console.error = originalError;
  originalClearTimeout(deadline);
}
