// playlist:save accepts a renderer-supplied coverImagePath. Without this
// guard, any script that can call window.newamp.savePlaylist could point
// main at an arbitrary local file: main copies it into the playlist-art
// cache and serves it back over newplaylistart://, an arbitrary-file-read
// primitive. Only a path playlist:pick-cover itself just returned from a
// real dialog.showOpenDialog() result is accepted.
//
// Bounded by count, not by time: a picked cover stays approved for the life of
// the process. An earlier version expired approvals after ten minutes, which
// rejected a perfectly legitimate save from a user who picked an icon and then
// took their time over the rest of the playlist. Keeping the last few dozen
// picks bounds memory just as well without inventing a deadline for the user.
import { resolve } from 'node:path';

export interface PlaylistCoverGuard {
  approve(filePath: string): void;
  isApproved(filePath: string): boolean;
}

const DEFAULT_MAX_APPROVALS = 32;

export function createPlaylistCoverGuard(maxApprovals = DEFAULT_MAX_APPROVALS): PlaylistCoverGuard {
  // insertion-ordered: the oldest approval is the first key
  const approved = new Set<string>();

  return {
    approve(filePath: string): void {
      const key = resolve(filePath);
      approved.delete(key); // re-approving moves it to the newest position
      approved.add(key);
      while (approved.size > maxApprovals) {
        const oldest = approved.values().next().value as string | undefined;
        if (oldest === undefined) break;
        approved.delete(oldest);
      }
    },
    isApproved(filePath: string): boolean {
      return approved.has(resolve(filePath));
    },
  };
}
