import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import type { SupportBackupResult, SupportRestoreResult } from '../shared/types.js';
import { renameRetryingAsync } from './recovery.js';

export interface SupportBackupInput {
  userDataPath: string;
  settingsPath: string;
  libraryPath: string;
  now?: Date | number;
  // In-memory snapshots that must be used instead of reading the live file
  // off disk. LibraryStore batches library.db writes (800ms, 30s for play/
  // skip stats) and SettingsStore debounces the resumeState autosave, so a
  // plain file copy can be stale relative to what's actually committed in
  // memory. The support-backup coordinator in main.ts pulls these straight
  // out of the live stores (LibraryStore.exportSnapshot() /
  // SettingsStore.snapshotJson()) right before calling createSupportBackup.
  librarySnapshot?: Buffer;
  settingsSnapshot?: string;
  // 'full' (the default, the Settings backup) copies the whole profile, art
  // stores included. 'library' is the safety copy taken before a trash or a
  // prune: library.db and settings.json only, since neither operation touches
  // art and the scanner rebuilds it anyway, and copying ~1 GB of covers per
  // trashed track filled drives. Those are named newamp-auto-backup-* and
  // only the newest AUTO_BACKUPS_KEPT are kept; user-made backups are never
  // touched. 'daily' is the same two files under its own name, written by
  // createDailyBackupIfDue, which owns its retention: the safety copies above
  // would otherwise be evicted by five days of routine ones.
  scope?: 'full' | 'library' | 'daily';
}

const AUTO_BACKUP_PREFIX = 'newamp-auto-backup-';
const AUTO_BACKUPS_KEPT = 5;
const DAILY_BACKUP_PREFIX = 'newamp-daily-';
export const DAILY_BACKUPS_KEPT = 5;
const LIBRARY_SCOPE_LABELS = new Set(['settings.json', 'library.db']);

export interface SupportRestoreInput extends SupportBackupInput {
  backupPath: string;
  safetyBackupPath?: string | null;
}

interface BackupCandidate {
  label: string;
  source: string;
  target: string;
}

interface BackupManifest {
  app: string;
  filesCopied: number;
  included: string[];
  createdAt?: number;
  automatic?: boolean;
  daily?: boolean;
  librarySha256?: string;
}

let restoreQueue: Promise<unknown> = Promise.resolve();
let restoreSql: ReturnType<typeof initSqlJs> | null = null;
const require = createRequire(import.meta.url);

export async function createSupportBackup(input: SupportBackupInput): Promise<SupportBackupResult> {
  const userDataPath = resolve(input.userDataPath);
  const createdAt = input.now instanceof Date ? input.now.getTime() : Number(input.now ?? Date.now());
  const daily = input.scope === 'daily';
  const automatic = input.scope === 'library' || daily;
  const backupsRoot = join(userDataPath, 'backups');
  const prefix = daily ? DAILY_BACKUP_PREFIX : automatic ? AUTO_BACKUP_PREFIX : 'newamp-backup-';
  const backupPath = await uniqueBackupPath(backupsRoot, `${prefix}${formatBackupStamp(createdAt)}`);
  ensureInside(userDataPath, backupPath);
  await mkdir(backupPath, { recursive: true });

  const candidates = backupCandidates(userDataPath, input.settingsPath, input.libraryPath, backupPath)
    .filter((candidate) => !automatic || LIBRARY_SCOPE_LABELS.has(candidate.label));

  let filesCopied = 0;
  const included: string[] = [];
  for (const candidate of candidates) {
    const copied = await writeCandidate(userDataPath, backupsRoot, candidate, input);
    if (copied > 0) {
      filesCopied += copied;
      included.push(candidate.label);
    }
  }

  const manifest = {
    app: 'NewAmp',
    createdAt,
    userDataPath,
    filesCopied,
    included,
    automatic,
    ...(daily ? { daily, librarySha256: input.librarySnapshot ? sha256(input.librarySnapshot) : undefined } : {}),
  };
  await writeFile(join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (input.scope === 'library') await pruneAutomaticBackups(backupsRoot, backupPath);

  return { backupPath, createdAt, filesCopied, included };
}

// Drops the oldest automatic backups past AUTO_BACKUPS_KEPT, never the one
// just written. Both the folder name and the manifest have to say automatic:
// a user-made backup copied or renamed into the folder is not deleted.
async function pruneAutomaticBackups(backupsRoot: string, keepPath: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(backupsRoot)).filter((name) => name.startsWith(AUTO_BACKUP_PREFIX));
  } catch {
    return;
  }
  const automatic: Array<{ path: string; createdAt: number }> = [];
  for (const name of names) {
    const path = join(backupsRoot, name);
    if (resolve(path) === resolve(keepPath)) continue;
    try {
      const manifest = await readBackupManifest(path);
      if (manifest.automatic !== true) continue;
      automatic.push({ path, createdAt: Number(manifest.createdAt) || 0 });
    } catch {
      // Not a readable backup; leave it alone.
    }
  }
  automatic.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
  // The one just written is the newest and counts toward the limit.
  for (const stale of automatic.slice(AUTO_BACKUPS_KEPT - 1)) {
    try {
      await rm(stale.path, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.warn(`[newamp] old automatic backup could not be removed: ${stale.path}`, err);
    }
  }
}

export interface DailyBackupInfo {
  path: string;
  createdAt: number;
  librarySha256: string | null;
}

// The daily copies, newest first. A folder with the right name whose manifest
// does not say daily (or cannot be read) is not one of ours and is left out.
export async function listDailyBackups(userDataPath: string): Promise<DailyBackupInfo[]> {
  const backupsRoot = join(resolve(userDataPath), 'backups');
  let names: string[];
  try {
    names = (await readdir(backupsRoot)).filter((name) => name.startsWith(DAILY_BACKUP_PREFIX));
  } catch {
    return [];
  }
  const found: DailyBackupInfo[] = [];
  for (const name of names) {
    const path = join(backupsRoot, name);
    try {
      const manifest = await readBackupManifest(path);
      if (manifest.daily !== true) continue;
      found.push({ path, createdAt: Number(manifest.createdAt) || 0, librarySha256: manifest.librarySha256 ?? null });
    } catch {
      // Not a readable backup; leave it alone.
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
}

export interface DailyBackupInput {
  userDataPath: string;
  settingsPath: string;
  libraryPath: string;
  now?: Date | number;
  // Called only once a backup is due, since taking the library snapshot copies
  // the whole database. Reads the live stores' memory, like the manual backup.
  snapshot: () => { librarySnapshot: Buffer; settingsSnapshot: string };
  // Free bytes on the profile's drive, or null when unknown. Injected for tests.
  freeBytes?: (path: string) => Promise<number | null>;
}

export type DailyBackupOutcome =
  | { status: 'created'; backup: SupportBackupResult }
  | { status: 'skipped'; reason: 'recent' | 'unchanged' | 'low-disk' | 'busy' | 'invalid'; detail?: string };

const DAILY_MIN_GAP_MS = 60 * 60 * 1000;
// library.db is the one big file (60 MB is ordinary, several times that is not
// rare), and five copies of it are kept. Leave the drive at least this much
// room afterwards rather than be the thing that fills it.
const DAILY_FREE_SPACE_FLOOR = 512 * 1024 * 1024;

let dailyBackupRunning = false;

// One copy of library.db and settings.json a day, the newest five kept. It is
// skipped when today already has one, when the library is byte-for-byte what
// the newest copy holds, or when the drive is nearly full. The new copy is
// checked with SQLite before anything old is removed, so a damaged library
// can never push the good copies out.
export async function createDailyBackupIfDue(input: DailyBackupInput): Promise<DailyBackupOutcome> {
  if (dailyBackupRunning) return { status: 'skipped', reason: 'busy' };
  dailyBackupRunning = true;
  try {
    const now = input.now instanceof Date ? input.now.getTime() : Number(input.now ?? Date.now());
    const existing = await listDailyBackups(input.userDataPath);
    const newest = existing[0] ?? null;
    if (!dailyBackupDue(newest ? newest.createdAt : null, now)) return { status: 'skipped', reason: 'recent' };

    const snapshot = input.snapshot();
    if (newest?.librarySha256 && newest.librarySha256 === sha256(snapshot.librarySnapshot)) {
      return { status: 'skipped', reason: 'unchanged' };
    }
    const free = await (input.freeBytes ?? freeBytesOn)(resolve(input.userDataPath));
    const needed = snapshot.librarySnapshot.length + Buffer.byteLength(snapshot.settingsSnapshot);
    if (free !== null && free - needed < DAILY_FREE_SPACE_FLOOR) return { status: 'skipped', reason: 'low-disk' };

    const backup = await createSupportBackup({
      userDataPath: input.userDataPath,
      settingsPath: input.settingsPath,
      libraryPath: input.libraryPath,
      now,
      scope: 'daily',
      ...snapshot,
    });
    try {
      if (!backup.included.includes('library.db')) throw new Error('The copy has no library.db.');
      await validateLibrarySnapshot(join(backup.backupPath, 'library.db'), 'quick_check');
    } catch (err) {
      await rm(backup.backupPath, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      return { status: 'skipped', reason: 'invalid', detail: errorMessage(err) };
    }
    await pruneDailyBackups(input.userDataPath, backup.backupPath);
    return { status: 'created', backup };
  } finally {
    dailyBackupRunning = false;
  }
}

// At most one a local calendar day, and never two within the hour, so a clock
// change or midnight rollover does not write a pair back to back.
function dailyBackupDue(newestAt: number | null, now: number): boolean {
  if (newestAt === null) return true;
  if (now - newestAt < DAILY_MIN_GAP_MS) return false;
  const last = new Date(newestAt);
  const today = new Date(now);
  return last.getFullYear() !== today.getFullYear()
    || last.getMonth() !== today.getMonth()
    || last.getDate() !== today.getDate();
}

async function pruneDailyBackups(userDataPath: string, keepPath: string): Promise<void> {
  const all = await listDailyBackups(userDataPath);
  const others = all.filter((backup) => resolve(backup.path) !== resolve(keepPath));
  // The one just written is the newest and counts toward the limit.
  for (const stale of others.slice(DAILY_BACKUPS_KEPT - 1)) {
    try {
      await rm(stale.path, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.warn(`[newamp] old daily backup could not be removed: ${stale.path}`, err);
    }
  }
}

async function freeBytesOn(path: string): Promise<number | null> {
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function restoreSupportBackup(input: SupportRestoreInput): Promise<SupportRestoreResult> {
  const pending = restoreQueue.then(() => restoreSupportBackupNow(input));
  restoreQueue = pending.catch(() => undefined);
  return pending;
}

async function restoreSupportBackupNow(input: SupportRestoreInput): Promise<SupportRestoreResult> {
  const userDataPath = resolve(input.userDataPath);
  const backupPath = resolve(input.backupPath);
  const restoredAt = input.now instanceof Date ? input.now.getTime() : Number(input.now ?? Date.now());
  const manifest = await readBackupManifest(backupPath);
  const included = new Set(manifest.included);
  const candidates = backupCandidates(userDataPath, input.settingsPath, input.libraryPath, backupPath)
    .filter((candidate) => included.has(candidate.label));
  if (!candidates.length || candidates.length !== included.size) throw new Error('Backup contains unsupported or no restore members.');
  const restored: string[] = [];
  const backupsRoot = join(userDataPath, 'backups');
  await mkdir(backupsRoot, { recursive: true });
  const transactionPath = await mkdtemp(join(backupsRoot, '.restore-'));
  const entries = candidates.map((candidate) => ({
    ...candidate,
    staged: join(transactionPath, 'staged', candidate.label),
    original: join(transactionPath, 'originals', candidate.label),
    displaced: false,
    installed: false,
  }));
  try {
    // Nothing in the live profile changes until every member has been read
    // and copied successfully. Staging beside the profile keeps renames on
    // the same filesystem; if anything fails, originals remain available for
    // manual recovery.
    for (const entry of entries) {
      ensureInside(userDataPath, resolve(entry.source));
      const info = await lstat(entry.target);
      const directory = entry.label === 'art' || entry.label === 'playlist-art';
      if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
        throw new Error(`Invalid backup member type: ${entry.label}`);
      }
      if (directory) await copyDirectory(entry.target, entry.staged, null, true);
      else {
        await mkdir(dirname(entry.staged), { recursive: true });
        await copyFile(entry.target, entry.staged);
        if (entry.label.endsWith('.json')) JSON.parse(await readFile(entry.staged, 'utf8'));
        if (entry.label === 'library.db') await validateLibrarySnapshot(entry.staged);
      }
      // A live symlink could redirect the transaction outside the profile.
      try {
        const current = await lstat(entry.source);
        if (current.isSymbolicLink() || (directory ? !current.isDirectory() : !current.isFile())) {
          throw new Error(`Invalid live member type: ${entry.label}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    await mkdir(join(transactionPath, 'originals'), { recursive: true });
    await writeFile(join(transactionPath, 'transaction.json'), JSON.stringify({ backupPath, members: entries.map((e) => e.label) }));
    // The stores have only just closed library.db and settings.json, and
    // antivirus or the indexer often still holds them for a moment: every
    // move here and in the rollback rides out EPERM/EBUSY instead of failing
    // the restore half-way.
    for (const entry of entries) {
      try {
        await renameRetryingAsync(entry.source, entry.original);
        entry.displaced = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await renameRetryingAsync(entry.staged, entry.source);
      entry.installed = true;
      restored.push(entry.label);
    }
  } catch (err) {
    const rollbackErrors: string[] = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.installed) await renameRetryingAsync(entry.source, entry.staged);
        if (entry.displaced) await renameRetryingAsync(entry.original, entry.source);
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.label}: ${errorMessage(rollbackError)}`);
      }
    }
    const rollback = rollbackErrors.length ? ` Rollback incomplete: ${rollbackErrors.join('; ')}.` : ' Original profile restored.';
    throw new Error(`Could not restore backup: ${errorMessage(err)}.${rollback} Recovery files: ${transactionPath}`);
  }

  // Committed. The transaction folder holds a full copy of the old profile
  // (library.db and all art), which the pre-restore safety backup already
  // has; keeping it would leak a profile-sized copy on every restore. A
  // failed restore never gets here, so its recovery files stay put.
  try {
    await rm(transactionPath, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`[newamp] restore succeeded but its working copy could not be removed: ${transactionPath}`, err);
  }

  return {
    backupPath,
    safetyBackupPath: input.safetyBackupPath ?? null,
    restoredAt,
    restored,
    restartRequired: true,
  };
}

async function validateLibrarySnapshot(path: string, check: 'integrity_check' | 'quick_check' = 'integrity_check'): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') {
    throw new Error('Backup library.db is not a complete SQLite database.');
  }
  restoreSql ??= initSqlJs({ locateFile: (file) => join(dirname(require.resolve('sql.js')), file) });
  const SQL = await restoreSql;
  const database = new SQL.Database(bytes);
  try {
    const results = database.exec(`PRAGMA ${check}`);
    const values = results[0]?.values;
    if (values?.length !== 1 || values[0]?.[0] !== 'ok') {
      throw new Error('Backup library.db failed its SQLite integrity check.');
    }
  } finally {
    database.close();
  }
}

function backupCandidates(
  userDataPath: string,
  settingsPath: string,
  libraryPath: string,
  backupPath: string,
): BackupCandidate[] {
  return [
    { label: 'settings.json', source: settingsPath, target: join(backupPath, 'settings.json') },
    { label: 'library.db', source: libraryPath, target: join(backupPath, 'library.db') },
    { label: 'art', source: join(userDataPath, 'art'), target: join(backupPath, 'art') },
    { label: 'playlist-art', source: join(userDataPath, 'playlist-art'), target: join(backupPath, 'playlist-art') },
    {
      label: 'lastfm-scrobbles.json',
      source: join(userDataPath, 'lastfm-scrobbles.json'),
      target: join(backupPath, 'lastfm-scrobbles.json'),
    },
    { label: 'podcasts.json', source: join(userDataPath, 'podcasts.json'), target: join(backupPath, 'podcasts.json') },
  ];
}

async function uniqueBackupPath(backupsRoot: string, baseName: string): Promise<string> {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const candidate = join(backupsRoot, `${baseName}${suffix}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('Unable to create a unique backup folder.');
}

// Writes one backup candidate: settings.json/library.db use an in-memory
// snapshot when the caller supplied one (see SupportBackupInput), everything
// else always copies from disk.
async function writeCandidate(
  userDataPath: string,
  backupsRoot: string,
  candidate: BackupCandidate,
  input: SupportBackupInput,
): Promise<number> {
  if (candidate.label === 'library.db' && input.librarySnapshot) {
    await mkdir(dirname(candidate.target), { recursive: true });
    await writeFile(candidate.target, input.librarySnapshot);
    return 1;
  }
  if (candidate.label === 'settings.json' && input.settingsSnapshot !== undefined) {
    await mkdir(dirname(candidate.target), { recursive: true });
    await writeFile(candidate.target, input.settingsSnapshot, 'utf8');
    return 1;
  }
  return copyCandidate(userDataPath, backupsRoot, candidate);
}

async function copyCandidate(userDataPath: string, backupsRoot: string, candidate: BackupCandidate): Promise<number> {
  const source = resolve(candidate.source);
  ensureInside(userDataPath, source);
  if (isInside(backupsRoot, source)) return 0;
  try {
    const info = await stat(source);
    if (info.isFile()) {
      await mkdir(dirname(candidate.target), { recursive: true });
      await copyFile(source, candidate.target);
      return 1;
    }
    if (info.isDirectory()) {
      return copyDirectory(source, candidate.target, backupsRoot);
    }
  } catch {
    return 0;
  }
  return 0;
}

async function copyDirectory(source: string, target: string, excludedRoot: string | null, strict = false): Promise<number> {
  if (excludedRoot && isInside(excludedRoot, source)) return 0;
  await mkdir(target, { recursive: true });
  let copied = 0;
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) copied += await copyDirectory(sourcePath, targetPath, excludedRoot, strict);
    else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
      copied += 1;
    } else if (strict) {
      throw new Error(`Unsupported backup entry: ${sourcePath}`);
    }
  }
  return copied;
}

async function readBackupManifest(backupPath: string): Promise<BackupManifest> {
  let parsed: Partial<BackupManifest>;
  try {
    parsed = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8')) as Partial<BackupManifest>;
  } catch (err) {
    throw new Error(`Backup manifest could not be read: ${errorMessage(err)}`);
  }
  if (!['NewAmp', 'Newamp'].includes(String(parsed.app ?? '')) || !Array.isArray(parsed.included)) {
    throw new Error('Backup manifest is not a NewAmp support backup.');
  }
  return {
    app: String(parsed.app),
    filesCopied: Math.max(0, Math.trunc(Number(parsed.filesCopied) || 0)),
    included: parsed.included.filter((item): item is string => typeof item === 'string'),
    createdAt: Number(parsed.createdAt) || 0,
    automatic: parsed.automatic === true,
    daily: parsed.daily === true,
    librarySha256: typeof parsed.librarySha256 === 'string' ? parsed.librarySha256 : undefined,
  };
}

function ensureInside(root: string, child: string): void {
  if (!isInside(root, child)) throw new Error(`Backup path escaped user data: ${child}`);
}

function isInside(root: string, child: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const normalizedChild = process.platform === 'win32' ? resolve(child).toLowerCase() : resolve(child);
  return normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}${sep}`);
}

function formatBackupStamp(value: number): string {
  const date = new Date(Number.isFinite(value) ? value : Date.now());
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
