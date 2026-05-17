import { useEffect, useMemo, useState } from 'react';
import type { ArtistSummary, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';
import { fetchArtistFacts, type ArtistFact } from '../../api/artistFacts';

const ARTIST_PAGE_SIZE = 320;
const CATALOG_SEARCH_DEBOUNCE_MS = 180;

export function ArtistsView(): JSX.Element {
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [artistFact, setArtistFact] = useState<ArtistFact | null>(null);
  const [factStatus, setFactStatus] = useState<'idle' | 'loading' | 'none' | 'ok'>('idle');
  const [filter, setFilter] = useState('');
  const artistQuery = useDebouncedValue(filter, CATALOG_SEARCH_DEBOUNCE_MS);
  const [hasMoreArtists, setHasMoreArtists] = useState(false);
  const [loadingArtists, setLoadingArtists] = useState(false);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const current = usePlayerStore((s) => s.current);

  useEffect(() => {
    let cancelled = false;
    setLoadingArtists(true);
    api
      .getArtists({ search: artistQuery, limit: ARTIST_PAGE_SIZE + 1, offset: 0 })
      .then((rows) => {
        if (cancelled) return;
        setArtists(rows.slice(0, ARTIST_PAGE_SIZE));
        setHasMoreArtists(rows.length > ARTIST_PAGE_SIZE);
      })
      .catch(() => {
        if (!cancelled) {
          setArtists([]);
          setHasMoreArtists(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingArtists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artistQuery]);

  useEffect(() => {
    if (!selected) {
      setTracks([]);
      return;
    }
    api.getArtistTracks(selected).then(setTracks).catch(() => undefined);
  }, [selected]);

  useEffect(() => {
    if (!selected || selected === 'Unknown Artist') {
      setArtistFact(null);
      setFactStatus('idle');
      return;
    }
    const ctrl = new AbortController();
    setArtistFact(null);
    setFactStatus('loading');
    fetchArtistFacts(selected, ctrl.signal)
      .then((next) => {
        setArtistFact(next);
        setFactStatus(next ? 'ok' : 'none');
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFactStatus('none');
      });
    return () => ctrl.abort();
  }, [selected]);

  async function loadMoreArtists(): Promise<void> {
    if (loadingArtists || !hasMoreArtists) return;
    setLoadingArtists(true);
    try {
      const rows = await api.getArtists({
        search: artistQuery,
        limit: ARTIST_PAGE_SIZE + 1,
        offset: artists.length,
      });
      setArtists((currentArtists) => [...currentArtists, ...rows.slice(0, ARTIST_PAGE_SIZE)]);
      setHasMoreArtists(rows.length > ARTIST_PAGE_SIZE);
    } finally {
      setLoadingArtists(false);
    }
  }

  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--line)' }}
        >
          <button className="pxbtn" onClick={() => setSelected(null)}>
            All artists
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-semibold">{selected}</div>
            <div className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
              {tracks.length} tracks
            </div>
          </div>
          <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)}>
            Play all
          </button>
          <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play artist next">
            NEXT
          </button>
          <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue artist">
            QUEUE
          </button>
          <PlaylistAppendPicker
            tracks={tracks}
            label="ADD ARTIST TO PLAYLIST"
            disabled={!tracks.length}
          />
        </div>
        <ArtistSpotlight
          artist={selected}
          fact={artistFact}
          status={factStatus}
          tracks={tracks}
        />
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
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter artists..."
          className="bevel-in lcd-text flex-1 px-3 py-1.5 text-[14px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {artists.length.toLocaleString()}{hasMoreArtists ? '+' : ''} artists
          {loadingArtists ? ' / loading' : ''}
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
        >
          {artists.map((a) => (
            <button
              key={a.artist}
              onClick={() => setSelected(a.artist)}
              className="flex items-center justify-between gap-2 border-b px-4 py-2 text-left transition-colors hover:bg-[var(--panel-2)]"
              style={{ borderColor: 'var(--line)' }}
            >
              <span className="truncate text-[13px]">{a.artist}</span>
              <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
                {a.albumCount} alb - {a.trackCount} tr
              </span>
            </button>
          ))}
        </div>
        {hasMoreArtists && (
          <div className="flex justify-center py-4">
            <button
              className="pxbtn is-active"
              onClick={() => void loadMoreArtists()}
              disabled={loadingArtists}
              data-newamp-artists-load-more
            >
              {loadingArtists ? 'Loading...' : 'Load more artists'}
            </button>
          </div>
        )}
      </div>
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

function ArtistSpotlight({
  artist,
  fact,
  status,
  tracks,
}: {
  artist: string;
  fact: ArtistFact | null;
  status: 'idle' | 'loading' | 'none' | 'ok';
  tracks: Track[];
}): JSX.Element {
  const imageUrl = fact?.imageUrl ?? fact?.originalImageUrl;
  const yearSpan = useMemo(() => formatYearSpan(tracks), [tracks]);
  const statText = [
    `${tracks.length.toLocaleString()} tracks`,
    yearSpan,
  ].filter(Boolean).join(' / ');

  return (
    <section
      className="relative overflow-hidden border-b"
      style={{
        borderColor: 'var(--line)',
        background: 'var(--panel)',
      }}
    >
      {imageUrl && (
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: `linear-gradient(90deg, rgba(6,10,14,0.96), rgba(6,10,14,0.76) 48%, rgba(6,10,14,0.3)), url(${JSON.stringify(imageUrl)})`,
            backgroundPosition: 'center',
            backgroundSize: 'cover',
          }}
        />
      )}
      <div className="relative grid min-h-[190px] gap-5 px-5 py-4" style={{ gridTemplateColumns: imageUrl ? '1fr 160px' : '1fr' }}>
        <div className="min-w-0">
          <div
            className="mb-2 flex flex-wrap items-center gap-2 text-[9px] uppercase tracking-[0.1em]"
            style={{ color: 'var(--ink-2)' }}
          >
            <span>Artist Image - Wikipedia</span>
            <span style={{ color: 'var(--muted)' }}>{statusLabel(status)}</span>
          </div>
          <h2
            className="truncate"
            style={{
              color: 'var(--ink)',
              fontFamily: 'var(--font-display)',
              fontSize: 24,
              fontWeight: 700,
              lineHeight: 1.1,
            }}
          >
            {fact?.title ?? artist}
          </h2>
          <div className="mt-1 text-[11px] uppercase tracking-[0.08em]" style={{ color: 'var(--accent)' }}>
            {fact?.description ?? statText}
          </div>
          <p className="mt-3 line-clamp-4 max-w-[900px] text-[12px] leading-[1.55]" style={{ color: 'var(--ink-2)' }}>
            {fact
              ? fact.summary
              : status === 'loading'
                ? 'Looking up a large artist image and short context for this library view.'
                : 'Artist context will appear here when a Wikipedia match is found.'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]" style={{ color: 'var(--muted)' }}>
            <span>{statText || 'No local tracks loaded yet'}</span>
            {fact?.url && (
              <a
                href={fact.url}
                target="_blank"
                rel="noreferrer"
                className="border px-2 py-1 uppercase tracking-[0.08em]"
                style={{ borderColor: 'var(--accent-dim)', color: 'var(--accent)' }}
              >
                Open source
              </a>
            )}
          </div>
        </div>
        {imageUrl && (
          <img
            src={imageUrl}
            alt={fact?.title ?? artist}
            className="hidden h-[160px] w-[160px] self-center object-cover sm:block"
            style={{ borderRadius: 'var(--radius)', boxShadow: '0 0 0 1px var(--line)' }}
            draggable={false}
          />
        )}
      </div>
    </section>
  );
}

function formatYearSpan(tracks: Track[]): string {
  const years = tracks
    .map((track) => track.year)
    .filter((year): year is number => typeof year === 'number' && year > 0);
  if (years.length === 0) return '';
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? String(min) : `${min}-${max}`;
}

function statusLabel(status: 'idle' | 'loading' | 'none' | 'ok'): string {
  if (status === 'loading') return 'fetching';
  if (status === 'none') return 'no match';
  if (status === 'ok') return 'image ready';
  return 'standby';
}
