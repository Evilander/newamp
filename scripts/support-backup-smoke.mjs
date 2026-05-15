import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupportBackup } from '../dist-electron/electron/support-backup.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'support-backup-smoke');
const userDataPath = join(smokeRoot, 'user-data');
const settingsPath = join(userDataPath, 'settings.json');
const libraryPath = join(userDataPath, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(join(userDataPath, 'art'), { recursive: true });
await mkdir(join(userDataPath, 'playlist-art'), { recursive: true });
await mkdir(join(userDataPath, 'backups', 'old-backup'), { recursive: true });

await writeFile(settingsPath, JSON.stringify({ theme: 'classic', libraryRoots: ['K:/music'] }), 'utf8');
await writeFile(libraryPath, Buffer.from('library fixture'));
await writeFile(join(userDataPath, 'art', 'cover.bin'), Buffer.from('cover art'));
await writeFile(join(userDataPath, 'playlist-art', 'icon.bin'), Buffer.from('playlist icon'));
await writeFile(join(userDataPath, 'lastfm-scrobbles.json'), JSON.stringify({ queue: [] }), 'utf8');
await writeFile(join(userDataPath, 'backups', 'old-backup', 'skip.txt'), 'skip this', 'utf8');

const result = await createSupportBackup({
  userDataPath,
  settingsPath,
  libraryPath,
  now: new Date('2026-05-15T03:45:00.000Z'),
});

assert.equal(result.createdAt, Date.parse('2026-05-15T03:45:00.000Z'));
assert.ok(result.backupPath.endsWith(join('backups', 'newamp-backup-20260515-034500')));
assert.ok(result.filesCopied >= 5, 'backup should include files and nested art assets');
assert.ok(existsSync(join(result.backupPath, 'settings.json')), 'settings should be backed up');
assert.ok(existsSync(join(result.backupPath, 'library.db')), 'library DB should be backed up');
assert.ok(existsSync(join(result.backupPath, 'art', 'cover.bin')), 'album art store should be backed up');
assert.ok(existsSync(join(result.backupPath, 'playlist-art', 'icon.bin')), 'playlist art store should be backed up');
assert.ok(existsSync(join(result.backupPath, 'lastfm-scrobbles.json')), 'Last.fm outbox should be backed up');
assert.equal(existsSync(join(result.backupPath, 'backups', 'old-backup', 'skip.txt')), false, 'backup should not recursively copy old backups');

const manifest = JSON.parse(await readFile(join(result.backupPath, 'manifest.json'), 'utf8'));
assert.equal(manifest.app, 'Newamp');
assert.equal(manifest.filesCopied, result.filesCopied);
assert.deepEqual(manifest.included, result.included);

const duplicateSecond = await createSupportBackup({
  userDataPath,
  settingsPath,
  libraryPath,
  now: new Date('2026-05-15T03:45:00.000Z'),
});
assert.notEqual(duplicateSecond.backupPath, result.backupPath, 'same-second backups should not reuse the same folder');
assert.ok(duplicateSecond.backupPath.endsWith(join('backups', 'newamp-backup-20260515-034500-2')));
assert.equal(existsSync(join(duplicateSecond.backupPath, 'backups', 'old-backup', 'skip.txt')), false);

const [typesSource, mainSource, preloadSource, apiSource, settingsViewSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /SupportBackupResult/, 'shared types should expose support backup result');
assert.match(mainSource, /app:create-backup/, 'main process should register backup IPC');
assert.match(preloadSource, /createSupportBackup/, 'preload should expose backup creation');
assert.match(apiSource, /createSupportBackup/, 'browser-safe API should include backup creation');
assert.match(settingsViewSource, /Create backup/, 'Settings should expose support backup action');
assert.match(packageSource, /smoke:support-backup/, 'package scripts should include support backup smoke');

console.log(JSON.stringify({ ok: true, backupPath: result.backupPath, filesCopied: result.filesCopied }, null, 2));
