import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { findLocalLyricsForTrack } from '../dist-electron/electron/local-lyrics.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'local-lyrics-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const audioPath = join(musicRoot, 'The Artist - The Song.mp3');
const customAudioPath = join(musicRoot, 'The Artist - Saved Song.mp3');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });
await writeFile(audioPath, '', 'utf8');
await writeFile(customAudioPath, '', 'utf8');

const track = {
  id: 1,
  path: audioPath,
  title: 'The Song',
  artist: 'The Artist',
  album: 'Sidecars',
};

await writeFile(
  join(musicRoot, 'The Artist - The Song.lrc'),
  '[00:01.00]First synced line\n[00:04.50]Second synced line\n',
  'utf8',
);

const synced = await findLocalLyricsForTrack(track);
assert.ok(synced, 'same-folder LRC should be discovered');
assert.equal(synced.source, 'sidecar');
assert.equal(synced.syncedLyrics?.includes('Second synced line'), true);
assert.equal(synced.plainLyrics, null);
assert.equal(synced.path.endsWith('The Artist - The Song.lrc'), true);

await rm(join(musicRoot, 'The Artist - The Song.lrc'), { force: true });
await writeFile(
  join(musicRoot, 'The Artist - The Song.txt'),
  'First plain verse\nSecond plain verse\n',
  'utf8',
);

const plain = await findLocalLyricsForTrack(track);
assert.ok(plain, 'artist-title TXT sidecar should be discovered');
assert.equal(plain.syncedLyrics, null);
assert.equal(plain.plainLyrics?.includes('Second plain verse'), true);

const missing = await findLocalLyricsForTrack({ ...track, path: join(musicRoot, 'missing.mp3') });
assert.equal(missing, null, 'missing audio path should not produce arbitrary lyrics');

const library = await LibraryStore.open(dbPath);
library.upsertTracks([
  {
    path: customAudioPath,
    title: 'Saved Song',
    artist: 'The Artist',
    album: 'Custom Lyrics',
    albumArtist: 'The Artist',
    trackNo: 1,
    discNo: null,
    year: 2026,
    genre: 'Smoke',
    duration: 180,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 0,
    mtime: Date.now(),
    art: null,
  },
]);

const [customTrack] = library.getTracks({ search: 'Saved Song', limit: 1 });
assert.ok(customTrack, 'custom lyrics fixture track should exist');

const savedPlain = library.saveCustomLyrics({
  trackId: customTrack.id,
  plainLyrics: '\nSaved custom lyric one\nSaved custom lyric two\n',
});
assert.ok(savedPlain, 'custom plain lyrics should save');
assert.equal(savedPlain.source, 'custom');
assert.equal(savedPlain.path, `newamp:lyrics:custom:${customTrack.id}`);
assert.equal(savedPlain.plainLyrics, 'Saved custom lyric one\nSaved custom lyric two');
assert.equal(savedPlain.syncedLyrics, null);

const savedSynced = library.saveCustomLyrics({
  trackId: customTrack.id,
  syncedLyrics: '[00:01.00]Saved synced line\n[00:03.00]Second saved line\n',
});
assert.ok(savedSynced, 'custom synced lyrics should replace plain lyrics');
assert.equal(savedSynced.source, 'custom');
assert.equal(savedSynced.plainLyrics, null);
assert.equal(savedSynced.syncedLyrics?.includes('Second saved line'), true);
assert.equal(library.getCustomLyrics(customTrack.id)?.source, 'custom');

library.close();
const reloaded = await LibraryStore.open(dbPath);
assert.equal(
  reloaded.getCustomLyrics(customTrack.id)?.syncedLyrics?.includes('Saved synced line'),
  true,
  'custom lyrics should persist in the library database',
);
reloaded.clearCustomLyrics(customTrack.id);
assert.equal(reloaded.getCustomLyrics(customTrack.id), null, 'custom lyrics should clear cleanly');
reloaded.close();

const sourceChecks = await Promise.all([
  readText('../shared/types.ts'),
  readText('../electron/main.ts'),
  readText('../electron/preload.ts'),
  readText('../src/lib/api.ts'),
  readText('../src/components/views/NowPlayingView.tsx'),
  readText('../package.json'),
]);

assert.match(sourceChecks[0], /LocalLyricsResult/, 'shared API types should expose local lyrics result');
assert.match(sourceChecks[1], /lyrics:local/, 'main process should register local lyrics IPC');
assert.match(sourceChecks[1], /lyrics:custom:save/, 'main process should register custom lyrics save IPC');
assert.match(sourceChecks[2], /getLocalLyrics/, 'preload should expose local lyrics lookup');
assert.match(sourceChecks[2], /saveCustomLyrics/, 'preload should expose custom lyrics save');
assert.match(sourceChecks[3], /getLocalLyrics/, 'browser-safe API should include local lyrics fallback');
assert.match(sourceChecks[3], /saveCustomLyrics/, 'browser-safe API should include custom lyrics fallback');
assert.match(sourceChecks[4], /lyricSource/, 'Now Playing should track local vs network lyric source');
assert.match(sourceChecks[4], /getLocalLyrics/, 'Now Playing should ask for local lyrics before LRCLIB');
assert.match(sourceChecks[4], /data-newamp-lyrics-editor/, 'Now Playing should expose a custom lyrics editor');
assert.match(sourceChecks[4], /SAVE \/ EDIT LYRICS/, 'Now Playing should offer saved lyrics entry');
assert.match(sourceChecks[4], /data-newamp-lyrics-size-slider/, 'lyrics panel should expose text resizing');
assert.match(sourceChecks[4], /data-newamp-karaoke-fullscreen/, 'karaoke mode should open a full-screen lyrics surface');
assert.match(sourceChecks[5], /smoke:local-lyrics/, 'package scripts should include local lyrics smoke');

console.log(JSON.stringify({
  ok: true,
  syncedPath: synced.path,
  plainPath: plain.path,
  customPath: savedSynced.path,
}, null, 2));

async function readText(relativePath) {
  return await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL(relativePath, import.meta.url), 'utf8'),
  );
}
