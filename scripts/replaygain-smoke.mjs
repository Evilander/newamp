import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { analyzeTrackReplayGain } from '../dist-electron/electron/transcode.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'replaygain-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const fixturePath = join(musicRoot, '01-gain-staged.ogg');
const quietFixturePath = join(musicRoot, '02-needs-boost.wav');

if (!ffmpeg) throw new Error('ffmpeg-static did not resolve a binary');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

runFfmpeg([
  '-y',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=0.8',
  '-metadata',
  'title=Gain Staged',
  '-metadata',
  'artist=ReplayGain Fixture',
  '-metadata',
  'album=Normalized Album',
  '-metadata',
  'REPLAYGAIN_TRACK_GAIN=-7.00 dB',
  '-metadata',
  'REPLAYGAIN_ALBUM_GAIN=-5.50 dB',
  '-c:a',
  'libvorbis',
  '-q:a',
  '4',
  fixturePath,
]);
runFfmpeg([
  '-y',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:duration=0.8',
  '-filter:a',
  'volume=0.12',
  quietFixturePath,
]);
assert.equal(existsSync(fixturePath), true, 'ReplayGain fixture should exist');
assert.equal(existsSync(quietFixturePath), true, 'quiet ReplayGain fixture should exist');

const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, () => undefined);
await scanner.start([musicRoot]);
const [track] = library.getTracks({ limit: 10, sort: 'album' });
const quietTrack = library.getTracks({ search: 'title:02-needs-boost', limit: 10, sort: 'title' })[0];
const analysis = await analyzeTrackReplayGain(quietFixturePath);
assert.ok(analysis.replayGainTrackDb > 0, 'quiet fixture should need positive ReplayGain');
const analyzedTrack = quietTrack ? library.setTrackReplayGain(quietTrack.id, analysis.replayGainTrackDb) : null;
library.close();

assert.ok(track, 'ReplayGain fixture should scan');
assert.ok(quietTrack, 'quiet fixture should scan');
assert.ok(analyzedTrack, 'analyzed quiet fixture should update');
assert.equal(track.title, 'Gain Staged');
assert.equal(track.replayGainTrackDb, -7);
assert.equal(track.replayGainAlbumDb, -5.5);
assert.equal(analyzedTrack?.replayGainTrackDb, Number(analysis.replayGainTrackDb.toFixed(2)));

const [typesSource, transcodeSource, librarySource, mainSource, preloadSource, apiSource, engineSource, storeSource, settingsSource, libraryViewSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/transcode.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /ReplayGainAnalysisResult/, 'shared API should expose ReplayGain analysis result');
assert.match(typesSource, /analyzeReplayGain/, 'shared API should expose ReplayGain analysis');
assert.match(transcodeSource, /analyzeTrackReplayGain/, 'transcode module should expose ffmpeg ReplayGain analysis');
assert.match(transcodeSource, /ebur128=peak=true/, 'ReplayGain analysis should use ffmpeg EBU R128 loudness');
assert.match(librarySource, /setTrackReplayGain/, 'library should persist analyzed ReplayGain values');
assert.match(mainSource, /tracks:analyze-replaygain/, 'main process should register ReplayGain analysis IPC');
assert.match(preloadSource, /analyzeReplayGain/, 'preload should expose ReplayGain analysis');
assert.match(apiSource, /analyzeReplayGain/, 'browser-safe API should include ReplayGain analysis');
assert.match(engineSource, /setReplayGainDb/, 'audio engine should expose ReplayGain control');
assert.match(storeSource, /applyReplayGain/, 'player store should apply ReplayGain per track');
assert.match(settingsSource, /ReplayGain/, 'settings should expose ReplayGain mode');
assert.match(libraryViewSource, /data-analyze-selected-replaygain/, 'Library selected toolbar should expose ReplayGain analysis');
assert.match(libraryViewSource, /api\.analyzeReplayGain/, 'Library selected toolbar should call ReplayGain analysis');

console.log(JSON.stringify({
  ok: true,
  title: track.title,
  replayGainTrackDb: track.replayGainTrackDb,
  replayGainAlbumDb: track.replayGainAlbumDb,
  analyzed: {
    title: analyzedTrack?.title,
    replayGainTrackDb: analyzedTrack?.replayGainTrackDb,
    integratedLufs: analysis.integratedLufs,
  },
}, null, 2));

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status})\n${result.stderr || result.stdout}`);
  }
}
