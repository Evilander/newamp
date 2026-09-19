import type { MenuItemConstructorOptions } from 'electron';
import type { TrackContextMenuChoice, TrackContextMenuRequest } from '../shared/types.js';

// Template for the native right-click menu on tracks. Pure, so the item list
// can be tested without Electron; main.ts wires `choose` and pops it up.
export function trackContextMenuTemplate(
  request: TrackContextMenuRequest,
  choose: (choice: TrackContextMenuChoice) => () => void,
): MenuItemConstructorOptions[] {
  const count = Math.max(1, Math.trunc(Number(request?.trackCount) || 1));
  const playlists = (Array.isArray(request?.playlists) ? request.playlists : [])
    .map((playlist) => ({ id: Math.trunc(Number(playlist?.id)), name: String(playlist?.name ?? '').slice(0, 80) }))
    .filter((playlist) => playlist.id > 0 && playlist.name);
  const template: MenuItemConstructorOptions[] = [
    { label: 'Play Next', click: choose({ action: 'play-next' }) },
    { label: 'Add to Queue', click: choose({ action: 'add-to-queue' }) },
    { type: 'separator' },
    {
      label: 'Add to Playlist',
      submenu: [
        {
          label: count === 1 ? 'New Playlist' : `New Playlist from ${count.toLocaleString('en-US')} Tracks`,
          click: choose({ action: 'new-playlist' }),
        },
        ...(playlists.length ? [{ type: 'separator' as const }] : []),
        ...playlists.map((playlist) => ({
          label: escapeMenuLabel(playlist.name),
          click: choose({ action: 'add-to-playlist', playlistId: playlist.id }),
        })),
      ],
    },
  ];
  if (request?.canShowInFolder) {
    template.push({ type: 'separator' }, { label: 'Show in Folder', click: choose({ action: 'show-in-folder' }) });
  }
  return template;
}

// '&' marks an access key in Windows menu labels.
function escapeMenuLabel(label: string): string {
  return label.replace(/&/g, '&&');
}
