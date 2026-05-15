import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'bookmarks-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const filePath = join(musicRoot, '01-long-set.mp3');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });
await writeFile(filePath, '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks([
  {
    path: filePath,
    title: 'Long Set',
    artist: 'Bookmark Artist',
    album: 'Markers',
    albumArtist: 'Bookmark Artist',
    trackNo: 1,
    discNo: null,
    year: 2026,
    genre: 'Live',
    duration: 3600,
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

const [track] = library.getTracks({ sort: 'album', limit: 10 });
assert.ok(track, 'fixture track should exist');

const intro = library.saveTrackBookmark({
  trackId: track.id,
  position: 12.345,
  label: 'Intro riff',
});
const chorus = library.saveTrackBookmark({
  trackId: track.id,
  position: 245.8,
  label: 'Big chorus',
});

assert.equal(intro.position, 12.35, 'bookmark positions should be rounded for stable display');
assert.equal(chorus.label, 'Big chorus');
assert.deepEqual(
  library.getTrackBookmarks(track.id).map((bookmark) => bookmark.label),
  ['Intro riff', 'Big chorus'],
);

const updated = library.saveTrackBookmark({
  ...intro,
  position: 18.2,
  label: 'Better intro',
});
assert.equal(updated.id, intro.id);
assert.deepEqual(
  library.getTrackBookmarks(track.id).map((bookmark) => `${bookmark.label}@${bookmark.position}`),
  ['Better intro@18.2', 'Big chorus@245.8'],
);

library.deleteTrackBookmark(chorus.id);
assert.deepEqual(library.getTrackBookmarks(track.id).map((bookmark) => bookmark.label), ['Better intro']);
library.close();

const [sharedTypes, mainSource, preloadSource, apiSource, nowPlayingSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /TrackBookmark/, 'shared API should expose track bookmarks');
assert.match(mainSource, /bookmark:list/, 'main process should register bookmark list IPC');
assert.match(preloadSource, /getTrackBookmarks/, 'preload should expose getTrackBookmarks');
assert.match(apiSource, /saveTrackBookmark/, 'renderer API should expose bookmark save');
assert.match(nowPlayingSource, /Track Bookmarks/, 'Now Playing should render a bookmark panel');
assert.match(nowPlayingSource, /saveTrackBookmark/, 'Now Playing should save bookmarks at current time');
assert.match(nowPlayingSource, /deleteTrackBookmark/, 'Now Playing should delete bookmarks');
assert.match(nowPlayingSource, /seek\(bookmark\.position\)/, 'Now Playing should jump to a bookmark');

console.log(JSON.stringify({
  ok: true,
  bookmarks: library.getTrackBookmarks ? 'verified before close' : 'missing',
  saved: updated,
}, null, 2));
