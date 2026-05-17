import { useEffect, useState } from 'react';
import type { Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';
import { LoadMoreFooter } from './LoadMoreFooter';

const LOVED_PAGE_SIZE = 600;

export function LovedView(): JSX.Element {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreLoved, setHasMoreLoved] = useState(false);
  const [totalLoved, setTotalLoved] = useState(0);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const toggleStoreLove = usePlayerStore((s) => s.toggleLove);
  const current = usePlayerStore((s) => s.current);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getTracks({ sort: 'loved', limit: LOVED_PAGE_SIZE, offset: 0 }),
      api.getTrackCount({ sort: 'loved' }),
    ])
      .then(([rows, total]) => {
        if (cancelled) return;
        const lovedRows = rows.filter((track) => track.loved);
        setTracks(lovedRows);
        setTotalLoved(total);
        setHasMoreLoved(lovedRows.length < total);
      })
      .catch(() => {
        if (cancelled) return;
        setTracks([]);
        setTotalLoved(0);
        setHasMoreLoved(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMoreLoved(): Promise<void> {
    if (loadingMore || !hasMoreLoved) return;
    const offset = tracks.length;
    setLoadingMore(true);
    try {
      const rows = await api.getTracks({ sort: 'loved', limit: LOVED_PAGE_SIZE, offset });
      const lovedRows = rows.filter((track) => track.loved);
      setTracks((currentTracks) => {
        const seen = new Set(currentTracks.map((track) => track.id));
        return [...currentTracks, ...lovedRows.filter((track) => !seen.has(track.id))];
      });
      setHasMoreLoved(offset + lovedRows.length < totalLoved);
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggleLove(id: number): Promise<boolean> {
    const loved = await toggleStoreLove(id);
    if (!loved) {
      setTracks((currentTracks) => currentTracks.filter((track) => track.id !== id));
      setTotalLoved((count) => Math.max(0, count - 1));
    }
    return loved;
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--line)' }}
      >
        <span style={{ color: 'var(--accent)' }}>★</span>
        <span className="text-[12px] font-semibold">Loved Tracks</span>
        <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
          {totalLoved
            ? `${tracks.length.toLocaleString()}${hasMoreLoved ? '+' : ''} of ${totalLoved.toLocaleString()} tracks`
            : `${tracks.length.toLocaleString()} tracks`}
        </span>
        <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)} disabled={!tracks.length}>
          ▶ Play loaded
        </button>
        <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play loaded loved tracks next">
          NEXT LOADED
        </button>
        <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue loaded loved tracks">
          QUEUE LOADED
        </button>
        <PlaylistAppendPicker
          tracks={tracks}
          label="ADD LOVED TO PLAYLIST"
          disabled={!tracks.length}
        />
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading...
          </div>
        ) : tracks.length ? (
          <>
            <TrackTable
              tracks={tracks}
              currentId={current?.id ?? null}
              onPlay={(i) => void playQueue(tracks, i)}
              onPlayTracks={(selectedTracks) => void playQueue(selectedTracks, 0)}
              onPlayNext={queueTrackNext}
              onAddToQueue={addTrackToQueue}
              onPlayNextTracks={queueTracksNext}
              onAddTracksToQueue={addTracksToQueue}
              onToggleLove={toggleLove}
            />
            <LoadMoreFooter
              shown={tracks.length}
              total={totalLoved}
              noun="loved tracks"
              hasMore={hasMoreLoved}
              loading={loadingMore}
              loadLabel="Load more loved"
              onLoadMore={() => void loadMoreLoved()}
            />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Mark tracks with ☆ to find them here later.
          </div>
        )}
      </div>
    </div>
  );
}
