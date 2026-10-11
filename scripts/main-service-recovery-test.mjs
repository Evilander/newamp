import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const restoreSource = source.slice(source.indexOf("  ipcMain.handle('app:restore-backup'"), source.indexOf("  ipcMain.handle('lastfm:start-auth'"));
const { code: restoreCode } = await transform(restoreSource, { loader: 'ts', target: 'es2022' });

for (const failure of ['backup', 'library-drain', 'settings-drain', 'close', 'restore', null]) {
  const handlers = new Map();
  const calls = [];
  let quiesced = false;
  const step = (name) => {
    calls.push(name);
    if (failure === name) throw new Error(`fixture ${name}`);
  };
  vm.runInNewContext(restoreCode, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPath: () => '/fixture/profile' }, mainWin: null,
    restoreInProgress: false, backupInProgress: 0, assertHistoryImportIdle() {}, exclusiveOutput: null,
    closeAllGaplessSessions() {}, radioBrain: null, queueRadioBrainSync: async () => {},
    join: (...parts) => parts.join('/'),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/fixture/backup'] }) },
    libraryWatcher: { stop: () => step('watch-stop') },
    quiesceLibraryMutations: async () => { quiesced = true; },
    resumeLibraryMutations: () => { quiesced = false; step('resume'); },
    syncLibraryWatcher: () => step('watch-start'),
    createBackupFromLiveStores: async () => { step('backup'); return { backupPath: '/fixture/safety' }; },
    library: { waitForPendingWrites: async () => step('library-drain'), close: () => step('close') },
    podcastStore: { flushProgressSync: () => step('podcast-flush') },
    settings: { waitForPendingWrites: async () => step('settings-drain'), flushSync: () => step('settings-flush') },
    restoreSupportBackup: async () => { step('restore'); return { restored: true }; },
    reloadRuntimeStores: async () => { quiesced = false; step('reload'); },
  });
  const result = handlers.get('app:restore-backup')();
  if (failure) await assert.rejects(result, new RegExp(`fixture ${failure}`));
  else assert.equal((await result).restored, true);
  assert.equal(quiesced, false, `${failure}: mutations must resume`);
  if (['backup', 'library-drain', 'settings-drain'].includes(failure)) {
    assert.ok(calls.includes('watch-start'), `${failure}: existing watcher must restart`);
    assert.ok(!calls.includes('reload'), `${failure}: keep live stores before close`);
  } else {
    assert.ok(calls.includes('reload'), `${failure}: closed stores must reopen`);
    // The outgoing podcast store's pending write must land before the swap,
    // or it fires afterwards and puts the old podcasts.json back.
    assert.ok(
      calls.indexOf('podcast-flush') >= 0 && calls.indexOf('podcast-flush') < calls.indexOf('close'),
      `${failure}: podcast progress must be flushed before the stores close`,
    );
  }
}

// Backup and restore share the scanner quiesce flag and must not overlap.
{
  const start = source.indexOf("  ipcMain.handle('app:create-backup'");
  const end = source.indexOf("  ipcMain.handle('lastfm:start-auth'");
  const { code } = await transform(source.slice(start, end), { loader: 'ts', target: 'es2022' });
  const handlers = new Map();
  let releaseBackup;
  let quiesced = false;
  const context = vm.createContext({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    restoreInProgress: false, backupInProgress: 0,
    app: { getPath: () => '/fixture/profile' },
    quiesceLibraryMutations: async () => { quiesced = true; },
    resumeLibraryMutations: () => { quiesced = false; },
    createBackupFromLiveStores: () => new Promise((resolve) => { releaseBackup = resolve; }),
  });
  vm.runInContext(code, context);
  const backup = handlers.get('app:create-backup')();
  await Promise.resolve();
  await assert.rejects(handlers.get('app:create-backup')(), /backup, move or cleanup to finish/);
  await assert.rejects(handlers.get('app:restore-backup')(), /backup to finish/);
  assert.equal(quiesced, true, 'rejected overlapping operations cannot resume mutations');
  releaseBackup({ backupPath: '/fixture/backup' });
  await backup;
  assert.equal(context.backupInProgress, 0);
  assert.equal(quiesced, false);
  context.quiesceLibraryMutations = async () => { quiesced = true; throw new Error('fixture quiesce'); };
  await assert.rejects(handlers.get('app:create-backup')(), /fixture quiesce/);
  assert.equal(context.backupInProgress, 0);
  assert.equal(quiesced, false, 'quiesce failures must also resume mutations');
}

// Moving files to the Recycle Bin and cleaning up missing tracks each take a
// library backup first and hold the same counter as a Support backup. A backup
// or restore is refused while either runs, and a failed operation hands the
// counter and the scanner pause back.
{
  const sliceOf = async (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    assert.ok(start !== -1 && end > start, `main.ts still has the block from ${from}`);
    return (await transform(source.slice(start, end), { loader: 'ts', target: 'es2022' })).code;
  };
  const codes = [
    await sliceOf("  ipcMain.handle('library:prune-missing'", '  // Files go to the Recycle Bin'),
    await sliceOf('  const LONG_TRASH_FILES', "  ipcMain.handle('history:get'"),
    await sliceOf("  ipcMain.handle('app:create-backup'", "  ipcMain.handle('lastfm:start-auth'"),
  ];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const until = async (ready, what) => {
    for (let i = 0; i < 50 && !ready(); i += 1) await tick();
    assert.ok(ready(), what);
  };
  const operations = {
    prune: { channel: 'library:prune-missing', args: [null, undefined] },
    trash: { channel: 'tracks:trash', args: [{ sender: { isDestroyed: () => false, send() {} } }, [1]] },
  };
  const makeFixture = () => {
    const handlers = new Map();
    const finishers = [];
    const fixture = {
      handlers,
      finishers,
      quiesceDepth: 0,
      backup: () => new Promise((resolve) => finishers.push(resolve)),
    };
    fixture.context = vm.createContext({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      process: { platform: 'win32', env: {} }, smokeMode: false,
      app: { getPath: () => '/fixture/profile' },
      restoreInProgress: false, backupInProgress: 0, assertHistoryImportIdle() {},
      quiesceLibraryMutations: async () => { fixture.quiesceDepth += 1; },
      resumeLibraryMutations: () => { fixture.quiesceDepth = Math.max(0, fixture.quiesceDepth - 1); },
      createBackupFromLiveStores: (...args) => fixture.backup(...args),
      settings: { get: () => ({ libraryRoots: [] }) },
      library: {
        previewPruneMissingTracks: () => ({ tracks: 2 }),
        pruneMissingTracks: () => ({ removedIds: [1, 2] }),
        getTrack: (id) => ({ id, path: `/fixture/${id}.mp3`, title: 'Fixture' }),
        removeTracksById: (ids) => ids,
      },
      trashableTracks: (ids, find) => ({ supplied: true, tracks: ids.map(find) }),
      BrowserWindow: { fromWebContents: () => null },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      releaseGaplessPaths: async () => {}, stopFfmpegReading: async () => {},
      moveTracksToTrash: async (tracks) => ({ trashed: tracks, gone: [], failed: [] }),
      existsSync: () => true, shell: { trashItem: async () => {} },
      notifyTracksRemoved() {}, notifyPlaylistsChanged() {},
    });
    for (const code of codes) vm.runInContext(code, fixture.context);
    return fixture;
  };

  for (const [name, { channel, args }] of Object.entries(operations)) {
    const fixture = makeFixture();
    const { handlers, context } = fixture;
    const running = handlers.get(channel)(...args);
    await until(() => context.backupInProgress === 1 && fixture.finishers.length === 1, `${name}: takes a backup while holding the counter`);
    await assert.rejects(handlers.get('app:create-backup')(), /backup, move or cleanup to finish/, `${name}: a backup waits`);
    await assert.rejects(handlers.get('app:restore-backup')(), /backup to finish/, `${name}: a restore waits`);
    assert.equal(context.backupInProgress, 1, `${name}: refused requests leave the counter alone`);
    assert.equal(fixture.quiesceDepth, 1, `${name}: the library stays paused until it is done`);
    fixture.finishers[0]({ backupPath: '/fixture/backup' });
    assert.equal((await running).backupPath, '/fixture/backup', `${name}: reports the backup it took`);
    assert.equal(context.backupInProgress, 0, `${name}: gives the counter back`);
    assert.equal(fixture.quiesceDepth, 0, `${name}: lets the library resume`);

    fixture.backup = async () => { throw new Error(`fixture ${name} backup`); };
    await assert.rejects(handlers.get(channel)(...args), new RegExp(`fixture ${name} backup`));
    assert.equal(context.backupInProgress, 0, `${name}: a failed backup gives the counter back`);
    assert.equal(fixture.quiesceDepth, 0, `${name}: a failed backup lets the library resume`);

    fixture.backup = async () => ({ backupPath: '/fixture/after' });
    const again = await handlers.get(channel)(...args);
    assert.equal(again.backupPath, '/fixture/after', `${name}: runs again after a failure`);
    assert.equal(again.refused, undefined, `${name}: a failure does not leave it marked as running`);
    assert.deepEqual(await handlers.get('app:create-backup')(), { backupPath: '/fixture/after' }, `${name}: a backup is allowed again`);
    assert.equal(context.backupInProgress, 0);
  }

  // Both at once: the counter stays up until the last of them is done.
  {
    const fixture = makeFixture();
    const { handlers, context } = fixture;
    const prune = handlers.get('library:prune-missing')(...operations.prune.args);
    await until(() => context.backupInProgress === 1 && fixture.finishers.length === 1, 'prune holds the counter');
    const trash = handlers.get('tracks:trash')(...operations.trash.args);
    await until(() => context.backupInProgress === 2 && fixture.finishers.length === 2, 'trash adds to the counter');
    fixture.finishers[0]({ backupPath: '/fixture/one' });
    await prune;
    assert.equal(context.backupInProgress, 1, 'the counter drops by one');
    await assert.rejects(handlers.get('app:create-backup')(), /backup, move or cleanup to finish/, 'a backup still waits for the other');
    fixture.finishers[1]({ backupPath: '/fixture/two' });
    await trash;
    assert.equal(context.backupInProgress, 0);
    assert.equal(fixture.quiesceDepth, 0);
  }
}

const radioPredicate = source.slice(source.indexOf('const RADIO_BRAIN_SETTINGS_KEYS'), source.indexOf('// Funnels every enable/port/reload'));
const settingsHandler = source.slice(source.indexOf("  ipcMain.handle('settings:get'"), source.indexOf('  // ---- Bit-Perfect Exclusive output'));
const { code: settingsCode } = await transform(`${radioPredicate}\n${settingsHandler}`, { loader: 'ts', target: 'es2022' });
const settingsHandlers = new Map();
let settings = { radioBrainEnabled: true, radioBrainToken: 'old-token' };
vm.runInNewContext(settingsCode, {
  ipcMain: { handle: (name, fn) => settingsHandlers.set(name, fn) },
  settings: { get: () => settings, set: (patch) => (settings = { ...settings, ...patch }) },
  withAiAssistRuntime: (value) => value,
  restoreInProgress: false, radioBrain: { revokeClients() {} },
  patchTouchesLibraryWatch: () => false,
  queueRadioBrainSync: async () => { if (!settings.radioBrainToken) settings = { ...settings, radioBrainToken: 'replacement-token' }; },
});
const updated = await settingsHandlers.get('settings:set')(null, { radioBrainToken: null });
assert.equal(updated.radioBrainToken, 'replacement-token', 'return the reminted credential after synchronization');
console.log('PASS main restore failure cleanup and remote credential synchronization');
