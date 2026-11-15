// Reads that failed because of the storage rather than the file: a network
// share that timed out or dropped, a drive that is busy or went away. A
// result built from such a read says nothing about the track, so it is
// neither kept nor held against the file.

import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const STORAGE_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'EIO',
  'EAGAIN',
  'EBUSY',
  'ESTALE',
  'ECONNRESET',
  'ECONNABORTED',
  'ENETRESET',
  'ENOTCONN',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  // A volume that went away: macOS answers ENXIO ("Device not configured") for
  // an unmounted share or a pulled drive.
  'ENXIO',
  'ENODEV',
  'ESHUTDOWN',
  'ENOLINK',
  'EREMOTEIO',
  'ECANCELED',
  // What libuv reports on Windows when an SMB share drops.
  ...(process.platform === 'win32' ? ['UNKNOWN'] : []),
]);

/** A filesystem error that came from the storage, not from the file. */
export function isStorageError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && STORAGE_ERROR_CODES.has(code);
}

// A share that stops answering for a while is waited on, not given up on: a
// read or a stat that fails for that reason is tried again, a little later
// each time, until the share has been gone STORAGE_OUTAGE_MS. Measured on the
// monotonic clock, which a sleep or a clock change does not move.
export const STORAGE_RETRY_DELAY_MS = 1000;
export const STORAGE_RETRY_MAX_DELAY_MS = 5000;
export const STORAGE_OUTAGE_MS = Number(process.env.NEWAMP_READ_OUTAGE_MS) || 60_000;

/** How long to wait before try number `attempt` (1 for the first retry). */
export function storageRetryDelay(attempt: number): number {
  return Math.min(STORAGE_RETRY_DELAY_MS * attempt, STORAGE_RETRY_MAX_DELAY_MS);
}

/**
 * Runs `op`, and again after each storage error until the outage has lasted
 * STORAGE_OUTAGE_MS. Any other error, and the last storage error once the
 * budget is spent, is thrown as it came.
 */
export async function retryStorageErrors<T>(op: () => Promise<T>): Promise<T> {
  const since = performance.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (!isStorageError(err) || performance.now() - since >= STORAGE_OUTAGE_MS) throw err;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, storageRetryDelay(attempt)));
    }
  }
}

// The system's text for those errors, as macOS, Linux and Windows word them.
// ffmpeg prints it at the end of an error line ("<file>: Operation timed out",
// "Error during demuxing: Input/output error") and then exits 0, as it does
// at the end of a file, so the output looks like a shorter track.
const READ_FAILURE_TEXT = [
  'Operation timed out',
  'Connection timed out',
  'Input/output error',
  'I/O error',
  'Stale NFS file handle',
  'Stale file handle',
  'Connection reset by peer',
  'Connection reset',
  'Software caused connection abort',
  'Connection aborted',
  'Network dropped connection on reset',
  'Network is down',
  'Network is unreachable',
  'Host is down',
  'Host is unreachable',
  'No route to host',
  'Socket is not connected',
  'Transport endpoint is not connected',
  'Device not configured',
  'No such device or address',
  'No such device',
  'Resource temporarily unavailable',
  'Device or resource busy',
  'Resource busy',
];
const READ_FAILURE_AT_END = new RegExp(
  `:\\s*(?:${READ_FAILURE_TEXT.map((text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})\\.?\\s*$`,
  'i',
);
// -loglevel level+... puts the level first; only errors count.
const LEVEL_TAG = /^\[(panic|fatal|error|warning|info|verbose|debug|trace)\] /;

/**
 * Whether one line of ffmpeg's log says a read of `inputPath` failed. The
 * input dump (tags, streams) is indented and never counts, nor does a line
 * logged below warning level, and the path itself is taken out first, so a
 * title or a file name that reads like an error doesn't either.
 */
export function isReadFailureLine(line: string, inputPath: string): boolean {
  let text = line;
  const level = LEVEL_TAG.exec(text);
  if (level) {
    if (!['panic', 'fatal', 'error', 'warning'].includes(level[1]!)) return false;
    text = text.slice(level[0].length);
  }
  if (!text || /^\s/.test(text)) return false;
  if (inputPath) text = text.split(inputPath).join('');
  return READ_FAILURE_AT_END.test(text);
}

/** Whether any line of an ffmpeg log says a read of `inputPath` failed. */
export function logShowsReadFailure(log: string, inputPath: string): boolean {
  return log.split(/\r?\n|\r/).some((line) => isReadFailureLine(line, inputPath));
}

/**
 * Watches an ffmpeg's log for a failed read of `inputPath`, whatever else the
 * log holds and however much of it the caller keeps. Call the returned
 * function once the process has closed.
 */
export function watchReadFailures(child: ChildProcess, inputPath: string): () => boolean {
  let failed = false;
  // A line can arrive split across chunks, and so can a character of a
  // non-ASCII path: the decoder holds back the half of it that has arrived.
  let partial = '';
  const decoder = new StringDecoder('utf8');
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (failed) return;
    const lines = (partial + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split(/\r?\n|\r/);
    // Bounded: a tag dump can run to tens of kilobytes on one line. The start
    // is what's kept, so an indented line stays indented.
    partial = lines.pop()!.slice(0, 4000);
    failed = lines.some((line) => isReadFailureLine(line, inputPath));
  });
  return () => failed || isReadFailureLine(partial, inputPath);
}
