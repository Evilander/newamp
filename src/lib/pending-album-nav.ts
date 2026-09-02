/**
 * Sequencing helper for pending album-navigation requests (opening an album
 * from Now Playing, a matched-song link, an artist page, etc.).
 *
 * These requests resolve asynchronously (an IPC round-trip for the album's
 * tracks, then another for its rating), and a user — or another view calling
 * navigateToAlbum/navigateToTrack — can fire a second request before the
 * first one lands. Without an identity check, whichever request happens to
 * resolve LAST wins and overwrites the screen, even if it was the older,
 * already-superseded one. This gives each request a monotonically
 * increasing id so a caller can tell, right before applying a result,
 * whether a newer request has since started.
 */
export interface PendingAlbumNavSeq {
  latest: number;
}

export function createPendingAlbumNavSeq(): PendingAlbumNavSeq {
  return { latest: 0 };
}

/** Call when starting a new pending-navigation request; returns its id. */
export function beginPendingAlbumNav(seq: PendingAlbumNavSeq): number {
  seq.latest += 1;
  return seq.latest;
}

/** True if `requestId` is still the most recently started request. */
export function isCurrentPendingAlbumNav(seq: PendingAlbumNavSeq, requestId: number): boolean {
  return seq.latest === requestId;
}
