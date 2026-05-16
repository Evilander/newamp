import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cueAudioPaths, cueEntriesToTracks, parseCueSheet } from '../dist-electron/electron/cue.js';

const smokeRoot = resolve('tmp', 'cue-smoke');
await mkdir(smokeRoot, { recursive: true });
const albumPath = join(smokeRoot, 'archive-album.flac');
const cuePath = join(smokeRoot, 'archive-album.cue');
await writeFile(albumPath, 'cue source placeholder', 'utf8');

const cue = `
REM GENRE "Post-Punk"
REM DATE 1981
PERFORMER "The Archive Band"
TITLE "One File Album"
FILE "archive-album.flac" WAVE
  TRACK 01 AUDIO
    TITLE "First Index"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Second Index"
    PERFORMER "Guest Singer"
    INDEX 01 01:31:00
  TRACK 03 AUDIO
    TITLE "Last Index"
    INDEX 01 03:05:00
`;
await writeFile(cuePath, cue, 'utf8');

const entries = parseCueSheet(cue, cuePath);
assert.equal(entries.length, 3);
assert.deepEqual(entries.map((entry) => entry.title), ['First Index', 'Second Index', 'Last Index']);
assert.deepEqual(entries.map((entry) => Math.round(entry.start)), [0, 91, 185]);
assert.deepEqual(entries.map((entry) => entry.end == null ? null : Math.round(entry.end)), [91, 185, null]);
assert.equal(entries[1].artist, 'Guest Singer');
assert.equal(entries[0].albumArtist, 'The Archive Band');
assert.equal(entries[0].genre, 'Post-Punk');
assert.equal(entries[0].year, 1981);
assert.deepEqual(cueAudioPaths(entries), [albumPath]);

const baseTrack = {
  id: 42,
  path: albumPath,
  title: 'One File Album',
  artist: 'The Archive Band',
  album: 'One File Album',
  albumArtist: 'The Archive Band',
  trackNo: null,
  discNo: null,
  year: 1981,
  genre: 'Post-Punk',
  duration: 240,
  bitrate: 1000,
  sampleRate: 44100,
  size: 1234,
  mtime: Date.now(),
  hasArt: 0,
  loved: 0,
  rating: 0,
  avoidAutoPlay: 0,
  playCount: 9,
  lastPlayed: Date.now(),
  skipCount: 1,
  lastSkipped: Date.now(),
  bpm: null,
  key: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
};
const tracks = cueEntriesToTracks(entries, [baseTrack]);
assert.equal(tracks.length, 3);
assert.ok(tracks.every((track) => track.id < 0), 'CUE tracks should use synthetic negative ids');
assert.deepEqual(tracks.map((track) => track.trackNo), [1, 2, 3]);
assert.deepEqual(tracks.map((track) => Math.round(track.duration ?? 0)), [91, 94, 55]);
assert.deepEqual(tracks.map((track) => Math.round(track.cueStart ?? 0)), [0, 91, 185]);
assert.deepEqual(tracks.map((track) => track.cueEnd == null ? null : Math.round(track.cueEnd)), [91, 185, 240]);
assert.equal(tracks[1].artist, 'Guest Singer');
assert.equal(tracks[0].playCount, 0, 'synthetic CUE tracks should not inherit library play counts');

const [typesSource, mainSource, storeSource, engineSource, packageSource, gateSource, readmeSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /cueStart/, 'Track type should expose CUE segment start');
assert.match(typesSource, /cueEnd/, 'Track type should expose CUE segment end');
assert.match(mainSource, /\.cue/, 'open-file routing should accept CUE sheets');
assert.match(mainSource, /parseCueSheet/, 'main process should parse CUE sheets');
assert.match(mainSource, /cueEntriesToTracks/, 'main process should convert CUE entries to playable tracks');
assert.match(storeSource, /cueRelativeTime/, 'player store should display segment-relative CUE time');
assert.match(storeSource, /cueEndKey/, 'player store should auto-advance at CUE segment boundaries');
assert.match(storeSource, /playEngineTrack/, 'player store should play CUE tracks through segment-aware helper');
assert.match(engineSource, /startAt = 0/, 'audio engine should accept a start offset');
assert.match(engineSource, /applyStartPosition/, 'audio engine should seek to CUE segment starts after metadata');
assert.match(packageSource, /smoke:cue/, 'package scripts should expose CUE smoke');
assert.match(gateSource, /smoke:cue/, 'release gate should run CUE smoke');
assert.match(readmeSource, /CUE sheet/i, 'README should document CUE support');

console.log(JSON.stringify({
  ok: true,
  cuePath,
  entries: entries.length,
  tracks: tracks.map((track) => ({
    title: track.title,
    start: track.cueStart,
    end: track.cueEnd,
    duration: track.duration,
  })),
}, null, 2));
