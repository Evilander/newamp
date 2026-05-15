import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'replaygain-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const fixturePath = join(musicRoot, '01-gain-staged.ogg');

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
assert.equal(existsSync(fixturePath), true, 'ReplayGain fixture should exist');

const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, () => undefined);
await scanner.start([musicRoot]);
const [track] = library.getTracks({ limit: 10, sort: 'album' });
library.close();

assert.ok(track, 'ReplayGain fixture should scan');
assert.equal(track.title, 'Gain Staged');
assert.equal(track.replayGainTrackDb, -7);
assert.equal(track.replayGainAlbumDb, -5.5);

const [engineSource, storeSource, settingsSource] = await Promise.all([
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
]);

assert.match(engineSource, /setReplayGainDb/, 'audio engine should expose ReplayGain control');
assert.match(storeSource, /applyReplayGain/, 'player store should apply ReplayGain per track');
assert.match(settingsSource, /ReplayGain/, 'settings should expose ReplayGain mode');

console.log(JSON.stringify({
  ok: true,
  title: track.title,
  replayGainTrackDb: track.replayGainTrackDb,
  replayGainAlbumDb: track.replayGainAlbumDb,
}, null, 2));

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status})\n${result.stderr || result.stdout}`);
  }
}
