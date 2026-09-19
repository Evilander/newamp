import { useEffect, useState } from 'react';
import type { SavedPlaylist } from '@shared/types';
import { api } from '../lib/api';

// The saved playlists, kept current: the main process announces every
// create/rename/fill/delete, so a picker never offers a stale list.
export function useSavedPlaylists(): SavedPlaylist[] {
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.getPlaylists()
        .then((next) => {
          if (!cancelled) setPlaylists(next);
        })
        .catch(() => undefined);
    };
    load();
    const off = api.onPlaylistsChanged(load);
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return playlists;
}
