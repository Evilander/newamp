import { useEffect, useMemo, useState } from 'react';
import type { FolderSummary, SavedPlaylist, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../lib/format';
import { api } from '../../lib/api';
import { TrackTable } from './LibraryView';

const FOLDER_TRACK_LIMIT = 5000;

export function FoldersView(): JSX.Element {
  const [stack, setStack] = useState<FolderSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const selected = stack[stack.length - 1] ?? null;
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const current = usePlayerStore((s) => s.current);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus(null);
    api.getFolders(selected?.path ?? null)
      .then((next) => {
        if (!cancelled) setFolders(next);
      })
      .catch(() => {
        if (!cancelled) setStatus('Folder index unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.path]);

  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setTracks([]);
      return () => {
        cancelled = true;
      };
    }
    api.getFolderTracks(selected.path, { recursive: false, limit: FOLDER_TRACK_LIMIT })
      .then((next) => {
        if (!cancelled) setTracks(next);
      })
      .catch(() => {
        if (!cancelled) setTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.path]);

  const totalTracks = useMemo(
    () => (selected ? selected.totalTrackCount : folders.reduce((sum, folder) => sum + folder.totalTrackCount, 0)),
    [folders, selected],
  );

  function openFolder(folder: FolderSummary): void {
    setStack((currentStack) => [...currentStack, folder]);
  }

  function jumpTo(index: number): void {
    setStack((currentStack) => currentStack.slice(0, index + 1));
  }

  async function withFolderTracks(
    folder: FolderSummary,
    action: (nextTracks: Track[]) => void | Promise<void>,
  ): Promise<void> {
    setStatus(`Loading ${folder.name}...`);
    const nextTracks = await api.getFolderTracks(folder.path, { recursive: true, limit: 100000 });
    if (!nextTracks.length) {
      setStatus(`${folder.name} has no playable tracks.`);
      return;
    }
    await action(nextTracks);
    setStatus(`${nextTracks.length.toLocaleString()} tracks loaded from ${folder.name}.`);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <button className="pxbtn" onClick={() => setStack([])} disabled={!stack.length}>
          Roots
        </button>
        {stack.map((folder, index) => (
          <button
            key={`${folder.path}-${index}`}
            className={`pxbtn ${index === stack.length - 1 ? 'is-active' : ''}`}
            onClick={() => jumpTo(index)}
            title={folder.path}
          >
            {folder.name}
          </button>
        ))}
        <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
          {loading ? 'Loading...' : `${folders.length.toLocaleString()} folders / ${totalTracks.toLocaleString()} tracks`}
        </span>
      </div>

      {selected && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
          <FolderArt folder={selected} size={44} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{selected.name}</div>
            <div className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }} title={selected.path}>
              {selected.path}
            </div>
          </div>
          <button
            className="pxbtn is-active"
            disabled={!selected.totalTrackCount}
            onClick={() => void withFolderTracks(selected, (nextTracks) => playQueue(nextTracks, 0))}
          >
            PLAY FOLDER
          </button>
          <button
            className="pxbtn"
            disabled={!selected.totalTrackCount}
            onClick={() => void withFolderTracks(selected, queueTracksNext)}
          >
            NEXT FOLDER
          </button>
          <button
            className="pxbtn"
            disabled={!selected.totalTrackCount}
            onClick={() => void withFolderTracks(selected, addTracksToQueue)}
          >
            QUEUE FOLDER
          </button>
          <FolderPlaylistAppendPicker folder={selected} onStatus={setStatus} />
        </div>
      )}

      {status && (
        <div className="border-b px-3 py-1 text-[11px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}>
          {status}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,0.42fr)_minmax(0,1fr)]">
        <div className="overflow-auto border-b" style={{ borderColor: 'var(--line)' }}>
          <table className="w-full table-fixed text-[12px]" style={{ fontFamily: 'var(--font-mono)', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead className="sticky top-0 z-10" style={{ background: 'var(--panel)', color: 'var(--ink-2)' }}>
              <tr className="text-left text-[9px] uppercase tracking-[0.12em]">
                <th className="w-[54px] px-3 py-[7px]"></th>
                <th className="px-2 py-[7px]">Folder</th>
                <th className="w-[110px] px-2 py-[7px] text-right">Tracks</th>
                <th className="w-[110px] px-2 py-[7px] text-right">Direct</th>
                <th className="w-[96px] px-2 py-[7px] text-right">Time</th>
                <th className="w-[92px] px-2 py-[7px] text-right">Folders</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder, index) => (
                <tr
                  key={folder.path}
                  className="cursor-pointer"
                  style={{ background: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)' }}
                  onDoubleClick={() => openFolder(folder)}
                >
                  <td className="px-3 py-[6px]">
                    <FolderArt folder={folder} size={34} />
                  </td>
                  <td className="min-w-0 px-2 py-[6px]">
                    <button className="block max-w-full truncate text-left font-semibold" onClick={() => openFolder(folder)} title={folder.path}>
                      {folder.name}
                    </button>
                    <div className="truncate text-[10px]" style={{ color: 'var(--muted)' }} title={folder.path}>
                      {folder.path}
                    </div>
                  </td>
                  <td className="px-2 py-[6px] text-right tabular-nums">{folder.totalTrackCount.toLocaleString()}</td>
                  <td className="px-2 py-[6px] text-right tabular-nums" style={{ color: 'var(--ink-2)' }}>
                    {folder.trackCount.toLocaleString()}
                  </td>
                  <td className="px-2 py-[6px] text-right tabular-nums" style={{ color: 'var(--ink-2)' }}>
                    {formatDuration(folder.duration)}
                  </td>
                  <td className="px-2 py-[6px] text-right tabular-nums" style={{ color: 'var(--muted)' }}>
                    {folder.childFolderCount.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="min-h-0 overflow-auto">
          {selected ? (
            <>
              {selected.trackCount > tracks.length && (
                <div className="border-b px-3 py-1 text-[11px]" style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>
                  Showing first {tracks.length.toLocaleString()} direct tracks. Folder actions include subfolders.
                </div>
              )}
              <TrackTable
                tracks={tracks}
                currentId={current?.id ?? null}
                onPlay={(index) => void playQueue(tracks, index)}
                onPlayTracks={(selectedTracks) => void playQueue(selectedTracks, 0)}
                onPlayNext={queueTrackNext}
                onAddToQueue={addTrackToQueue}
                onPlayNextTracks={queueTracksNext}
                onAddTracksToQueue={addTracksToQueue}
              />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
              Open a root folder to browse its cataloged subfolders and direct tracks.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FolderArt({ folder, size }: { folder: FolderSummary; size: number }): JSX.Element {
  if (folder.artFromTrackId) {
    return (
      <img
        src={api.getArtUrl(folder.artFromTrackId)}
        alt=""
        width={size}
        height={size}
        className="object-cover"
        style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
        draggable={false}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center text-[16px]"
      style={{
        width: size,
        height: size,
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
        color: 'var(--muted)',
      }}
    >
      DIR
    </div>
  );
}

function FolderPlaylistAppendPicker({
  folder,
  onStatus,
}: {
  folder: FolderSummary;
  onStatus: (status: string | null) => void;
}): JSX.Element | null {
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.getPlaylists()
      .then((next) => {
        if (!cancelled) setPlaylists(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function appendToPlaylist(playlistId: number): Promise<void> {
    onStatus(`Loading ${folder.name}...`);
    const tracks = await api.getFolderTracks(folder.path, { recursive: true, limit: 100000 });
    const updated = await api.addTracksToPlaylist({ playlistId, trackIds: tracks.map((track) => track.id) });
    if (!updated) {
      onStatus('Playlist was not found.');
      return;
    }
    setPlaylists((current) => current.map((playlist) => (playlist.id === updated.id ? updated : playlist)));
    onStatus(`Added ${tracks.length.toLocaleString()} tracks from ${folder.name} to ${updated.name}.`);
  }

  if (!playlists.length) return null;

  return (
    <select
      aria-label="Add folder to playlist"
      title="Add folder to playlist"
      value=""
      disabled={!folder.totalTrackCount}
      onChange={(event) => {
        const playlistId = Number(event.currentTarget.value);
        if (playlistId > 0) void appendToPlaylist(playlistId);
      }}
      className="bevel-in px-2 py-1 text-[11px] outline-none"
      style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
    >
      <option value="">ADD FOLDER TO PLAYLIST</option>
      {playlists.map((playlist) => (
        <option key={playlist.id} value={playlist.id}>
          {playlist.name}
        </option>
      ))}
    </select>
  );
}
