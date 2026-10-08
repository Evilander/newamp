import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function loadSource(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', mainFields: ['module', 'main'], logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const unhandled = [];
const observe = (error) => unhandled.push(error);
process.on('unhandledRejection', observe);
let activeRecorder;
let failStart = false;
globalThis.MediaStream = class {
  constructor(tracks) { this.tracks = tracks; }
  getVideoTracks() { return this.tracks; }
};
globalThis.MediaRecorder = class {
  static isTypeSupported() { return true; }
  constructor() { activeRecorder = this; this.state = 'inactive'; }
  start() { if (failStart) throw new Error('start fixture'); this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
};
const { createCanvasRecorder } = await loadSource('src/visualizer/eviland-recorder.ts');
const canvas = { captureStream: () => ({ getVideoTracks: () => [{ stop() {} }] }) };
const recorder = createCanvasRecorder(canvas);
recorder.start();
activeRecorder.onerror({ error: new Error('encoder fixture') });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(unhandled.length, 0);
await assert.rejects(recorder.stop(), /MediaRecorder reported an error/);
failStart = true;
assert.throws(() => recorder.start(), /MediaRecorder.start/);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(unhandled.length, 0);
failStart = false;
recorder.start();
activeRecorder.ondataavailable({ data: new Blob(['fixture']) });
assert.equal((await recorder.stop()).size, 7);
process.off('unhandledRejection', observe);

let supportedCodec = 'vp8';
let chosen;
globalThis.VideoEncoder = class {
  static async isConfigSupported(config) { return { supported: config.codec === supportedCodec }; }
  constructor(callbacks) { this.callbacks = callbacks; this.encodeQueueSize = 0; }
  configure(config) { this.config = config; chosen = config.codec; }
  encode(frame) {
    this.callbacks.output({ type: 'key', timestamp: frame.timestamp, duration: 33333, byteLength: 4, copyTo: (bytes) => bytes.set([1, 2, 3, 4]) },
      { decoderConfig: { codec: this.config.codec, codedWidth: 16, codedHeight: 16 } });
  }
  close() {}
};
globalThis.MediaStreamTrackProcessor = class {
  constructor() {
    let sent = false;
    this.readable = { getReader: () => ({
      read: async () => sent ? { done: true } : (sent = true, { done: false, value: { codedWidth: 16, codedHeight: 16, timestamp: 0, close() {} } }),
      cancel: async () => {},
    }) };
  }
};
const { createReplayRing } = await loadSource('src/visualizer/eviland-replay.ts');
for (const [codec, label] of [['vp8', 'V_VP8'], ['vp09.00.41.08', 'V_VP9']]) {
  supportedCodec = codec;
  const track = { stop() {} };
  const replay = createReplayRing({ width: 16, height: 16, captureStream: () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) });
  replay.arm();
  for (let i = 0; i < 20 && !replay.stats().videoChunks; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chosen, codec);
  assert.equal(replay.stats().videoChunks, 1);
  const clip = await replay.saveClip();
  assert.ok(Buffer.from(await clip.arrayBuffer()).includes(Buffer.from(label)), `${codec} must use ${label} container metadata`);
  replay.disarm();
}
console.log('PASS recorder error recovery and VP8/VP9 replay mux contracts');
