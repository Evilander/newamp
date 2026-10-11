// The wheel handler for every control that sets the player volume, bound to
// the player store so each reads the live volume when the event fires.

import { usePlayerStore } from '../store/usePlayerStore';
import { handleVolumeWheel, type VolumeAccess, type WheelSource } from './wheel-volume';

const playerVolume: VolumeAccess = {
  read: () => usePlayerStore.getState().volume,
  write: (volume) => void usePlayerStore.getState().setVolume(volume),
};

export function handlePlayerWheel(event: WheelEvent, source: WheelSource): void {
  handleVolumeWheel(event, source, playerVolume);
}
