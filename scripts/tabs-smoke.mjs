import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const tabs = await import('../dist-electron/electron/guitar-tabs.js');
const { LibraryStore } = await import('../dist-electron/electron/library.js');

const searchHtml = `
<html><script>
window.UGAPP = { store: { page: { data: { results: [
  {
    "song_name": "Creep",
    "artist_name": "Radiohead",
    "type": "Chords",
    "rating": 4.8,
    "votes": 18522,
    "tab_url": "https://tabs.ultimate-guitar.com/tab/radiohead/creep-chords-4169"
  },
  {
    "song_name": "Creep",
    "artist_name": "Stone Temple Pilots",
    "type": "Tab",
    "rating": 4.1,
    "votes": 900,
    "tab_url": "https://tabs.ultimate-guitar.com/tab/stone-temple-pilots/creep-tabs-1234"
  }
] } } } };
</script></html>`;

const results = tabs.parseUltimateGuitarSearchHtml(searchHtml);
assert.equal(results.length, 2);
assert.equal(results[0].title, 'Creep');
assert.equal(results[0].artist, 'Radiohead');
assert.equal(results[0].kind, 'Chords');
assert.equal(results[0].url, 'https://tabs.ultimate-guitar.com/tab/radiohead/creep-chords-4169');
assert.equal(results[0].rating, 4.8);
assert.equal(results[0].votes, 18522);

const tabHtml = `
<html><script id="__NEXT_DATA__" type="application/json">
{
  "props": {
    "pageProps": {
      "data": {
        "tab": {
          "song_name": "Creep",
          "artist_name": "Radiohead",
          "type": "Chords",
          "rating": 4.8,
          "votes": 18522,
          "tonality_name": "G",
          "content": "[ch]G[/ch] [ch]B[/ch] [ch]C[/ch] [ch]Cm[/ch]\\nWhen you were here before\\n"
        }
      }
    }
  }
}
</script></html>`;

const parsed = tabs.parseUltimateGuitarTabHtml(
  tabHtml,
  'https://tabs.ultimate-guitar.com/tab/radiohead/creep-chords-4169',
);
assert.equal(parsed.title, 'Creep');
assert.equal(parsed.artist, 'Radiohead');
assert.equal(parsed.key, 'G');
assert.equal(parsed.lines.length, 2);
assert.equal(parsed.lines[0].type, 'chords');
assert.equal(parsed.lines[0].text, 'G B C Cm');
assert.equal(parsed.lines[1].type, 'lyrics');

const structuredTabHtml = `
<html><script id="__NEXT_DATA__" type="application/json">
{
  "props": {
    "pageProps": {
      "data": {
        "tab_view": {
          "type": "Chords",
          "author": { "username": "newamp-fixture" },
          "meta": { "tonality": "D" },
          "content": {
            "lines": [
              { "type": "chords", "text": "D A Bm G" },
              { "type": "lyrics", "text": "Hello from structured Next data" }
            ]
          }
        },
        "song": {
          "name": "Everlong",
          "artist_name": "Foo Fighters"
        }
      }
    }
  }
}
</script></html>`;

const structured = tabs.parseUltimateGuitarTabHtml(
  structuredTabHtml,
  'https://tabs.ultimate-guitar.com/tab/foo-fighters/everlong-chords-827983',
);
assert.equal(structured.title, 'Everlong');
assert.equal(structured.artist, 'Foo Fighters');
assert.equal(structured.author, 'newamp-fixture');
assert.equal(structured.key, 'D');
assert.equal(structured.lines[0].type, 'chords');
assert.equal(structured.lines[0].text, 'D A Bm G');

const spanPreHtml = `
<html><pre>
<span data-name="Em"></span> <span data-name="C"></span> <span data-name="G"></span> <span data-name="D"></span>
The rendered tab line
</pre></html>`;
const spanPreParsed = tabs.parseUltimateGuitarTabHtml(
  spanPreHtml,
  'https://tabs.ultimate-guitar.com/tab/test-artist/test-song-chords-1234567',
);
assert.equal(spanPreParsed.lines[0].type, 'chords');
assert.equal(spanPreParsed.lines[0].text, 'Em C G D');

const localTab = tabs.buildLocalGuitarTabDocument({
  artist: 'Newamp QA',
  title: 'Local Jam',
  content: '[Intro]\nG D Em C\nA locally pasted line\n',
  key: 'G',
});
assert.equal(localTab.source, 'local');
assert.match(localTab.url, /^newamp-local-tab:\/\//);
assert.equal(localTab.title, 'Local Jam');
assert.equal(localTab.artist, 'Newamp QA');
assert.equal(localTab.kind, 'Pasted Tab');
assert.equal(localTab.key, 'G');
assert.equal(localTab.lines[0].type, 'section');
assert.equal(localTab.lines[1].type, 'chords');
assert.equal(localTab.lines[2].type, 'lyrics');

const chordProTab = tabs.buildLocalGuitarTabDocument({
  artist: 'Fallback Artist',
  title: 'Fallback Title',
  content: '{title: Creep}\n{artist: Radiohead}\n{key: G}\n{start_of_chorus}\n[G]When [B]you were [C]here [Cm]before\n',
  kind: 'ChordPro',
});
assert.equal(chordProTab.title, 'Creep');
assert.equal(chordProTab.artist, 'Radiohead');
assert.equal(chordProTab.key, 'G');
assert.equal(chordProTab.lines[0].type, 'section');
assert.equal(chordProTab.lines[0].text, '[Chorus]');
assert.equal(chordProTab.lines[1].type, 'chords');
assert.equal(chordProTab.lines[1].text, 'G B C Cm');
assert.equal(chordProTab.lines[2].type, 'lyrics');
assert.equal(chordProTab.lines[2].text, 'When you were here before');

assert.equal(tabs.transposeChordLine('G B C Cm', 2), 'A C# D Dm');
assert.equal(
  tabs.buildUltimateGuitarSearchUrl({ artist: 'Radiohead', title: 'Creep' }).toString(),
  'https://www.ultimate-guitar.com/search.php?search_type=title&value=Radiohead+Creep',
);
const noisySearchValues = tabs
  .buildUltimateGuitarSearchCandidates({
    artist: 'Radiohead',
    title: 'Paranoid Android - Remastered 2020 (Live)',
    limit: 5,
  })
  .map((url) => url.searchParams.get('value'));
assert.equal(
  noisySearchValues[0],
  'Radiohead Paranoid Android - Remastered 2020 (Live)',
  'current-song tab search should try the exact library title first',
);
assert.ok(
  noisySearchValues.includes('Radiohead Paranoid Android'),
  'current-song tab search should retry with remaster/live descriptors stripped',
);
assert.ok(noisySearchValues.length <= 4, 'current-song tab search retries should stay bounded');
assert.deepEqual(tabs.buildUltimateGuitarTabUrlCandidates('https://tabs.ultimate-guitar.com/tab/radiohead/creep-chords-4169'), [
  'https://tabs.ultimate-guitar.com/tab/radiohead/creep-chords-4169',
  'https://www.ultimate-guitar.com/tab/radiohead/creep-chords-4169',
  'https://tabs.ultimate-guitar.com/tab/radiohead/creep-chords-4169?print=1',
  'https://www.ultimate-guitar.com/tab/radiohead/creep-chords-4169?print=1',
]);

const cacheRoot = resolve('tmp', 'tabs-cache-smoke');
await rm(cacheRoot, { recursive: true, force: true });
await mkdir(cacheRoot, { recursive: true });
const trackPath = join(cacheRoot, 'Radiohead - Creep.mp3');
await writeFile(trackPath, 'fixture audio placeholder', 'utf8');
await writeFile(
  join(cacheRoot, 'Radiohead - Creep.chopro'),
  '{title: Creep}\n{artist: Radiohead}\n{key: G}\n[G]Sidecar [B]fallback\n',
  'utf8',
);
const library = await LibraryStore.open(join(cacheRoot, 'library.db'));
library.upsertTracks([
  {
    path: trackPath,
    title: 'Creep',
    artist: 'Radiohead',
    album: 'Pablo Honey',
    albumArtist: 'Radiohead',
    trackNo: 2,
    discNo: 1,
    year: 1993,
    genre: 'Alternative',
    duration: 238,
    bitrate: 192000,
    sampleRate: 44100,
    bpm: null,
    key: 'G',
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1234,
    mtime: 1,
    art: null,
  },
]);
const track = library.getTracks({ search: 'artist:radiohead title:creep', limit: 1 })[0];
assert.ok(track, 'fixture track should be indexed');
const sidecarTab = await tabs.findLocalGuitarTabForTrack(track);
assert.ok(sidecarTab, 'track-adjacent ChordPro tab should be discovered');
assert.equal(sidecarTab.title, 'Creep');
assert.equal(sidecarTab.kind, 'Sidecar Tab');
assert.equal(sidecarTab.lines[0].text, 'G B');
const cached = library.saveCachedGuitarTab(track.id, parsed);
assert.equal(cached.trackId, track.id);
assert.equal(cached.document.title, 'Creep');
assert.equal(cached.document.lines[0].text, 'G B C Cm');
assert.equal(library.getCachedGuitarTabs(track.id).length, 1);
assert.equal(library.getCachedGuitarTabs(track.id)[0].document.url, parsed.url);
const cachedLocal = library.saveCachedGuitarTab(track.id, localTab);
assert.equal(cachedLocal.document.source, 'local');
assert.equal(cachedLocal.document.lines[1].text, 'G D Em C');
assert.equal(library.getCachedGuitarTabs(track.id).length, 2);
library.close();

const [companionSource, nowPlayingSource, typesSource, preloadSource, apiSource, mainSource] = await Promise.all([
  readFile(new URL('../src/components/GuitarTabCompanion.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
]);
assert.match(companionSource, /searchGuitarTabs/, 'GuitarTabCompanion must search current-song tabs');
assert.match(companionSource, /getGuitarTab/, 'GuitarTabCompanion must load selected tabs');
assert.match(companionSource, /getCachedGuitarTabs/, 'GuitarTabCompanion must load cached tabs');
assert.match(companionSource, /saveCachedGuitarTab/, 'GuitarTabCompanion must save opened tabs');
assert.match(companionSource, /saveLocalGuitarTab/, 'GuitarTabCompanion must save pasted local tabs');
assert.match(companionSource, /findLocalGuitarTab/, 'GuitarTabCompanion must auto-discover local sidecar tabs');
assert.match(companionSource, /manualText/, 'GuitarTabCompanion must keep pasted tab text');
assert.match(companionSource, /ChordPro/, 'GuitarTabCompanion should tell users pasted ChordPro is supported');
assert.match(companionSource, /openGuitarTabWindow/, 'GuitarTabCompanion must open true native tab windows');
assert.match(companionSource, /Window/, 'GuitarTabCompanion should expose a window pop-out action');
assert.match(companionSource, /Auto-scroll/, 'GuitarTabCompanion must include play-along autoscroll');
assert.match(typesSource, /openGuitarTabWindow/, 'shared API should expose native guitar tab windows');
assert.match(typesSource, /saveLocalGuitarTab/, 'shared API should expose local tab creation');
assert.match(typesSource, /findLocalGuitarTab/, 'shared API should expose local sidecar tab discovery');
assert.match(preloadSource, /tabs:window:open/, 'preload should expose native guitar tab window IPC');
assert.match(preloadSource, /tabs:local:save/, 'preload should expose local tab save IPC');
assert.match(preloadSource, /tabs:local:find/, 'preload should expose local sidecar tab discovery IPC');
assert.match(apiSource, /openGuitarTabWindow/, 'browser-safe API should include native tab window fallback');
assert.match(apiSource, /saveLocalGuitarTab/, 'browser-safe API should include local tab fallback');
assert.match(apiSource, /findLocalGuitarTab/, 'browser-safe API should include local sidecar fallback');
assert.match(mainSource, /openGuitarTabWindow/, 'main process should create native guitar tab windows');
assert.match(mainSource, /tabs:local:save/, 'main process should save pasted local tabs');
assert.match(mainSource, /tabs:local:find/, 'main process should discover sidecar local tabs');
assert.match(mainSource, /Newamp Native Guitar Tab Window/, 'native window HTML should be branded as a Newamp tab window');
assert.doesNotMatch(nowPlayingSource, /GuitarTabCompanion/, 'Now Playing should not mount guitar tabs in the primary player surface');

console.log(
  JSON.stringify(
    {
      ok: true,
      results: results.length,
      lines: parsed.lines.length,
      transposed: tabs.transposeChordLine('G B C Cm', 2),
    },
    null,
    2,
  ),
);
