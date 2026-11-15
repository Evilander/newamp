import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const slice = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} is in main.ts`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `${end} follows ${start}`);
  return source.slice(from, to);
};

// Folders added from the File menu survive a save from a stale folder list.
{
  const { code } = await transform(
    `${slice('const unseenMenuRoots', '// File > Add Folder to Library: the same steps')}\nglobalThis.api = { unseenMenuRoots, libraryRootsRead, keepUnseenMenuRoots };`,
    { loader: 'ts', target: 'es2022' },
  );
  let libraryRoots = ['/music', '/menu-added'];
  const context = {
    settings: { get: () => ({ libraryRoots }) },
    isPathInside: (path, folder) => path === folder || path.startsWith(`${folder}/`),
  };
  vm.runInNewContext(code, context);
  const { unseenMenuRoots, libraryRootsRead } = context.api;
  const keepUnseenMenuRoots = (patch) => {
    const out = context.api.keepUnseenMenuRoots(patch);
    return out && Array.isArray(out.libraryRoots) ? { ...out, libraryRoots: [...out.libraryRoots] } : out;
  };

  const stale = { libraryRoots: ['/music', '/other'] };
  assert.deepEqual(keepUnseenMenuRoots(stale), stale, 'nothing is added while the page has seen every folder');

  unseenMenuRoots.add('/menu-added');
  assert.deepEqual(keepUnseenMenuRoots(stale).libraryRoots, ['/music', '/other', '/menu-added'], 'a stale list keeps the menu-added folder');
  assert.deepEqual(keepUnseenMenuRoots({ libraryRoots: ['/music', '/menu-added'] }).libraryRoots, ['/music', '/menu-added'], 'a list that has it is left alone');
  libraryRoots = ['/music', '/menu-added', '/music/new'];
  unseenMenuRoots.add('/music/new');
  assert.deepEqual(keepUnseenMenuRoots({ libraryRoots: ['/music', '/menu-added'] }).libraryRoots, ['/music', '/menu-added'], 'a folder the new list covers is not added again');
  unseenMenuRoots.delete('/music/new');
  libraryRoots = ['/music', '/menu-added'];
  assert.deepEqual(keepUnseenMenuRoots({ volume: 0.5 }), { volume: 0.5 }, 'patches without a folder list pass through');
  assert.equal(keepUnseenMenuRoots(null), null);

  // The menu added /menu-added in place of two folders inside it; a list from
  // before that still names them.
  assert.deepEqual(
    keepUnseenMenuRoots({ libraryRoots: ['/music', '/menu-added/a', '/menu-added/b', '/other'] }).libraryRoots,
    ['/music', '/other', '/menu-added'],
    'the folders the menu folded into the new one are not listed beside it',
  );

  libraryRoots = ['/music'];
  assert.deepEqual(keepUnseenMenuRoots(stale), stale, 'a folder no longer in the settings is not brought back');
  libraryRoots = ['/music', '/menu-added'];

  libraryRootsRead();
  assert.deepEqual(keepUnseenMenuRoots(stale), stale, 'once the page has read the settings, removing the folder sticks');
}

// Reading the settings clears the guard; saving them does only when the save carries a folder list.
{
  const { code } = await transform(
    `${slice('const unseenMenuRoots', '// File > Add Folder to Library: the same steps')}\n${slice("ipcMain.handle('settings:get'", '// ---- Bit-Perfect Exclusive output')}\nglobalThis.api = { unseenMenuRoots };`,
    { loader: 'ts', target: 'es2022' },
  );
  const handlers = new Map();
  const saved = [];
  const context = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    settings: { get: () => ({ libraryRoots: ['/music', '/menu-added'], waveformSeekBar: true }), set: (patch) => saved.push(patch) },
    isPathInside: (path, folder) => path === folder || path.startsWith(`${folder}/`),
    withAiAssistRuntime: (value) => value,
    restoreInProgress: false,
    patchTouchesLibraryWatch: () => false,
    patchTouchesRadioBrain: () => false,
  };
  vm.runInNewContext(code, context);
  const { unseenMenuRoots } = context.api;

  unseenMenuRoots.add('/menu-added');
  await handlers.get('settings:set')(null, { resumeState: null });
  await handlers.get('settings:set')(null, { volume: 0.5 });
  assert.equal(unseenMenuRoots.size, 1, 'saves that carry no folder list leave the guard up');
  await handlers.get('settings:set')(null, { libraryRoots: ['/music', '/menu-added'] });
  assert.equal(unseenMenuRoots.size, 0, 'a saved folder list ends it');
  assert.equal(saved.length, 3);

  unseenMenuRoots.add('/menu-added');
  await handlers.get('settings:get')();
  assert.equal(unseenMenuRoots.size, 0, 'so does the page reading the settings');
}

// Source-level wiring that main.ts cannot be loaded to check.
{
  const set = slice("ipcMain.handle('settings:set'", '\n  });');
  assert.match(set, /'bitPerfectExclusive' in patch[\s\S]*syncMediaShortcuts\(\)/, 'a change of the exclusive setting re-registers the media keys');

  const prune = slice("ipcMain.handle('library:prune-missing',", "// Files go to the Recycle Bin");
  assert.match(prune, /if \(!preview\.tracks\) return \{ checked: preview\.checked, removed: 0, offline: preview\.offline \};/, 'a preview with nothing to remove returns without a second sweep');
  assert.match(prune, /if \(!preview\.tracks\)[\s\S]*restoreInProgress[\s\S]*assertHistoryImportIdle\(\);\s*\/\/ Removing a track/, 'a history import that began during the preview is refused');

  assert.match(slice('async function chooseFolderForLibrary', '\n}\n'), /webContents\.send\('settings:changed'\)/, 'the page is told the folder list changed');

  assert.equal(source.match(/app\.on\('will-quit'/g).length, 1, 'one will-quit listener');
  assert.match(slice("app.on('will-quit', (event) => {", '\n});'), /appSuspensionBlockerId/, 'and it releases the app-suspension blocker');
}

console.log('main-review-fixes-test: ok');
