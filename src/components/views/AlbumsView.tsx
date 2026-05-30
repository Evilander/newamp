import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import type { AlbumSummary, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../lib/format';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';
import { spectralArtDataUrl } from '@shared/spectral-art';
import { ScoreRating } from '../ScoreRating';

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
  const [scanStatus, setScanStatus] = useState<string | null>(null);
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
  useEffect(() => {
    if (!pendingNavigation || pendingNavigation.kind !== 'album') return;
    const target = pendingNavigation;
    void (async () => {
      let tracks: Track[] = [];
      let lookupFailed = false;
      try {
        tracks = await api.getAlbumTracks(target.albumArtist, target.album);
      } catch (err) {
        lookupFailed = true;
        setScanStatus(`Could not open ${target.album}: ${err instanceof Error ? err.message : 'unknown error'}. Click again to retry.`);
      }
      if (lookupFailed || tracks.length === 0) {
        // Don't consume on partial failure — a retry click on the same album
        // link in Now Playing should be able to fire again. Leave the pending
        // nav alone so the next render either retries (if the user re-clicks)
        // or stays put.
        if (!lookupFailed) {
          setScanStatus(`No tracks found for ${target.album}.`);
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
        // failure to the console and to the scan status banner so the next
        // backend bug is visible instead of looking like an empty library.
        if (!cancelled) {
          console.error('[newamp] getAlbums failed:', err);
          setAlbums([]);
          setHasMoreAlbums(false);
          setScanStatus(`Couldn't load albums: ${err instanceof Error ? err.message : String(err)}`);
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
    setScanStatus('Scanning music folders...');
    try {
      await api.scanLibrary();
      await reloadAlbumsAfterScan();
      setScanStatus('Library scan finished.');
    } catch (err) {
      setScanStatus(err instanceof Error ? err.message : 'Library scan failed.');
    }
  }

  async function addFolderAndScan(): Promise<void> {
    setScanStatus('Choose a music folder...');
    try {
      const dir = await api.pickFolder();
      if (!dir) {
        setScanStatus(null);
        return;
      }
      const settings = await api.getSettings();
      const roots = Array.from(new Set([...settings.libraryRoots, dir]));
      await api.setSettings({ libraryRoots: roots, libraryAutoWatch: true });
      setScanStatus(`Scanning ${dir}...`);
      await api.scanLibrary([dir]);
      await reloadAlbumsAfterScan();
      setScanStatus('New folder scanned and added to library watch.');
    } catch (err) {
      setScanStatus(err instanceof Error ? err.message : 'Folder scan failed.');
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
      setScanStatus('No current album loaded.');
      return;
    }
    setScanStatus('Opening current album...');
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
        setScanStatus('Current album was not found in the library.');
        return;
      }
      setScanStatus(null);
      openAlbum(match);
    } catch (err) {
      setScanStatus(err instanceof Error ? err.message : 'Could not open current album.');
    }
  }

  async function openSurpriseAlbum(): Promise<void> {
    const visible = albums.filter((album) => album.trackCount > 0);
    const pick = visible.length
      ? visible[Math.floor(Math.random() * visible.length)]!
      : (await api.getAlbums({ sort: 'random', randomSeed: Date.now(), limit: 1, offset: 0 }))[0] ?? null;
    if (!pick) {
      setScanStatus('No albums found yet.');
      return;
    }
    setScanStatus(null);
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
      setScanStatus(`Couldn't save album rating: ${err instanceof Error ? err.message : String(err)}`);
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
    setScanStatus(
      score == null
        ? `Cleared album rating for ${selected.album}.`
        : `Rated ${selected.album} ${score.toFixed(1)}/100. Track ratings unchanged.`,
    );
  }

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
              {selected.albumArtist}
              {selected.year ? `  ·  ${selected.year}` : ''}
              {`  ·  ${selected.trackCount} tracks  ·  ${formatDuration(selected.duration)}`}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)}>
              ▶ Play album
            </button>
            <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play album next">
              PLAY NEXT
            </button>
            <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue album">
              QUEUE ALBUM
            </button>
            <button className="pxbtn" onClick={() => setCompactMode(true)} title="Open the compact deck">
              DECK
            </button>
            <button className="pxbtn" onClick={() => setFullscreenViz(true)} title="Open fullscreen visualizer">
              FULL VIS
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
            RESHUFFLE
          </button>
        )}
        <button className="pxbtn" onClick={() => void openCurrentAlbum()} disabled={!current?.album} data-newamp-albums-now-lp>
          NOW LP
        </button>
        <button className="pxbtn" onClick={() => void openSurpriseAlbum()} disabled={loadingAlbums} data-newamp-albums-surprise>
          SURPRISE LP
        </button>
        <button className="pxbtn is-active" onClick={() => void scanLibraryNow()} disabled={loadingAlbums}>
          SCAN NEW
        </button>
        <button className="pxbtn" onClick={() => void addFolderAndScan()} disabled={loadingAlbums}>
          + FOLDER
        </button>
        <button className="pxbtn" onClick={() => setCompactMode(true)} title="Open the compact deck">
          DECK
        </button>
        <button className="pxbtn" onClick={() => setFullscreenViz(true)} title="Open fullscreen visualizer">
          FULL VIS
        </button>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {albums.length.toLocaleString()}{hasMoreAlbums ? '+' : ''}{' '}
          {showMissingArtOnly ? 'missing-art albums' : 'albums'}
          {loadingAlbums ? ' / loading' : ''}
          {scanStatus ? ` / ${scanStatus}` : ''}
        </span>
      </div>
      <div className="relative flex flex-1 overflow-hidden">
        <div
          ref={albumListRef}
          data-newamp-albums-scroll
          className="flex-1 overflow-auto p-4"
          onScroll={handleAlbumsScroll}
        >
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}
          >
            {albums.map((a) => {
              const firstLetter = albumArtistFirstLetter(a.albumArtist);
              return (
                <button
                  key={`${a.album}::${a.albumArtist}`}
                  onClick={() => openAlbum(a)}
                  className="group flex flex-col gap-1 text-left"
                  data-newamp-album-artist-letter={firstLetter}
                >
                  <AlbumArt album={a} size={168} />
                  <div className="truncate pt-1 text-[13px] font-semibold">{a.album}</div>
                  <div className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }}>
                    {a.albumArtist}
                    {a.year ? `  ·  ${a.year}` : ''}
                  </div>
                </button>
              );
            })}
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
        {albumSort === 'artist' && (
          <AlphabetRail
            albums={albums}
            listRef={albumListRef}
          />
        )}
      </div>
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
 * Vertical A-Z navigation rail. Letters with no matching album render dimmed
 * and disabled; clicking a present letter scrolls the album grid to the
 * first matching album. The rail floats over the right edge of the album
 * list so it doesn't take any horizontal space away from the grid.
 */
function AlphabetRail({
  albums,
  listRef,
}: {
  albums: AlbumSummary[];
  listRef: React.RefObject<HTMLDivElement>;
}): JSX.Element {
  const available = useMemo(() => {
    const set = new Set<string>();
    for (const album of albums) set.add(albumArtistFirstLetter(album.albumArtist));
    return set;
  }, [albums]);

  function jumpTo(letter: string): void {
    const container = listRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-newamp-album-artist-letter="${letter}"]`);
    if (!target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - containerRect.top + container.scrollTop - 12;
    container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  }

  return (
    <nav
      className="album-letter-rail"
      data-newamp-album-letter-rail
      aria-label="Jump to artist letter"
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
            onClick={() => present && jumpTo(letter)}
            title={present ? `Jump to artists starting with ${letter}` : `No ${letter} artists yet`}
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
