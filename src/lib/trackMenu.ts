// The right-click menu for tracks, shared by every track list. The menu itself
// is native (built in the main process); this side supplies the playlists and
// carries out the choice.
import type { Track, TrashProgress, TrashTracksResult } from '@shared/types';
import { usePlayerStore } from '../store/usePlayerStore';
import { api } from './api';
import { dismissToast, getToasts, pushToast, subscribeToasts } from './toast';
import { canTrashTracks, describeTrashProgress, describeTrashResult } from './trashResult';

export function defaultPlaylistName(tracks: Track[]): string {
  if (tracks.length <= 1) return 'New Playlist';
  const date = new Date().toISOString().slice(0, 10);
  const firstArtist = tracks.find((track) => track.artist.trim())?.artist.trim();
  return firstArtist ? `${firstArtist} Selection ${date}` : `Selected Tracks ${date}`;
}

function describe(tracks: Track[]): string {
  return tracks.length === 1 ? tracks[0]!.title : `${tracks.length.toLocaleString()} tracks`;
}

function isLocalPath(path: string | null | undefined): path is string {
  return !!path && !/^[a-z][a-z0-9+.-]+:\/\//i.test(path);
}

// A large move reports as it goes. The report replaces the toast before it, so
// one stays on screen; a toast the user closed stays closed. The stack drops
// its oldest toast when a newer one arrives, which is this one for the whole
// move, so a toast that vanished as another appeared is put back.
export async function trashTracksWithProgress(trackIds: number[], bin: string): Promise<TrashTracksResult> {
  let shown: number | null = null;
  let closed = false;
  let changing = false;
  let before = getToasts();
  const unwatch = subscribeToasts(() => {
    const now = getToasts();
    if (!changing && shown != null && before.some((item) => item.id === shown) && !now.some((item) => item.id === shown)) {
      const evicted = now.some((item) => !before.some((old) => old.id === item.id));
      if (!evicted) closed = true;
    }
    before = now;
  });
  const stop = api.onTrashProgress((progress: TrashProgress) => {
    const toast = describeTrashProgress(progress, bin);
    if (!toast || closed) return;
    changing = true;
    try {
      if (shown != null) dismissToast(shown);
      shown = pushToast({ ...toast, durationMs: 0 });
    } finally {
      changing = false;
    }
  });
  try {
    return await api.trashTracks(trackIds);
  } finally {
    stop();
    unwatch();
    if (shown != null) dismissToast(shown);
  }
}

export async function openTrackContextMenu(tracks: Track[]): Promise<void> {
  if (!tracks.length) return;
  const playlists = await api.getPlaylists().catch(() => []);
  const choice = await api.showTrackContextMenu({
    trackCount: tracks.length,
    playlists: playlists.map((playlist) => ({ id: playlist.id, name: playlist.name })),
    canShowInFolder: tracks.length === 1 && isLocalPath(tracks[0]!.path),
    canTrash: canTrashTracks(tracks),
  });
  if (!choice) return;
  const store = usePlayerStore.getState();
  const trackIds = tracks.map((track) => track.id);
  switch (choice.action) {
    case 'play-next':
      store.queueTracksNext(tracks);
      pushToast({ tone: 'ok', title: 'Playing next', detail: describe(tracks) });
      return;
    case 'add-to-queue':
      store.addTracksToQueue(tracks);
      pushToast({ tone: 'ok', title: 'Added to queue', detail: describe(tracks) });
      return;
    case 'add-to-playlist': {
      const updated = await api.addTracksToPlaylist({ playlistId: choice.playlistId, trackIds });
      if (!updated) {
        pushToast({ tone: 'warn', title: 'Playlist was not found' });
        return;
      }
      pushToast({
        tone: 'ok',
        title: `Added to ${updated.name}`,
        detail: `${describe(tracks)} · ${updated.trackCount.toLocaleString()} in the playlist`,
        action: { label: 'SHOW', onClick: () => usePlayerStore.getState().navigateToPlaylist(updated.id) },
      });
      return;
    }
    case 'new-playlist': {
      const saved = await api.savePlaylist({ name: defaultPlaylistName(tracks), trackIds });
      pushToast({
        tone: 'ok',
        title: `Created ${saved.name}`,
        detail: `${describe(tracks)}. Rename it in Playlists.`,
        action: { label: 'SHOW', onClick: () => usePlayerStore.getState().navigateToPlaylist(saved.id) },
      });
      return;
    }
    case 'show-in-folder':
      void api.showInFolder(tracks[0]!.path);
      return;
    case 'trash': {
      // The main process asks first; the files and their library rows go
      // together, and the player drops them on the tracks-removed event.
      const bin = /^win/i.test(navigator.platform) ? 'Recycle Bin' : 'Trash';
      const result = await trashTracksWithProgress(trackIds, bin);
      for (const toast of describeTrashResult(result, tracks, bin)) pushToast(toast);
      return;
    }
  }
}
