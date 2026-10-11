// A track that is playing through ffmpeg holds its file open, and Windows will
// not move a file another process has open. Both long-running decoders (the
// seekable WAV the <audio> element reads, and Bit-Perfect Exclusive) register
// with the watcher that "Move to Recycle Bin" stops first.
//  - audio-serve: the decoder is stopped, the file can then be moved, and the
//    response ends in an error instead of padding the rest of the track with
//    silence
//  - exclusive output: its decoder registers on the audible file, again after a
//    seek, and a decoder stopped from outside reports no failure and ends the
//    track (a destroyed stdout never emits 'end', so the process closing is
//    all the output hears)
// Run: npm run build:electron && node scripts/decoder-release-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import cp, { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const deadline = setTimeout(() => { console.error('decoder-release-test timed out'); process.exit(1); }, 60_000);
deadline.unref();

const root = resolve('tmp', 'decoder-release-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

// --- the seekable WAV response ------------------------------------------------------
{
  const { seekableTranscodeResponse } = await import(pathToFileURL(resolve('dist-electron/electron/audio-serve.js')).href);
  const { stopFfmpegReading } = await import(pathToFileURL(resolve('dist-electron/electron/transcode.js')).href);

  const wav = join(root, 'playing.wav');
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120', wav], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stderr);

  const response = await seekableTranscodeResponse(wav, new Request('http://newamp.test/track', { headers: { Range: 'bytes=0-' } }));
  assert.equal(response.headers.get('X-Newamp-Playback'), 'ffmpeg-seekable-wav', 'served by the decoder, not the legacy pipe');
  const promised = Number(response.headers.get('Content-Length'));
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value?.length > 0, 'the decoder is producing audio');
  // Nobody reads on: the stream's buffer fills and the decoder sits blocked on
  // its pipe with the file open, the way it does for most of a track.
  await new Promise((r) => setTimeout(r, 700));
  if (process.platform === 'win32') {
    await assert.rejects(rename(wav, join(root, 'moved.wav')), 'Windows refuses to move a file the decoder has open');
  }

  await stopFfmpegReading([wav]);
  await rename(wav, join(root, 'moved.wav'));
  assert.ok(existsSync(join(root, 'moved.wav')), 'the file can be moved once the decoder is stopped');

  // What the element sees next: an error, promptly, not a body padded with
  // silence out to the promised length.
  const outcome = await Promise.race([
    (async () => {
      let bytes = first.value.length;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return { done: true, bytes };
          bytes += next.value.length;
        }
      } catch (err) {
        return { error: err, bytes };
      }
    })(),
    new Promise((r) => setTimeout(() => r({ timedOut: true }), 5000)),
  ]);
  assert.ok(!outcome.timedOut, 'the response ends once its decoder is stopped');
  assert.ok(outcome.error, 'it ends in an error');
  assert.ok(outcome.bytes < promised / 4, `no silence padding: ${outcome.bytes} of ${promised} bytes delivered`);
}

// --- Bit-Perfect Exclusive --------------------------------------------------------------
{
  const watched = [];
  const children = [];
  const source = readFileSync(new URL('../electron/exclusive-output.ts', import.meta.url), 'utf8')
    .replace('this.addon = loadAddon();', 'this.addon = null;')
    .replace("import { resamplerFilter, resamplerKindNow } from './resampler.js';", "const resamplerFilter = () => 'aresample'; const resamplerKindNow = () => 'swr';")
    .replace(
      "import { resolveFfmpegPath, watchFfmpegInput } from './transcode.js';",
      "const resolveFfmpegPath = () => 'fixture-ffmpeg'; const watchFfmpegInput = (child, path) => globalThis.__watched.push([child, path]);",
    )
    .replace("import { killChild } from './kill-child.js';", 'const killChild = (child) => child.kill();');
  const compiled = await build({ stdin: { contents: source, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });

  const originalSpawn = cp.spawn;
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.__watched = watched;
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
  globalThis.setTimeout = (callback, ms) => ({ callback, ms });
  globalThis.clearTimeout = () => {};
  try {
    const { ExclusiveOutput } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    const events = [];
    const eos = [];
    const output = new ExclusiveOutput({ send: (e) => events.push(e), sendTap() {} });
    output.addon = {
      probeDevice: () => ({ name: 'Test DAC', formats: [{ format: 's16', channels: 2, sampleRate: 44100 }] }),
      open: () => ({ deviceName: 'Test DAC', internalFormat: 's16', internalChannels: 2, internalSampleRate: 44100 }),
      close() {},
      stats: () => ({ framesRendered: 0, bufferedFrames: 0, capacityFrames: 1000, underruns: 0, drained: false, running: true }),
      write: (buf) => buf.length,
      start() {}, stopDevice() {}, clear() {}, setEos: (value) => eos.push(value),
    };
    try {
      await output.play({ trackId: 1, path: '/music/a.flac', sampleRate: 44100, channels: 2, bitDepth: 16, durationSec: 30, lossless: true, dsd: false }, 0, null);
      assert.equal(watched.length, 1, 'the decoder is registered when it starts');
      assert.equal(watched[0][0], children[0]);
      assert.equal(watched[0][1], '/music/a.flac', 'on the file it reads');

      output.seek(5);
      assert.equal(watched.length, 2, 'a seek starts a new decoder, which is registered too');
      assert.equal(watched[1][0], children[1]);
      assert.equal(watched[1][1], '/music/a.flac');

      // The decoder the seek replaced closes late: it is not the track ending.
      children[0].emit('close', null, 'SIGTERM');
      assert.equal(output.eosSent, false, 'a decoder a seek replaced does not end the track');
      assert.equal(eos.includes(true), false);
      assert.equal(output.ffmpeg, children[1]);

      // Stopped from outside, the way a move to the Recycle Bin stops it: the
      // process reports a signal, not a failing exit code, and its stdout was
      // destroyed, so no 'end' ever comes.
      const ended = [];
      children[1].stdout.on('end', () => ended.push('end'));
      children[1].stdout.destroy();
      children[1].killed = true;
      children[1].emit('close', null, 'SIGTERM');
      assert.deepEqual(ended, [], 'a destroyed stdout does not emit end');
      assert.equal(events.some((e) => e.type === 'error'), false, 'a decoder that was stopped is not a decode failure');
      assert.equal(eos.at(-1), true, 'the output is told the stream is over, so the track ends');
      assert.equal(output.eosSent, true);
      assert.equal(output.ffmpeg, null, 'and no dead decoder is kept');

      // A second close for the same child changes nothing.
      const told = eos.length;
      children[1].emit('close', null, 'SIGTERM');
      assert.equal(eos.length, told);
    } finally {
      output.dispose();
    }
  } finally {
    cp.spawn = originalSpawn;
    syncBuiltinESMExports();
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    delete globalThis.__watched;
  }
}

console.log('decoder-release-test: ok');
