import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { open as fsOpen, readFile as fsReadFile, rename as fsRename, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises';
import type { RecoveryEvent } from '../shared/types.js';

export function quarantineCorruptFile(
  filePath: string,
  store: RecoveryEvent['store'],
  reason: string,
): RecoveryEvent | null {
  if (!existsSync(filePath)) return null;
  const recoveredAt = Date.now();
  const backupPath = `${filePath}.corrupt-${stamp(recoveredAt)}`;
  try {
    renameSync(filePath, backupPath);
  } catch {
    copyFileSync(filePath, backupPath);
    try {
      unlinkSync(filePath);
    } catch (err) {
      // A locked original must never take down startup — leave it in place
      // and continue with an in-memory database; it gets replaced on the
      // next successful flush instead.
      console.warn(`[newamp] could not remove ${filePath} after backing it up:`, err);
    }
  }
  return { store, filePath, backupPath, reason, recoveredAt };
}

const TRANSIENT_IO_CODES = new Set(['EBUSY', 'EPERM', 'EAGAIN']);

// A locked/unavailable file is not corruption — quarantining on those errors
// silently reset whole libraries. Callers retry these with backoff and then
// surface a clear error instead of entering the recovery path.
export function isTransientIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_IO_CODES.has(code);
}

export function recoveryReason(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err || 'Unknown recovery error');
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
}

// Crash-safe file replacement: write to a sibling temp file, fsync it, then
// rename over the target (rename is atomic on the same volume). A crash or
// power loss mid-write can only ever lose the temp file — never truncate the
// target, which is what the old in-place writeFileSync did to library.db and
// settings.json.
export function atomicWriteFileSync(filePath: string, data: Buffer | string): void {
  // The "-sync" suffix matters: an async flush of the same file may have an open
  // fd on its own temp file right now. Sharing one temp path would let this
  // write truncate that inode, rename it into place, and then have the async
  // write's pending bytes land inside the live file at its old offset.
  const tmp = `${filePath}.tmp-${process.pid}-sync`;
  try {
    durableWriteFileSync(tmp, data);
    renameOverExistingSync(tmp, filePath);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone with the rename, or nothing left to clean up */
    }
  }
}

// Callers that must run a staleness check between the write and the rename
// (LibraryStore.flushAsync / SettingsStore.persistAsync drop a snapshot that a
// synchronous quit-path flush has already superseded) compose the durable-write
// and rename steps directly instead of using a one-shot helper.
export function durableWriteFileSync(filePath: string, data: Buffer | string): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const fd = openSync(filePath, 'w');
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function durableWriteFileAsync(filePath: string, data: Buffer | string): Promise<void> {
  const handle = await fsOpen(filePath, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function renameOverExistingSync(fromPath: string, toPath: string): void {
  try {
    renameSync(fromPath, toPath);
    return;
  } catch (err) {
    if (!isTransientRenameError(err)) throw err;
    sleepSync(RENAME_RETRY_DELAY_MS);
    try {
      renameSync(fromPath, toPath);
      return;
    } catch (retryErr) {
      // Windows can hold the target open past both tries (antivirus/indexer).
      // Prefer an in-place write over hanging the quit path or losing data.
      console.warn(`[newamp] atomic replace of ${toPath} failed twice; writing in place`, retryErr);
      writeFileSync(toPath, readFileSync(fromPath));
    }
  }
}

export async function renameOverExistingAsync(fromPath: string, toPath: string): Promise<void> {
  try {
    await fsRename(fromPath, toPath);
    return;
  } catch (err) {
    if (!isTransientRenameError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    try {
      await fsRename(fromPath, toPath);
      return;
    } catch (retryErr) {
      console.warn(`[newamp] atomic replace of ${toPath} failed twice; writing in place`, retryErr);
      await fsWriteFile(toPath, await fsReadFile(fromPath));
    }
  }
}

const RENAME_RETRY_DELAY_MS = 100;

// Windows rename-over-existing fails transiently with EPERM/EBUSY while the
// target is briefly held open by another process.
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
