// playlist:save accepts a renderer-supplied coverImagePath. Without this
// guard, any script that can call window.newamp.savePlaylist could point
// main at an arbitrary local file: main copies it into the playlist-art
// cache and serves it back over newplaylistart://, an arbitrary-file-read
// primitive. Only a path playlist:pick-cover itself just returned from a
// real dialog.showOpenDialog() result is accepted; approval expires after
// ttlMs so the allowlist can't grow without bound across a long session.
import { resolve } from 'node:path';

export interface PlaylistCoverGuard {
  approve(filePath: string): void;
  isApproved(filePath: string): boolean;
}

const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

export function createPlaylistCoverGuard(ttlMs = DEFAULT_APPROVAL_TTL_MS): PlaylistCoverGuard {
  const approvedAt = new Map<string, number>();

  function prune(now: number): void {
    const cutoff = now - ttlMs;
    for (const [path, at] of approvedAt) {
      if (at < cutoff) approvedAt.delete(path);
    }
  }

  return {
    approve(filePath: string): void {
      const now = Date.now();
      prune(now);
      approvedAt.set(resolve(filePath), now);
    },
    isApproved(filePath: string): boolean {
      const now = Date.now();
      prune(now);
      const at = approvedAt.get(resolve(filePath));
      return at !== undefined && now - at <= ttlMs;
    },
  };
}
