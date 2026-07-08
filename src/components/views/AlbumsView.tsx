import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import type { AlbumSummary, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../lib/format';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';
import { pushToast } from '../../lib/toast';
import { spectralArtDataUrl } from '@shared/spectral-art';
import { ScoreRating } from '../ScoreRating';
import { ArtistLink } from '../EntityLink';
import { ViewHeader } from '../ViewHeader';
import { Chip } from '../Chip';
import { EmptyState } from '../EmptyState';
import { ViewSkeleton } from '../ViewSkeleton';
import { Note } from '../Icons';

const ALBUM_PAGE_SIZE = 240;
const CATALOG_SEARCH_DEBOUNCE_MS = 180;
const ALBUM_AUTO_LOAD_SCROLL_PX = 560;

type AlbumSort = 'artist' | 'album' | 'year-desc' | 'year-asc' | 'recent' | 'plays' | 'duration' | 'tracks' | 'random';

const ALBUM_SORTS: Array<{ id: AlbumSort; label: string }> = [
  { id: 'artist', label: 'Artist / year' },
  { id: 'album', label: 'Album title' },
  { id: 'year-desc', label: 'Newest year' },
  { id: 'year-asc', label: 'Oldest year' },
  { id: 'recent', label: 'Recently added' },
  { id: 'plays', label: 'Most played' },
  { id: 'duration', label: 'Longest albums' },
  { id: 'tracks', label: 'Most tracks' },
  { id: 'random', label: 'Random' },
];

const albumViewSnapshot: {
  albums: AlbumSummary[];
  selected: AlbumSummary | null;
  tracks: Track[];
  filter: string;
  showMissingArtOnly: boolean;
  sort: AlbumSort;
  randomSeed: number;
  hasMoreAlbums: boolean;
  scrollTop: number;
} = {
  albums: [],
  selected: null,
  tracks: [],
  filter: '',
  showMissingArtOnly: false,
  sort: 'artist',
  randomSeed: Date.now(),
  hasMoreAlbums: false,
  scrollTop: 0,
};

export function AlbumsView(): JSX.Element {
  const [albums, setAlbums] = useState<AlbumSummary[]>(() => albumViewSnapshot.albums);
  const [selected, setSelected] = useState<AlbumSummary | null>(() => albumViewSnapshot.selected);
  const [tracks, setTracks] = useState<Track[]>(() => albumViewSnapshot.tracks);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const setFullscreenViz = usePlayerStore((s) => s.setFullscreenViz);
  const current = usePlayerStore((s) => s.current);
  const [filter, setFilter] = useState(() => albumViewSnapshot.filter);
  const albumQuery = useDebouncedValue(filter, CATALOG_SEARCH_DEBOUNCE_MS);
  const [showMissingArtOnly, setShowMissingArtOnly] = useState(() => albumViewSnapshot.showMissingArtOnly);
  const [albumSort, setAlbumSort] = useState<AlbumSort>(() => albumViewSnapshot.sort);
  const [randomSeed, setRandomSeed] = useState(() => albumViewSnapshot.randomSeed);
  const [hasMoreAlbums, setHasMoreAlbums] = useState(() => albumViewSnapshot.hasMoreAlbums);
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const albumListRef = useRef<HTMLDivElement>(null);
  const albumPageRequestRef = useRef(false);
  const albumScrollTopRef = useRef(albumViewSnapshot.scrollTop);
  const hydratedSnapshotRef = useRef(albumViewSnapshot.albums.length > 0 || !!albumViewSnapshot.selected);

  useEffect(() => {
    albumViewSnapshot.filter = filter;
  }, [filter]);

  // Handle programmatic navigation requests from elsewhere in the app — e.g.
  // clicking the album name in Now Playing lands here with the album/artist
  // pre-selected for instant detail view.
  const pendingNavigation = usePlayerStore((s) => s.pendingNavigation);
  const consumePendingNavigation = usePlayerStore((s) => s.consumePendingNavigation);
  // One-shot row highlight consumed by the album detail's TrackTable after an
  // 'album-with-track' navigation (TrackLink / ♪ matched-song click).
  const [highlightTrack, setHighlightTrack] = useState<{ id: number | null; title: string | null } | null>(null);
  useEffect(() => {
    if (!pendingNavigation || (pendingNavigation.kind !== 'album' && pendingNavigation.kind !== 'album-with-track')) return;
    const target = pendingNavigation;
    void (async () => {
      let tracks: Track[] = [];
      let lookupFailed = false;
      try {
        tracks = await api.getAlbumTracks(target.albumArtist, target.album);
      } catch (err) {
        lookupFailed = true;
        pushToast({
          tone: 'error',
          title: `Could not open ${target.album}`,
          detail: `${err instanceof Error ? err.message : 'Unknown error'}. Click again to retry.`,
        });
      }
      if (lookupFailed || tracks.length === 0) {
        // Don't consume on partial failure — a retry click on the same album
        // link in Now Playing should be able to fire again. Leave the pending
        // nav alone so the next render either retries (if the user re-clicks)
        // or stays put.
        if (!lookupFailed) {
          pushToast({ tone: 'warn', title: `No tracks found for ${target.album}` });
          consumePendingNavigation();
        }
        return;
      }
      const albumArtist =
        target.albumArtist || (tracks[0]?.albumArtist ?? tracks[0]?.artist ?? 'Unknown Artist');
      // Hydrate the stored album rating so the AlbumsView slider shows the
      // real value when the user lands on the album via pending navigation.
      // Falls back to 0/null on lookup failure — the slider's fallback
      // (selected.ratingScore ?? albumScore(tracks)) still displays a
      // reasonable value from the per-track scores.
      let albumRating: { rating: number; ratingScore: number | null } = { rating: 0, ratingScore: null };
      try {
        const stored = await api.getAlbumRating(albumArtist, target.album);
        if (stored) albumRating = { rating: stored.rating, ratingScore: stored.ratingScore };
      } catch (err) {
        console.error('[newamp] getAlbumRating failed during pending navigation:', err);
      }
      const albumSummary: AlbumSummary = {
        album: target.album,
        albumArtist,
        year: tracks.find((t) => t.year)?.year ?? null,
        trackCount: tracks.length,
        duration: tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
        artFromTrackId: tracks.find((t) => t.hasArt)?.id ?? null,
        rating: albumRating.rating,
        ratingScore: albumRating.ratingScore,
      };
      setSelected(albumSummary);
      setTracks(tracks);
      setFilter(target.album);
      setHighlightTrack(
        target.kind === 'album-with-track'
          ? { id: target.trackId, title: target.trackTitle }
          : null,
      );
      consumePendingNavigation();
    })();
  }, [pendingNavigation, consumePendingNavigation]);

  useEffect(() => {
    albumViewSnapshot.showMissingArtOnly = showMissingArtOnly;
  }, [showMissingArtOnly]);

  useEffect(() => {
    albumViewSnapshot.sort = albumSort;
    albumViewSnapshot.randomSeed = randomSeed;
  }, [albumSort, randomSeed]);

  useEffect(() => {
    albumViewSnapshot.albums = albums;
    albumViewSnapshot.hasMoreAlbums = hasMoreAlbums;
  }, [albums, hasMoreAlbums]);

  useEffect(() => {
    albumViewSnapshot.selected = selected;
  }, [selected]);

  useEffect(() => {
    albumViewSnapshot.tracks = tracks;
  }, [tracks]);

  useEffect(() => {
    return () => {
      albumViewSnapshot.scrollTop = albumScrollTopRef.current;
    };
  }, []);

  useEffect(() => {
    if (hydratedSnapshotRef.current) {
      hydratedSnapshotRef.current = false;
      return undefined;
    }
    let cancelled = false;
    albumPageRequestRef.current = false;
    albumScrollTopRef.current = 0;
    albumViewSnapshot.scrollTop = 0;
    setSelected(null);
    setTracks([]);
    setLoadingAlbums(true);
    api
      .getAlbums({
        search: albumQuery,
        missingArtOnly: showMissingArtOnly,
        sort: albumSort,
        randomSeed,
        limit: ALBUM_PAGE_SIZE + 1,
        offset: 0,
      })
      .then((rows) => {
        if (cancelled) return;
        setAlbums(rows.slice(0, ALBUM_PAGE_SIZE));
        setHasMoreAlbums(rows.length > ALBUM_PAGE_SIZE);
      })
      .catch((err) => {
        // Don't silently swallow — a 1.5.4 LEFT JOIN regression made the
        // SQL throw an "ambiguous column" error, this catch fired, and the
        // UI showed an empty album list with no clue why. Surface the
        // failure to the console and as an error toast so the next backend
        // bug is visible instead of looking like an empty library.
        if (!cancelled) {
          console.error('[newamp] getAlbums failed:', err);
          setAlbums([]);
          setHasMoreAlbums(false);
          pushToast({
            tone: 'error',
            title: "Couldn't load albums",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingAlbums(false);
      });
    return () => {
      cancelled = true;
    };
  }, [albumQuery, showMissingArtOnly, albumSort, randomSeed]);

  useEffect(() => {
    if (!selected) return;
    api
      .getAlbumTracks(selected.albumArtist, selected.album)
      .then(setTracks)
      .catch(() => undefined);
  }, [selected?.album, selected?.albumArtist]);

  useLayoutEffect(() => {
    if (selected) return;
    const list = albumListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = albumScrollTopRef.current;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected, albums.length, filter, showMissingArtOnly, albumSort, randomSeed]);

  function openAlbum(album: AlbumSummary): void {
    albumScrollTopRef.current = albumListRef.current?.scrollTop ?? albumScrollTopRef.current;
    albumViewSnapshot.scrollTop = albumScrollTopRef.current;
    setSelected(album);
  }

  function closeAlbum(): void {
    setSelected(null);
  }

  async function loadMoreAlbums(): Promise<void> {
    if (loadingAlbums || albumPageRequestRef.current || !hasMoreAlbums) return;
    albumPageRequestRef.current = true;
    setLoadingAlbums(true);
    try {
      const rows = await api.getAlbums({
        search: albumQuery,
        missingArtOnly: showMissingArtOnly,
        sort: albumSort,
        randomSeed,
        limit: ALBUM_PAGE_SIZE + 1,
        offset: albums.length,
      });
      setAlbums((currentAlbums) => [...currentAlbums, ...rows.slice(0, ALBUM_PAGE_SIZE)]);
      setHasMoreAlbums(rows.length > ALBUM_PAGE_SIZE);
    } finally {
      albumPageRequestRef.current = false;
      setLoadingAlbums(false);
    }
  }

  async function reloadAlbumsAfterScan(): Promise<void> {
    setLoadingAlbums(true);
    try {
      const pageSize = Math.max(ALBUM_PAGE_SIZE, albums.length || ALBUM_PAGE_SIZE);
      const rows = await api.getAlbums({
        search: albumQuery,
        missingArtOnly: showMissingArtOnly,
        sort: albumSort,
        randomSeed,
        limit: pageSize + 1,
        offset: 0,
      });
      setAlbums(rows.slice(0, pageSize));
      setHasMoreAlbums(rows.length > pageSize);
    } finally {
      setLoadingAlbums(false);
    }
  }

  async function scanLibraryNow(): Promise<void> {
    setScanBusy(true);
    pushToast({ title: 'Scanning music folders…' });
    try {
      await api.scanLibrary();
      await reloadAlbumsAfterScan();
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

  async function addFolderAndScan(): Promise<void> {
    setScanBusy(true);
    try {
      const dir = await api.pickFolder();
      if (!dir) return;
      const settings = await api.getSettings();
      const roots = Array.from(new Set([...settings.libraryRoots, dir]));
      await api.setSettings({ libraryRoots: roots, libraryAutoWatch: true });
      pushToast({ title: `Scanning ${dir}…` });
      await api.scanLibrary([dir]);
      await reloadAlbumsAfterScan();
      pushToast({
        tone: 'ok',
        title: 'Folder added to the library',
        detail: `${dir} is scanned and watched for changes.`,
      });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Folder scan failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setScanBusy(false);
    }
  }

  function handleAlbumsScroll(event: UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget;
    albumScrollTopRef.current = list.scrollTop;
    albumViewSnapshot.scrollTop = list.scrollTop;
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (remaining > ALBUM_AUTO_LOAD_SCROLL_PX) return;
    void loadMoreAlbums();
  }

  function changeAlbumSort(nextSort: AlbumSort): void {
    setAlbumSort(nextSort);
    if (nextSort === 'random') setRandomSeed(Date.now());
  }

  async function openCurrentAlbum(): Promise<void> {
    if (!current?.album) {
      pushToast({ tone: 'warn', title: 'No current album loaded' });
      return;
    }
    try {
      const rows = await api.getAlbums({
        search: current.album,
        sort: 'album',
        limit: 80,
        offset: 0,
      });
      const match =
        rows.find((album) => sameText(album.album, current.album) && sameText(album.albumArtist, current.albumArtist)) ??
        rows.find((album) => sameText(album.album, current.album)) ??
        null;
      if (!match) {
        pushToast({ tone: 'warn', title: 'Current album was not found in the library' });
        return;
      }
      openAlbum(match);
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Could not open current album',
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  }

  async function openSurpriseAlbum(): Promise<void> {
    const visible = albums.filter((album) => album.trackCount > 0);
    const pick = visible.length
      ? visible[Math.floor(Math.random() * visible.length)]!
      : (await api.getAlbums({ sort: 'random', randomSeed: Date.now(), limit: 1, offset: 0 }))[0] ?? null;
    if (!pick) {
      pushToast({ tone: 'warn', title: 'No albums to surprise you with yet' });
      return;
    }
    openAlbum(pick);
  }

  // Album rating is its own stored value (album_ratings table), kept strictly
  // independent of per-track scores. The editable control reflects ONLY the
  // explicit album rating (null = unrated) — falling back to the track-score
  // average here caused the song-rating slider to visibly move the album
  // rating, since the average shifts when any track rating changes. The
  // track-score average is still surfaced separately below as a read-only
  // hint, so the user can see "songs avg N" without it driving the slider.
  const selectedAlbumScore = selected?.ratingScore ?? null;
  const selectedTrackAverage = selected ? albumScore(tracks) : null;

  async function setAlbumScore(score: number | null): Promise<void> {
    if (!selected) return;
    let updated;
    try {
      updated = await api.setAlbumRatingScore(selected.albumArtist, selected.album, score);
    } catch (err) {
      // Mirror the read-path catch hardening — surface the failure
      // instead of letting "Rated X 75/100" lie about a write that never
      // happened. No state mutation on failure, so the slider snaps back
      // to the prior value on the next re-render.
      console.error('[newamp] setAlbumRatingScore failed:', err);
      pushToast({
        tone: 'error',
        title: "Couldn't save album rating",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const nextRating = updated?.rating ?? 0;
    const nextScore = updated?.ratingScore ?? null;
    // Reflect the new album rating on both the selected AlbumSummary and
    // the cached album list so the slider's optimistic update sticks
    // across renders without waiting for a full re-fetch.
    setSelected((prev) =>
      prev ? { ...prev, rating: nextRating, ratingScore: nextScore } : prev,
    );
    setAlbums((rows) =>
      rows.map((row) =>
        sameText(row.album, selected.album) && sameText(row.albumArtist, selected.albumArtist)
          ? { ...row, rating: nextRating, ratingScore: nextScore }
          : row,
      ),
    );
    pushToast(
      score == null
        ? { tone: 'ok', title: 'Album rating cleared', detail: selected.album }
        : {
            tone: 'ok',
            title: `Rated ${selected.album} ${score.toFixed(1)}/100`,
            detail: 'Track ratings unchanged.',
          },
    );
  }

  const albumLetters = useMemo(() => {
    const set = new Set<string>();
    for (const album of albums) set.add(albumArtistFirstLetter(album.albumArtist));
    return set;
  }, [albums]);

  function jumpToAlbumLetter(letter: string): void {
    const container = albumListRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-newamp-album-artist-letter="${letter}"]`);
    if (!target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - containerRect.top + container.scrollTop - 12;
    container.scrollTo({ top: Math.max(0, offset), behavior: catalogScrollBehavior() });
  }

  const filterActive = albumQuery.trim().length > 0;

  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--line)' }}
        >
          <button className="pxbtn" onClick={closeAlbum}>
            ← All albums
          </button>
          <AlbumArt album={selected} />
          <div className="min-w-[180px] flex-1">
            <div className="text-lg font-semibold">{selected.album}</div>
            <div className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
              <ArtistLink artist={selected.albumArtist} color="inherit" />
              {selected.year ? `  ·  ${selected.year}` : ''}
              {`  ·  ${selected.trackCount} tracks  ·  ${formatDuration(selected.duration)}`}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)}>
              Play album
            </button>
            <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play album next">
              Next
            </button>
            <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue album">
              Queue
            </button>
            <button className="pxbtn" onClick={() => setCompactMode(true)} title="Open the compact deck">
              Deck
            </button>
            <button className="pxbtn" onClick={() => setFullscreenViz(true)} title="Open fullscreen visualizer">
              Full vis
            </button>
          </div>
          {/* Rating gets its own full-width row underneath the action buttons.
              ScoreRating's internal grid is 88+180+auto = at least 280px, which
              regularly collides with the play / queue buttons on any non-huge
              window. Putting it on a dedicated row eliminates the overlap
              entirely. */}
          <div
            className="flex w-full items-center gap-3 border-t pt-2"
            style={{ borderColor: 'var(--line)' }}
            data-newamp-album-rating-row
          >
            <span className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
              Album Rating
            </span>
            <div className="flex-1" data-newamp-album-rating>
              <ScoreRating
                value={selectedAlbumScore}
                stars={Math.round((selectedAlbumScore ?? 0) / 20)}
                onChange={(score) => void setAlbumScore(score)}
              />
            </div>
            {selectedTrackAverage != null ? (
              <span
                className="text-[10px] tabular-nums"
                style={{ color: 'var(--muted)' }}
                data-newamp-album-songs-avg
                title="Average of this album's track scores (read-only)"
              >
                songs avg {selectedTrackAverage.toFixed(1)}
              </span>
            ) : null}
          </div>
          <PlaylistAppendPicker
            tracks={tracks}
            label="Add album to playlist"
            disabled={!tracks.length}
          />
        </div>
        <div className="flex-1 overflow-auto">
          <TrackTable
            tracks={tracks}
            currentId={current?.id ?? null}
            highlightTrack={highlightTrack}
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
        title="Albums"
        count={`${albums.length.toLocaleString()}${hasMoreAlbums ? '+' : ''} ${
          showMissingArtOnly ? 'albums missing art' : 'albums'
        }`}
        status={
          scanBusy ? (
            <Chip tone="accent" size="sm">
              Scanning…
            </Chip>
          ) : loadingAlbums ? (
            <Chip tone="muted" size="sm">
              Loading…
            </Chip>
          ) : null
        }
        actions={
          <>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter albums or songs…"
              aria-label="Filter albums or songs"
              className="catalog-header-filter bevel-in lcd-text px-3 py-1.5 text-[14px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
            />
            <select
              value={albumSort}
              onChange={(event) => changeAlbumSort(event.currentTarget.value as AlbumSort)}
              className="bevel-in lcd-text px-2 py-1.5 text-[12px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
              title="Sort albums"
              data-newamp-albums-sort
            >
              {ALBUM_SORTS.map((sort) => (
                <option key={sort.id} value={sort.id}>
                  {sort.label}
                </option>
              ))}
            </select>
            {albumSort === 'random' && (
              <button className="pxbtn" onClick={() => setRandomSeed(Date.now())} data-newamp-albums-reshuffle>
                Reshuffle
              </button>
            )}
            <button
              className="pxbtn"
              onClick={() => void openCurrentAlbum()}
              disabled={!current?.album}
              title="Jump to the album playing now"
              data-newamp-albums-now-lp
            >
              Now playing
            </button>
            <button
              className="pxbtn"
              onClick={() => void openSurpriseAlbum()}
              disabled={loadingAlbums}
              title="Open a random album"
              data-newamp-albums-surprise
            >
              Surprise me
            </button>
            <HeaderOverflow>
              <button
                className={`pxbtn ${showMissingArtOnly ? 'is-active' : ''}`}
                onClick={() => setShowMissingArtOnly((value) => !value)}
                title="Show albums that still need cover art"
              >
                Missing art
              </button>
              <button className="pxbtn" onClick={() => void scanLibraryNow()} disabled={scanBusy}>
                Scan library
              </button>
              <button className="pxbtn" onClick={() => void addFolderAndScan()} disabled={scanBusy}>
                Add folder…
              </button>
              <button className="pxbtn" onClick={() => setCompactMode(true)} title="Open the compact deck">
                Deck
              </button>
              <button className="pxbtn" onClick={() => setFullscreenViz(true)} title="Open fullscreen visualizer">
                Full visualizer
              </button>
            </HeaderOverflow>
          </>
        }
      />
      <div className="relative flex flex-1 overflow-hidden">
        {loadingAlbums && albums.length === 0 ? (
          <div className="flex-1 overflow-hidden">
            <ViewSkeleton variant="cards" count={18} />
          </div>
        ) : albums.length === 0 ? (
          <div className="flex-1">
            <EmptyState
              icon={<Note size={40} />}
              title={filterActive || showMissingArtOnly ? 'No albums match' : 'No albums yet'}
              body={
                filterActive
                  ? `Nothing in the library matches "${albumQuery.trim()}".`
                  : showMissingArtOnly
                    ? 'Every album in the library already has cover art.'
                    : 'Point NewAmp at a music folder and the wall of covers builds itself.'
              }
              actions={
                filterActive || showMissingArtOnly ? (
                  <>
                    {filterActive && (
                      <button className="pxbtn" onClick={() => setFilter('')}>
                        Clear filter
                      </button>
                    )}
                    {showMissingArtOnly && (
                      <button className="pxbtn" onClick={() => setShowMissingArtOnly(false)}>
                        Show all albums
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button className="pxbtn is-active" onClick={() => void scanLibraryNow()} disabled={scanBusy}>
                      Scan library
                    </button>
                    <button className="pxbtn" onClick={() => void addFolderAndScan()} disabled={scanBusy}>
                      Add folder…
                    </button>
                  </>
                )
              }
            />
          </div>
        ) : (
          <>
        <div
          ref={albumListRef}
          data-newamp-albums-scroll
          className="flex-1 overflow-auto"
          onScroll={handleAlbumsScroll}
        >
          <div className="p-4">
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}
          >
            {albums.map((a) => {
              const firstLetter = albumArtistFirstLetter(a.albumArtist);
              return (
                <div
                  key={`${a.album}::${a.albumArtist}`}
                  className="group flex flex-col gap-1"
                  data-newamp-album-artist-letter={firstLetter}
                >
                  <button
                    onClick={() => openAlbum(a)}
                    className="flex flex-col gap-1 text-left"
                    title={`Open ${a.album}`}
                  >
                    <AlbumArt album={a} size={168} />
                    <div className="truncate pt-1 text-[13px] font-semibold">{a.album}</div>
                  </button>
                  <div className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }}>
                    <ArtistLink artist={a.albumArtist} color="var(--ink-2)" />
                    {a.year ? `  ·  ${a.year}` : ''}
                  </div>
                  {a.matchedTrackTitles && (
                    <div
                      className="truncate text-[10px]"
                      style={{ color: 'var(--accent)' }}
                      title={a.matchedTrackTitles}
                      data-newamp-album-matched-songs
                    >
                      {'♪ '}
                      {a.matchedTrackTitles.split(' · ').map((matchedTitle, i) => (
                        <Fragment key={`${matchedTitle}-${i}`}>
                          {i > 0 && ' · '}
                          <button
                            type="button"
                            className="underline-offset-2 hover:underline"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              color: 'inherit',
                              font: 'inherit',
                            }}
                            title={`Open "${matchedTitle}" on ${a.album}`}
                            onClick={() =>
                              usePlayerStore.getState().navigateToTrack({
                                title: matchedTitle,
                                album: a.album,
                                albumArtist: a.albumArtist,
                              })
                            }
                          >
                            {matchedTitle}
                          </button>
                        </Fragment>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
          <CatalogLoadMore
            shown={albums.length}
            noun={showMissingArtOnly ? 'missing-art albums' : 'albums'}
            hasMore={hasMoreAlbums}
            loading={loadingAlbums}
            onLoadMore={() => void loadMoreAlbums()}
            marker={{ 'data-newamp-albums-load-more': '' }}
          />
        </div>
        {albumSort === 'artist' && <AlphabetRail available={albumLetters} onJump={jumpToAlbumLetter} />}
          </>
        )}
      </div>
    </div>
  );
}

/** `smooth` unless the user asked for reduced motion. */
export function catalogScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/**
 * Sticky load-more footer shared by the catalog views — same layout and copy
 * as LoadMoreFooter, plus a `marker` slot for the frozen data-newamp-* button
 * markers the paging smokes assert on (LoadMoreFooter can't carry those).
 */
export function CatalogLoadMore({
  shown,
  total,
  noun,
  hasMore,
  loading,
  onLoadMore,
  marker,
}: {
  shown: number;
  total?: number | null;
  noun: string;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** Stable data-newamp-* attributes spread onto the load-more button. */
  marker?: Record<string, string>;
}): JSX.Element | null {
  const knownTotal = typeof total === 'number' && Number.isFinite(total) ? Math.max(0, total) : null;
  if (!hasMore && (knownTotal === null || shown >= knownTotal)) return null;

  return (
    <div
      className="sticky bottom-0 flex items-center justify-between border-t px-3 py-2 text-[11px]"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--ink-2)' }}
    >
      <span>
        {knownTotal === null
          ? `${shown.toLocaleString()} ${noun} loaded`
          : `${shown.toLocaleString()} of ${knownTotal.toLocaleString()} ${noun} loaded`}
      </span>
      {hasMore && (
        <button className="pxbtn" onClick={onLoadMore} disabled={loading} {...(marker ?? {})}>
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}

/**
 * Compact "More" cluster for secondary header actions. Children render inside
 * a small elevated menu; any click inside closes it, as do Escape and clicks
 * elsewhere in the document.
 */
function HeaderOverflow({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="catalog-overflow" data-newamp-header-overflow>
      <button
        type="button"
        className={`pxbtn ${open ? 'is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => setOpen((value) => !value)}
      >
        More
      </button>
      {open && (
        <div className="catalog-overflow-menu bevel-out" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function albumArtistFirstLetter(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '#';
  // Skip leading articles so "The Beatles" jumps to B, not T.
  const stripped = trimmed.replace(/^(the|a|an)\s+/i, '');
  const first = stripped.charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

// Hoisted at module scope so it's not re-allocated on every AlphabetRail
// render. The set never changes — `#` then A through Z.
const ALPHABET_RAIL_LETTERS = ['#', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))] as const;

/**
 * Vertical A-Z navigation rail, shared by the catalog grids (Albums by album
 * artist, Artists by name). Letters with nothing under them render dimmed and
 * disabled; clicking a present letter hands off to the view's own jump
 * handler. The rail floats over the right edge of the list so it doesn't take
 * any horizontal space away from the grid.
 */
export function AlphabetRail({
  available,
  onJump,
  noun = 'artists',
}: {
  available: ReadonlySet<string>;
  onJump: (letter: string) => void;
  noun?: string;
}): JSX.Element {
  return (
    <nav
      className="album-letter-rail"
      data-newamp-album-letter-rail
      aria-label={`Jump to ${noun} letter`}
    >
      {ALPHABET_RAIL_LETTERS.map((letter) => {
        const present = available.has(letter);
        return (
          <button
            key={letter}
            type="button"
            data-letter={letter}
            data-newamp-album-letter={letter}
            data-newamp-album-letter-present={present ? 'true' : 'false'}
            className={`album-letter-rail-key ${present ? 'is-present' : 'is-empty'}`}
            disabled={!present}
            onClick={() => present && onJump(letter)}
            title={present ? `Jump to ${noun} starting with ${letter}` : `No ${letter} ${noun} yet`}
          >
            {letter}
          </button>
        );
      })}
    </nav>
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
          loading="lazy"
          decoding="async"
          className="relative h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
          style={{ zIndex: 1 }}
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  const spectralUrl = spectralArtDataUrl({ artist: album.albumArtist, album: album.album }, Math.max(96, size * 2));
  return (
    <div
      className="album-art-tile relative overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-card)',
      }}
      title="Spectral cover (auto-generated)"
    >
      <img
        src={spectralUrl}
        alt={`${album.album} (spectral cover)`}
        width={size}
        height={size}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function albumScore(tracks: Track[]): number | null {
  const scores = tracks
    .map((track) => track.ratingScore ?? (track.rating > 0 ? track.rating * 20 : null))
    .filter((score): score is number => score != null);
  if (!scores.length) return null;
  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}
