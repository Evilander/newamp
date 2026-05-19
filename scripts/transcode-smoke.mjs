import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  playbackMode,
  transcodeToWavResponse,
  transcodeTracksToAudioFolder,
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
const multiFormatExports = [];
for (const format of ['mp3', 'flac', 'opus']) {
  const result = await transcodeTracksToAudioFolder(
    [fixtureTrack(filePath, 10 + multiFormatExports.length, `${format.toUpperCase()} Export`)],
    resolve('tmp', 'transcode-smoke', `batch-${format}`),
    format,
  );
  const file = result.files[0];
  const magic = file ? await audioMagic(file.path, format) : '';
  multiFormatExports.push({ format, result, magic });
}

const [typesSource, transcodeSource, mainSource, preloadSource, apiSource, nowPlayingSource, libraryViewSource, scannerSource, watcherSource, librarySource, installerSource, packageSource, formatSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/transcode.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../electron/scanner.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library-watcher.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
  readFile(new URL('../build/installer.nsh', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/format.tsx', import.meta.url), 'utf8'),
]);

assertExportWiring(typesSource, transcodeSource, mainSource, preloadSource, apiSource, nowPlayingSource, libraryViewSource);
assertDsdWiring({ transcodeSource, mainSource, scannerSource, watcherSource, librarySource, installerSource, packageSource, formatSource, nowPlayingSource });

assert.equal(batch.exported, 2, 'batch export should transcode every selected fixture');
assert.equal(batch.skipped.length, 0, 'batch export should not skip valid fixtures');
assert.ok(batch.bytes > exported.bytes, 'batch export should report aggregate bytes');
assert.equal(new Set(batch.files.map((file) => file.path)).size, 2, 'batch export should create unique output paths');
assert.deepEqual(batchMagics, ['RIFF', 'RIFF'], 'batch export files should be WAV files');
assert.deepEqual(
  multiFormatExports.map((item) => ({ format: item.format, exported: item.result.exported, magic: item.magic })),
  [
    { format: 'mp3', exported: 1, magic: 'MP3' },
    { format: 'flac', exported: 1, magic: 'fLaC' },
    { format: 'opus', exported: 1, magic: 'OggS' },
  ],
  'multi-format export should produce MP3, FLAC, and Opus files',
);

console.log(JSON.stringify({
  ok: ok
    && exportedMagic === 'RIFF'
    && exported.bytes > 44
    && batchMagics.every((magic) => magic === 'RIFF')
    && multiFormatExports.every((item) => item.result.exported === 1),
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
  multiFormatExports,
}, null, 2));

process.exit(
  ok
  && exportedMagic === 'RIFF'
  && exported.bytes > 44
  && batchMagics.every((magic) => magic === 'RIFF')
  && multiFormatExports.every((item) => item.result.exported === 1)
    ? 0
    : 1,
);

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

function assertDsdWiring(sources) {
  for (const [label, source] of Object.entries(sources)) {
    assert.match(source, /['"]\.?dsf['"]|["']dsf["']/i, `${label} should include DSF support`);
    assert.match(source, /['"]\.?dff['"]|["']dff["']/i, `${label} should include DFF support`);
  }
  assert.match(sources.transcodeSource, /X-Newamp-Playback.*ffmpeg-transcode/s, 'DSD fallback should keep using the ffmpeg playback path');
  assert.match(sources.transcodeSource, /existsSync\(staticCandidate\)/, 'Linux packages should fall back to system ffmpeg when a platform-static binary is missing');
  assert.match(sources.packageSource, /node_modules\/ffmpeg-static\/\*\*\/\*/, 'packaged apps should unpack the available platform ffmpeg-static payload');
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
  assert.match(typesSource, /AudioExportFormat/, 'shared API should expose audio export formats');
  assert.match(typesSource, /TrackAudioBatchExportResult/, 'shared API should expose multi-format audio export result');
  assert.match(typesSource, /exportTrackWav/, 'shared API should expose track WAV export');
  assert.match(typesSource, /exportTracksWav/, 'shared API should expose batch track WAV export');
  assert.match(typesSource, /exportTracksAudio/, 'shared API should expose selected-track audio export');
  assert.match(transcodeSource, /transcodeTracksToWavFolder/, 'transcode module should expose batch WAV folder export');
  assert.match(transcodeSource, /SUPPORTED_AUDIO_EXPORT_FORMATS/, 'transcode module should define supported audio export formats');
  assert.match(transcodeSource, /transcodeTracksToAudioFolder/, 'transcode module should expose multi-format folder export');
  assert.match(transcodeSource, /libmp3lame/, 'multi-format export should support MP3 encoding');
  assert.match(transcodeSource, /libopus/, 'multi-format export should support Opus encoding');
  assert.match(mainSource, /track:export-wav/, 'main process should register track WAV export IPC');
  assert.match(mainSource, /tracks:export-wav-folder/, 'main process should register batch track WAV export IPC');
  assert.match(mainSource, /tracks:export-audio-folder/, 'main process should register multi-format track export IPC');
  assert.match(mainSource, /chooseTrackWavExportPath/, 'main process should use a native save dialog for WAV export');
  assert.match(mainSource, /chooseTracksWavExportFolder/, 'main process should use a native folder picker for batch WAV export');
  assert.match(mainSource, /chooseTracksAudioExportFolder/, 'main process should use a native folder picker for multi-format export');
  assert.match(mainSource, /transcodeTrackToWavFile\(track\.path/, 'main process should reuse ffmpeg file export');
  assert.match(mainSource, /transcodeTracksToWavFolder\(tracks, destinationRoot\)/, 'main process should reuse ffmpeg batch export');
  assert.match(mainSource, /transcodeTracksToAudioFolder\(tracks, destinationRoot, format\)/, 'main process should reuse ffmpeg multi-format batch export');
  assert.match(preloadSource, /exportTrackWav/, 'preload should expose track WAV export');
  assert.match(preloadSource, /exportTracksWav/, 'preload should expose batch track WAV export');
  assert.match(preloadSource, /exportTracksAudio/, 'preload should expose multi-format track export');
  assert.match(apiSource, /exportTrackWav/, 'browser-safe API should include track WAV export');
  assert.match(apiSource, /exportTracksWav/, 'browser-safe API should include batch track WAV export');
  assert.match(apiSource, /exportTracksAudio/, 'browser-safe API should include multi-format track export');
  assert.match(nowPlayingSource, /data-export-track-wav/, 'Now Playing should expose current-track WAV export');
  assert.match(nowPlayingSource, /api\.exportTrackWav\(current\.id\)/, 'Now Playing WAV export should target the current track');
  assert.match(libraryViewSource, /data-export-selected-wav/, 'Library selected toolbar should expose batch WAV export');
  assert.match(libraryViewSource, /data-export-selected-mp3/, 'Library selected toolbar should expose MP3 export');
  assert.match(libraryViewSource, /data-export-selected-flac/, 'Library selected toolbar should expose FLAC export');
  assert.match(libraryViewSource, /data-export-selected-opus/, 'Library selected toolbar should expose Opus export');
  assert.match(libraryViewSource, /api\.exportTracksWav/, 'Library selected toolbar should call batch WAV export');
  assert.match(libraryViewSource, /api\.exportTracksAudio/, 'Library selected toolbar should call multi-format export');
}

async function audioMagic(path, format) {
  const buffer = await readFile(path);
  const magic = buffer.subarray(0, 4).toString('ascii');
  if (format === 'mp3') {
    if (magic.slice(0, 3) === 'ID3') return 'MP3';
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'MP3';
  }
  return magic;
}
