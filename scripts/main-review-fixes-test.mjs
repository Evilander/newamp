import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
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

  libraryRoots = ['/music'];
  assert.deepEqual(keepUnseenMenuRoots(stale), stale, 'a folder no longer in the settings is not brought back');
  libraryRoots = ['/music', '/menu-added'];

  libraryRootsRead();
  assert.deepEqual(keepUnseenMenuRoots(stale), stale, 'once the page has read the settings, removing the folder sticks');
}

// Source-level wiring that main.ts cannot be loaded to check.
{
  const set = slice("ipcMain.handle('settings:set'", '\n  });');
  assert.match(set, /'bitPerfectExclusive' in patch[\s\S]*syncMediaShortcuts\(\)/, 'a change of the exclusive setting re-registers the media keys');

  const folders = slice('async function readOpenedFolders', '\n}\n');
  assert.match(folders, /isInsideLibraryRoot\(folder\) && \(await library\.getFolderTracksAsync\(folder, \{ recursive: true, limit: 1 \}\)\)\.length/, 'a folder inside a library folder is read inline when the library has no tracks for it');

  assert.match(folders, /listAudioFiles\(folder, OPENED_FOLDER_INLINE_FILES\)[\s\S]*files\.length > OPENED_FOLDER_INLINE_FILES\) continue;[\s\S]*readOpenedFiles\(files\)/, 'a folder with more files than the cap is left to the scanner');

  const prune = slice("ipcMain.handle('library:prune-missing',", "// Files go to the Recycle Bin");
  assert.match(prune, /if \(!preview\.tracks\) return \{ checked: preview\.checked, removed: 0, offline: preview\.offline \};/, 'a preview with nothing to remove returns without a second sweep');
  assert.match(prune, /if \(!preview\.tracks\)[\s\S]*restoreInProgress[\s\S]*assertHistoryImportIdle\(\);\s*\/\/ Removing a track/, 'a history import that began during the preview is refused');

  const apply = slice('function applyShellPlaybackState', '\n}\n');
  assert.match(apply, /state\.isPlaying && Date\.now\(\) < sleepPauseUntil[\s\S]*sendPlayerCommand\('pause'\)/, 'a snapshot that says playing right after a wake is paused');
  assert.match(source, /sleepPauseUntil = Infinity;[\s\S]*sleepPauseUntil = Date\.now\(\) \+ WAKE_PAUSE_WINDOW_MS/, 'suspend opens the window and wake bounds it');

  assert.match(slice('async function chooseFolderForLibrary', '\n}\n'), /webContents\.send\('settings:changed'\)/, 'the page is told the folder list changed');

  assert.equal(source.match(/app\.on\('will-quit'/g).length, 1, 'one will-quit listener');
  assert.match(slice("app.on('will-quit', (event) => {", '\n});'), /appSuspensionBlockerId/, 'and it releases the app-suspension blocker');
}

console.log('main-review-fixes-test: ok');
