import { useEffect, useRef, useState } from 'react';
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
  const loveChange = usePlayerStore((s) => s.lastLoveChange);
  const [reloadSeed, setReloadSeed] = useState(0);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  // A love from before this view opened is already in what it loads.
  const handledLoveSeq = useRef(loveChange?.seq ?? 0);

  // Loving or unloving from anywhere else (the transport, a shortcut, Quick
  // Play) changes this list: an unloved track leaves it, a newly loved one is
  // found by reading the first page again, which also puts it where the sort does.
  useEffect(() => {
    if (!loveChange || loveChange.seq === handledLoveSeq.current) return;
    handledLoveSeq.current = loveChange.seq;
    if (loveChange.loved) {
      if (!tracksRef.current.some((track) => track.id === loveChange.id)) setReloadSeed((seed) => seed + 1);
      return;
    }
    setTracks((currentTracks) => currentTracks.filter((track) => track.id !== loveChange.id));
    setTotalLoved((count) => Math.max(0, count - 1));
  }, [loveChange]);

  useEffect(() => {
    let cancelled = false;
    // A reload for a love keeps the rows on screen until the new page lands.
    if (!tracksRef.current.length) setLoading(true);
    // A reload keeps the extent already paged in, so a love from elsewhere does
    // not scroll a long list back to its first page.
    const limit = Math.max(LOVED_PAGE_SIZE, tracksRef.current.length);
    Promise.all([
      api.getTracks({ sort: 'loved', limit, offset: 0 }),
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
        if (cancelled || tracksRef.current.length) return;
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
  }, [reloadSeed]);

  async function loadMoreLoved(): Promise<void> {
    if (loadingMore || !hasMoreLoved) return;
    const offset = tracks.length;
    setLoadingMore(true);
    try {
      const rows = await api.getTracks({ sort: 'loved', limit: LOVED_PAGE_SIZE, offset });
      const lovedRows = rows.filter((track) => track.loved);
      const seen = new Set(tracks.map((track) => track.id));
      const freshRows = lovedRows.filter((track) => !seen.has(track.id));
      // Append race-safe: re-dedupe against the LATEST committed list inside the
      // updater. An unlove (which shifts server-side offsets) or a StrictMode
      // double-fire can otherwise re-append rows this stale snapshot didn't see.
      setTracks((currentTracks) => {
        if (!freshRows.length) return currentTracks;
        const have = new Set(currentTracks.map((track) => track.id));
        const add = freshRows.filter((track) => !have.has(track.id));
        return add.length ? [...currentTracks, ...add] : currentTracks;
      });
      // Advance "has more" by the unique rows in this page, not the raw page
      // size: deduped pages would otherwise keep this true and loop on no-op loads.
      setHasMoreLoved(freshRows.length > 0 && tracks.length + freshRows.length < totalLoved);
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggleLove(id: number): Promise<boolean> {
    // The store announces the change, and the effect above takes the row and
    // the count off the list.
    return toggleStoreLove(id);
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
        <button className="pxbtn is-primary" onClick={() => void playQueue(tracks, 0)} disabled={!tracks.length}>
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
