// A first run used to seed the library with C:/Users/Public/Music when no
// other folder was found. That folder exists on every Windows install and
// almost nobody keeps music in it, so the tour's "scan your library" button
// scanned an empty system folder and reported nothing. Now:
//  - the first run seeds the same folders the empty library screen suggests,
//    and never the Public one;
//  - a profile that an earlier build seeded that way (the Public folder as the
//    only root, no tracks ever scanned) starts the choice over;
//  - Home shows the shared empty-library screen, which names the folder it
//    scanned when it finds nothing;
//  - the folder picker opens on the library or the Music folder, not a
//    hard-coded drive letter.
// Run: node scripts/first-launch-roots-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const read = (path) => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');

await build({
  entryPoints: [resolve('electron/music-folders.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent',
  outfile: resolve('tmp/first-launch-roots-bundle.mjs'),
});
const { defaultMusicScanRoots, isSeededPublicMusicRoot, suggestMusicFolders } = await import(
  pathToFileURL(resolve('tmp/first-launch-roots-bundle.mjs')).href
);

// ---- what a stock Windows profile gets ----
{
  const exists = (path) => ['C:/Users/tester/Music', 'C:/Users/Public/Music', 'C:/Music'].includes(path);
  const options = { platform: 'win32', homeDir: 'C:/Users/tester', env: {}, exists };
  assert.deepEqual(suggestMusicFolders(options).map((s) => s.path), ['C:/Users/tester/Music'], 'the profile Music folder, not the Public one');
  assert.deepEqual(defaultMusicScanRoots({ ...options, fallbackMusicPath: 'C:/Users/tester/Music' }), ['C:/Users/tester/Music']);
}

// ---- a profile with only the Public folder gets nothing, not the Public folder ----
{
  const exists = (path) => path === 'C:/Users/Public/Music' || path === 'C:/Music';
  const roots = defaultMusicScanRoots({ platform: 'win32', homeDir: 'C:/Users/tester', env: {}, exists, fallbackMusicPath: 'C:/Users/tester/Music' });
  assert.deepEqual(roots, [], 'nothing found means an empty list, which shows the empty-library screen');
}

// ---- a relocated Music folder (OneDrive known-folder move) is still found ----
{
  const exists = (path) => path === 'D:/Moved/Music';
  const roots = defaultMusicScanRoots({
    platform: 'win32', homeDir: 'C:/Users/tester', env: {}, exists, fallbackMusicPath: 'D:/Moved/Music',
  });
  assert.deepEqual(roots, ['D:/Moved/Music'], 'the OS-reported Music folder is the fallback');
}

// ---- the seeded-root migration ----
{
  assert.equal(isSeededPublicMusicRoot(['C:/Users/Public/Music'], 0, {}), true, 'the seeded profile');
  assert.equal(isSeededPublicMusicRoot(['C:\\Users\\Public\\Music\\'], 0, {}), true, 'either slash, trailing separator');
  assert.equal(isSeededPublicMusicRoot(['c:/users/public/music'], 0, {}), true, 'any case');
  assert.equal(isSeededPublicMusicRoot(['D:/Shared/Music'], 0, { PUBLIC: 'D:\\Shared' }), true, 'where %PUBLIC% points');
  assert.equal(isSeededPublicMusicRoot(['C:/Users/Public/Music'], 12, {}), false, 'a library that has tracks is kept');
  assert.equal(isSeededPublicMusicRoot(['C:/Users/Public/Music'], -1, {}), false, 'an unreadable library is not treated as empty');
  assert.equal(isSeededPublicMusicRoot(['C:/Users/Public/Music', 'K:/music'], 0, {}), false, 'a second root means the user added one');
  assert.equal(isSeededPublicMusicRoot(['K:/music'], 0, {}), false, 'another folder is never dropped');
  assert.equal(isSeededPublicMusicRoot([], 0, {}), false);
}

// ---- main.ts ----
{
  const main = read('electron/main.ts');
  const bootstrap = main.slice(main.indexOf('async function bootstrap(): Promise<void> {'));
  const seed = bootstrap.slice(0, bootstrap.indexOf('registerAudioProtocol();'));
  assert.match(seed, /defaultMusicScanRoots\(\{ fallbackMusicPath: app\.getPath\('music'\) \}\)/, 'the first run seeds the suggested folders');
  assert.doesNotMatch(seed, /Users\/Public\/Music['"]/, 'no hard-coded Public folder');
  assert.doesNotMatch(seed, /'K:\/music'/, 'no hard-coded drive');
  assert.match(
    seed,
    /isSeededPublicMusicRoot\(settings\.get\(\)\.libraryRoots, trackCount\)\) \{\s*settings\.set\(\{ libraryRoots: defaultMusicScanRoots/,
    'a profile an earlier build seeded starts over',
  );
  assert.ok(
    seed.indexOf('LibraryStore.open(') < seed.indexOf('isSeededPublicMusicRoot('),
    'the migration needs the library open to know it is empty',
  );

  const pick = main.match(/ipcMain\.handle\('os:pick-folder'[\s\S]*?\n  \}\);\n/)?.[0] ?? '';
  assert.match(pick, /defaultPath: settings\.get\(\)\.libraryRoots\[0\] \?\? app\.getPath\('music'\),/, 'the picker opens on the library or the Music folder');
  assert.doesNotMatch(pick, /K:/, 'no drive letter');
  assert.doesNotMatch(main, /defaultPath: 'K:/);
}

// ---- Home uses the shared empty-library screen ----
{
  const home = read('src/components/views/HomeView.tsx');
  assert.match(home, /import \{ EmptyLibrary \} from '\.\/EmptyLibrary';/);
  assert.match(home, /data\.stats\.tracks === 0 \? \(\n[\s\S]*?<EmptyLibrary \/>/, 'an empty library on Home shows it');
  assert.doesNotMatch(home, /SCAN DEFAULT LIBRARY/, 'the bare scan button is gone');
  assert.doesNotMatch(home, /api\.scanLibrary\(\)/, 'Home no longer starts a blind scan');
}

console.log('PASS first launch roots: no Public Music seed, a seeded profile starts over, Home shows the shared empty screen, no hard-coded drive');
