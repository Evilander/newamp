// Reads that failed because of the storage rather than the file: a network
// share that timed out or dropped, a drive that is busy or went away. A
// result built from such a read says nothing about the track, so it is
// neither kept nor held against the file.

import type { ChildProcess } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { parse, posix, resolve, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { caseFoldCachePath } from './cache-key-casing.js';

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
// On Windows EBUSY is a sharing or lock violation: another program has the
// file, or part of it, to itself (a download still being written, a scanner
// passing over it). That clears in a moment or not for a long while, so it is
// waited on for seconds, not for the minute a share gets.
export const BUSY_FILE_OUTAGE_MS = Math.min(Number(process.env.NEWAMP_READ_BUSY_MS) || 5000, STORAGE_OUTAGE_MS);
// Once an outage has been waited out and given up on, the storage the file is
// on is remembered as gone. The next file from it is still tried, but a
// storage error then fails it at once: left alone, every track that follows
// waits out a whole outage of its own, a minute a track for as many tracks as
// the player goes on to try. The first failure always gets its wait, since it
// may be a blip. Anything read from that storage forgets the note, and it
// lapses by itself this long after the last failure.
export const STORAGE_GIVEN_UP_MS = Number(process.env.NEWAMP_READ_GIVEN_UP_MS) || 30_000;

function isHeldByAnotherProgram(err: unknown): boolean {
  return process.platform === 'win32' && (err as { code?: unknown } | null)?.code === 'EBUSY';
}

// Where a volume is mounted when no drive letter says so: under /Volumes on
// macOS; under /mnt, /media/<user> or /run/media/<user> on Linux.
const MOUNT_POINT = /^\/(?:volumes\/[^/]+|mnt\/[^/]+|(?:run\/)?media\/[^/]+\/[^/]+)/i;
let libraryFolders: string[] = [];

/**
 * The library's folders as configured. Where a share is mounted somewhere
 * storageRootOf does not know, the library folder a file was added under
 * stands for its storage.
 */
export function setStorageRoots(folders: readonly string[]): void {
  libraryFolders = [...folders];
}

/**
 * What stands for the storage `filePath` is on: its drive letter or
 * \\server\share on Windows; elsewhere the mount it is under, or the library
 * folder it is under when that is the closer of the two. Null when neither
 * says (a file in the home folder): the root of the one tree every path
 * hangs off is never taken for a share.
 */
export function storageRootOf(filePath: string, platform: NodeJS.Platform = process.platform): string | null {
  const paths = platform === 'win32' ? win32 : posix;
  const full = caseFoldCachePath(paths.resolve(filePath), platform);
  const volume = paths.parse(full).root;
  if (volume.length > 1) return volume;
  let root = MOUNT_POINT.exec(full)?.[0] ?? null;
  for (const folder of libraryFolders) {
    const under = caseFoldCachePath(paths.resolve(folder), platform);
    if (under.length <= 1 || under.length <= (root?.length ?? 0)) continue;
    if (full === under || full.startsWith(under + paths.sep)) root = under;
  }
  return root;
}

const storageGoneAt = new Map<string, number>();

/**
 * Notes that the storage `filePath` is on was waited for and did not come
 * back, or still does not answer. `err` is the error in hand, if there is
 * one: a file another program holds says nothing about the storage.
 */
export function rememberStorageGone(filePath: string, err?: unknown): void {
  if (isHeldByAnotherProgram(err)) return;
  const root = storageRootOf(filePath);
  if (root) storageGoneAt.set(root, performance.now());
}

/** Something on the storage `filePath` is on was read: whatever was noted about it is over. */
export function storageAnswered(filePath: string): void {
  if (storageGoneAt.size === 0) return;
  const root = storageRootOf(filePath);
  if (root) storageGoneAt.delete(root);
}

/** Whether the storage `filePath` is on was given up on a moment ago, and nothing has been read from it since. */
export function storageKnownGone(filePath: string): boolean {
  if (storageGoneAt.size === 0) return false;
  const root = storageRootOf(filePath);
  const at = root ? storageGoneAt.get(root) : undefined;
  if (root == null || at == null) return false;
  if (performance.now() - at < STORAGE_GIVEN_UP_MS) return true;
  storageGoneAt.delete(root);
  return false;
}

/** How long an outage whose latest failure was the storage error `err` is waited out. */
export function storageOutageMs(err: unknown): number {
  return isHeldByAnotherProgram(err) ? BUSY_FILE_OUTAGE_MS : STORAGE_OUTAGE_MS;
}

/** How long to wait before try number `attempt` (1 for the first retry). */
export function storageRetryDelay(attempt: number): number {
  return Math.min(STORAGE_RETRY_DELAY_MS * attempt, STORAGE_RETRY_MAX_DELAY_MS);
}

/**
 * Runs `op`, and again after each storage error until the outage has lasted
 * as long as that error is waited out (STORAGE_OUTAGE_MS for a share). Any
 * other error, and the last storage error once the budget is spent, is thrown
 * as it came.
 */
export async function retryStorageErrors<T>(op: () => Promise<T>): Promise<T> {
  const since = performance.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (!isStorageError(err) || performance.now() - since >= storageOutageMs(err)) throw err;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, storageRetryDelay(attempt)));
    }
  }
}

// What a path that is not there answers with. A file that was moved or deleted
// gives these, and so does every file on a drive letter that has gone or a
// share that was unmapped, where the whole volume is what is missing.
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** An error that says the path does not exist. */
export function isMissingError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && MISSING_CODES.has(code);
}

// How long a volume's root or a file's last bytes get to answer before the
// storage is taken to be away. A healthy drive answers in a millisecond; a
// share whose server has gone can hold the call for the better part of a minute.
const PROBE_TIMEOUT_MS = Number(process.env.NEWAMP_READ_PROBE_MS) || 2500;
const PROBE_TAIL_BYTES = 64 * 1024;

/**
 * `ask()`'s answer, or `late` if it has not come within PROBE_TIMEOUT_MS. One
 * question at a time per key: a call that hangs holds a thread of the pool
 * every other file call in the process shares, so a second caller joins the
 * one already out instead of adding its own.
 */
function askOnce<T>(asked: Map<string, Promise<T>>, key: string, ask: () => Promise<T>, late: T): Promise<T> {
  let answer = asked.get(key);
  if (!answer) {
    answer = ask();
    asked.set(key, answer);
    void answer.finally(() => asked.delete(key));
  }
  const pending = answer;
  return new Promise((resolveAnswer) => {
    const timer = setTimeout(() => resolveAnswer(late), PROBE_TIMEOUT_MS);
    timer.unref();
    void pending.then((value) => {
      clearTimeout(timer);
      resolveAnswer(value);
    });
  });
}

const volumeChecks = new Map<string, Promise<boolean>>();

/**
 * Whether the volume `filePath` is on has gone: its drive letter or its
 * `\\server\share` root no longer answers. Never true where every path hangs
 * off one root that is always there, as on macOS and Linux.
 */
export function volumeAway(filePath: string): Promise<boolean> {
  const root = parse(resolve(filePath)).root;
  if (root.length <= 1) return Promise.resolve(false);
  return askOnce(volumeChecks, root, () => stat(root).then(() => false, () => true), true);
}

/**
 * What the file system itself says about reading a file:
 * - 'readable': its last bytes were read;
 * - 'storage': the storage did not deliver them (an error of its own, a
 *   volume that has gone, or no answer in time);
 * - 'file': the file is what can't be read (missing, refused, or held by
 *   another program) on a volume that answers.
 */
export type ReadProbe = 'readable' | 'storage' | 'file';

const readProbes = new Map<string, Promise<ReadProbe>>();

/**
 * Reads the last bytes of `filePath` to find out what a decoder's log can't
 * say: whether the file can be read to its end right now, and if not, whether
 * that is the storage's doing. A decoder reports a drive that vanished as a
 * missing file, some report a failed read as damaged data, and one that
 * stopped without a word may have reached the end or may not.
 */
export function probeFileRead(filePath: string): Promise<ReadProbe> {
  const ask = (): Promise<ReadProbe> =>
    readTail(filePath).then(
      () => {
        storageAnswered(filePath);
        return 'readable' as const;
      },
      async (err) => {
        if (isHeldByAnotherProgram(err)) return 'file';
        return isStorageError(err) || (await volumeAway(filePath)) ? 'storage' : 'file';
      },
    );
  return askOnce(readProbes, filePath, ask, 'storage');
}

async function readTail(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const want = Math.min(size, PROBE_TAIL_BYTES);
    if (want > 0) await handle.read(Buffer.allocUnsafe(want), 0, want, size - want);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * What a line of ffmpeg's log says stopped a read of the input: 'storage' when
 * the reason it gives is one only a drive or a share that failed gives,
 * 'unclear' when a read failed for a reason that does not say whose doing it
 * was (see isStorageReadFailure).
 */
export type ReadFailureKind = 'storage' | 'unclear';

// The system's text for the errors only a failing drive or share gives, as
// macOS and Linux word them. ffmpeg prints it at the end of an error line
// ("Error during demuxing: Operation timed out", "<file>: Stale NFS file
// handle") and then exits 0, as it does at the end of a file, so the output
// looks like a shorter track.
const STORAGE_TEXT = [
  'Operation timed out',
  'Connection timed out',
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
// A failed read from the system, and also what ffmpeg's own demuxers answer
// for a file whose data ends early or makes no sense. And what the Windows C
// runtime makes of most things a drive or a share can do wrong, having no
// code of its own for a dropped connection, a timeout or a pulled drive.
const UNCLEAR_TEXT = ['Input/output error', 'I/O error', 'Invalid argument', 'Bad file descriptor'];
// What a file that is missing or refused gives when it is opened: the file's
// own condition, as far as a log can tell. Partway through a file that had
// been reading, the same words are a failed read (it is how Windows reports a
// drive that is not ready, a locked range, a share whose path has gone).
const FILE_OWN_TEXT = [
  'No such file or directory',
  'Permission denied',
  'Operation not permitted',
  'Is a directory',
  'Not a directory',
  'File name too long',
  'Too many levels of symbolic links',
];
const lowered = (texts: string[]): Set<string> => new Set(texts.map((text) => text.toLowerCase()));
const atEnd = (texts: string[]): RegExp =>
  new RegExp(`:\\s*(?:${texts.map((text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})\\.?\\s*$`, 'i');
const STORAGE_REASONS = lowered(STORAGE_TEXT);
const UNCLEAR_REASONS = lowered(UNCLEAR_TEXT);
const FILE_OWN_REASONS = lowered(FILE_OWN_TEXT);
// ffmpeg's own error texts: the data, the build or the request is at fault,
// or the run was stopped, and no read failed.
const NOT_A_READ = /^(?:invalid data found when processing input|end of file|immediate exit requested|not yet implemented in ffmpeg, patches welcome|.+ not found)$/;
const STORAGE_TEXT_AT_END = atEnd(STORAGE_TEXT);
const IO_ERROR_AT_END = atEnd(UNCLEAR_TEXT.slice(0, 2));
// What comes before the message: the component that logged the line
// ("[in#0/flac @ 000001a51ab3c680] ") and, with -loglevel level+..., the
// level, which ffmpeg puts after the component.
const LINE_PREFIX = /^(?:\[[^\]]* @ [0-9a-fx]+\] |\[(?:panic|fatal|error|warning|info|verbose|debug|trace)\] )*/i;
const LEVEL_TAG = /\[(panic|fatal|error|warning|info|verbose|debug|trace)\] /gi;
// A read that failed partway through the input, whatever the reason given.
const DEMUX_ERROR = /^Error (?:during demuxing|retrieving a packet from demuxer): (.+)$/;
// The input could not be opened or its header could not be read.
const OPEN_ERROR = /^Error opening input(?: files?)?: (.+)$/;

/**
 * What one line of ffmpeg's log says about a failed read of `inputPath`, or
 * null when it says nothing of the kind. A read that fails partway is
 * recognised by the line ffmpeg reports it on, for any reason but the ones
 * that mean the data is bad or finished, so no system's wording has to be
 * known in advance. The input dump (tags, streams) is indented and never
 * counts, nor does a line logged below warning level, and the path itself is
 * taken out first, so a title or a file name that reads like an error doesn't
 * either.
 */
export function readFailureKind(line: string, inputPath: string): ReadFailureKind | null {
  const prefix = LINE_PREFIX.exec(line)![0];
  const levels = prefix.match(LEVEL_TAG);
  if (levels && !/panic|fatal|error|warning/i.test(levels[levels.length - 1]!)) return null;
  const text = line.slice(prefix.length);
  if (!text || /^\s/.test(text)) return null;
  const reasonOf = (match: RegExpExecArray): string => match[1]!.trim().replace(/\.$/, '').toLowerCase();
  const demux = DEMUX_ERROR.exec(text);
  if (demux) {
    const reason = reasonOf(demux);
    if (NOT_A_READ.test(reason)) return null;
    return STORAGE_REASONS.has(reason) ? 'storage' : 'unclear';
  }
  const opening = OPEN_ERROR.exec(text);
  if (opening) {
    const reason = reasonOf(opening);
    if (NOT_A_READ.test(reason) || FILE_OWN_REASONS.has(reason)) return null;
    return STORAGE_REASONS.has(reason) ? 'storage' : 'unclear';
  }
  // "<file>: <reason>", as older ffmpeg reports both, with nothing to tell them
  // apart; and any other error that ends in a reason only a failed read has.
  const rest = inputPath ? text.split(inputPath).join('') : text;
  const bare = /^: (.+)$/.exec(rest);
  if (bare && STORAGE_REASONS.has(reasonOf(bare))) return 'storage';
  if (bare && UNCLEAR_REASONS.has(reasonOf(bare))) return 'unclear';
  if (STORAGE_TEXT_AT_END.test(rest)) return 'storage';
  return IO_ERROR_AT_END.test(rest) ? 'unclear' : null;
}

/**
 * Whether a failed read that ffmpeg logged was the storage's doing. The
 * reason settles it when it is one only the storage gives. When it is not
 * (an "I/O error" is also what a file that ends early gets, and "Permission
 * denied" is what Windows calls a drive that is not ready), the file system is
 * asked whether the file can be read at all.
 */
export async function isStorageReadFailure(kind: ReadFailureKind, filePath: string): Promise<boolean> {
  return kind === 'storage' || (await probeFileRead(filePath)) === 'storage';
}

/** Whether one line of ffmpeg's log says a read of `inputPath` failed. */
export function isReadFailureLine(line: string, inputPath: string): boolean {
  return readFailureKind(line, inputPath) != null;
}

/** What an ffmpeg log says about a failed read of `inputPath`: 'storage' if any line says so. */
export function logReadFailure(log: string, inputPath: string): ReadFailureKind | null {
  let found: ReadFailureKind | null = null;
  for (const line of log.split(/\r?\n|\r/)) {
    const kind = readFailureKind(line, inputPath);
    if (kind === 'storage') return kind;
    found ??= kind;
  }
  return found;
}

/** Whether any line of an ffmpeg log says a read of `inputPath` failed. */
export function logShowsReadFailure(log: string, inputPath: string): boolean {
  return logReadFailure(log, inputPath) != null;
}

/**
 * Watches an ffmpeg's log for a failed read of `inputPath`, whatever else the
 * log holds and however much of it the caller keeps. Call the returned
 * function once the process has closed: it answers with the kind of failure,
 * or null.
 */
export function watchReadFailureKind(child: ChildProcess, inputPath: string): () => ReadFailureKind | null {
  let found: ReadFailureKind | null = null;
  const note = (line: string): void => {
    const kind = readFailureKind(line, inputPath);
    if (kind === 'storage' || found == null) found = kind ?? found;
  };
  // A line can arrive split across chunks, and so can a character of a
  // non-ASCII path: the decoder holds back the half of it that has arrived.
  let partial = '';
  const decoder = new StringDecoder('utf8');
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (found === 'storage') return;
    const lines = (partial + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split(/\r?\n|\r/);
    // Bounded: a tag dump can run to tens of kilobytes on one line. The start
    // is what's kept, so an indented line stays indented.
    partial = lines.pop()!.slice(0, 4000);
    for (const line of lines) note(line);
  });
  return () => {
    if (found !== 'storage') note(partial);
    return found;
  };
}

/**
 * Watches an ffmpeg's log for a failed read of `inputPath`. Call the returned
 * function once the process has closed.
 */
export function watchReadFailures(child: ChildProcess, inputPath: string): () => boolean {
  const kind = watchReadFailureKind(child, inputPath);
  return () => kind() != null;
}
