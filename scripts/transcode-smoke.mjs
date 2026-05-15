import { resolve } from 'node:path';
import { playbackMode, transcodeToWavResponse } from '../dist-electron/electron/transcode.js';

const target = process.argv[2];

if (!target) {
  console.error('usage: node scripts/transcode-smoke.mjs <audio-file>');
  process.exit(2);
}

const filePath = resolve(target);
const timeout = setTimeout(() => {
  console.error('transcode smoke timed out');
  process.exit(1);
}, 15000);

const controller = new AbortController();
const request = new Request(`newamp://track/${encodeURI(filePath.replace(/\\/g, '/'))}`, {
  signal: controller.signal,
});
const res = transcodeToWavResponse(filePath, request);
const reader = res.body?.getReader();

if (!reader) {
  console.error('response body missing');
  process.exit(1);
}

const chunks = [];
let total = 0;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (value) {
    chunks.push(value);
    total += value.byteLength;
  }
}

clearTimeout(timeout);
controller.abort();

const buf = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
const magic = buf.subarray(0, 4).toString('ascii');
const ok = res.ok && playbackMode(filePath) === 'ffmpeg' && magic === 'RIFF' && total > 44;

console.log(JSON.stringify({
  ok,
  mode: playbackMode(filePath),
  status: res.status,
  contentType: res.headers.get('content-type'),
  playbackHeader: res.headers.get('x-newamp-playback'),
  bytes: total,
  magic,
}, null, 2));

process.exit(ok ? 0 : 1);
