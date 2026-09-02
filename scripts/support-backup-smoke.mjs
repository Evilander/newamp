import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupportBackup } from '../dist-electron/electron/support-backup.js';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { SettingsStore } from '../dist-electron/electron/settings.js';
import initSqlJs from 'sql.js';

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
assert.equal(manifest.app, 'NewAmp');
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

// --- Backups come from the live stores, not from whatever is on disk ---------
//
// LibraryStore batches its library.db write (up to 30 s for play/skip stats)
// and SettingsStore debounces the resumeState autosave, so copying the files
// off disk can miss the newest state. The backup coordinator in main.ts hands
// createSupportBackup in-memory snapshots instead; this proves those snapshots
// carry a mutation made a moment earlier, and that the disk copy would not.
{
  const liveRoot = join(smokeRoot, 'live-user-data');
  await mkdir(liveRoot, { recursive: true });
  const liveLibraryPath = join(liveRoot, 'library.db');
  const liveSettingsPath = join(liveRoot, 'settings.json');

  const library = new LibraryStore(liveLibraryPath);
  await library.init();
  library.upsertTracks([{
    path: 'K:/music/live/track.mp3', title: 'Live', artist: 'Snapshot', album: 'Backup', albumArtist: 'Snapshot',
    trackNo: 1, discNo: 1, year: 2026, genre: 'Test', duration: 180, bitrate: 320, sampleRate: 44100,
    replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
  }]);
  library.flushSync?.();
  const trackId = library.getTracks({ sort: 'title', limit: 1, offset: 0 })[0].id;
  library.recordPlay(trackId);
  // Not flushed: the play count lives only in memory right now.

  const settings = new SettingsStore(liveSettingsPath);
  settings.set({
    resumeState: { queueTrackIds: [trackId], index: 0, currentTime: 42.5, mode: 'normal', updatedAt: Date.now() },
  });
  // Also debounced: settings.json on disk has not seen resumeState yet.

  const liveBackup = await createSupportBackup({
    userDataPath: liveRoot,
    settingsPath: liveSettingsPath,
    libraryPath: liveLibraryPath,
    librarySnapshot: library.exportSnapshot(),
    settingsSnapshot: settings.snapshotJson(),
    now: new Date('2026-05-15T04:00:00.000Z'),
  });

  const SQL = await initSqlJs();
  const backedUp = new SQL.Database(await readFile(join(liveBackup.backupPath, 'library.db')));
  const played = backedUp.exec(`SELECT play_count FROM tracks WHERE id = ${trackId}`)[0]?.values?.[0]?.[0];
  backedUp.close();
  assert.equal(played, 1, 'a play recorded a moment before the backup must be in the backed-up library');

  const backedUpSettings = JSON.parse(await readFile(join(liveBackup.backupPath, 'settings.json'), 'utf8'));
  assert.equal(backedUpSettings.resumeState?.currentTime, 42.5, 'a resumeState set a moment before the backup must be in the backed-up settings');

  // And the disk copies really were behind — the reason the snapshots exist.
  const diskSettings = JSON.parse(await readFile(liveSettingsPath, 'utf8'));
  assert.notEqual(diskSettings.resumeState?.currentTime, 42.5, 'settings.json on disk should still be behind the live store at this point');

  // Draining an in-flight write must resolve, and must not be needed for the
  // snapshot to be current.
  await library.waitForPendingWrites();
  await settings.waitForPendingWrites();
  library.close();
  settings.flushSync();
}

// main.ts wiring: the IPC handlers must quiesce, snapshot from live stores, and
// resume even when the backup throws; restore must stop mutation sources
// before taking its safety snapshot and drain in-flight writes before it
// replaces either file.
{
  const mainSource = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const createHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('app:create-backup'"), mainSource.indexOf("ipcMain.handle('app:restore-backup'"));
  assert.match(createHandler, /await quiesceLibraryMutations\(\);\s*try \{\s*return await createBackupFromLiveStores\(userData\);\s*\} finally \{\s*resumeLibraryMutations\(\);/, 'create-backup must quiesce, snapshot from live stores, and always resume');
  const restoreHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('app:restore-backup'"), mainSource.indexOf("ipcMain.handle('app:restore-backup'") + 4000);
  const stopIdx = restoreHandler.indexOf('libraryWatcher?.stop()');
  const safetyIdx = restoreHandler.indexOf('createBackupFromLiveStores(userData)');
  const drainIdx = restoreHandler.indexOf('await library?.waitForPendingWrites()');
  const closeIdx = restoreHandler.indexOf('library?.close()');
  assert.ok(stopIdx > 0 && safetyIdx > stopIdx, 'restore must stop the watcher before taking the safety snapshot');
  assert.ok(drainIdx > safetyIdx && closeIdx > drainIdx, 'restore must drain in-flight library writes before closing and replacing the file');
  assert.match(mainSource, /librarySnapshot: library\.exportSnapshot\(\)/, 'backups must snapshot the live library');
  assert.match(mainSource, /settingsSnapshot: settings\.snapshotJson\(\)/, 'backups must snapshot the live settings');
}

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
