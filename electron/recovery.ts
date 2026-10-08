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

const TRANSIENT_IO_CODES = new Set(['EBUSY', 'EPERM', 'EAGAIN', 'EACCES', 'EMFILE']);

// A locked/unavailable file is not corruption — quarantining on those errors
// silently reset whole libraries. Callers retry these with backoff and then
// surface a clear error instead of entering the recovery path.
export function isTransientIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_IO_CODES.has(code);
}

// EIO (a failing disk/drive) and EISDIR (something replaced the file with a
// directory) never clear on retry the way a lock does — readFileSyncRetrying
// already rethrows them on the first attempt instead of wasting the retry
// budget — but they are still not evidence of corrupt JSON content. A caller
// deciding "suppress + notify" vs "let it crash bootstrap" should treat them
// the same as a lock that outlasted every retry, not as an unknown error.
const UNREADABLE_FILE_CODES = new Set([...TRANSIENT_IO_CODES, 'EIO', 'EISDIR']);

export function isUnreadableFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && UNREADABLE_FILE_CODES.has(code);
}

export function recoveryReason(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err || 'Unknown recovery error');
}

// Bounded, synchronous retry for reading a store's file at startup. A
// locked/unavailable file (antivirus, indexer, OneDrive, a second process
// mid-write) is transient, not corruption — this gives it a short window to
// clear before the caller decides the original is unavailable for the
// session. Rethrows the same transient error once the budget runs out, and
// rethrows immediately on anything that isn't a transient I/O error.
export function readFileSyncRetrying(filePath: string, encoding: BufferEncoding = 'utf-8'): string {
  let lastErr: unknown;
  for (const delay of RENAME_RETRY_DELAYS_MS_SYNC) {
    if (delay) sleepSync(delay);
    try {
      return readFileSync(filePath, encoding);
    } catch (err) {
      lastErr = err;
      if (!isTransientIoError(err)) throw err;
    }
  }
  throw lastErr;
}

// EBUSY/EPERM/EAGAIN/EMFILE plausibly clear on their own — another process
// briefly holding the file, a sync client, a full fd table. EACCES usually
// doesn't: it means a real permissions problem on the file or its folder,
// and "will retry next launch" is a false promise for it. EIO/EISDIR are the
// same story (failing drive, or the file got replaced by a directory) — say
// so plainly instead of implying the user just needs to wait.
function describeUnreadableFile(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const reason = recoveryReason(err);
  if (code === 'EACCES') {
    return `permission denied (${reason}) — check file and folder permissions; this will not clear on its own`;
  }
  if (code === 'EIO' || code === 'EISDIR') {
    return `${reason} — this will not clear on its own; check the drive and the file`;
  }
  return `${reason} — may clear on its own; will retry next launch`;
}

// A locked/unreadable file that outlasted the retry budget above. The
// original was never actually read, so there is nothing to quarantine —
// backupPath names the file itself, and the caller must run the session on
// in-memory defaults without ever writing over it.
export function suppressedRecoveryEvent(store: RecoveryEvent['store'], filePath: string, err: unknown): RecoveryEvent {
  return {
    store,
    filePath,
    backupPath: filePath,
    reason: describeUnreadableFile(err),
    recoveredAt: Date.now(),
  };
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
  } catch (err) {
    // The temp file is the only complete copy of this state if the replace
    // failed part-way; deleting it here would turn a failed save into data
    // loss. Leave it beside the target, named so it can be found, and say so.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not replace ${filePath} (${reason}); the complete copy is at ${tmp}`);
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* gone with the rename */
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
  // The synchronous writer runs on the main thread for ordinary settings
  // writes, not only at quit, so its backoff is shorter than the async one:
  // a locked file must not freeze the UI for close to a second.
  for (const delay of RENAME_RETRY_DELAYS_MS_SYNC) {
    if (delay) sleepSync(delay);
    try {
      renameSync(fromPath, toPath);
      return;
    } catch (err) {
      if (!isTransientRenameError(err)) throw err;
    }
  }
  // The target is still locked (antivirus/indexer/OneDrive) after the
  // backoff. Give the atomic path one more chance through a fresh temp file.
  // If that also fails, leave `fromPath` intact as the complete snapshot;
  // opening the live target for write would truncate it before durability is
  // guaranteed, which is the crash-corruption path this module avoids.
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
    throw new Error(`atomic replace of ${toPath} failed after retries; complete copy remains at ${fromPath}`);
  }
}

// A plain rename with the same backoff as the async writer, for moves that
// must stay moves: directories, and files whose source and target are both
// being swapped (support-backup's restore). Windows antivirus and indexers
// hold a file for a moment after it is closed, which fails the rename with
// EPERM/EBUSY even though nothing is wrong. Rethrows the last transient error
// once the budget runs out.
export async function renameRetryingAsync(fromPath: string, toPath: string): Promise<void> {
  let lastErr: unknown;
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await fsRename(fromPath, toPath);
      return;
    } catch (err) {
      if (!isTransientRenameError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function renameOverExistingAsync(fromPath: string, toPath: string): Promise<void> {
  try {
    await renameRetryingAsync(fromPath, toPath);
    return;
  } catch (err) {
    if (!isTransientRenameError(err)) throw err;
  }
  const retryTmp = `${toPath}.tmp-${process.pid}-retry`;
  try {
    await durableWriteFileAsync(retryTmp, await fsReadFile(fromPath));
    await fsRename(retryTmp, toPath);
    return;
  } catch (retryErr) {
    await fsUnlink(retryTmp).catch(() => {});
    if (!isTransientRenameError(retryErr)) throw retryErr;
    throw new Error(`atomic replace of ${toPath} failed after retries; complete copy remains at ${fromPath}`);
  }
}

// First attempt is immediate (delay 0); the rest back off. The async writer
// can afford ~900 ms; the synchronous one blocks the main thread, so ~240 ms.
const RENAME_RETRY_DELAYS_MS = [0, 150, 300, 450];
const RENAME_RETRY_DELAYS_MS_SYNC = [0, 40, 80, 120];

// Windows rename-over-existing fails transiently with EPERM/EBUSY while the
// target is briefly held open by another process.
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
