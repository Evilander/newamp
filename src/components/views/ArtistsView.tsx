import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArtistSummary, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';
import { pushToast } from '../../lib/toast';
import { fetchArtistFacts, type ArtistFact } from '../../api/artistFacts';
import { ViewHeader } from '../ViewHeader';
import { Chip } from '../Chip';
import { EmptyState } from '../EmptyState';
import { ViewSkeleton } from '../ViewSkeleton';
import { AlphabetRail, CatalogLoadMore, catalogScrollBehavior } from './AlbumsView';
import { Sparkle } from '../Icons';

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
  const [scanBusy, setScanBusy] = useState(false);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const artistListRef = useRef<HTMLDivElement>(null);
  const [restoreArtistScrollTop, setRestoreArtistScrollTop] = useState(0);
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
        setRestoreArtistScrollTop(0);
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
  }, [artistQuery, refreshSeed]);

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

  useLayoutEffect(() => {
    if (selected) return;
    const list = artistListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = restoreArtistScrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected, restoreArtistScrollTop, filter]);

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

  function openArtist(artist: string): void {
    setRestoreArtistScrollTop(artistListRef.current?.scrollTop ?? 0);
    setSelected(artist);
  }

  // Consume programmatic navigation requests — e.g. clicking an artist name
  // from Now Playing arrives here with the artist pre-selected.
  const pendingNavigation = usePlayerStore((s) => s.pendingNavigation);
  const consumePendingNavigation = usePlayerStore((s) => s.consumePendingNavigation);
  useEffect(() => {
    if (!pendingNavigation || pendingNavigation.kind !== 'artist') return;
    setSelected(pendingNavigation.name);
    consumePendingNavigation();
  }, [pendingNavigation, consumePendingNavigation]);

  function closeArtist(): void {
    setSelected(null);
  }

  const artistLetters = useMemo(() => {
    const set = new Set<string>();
    for (const artist of artists) set.add(artistFirstLetter(artist.artist));
    return set;
  }, [artists]);

  function jumpToArtistLetter(letter: string): void {
    const container = artistListRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-newamp-artist-letter="${letter}"]`);
    if (!target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - containerRect.top + container.scrollTop - 12;
    container.scrollTo({ top: Math.max(0, offset), behavior: catalogScrollBehavior() });
  }

  const filterActive = artistQuery.trim().length > 0;

  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--line)' }}
        >
          <button className="pxbtn" onClick={closeArtist}>
            ← All artists
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-semibold">{selected}</div>
            <div className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
              {tracks.length.toLocaleString()} {tracks.length === 1 ? 'track' : 'tracks'}
            </div>
          </div>
          <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)}>
            Play all
          </button>
          <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play artist next">
            Next
          </button>
          <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue artist">
            Queue
          </button>
          <PlaylistAppendPicker
            tracks={tracks}
            label="Add artist to playlist"
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
      <ViewHeader
        eyebrow="Explore"
        title="Artists"
        count={`${artists.length.toLocaleString()}${hasMoreArtists ? '+' : ''} artists`}
        status={
          scanBusy ? (
            <Chip tone="accent" size="sm">
              Scanning…
            </Chip>
          ) : loadingArtists ? (
            <Chip tone="muted" size="sm">
              Loading…
            </Chip>
          ) : null
        }
        actions={
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter artists…"
            aria-label="Filter artists"
            className="catalog-header-filter bevel-in lcd-text px-3 py-1.5 text-[14px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          />
        }
      />
      <div className="relative flex flex-1 overflow-hidden">
        {loadingArtists && artists.length === 0 ? (
          <div className="flex-1 overflow-hidden">
            <ViewSkeleton variant="rows" count={14} />
          </div>
        ) : artists.length === 0 ? (
          <div className="flex-1">
            <EmptyState
              icon={<Sparkle size={40} />}
              title={filterActive ? 'No artists match' : 'No artists yet'}
              body={
                filterActive
                  ? `Nothing in the library matches "${artistQuery.trim()}".`
                  : 'Artists appear as soon as your library has music in it. Scan a music folder to get started.'
              }
              actions={
                filterActive ? (
                  <button className="pxbtn" onClick={() => setFilter('')}>
                    Clear filter
                  </button>
                ) : (
                  <button className="pxbtn is-active" onClick={() => void scanLibraryNow()} disabled={scanBusy}>
                    Scan library
                  </button>
                )
              }
            />
          </div>
        ) : (
          <>
            <div ref={artistListRef} data-newamp-artists-scroll className="flex-1 overflow-auto">
              <div
                className="grid"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
              >
                {artists.map((a) => (
                  <button
                    key={a.artist}
                    onClick={() => openArtist(a.artist)}
                    className="flex items-center justify-between gap-2 border-b px-4 py-2 text-left transition-colors hover:bg-[var(--panel-2)]"
                    style={{ borderColor: 'var(--line)' }}
                    data-newamp-artist-letter={artistFirstLetter(a.artist)}
                  >
                    <span className="truncate text-[13px]">{a.artist}</span>
                    <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
                      {formatArtistStats(a)}
                    </span>
                  </button>
                ))}
              </div>
              <CatalogLoadMore
                shown={artists.length}
                noun="artists"
                hasMore={hasMoreArtists}
                loading={loadingArtists}
                onLoadMore={() => void loadMoreArtists()}
                marker={{ 'data-newamp-artists-load-more': '' }}
              />
            </div>
            <AlphabetRail available={artistLetters} onJump={jumpToArtistLetter} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * First letter for the rail — deliberately NOT stripping leading articles the
 * way the Albums grid does: getArtists sorts on the raw name (COLLATE NOCASE),
 * so "The Beatles" really does live under T here and the jump targets must
 * agree with the sort order.
 */
function artistFirstLetter(value: string | null | undefined): string {
  const first = String(value ?? '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

function formatArtistStats(artist: ArtistSummary): string {
  const albums = `${artist.albumCount.toLocaleString()} ${artist.albumCount === 1 ? 'album' : 'albums'}`;
  const tracks = `${artist.trackCount.toLocaleString()} ${artist.trackCount === 1 ? 'track' : 'tracks'}`;
  return `${albums} · ${tracks}`;
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
    `${tracks.length.toLocaleString()} ${tracks.length === 1 ? 'track' : 'tracks'}`,
    yearSpan,
  ].filter(Boolean).join(' · ');

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
            // The readability scrim mixes over --panel instead of a hardcoded
            // near-black: on the light skins (steel/terminal/ice/miami) the
            // old rgba(6,10,14,…) slab sat like a hole punched in the panel.
            backgroundImage: `linear-gradient(90deg, color-mix(in srgb, var(--panel) 96%, transparent), color-mix(in srgb, var(--panel) 78%, transparent) 48%, color-mix(in srgb, var(--panel) 32%, transparent)), url(${JSON.stringify(imageUrl)})`,
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
            <span>Artist image · Wikipedia</span>
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
  return min === max ? String(min) : `${min}–${max}`;
}

function statusLabel(status: 'idle' | 'loading' | 'none' | 'ok'): string {
  if (status === 'loading') return 'fetching';
  if (status === 'none') return 'no match';
  if (status === 'ok') return 'image ready';
  return 'standby';
}
