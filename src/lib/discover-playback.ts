import type { Track } from '@shared/types';
import { usePlayerStore } from '../store/usePlayerStore';

export async function playDiscoverQueue(tracks: Track[], index = 0): Promise<void> {
  if (!tracks.length) return;
  const player = usePlayerStore.getState();
  await player.playQueue(tracks, index, 0, { finite: true });
}
