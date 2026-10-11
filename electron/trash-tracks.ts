// The parts of "Move to Recycle Bin" that need no Electron: which of the
// requested tracks have a file to move, the retry around the move, and plain
// words for what the platform reports when it fails.

import type { Track } from '../shared/types.js';

const RETRY_DELAY_MS = 250;

/**
 * The library rows a request names that have a file of their own. Streams,
 * and CUE or podcast tracks (negative ids), have nothing to move; `supplied`
 * tells an empty request from one that named only those, which is answered
 * with a failure rather than silence.
 */
export function trashableTracks(ids: unknown, getTrack: (id: number) => Track | null): { supplied: boolean; tracks: Track[] } {
  const supplied = Array.isArray(ids) ? ids : [];
  const wanted = [...new Set(supplied.map((id) => Math.trunc(Number(id))).filter((id) => id > 0))];
  const tracks = wanted
    .map((id) => getTrack(id))
    .filter((track): track is Track => !!track && !track.cueStart && !!track.path && !/^[a-z][a-z0-9+.-]+:\/\//i.test(track.path));
  return { supplied: supplied.length > 0, tracks };
}

/**
 * One retry after a short wait. The ffmpeg children reading the file were
 * stopped just before, and Windows lets go of a terminated process's handles
 * a moment after it exits; the second error is the one reported.
 */
export async function trashWithRetry(
  path: string,
  trash: (path: string) => Promise<void>,
  delayMs = RETRY_DELAY_MS,
): Promise<void> {
  try {
    await trash(path);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await trash(path);
  }
}

/** A move reports in after this many files, and once more at the end. */
export const TRASH_PROGRESS_EVERY = 25;

export interface TrashOutcome {
  trashed: Track[];
  /** Rows whose file was already gone: nothing to move, they just leave the library. */
  gone: Track[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Moves each track's file in turn. A file that cannot be moved stays where it
 * is and is reported; one that is already gone is not a failure.
 */
export async function moveTracksToTrash(
  tracks: Track[],
  io: {
    exists: (path: string) => boolean;
    trash: (path: string) => Promise<void>;
    bin: string;
    /**
     * Run right before every attempt on a file, to let go of whatever is
     * reading it. Playback moves on when its decoder is stopped, and the next
     * track's decoder may hold the next file in the batch by the time its turn
     * comes, so one stop before the whole batch is not enough.
     */
    release?: (path: string) => Promise<void>;
    onProgress?: (done: number, total: number) => void;
    retryDelayMs?: number;
  },
): Promise<TrashOutcome> {
  const outcome: TrashOutcome = { trashed: [], gone: [], failed: [] };
  const attempt = async (path: string): Promise<void> => {
    // The move reports its own failure; a release that fails is not a reason to skip it.
    try {
      await io.release?.(path);
    } catch {
      /* the move below says whether the file is still held */
    }
    await io.trash(path);
  };
  let done = 0;
  for (const track of tracks) {
    if (!io.exists(track.path)) {
      outcome.gone.push(track);
    } else {
      try {
        await trashWithRetry(track.path, attempt, io.retryDelayMs);
        outcome.trashed.push(track);
      } catch (err) {
        outcome.failed.push({ path: track.path, error: trashErrorMessage(err, io.bin) });
      }
    }
    done += 1;
    if (io.onProgress && (done % TRASH_PROGRESS_EVERY === 0 || done === tracks.length)) io.onProgress(done, tracks.length);
  }
  return outcome;
}

// shell.trashItem reports the platform's own words. On Windows a file another
// program holds open and a drive with no Recycle Bin (network shares, some
// removable media) both come back as "Operation was aborted", so one message
// covers both; anything unrecognised is passed through as it came.
export function trashErrorMessage(error: unknown, bin: string): string {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).trim();
  if (/operation was aborted|cannot be recycled|not recyclable/i.test(raw)) {
    return `The file is in use, or its drive has no ${bin} (network shares and some removable drives). It was left where it is.`;
  }
  if (/used by another process|sharing violation|\bEBUSY\b|\bEPERM\b|\bin use\b/i.test(raw)) {
    return 'The file is in use by another program and was left where it is.';
  }
  if (/\bENOENT\b|no such file|not found|does not exist/i.test(raw)) return 'The file was not found.';
  return raw || `The file could not be moved to the ${bin}.`;
}
