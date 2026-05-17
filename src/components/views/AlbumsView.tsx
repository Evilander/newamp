import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AlbumSummary, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../lib/format';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';

const ALBUM_PAGE_SIZE = 240;
const CATALOG_SEARCH_DEBOUNCE_MS = 180;

export function AlbumsView(): JSX.Element {
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [selected, setSelected] = useState<AlbumSummary | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const current = usePlayerStore((s) => s.current);
  const [filter, setFilter] = useState('');
  const albumQuery = useDebouncedValue(filter, CATALOG_SEARCH_DEBOUNCE_MS);
  const [showMissingArtOnly, setShowMissingArtOnly] = useState(false);
  const [hasMoreAlbums, setHasMoreAlbums] = useState(false);
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const albumListRef = useRef<HTMLDivElement>(null);
  const [restoreAlbumScrollTop, setRestoreAlbumScrollTop] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadingAlbums(true);
    api
      .getAlbums({
        search: albumQuery,
        missingArtOnly: showMissingArtOnly,
        limit: ALBUM_PAGE_SIZE + 1,
        offset: 0,
      })
      .then((rows) => {
        if (cancelled) return;
        setAlbums(rows.slice(0, ALBUM_PAGE_SIZE));
        setHasMoreAlbums(rows.length > ALBUM_PAGE_SIZE);
        setRestoreAlbumScrollTop(0);
      })
      .catch(() => {
        if (!cancelled) {
          setAlbums([]);
          setHasMoreAlbums(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingAlbums(false);
      });
    return () => {
      cancelled = true;
    };
  }, [albumQuery, showMissingArtOnly]);

  useEffect(() => {
    if (!selected) return;
    api
      .getAlbumTracks(selected.album, selected.albumArtist)
      .then(setTracks)
      .catch(() => undefined);
  }, [selected?.album, selected?.albumArtist]);

  useLayoutEffect(() => {
    if (selected) return;
    const list = albumListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = restoreAlbumScrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected, restoreAlbumScrollTop, filter, showMissingArtOnly]);

  function openAlbum(album: AlbumSummary): void {
    setRestoreAlbumScrollTop(albumListRef.current?.scrollTop ?? 0);
    setSelected(album);
  }

  function closeAlbum(): void {
    setSelected(null);
  }

  async function loadMoreAlbums(): Promise<void> {
    if (loadingAlbums || !hasMoreAlbums) return;
    setLoadingAlbums(true);
    try {
      const rows = await api.getAlbums({
        search: albumQuery,
        missingArtOnly: showMissingArtOnly,
        limit: ALBUM_PAGE_SIZE + 1,
        offset: albums.length,
      });
      setAlbums((currentAlbums) => [...currentAlbums, ...rows.slice(0, ALBUM_PAGE_SIZE)]);
      setHasMoreAlbums(rows.length > ALBUM_PAGE_SIZE);
    } finally {
      setLoadingAlbums(false);
    }
  }

  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--line)' }}
        >
          <button className="pxbtn" onClick={closeAlbum}>
            ← All albums
          </button>
          <AlbumArt album={selected} />
          <div className="flex-1">
            <div className="text-lg font-semibold">{selected.album}</div>
            <div className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
              {selected.albumArtist}
              {selected.year ? `  ·  ${selected.year}` : ''}
              {`  ·  ${selected.trackCount} tracks  ·  ${formatDuration(selected.duration)}`}
            </div>
          </div>
          <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)}>
            ▶ Play album
          </button>
          <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play album next">
            PLAY NEXT
          </button>
          <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue album">
            QUEUE ALBUM
          </button>
          <PlaylistAppendPicker
            tracks={tracks}
            label="ADD ALBUM TO PLAYLIST"
            disabled={!tracks.length}
          />
        </div>
        <div className="flex-1 overflow-auto">
          <TrackTable
            tracks={tracks}
            currentId={current?.id ?? null}
            onPlay={(i) => void playQueue(tracks, i)}
            onPlayTracks={(selectedTracks) => void playQueue(selectedTracks, 0)}
            onPlayNext={queueTrackNext}
            onAddToQueue={addTrackToQueue}
            onPlayNextTracks={queueTracksNext}
            onAddTracksToQueue={addTracksToQueue}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <button
          className={`pxbtn ${showMissingArtOnly ? 'is-active' : ''}`}
          onClick={() => setShowMissingArtOnly((value) => !value)}
          title="Show albums that still need cover art"
        >
          MISSING ART
        </button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter albums…"
          className="bevel-in lcd-text flex-1 px-3 py-1.5 text-[14px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {albums.length.toLocaleString()}{hasMoreAlbums ? '+' : ''}{' '}
          {showMissingArtOnly ? 'missing-art albums' : 'albums'}
          {loadingAlbums ? ' / loading' : ''}
        </span>
      </div>
      <div ref={albumListRef} data-newamp-albums-scroll className="flex-1 overflow-auto p-4">
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}
        >
          {albums.map((a) => (
            <button
              key={`${a.album}::${a.albumArtist}`}
              onClick={() => openAlbum(a)}
              className="group flex flex-col gap-1 text-left"
            >
              <AlbumArt album={a} size={168} />
              <div className="truncate pt-1 text-[13px] font-semibold">{a.album}</div>
              <div className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }}>
                {a.albumArtist}
                {a.year ? `  ·  ${a.year}` : ''}
              </div>
            </button>
          ))}
        </div>
        {hasMoreAlbums && (
          <div className="flex justify-center py-4">
            <button
              className="pxbtn is-active"
              onClick={() => void loadMoreAlbums()}
              disabled={loadingAlbums}
              data-newamp-albums-load-more
            >
              {loadingAlbums ? 'Loading...' : 'Load more albums'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AlbumArt({ album, size = 64 }: { album: AlbumSummary; size?: number }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (album.artFromTrackId && !failed) {
    return (
      <div
        className="album-art-tile relative overflow-hidden"
        style={{ width: size, height: size, borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
      >
        <div className="album-art-placeholder flex h-full w-full items-center justify-center">
          <span>{album.album.slice(0, 2).toUpperCase() || 'LP'}</span>
        </div>
        <img
          src={api.getArtUrl(album.artFromTrackId)}
          alt={album.album}
          width={size}
          height={size}
          className="relative h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
          style={{ zIndex: 1 }}
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  return (
    <div
      className="album-art-tile album-art-placeholder flex items-center justify-center text-[22px]"
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      ♫
    </div>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}
