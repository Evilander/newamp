// Pure allowlist decision for the `newamp:` audio protocol (todo 005).
// A path is legitimately playable only when it arrived through one of the
// app's own flows: library scanning (roots / DB), session open-with /
// drag-drop, or a podcast download. Everything else is denied so the
// persistent transcode cache can never be used as an arbitrary-file-read
// oracle. The caller realpaths every input (TOCTOU: the validated realpath
// is also what gets served/transcoded); this module does no fs work.

import { caseFoldCachePath } from './cache-key-casing.js';

export interface AudioPathPolicyInput {
  realPath: string;
  libraryRoots: readonly string[];   // realpathed by caller
  openedFiles: ReadonlySet<string>;  // realpathed by caller
  podcastRoot: string | null;        // realpathed by caller
  isLibraryTrack: boolean;
  platform?: NodeJS.Platform;        // case-folding for win32/darwin compares
}

export function isAllowedAudioPath(input: AudioPathPolicyInput): boolean {
  if (input.isLibraryTrack) return true;
  const platform = input.platform ?? process.platform;
  const real = foldComparable(input.realPath, platform);

  for (const root of input.libraryRoots) {
    if (contains(foldComparable(root, platform), real)) return true;
  }
  if (input.podcastRoot && contains(foldComparable(input.podcastRoot, platform), real)) {
    return true;
  }
  for (const opened of input.openedFiles) {
    if (foldComparable(opened, platform) === real) return true;
  }
  return false;
}

// Normalize to forward slashes and fold case on case-insensitive platforms
// (win32 NTFS, darwin APFS default) so /Music matches /music there but not
// on linux. Reuses the transcode-cache folding rule for consistency.
function foldComparable(path: string, platform: NodeJS.Platform): string {
  return caseFoldCachePath(path.replace(/\\/g, '/'), platform);
}

// Separator-safe containment: exact equality (a root entry may itself be a
// file) or a true child path. `/music-evil` must NOT match root `/music`,
// which a bare startsWith would allow.
function contains(root: string, real: string): boolean {
  const trimmed = root.endsWith('/') ? root.slice(0, -1) : root;
  return real === trimmed || real.startsWith(trimmed + '/');
}
