import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const section = source.slice(source.indexOf("  ipcMain.handle('settings:get'"), source.indexOf("  ipcMain.handle('radio-brain:status'"));
const { code } = await transform(section, { loader: 'ts', target: 'es2022' });
const handlers = new Map();
const resolutions = [];
const played = [];
const prepared = [];
const output = { stop() {}, pause() {}, resume() {}, seek() {}, prepareNext: (source) => prepared.push(source), play: async (source) => { played.push(source); return {}; } };
const sandbox = {
  ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  settings: { get: () => ({}), set: (patch) => patch },
  withAiAssistRuntime: (settings) => settings,
  restoreInProgress: false, radioBrain: null,
  syncLibraryWatcher() {}, patchTouchesLibraryWatch: () => false, patchTouchesRadioBrain: () => false, queueRadioBrainSync: async () => {},
  exclusiveOutput: output, getExclusiveOutput: () => output,
  resolveExclusiveSource: (trackId) => new Promise((resolve) => resolutions.push(() => resolve({ trackId }))),
};
vm.runInNewContext(code, sandbox);
const invoke = (name, ...args) => handlers.get(name)(null, ...args);

for (const cancel of [() => invoke('exclusive:stop'), () => invoke('settings:set', { bitPerfectExclusive: false })]) {
  const pending = invoke('exclusive:play', 1);
  await cancel();
  resolutions.shift()();
  assert.equal((await pending).ok, false);
  assert.equal(played.length, 0, 'a canceled metadata probe cannot reopen the device');
}
const old = invoke('exclusive:play', 1);
const newest = invoke('exclusive:play', 2);
resolutions.pop()();
await newest;
resolutions.shift()();
assert.equal((await old).ok, false);
assert.deepEqual(played.map((source) => source.trackId), [2]);

const preparing = invoke('exclusive:prepare-next', 3);
await invoke('exclusive:stop');
resolutions.shift()();
await preparing;
assert.deepEqual(prepared, [], 'a late prepare must not survive Stop');
const preparingAgain = invoke('exclusive:prepare-next', 3);
await invoke('exclusive:prepare-next', null);
resolutions.shift()();
await preparingAgain;
assert.deepEqual(prepared, [null], 'clearing preparation wins over an older probe');
// A page that crashed and was reloaded: main gives up on the play and prepare requests that are still resolving, as Stop does.
const pendingPlay = invoke('exclusive:play', 1);
const pendingPrepare = invoke('exclusive:prepare-next', 3);
sandbox.invalidateExclusiveRequests();
resolutions.shift()();
resolutions.shift()();
const crashedPlay = await pendingPlay;
assert.equal(crashedPlay.ok, false);
assert.equal(played.length, 1, 'a request that was resolving when the page crashed cannot reopen the device');
await pendingPrepare;
assert.deepEqual(prepared, [null], 'nor can a late prepare survive it');
const afterCrash = invoke('exclusive:play', 4);
resolutions.shift()();
assert.equal((await afterCrash).ok, true, 'requests made after it are served');
assert.deepEqual(played.map((source) => source.trackId), [2, 4]);
console.log('PASS exclusive IPC cancellation and request ordering');
