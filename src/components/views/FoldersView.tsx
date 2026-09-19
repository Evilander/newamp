import { useEffect, useMemo, useRef, useState } from 'react';
import type { FolderSummary, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../lib/format';
import { api } from '../../lib/api';
import { pushToast } from '../../lib/toast';
import { spectralArtDataUrl } from '@shared/spectral-art';
import { TrackTable } from './LibraryView';
import { useSavedPlaylists } from '../../hooks/useSavedPlaylists';
import { useVirtualRows } from '../../hooks/useVirtualRows';
import { LoadMoreFooter } from './LoadMoreFooter';
import { ViewHeader } from '../ViewHeader';
import { Chip } from '../Chip';
import { EmptyState } from '../EmptyState';
import { ViewSkeleton } from '../ViewSkeleton';
import { Queue } from '../Icons';

const FOLDER_TRACK_LIMIT = 600;
const FOLDER_ROW_HEIGHT = 48;

// The folder index keeps paths in one normalized form (backslashes) for
// matching; show them the way this OS writes them.
function displayFolderPath(path: string): string {
  return api.platform === 'win32' ? path : path.replace(/\\/g, '/');
}

function searchLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function FoldersView(): JSX.Element {
  const [stack, setStack] = useState<FolderSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMoreTracks, setLoadingMoreTracks] = useState(false);
  const [hasMoreDirectTracks, setHasMoreDirectTracks] = useState(false);
  const [indexError, setIndexError] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const [folderFilter, setFolderFilter] = useState('');
  const folderListRef = useRef<HTMLDivElement>(null);
  const selected = stack[stack.length - 1] ?? null;
  const setView = usePlayerStore((s) => s.setView);
  const setSearchQuery = usePlayerStore((s) => s.setSearchQuery);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const current = usePlayerStore((s) => s.current);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setIndexError(false);
    api.getFolders(selected?.path ?? null)
      .then((next) => {
        if (!cancelled) setFolders(next);
      })
      .catch(() => {
        if (!cancelled) {
          setFolders([]);
          setIndexError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.path, refreshSeed]);

  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setTracks([]);
      setHasMoreDirectTracks(false);
      return () => {
        cancelled = true;
      };
    }
    api.getFolderTracks(selected.path, { recursive: false, limit: FOLDER_TRACK_LIMIT })
      .then((next) => {
        if (!cancelled) {
          setTracks(next);
          setHasMoreDirectTracks(next.length < selected.trackCount);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTracks([]);
          setHasMoreDirectTracks(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.path, selected?.trackCount]);

  useEffect(() => {
    setFolderFilter('');
    folderListRef.current?.scrollTo({ top: 0 });
  }, [selected?.path]);

  const visibleFolders = useMemo(() => {
    const needle = folderFilter.trim().toLowerCase();
    return needle ? folders.filter((folder) => folder.name.toLowerCase().includes(needle)) : folders;
  }, [folders, folderFilter]);
  // An Artist/Album library puts thousands of folders at the root level; only
  // the rows in view are mounted.
  const folderRows = useVirtualRows({
    rowCount: visibleFolders.length,
    rowHeight: FOLDER_ROW_HEIGHT,
    scrollRef: folderListRef,
    enabled: visibleFolders.length > 0,
  });

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
    try {
      const nextTracks = await api.getFolderTracks(folder.path, { recursive: true, limit: 100000 });
      if (!nextTracks.length) {
        pushToast({ tone: 'warn', title: 'Nothing to play', detail: `${folder.name} has no playable tracks.` });
        return;
      }
      await action(nextTracks);
      pushToast({
        tone: 'ok',
        title: `${nextTracks.length.toLocaleString()} tracks loaded`,
        detail: `From ${folder.name}, subfolders included.`,
      });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: `Couldn't load ${folder.name}`,
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  }

  // A smart playlist that is this folder: it plays every track under it, in
  // folder order, and follows the folder as files come and go.
  async function saveFolderSmartRule(folder: FolderSummary): Promise<void> {
    const folderPath = displayFolderPath(folder.path);
    try {
      const rules = await api.getSmartPlaylistRules();
      const sameFolder = rules.find((rule) => rule.folderPath === folderPath);
      let name = sameFolder?.name ?? folder.name;
      for (let n = 2; !sameFolder && rules.some((rule) => rule.name === name); n += 1) name = `${folder.name} ${n}`;
      const rule = await api.saveSmartPlaylistRule({ id: sameFolder?.id, name, mood: 'focus', count: 200, folderPath });
      pushToast({
        tone: 'ok',
        title: `Smart playlist: ${rule.name}`,
        detail: 'Saved under Playlists. It keeps up with the folder as tracks come and go.',
        action: {
          label: 'PLAY',
          onClick: () => {
            void api.runSmartPlaylistRule(rule.id).then((ruleTracks) => {
              if (ruleTracks.length) void playQueue(ruleTracks, 0);
            });
          },
        },
      });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: `Couldn't save ${folder.name} as a smart playlist`,
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  }

  function showFolderInLibrary(folder: FolderSummary): void {
    // The trailing separator keeps "Rock" from also matching "Rock Classics".
    setSearchQuery(`path:"${searchLiteral(`${displayFolderPath(folder.path).replace(/[\\/]+$/, '')}/`)}"`);
    setView('library');
  }

  async function loadMoreDirectTracks(): Promise<void> {
    if (!selected || loadingMoreTracks || !hasMoreDirectTracks) return;
    const offset = tracks.length;
    setLoadingMoreTracks(true);
    try {
      const next = await api.getFolderTracks(selected.path, {
        recursive: false,
        limit: FOLDER_TRACK_LIMIT,
        offset,
      });
      setTracks((currentTracks) => {
        const seen = new Set(currentTracks.map((track) => track.id));
        return [...currentTracks, ...next.filter((track) => !seen.has(track.id))];
      });
      setHasMoreDirectTracks(offset + next.length < selected.trackCount);
    } finally {
      setLoadingMoreTracks(false);
    }
  }

  async function scanLibraryNow(): Promise<void> {
    setScanBusy(true);
    pushToast({ title: 'Scanning music folders…' });
    try {
      await api.scanLibrary();
      setRefreshSeed((seed) => seed + 1);
      pushToast({ tone: 'ok', title: 'Library scan finished' });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Library scan failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setScanBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        eyebrow="Explore"
        title="Folders"
        count={`${folders.length.toLocaleString()} ${folders.length === 1 ? 'folder' : 'folders'}`}
        status={
          loading ? (
            <Chip tone="muted" size="sm">
              Loading…
            </Chip>
          ) : scanBusy ? (
            <Chip tone="accent" size="sm">
              Scanning…
            </Chip>
          ) : (
            <span style={{ color: 'var(--muted)' }}>
              {totalTracks.toLocaleString()} {totalTracks === 1 ? 'track' : 'tracks'}
            </span>
          )
        }
        actions={
          <input
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            placeholder="Filter folders…"
            aria-label="Filter folders"
            className="catalog-header-filter bevel-in lcd-text px-3 py-1.5 text-[14px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          />
        }
      />

      {stack.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
          <button className="pxbtn" onClick={() => setStack([])}>
            Roots
          </button>
          {stack.map((folder, index) => (
            <button
              key={`${folder.path}-${index}`}
              className={`pxbtn ${index === stack.length - 1 ? 'is-active' : ''}`}
              onClick={() => jumpTo(index)}
              title={displayFolderPath(folder.path)}
            >
              {folder.name}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
          <FolderArt folder={selected} size={44} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{selected.name}</div>
            <div className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }} title={displayFolderPath(selected.path)}>
              {displayFolderPath(selected.path)}
            </div>
          </div>
          <button
            className="pxbtn is-active"
            disabled={!selected.totalTrackCount}
            onClick={() => void withFolderTracks(selected, (nextTracks) => playQueue(nextTracks, 0))}
          >
            Play folder
          </button>
          <button
            className="pxbtn"
            disabled={!selected.totalTrackCount}
            title="Play folder next"
            onClick={() => void withFolderTracks(selected, queueTracksNext)}
          >
            Next
          </button>
          <button
            className="pxbtn"
            disabled={!selected.totalTrackCount}
            title="Queue folder"
            onClick={() => void withFolderTracks(selected, addTracksToQueue)}
          >
            Queue
          </button>
          <FolderPlaylistAppendPicker folder={selected} />
          <button
            className="pxbtn"
            disabled={!selected.totalTrackCount}
            title="Save a smart playlist that always holds this folder's tracks"
            onClick={() => void saveFolderSmartRule(selected)}
          >
            Smart playlist
          </button>
          <button
            className="pxbtn"
            disabled={!selected.totalTrackCount}
            title="Filter the Library to this folder"
            onClick={() => showFolderInLibrary(selected)}
          >
            Show in Library
          </button>
        </div>
      )}

      {/* Adaptive layout: when no folder is selected, the folder list takes the
          whole available height so users can see as many folders as fit. When
          a folder is selected, split the space so tracks have room. The hard
          42% cap before made only ~7 folders visible on typical 800px windows
          even when no track preview was needed. */}
      <div
        className={`grid min-h-0 flex-1 ${selected ? 'grid-rows-[minmax(180px,0.42fr)_minmax(0,1fr)]' : 'grid-rows-[minmax(0,1fr)]'}`}
        data-newamp-folders-layout={selected ? 'split' : 'list-full'}
      >
        <div
          ref={folderListRef}
          onScroll={folderRows.onScroll}
          className="overflow-auto border-b"
          style={{ borderColor: 'var(--line)' }}
        >
          {loading ? (
            <ViewSkeleton variant="rows" count={selected ? 5 : 12} />
          ) : folders.length > 0 && visibleFolders.length === 0 ? (
            <EmptyState
              size={selected ? 'panel' : 'view'}
              title="No folders match"
              body={`No folder here has "${folderFilter.trim()}" in its name.`}
              actions={
                <button className="pxbtn" onClick={() => setFolderFilter('')}>
                  Clear filter
                </button>
              }
            />
          ) : folders.length === 0 ? (
            indexError ? (
              <EmptyState
                size={selected ? 'panel' : 'view'}
                title="Folder index unavailable"
                body="The folder index could not be read. Retry once the library finishes scanning."
                actions={
                  <button className="pxbtn" onClick={() => setRefreshSeed((seed) => seed + 1)}>
                    Retry
                  </button>
                }
              />
            ) : selected ? (
              <EmptyState
                size="panel"
                title="No subfolders"
                body={`Every track in ${selected.name} sits at this level.`}
              />
            ) : (
              <EmptyState
                icon={<Queue size={36} />}
                title="No folders indexed yet"
                body="Folders mirror your music exactly as it sits on disk. Scan a music folder and the tree appears here."
                actions={
                  <button className="pxbtn is-active" onClick={() => void scanLibraryNow()} disabled={scanBusy}>
                    Scan library
                  </button>
                }
              />
            )
          ) : (
            <table
              className="catalog-zebra w-full table-fixed text-[12px]"
              style={{ fontFamily: 'var(--font-mono)', borderCollapse: 'separate', borderSpacing: 0 }}
            >
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
                {folderRows.topPad > 0 && (
                  <tr aria-hidden><td colSpan={6} style={{ height: folderRows.topPad, padding: 0, border: 0 }} /></tr>
                )}
                {visibleFolders.slice(folderRows.startIndex, folderRows.endIndex + 1).map((folder) => (
                  <tr
                    key={folder.path}
                    className="cursor-pointer"
                    style={{ height: FOLDER_ROW_HEIGHT }}
                    onDoubleClick={() => openFolder(folder)}
                  >
                    <td className="px-3 py-[6px]">
                      <FolderArt folder={folder} size={34} />
                    </td>
                    <td className="min-w-0 px-2 py-[6px]">
                      <button
                        className="block max-w-full truncate text-left font-semibold"
                        onClick={() => openFolder(folder)}
                        title={displayFolderPath(folder.path)}
                      >
                        {folder.name}
                      </button>
                      <div className="truncate text-[10px]" style={{ color: 'var(--muted)' }} title={displayFolderPath(folder.path)}>
                        {displayFolderPath(folder.path)}
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
                {folderRows.bottomPad > 0 && (
                  <tr aria-hidden><td colSpan={6} style={{ height: folderRows.bottomPad, padding: 0, border: 0 }} /></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {selected ? (
          <div className="min-h-0 overflow-auto">
            {selected.trackCount > tracks.length && (
              <div className="border-b px-3 py-1 text-[11px]" style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>
                Showing first {tracks.length.toLocaleString()} direct tracks. Load more to browse the rest. Folder actions include subfolders.
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
            <LoadMoreFooter
              shown={tracks.length}
              total={selected.trackCount}
              noun="direct tracks"
              hasMore={hasMoreDirectTracks}
              loading={loadingMoreTracks}
              loadLabel="Load more direct tracks"
              onLoadMore={() => void loadMoreDirectTracks()}
            />
          </div>
        ) : null}
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
    <img
      src={spectralArtDataUrl({ artist: folder.parentPath ?? '', album: folder.name }, Math.max(96, size * 2))}
      alt={`${folder.name} (spectral cover)`}
      width={size}
      height={size}
      style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
      title="Spectral cover (auto-generated)"
      draggable={false}
    />
  );
}

function FolderPlaylistAppendPicker({ folder }: { folder: FolderSummary }): JSX.Element | null {
  const playlists = useSavedPlaylists();

  async function appendToPlaylist(playlistId: number): Promise<void> {
    try {
      const trackIds = await api.getFolderTrackIds(folder.path, { recursive: true, limit: 100000 });
      if (!trackIds.length) {
        pushToast({ tone: 'warn', title: 'Nothing to add', detail: `${folder.name} has no playable tracks.` });
        return;
      }
      const updated = await api.addTracksToPlaylist({ playlistId, trackIds });
      if (!updated) {
        pushToast({ tone: 'error', title: 'Playlist was not found' });
        return;
      }
      pushToast({
        tone: 'ok',
        title: `Added to ${updated.name}`,
        detail: `${trackIds.length.toLocaleString()} tracks from ${folder.name}.`,
      });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: `Couldn't add ${folder.name} to the playlist`,
        detail: err instanceof Error ? err.message : undefined,
      });
    }
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
      <option value="">Add folder to playlist</option>
      {playlists.map((playlist) => (
        <option key={playlist.id} value={playlist.id}>
          {playlist.name}
        </option>
      ))}
    </select>
  );
}
