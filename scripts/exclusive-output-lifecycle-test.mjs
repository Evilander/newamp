// Real ExclusiveOutput driver with controllable decoder, device and idle timers.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const originalSpawn = cp.spawn;
const originalTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
const children = [];
cp.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
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
const { ExclusiveOutput } = await import('../dist-electron/electron/exclusive-output.js');

function fixture(format = 's16') {
  let written = 0, rendered = 0, running = false, eos = false, maxWrite = Infinity;
  const bpf = format === 's24' ? 6 : 4;
  const events = [];
  const output = new ExclusiveOutput({ send: (e) => events.push(e), sendTap() {} });
  output.addon = {
    probeDevice: () => ({ name: 'Test DAC', formats: [{ format, channels: 2, sampleRate: 44100 }] }),
    open: () => ({ deviceName: 'Test DAC', internalFormat: format, internalChannels: 2, internalSampleRate: 44100 }),
    close: () => { running = false; },
    stats: () => ({ framesRendered: rendered, bufferedFrames: Math.floor(written / bpf) - rendered, capacityFrames: 1000, underruns: 0, drained: eos && rendered >= written / bpf, running }),
    write: (buf) => { const n = Math.min(buf.length, maxWrite); written += n; return n; },
    start: () => { running = true; }, stopDevice: () => { running = false; },
    clear: () => { written = rendered * bpf; }, setEos: (value) => { eos = value; },
  };
  const source = { trackId: 1, path: '/a.flac', sampleRate: 44100, channels: 2, bitDepth: format === 's24' ? 24 : 16, durationSec: 30, lossless: true, dsd: false };
  return { output, source, events, written: () => written, render: (n) => { rendered = n; }, limitWrite: (n) => { maxWrite = n; } };
}

try {
  {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', Buffer.alloc(40));
      const next = { ...f.source, trackId: 2, path: '/b.flac' };
      f.output.prepareNext(next);
      children.at(-1).stdout.emit('end');
      const decoder = children.at(-1);
      decoder.stdout.emit('data', Buffer.alloc(40));
      f.render(10);
      f.output.pollPlayback();
      assert.ok(f.events.some((e) => e.type === 'boundary'));
      assert.equal((await f.output.play(next, 0, null)).chained, true);
      decoder.stdout.emit('data', Buffer.alloc(40));
      assert.equal(f.written(), 120, 'chain acknowledgement keeps accepting the active decoder');
      decoder.stdout.emit('end');
      f.render(30);
      f.output.pollPlayback();
      assert.equal(f.events.filter((e) => e.type === 'ended').length, 1, 'the chained decoder can still end normally');
    } finally { f.output.dispose(); }
  }

  for (const idleReason of ['pause', 'end']) {
    const f = fixture();
    try {
      await f.output.play(f.source, 0, null);
      children.at(-1).stdout.emit('data', Buffer.alloc(40));
      if (idleReason === 'pause') f.output.pause();
      else {
        children.at(-1).stdout.emit('end');
        f.render(10);
        f.output.pollPlayback();
      }
      const timer = f.output.idleTimer;
      assert.ok(timers.has(timer));
      await f.output.play({ ...f.source, trackId: 2, path: '/b.flac' }, 0, null);
      assert.equal(timers.has(timer), false, `new playback cancels ${idleReason}'s device release`);
      assert.equal(f.output.idleTimer, null);
      assert.ok(f.output.openFormat);
    } finally { f.output.dispose(); }
  }

  for (const backpressure of [false, true]) {
    const f = fixture('s24');
    try {
      await f.output.play(f.source, 0, null);
      const pcm = Buffer.alloc(12);
      [0x100000, -0x200000, 0x300000, -0x400000].forEach((v, i) => pcm.writeIntLE(v, i * 3, 3));
      if (backpressure) {
        f.limitWrite(5);
        children.at(-1).stdout.emit('data', pcm);
        assert.equal(f.output.framesWrittenTotal, 0);
        f.output.pumpTimer._onTimeout();
        assert.equal(f.output.framesWrittenTotal, 1);
        f.output.pumpTimer._onTimeout();
      } else {
        for (const [start, end] of [[0, 1], [1, 5], [5, 10], [10, 12]]) {
          children.at(-1).stdout.emit('data', pcm.subarray(start, end));
        }
      }
      assert.equal(f.output.framesWrittenTotal, 2, 'frame accounting carries partial accepted writes');
      assert.equal(f.output.tapRemainder.length, 0);
      assert.deepEqual([...f.output.tapRing.slice(0, 4)], [0.125, -0.25, 0.375, -0.5]);
      children.at(-1).stdout.emit('data', Buffer.from([1, 2]));
      f.output.seek(5);
      assert.equal(f.output.tapRemainder.length, 0, 'seeking discards incomplete frames from the old decode');
    } finally { f.output.dispose(); }
  }
  assert.equal(timers.size, 0);
  console.log('PASS exclusive output: gapless acknowledgement, idle release, split PCM frames');
} finally {
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
  globalThis.setTimeout = originalTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
