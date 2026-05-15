import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'power-search-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  {
    name: '01-paranoid-android.flac',
    title: 'Paranoid Android',
    artist: 'Radiohead',
    album: 'OK Computer',
    year: 1997,
    genre: 'Alternative Rock',
    art: true,
    loved: true,
  },
  {
    name: '02-weird-fishes.mp3',
    title: 'Weird Fishes/Arpeggi',
    artist: 'Radiohead',
    album: 'In Rainbows',
    year: 2007,
    genre: 'Art Rock',
    art: true,
    loved: false,
  },
  {
    name: '03-teen-age-riot.wma',
    title: 'Teen Age Riot',
    artist: 'Sonic Youth',
    album: 'Daydream Nation',
    year: 1988,
    genre: 'Indie Rock',
    art: false,
    loved: false,
  },
  {
    name: '04-mystery-file.m4a',
    title: 'Mystery File',
    artist: 'Unknown Artist',
    album: '',
    year: null,
    genre: null,
    art: false,
    loved: false,
  },
];

for (const fixture of fixtures) await writeFile(join(musicRoot, fixture.name), '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks(fixtures.map((fixture, index) => ({
  path: join(musicRoot, fixture.name),
  title: fixture.title,
  artist: fixture.artist,
  album: fixture.album,
  albumArtist: fixture.artist,
  trackNo: index + 1,
  discNo: null,
  year: fixture.year,
  genre: fixture.genre,
  duration: 200 + index,
  bitrate: null,
  sampleRate: null,
  bpm: null,
  key: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: Date.now() + index,
  art: fixture.art ? { mime: 'image/jpeg', data: Buffer.from(`art-${fixture.name}`) } : null,
})));

const paranoid = library.getTracks({ search: 'title:"Paranoid Android"', limit: 10 })[0];
assert.ok(paranoid, 'Paranoid Android should be queryable by title');
library.toggleLove(paranoid.id);

assertTitles('artist:radiohead album:"in rainbows"', ['Weird Fishes/Arpeggi']);
assertTitles('artist:radiohead fishes', ['Weird Fishes/Arpeggi']);
assertTitles('year:1997', ['Paranoid Android']);
assertTitles('year:1980-1990 genre:rock', ['Teen Age Riot']);
assertTitles('format:wma', ['Teen Age Riot']);
assertTitles('missing:art', ['Teen Age Riot', 'Mystery File']);
assertTitles('missing:artist', ['Mystery File']);
assertTitles('has:art loved:true', ['Paranoid Android']);
assertTitles('title:riot artist:"sonic youth"', ['Teen Age Riot']);

const smartRule = library.saveSmartPlaylistRule({
  name: 'Power Search Smart Rule',
  mood: 'focus',
  count: 10,
  searchQuery: 'artist:radiohead has:art',
});
assert.equal(smartRule.searchQuery, 'artist:radiohead has:art');
assert.deepEqual(
  library.runSmartPlaylistRule(smartRule.id).map((track) => track.title).sort(),
  ['Paranoid Android', 'Weird Fishes/Arpeggi'],
  'saved smart rules should reuse Library power-search grammar',
);
library.close();

const [librarySource, libraryViewSource, packageJson] = await Promise.all([
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(librarySource, /parseTrackSearchQuery/, 'library should parse power-search tokens explicitly');
assert.match(libraryViewSource, /artist:radiohead/, 'Library search input should expose power-search examples');
assert.match(libraryViewSource, /saveSmartPlaylistRule/, 'Library should save current searches as smart rules');
assert.match(libraryViewSource, /SAVE SEARCH AS SMART RULE/, 'Library should expose a dynamic smart-rule save action');
assert.match(libraryViewSource, /Smart rule name/, 'Library should let users name search-backed smart rules');
assert.match(packageJson, /smoke:search/, 'package scripts should expose the search smoke');

console.log(JSON.stringify({
  ok: true,
  examples: [
    'artist:radiohead album:"in rainbows"',
    'year:1980-1990 genre:rock',
    'missing:art format:wma',
  ],
}, null, 2));

function assertTitles(search, expected) {
  const titles = library
    .getTracks({ search, sort: 'artist', limit: 20 })
    .map((track) => track.title);
  assert.deepEqual(titles, expected, search);
}
