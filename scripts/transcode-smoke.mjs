import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  playbackMode,
  transcodeToWavResponse,
  transcodeTrackToWavFile,
  transcodeTracksToWavFolder,
} from '../dist-electron/electron/transcode.js';

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
const batch = await transcodeTracksToWavFolder(
  [
    fixtureTrack(filePath, 1, 'Batch One'),
    fixtureTrack(filePath, 2, 'Batch One'),
  ],
  resolve('tmp', 'transcode-smoke', 'batch'),
);
const batchMagics = await Promise.all(
  batch.files.map(async (file) => (await readFile(file.path)).subarray(0, 4).toString('ascii')),
);

const [typesSource, transcodeSource, mainSource, preloadSource, apiSource, nowPlayingSource, libraryViewSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/transcode.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
]);

assertExportWiring(typesSource, transcodeSource, mainSource, preloadSource, apiSource, nowPlayingSource, libraryViewSource);

assert.equal(batch.exported, 2, 'batch export should transcode every selected fixture');
assert.equal(batch.skipped.length, 0, 'batch export should not skip valid fixtures');
assert.ok(batch.bytes > exported.bytes, 'batch export should report aggregate bytes');
assert.equal(new Set(batch.files.map((file) => file.path)).size, 2, 'batch export should create unique output paths');
assert.deepEqual(batchMagics, ['RIFF', 'RIFF'], 'batch export files should be WAV files');

console.log(JSON.stringify({
  ok: ok && exportedMagic === 'RIFF' && exported.bytes > 44 && batchMagics.every((magic) => magic === 'RIFF'),
  fixture: filePath,
  mode: playbackMode(filePath),
  status: res.status,
  contentType: res.headers.get('content-type'),
  playbackHeader: res.headers.get('x-newamp-playback'),
  bytes: total,
  magic,
  exported,
  exportedMagic,
  batch,
  batchMagics,
}, null, 2));

process.exit(ok && exportedMagic === 'RIFF' && exported.bytes > 44 && batchMagics.every((magic) => magic === 'RIFF') ? 0 : 1);

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

function fixtureTrack(path, id, title) {
  return {
    id,
    path,
    title,
    artist: 'Batch Fixture',
    album: 'Transcode Smoke',
    albumArtist: 'Batch Fixture',
    trackNo: id,
    discNo: null,
    year: 2026,
    genre: 'Fixture',
    duration: 1.2,
    bitrate: null,
    sampleRate: 44100,
    size: null,
    mtime: Date.now(),
    hasArt: 0,
    loved: 0,
    rating: 0,
    avoidAutoPlay: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
  };
}

function assertExportWiring(typesSource, transcodeSource, mainSource, preloadSource, apiSource, nowPlayingSource, libraryViewSource) {
  assert.match(typesSource, /TrackWavExportResult/, 'shared API should expose WAV export result');
  assert.match(typesSource, /TrackWavBatchExportResult/, 'shared API should expose batch WAV export result');
  assert.match(typesSource, /exportTrackWav/, 'shared API should expose track WAV export');
  assert.match(typesSource, /exportTracksWav/, 'shared API should expose batch track WAV export');
  assert.match(transcodeSource, /transcodeTracksToWavFolder/, 'transcode module should expose batch WAV folder export');
  assert.match(mainSource, /track:export-wav/, 'main process should register track WAV export IPC');
  assert.match(mainSource, /tracks:export-wav-folder/, 'main process should register batch track WAV export IPC');
  assert.match(mainSource, /chooseTrackWavExportPath/, 'main process should use a native save dialog for WAV export');
  assert.match(mainSource, /chooseTracksWavExportFolder/, 'main process should use a native folder picker for batch WAV export');
  assert.match(mainSource, /transcodeTrackToWavFile\(track\.path/, 'main process should reuse ffmpeg file export');
  assert.match(mainSource, /transcodeTracksToWavFolder\(tracks, destinationRoot\)/, 'main process should reuse ffmpeg batch export');
  assert.match(preloadSource, /exportTrackWav/, 'preload should expose track WAV export');
  assert.match(preloadSource, /exportTracksWav/, 'preload should expose batch track WAV export');
  assert.match(apiSource, /exportTrackWav/, 'browser-safe API should include track WAV export');
  assert.match(apiSource, /exportTracksWav/, 'browser-safe API should include batch track WAV export');
  assert.match(nowPlayingSource, /data-export-track-wav/, 'Now Playing should expose current-track WAV export');
  assert.match(nowPlayingSource, /api\.exportTrackWav\(current\.id\)/, 'Now Playing WAV export should target the current track');
  assert.match(libraryViewSource, /data-export-selected-wav/, 'Library selected toolbar should expose batch WAV export');
  assert.match(libraryViewSource, /api\.exportTracksWav/, 'Library selected toolbar should call batch WAV export');
}
