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
    restoreInProgress: false, backupInProgress: false, assertHistoryImportIdle() {}, exclusiveOutput: null,
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
    restoreInProgress: false, backupInProgress: false,
    app: { getPath: () => '/fixture/profile' },
    quiesceLibraryMutations: async () => { quiesced = true; },
    resumeLibraryMutations: () => { quiesced = false; },
    createBackupFromLiveStores: () => new Promise((resolve) => { releaseBackup = resolve; }),
  });
  vm.runInContext(code, context);
  const backup = handlers.get('app:create-backup')();
  await Promise.resolve();
  await assert.rejects(handlers.get('app:create-backup')(), /already running/);
  await assert.rejects(handlers.get('app:restore-backup')(), /backup to finish/);
  assert.equal(quiesced, true, 'rejected overlapping operations cannot resume mutations');
  releaseBackup({ backupPath: '/fixture/backup' });
  await backup;
  assert.equal(context.backupInProgress, false);
  assert.equal(quiesced, false);
  context.quiesceLibraryMutations = async () => { quiesced = true; throw new Error('fixture quiesce'); };
  await assert.rejects(handlers.get('app:create-backup')(), /fixture quiesce/);
  assert.equal(context.backupInProgress, false);
  assert.equal(quiesced, false, 'quiesce failures must also resume mutations');
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
