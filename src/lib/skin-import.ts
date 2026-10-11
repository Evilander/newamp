import type { CustomSkin } from '@shared/types';
import { usePlayerStore } from '../store/usePlayerStore';
import { pushToast } from './toast';
import { applySkinKeepingPrevious, removeFromShelf, shelfSkin } from './skin-shelf';

const UNDO_TOAST_MS = 9000;

/**
 * Applies an imported or dropped skin as the custom skin, keeping the one it
 * replaces. A skin taken off the shelf passes `fromShelf`.
 */
export function applyImportedSkin(skin: CustomSkin, options: { fromShelf?: boolean } = {}): Promise<CustomSkin | null> {
  return applySkinKeepingPrevious(
    skin,
    {
      current: () => usePlayerStore.getState().settings?.customSkin,
      save: (next) => usePlayerStore.getState().saveCustomSkin(next),
      shelve: (previous) => shelfSkin(previous),
      unshelve: (name) => removeFromShelf(name),
      notify: (toast) => pushToast({ tone: 'ok', durationMs: UNDO_TOAST_MS, ...toast }),
    },
    options,
  );
}
