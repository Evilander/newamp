// The right-click menu for tracks, shared by every track list. The menu itself
// is native (built in the main process); this side supplies the playlists and
// carries out the choice.
import type { Track } from '@shared/types';
import { usePlayerStore } from '../store/usePlayerStore';
import { api } from './api';
import { pushToast } from './toast';

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

export async function openTrackContextMenu(tracks: Track[]): Promise<void> {
  if (!tracks.length) return;
  const playlists = await api.getPlaylists().catch(() => []);
  const choice = await api.showTrackContextMenu({
    trackCount: tracks.length,
    playlists: playlists.map((playlist) => ({ id: playlist.id, name: playlist.name })),
    canShowInFolder: tracks.length === 1 && isLocalPath(tracks[0]!.path),
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
  }
}
