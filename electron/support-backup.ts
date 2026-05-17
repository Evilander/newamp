import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { SupportBackupResult, SupportRestoreResult } from '../shared/types.js';

export interface SupportBackupInput {
  userDataPath: string;
  settingsPath: string;
  libraryPath: string;
  now?: Date | number;
}

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
}

export async function createSupportBackup(input: SupportBackupInput): Promise<SupportBackupResult> {
  const userDataPath = resolve(input.userDataPath);
  const createdAt = input.now instanceof Date ? input.now.getTime() : Number(input.now ?? Date.now());
  const backupsRoot = join(userDataPath, 'backups');
  const backupPath = await uniqueBackupPath(backupsRoot, `newamp-backup-${formatBackupStamp(createdAt)}`);
  ensureInside(userDataPath, backupPath);
  await mkdir(backupPath, { recursive: true });

  const candidates = backupCandidates(userDataPath, input.settingsPath, input.libraryPath, backupPath);

  let filesCopied = 0;
  const included: string[] = [];
  for (const candidate of candidates) {
    const copied = await copyCandidate(userDataPath, backupsRoot, candidate);
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
  };
  await writeFile(join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return { backupPath, createdAt, filesCopied, included };
}

export async function restoreSupportBackup(input: SupportRestoreInput): Promise<SupportRestoreResult> {
  const userDataPath = resolve(input.userDataPath);
  const backupPath = resolve(input.backupPath);
  const restoredAt = input.now instanceof Date ? input.now.getTime() : Number(input.now ?? Date.now());
  const manifest = await readBackupManifest(backupPath);
  const included = new Set(manifest.included);
  const candidates = backupCandidates(userDataPath, input.settingsPath, input.libraryPath, backupPath);
  const restored: string[] = [];

  for (const candidate of candidates) {
    if (!included.has(candidate.label)) continue;
    const copied = await restoreCandidate(userDataPath, candidate);
    if (copied > 0) restored.push(candidate.label);
  }

  return {
    backupPath,
    safetyBackupPath: input.safetyBackupPath ?? null,
    restoredAt,
    restored,
    restartRequired: true,
  };
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

async function restoreCandidate(userDataPath: string, candidate: BackupCandidate): Promise<number> {
  const source = resolve(candidate.target);
  const target = resolve(candidate.source);
  ensureInside(userDataPath, target);
  try {
    const info = await stat(source);
    if (info.isFile()) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      return 1;
    }
    if (info.isDirectory()) {
      await rm(target, { recursive: true, force: true });
      return copyDirectory(source, target, null);
    }
  } catch (err) {
    throw new Error(`Could not restore ${candidate.label}: ${errorMessage(err)}`);
  }
  return 0;
}

async function copyDirectory(source: string, target: string, excludedRoot: string | null): Promise<number> {
  if (excludedRoot && isInside(excludedRoot, source)) return 0;
  await mkdir(target, { recursive: true });
  let copied = 0;
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) copied += await copyDirectory(sourcePath, targetPath, excludedRoot);
    else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
      copied += 1;
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
  };
}

function ensureInside(root: string, child: string): void {
  if (!isInside(root, child)) throw new Error(`Backup path escaped user data: ${child}`);
}

function isInside(root: string, child: string): boolean {
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedChild = resolve(child).toLowerCase();
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
