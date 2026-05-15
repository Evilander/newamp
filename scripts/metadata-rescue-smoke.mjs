import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { searchMusicBrainzMetadata } from '../dist-electron/electron/musicbrainz.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'metadata-rescue-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const packageMeta = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedNewampUserAgent = new RegExp(`Newamp/${escapeRegExp(String(packageMeta.version))}`);

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const barePath = join(musicRoot, '03 - Weird Fishes Arpeggi.mp3');
await writeFile(barePath, '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks([
  {
    path: barePath,
    title: 'Weird Fishes Arpeggi',
    artist: 'Unknown Artist',
    album: '',
    albumArtist: 'Unknown Artist',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: 318,
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

const [bareTrack] = library.getTracks({ limit: 5, sort: 'artist' });
assert.ok(bareTrack, 'fixture track should exist');

const requests = [];
const candidates = await searchMusicBrainzMetadata(bareTrack, {
  fetchImpl: async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers ?? {} });
    return jsonResponse({
      recordings: [
        {
          id: '0f4a9be2-146e-4f9d-9d01-51f3fded3813',
          score: 96,
          title: 'Weird Fishes/ Arpeggi',
          length: 318000,
          'artist-credit': [{ name: 'Radiohead' }],
          releases: [
            {
              id: 'ac2d3f91-a3f6-4fdb-8a65-5741f7755d74',
              title: 'In Rainbows',
              date: '2007-10-10',
              'artist-credit': [{ name: 'Radiohead' }],
            },
          ],
        },
      ],
    });
  },
  now: () => 1778805000000,
  sleep: async () => undefined,
  lastRequestAt: () => 0,
  setLastRequestAt: () => undefined,
});

assert.equal(candidates.length, 1, 'MusicBrainz search should return a candidate');
assert.equal(candidates[0].source, 'musicbrainz');
assert.equal(candidates[0].artist, 'Radiohead');
assert.equal(candidates[0].album, 'In Rainbows');
assert.equal(candidates[0].year, 2007);
assert.equal(candidates[0].duration, 318);
assert.ok(requests[0].url.startsWith('https://musicbrainz.org/ws/2/recording?'));
assert.match(requests[0].url, /fmt=json/);
assert.match(requests[0].url, /limit=5/);
assert.match(String(requests[0].headers['User-Agent']), expectedNewampUserAgent);
assert.doesNotMatch(decodeURIComponent(requests[0].url), /artistname:"Unknown Artist"/);

const patched = library.applyMetadataPatch(bareTrack.id, candidates[0]);
assert.ok(patched, 'metadata patch should return the updated track');
assert.equal(patched.artist, 'Radiohead');
assert.equal(patched.album, 'In Rainbows');
assert.equal(patched.albumArtist, 'Radiohead');
assert.equal(patched.year, 2007);
assert.equal(patched.duration, 318, 'local duration should be preserved when already known');

const manual = library.applyManualMetadataPatch(patched.id, {
  title: 'Weird Fishes',
  artist: 'Radiohead',
  album: 'In Rainbows',
  albumArtist: 'Radiohead',
  genre: 'Art Rock',
  year: 2007,
  trackNo: 3,
  discNo: 1,
});
assert.ok(manual, 'manual metadata patch should return the updated track');
assert.equal(manual.title, 'Weird Fishes');
assert.equal(manual.genre, 'Art Rock');
assert.equal(manual.trackNo, 3);
assert.equal(manual.discNo, 1);

const cleared = library.applyManualMetadataPatch(manual.id, {
  genre: '',
  year: null,
  trackNo: null,
  discNo: null,
});
assert.ok(cleared, 'manual metadata patch should support clearing optional fields');
assert.equal(cleared.genre, null);
assert.equal(cleared.year, null);
assert.equal(cleared.trackNo, null);
assert.equal(cleared.discNo, null);
library.close();

const [sharedTypes, mainSource, preloadSource, apiSource, libraryViewSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
]);

assert.match(sharedTypes, /MetadataLookupCandidate/, 'shared types should expose MusicBrainz candidates');
assert.match(sharedTypes, /TrackMetadataPatchInput/, 'shared types should expose manual metadata patch input');
assert.match(mainSource, /metadata:lookup/, 'main process should register metadata lookup IPC');
assert.match(mainSource, /metadata:edit/, 'main process should register manual metadata edit IPC');
assert.match(preloadSource, /lookupTrackMetadata/, 'preload should expose lookupTrackMetadata');
assert.match(preloadSource, /applyTrackMetadataEdit/, 'preload should expose manual metadata edits');
assert.match(apiSource, /applyTrackMetadataPatch/, 'renderer API should expose metadata patching');
assert.match(apiSource, /applyTrackMetadataEdit/, 'renderer API should expose manual metadata editing');
assert.match(libraryViewSource, /Metadata Rescue/, 'Library view should expose the metadata rescue UI');
assert.match(libraryViewSource, /Manual edit/, 'Library view should expose manual metadata editing');
assert.match(libraryViewSource, /applyManualMetadataEdit/, 'Library view should save manual metadata edits');
assert.match(libraryViewSource, /data-bulk-metadata-edit/, 'selected-track toolbar should expose bulk metadata editing');
assert.match(libraryViewSource, /applyBulkMetadataEdit/, 'selected-track toolbar should apply bulk metadata edits');
assert.match(libraryViewSource, /BULK TAG SELECTED/, 'selected-track toolbar should label the bulk metadata action');
assert.match(libraryViewSource, /applyTrackMetadataEdit\(track\.id, patch\)/, 'bulk metadata edits should reuse the existing metadata edit API');
assert.match(
  libraryViewSource,
  /applyMetadataCandidate[\s\S]+api\.getStats\(\)\.then\(setStats\)/,
  'applying a metadata patch should refresh Library stats without needing a rescan',
);

console.log(JSON.stringify({
  ok: true,
  request: requests[0].url,
  candidate: candidates[0],
  patched: {
    title: patched.title,
    artist: patched.artist,
    album: patched.album,
    year: patched.year,
  },
}, null, 2));

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
