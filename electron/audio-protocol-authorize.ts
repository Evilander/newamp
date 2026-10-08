// Decode + resolve + two-phase allowlist authorization for a newamp://track
// (or newamp://file) request. Extracted out of the protocol handler in
// electron/main.ts so this — the part of the request path a hostile input
// actually reaches — can be unit-tested directly (scripts/
// audio-url-roundtrip-test.mjs) without booting Electron.
//
// The two phases are not redundant. Phase one runs on pure strings, before
// any fs call (existsSync, realpath, stat). Touching the filesystem with an
// unvalidated path is itself the leak: on Windows, existsSync/realpath on a
// UNC path (\\host\share, //host/share — arriving literally, percent-
// encoded, or left over from a multi-slash pathname) opens an SMB session to
// that host and can hand over the user's NTLM hash, regardless of what the
// allowlist decides afterward. A UNC candidate can only pass phase one by
// exactly matching an already-configured library root, opened file, or
// podcast root string — it is never resolved against the real filesystem to
// decide that. Phase two re-runs the same policy against the realpathed
// target once fs access is known to be safe, closing the TOCTOU window a
// symlink swap between phase one and realpath could otherwise open.
import { existsSync as nodeExistsSync } from 'node:fs';
import { realpath as nodeRealpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAllowedAudioPath } from './audio-path-policy.js';

export interface AudioProtocolAuthorizeDeps {
  /** Raw, as-configured library roots — not realpathed by the caller. */
  libraryRoots: readonly string[];
  /** Already realpathed at add-time by the flow that opened each file. */
  openedFiles: ReadonlySet<string>;
  getPodcastDownloadsRealRoot: () => Promise<string | null>;
  getTracksByPaths?: (paths: string[]) => { length: number } | undefined;
  /** Injectable for tests; default to the real fs calls in production. */
  existsSync?: (path: string) => boolean;
  realpath?: (path: string) => Promise<string>;
}

export type AudioProtocolAuthorizeResult =
  | { ok: true; filePath: string; real: string }
  | { ok: false; status: 403 | 404 };

export async function authorizeAudioProtocolPath(
  url: URL,
  deps: AudioProtocolAuthorizeDeps,
): Promise<AudioProtocolAuthorizeResult> {
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const realpath = deps.realpath ?? nodeRealpath;

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

  if (!existsSync(filePath)) return { ok: false, status: 404 };

  let real: string;
  try {
    real = await realpath(filePath);
  } catch {
    return { ok: false, status: 404 };
  }
  const realLibraryRoots: string[] = [];
  for (const root of deps.libraryRoots) {
    try {
      realLibraryRoots.push(await realpath(root));
    } catch {
      /* missing/unreadable root contributes nothing */
    }
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
  if (!allowed) return { ok: false, status: 403 };

  return { ok: true, filePath, real };
}
