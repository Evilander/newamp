// Keeps the player's copies of tracks in step with edits made in the Library.
// The queue and the track on deck hold snapshots taken when they were queued,
// so a retagged track would keep its old title in the transport, Now Playing
// and the scrobble payload until it was queued again.
import type { Track } from '@shared/types';

/** Every distinct id the player holds a snapshot of: the track on deck, then the queue. */
export function playerTrackIds(state: { current: Track | null; queue: readonly Track[] }): number[] {
  const ids = new Set<number>();
  if (state.current && state.current.id > 0) ids.add(state.current.id);
  for (const track of state.queue) if (track.id > 0) ids.add(track.id);
  return [...ids];
}

/**
 * Fresh rows for everything the player holds, for edits that touch tracks
 * nobody named (a reset of adopted tags across the whole library). Empty when
 * the player holds nothing or the lookup fails: stale tags beat a broken reset.
 */
export async function freshPlayerTracks(
  state: { current: Track | null; queue: readonly Track[] },
  getTracksByIds: (ids: number[]) => Promise<Track[]>,
): Promise<Track[]> {
  const ids = playerTrackIds(state);
  if (!ids.length) return [];
  try {
    return await getTracksByIds(ids);
  } catch {
    return [];
  }
}
