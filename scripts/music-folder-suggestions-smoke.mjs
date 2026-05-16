import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { suggestMusicFolders } = await import('../dist-electron/electron/music-folders.js');

function key(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const existing = new Set([
  'k:/music',
  'c:/users/tyler/music',
  'c:/users/tyler/onedrive/music',
].map(key));

const suggestions = suggestMusicFolders({
  homeDir: 'C:/Users/Tyler',
  env: {
    NEWAMP_REAL_LIBRARY_ROOT: 'K:/music',
    OneDrive: 'C:/Users/Tyler/OneDrive',
  },
  exists: (path) => existing.has(key(path)),
});

assert.deepEqual(
  suggestions.map((suggestion) => suggestion.path),
  ['K:/music', 'C:/Users/Tyler/Music', 'C:/Users/Tyler/OneDrive/Music'],
  'suggestions should prioritize the configured real library, then profile and OneDrive music folders',
);
assert.equal(new Set(suggestions.map((suggestion) => key(suggestion.path))).size, suggestions.length, 'suggestions should be unique');
assert.ok(suggestions.every((suggestion) => suggestion.label && suggestion.reason), 'suggestions should be user-readable');

const [packageSource, gateSource, typesSource, preloadSource, apiSource, mainSource, emptyLibrarySource, readmeSource] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/EmptyLibrary.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
]);

assert.match(packageSource, /smoke:music-folders/, 'package scripts should expose the music folder suggestions smoke');
assert.match(gateSource, /smoke:music-folders/, 'release gate should run the music folder suggestions smoke');
assert.match(typesSource, /MusicFolderSuggestion/, 'shared API types should expose music folder suggestions');
assert.match(typesSource, /getSuggestedMusicFolders/, 'shared API should include getSuggestedMusicFolders');
assert.match(preloadSource, /os:suggested-music-folders/, 'preload should expose suggested music folder IPC');
assert.match(apiSource, /getSuggestedMusicFolders/, 'browser-safe API should include suggested music folders');
assert.match(mainSource, /suggestMusicFolders/, 'main process should call the suggestion helper');
assert.match(emptyLibrarySource, /getSuggestedMusicFolders/, 'empty library onboarding should load detected folders');
assert.match(emptyLibrarySource, /data-music-folder-suggestion/, 'empty library onboarding should render one-click suggestion actions');
assert.match(readmeSource, /one-click music folder suggestions/i, 'README should document first-run folder suggestions');

console.log(JSON.stringify({ ok: true, suggestions }, null, 2));
