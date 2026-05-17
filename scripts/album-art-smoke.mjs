import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { fetchAlbumArtImage, searchAlbumArt } from '../dist-electron/electron/musicbrainz.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'album-art-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');
const packageMeta = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedNewampUserAgent = new RegExp(`NewAmp/${escapeRegExp(String(packageMeta.version))}`);

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const trackPath = join(musicRoot, '01 - Everything In Its Right Place.mp3');
await writeFile(trackPath, '');

const requests = [];
const imageBytes = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0,
  ...Buffer.from('Newamp album art smoke fixture'.padEnd(512, '.')),
  0xff, 0xd9,
]);
const candidates = await searchAlbumArt(
  { album: 'Kid A', albumArtist: 'Radiohead' },
  {
    now: () => 1778859900000,
    sleep: async () => undefined,
    lastRequestAt: () => 0,
    setLastRequestAt: () => undefined,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), headers: init?.headers ?? {} });
      if (String(url).startsWith('https://musicbrainz.org/ws/2/release-group')) {
        return jsonResponse({
          'release-groups': [
            {
              id: 'b1392450-e666-3926-a536-22c65f834433',
              score: 100,
              title: 'Kid A',
              'first-release-date': '2000-10-02',
              'primary-type': 'Album',
              'artist-credit': [{ name: 'Radiohead' }],
            },
          ],
        });
      }
      if (String(url).startsWith('https://coverartarchive.org/release-group/')) {
        return jsonResponse({
          images: [
            {
              image: 'https://coverartarchive.org/release/fake/full.jpg',
              front: true,
              approved: true,
              types: ['Front'],
              thumbnails: {
                250: 'https://coverartarchive.org/release/fake/250.jpg',
                500: 'https://coverartarchive.org/release/fake/500.jpg',
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  },
);

assert.equal(candidates.length, 1, 'album art lookup should return a cover candidate');
assert.equal(candidates[0].source, 'cover-art-archive');
assert.equal(candidates[0].releaseGroupTitle, 'Kid A');
assert.equal(candidates[0].artist, 'Radiohead');
assert.equal(candidates[0].thumbnailUrl, 'https://coverartarchive.org/release/fake/500.jpg');
assert.match(requests[0].url, /release-group/);
const musicBrainzUrl = new URL(requests[0].url);
const musicBrainzQuery = musicBrainzUrl.searchParams.get('query') ?? '';
assert.equal(musicBrainzUrl.pathname, '/ws/2/release-group');
assert.match(musicBrainzQuery, /releasegroup:"Kid A"/);
assert.match(musicBrainzQuery, /artist:"Radiohead"/);
assert.match(musicBrainzQuery, /primarytype:album/);
assert.match(String(requests[0].headers['User-Agent']), expectedNewampUserAgent);

const image = await fetchAlbumArtImage(candidates[0], {
  fetchImpl: async (url) => {
    assert.equal(String(url), 'https://coverartarchive.org/release/fake/500.jpg');
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      json: async () => ({}),
      arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
    };
  },
});
assert.equal(image.mime, 'image/jpeg');
assert.equal(image.data.byteLength, imageBytes.byteLength);
await assert.rejects(
  () => fetchAlbumArtImage({
    ...candidates[0],
    thumbnailUrl: 'http://127.0.0.1/internal-cover.jpg',
    imageUrl: 'http://127.0.0.1/internal-cover-full.jpg',
  }, {
    fetchImpl: async () => {
      throw new Error('unsupported cover art URL should not be fetched');
    },
  }),
  /unsupported image URL/,
);
await assert.rejects(
  () => fetchAlbumArtImage(candidates[0], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
      json: async () => ({}),
      arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
    }),
  }),
  /instead of an image/,
);

const library = await LibraryStore.open(dbPath);
library.upsertTracks([
  {
    path: trackPath,
    title: 'Everything In Its Right Place',
    artist: 'Radiohead',
    album: 'Kid A',
    albumArtist: 'Radiohead',
    trackNo: 1,
    discNo: 1,
    year: 2000,
    genre: 'Alternative',
    duration: 251,
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

const before = library.getAlbums()[0];
assert.equal(before.artFromTrackId, null, 'fixture album should start without art');
const applied = library.applyAlbumArtToAlbum('Kid A', 'Radiohead', {
  mime: image.mime,
  data: image.data,
}, image.sourceUrl);
assert.ok(applied, 'album art should apply to matching album tracks');
assert.equal(applied.appliedTrackCount, 1);
assert.equal(library.getAlbums()[0].artFromTrackId, applied.artFromTrackId);
assert.equal(library.getArt(applied.artFromTrackId)?.data.byteLength, imageBytes.byteLength);
library.close();

const [typesSource, mainSource, preloadSource, apiSource, albumsViewSource, packageSource, gateSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/AlbumsView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /AlbumArtLookupResult/, 'shared types should expose album art lookup results');
assert.match(mainSource, /album-art:lookup/, 'main process should register album art lookup IPC');
assert.match(mainSource, /album-art:apply/, 'main process should register album art apply IPC');
assert.match(preloadSource, /lookupAlbumArt/, 'preload should expose album art lookup');
assert.match(apiSource, /applyAlbumArt/, 'renderer API should expose album art apply');
assert.doesNotMatch(albumsViewSource, /FIND COVER|APPLY COVER|REVIEW COVER/, 'Albums view should not expose cover review buttons in album chrome');
assert.match(albumsViewSource, /MISSING ART/, 'Albums view should expose a missing-art review lane');
assert.match(albumsViewSource, /showMissingArtOnly/, 'Albums view should filter to albums missing cover art');
assert.match(albumsViewSource, /data-newamp-albums-scroll/, 'Albums view should own a restorable scroll container');
assert.match(albumsViewSource, /restoreAlbumScrollTop/, 'Albums view should return to prior scroll position after closing an album');
assert.match(packageSource, /"smoke:album-art"/, 'package.json should expose album art smoke');
assert.match(gateSource, /smoke:album-art/, 'release gate should include album art smoke');

console.log(JSON.stringify({
  ok: true,
  candidate: candidates[0],
  applied: {
    trackCount: applied.appliedTrackCount,
    bytes: applied.bytes,
    artFromTrackId: applied.artFromTrackId,
  },
}, null, 2));

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
