// The renderer half of Bit-Perfect Exclusive: what the bridge does with the
// events the main process sends.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let onEvent = null;
const api = {
  exclusiveSupported: async () => true,
  onExclusiveEvent: (fn) => { onEvent = fn; return () => {}; },
  onExclusiveTap: () => () => {},
  exclusivePlay: async () => ({ ok: true, chained: false }),
  exclusivePause: async () => {},
  exclusiveResume: async () => {},
  exclusiveStop: async () => {},
  exclusiveSeek: async () => {},
  exclusivePrepareNext: async () => {},
};
globalThis.__exclusiveApi = api;

// The bridge reaches the main process through lib/api; the bundle gets this
// file's stand-in instead of the renderer's.
const bundled = await build({
  stdin: {
    contents: "export { exclusiveBridge } from './src/audio/exclusive-bridge';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  plugins: [{
    name: 'api-stand-in',
    setup(b) {
      b.onResolve({ filter: /lib\/api$/ },() => ({ path: 'api', namespace: 'stand-in' }));
      b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ contents: 'export const api = globalThis.__exclusiveApi;', loader: 'js' }));
    },
  }],
});
const { exclusiveBridge } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const calls = [];
const engine = {
  setExternalAnalysis() {},
  setExternalTransport() {},
  setExclusiveNegotiated() {},
  patchExternal: (patch) => calls.push(['patch', patch]),
  handleExternalFailure: (positionSec, reason, forTrackId) => calls.push(['failure', positionSec, reason, forTrackId]),
  handleExternalDeviceLost: (positionSec) => calls.push(['lost', positionSec]),
};
const send = (payload) => { calls.length = 0; onEvent(payload); return [...calls]; };

try {
  assert.equal(await exclusiveBridge.setEnabled(engine, true), true);
  const gone = 'The drive stopped answering partway through the track.';

  // A track the drive stopped answering on is carried on from where it
  // stopped; the engine does not hear of an error, so nothing skips it. The
  // engine is told which track the stream was, to ignore one that has moved on.
  assert.deepEqual(send({ type: 'error', trackId: 9, message: gone, positionSec: 77 }), [['failure', 77, gone, 9]]);
  assert.deepEqual(send({ type: 'error', trackId: 9, message: gone, positionSec: 0 }), [['failure', 0, gone, 9]], 'the start of a track is a position too');

  // One that is simply broken has no position: the ordinary error.
  assert.deepEqual(send({ type: 'error', trackId: 9, message: 'Decode failed (ffmpeg 1).' }), [
    ['patch', { playing: false, buffering: false, error: 'Decode failed (ffmpeg 1).' }],
  ]);

  // The device is still the device.
  assert.deepEqual(send({ type: 'device-lost', trackId: 9, positionSec: 12 }), [['lost', 12]]);

  // Waiting on audio reaches the engine, and stops reaching it when it ends.
  const position = { type: 'position', trackId: 9, positionSec: 30, durationSec: 200, underruns: 0, bufferedFrames: 0 };
  assert.deepEqual(send({ ...position, buffering: true }), [['patch', { currentTime: 30, duration: 200, buffering: true }]]);
  assert.deepEqual(send({ ...position, buffering: false }), [['patch', { currentTime: 30, duration: 200, buffering: false }]]);
  assert.deepEqual(send(position), [['patch', { currentTime: 30, duration: 200, buffering: false }]], 'a main process that does not say is not waiting');
  console.log('PASS exclusive bridge: hand-over of a track the drive stopped answering on, ordinary errors, buffering');
} finally {
  await exclusiveBridge.setEnabled(engine, false);
}
