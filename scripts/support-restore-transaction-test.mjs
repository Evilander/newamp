// Restoring a support backup swaps library.db, settings.json and the art
// folders in place, so it must be all-or-nothing: nothing in the live profile
// changes until every member has been read and checked, and a failure part
// way through puts the original profile back. The stores have only just
// closed their files when the swap starts, and on Windows antivirus or the
// indexer often still holds them for a moment, so the swap and its rollback
// ride out EPERM/EBUSY. A committed restore removes its working folder (a full
// copy of the old profile, which the pre-restore safety backup already has);
// a failed one keeps it as the recovery files its error names.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { syncBuiltinESMExports } from 'node:module';
import fsPromises, { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';

const root = await mkdtemp(join(tmpdir(), 'newamp-restore-transaction-'));
const result = await build({
  entryPoints: ['electron/support-backup.ts'], write: false, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('electron/support-backup.ts')).href) },
});
const code = result.outputFiles[0].text.replace(/from "sql.js"/g, `from ${JSON.stringify(import.meta.resolve('sql.js'))}`);
const { restoreSupportBackup } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// Every rename the restore makes goes through node:fs/promises; route it
// through a hook a case can set.
const realRename = fsPromises.rename;
let renameHook = null;
fsPromises.rename = (from, to) => (renameHook ? renameHook(String(from), String(to)) : realRename.call(fsPromises, from, to));
syncBuiltinESMExports();
function fsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const SQL = await initSqlJs();
function snapshot(label) {
  const database = new SQL.Database();
  database.run('CREATE TABLE fixture(value TEXT)');
  database.run('INSERT INTO fixture VALUES (?)', [label]);
  const bytes = Buffer.from(database.export());
  database.close();
  return bytes;
}
const currentLibrary = snapshot('current');
const restoredLibrary = snapshot('restored');
const userDataPath = join(root, 'profile');
const backupPath = join(root, 'backup');
const settingsPath = join(userDataPath, 'settings.json');
const libraryPath = join(userDataPath, 'library.db');
const input = { userDataPath, settingsPath, libraryPath, backupPath };
async function assertOriginals() {
  assert.equal(await readFile(settingsPath, 'utf8'), '{"theme":"current"}');
  assert.deepEqual(await readFile(libraryPath), currentLibrary);
  assert.equal(await readFile(join(userDataPath, 'art', 'keep.bin'), 'utf8'), 'current-art');
}
async function assertRestored() {
  assert.equal(await readFile(settingsPath, 'utf8'), '{"theme":"restored"}');
  assert.deepEqual(await readFile(libraryPath), restoredLibrary);
  assert.equal(await readFile(join(userDataPath, 'art', 'new.bin'), 'utf8'), 'restored-art');
  await assert.rejects(readFile(join(userDataPath, 'art', 'keep.bin')), /ENOENT/);
}
async function resetProfile() {
  await rm(userDataPath, { recursive: true, force: true });
  await mkdir(join(userDataPath, 'art'), { recursive: true });
  await writeFile(settingsPath, '{"theme":"current"}');
  await writeFile(libraryPath, currentLibrary);
  await writeFile(join(userDataPath, 'art', 'keep.bin'), 'current-art');
}
async function transactionFolders() {
  try {
    return (await readdir(join(userDataPath, 'backups'))).filter((name) => name.startsWith('.restore-')).sort();
  } catch {
    return [];
  }
}
try {
  await resetProfile();
  await mkdir(backupPath);
  await writeFile(join(backupPath, 'manifest.json'), JSON.stringify({ app: 'NewAmp', included: ['settings.json', 'library.db', 'art'] }));
  await writeFile(join(backupPath, 'settings.json'), '{"theme":"restored"}');
  await assert.rejects(restoreSupportBackup(input), /ENOENT/);
  await assertOriginals();

  await writeFile(join(backupPath, 'library.db'), restoredLibrary);
  await mkdir(join(backupPath, 'art'));
  await writeFile(join(backupPath, 'art', 'new.bin'), 'restored-art');
  await writeFile(join(backupPath, 'settings.json'), '{invalid');
  await assert.rejects(restoreSupportBackup(input), /Could not restore backup/);
  await assertOriginals();
  await writeFile(join(backupPath, 'settings.json'), '{"theme":"restored"}');
  await writeFile(join(backupPath, 'library.db'), restoredLibrary.subarray(0, 100));
  await assert.rejects(restoreSupportBackup(input), /Could not restore backup/);
  await assertOriginals();
  await writeFile(join(backupPath, 'library.db'), restoredLibrary);

  // A real failure installing a member rolls everything back, and the
  // recovery files the error names are kept.
  let failureInjected = false;
  renameHook = (from, to) => {
    if (!failureInjected && from.includes(`${sep}staged${sep}`) && to === join(userDataPath, 'art')) {
      failureInjected = true;
      throw fsError('EIO', 'injected disk failure');
    }
    return realRename.call(fsPromises, from, to);
  };
  const failed = await restoreSupportBackup(input).then(() => null, (error) => error);
  assert.match(String(failed?.message), /injected disk failure.*Original profile restored/);
  assert.equal(failureInjected, true);
  await assertOriginals();
  const recoveryFiles = String(failed.message).match(/Recovery files: (.+)$/)?.[1];
  assert.ok(recoveryFiles && (await stat(recoveryFiles)).isDirectory(), 'a failed restore keeps the recovery files it names');

  // library.db still held for a moment after the store closed it: moving it
  // aside, and putting the restored copy in its place, fail with EPERM/EBUSY
  // a couple of times before the hold is released. The restore waits it out.
  const holds = new Map([[`out:${libraryPath}`, 2], [`in:${libraryPath}`, 2]]);
  renameHook = (from, to) => {
    const key = from === libraryPath ? `out:${from}` : to === libraryPath ? `in:${to}` : null;
    const left = key ? holds.get(key) ?? 0 : 0;
    if (left > 0) {
      holds.set(key, left - 1);
      throw fsError(key.startsWith('out') ? 'EBUSY' : 'EPERM', `injected hold on ${key}`);
    }
    return realRename.call(fsPromises, from, to);
  };
  const foldersBefore = await transactionFolders();
  const held = await restoreSupportBackup(input);
  assert.deepEqual([...holds.values()], [0, 0], 'both holds were met');
  assert.deepEqual(held.restored, ['settings.json', 'library.db', 'art']);
  await assertRestored();
  assert.deepEqual(await transactionFolders(), foldersBefore, 'a committed restore removes its working copy of the old profile');

  // The rollback after a real failure meets the same holds, and still puts
  // the whole original profile back.
  await resetProfile();
  let artFailed = false;
  const rollbackHolds = new Map();
  renameHook = (from, to) => {
    if (!artFailed && from.includes(`${sep}staged${sep}`) && to === join(userDataPath, 'art')) {
      artFailed = true;
      throw fsError('EIO', 'injected disk failure');
    }
    // Once the failure has happened, every rollback move meets one EPERM.
    if (artFailed && !rollbackHolds.has(`${from}>${to}`)) {
      rollbackHolds.set(`${from}>${to}`, true);
      throw fsError('EPERM', 'injected hold during rollback');
    }
    return realRename.call(fsPromises, from, to);
  };
  await assert.rejects(restoreSupportBackup(input), /injected disk failure.*Original profile restored/);
  assert.ok(rollbackHolds.size >= 4, 'the rollback moves each met a hold');
  await assertOriginals();
  renameHook = null;

  // And plainly, with nothing in the way, into a profile with no earlier
  // recovery folders.
  await resetProfile();
  const restored = await restoreSupportBackup(input);
  assert.deepEqual(restored.restored, ['settings.json', 'library.db', 'art']);
  await assertRestored();
  assert.deepEqual(await transactionFolders(), [], 'no working copy is left behind after a committed restore');
  console.log('PASS restore transaction: missing member, malformed JSON, SQLite integrity, rollback, held files, cleanup after commit');
} finally {
  renameHook = null;
  fsPromises.rename = realRename;
  syncBuiltinESMExports();
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  await rm(root, { recursive: true, force: true });
}
