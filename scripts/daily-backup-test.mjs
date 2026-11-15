// An automatic rolling backup of library.db and settings.json. Play history,
// ratings and playlists lived in exactly one file; one bad write, migration or
// cleanup slip lost them with no way back.
//  - one copy per local calendar day, the newest five kept;
//  - a copy is checked with SQLite before any older one is removed;
//  - nothing is copied when the library has not changed since the last copy,
//    or when the drive is nearly full;
//  - the safety copies taken before a trash or a prune are never evicted by it;
//  - the existing restore reads these copies;
//  - Settings shows the count and the folder and can turn it off.
// Run: npm run build:electron && node scripts/daily-backup-test.mjs
import assert from 'node:assert/strict';
import { existsSync, promises as fsp, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import {
  DAILY_BACKUPS_KEPT,
  createDailyBackupIfDue,
  createSupportBackup,
  listDailyBackups,
  restoreSupportBackup,
} from '../dist-electron/electron/support-backup.js';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { SettingsStore } from '../dist-electron/electron/settings.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(join(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
const root = join(repoRoot, 'tmp', 'daily-backup-test');
const SQL = await initSqlJs();

// A valid SQLite file that differs per `n`, so each one hashes differently.
function library(n) {
  const db = new SQL.Database();
  db.run('CREATE TABLE tracks (id INTEGER PRIMARY KEY, title TEXT)');
  for (let i = 0; i <= n; i += 1) db.run('INSERT INTO tracks (title) VALUES (?)', [`track ${i}`]);
  const bytes = Buffer.from(db.export());
  db.close();
  return bytes;
}

let profileId = 0;
async function profile() {
  const userDataPath = join(root, `profile-${(profileId += 1)}`);
  await mkdir(join(userDataPath, 'art'), { recursive: true });
  await writeFile(join(userDataPath, 'art', 'cover.bin'), 'cover');
  const settingsPath = join(userDataPath, 'settings.json');
  const libraryPath = join(userDataPath, 'library.db');
  await writeFile(settingsPath, JSON.stringify({ theme: 'classic' }));
  await writeFile(libraryPath, library(0));
  return { userDataPath, settingsPath, libraryPath };
}

function daily(p, when, libraryBytes, extra = {}) {
  let snapshots = 0;
  const promise = createDailyBackupIfDue({
    ...p,
    now: when,
    freeBytes: async () => null,
    snapshot: () => {
      snapshots += 1;
      return { librarySnapshot: libraryBytes, settingsSnapshot: JSON.stringify({ theme: 'classic', at: when }) };
    },
    ...extra,
  });
  return promise.then((outcome) => ({ outcome, snapshots }));
}

// Local-time days, so the test means the same thing in every time zone.
const day = (d, hour = 9, minute = 0) => new Date(2026, 9, d, hour, minute).getTime();
const folders = async (p, prefix) => (await readdir(join(p.userDataPath, 'backups')).catch(() => [])).filter((name) => name.startsWith(prefix));

await rm(root, { recursive: true, force: true });

// ---- the first copy ----
{
  const p = await profile();
  const bytes = library(1);
  const { outcome } = await daily(p, day(1), bytes);
  assert.equal(outcome.status, 'created');
  const path = outcome.backup.backupPath;
  assert.match(path, /backups[\\/]newamp-daily-\d{8}-\d{6}$/, 'its own name');
  assert.deepEqual(outcome.backup.included, ['settings.json', 'library.db'], 'the two files, not the art');
  assert.ok(existsSync(join(path, 'settings.json')));
  assert.deepEqual(await readFile(join(path, 'library.db')), bytes, 'the snapshot, byte for byte');
  assert.equal(existsSync(join(path, 'art')), false);
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.app, 'NewAmp');
  assert.equal(manifest.daily, true);
  assert.equal(manifest.automatic, true);
  assert.equal(manifest.createdAt, day(1));
  assert.match(manifest.librarySha256, /^[0-9a-f]{64}$/);
  assert.equal((await listDailyBackups(p.userDataPath)).length, 1);
}

// ---- at most one a day ----
{
  const p = await profile();
  await daily(p, day(1, 9), library(1));
  const sameDay = await daily(p, day(1, 21), library(2));
  assert.deepEqual(sameDay.outcome, { status: 'skipped', reason: 'recent' }, 'a second look the same day');
  assert.equal(sameDay.snapshots, 0, 'and the database is not copied out of memory to find that out');
  const nextDay = await daily(p, day(2, 8), library(2));
  assert.equal(nextDay.outcome.status, 'created', 'the next calendar day');
  assert.equal((await listDailyBackups(p.userDataPath)).length, 2);
}

// ---- never two within the hour, even across midnight ----
{
  const p = await profile();
  await daily(p, day(1, 23, 50), library(1));
  const soon = await daily(p, day(1, 23, 50) + 20 * 60 * 1000, library(2));
  assert.equal(soon.outcome.reason, 'recent', 'ten past midnight is a new day, but twenty minutes is too soon');
  const later = await daily(p, day(2, 1, 0), library(2));
  assert.equal(later.outcome.status, 'created', 'an hour on, it is due');
}

// ---- unchanged since the last copy ----
{
  const p = await profile();
  await daily(p, day(1), library(3));
  const same = await daily(p, day(2), library(3));
  assert.deepEqual(same.outcome, { status: 'skipped', reason: 'unchanged' });
  assert.equal((await listDailyBackups(p.userDataPath)).length, 1, 'no second copy of the same library');
  const changed = await daily(p, day(2), library(4));
  assert.equal(changed.outcome.status, 'created');
}

// ---- the newest five are kept ----
{
  const p = await profile();
  for (let d = 1; d <= 8; d += 1) {
    const { outcome } = await daily(p, day(d), library(d));
    assert.equal(outcome.status, 'created', `day ${d}`);
  }
  const kept = await listDailyBackups(p.userDataPath);
  assert.equal(DAILY_BACKUPS_KEPT, 5);
  assert.equal(kept.length, 5, 'eight days of copies leave five');
  assert.deepEqual(kept.map((backup) => backup.createdAt), [8, 7, 6, 5, 4].map((d) => day(d)), 'the newest five, newest first');
  assert.equal((await folders(p, 'newamp-daily-')).length, 5, 'the old ones are gone from disk');
}

// ---- a damaged library never pushes the good copies out ----
{
  const p = await profile();
  for (let d = 1; d <= 5; d += 1) await daily(p, day(d), library(d));
  const before = (await listDailyBackups(p.userDataPath)).map((backup) => backup.path);
  const damaged = Buffer.concat([library(9).subarray(0, 4096), Buffer.alloc(4096, 0xab)]);
  const { outcome } = await daily(p, day(6), damaged);
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'invalid');
  const after = (await listDailyBackups(p.userDataPath)).map((backup) => backup.path);
  assert.deepEqual(after, before, 'the five good copies are all still there');
  assert.equal((await folders(p, 'newamp-daily-')).length, 5, 'and the bad copy was removed');

  const notSqlite = await daily(p, day(7), Buffer.from('this is not a database file at all, just some text '.repeat(10)));
  assert.equal(notSqlite.outcome.reason, 'invalid', 'a file that is not SQLite at all');
}

// ---- put off for playback, but not for ever ----
{
  const p = await profile();
  const first = await daily(p, day(1, 9), library(1), { defer: () => true });
  assert.equal(first.outcome.status, 'created', 'with no copy at all there is nothing to wait for');
  const playing = await daily(p, day(2, 8), library(2), { defer: () => true });
  assert.deepEqual(playing.outcome, { status: 'skipped', reason: 'deferred' }, 'a copy that falls due while music plays waits');
  assert.equal(playing.snapshots, 0, 'and the database is not copied out of memory meanwhile');
  const almost = await daily(p, day(2, 20), library(2), { defer: () => true });
  assert.equal(almost.outcome.reason, 'deferred', 'still waiting at 35 hours');
  const overdue = await daily(p, day(2, 22), library(2), { defer: () => true });
  assert.equal(overdue.outcome.status, 'created', 'at 37 hours it is made while the music plays');
  assert.equal((await listDailyBackups(p.userDataPath)).length, 2);
  const idle = await daily(p, day(3, 8), library(3), { defer: () => false });
  assert.equal(idle.outcome.status, 'created', 'and it is made as usual when nothing plays');
}

// ---- a copy that cannot be finished leaves no folder behind ----
{
  const p = await profile();
  const realWriteFile = fsp.writeFile;
  fsp.writeFile = async (path, ...rest) => {
    if (/backups[\\/].*library\.db$/.test(String(path))) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return realWriteFile(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(daily(p, day(1), library(1)), /ENOSPC/, 'the failure still reaches the caller');
    await assert.rejects(createSupportBackup({ ...p, now: new Date(Date.UTC(2026, 9, 2)), librarySnapshot: library(1) }), /ENOSPC/);
  } finally {
    fsp.writeFile = realWriteFile;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readdir(join(p.userDataPath, 'backups')), [], 'the half-written folders are removed, settings.json included');
  const retry = await daily(p, day(1), library(1));
  assert.equal(retry.outcome.status, 'created', 'the next attempt starts clean');
}

// ---- a nearly full drive ----
{
  const p = await profile();
  const full = await daily(p, day(1), library(1), { freeBytes: async () => 100 * 1024 * 1024 });
  assert.deepEqual(full.outcome, { status: 'skipped', reason: 'low-disk' });
  assert.equal((await listDailyBackups(p.userDataPath)).length, 0);
  const roomy = await daily(p, day(1), library(1), { freeBytes: async () => 50 * 1024 * 1024 * 1024 });
  assert.equal(roomy.outcome.status, 'created');
}

// ---- two at once ----
{
  const p = await profile();
  const [a, b] = await Promise.all([daily(p, day(1), library(1)), daily(p, day(1), library(1))]);
  const statuses = [a.outcome, b.outcome].map((outcome) => outcome.status === 'created' ? 'created' : outcome.reason).sort();
  assert.deepEqual(statuses, ['busy', 'created']);
  assert.equal((await listDailyBackups(p.userDataPath)).length, 1);
}

// ---- other backups are not touched, and do not count ----
{
  const p = await profile();
  const stamps = [1, 2, 3, 4, 5, 6, 7].map((d) => new Date(Date.UTC(2026, 8, d, 12)));
  for (const now of stamps) {
    await createSupportBackup({ ...p, now, scope: 'library', librarySnapshot: library(1), settingsSnapshot: '{}' });
  }
  const userBackup = await createSupportBackup({ ...p, now: new Date(Date.UTC(2026, 8, 20)) });
  const safetyBefore = await folders(p, 'newamp-auto-backup-');
  assert.equal(safetyBefore.length, 5, 'the safety copies keep their own limit of five');

  for (let d = 1; d <= 7; d += 1) await daily(p, day(d), library(d));
  assert.deepEqual(await folders(p, 'newamp-auto-backup-'), safetyBefore, 'seven daily copies evicted none of the safety copies');
  assert.ok(existsSync(userBackup.backupPath), 'a backup the user made is untouched');
  assert.equal((await folders(p, 'newamp-daily-')).length, 5);

  // And the other way: a safety copy does not count as a daily one or evict one.
  await createSupportBackup({ ...p, now: new Date(Date.UTC(2026, 9, 30)), scope: 'library', librarySnapshot: library(1), settingsSnapshot: '{}' });
  assert.equal((await listDailyBackups(p.userDataPath)).length, 5, 'the daily list is only daily copies');
}

// ---- a folder that only has the name ----
{
  const p = await profile();
  await mkdir(join(p.userDataPath, 'backups', 'newamp-daily-20260101-000000'), { recursive: true });
  await mkdir(join(p.userDataPath, 'backups', 'newamp-daily-20260102-000000'), { recursive: true });
  await writeFile(
    join(p.userDataPath, 'backups', 'newamp-daily-20260102-000000', 'manifest.json'),
    JSON.stringify({ app: 'NewAmp', included: [], createdAt: 1, automatic: true }),
  );
  assert.equal((await listDailyBackups(p.userDataPath)).length, 0, 'no manifest, or one that is not daily, is not one of ours');
  for (let d = 1; d <= 6; d += 1) await daily(p, day(d), library(d));
  assert.ok(existsSync(join(p.userDataPath, 'backups', 'newamp-daily-20260101-000000')), 'and it is never pruned');
}

// ---- the existing restore reads a daily copy ----
{
  const p = await profile();
  const good = library(6);
  const { outcome } = await daily(p, day(1), good);
  await writeFile(p.libraryPath, library(0));
  const restored = await restoreSupportBackup({ ...p, backupPath: outcome.backup.backupPath });
  assert.deepEqual(restored.restored.sort(), ['library.db', 'settings.json']);
  assert.deepEqual(await readFile(p.libraryPath), good, 'library.db is the backed-up one');
  assert.equal(JSON.parse(await readFile(p.settingsPath, 'utf8')).theme, 'classic');
}

// ---- a restore is not undone by a copy that was waiting to be saved before it ----
{
  const p = await profile();
  const libraryWith = async (marker) => {
    const store = await LibraryStore.open(join(p.userDataPath, `scratch-${marker}.db`));
    store.db.run('CREATE TABLE marker (v TEXT)');
    store.db.run('INSERT INTO marker VALUES (?)', [marker]);
    const bytes = Buffer.from(store.db.export());
    store.close();
    return bytes;
  };
  const markerIn = async (file) => {
    const store = await LibraryStore.open(file);
    try {
      return store.db.exec('SELECT v FROM marker')[0].values[0][0];
    } finally {
      store.close();
    }
  };
  const restoredBytes = await libraryWith('restored');
  await writeFile(p.libraryPath, restoredBytes);
  await writeFile(p.settingsPath, JSON.stringify({ theme: 'classic' }));
  const { outcome } = await daily(p, day(1), restoredBytes);
  assert.equal(outcome.status, 'created');
  // The backup is old, and a restore on Windows keeps the date a copied file has.
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (const name of ['library.db', 'settings.json']) await utimes(join(outcome.backup.backupPath, name), longAgo, longAgo);

  // The profile has moved on, and two whole copies of what was newest never got into place.
  await writeFile(p.libraryPath, await libraryWith('live'));
  await writeFile(p.settingsPath, JSON.stringify({ theme: 'terminal' }));
  const later = new Date(Date.now() + 60 * 60 * 1000);
  const unsavedBytes = await libraryWith('unsaved');
  const waiting = [
    [`${p.libraryPath}.tmp-4242-sync`, unsavedBytes],
    [`${p.libraryPath}.tmp-4242-7`, unsavedBytes],
    [`${p.settingsPath}.tmp-4242-sync`, JSON.stringify({ theme: 'amber' })],
    [`${p.settingsPath}.tmp-4242-retry`, JSON.stringify({ theme: 'amber' })],
    [`${p.settingsPath}.tmp-4242-3`, JSON.stringify({ theme: 'amber' })],
  ];
  for (const [path, content] of waiting) {
    await writeFile(path, content);
    await utimes(path, later, later);
  }
  const setAside = [`${p.libraryPath}.unsaved-4242-1`, `${p.libraryPath}.replaced-123`, `${p.settingsPath}.corrupt-20260101-000000`];
  const unrelated = join(p.userDataPath, 'notes.tmp-4242-1');
  for (const path of [...setAside, unrelated]) await writeFile(path, 'kept');

  const startedAt = Date.now();
  await restoreSupportBackup({ ...p, backupPath: outcome.backup.backupPath });
  assert.deepEqual(waiting.map(([path]) => existsSync(path)), waiting.map(() => false), 'the copies from before the restore are gone');
  assert.deepEqual([...setAside, unrelated].map((path) => existsSync(path)), [true, true, true, true], 'copies set aside, and files that are not a writer\'s temp, stay');
  for (const file of [p.libraryPath, p.settingsPath]) {
    assert.ok(statSync(file).mtimeMs >= startedAt - 2000, `${file} is dated from the restore, not from the backup`);
  }
  assert.equal(JSON.parse(await readFile(p.settingsPath, 'utf8')).theme, 'classic');
  assert.equal(new SettingsStore(p.settingsPath).get().theme, 'classic', 'a fresh start loads the restored settings');
  assert.equal(await markerIn(p.libraryPath), 'restored', 'and the restored library');
}

// ---- the setting ----
{
  const p = await profile();
  const file = join(p.userDataPath, 'settings-store.json');
  const store = new SettingsStore(file);
  assert.equal(store.get().autoBackupEnabled, true, 'on for everyone, including profiles from before it existed');
  store.set({ autoBackupEnabled: false });
  assert.equal(new SettingsStore(file).get().autoBackupEnabled, false, 'turning it off sticks');
  store.set({ autoBackupEnabled: true });
  assert.equal(new SettingsStore(file).get().autoBackupEnabled, true);
  await writeFile(file, JSON.stringify({ theme: 'classic' }));
  assert.equal(new SettingsStore(file).get().autoBackupEnabled, true, 'a settings file without the key means on');
}

// ---- main.ts and Settings ----
{
  const main = read('electron/main.ts');
  const run = main.match(/async function runDailyBackup\(\): Promise<void> \{[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.ok(run, 'main.ts has runDailyBackup');
  assert.match(run, /if \(!settings\.get\(\)\.autoBackupEnabled \|\| library\.isClosed\(\) \|\| library\.upgradeError \|\| settings\.isSuppressed\(\)\) \{/, 'off means off, and so is a library that is not the real one');
  assert.match(run, /if \(restoreInProgress \|\| backupInProgress\) \{\s*retryDeferredDailyBackup\(\);\s*return;/, 'not while the stores are being swapped, and a copy put off for playback is asked for again');
  assert.ok(run.indexOf('library.flushPendingWrites()') < run.indexOf('createDailyBackupIfDue('), 'the library is flushed before it is copied');
  assert.match(run, /snapshot: \(\) => \(\{ librarySnapshot: library\.exportSnapshot\(\), settingsSnapshot: settings\.snapshotJson\(\) \}\)/, 'the copy is of the live stores, not a possibly stale file');
  assert.match(run, /backupInProgress \+= 1;[\s\S]*?finally \{\s*backupInProgress -= 1;/, 'a restore cannot start under it');
  assert.match(main, /const DAILY_BACKUP_CHECK_MS = 6 \* 60 \* 60 \* 1000;/);
  const bootstrap = main.slice(main.indexOf('async function bootstrap(): Promise<void> {'));
  assert.match(bootstrap, /\n {2}scheduleDailyBackups\(\);/, 'started at launch');
  const schedule = main.match(/function scheduleDailyBackups\(\): void \{[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.match(schedule, /if \(smokeMode\) return;/, 'smoke runs write no backups');
  assert.match(schedule, /\.unref\(\)/, 'the timers never keep the app alive');
  assert.match(main, /dailyBackups: \{ count: dailyBackups\.length, newestAt: dailyBackups\[0\]\?\.createdAt \?\? null, folder: join\(userData, 'backups'\) \}/, 'diagnostics carry the count and the folder');

  const settingsView = read('src/components/views/SettingsView.tsx');
  assert.match(settingsView, /dailyBackupSummary\(settings\.autoBackupEnabled, supportDiagnostics\.dailyBackups\)/, 'Settings shows the count');
  assert.match(settingsView, /label="Backups folder">\{supportDiagnostics\.dailyBackups\.folder/, 'and the folder');
  assert.match(settingsView, /data-newamp-auto-backup\s+checked=\{settings\.autoBackupEnabled\}/, 'with a switch');
  assert.match(settingsView, /saveSettings\(\{ autoBackupEnabled: e\.target\.checked \}\)/);
  assert.match(settingsView, /api\.showInFolder\(supportDiagnostics\.dailyBackups\.folder\)/, 'and a way to open the folder');
}

await rm(root, { recursive: true, force: true });
console.log('PASS daily backup: one a day, newest five kept, verified before pruning, skipped when unchanged or the drive is full, restorable, switchable');
