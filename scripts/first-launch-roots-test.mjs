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
import vm from 'node:vm';
import { build, transform } from 'esbuild';

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

  // The seed itself, run: a first run gets the Music folder, and a list the
  // user emptied by removing folders stays empty.
  const block = seed.slice(seed.indexOf('  const current = settings.get();'), seed.indexOf('  library = await LibraryStore.open('));
  const { code } = await transform(block, { loader: 'ts', target: 'es2022' });
  for (const platform of ['darwin', 'win32']) {
    const run = (stored) => {
      let roots = stored.libraryRoots;
      vm.runInNewContext(code, {
        smokeMode: false,
        process: { platform },
        settings: { get: () => ({ ...stored }), isSuppressed: () => false, set: (patch) => { roots = patch.libraryRoots; } },
        app: { getPath: () => '/Users/tester/Music' },
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => true }),
        safeListMacVolumesMusic: () => [],
        defaultMusicScanRoots: () => ['/Users/tester/Music'],
      });
      // Built in the vm's realm; compared as plain data.
      return JSON.parse(JSON.stringify(roots));
    };
    assert.deepEqual(run({ libraryRoots: [], libraryRootsChosen: false }), ['/Users/tester/Music'], `${platform}: a first run is seeded`);
    assert.deepEqual(run({ libraryRoots: [] }), ['/Users/tester/Music'], `${platform}: so is a profile from before the flag`);
    assert.deepEqual(run({ libraryRoots: [], libraryRootsChosen: true }), [], `${platform}: a list emptied by removing folders stays empty`);
    assert.deepEqual(run({ libraryRoots: ['/x'], libraryRootsChosen: false }), ['/x'], `${platform}: a configured list is left alone`);
  }

  // The Public Music migration, run: an old seeded profile starts over, and a
  // list the user cut down to that folder by removing the others does not.
  const migration = seed.slice(seed.indexOf('  // Earlier builds seeded a first run'), seed.indexOf('  scanner = createScannerService(library);'));
  const migrated = await transform(migration, { loader: 'ts', target: 'es2022' });
  const migrate = (stored) => {
    let roots = stored.libraryRoots;
    vm.runInNewContext(migrated.code, {
      smokeMode: false,
      settings: { get: () => ({ ...stored, libraryRoots: roots }), isSuppressed: () => false, set: (patch) => { roots = patch.libraryRoots; } },
      library: { getTrackCount: () => 0 },
      app: { getPath: () => 'C:/Users/tester/Music' },
      isSeededPublicMusicRoot: (list, count) => isSeededPublicMusicRoot(list, count, {}),
      defaultMusicScanRoots: () => ['K:/music'],
    });
    return JSON.parse(JSON.stringify(roots));
  };
  assert.deepEqual(migrate({ libraryRoots: ['C:/Users/Public/Music'] }), ['K:/music'], 'a profile from before the flag starts over');
  assert.deepEqual(migrate({ libraryRoots: ['C:/Users/Public/Music'], libraryRootsChosen: false }), ['K:/music'], 'so does one that never removed a folder');
  assert.deepEqual(
    migrate({ libraryRoots: ['C:/Users/Public/Music'], libraryRootsChosen: true }),
    ['C:/Users/Public/Music'],
    'removing the other folders is not undone at the next launch',
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

console.log('PASS first launch roots: no Public Music seed, a seeded profile starts over, a removed last folder is not re-seeded, nor is a list cut down to Public Music, Home shows the shared empty screen, no hard-coded drive');
