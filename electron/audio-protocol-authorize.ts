// Decode + resolve + two-phase allowlist authorization for a newamp://track
// (or newamp://file) request. Extracted out of the protocol handler in
// electron/main.ts so this — the part of the request path a hostile input
// actually reaches — can be unit-tested directly (scripts/
// audio-url-roundtrip-test.mjs) without booting Electron.
//
// The two phases are not redundant. Phase one runs on pure strings, before
// any fs call (realpath, stat). Touching the filesystem with an
// unvalidated path is itself the leak: on Windows, realpath on a
// UNC path (\\host\share, //host/share — arriving literally, percent-
// encoded, or left over from a multi-slash pathname) opens an SMB session to
// that host and can hand over the user's NTLM hash, regardless of what the
// allowlist decides afterward. A UNC candidate can only pass phase one by
// exactly matching an already-configured library root, opened file, or
// podcast root string — it is never resolved against the real filesystem to
// decide that. Phase two re-runs the same policy against the realpathed
// target once fs access is known to be safe, closing the TOCTOU window a
// symlink swap between phase one and realpath could otherwise open.
import { realpath as nodeRealpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAllowedAudioPath } from './audio-path-policy.js';
import { isStorageError, retryStorageErrors } from './read-failure.js';

export interface AudioProtocolAuthorizeDeps {
  /** Raw, as-configured library roots — not realpathed by the caller. */
  libraryRoots: readonly string[];
  /** Already realpathed at add-time by the flow that opened each file. */
  openedFiles: ReadonlySet<string>;
  getPodcastDownloadsRealRoot: () => Promise<string | null>;
  getTracksByPaths?: (paths: string[]) => { length: number } | undefined;
  /** Injectable for tests; default to the real fs call in production. */
  realpath?: (path: string) => Promise<string>;
  /** How the requested file's realpath is retried when the storage errors out; injectable for tests. */
  retry?: <T>(op: () => Promise<T>) => Promise<T>;
  /** Pauses between attempts at a library root's realpath; injectable for tests. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type AudioProtocolAuthorizeResult =
  | { ok: true; filePath: string; real: string }
  // 503 means the storage did not answer (a network share timing out), which
  // says nothing about the file; the caller must not report it as missing.
  | { ok: false; status: 403 | 404 | 503 };

// The requested file is waited for like any other read of the share
// (retryStorageErrors): an answer that comes late keeps the song playing, and
// only a share that stays away for the whole outage budget gives a 503. A
// library root is only the second question, asked about a share that has just
// answered the first, so it gets a couple of short pauses and no more; one
// offline root must not hold up a file that lives under another.
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 500];

// A library root's realpath costs a round trip to the share and only changes
// when the root itself is remapped, so it is kept for a minute. A root that
// failed is kept for seconds, so a share that is down is not asked again by
// every request that arrives while it is.
const REAL_ROOT_TTL_MS = 60_000;
const FAILED_ROOT_TTL_MS = 5_000;

interface RealRoot {
  real: string | null;
  storageDown: boolean;
  at: number;
}

// One cache per realpath function, so a test's stub never reads the answers
// the real fs gave.
const realRootCaches = new WeakMap<(path: string) => Promise<string>, Map<string, RealRoot>>();

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function realpathRetrying(
  path: string,
  realpath: (path: string) => Promise<string>,
  delaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await realpath(path);
    } catch (err) {
      const delay = delaysMs[attempt];
      if (!isStorageError(err) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

async function realLibraryRoot(
  root: string,
  realpath: (path: string) => Promise<string>,
  delaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<RealRoot> {
  let cache = realRootCaches.get(realpath);
  if (!cache) {
    cache = new Map();
    realRootCaches.set(realpath, cache);
  }
  const cached = cache.get(root);
  if (cached && now() - cached.at < (cached.real === null ? FAILED_ROOT_TTL_MS : REAL_ROOT_TTL_MS)) return cached;
  let entry: RealRoot;
  try {
    entry = { real: await realpathRetrying(root, realpath, delaysMs, sleep), storageDown: false, at: now() };
  } catch (err) {
    // A missing or unreadable root contributes nothing.
    entry = { real: null, storageDown: isStorageError(err), at: now() };
  }
  cache.set(root, entry);
  return entry;
}

export async function authorizeAudioProtocolPath(
  url: URL,
  deps: AudioProtocolAuthorizeDeps,
): Promise<AudioProtocolAuthorizeResult> {
  const realpath = deps.realpath ?? nodeRealpath;
  const retry = deps.retry ?? retryStorageErrors;
  const delaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  // host is "track" or "file", pathname holds the encoded path. Strip
  // exactly the one leading slash the URL parser adds after the host —
  // stripping "one or more" would also eat the leading slash of a POSIX
  // absolute path's own encoded double-slash, silently turning it relative.
  const raw = decodeURIComponent(url.pathname.replace(/^\//, ''));
  // On Windows we get something like "K:/music/foo/bar.mp3"
  const filePath = resolve(raw);

  let preCheckIsLibraryTrack = false;
  try {
    preCheckIsLibraryTrack = (deps.getTracksByPaths?.([filePath])?.length ?? 0) > 0;
  } catch {
    /* library DB not open yet → not a library track */
  }
  const preCheckAllowed = isAllowedAudioPath({
    realPath: filePath,
    libraryRoots: deps.libraryRoots,
    openedFiles: deps.openedFiles,
    podcastRoot: await deps.getPodcastDownloadsRealRoot(),
    isLibraryTrack: preCheckIsLibraryTrack,
  });
  if (!preCheckAllowed) return { ok: false, status: 403 };

  // A library row for the path as written settles phase two as well: the
  // policy accepts a library track whatever it resolves to. Nothing here
  // touches the share, and a file that is gone fails later, where it is
  // opened, with the error the storage gave.
  if (preCheckIsLibraryTrack) return { ok: true, filePath, real: filePath };

  let real: string;
  try {
    real = await retry(() => realpath(filePath));
  } catch (err) {
    return { ok: false, status: isStorageError(err) ? 503 : 404 };
  }
  const realLibraryRoots: string[] = [];
  let rootsUnavailable = false;
  for (const root of deps.libraryRoots) {
    const entry = await realLibraryRoot(root, realpath, delaysMs, sleep, now);
    if (entry.real !== null) realLibraryRoots.push(entry.real);
    else if (entry.storageDown) rootsUnavailable = true;
  }
  let isLibraryTrack = false;
  try {
    isLibraryTrack = (deps.getTracksByPaths?.([filePath, real])?.length ?? 0) > 0;
  } catch {
    /* library DB not open yet → not a library track */
  }
  const allowed = isAllowedAudioPath({
    realPath: real,
    libraryRoots: realLibraryRoots,
    openedFiles: deps.openedFiles,
    podcastRoot: await deps.getPodcastDownloadsRealRoot(),
    isLibraryTrack,
  });
  // A root that could not be resolved because its share timed out may be the
  // one this file belongs to, so the refusal is not final.
  if (!allowed) return { ok: false, status: rootsUnavailable ? 503 : 403 };

  return { ok: true, filePath, real };
}
