import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupportBackup, restoreSupportBackup } from '../dist-electron/electron/support-backup.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'support-restore-smoke');
const userDataPath = join(smokeRoot, 'user-data');
const settingsPath = join(userDataPath, 'settings.json');
const libraryPath = join(userDataPath, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(join(userDataPath, 'art'), { recursive: true });
await mkdir(join(userDataPath, 'playlist-art'), { recursive: true });

await writeFile(settingsPath, JSON.stringify({ theme: 'oxide', libraryRoots: ['K:/music'] }), 'utf8');
await writeFile(libraryPath, Buffer.from('original library'));
await writeFile(join(userDataPath, 'art', 'cover.bin'), Buffer.from('original cover'));
await writeFile(join(userDataPath, 'playlist-art', 'icon.bin'), Buffer.from('original icon'));
await writeFile(join(userDataPath, 'lastfm-scrobbles.json'), JSON.stringify({ queue: ['original'] }), 'utf8');

const backup = await createSupportBackup({
  userDataPath,
  settingsPath,
  libraryPath,
  now: new Date('2026-05-15T05:00:00.000Z'),
});

await writeFile(settingsPath, JSON.stringify({ theme: 'mono', libraryRoots: [] }), 'utf8');
await writeFile(libraryPath, Buffer.from('mutated library'));
await writeFile(join(userDataPath, 'art', 'cover.bin'), Buffer.from('mutated cover'));
await writeFile(join(userDataPath, 'art', 'extra.bin'), Buffer.from('remove me'));
await writeFile(join(userDataPath, 'playlist-art', 'icon.bin'), Buffer.from('mutated icon'));
await writeFile(join(userDataPath, 'lastfm-scrobbles.json'), JSON.stringify({ queue: ['mutated'] }), 'utf8');

const safety = await createSupportBackup({
  userDataPath,
  settingsPath,
  libraryPath,
  now: new Date('2026-05-15T05:05:00.000Z'),
});

const restored = await restoreSupportBackup({
  userDataPath,
  settingsPath,
  libraryPath,
  backupPath: backup.backupPath,
  safetyBackupPath: safety.backupPath,
  now: new Date('2026-05-15T05:10:00.000Z'),
});

assert.equal(restored.backupPath, backup.backupPath);
assert.equal(restored.safetyBackupPath, safety.backupPath);
assert.equal(restored.restoredAt, Date.parse('2026-05-15T05:10:00.000Z'));
assert.equal(restored.restartRequired, true);
assert.deepEqual(
  restored.restored,
  ['settings.json', 'library.db', 'art', 'playlist-art', 'lastfm-scrobbles.json'],
);
assert.match(await readFile(settingsPath, 'utf8'), /oxide/);
assert.equal(String(await readFile(libraryPath)), 'original library');
assert.equal(String(await readFile(join(userDataPath, 'art', 'cover.bin'))), 'original cover');
assert.equal(existsSync(join(userDataPath, 'art', 'extra.bin')), false, 'restored art dir should replace stale files');
assert.equal(String(await readFile(join(userDataPath, 'playlist-art', 'icon.bin'))), 'original icon');
assert.match(await readFile(join(userDataPath, 'lastfm-scrobbles.json'), 'utf8'), /original/);
assert.ok(existsSync(join(safety.backupPath, 'settings.json')), 'restore should keep a pre-restore safety backup');

await assert.rejects(
  () => restoreSupportBackup({
    userDataPath,
    settingsPath,
    libraryPath,
    backupPath: join(smokeRoot, 'not-a-newamp-backup'),
  }),
  /manifest/i,
);

const [typesSource, mainSource, preloadSource, apiSource, settingsViewSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /SupportRestoreResult/, 'shared types should expose support restore result');
assert.match(mainSource, /app:restore-backup/, 'main process should register restore IPC');
assert.match(preloadSource, /restoreSupportBackup/, 'preload should expose backup restore');
assert.match(apiSource, /restoreSupportBackup/, 'browser-safe API should include backup restore');
assert.match(settingsViewSource, /Restore backup/, 'Settings should expose support restore action');
assert.match(packageSource, /smoke:support-restore/, 'package scripts should include support restore smoke');

console.log(JSON.stringify({ ok: true, restored }, null, 2));
