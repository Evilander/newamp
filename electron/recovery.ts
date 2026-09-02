import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { open as fsOpen, readFile as fsReadFile, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises';
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
    // writeSync is not guaranteed to write the whole buffer in one call —
    // fs.writeFileSync loops internally for exactly this reason. Without the
    // loop here, a short write (rare on local disks, but real on network
    // shares and under load) would get fsynced and renamed into place as if
    // it were the complete file.
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
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
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    if (delay) sleepSync(delay);
    try {
      renameSync(fromPath, toPath);
      return;
    } catch (err) {
      if (!isTransientRenameError(err)) throw err;
    }
  }
  // The target is still locked (antivirus/indexer/OneDrive) after ~900ms of
  // backoff. Give the atomic path one more chance through a fresh temp file
  // before reaching for an in-place write — an in-place writeFileSync with no
  // fsync and no atomicity is the exact truncation-on-crash hazard this
  // module exists to eliminate.
  const retryTmp = `${toPath}.tmp-${process.pid}-retry`;
  try {
    durableWriteFileSync(retryTmp, readFileSync(fromPath));
    renameSync(retryTmp, toPath);
    return;
  } catch (retryErr) {
    try {
      unlinkSync(retryTmp);
    } catch {
      /* gone with the rename, or nothing left to clean up */
    }
    if (!isTransientRenameError(retryErr)) throw retryErr;
    console.warn(`[newamp] atomic replace of ${toPath} failed after retries; writing in place`, retryErr);
    durableWriteFileSync(toPath, readFileSync(fromPath));
  }
}

export async function renameOverExistingAsync(fromPath: string, toPath: string): Promise<void> {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await fsRename(fromPath, toPath);
      return;
    } catch (err) {
      if (!isTransientRenameError(err)) throw err;
    }
  }
  const retryTmp = `${toPath}.tmp-${process.pid}-retry`;
  try {
    await durableWriteFileAsync(retryTmp, await fsReadFile(fromPath));
    await fsRename(retryTmp, toPath);
    return;
  } catch (retryErr) {
    await fsUnlink(retryTmp).catch(() => {});
    if (!isTransientRenameError(retryErr)) throw retryErr;
    console.warn(`[newamp] atomic replace of ${toPath} failed after retries; writing in place`, retryErr);
    await durableWriteFileAsync(toPath, await fsReadFile(fromPath));
  }
}

// First attempt is immediate (delay 0); the rest back off, for ~900ms total
// before either function gives up on a clean atomic rename.
const RENAME_RETRY_DELAYS_MS = [0, 150, 300, 450];

// Windows rename-over-existing fails transiently with EPERM/EBUSY while the
// target is briefly held open by another process.
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
