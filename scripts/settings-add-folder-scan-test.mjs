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

async function addFolder({ roots = ['K:\\Music'], picked, scan = async () => undefined, save, platform = 'win32' }) {
  const calls = { saved: [], scanned: [], toasts: [], accepted: [] };
  const settings = { libraryRoots: roots };
  const ctx = await load(['pickAndAddFolder', 'folderIsSameOrInside'], {
    settings,
    api: {
      platform,
      pickFolder: async () => picked,
      scanLibrary: (...args) => { calls.scanned.push(args); return scan(...args); },
    },
    saveSettings: async (patch) => {
      calls.saved.push(patch);
      if (save) return save(patch);
      return { ...settings, ...patch };
    },
    acceptSettings: (value) => calls.accepted.push(value),
    pushToast: (toast) => calls.toasts.push(toast),
  });
  await ctx.pickAndAddFolder();
  await tick();
  return { ...calls, saved: plain(calls.saved), scanned: plain(calls.scanned), toasts: plain(calls.toasts) };
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

// A save that fails scans nothing: the folder never joined the library.
{
  await assert.rejects(addFolder({ picked: 'D:\\Albums', save: async () => { throw new Error('disk full'); } }), /disk full/);
  const scanned = [];
  const ctx = await load(['pickAndAddFolder', 'folderIsSameOrInside'], {
    settings: { libraryRoots: [] },
    api: { platform: 'win32', pickFolder: async () => 'D:\\Albums', scanLibrary: (...args) => { scanned.push(args); } },
    saveSettings: async () => { throw new Error('disk full'); },
    acceptSettings: () => undefined,
    pushToast: () => undefined,
  });
  await assert.rejects(ctx.pickAndAddFolder(), /disk full/);
  assert.deepEqual(scanned, []);
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
