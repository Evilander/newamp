import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { playbackMode, transcodeToWavResponse, transcodeTrackToWavFile } from '../dist-electron/electron/transcode.js';

const target = process.argv[2] ?? generateFixture();

if (!target) {
  console.error('transcode smoke could not create or resolve an audio fixture');
  process.exit(1);
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
const exportPath = resolve('tmp', 'transcode-smoke', 'exported-track.wav');
const exported = await transcodeTrackToWavFile(filePath, exportPath);
const exportedMagic = (await readFile(exportPath)).subarray(0, 4).toString('ascii');

const [typesSource, mainSource, preloadSource, apiSource, nowPlayingSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
]);

assertExportWiring(typesSource, mainSource, preloadSource, apiSource, nowPlayingSource);

console.log(JSON.stringify({
  ok: ok && exportedMagic === 'RIFF' && exported.bytes > 44,
  fixture: filePath,
  mode: playbackMode(filePath),
  status: res.status,
  contentType: res.headers.get('content-type'),
  playbackHeader: res.headers.get('x-newamp-playback'),
  bytes: total,
  magic,
  exported,
  exportedMagic,
}, null, 2));

process.exit(ok && exportedMagic === 'RIFF' && exported.bytes > 44 ? 0 : 1);

function generateFixture() {
  if (!ffmpeg) {
    console.error('ffmpeg-static did not resolve a binary for this platform');
    process.exit(1);
  }
  const out = resolve('tmp', 'transcode-smoke', 'legacy-fallback.aiff');
  rmSync(dirname(out), { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=493.88:duration=1.2',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-y',
      out,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture generation failed (${result.status})\n${result.stderr || result.stdout}`);
  }
  return out;
}

function assertExportWiring(typesSource, mainSource, preloadSource, apiSource, nowPlayingSource) {
  assert.match(typesSource, /TrackWavExportResult/, 'shared API should expose WAV export result');
  assert.match(typesSource, /exportTrackWav/, 'shared API should expose track WAV export');
  assert.match(mainSource, /track:export-wav/, 'main process should register track WAV export IPC');
  assert.match(mainSource, /chooseTrackWavExportPath/, 'main process should use a native save dialog for WAV export');
  assert.match(mainSource, /transcodeTrackToWavFile\(track\.path/, 'main process should reuse ffmpeg file export');
  assert.match(preloadSource, /exportTrackWav/, 'preload should expose track WAV export');
  assert.match(apiSource, /exportTrackWav/, 'browser-safe API should include track WAV export');
  assert.match(nowPlayingSource, /data-export-track-wav/, 'Now Playing should expose current-track WAV export');
  assert.match(nowPlayingSource, /api\.exportTrackWav\(current\.id\)/, 'Now Playing WAV export should target the current track');
}
