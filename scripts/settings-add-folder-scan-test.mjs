// Settings > "+ Add folder..." saved the new root and then did nothing, so the
// folder stayed empty until the user found "Scan now". Adding a folder now
// scans that folder (only that one) once it is saved. Runs the real handler
// from SettingsView.tsx against stubs for the API, the settings writer and the
// toasts.
// Run: node scripts/settings-add-folder-scan-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transform } from 'esbuild';

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const path = 'src/components/views/SettingsView.tsx';
const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(root, predicate) {
  if (predicate(root)) return root;
  let result;
  ts.forEachChild(root, (node) => { result ??= find(node, predicate); });
  return result;
}
async function load(names, bindings) {
  // The errors under test are built out here, so the handler must see this realm's Error.
  bindings = { Error, ...bindings };
  const text = names.map((name) => {
    const node = find(file, (candidate) => ts.isFunctionDeclaration(candidate) && candidate.name?.text === name);
    assert.ok(node, `Missing ${name}`);
    return node.getText(file);
  }).join('\n');
  const ctx = vm.createContext(bindings);
  vm.runInContext((await transform(text, { loader: 'tsx' })).code, ctx);
  return ctx;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
// Values built inside the vm carry its realm's prototypes; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

// `roots` is the page's copy of the folder list and `stored` the saved one;
// they differ when a removal finished behind the page.
async function addFolder({ roots = ['K:\\Music'], stored = roots, picked, scan = async () => undefined, save, platform = 'win32', whilePicking, read }) {
  const calls = { saved: [], scanned: [], toasts: [], accepted: [], errors: [] };
  const settings = { libraryRoots: roots };
  const settingsRef = { current: settings };
  const ctx = await load(['pickAndAddFolder', 'folderIsSameOrInside'], {
    settingsRef,
    api: {
      platform,
      pickFolder: async () => {
        // The saved list can change while the picker is open.
        if (whilePicking) stored = whilePicking;
        return picked;
      },
      getSettings: async () => {
        if (read) await read();
        return { ...settings, libraryRoots: stored };
      },
      scanLibrary: (...args) => { calls.scanned.push(args); return scan(...args); },
    },
    saveSettings: async (patch) => {
      calls.saved.push(patch);
      if (save) return save(patch);
      return { ...settings, ...patch };
    },
    acceptSettings: (value) => calls.accepted.push(value),
    pushToast: (toast) => calls.toasts.push(toast),
    reportSettingError: (title, err) => calls.errors.push({ title, detail: err.message }),
  });
  await ctx.pickAndAddFolder();
  await tick();
  return { ...calls, saved: plain(calls.saved), scanned: plain(calls.scanned), toasts: plain(calls.toasts), errors: plain(calls.errors) };
}

// A new folder is saved, then scanned, and only that folder is scanned.
{
  const calls = await addFolder({ picked: 'D:\\Albums' });
  assert.deepEqual(calls.saved, [{ libraryRoots: ['K:\\Music', 'D:\\Albums'] }]);
  assert.deepEqual(calls.scanned, [[['D:\\Albums']]], 'scans the new folder alone, not every root');
  assert.equal(calls.accepted.length, 1);
  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.toasts[0].tone, 'ok');
  assert.equal(calls.toasts[0].title, 'Folder added');
  assert.match(calls.toasts[0].detail, /Scanning D:\\Albums/, 'the toast says what is being scanned');
}

// A folder that holds existing roots replaces them and is scanned once.
{
  const calls = await addFolder({ roots: ['D:\\Music\\Rock', 'D:\\Music\\Jazz', 'K:\\Other'], picked: 'D:\\Music' });
  assert.deepEqual(calls.saved, [{ libraryRoots: ['K:\\Other', 'D:\\Music'] }]);
  assert.deepEqual(calls.scanned, [[['D:\\Music']]]);
}

// A folder the library already covers is neither saved nor scanned.
{
  const calls = await addFolder({ roots: ['K:\\Music'], picked: 'k:/music/Rock' });
  assert.deepEqual(calls.saved, []);
  assert.deepEqual(calls.scanned, []);
  assert.equal(calls.toasts[0].title, 'Already in your library');
}

// Cancelling the picker does nothing.
{
  const calls = await addFolder({ picked: null });
  assert.deepEqual(calls.saved, []);
  assert.deepEqual(calls.scanned, []);
  assert.deepEqual(calls.toasts, []);
}

// A save that fails scans nothing: the folder never joined the library. The
// failure is reported rather than left as an unhandled rejection.
{
  const calls = await addFolder({ picked: 'D:\\Albums', save: async () => { throw new Error('disk full'); } });
  assert.deepEqual(calls.scanned, []);
  assert.equal(calls.accepted.length, 0);
  assert.deepEqual(calls.errors, [{ title: 'Could not add folder', detail: 'disk full' }]);
  assert.equal(unhandled.length, 0);
}

// A folder removed while the picker was open is not saved back with the new one.
{
  const calls = await addFolder({ roots: ['K:\\Music', 'E:\\Old'], whilePicking: ['K:\\Music'], picked: 'D:\\Albums' });
  assert.deepEqual(calls.saved, [{ libraryRoots: ['K:\\Music', 'D:\\Albums'] }]);
}

// Nor is one a Settings page opened during the removal still lists: the page
// that started it is the only one whose copy the removal updates.
{
  const calls = await addFolder({ roots: ['K:\\Music', 'E:\\Old'], stored: ['K:\\Music'], picked: 'D:\\Albums' });
  assert.deepEqual(calls.saved, [{ libraryRoots: ['K:\\Music', 'D:\\Albums'] }]);
}

// A folder list that cannot be read saves nothing and says so.
{
  const calls = await addFolder({ picked: 'D:\\Albums', read: async () => { throw new Error('Wait for backup restoration to finish.'); } });
  assert.deepEqual(calls.saved, []);
  assert.deepEqual(calls.scanned, []);
  assert.deepEqual(calls.errors, [{ title: 'Could not add folder', detail: 'Wait for backup restoration to finish.' }]);
}

// A removal hands the new folder list to the rest of the app, not only to this
// page: the title bar and Play read it from the player store.
{
  let state = { settings: { libraryRoots: ['K:\\Music'], volume: 0.5 } };
  const calls = { accepted: [], toasts: [], errors: [] };
  const ctx = await load(['removeRoot', 'publishSavedSettings'], {
    Object,
    folderRemoval: { path: 'K:\\Music', count: 3 },
    setRemovingFolder: () => undefined,
    setFolderRemoval: () => undefined,
    api: { removeLibraryFolder: async () => ({ libraryRoots: [], volume: 0.5 }), getStats: async () => ({ tracks: 0, albums: 0, artists: 0, duration: 0 }) },
    setStats: (value) => { calls.stats = value; },
    acceptSettings: (value) => calls.accepted.push(value),
    pushToast: (toast) => calls.toasts.push(toast),
    reportSettingError: (title, err) => calls.errors.push({ title, detail: err.message }),
    usePlayerStore: { setState: (update) => { state = { ...state, ...update(state) }; } },
  });
  await ctx.removeRoot();
  assert.deepEqual(calls.errors, []);
  assert.deepEqual(plain(state.settings), { libraryRoots: [], volume: 0.5 }, 'the store no longer lists the removed folder');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.stats.tracks, 0, 'the totals under the folder list are read again');
}

// While a removal runs (it can wait minutes for a scan), the controls that
// would change the folder list or start a scan are off.
{
  const source = readFileSync(path, 'utf8');
  assert.match(source, /<button className="pxbtn" disabled=\{removingFolder\} onClick=\{\(\) => void pickAndAddFolder\(\)\}>/, 'Add folder waits for the removal');
  assert.match(source, /disabled=\{!settings\.libraryRoots\.length \|\| removingFolder\}\s*>\s*▶ Scan now/, 'Scan now waits for the removal');
  assert.match(source, /removingFolder \? 'Removing…'/);
}

// A scan that fails is reported, and does not turn into an unhandled rejection.
{
  const calls = await addFolder({ picked: 'D:\\Albums', scan: async () => { throw new Error('Folder is not readable'); } });
  await tick();
  assert.equal(unhandled.length, 0, 'the scan promise is handled');
  const failure = calls.toasts.find((toast) => toast.tone === 'error');
  assert.ok(failure, 'the user is told the scan failed');
  assert.equal(failure.title, 'Scan failed');
  assert.equal(failure.detail, 'Folder is not readable');
}

// The scan runs in the background: the handler does not wait for it to finish.
{
  let finish;
  const calls = await addFolder({ picked: 'D:\\Albums', scan: () => new Promise((resolve) => { finish = resolve; }) });
  assert.equal(calls.scanned.length, 1, 'handler returned while the scan is still running');
  finish();
}

console.log('PASS settings add-folder scan');
