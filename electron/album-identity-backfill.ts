// Reads the album-grouping tags for rows scanned before those tags were
// stored. A row's size and date say whether its file is unchanged since the
// scan, and a changed file is left for the next scan to read in full. Playback
// comes first: nothing is read while the gapless stream is short of audio.

import { promises as fs } from 'node:fs';
import type { LibraryStore } from './library.js';
import type { TrackTagExtras } from '../shared/album-identity.js';
import { whenPlaybackFed } from './playback-io.js';

export interface TagBackfillControl {
  cancelled: boolean;
}

export interface TagBackfillResult {
  read: number;
  unreadable: number;
  skipped: number;
  completed: boolean;
}

// Small batches keep every stretch of synchronous work short: parsing a tag
// block is a few milliseconds and the database write for a batch is less.
const BATCH_SIZE = 48;
// A few reads in flight is enough to keep a disk busy without starving playback.
const READ_CONCURRENCY = 4;
const BATCH_PAUSE_MS = 10;

const NO_TAGS: TrackTagExtras = {
  albumArtistTag: null,
  compilation: false,
  albumArtistSort: null,
  artistSort: null,
  discTotal: null,
  trackTotal: null,
  discSubtitle: null,
  mbReleaseGroupId: null,
  originalYear: null,
  artists: null,
  genres: null,
};

async function pMap<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runTagBackfill(
  library: LibraryStore,
  read: (path: string) => Promise<TrackTagExtras | null>,
  control: TagBackfillControl,
): Promise<TagBackfillResult> {
  const result: TagBackfillResult = { read: 0, unreadable: 0, skipped: 0, completed: false };
  let after = 0;
  for (;;) {
    if (control.cancelled || library.isClosed()) return result;
    // A grouping pass reads the whole library and stops if a row changes under
    // it, so a batch waits for one that is running instead of restarting it.
    await library.albumsReady();
    await whenPlaybackFed();
    if (control.cancelled || library.isClosed()) return result;
    const batch = library.getTagBackfillBatch(BATCH_SIZE, after);
    if (!batch.length) break;
    after = batch[batch.length - 1]!.id;

    const rows = await pMap(batch, READ_CONCURRENCY, async (row) => {
      try {
        const stat = await fs.stat(row.path);
        // Changed since the scan, or not a file any more: the next scan reads it whole.
        if ((row.size != null && stat.size !== row.size) || Math.round(stat.mtimeMs) !== row.mtime) {
          result.skipped++;
          return null;
        }
      } catch {
        result.skipped++;
        return null;
      }
      const tags = await read(row.path);
      if (tags) result.read++;
      else result.unreadable++;
      // A file that will not parse is marked done with no tags, so it is not
      // tried again on every launch; it fails the same way each time.
      return { id: row.id, ...(tags ?? NO_TAGS) };
    });
    await library.albumsReady();
    if (control.cancelled || library.isClosed()) return result;
    library.applyTagBackfill(rows.filter((r): r is { id: number } & TrackTagExtras => r !== null));
    await new Promise<void>((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
  }

  result.completed = true;
  library.finishTagBackfill();
  // The album artist the files name is known now for every row that was read.
  await library.regroupAlbums();
  return result;
}
