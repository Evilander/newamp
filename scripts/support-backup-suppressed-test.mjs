// Tests SettingsStore.snapshotJson(): while persistence is
// suppressed (see settings-transient-read-test.mjs), `state` is DEFAULTS,
// not the real file. Handing that straight to a backup, or to the
// pre-restore safety snapshot, used to silently poison both with defaults —
// and a later restore from either one would overwrite the real settings.json
// with them. snapshotJson() now re-reads the file for itself and returns the
// real bytes, or throws so the caller (main.ts's createBackupFromLiveStores,
// used by both app:create-backup and the pre-restore safety snapshot in
// app:restore-backup) refuses before touching anything.
// Run: npm run build:electron && node scripts/support-backup-suppressed-test.mjs
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from '../dist-electron/electron/settings.js';
import { createSupportBackup } from '../dist-electron/electron/support-backup.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'support-backup-suppressed-test');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

function lockedError(code) {
  const err = new Error(`fixture ${code} lock`);
  err.code = code;
  return err;
}
const realReadFileSync = fs.readFileSync;
function patchRead(targetFile, code, failTimes) {
  let calls = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === targetFile) {
      calls += 1;
      if (calls <= failTimes) throw lockedError(code);
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
}
function unpatchRead() {
  fs.readFileSync = realReadFileSync;
  syncBuiltinESMExports();
}

// 1. Suppressed AND still unreadable when the backup coordinator asks:
//    snapshotJson() must throw, so a backup built the same way
//    createBackupFromLiveStores does (settingsSnapshot: settings.snapshotJson())
//    never even reaches createSupportBackup — no backup directory is
//    created, and both live files are untouched. This is also exactly the
//    shape of the pre-restore safety snapshot, so it covers "restore refuses"
//    too: restoreSupportBackup is never reached if this throws first.
{
  const userData = join(smokeRoot, 'refuses');
  mkdirSync(userData, { recursive: true });
  const settingsPath = join(userData, 'settings.json');
  const original = JSON.stringify({ volume: 0.31, theme: 'amber', libraryRoots: ['D:/RealMusic'], lastfmSessionKey: 'real-session' });
  writeFileSync(settingsPath, original, 'utf-8');
  const libraryPath = join(userData, 'library.db');
  writeFileSync(libraryPath, 'real-library-bytes');

  patchRead(settingsPath, 'EBUSY', 999);
  let store;
  try {
    store = new SettingsStore(settingsPath);
  } finally {
    unpatchRead();
  }
  assert.ok(store.isSuppressed(), 'setup: the store must be suppressed');

  // Re-lock only for the snapshot attempt itself, so it fails the same way.
  patchRead(settingsPath, 'EBUSY', 999);
  let threw = null;
  try {
    await createSupportBackup({
      userDataPath: userData,
      settingsPath,
      libraryPath,
      librarySnapshot: Buffer.from('live-library-snapshot'),
      settingsSnapshot: store.snapshotJson(), // must throw before createSupportBackup runs at all
    });
  } catch (err) {
    threw = err;
  } finally {
    unpatchRead();
  }
  assert.ok(threw, 'a suppressed, still-unreadable settings store must refuse to back itself up');
  assert.match(threw.message, /settings\.json is unavailable/);
  assert.equal(readFileSync(settingsPath, 'utf-8'), original, 'the live settings file must be untouched');
  assert.equal(readFileSync(libraryPath, 'utf-8'), 'real-library-bytes', 'the live library file must be untouched');
  const backupsDir = join(userData, 'backups');
  const backups = existsSync(backupsDir) ? readdirSync(backupsDir) : [];
  assert.deepEqual(backups, [], 'no backup directory should exist after a refused backup');
}

// 2. Suppressed, but readable again by the time snapshotJson() tries: it
//    returns the REAL bytes, not the in-memory defaults, and does not itself
//    lift suppression as a side effect (that only happens through set()).
{
  const userData = join(smokeRoot, 'real-bytes');
  mkdirSync(userData, { recursive: true });
  const settingsPath = join(userData, 'settings.json');
  const original = JSON.stringify({ volume: 0.31, theme: 'amber', libraryRoots: ['D:/RealMusic'], lastfmSessionKey: 'real-session' });
  writeFileSync(settingsPath, original, 'utf-8');
  const libraryPath = join(userData, 'library.db');
  writeFileSync(libraryPath, 'real-library-bytes');

  patchRead(settingsPath, 'EBUSY', 999);
  let store;
  try {
    store = new SettingsStore(settingsPath);
  } finally {
    unpatchRead();
  }
  assert.ok(store.isSuppressed());
  assert.equal(store.get().volume, 0.75, 'in-memory state must still be defaults');

  // Read is NOT re-locked this time — snapshotJson()'s own re-read succeeds.
  const snapshot = store.snapshotJson();
  assert.equal(JSON.parse(snapshot).volume, 0.31, 'snapshotJson must return the real on-disk value, not defaults');
  assert.equal(JSON.parse(snapshot).lastfmSessionKey, 'real-session');
  assert.ok(store.isSuppressed(), 'snapshotJson must not itself lift suppression as a side effect');

  const backup = await createSupportBackup({
    userDataPath: userData,
    settingsPath,
    libraryPath,
    librarySnapshot: Buffer.from('real-library-bytes'),
    settingsSnapshot: snapshot,
  });
  const backedUp = readFileSync(join(backup.backupPath, 'settings.json'), 'utf-8');
  assert.equal(JSON.parse(backedUp).volume, 0.31, 'the backup itself must hold the real settings, not defaults');
  assert.equal(readFileSync(settingsPath, 'utf-8'), original, 'creating a backup must never touch the live file');
}

await rm(smokeRoot, { recursive: true, force: true });
console.log('[support-backup-suppressed-test] PASS: a suppressed settings store never poisons a backup or a restore safety snapshot');
