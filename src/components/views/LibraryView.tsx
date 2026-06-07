import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type {
  AudioExportFormat,
  LibraryHealth,
  MetadataLookupCandidate,
  SavedPlaylist,
  Track,
  TrackMetadataPatchInput,
} from '@shared/types';
import { buildArchiveCompass, duplicateExactTotal, missingMetadataTotal } from '@shared/archive-compass';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatTime, highlight } from '../../lib/format';
import { api } from '../../lib/api';
import { EmptyLibrary } from './EmptyLibrary';
import { ArtistLink, AlbumLink } from '../EntityLink';

type Sort =
  | 'artist'
  | 'album'
  | 'title'
  | 'added'
  | 'year'
  | 'genre'
  | 'duration'
  | 'recent'
  | 'plays'
  | 'loved'
  | 'rating';

const LIBRARY_PAGE_SIZE = 600;
const LIBRARY_SEARCH_DEBOUNCE_MS = 180;

export function LibraryView(): JSX.Element {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreTracks, setHasMoreTracks] = useState(false);
  const [matchingTrackCount, setMatchingTrackCount] = useState(0);
  const [summaryRefreshKey, setSummaryRefreshKey] = useState(0);
  const [sort, setSort] = useState<Sort>('artist');
  const [dropActive, setDropActive] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [metadataPanel, setMetadataPanel] = useState<{
    track: Track;
    candidates: MetadataLookupCandidate[];
    loading: boolean;
    status: string | null;
  } | null>(null);
  const [stats, setStats] = useState<{
    tracks: number;
    albums: number;
    artists: number;
    duration: number;
  }>({ tracks: 0, albums: 0, artists: 0, duration: 0 });
  const [health, setHealth] = useState<LibraryHealth | null>(null);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [smartRuleName, setSmartRuleName] = useState('');
  const [searchRuleStatus, setSearchRuleStatus] = useState<string | null>(null);
  const search = usePlayerStore((s) => s.searchQuery);
  const libraryQuery = useDebouncedValue(search, LIBRARY_SEARCH_DEBOUNCE_MS);
  const setSearch = usePlayerStore((s) => s.setSearchQuery);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const toggleCurrentLove = usePlayerStore((s) => s.toggleLove);
  const setTrackRating = usePlayerStore((s) => s.setTrackRating);
  const toggleAvoidAutoPlay = usePlayerStore((s) => s.toggleAvoidAutoPlay);
  const current = usePlayerStore((s) => s.current);

  // Bumped every time the active query/sort changes so an in-flight "load more"
  // can detect it resolved against a stale query and drop its page instead of
  // appending rows from a search the user already left.
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadGenerationRef.current += 1;
    setLoading(true);
    Promise.all([
      api.getTracks({ search: libraryQuery, sort, limit: LIBRARY_PAGE_SIZE, offset: 0 }),
      api.getTrackCount({ search: libraryQuery, sort }),
    ])
      .then(([rows, total]) => {
        if (!cancelled) {
          setTracks(rows);
          setMatchingTrackCount(total);
          setHasMoreTracks(rows.length < total);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMatchingTrackCount(0);
          setHasMoreTracks(false);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [libraryQuery, sort]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getStats(), api.getLibraryHealth()])
      .then(([nextStats, nextHealth]) => {
        if (cancelled) return;
        setStats(nextStats);
        setHealth(nextHealth);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [summaryRefreshKey]);

  const hasLibrary = stats.tracks > 0;

  async function scanDropped(dataTransfer: DataTransfer): Promise<void> {
    const paths = droppedPaths(dataTransfer);
    if (!paths.length) {
      setDropMessage('Drop folders or audio files from Windows Explorer.');
      return;
    }
    setDropMessage(`Scanning ${paths.length.toLocaleString()} dropped item${paths.length === 1 ? '' : 's'}...`);
    await api.scanLibrary(paths);
    await reloadLibraryPage();
    refreshLibrarySummary();
  }

  async function loadMoreTracks(): Promise<void> {
    if (loadingMore || !hasMoreTracks) return;
    const generation = loadGenerationRef.current;
    setLoadingMore(true);
    try {
      const rows = await api.getTracks({
        search: libraryQuery,
        sort,
        limit: LIBRARY_PAGE_SIZE,
        offset: tracks.length,
      });
      // The query/sort changed while this page was in flight — these rows belong
      // to a search the user already left; drop them rather than polluting the
      // current results.
      if (generation !== loadGenerationRef.current) return;
      const seen = new Set(tracks.map((track) => track.id));
      const freshRows = rows.filter((track) => !seen.has(track.id));
      // Append race-safe: re-dedupe against the LATEST committed list inside the
      // functional updater so a StrictMode double-fire or two in-flight pages
      // can't both append the same rows from this stale `tracks` snapshot.
      setTracks((current) => {
        if (!freshRows.length) return current;
        const have = new Set(current.map((track) => track.id));
        const add = freshRows.filter((track) => !have.has(track.id));
        return add.length ? [...current, ...add] : current;
      });
      // Base "load more" on the unique rows in this page: raw rows.length
      // over-counts when pages overlap, which keeps the button enabled and can
      // spin on no-op loads once offset stops advancing.
      setHasMoreTracks(freshRows.length > 0 && tracks.length + freshRows.length < matchingTrackCount);
    } finally {
      setLoadingMore(false);
    }
  }

  async function reloadLibraryPage(): Promise<void> {
    const [nextTracks, nextCount] = await Promise.all([
      api.getTracks({ search: libraryQuery, sort, limit: LIBRARY_PAGE_SIZE, offset: 0 }),
      api.getTrackCount({ search: libraryQuery, sort }),
    ]);
    setTracks(nextTracks);
    setMatchingTrackCount(nextCount);
    setHasMoreTracks(nextTracks.length < nextCount);
  }

  function refreshLibrarySummary(): void {
    setSummaryRefreshKey((key) => key + 1);
  }

  async function toggleLove(id: number): Promise<void> {
    const loved = await toggleCurrentLove(id);
    const nextLoved: 0 | 1 = loved ? 1 : 0;
    setTracks((rows) =>
      rows
        .map((t) => (t.id === id ? { ...t, loved: nextLoved } : t))
        .filter((t) => sort !== 'loved' || t.loved),
    );
    api.getTrackCount({ search: libraryQuery, sort }).then(setMatchingTrackCount).catch(() => undefined);
  }

  async function rateTrack(id: number, rating: number): Promise<void> {
    const updated = await setTrackRating(id, rating);
    if (!updated) return;
    setTracks((rows) => rows.map((track) => (track.id === id ? updated : track)));
    api.getTrackCount({ search: libraryQuery, sort }).then(setMatchingTrackCount).catch(() => undefined);
  }

  async function toggleAvoid(id: number): Promise<void> {
    const updated = await toggleAvoidAutoPlay(id);
    if (!updated) return;
    setTracks((rows) => rows.map((track) => (track.id === id ? updated : track)));
    api.getTrackCount({ search: libraryQuery, sort }).then(setMatchingTrackCount).catch(() => undefined);
  }

  async function lookupMetadata(track: Track): Promise<void> {
    setMetadataPanel({ track, candidates: [], loading: true, status: 'Searching MusicBrainz...' });
    try {
      const candidates = await api.lookupTrackMetadata(track.id);
      setMetadataPanel({
        track,
        candidates,
        loading: false,
        status: candidates.length
          ? `${candidates.length} MusicBrainz match${candidates.length === 1 ? '' : 'es'}`
          : 'No MusicBrainz match found.',
      });
    } catch (err) {
      setMetadataPanel({
        track,
        candidates: [],
        loading: false,
        status: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function applyMetadataCandidate(candidate: MetadataLookupCandidate): Promise<void> {
    if (!metadataPanel) return;
    const updated = await api.applyTrackMetadataPatch(metadataPanel.track.id, candidate);
    if (!updated) return;
    setTracks((rows) => rows.map((track) => (track.id === updated.id ? updated : track)));
    refreshLibrarySummary();
    setMetadataPanel({
      track: updated,
      candidates: [],
      loading: false,
      status: `Applied ${updated.artist} - ${updated.title}.`,
    });
    api.getTrackCount({ search: libraryQuery, sort }).then(setMatchingTrackCount).catch(() => undefined);
  }

  async function applyManualMetadataEdit(patch: TrackMetadataPatchInput): Promise<void> {
    if (!metadataPanel) return;
    const updated = await api.applyTrackMetadataEdit(metadataPanel.track.id, patch);
    if (!updated) return;
    setTracks((rows) => rows.map((track) => (track.id === updated.id ? updated : track)));
    refreshLibrarySummary();
    setMetadataPanel({
      track: updated,
      candidates: metadataPanel.candidates,
      loading: false,
      status: `Saved manual edits for ${updated.artist} - ${updated.title}.`,
    });
    api.getTrackCount({ search: libraryQuery, sort }).then(setMatchingTrackCount).catch(() => undefined);
  }

  function applyBulkMetadataResults(updated: Track[]): void {
    if (!updated.length) return;
    const byId = new Map(updated.map((track) => [track.id, track]));
    setTracks((rows) => rows.map((track) => byId.get(track.id) ?? track));
    refreshLibrarySummary();
    api.getTrackCount({ search: libraryQuery, sort }).then(setMatchingTrackCount).catch(() => undefined);
  }

  async function cleanMissingFiles(): Promise<void> {
    setCleanupStatus('Checking file paths...');
    const result = await api.pruneMissingTracks();
    const [nextTracks, nextCount, nextStats, nextHealth] = await Promise.all([
      api.getTracks({ search: libraryQuery, sort, limit: LIBRARY_PAGE_SIZE, offset: 0 }),
      api.getTrackCount({ search: libraryQuery, sort }),
      api.getStats(),
      api.getLibraryHealth(),
    ]);
    setTracks(nextTracks);
    setMatchingTrackCount(nextCount);
    setHasMoreTracks(nextTracks.length < nextCount);
    setStats(nextStats);
    setHealth(nextHealth);
    setCleanupStatus(
      result.removed
        ? `Removed ${result.removed.toLocaleString()} stale track${result.removed === 1 ? '' : 's'}.`
        : `Checked ${result.checked.toLocaleString()} track${result.checked === 1 ? '' : 's'}; no missing files.`,
    );
  }

  async function createDuplicateReviewPlaylist(): Promise<void> {
    if (!health?.duplicateGroups.length) {
      setCleanupStatus('No obvious duplicates to review.');
      return;
    }
    const trackIds = [
      ...new Set(health.duplicateGroups.flatMap((group) => group.tracks.map((track) => track.id))),
    ];
    if (!trackIds.length) {
      setCleanupStatus('No duplicate candidates were available.');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const playlist = await api.savePlaylist({
      name: `Duplicate Review ${date}`,
      trackIds,
    });
    setCleanupStatus(
      `Saved ${playlist.name} with ${playlist.trackCount.toLocaleString()} duplicate candidate${playlist.trackCount === 1 ? '' : 's'}.`,
    );
  }

  async function createMissingReviewPlaylist(): Promise<void> {
    if (!health) return;
    const missingTotal =
      health.missing.artist +
      health.missing.album +
      health.missing.year +
      health.missing.art +
      health.missing.duration;
    if (!missingTotal) {
      setCleanupStatus('No missing metadata/art candidates to review.');
      return;
    }
    setCleanupStatus('Building missing metadata review...');
    const trackIds = await collectTrackIdsByQueries([
      'missing:artist',
      'missing:album',
      'missing:year',
      'missing:art',
      'missing:duration',
    ]);
    await saveHealthReviewPlaylist('Missing Metadata Review', trackIds, 'missing metadata/art candidate');
  }

  async function createLegacyReviewPlaylist(): Promise<void> {
    if (!health?.legacyFormats.length) {
      setCleanupStatus('No legacy-format tracks to review.');
      return;
    }
    setCleanupStatus('Building legacy format review...');
    const trackIds = await collectTrackIdsByQueries(
      health.legacyFormats.map((item) => `format:${item.ext.replace(/^\./, '')}`),
    );
    await saveHealthReviewPlaylist('Legacy Format Review', trackIds, 'legacy-format track');
  }

  async function createQualityReviewPlaylist(): Promise<void> {
    if (!health) return;
    const qualityIssueCount = health.quality.lowBitrate + health.quality.unknown + health.quality.replayGainMissing;
    if (!qualityIssueCount) {
      setCleanupStatus('No archive-quality candidates to review.');
      return;
    }
    setCleanupStatus('Building archive radar review...');
    const queries = [
      health.quality.lowBitrate ? 'quality:low-bitrate' : null,
      health.quality.unknown ? 'quality:unknown' : null,
      health.quality.replayGainMissing ? 'rg:missing' : null,
    ].filter((query): query is string => query != null);
    const trackIds = await collectTrackIdsByQueries(queries);
    await saveHealthReviewPlaylist('Archive Radar Review', trackIds, 'archive-quality candidate');
  }

  async function collectTrackIdsByQueries(queries: string[]): Promise<number[]> {
    const rows = await Promise.all(
      queries.map((query) => api.getTrackIds({ search: query, sort: 'artist', limit: 100000 })),
    );
    return [...new Set(rows.flat())];
  }

  async function saveHealthReviewPlaylist(
    baseName: string,
    trackIds: number[],
    label: string,
  ): Promise<void> {
    if (!trackIds.length) {
      setCleanupStatus(`No ${label}s were available.`);
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const playlist = await api.savePlaylist({
      name: `${baseName} ${date}`,
      trackIds,
    });
    setCleanupStatus(
      `Saved ${playlist.name} with ${playlist.trackCount.toLocaleString()} ${label}${playlist.trackCount === 1 ? '' : 's'}.`,
    );
  }

  async function saveSearchAsSmartRule(): Promise<void> {
    const query = search.trim();
    if (!query) {
      setSearchRuleStatus('Enter a Library search first.');
      return;
    }
    const name = smartRuleName.trim() || smartRuleDefaultName(query);
    const saved = await api.saveSmartPlaylistRule({
      name,
      mood: 'focus',
      count: 50,
      searchQuery: query,
    });
    setSmartRuleName('');
    setSearchRuleStatus(`Saved dynamic rule ${saved.name}.`);
  }

  return (
    <div
      className="relative flex h-full flex-col"
      style={{ fontFamily: 'var(--font-mono)' }}
      onDragEnter={(e) => {
        e.preventDefault();
        setDropActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setDropActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        void scanDropped(e.dataTransfer);
      }}
    >
      {dropActive && <DropOverlay />}
      {hasLibrary && <StatsStrip stats={stats} />}
      {hasLibrary && health && (
        <LibraryHealthPanel
          health={health}
          cleanupStatus={cleanupStatus}
          onCleanMissingFiles={() => void cleanMissingFiles()}
          onCreateDuplicateReviewPlaylist={() => void createDuplicateReviewPlaylist()}
          onCreateMissingReviewPlaylist={() => void createMissingReviewPlaylist()}
          onCreateLegacyReviewPlaylist={() => void createLegacyReviewPlaylist()}
          onCreateQualityReviewPlaylist={() => void createQualityReviewPlaylist()}
        />
      )}
      <div
        className="library-commandbar flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--line)' }}
      >
        <label className="library-search-command" data-newamp-library-search-command>
          <span>SEARCH LIBRARY</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='artist:radiohead album:"in rainbows" year:2007 format:wma missing:art'
            className="lcd-text min-w-[260px] flex-1 text-[14px] outline-none"
            style={{ background: 'transparent', color: 'var(--display-fg)' }}
            autoFocus
          />
          <kbd>Ctrl K</kbd>
        </label>
        <SortPicker value={sort} onChange={setSort} />
        <input
          value={smartRuleName}
          onChange={(e) => setSmartRuleName(e.currentTarget.value)}
          placeholder="Smart rule name"
          className="bevel-in w-[154px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          aria-label="Smart rule name"
        />
        <button className="pxbtn" onClick={() => void saveSearchAsSmartRule()} disabled={!search.trim()}>
          SAVE SEARCH AS SMART RULE
        </button>
        <span
          className="text-[10px] uppercase tracking-[0.1em] tabular-nums"
          style={{ color: 'var(--ink-2)' }}
        >
          {search !== libraryQuery
            ? 'Updating...'
            : libraryCountLabel(tracks.length, matchingTrackCount, hasMoreTracks, !!libraryQuery)}
        </span>
      </div>
      {dropMessage && (
        <div
          className="border-b px-3 py-1 text-[11px]"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-2)', background: 'var(--panel)' }}
        >
          {dropMessage}
        </div>
      )}
      {searchRuleStatus && (
        <div
          className="border-b px-3 py-1 text-[11px]"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-2)', background: 'var(--panel)' }}
        >
          {searchRuleStatus}
        </div>
      )}
      {metadataPanel && (
        <MetadataRescuePanel
          key={metadataPanel.track.id}
          panel={metadataPanel}
          onClose={() => setMetadataPanel(null)}
          onApply={(candidate) => void applyMetadataCandidate(candidate)}
          onManualSave={(patch) => void applyManualMetadataEdit(patch)}
        />
      )}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading…
          </div>
          ) : tracks.length === 0 ? (
          libraryQuery ? (
            <div
              className="flex h-full items-center justify-center text-[12px]"
              style={{ color: 'var(--muted)' }}
            >
              No matches for &ldquo;{libraryQuery}&rdquo;.
            </div>
          ) : hasLibrary ? (
            <div
              className="flex h-full items-center justify-center text-[12px]"
              style={{ color: 'var(--muted)' }}
            >
              No tracks in this view.
            </div>
          ) : (
            <EmptyLibrary />
          )
        ) : (
          <>
            <TrackTable
              tracks={tracks}
              currentId={current?.id ?? null}
              search={libraryQuery}
              onPlay={(idx) => void playQueue(tracks, idx)}
              onPlayTracks={(selected) => void playQueue(selected, 0)}
              onPlayNext={queueTrackNext}
              onAddToQueue={addTrackToQueue}
              onPlayNextTracks={queueTracksNext}
              onAddTracksToQueue={addTracksToQueue}
              onToggleLove={toggleLove}
              onSetRating={rateTrack}
              onToggleAvoidAutoPlay={toggleAvoid}
              onMetadataLookup={(track) => void lookupMetadata(track)}
              onBulkMetadataSaved={applyBulkMetadataResults}
            />
            <LibraryPagingFooter
              shown={tracks.length}
              total={matchingTrackCount}
              hasMore={hasMoreTracks}
              loading={loadingMore}
              onLoadMore={() => void loadMoreTracks()}
            />
          </>
        )}
      </div>
    </div>
  );
}

function smartRuleDefaultName(query: string): string {
  const compact = query.replace(/\s+/g, ' ').trim();
  return `Search: ${compact.slice(0, 80)}`;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

function libraryCountLabel(
  shown: number,
  total: number,
  hasMore: boolean,
  searching: boolean,
): string {
  const noun = searching ? 'match' : 'track';
  const plural = searching ? 'matches' : 'tracks';
  if (total <= 0) {
    return `0 ${plural}`;
  }
  if (hasMore || shown < total) {
    return `${shown.toLocaleString()} of ${total.toLocaleString()} ${plural}`;
  }
  return `${total.toLocaleString()} ${total === 1 ? noun : plural}`;
}

function LibraryPagingFooter({
  shown,
  total,
  hasMore,
  loading,
  onLoadMore,
}: {
  shown: number;
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}): JSX.Element | null {
  if (!hasMore && (!total || shown >= total)) return null;
  return (
    <div
      className="sticky bottom-0 flex items-center justify-between border-t px-3 py-2 text-[11px]"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--ink-2)' }}
    >
      <span>
        {total
          ? `${shown.toLocaleString()} of ${total.toLocaleString()} tracks loaded`
          : `${shown.toLocaleString()} matches loaded`}
      </span>
      {hasMore && (
        <button className="pxbtn" onClick={onLoadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}

function droppedPaths(dataTransfer: DataTransfer): string[] {
  return api.getDroppedFilePaths(Array.from(dataTransfer.files));
}

function DropOverlay(): JSX.Element {
  return (
    <div
      className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center"
      style={{
        border: '1px dashed var(--accent)',
        background: 'rgba(0,0,0,0.72)',
        boxShadow: '0 0 28px var(--accent-glow)',
      }}
    >
      <div className="lcd-text text-[18px]">Drop music folders or files to scan</div>
    </div>
  );
}

function StatsStrip({
  stats,
}: {
  stats: { tracks: number; albums: number; artists: number; duration: number };
}): JSX.Element {
  const tiles: Array<{ label: string; value: string; tone?: 'accent' | 'warn' }> = [
    { label: 'Tracks', value: stats.tracks.toLocaleString(), tone: 'accent' },
    { label: 'Albums', value: stats.albums.toLocaleString() },
    { label: 'Artists', value: stats.artists.toLocaleString() },
    { label: 'Runtime', value: formatRuntime(stats.duration), tone: 'warn' },
  ];
  return (
    <div
      className="flex items-stretch gap-0 border-b"
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--line)',
      }}
    >
      {tiles.map((t, i) => (
        <div
          key={t.label}
          className="flex flex-1 flex-col gap-[2px] px-4 py-[10px]"
          style={{
            borderRight: i < tiles.length - 1 ? '1px solid var(--line)' : undefined,
          }}
        >
          <div
            className="text-[9px] uppercase tracking-[0.12em]"
            style={{ color: 'var(--ink-2)' }}
          >
            {t.label}
          </div>
          <div
            className="text-[18px] font-bold tabular-nums leading-tight"
            style={{
              color:
                t.tone === 'accent'
                  ? 'var(--accent)'
                  : t.tone === 'warn'
                    ? 'var(--warn)'
                    : 'var(--ink)',
            }}
          >
            {t.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function LibraryHealthPanel({
  health,
  cleanupStatus,
  onCleanMissingFiles,
  onCreateDuplicateReviewPlaylist,
  onCreateMissingReviewPlaylist,
  onCreateLegacyReviewPlaylist,
  onCreateQualityReviewPlaylist,
}: {
  health: LibraryHealth;
  cleanupStatus: string | null;
  onCleanMissingFiles: () => void;
  onCreateDuplicateReviewPlaylist: () => void;
  onCreateMissingReviewPlaylist: () => void;
  onCreateLegacyReviewPlaylist: () => void;
  onCreateQualityReviewPlaylist: () => void;
}): JSX.Element {
  const compass = buildArchiveCompass(health);
  const missingTotal = missingMetadataTotal(health);
  const legacySummary = health.legacyFormats.length
    ? health.legacyFormats.map((item) => `${item.ext} ${item.count}`).join(' / ')
    : 'none';
  const qualityIssueCount = health.quality.lowBitrate + health.quality.unknown + health.quality.replayGainMissing;
  const recent = health.recentlyAdded.slice(0, 3);

  return (
    <div
      className="grid gap-3 border-b px-3 py-2 text-[11px]"
      style={{
        borderColor: 'var(--line)',
        background: 'var(--panel)',
        gridTemplateColumns: 'minmax(210px,0.9fr) minmax(240px,1fr) minmax(220px,1fr) minmax(220px,1fr)',
      }}
    >
      <div>
        <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Library Health
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums" style={{ color: 'var(--ink-2)' }}>
          <span>Missing tags</span><span className="text-right">{missingTotal.toLocaleString()}</span>
          <span>Duplicates</span><span className="text-right">{health.duplicateGroups.length.toLocaleString()}</span>
          <span>Exact matches</span><span className="text-right">{duplicateExactTotal(health).toLocaleString()}</span>
          <span>Legacy</span><span className="truncate text-right" title={legacySummary}>{legacySummary}</span>
        </div>
        <div className="mt-2 grid grid-cols-[52px_minmax(0,1fr)] gap-2">
          <div
            className="bevel-in flex h-[52px] items-center justify-center text-[24px] font-black"
            style={{ color: compass.score >= 86 ? 'var(--accent)' : 'var(--warn)' }}
            title={`Archive score ${compass.score}/100`}
          >
            {compass.grade}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-bold" style={{ color: 'var(--ink)' }}>
              {compass.profile}
            </div>
            <div className="mt-1 line-clamp-2 leading-snug" style={{ color: 'var(--ink-2)' }}>
              {compass.headline}
            </div>
          </div>
        </div>
        <div className="mt-2 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Archive Radar
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums" style={{ color: 'var(--ink-2)' }}>
          <span>Lossless / hi-res</span>
          <span className="text-right">{health.quality.lossless.toLocaleString()} / {health.quality.hiRes.toLocaleString()}</span>
          <span>DSD / fallback</span>
          <span className="text-right">{health.quality.dsd.toLocaleString()} / {health.quality.ffmpegFallback.toLocaleString()}</span>
          <span>Low bitrate</span>
          <span className="text-right">{health.quality.lowBitrate.toLocaleString()}</span>
          <span>Lossy / unknown</span>
          <span className="text-right">{health.quality.lossy.toLocaleString()} / {health.quality.unknown.toLocaleString()}</span>
          <span>ReplayGain ready</span>
          <span className="text-right">{health.quality.replayGainReady.toLocaleString()}</span>
          <span>ReplayGain missing</span>
          <span className="text-right">{health.quality.replayGainMissing.toLocaleString()}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="pxbtn" onClick={onCleanMissingFiles}>
            Clean missing files
          </button>
          <button
            className="pxbtn"
            onClick={onCreateMissingReviewPlaylist}
            disabled={!missingTotal}
          >
            Save missing review
          </button>
          <button
            className="pxbtn"
            onClick={onCreateDuplicateReviewPlaylist}
            disabled={!health.duplicateGroups.length}
          >
            Save duplicate review
          </button>
          <button
            className="pxbtn"
            onClick={onCreateLegacyReviewPlaylist}
            disabled={!health.legacyFormats.length}
          >
            Save legacy review
          </button>
          <button
            className="pxbtn"
            onClick={onCreateQualityReviewPlaylist}
            disabled={!qualityIssueCount}
          >
            Save archive radar
          </button>
          {cleanupStatus && (
            <span className="truncate" style={{ color: 'var(--muted)' }}>
              {cleanupStatus}
            </span>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-2)' }}>
          Compass Moves
        </div>
        <div className="mt-1 grid gap-[3px]">
          {compass.moves.slice(0, 4).map((move) => (
            <div key={move.label} className="bevel-in px-2 py-[5px]" title={move.detail}>
              <div className="flex gap-2">
                <span className="w-24 shrink-0 truncate font-bold" style={{ color: 'var(--accent)' }}>
                  {move.label}
                </span>
                <span className="min-w-0 truncate" style={{ color: 'var(--ink-2)' }}>
                  {move.detail}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-2)' }}>
          Top Duplicate Clusters
        </div>
        {health.duplicateGroups.length ? (
          <div className="mt-1 grid gap-[2px]">
            {health.duplicateGroups.slice(0, 3).map((group) => (
              <div key={`${group.artist}:${group.title}`} className="flex gap-2">
                <span className="w-8 tabular-nums" style={{ color: 'var(--warn)' }}>{group.count}x</span>
                <span className="truncate" title={`${group.artist} - ${group.title}`}>
                  {group.artist} - {group.title}
                </span>
                {group.exactMatchCount >= 2 && (
                  <span className="shrink-0 tabular-nums" style={{ color: 'var(--accent)' }}>
                    {group.exactMatchCount} exact matches
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1" style={{ color: 'var(--muted)' }}>No obvious duplicates.</div>
        )}
      </div>
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-2)' }}>
          Recent Imports
        </div>
        <div className="mt-1 grid gap-[2px]">
          {recent.map((track) => (
            <div key={track.id} className="truncate" title={`${track.artist} - ${track.title}`}>
              <ArtistLink artist={track.artist} color="inherit" /> - {track.title}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatRuntime(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function SortPicker({ value, onChange }: { value: Sort; onChange: (s: Sort) => void }): JSX.Element {
  const opts: Array<{ id: Sort; label: string }> = [
    { id: 'artist', label: 'Artist' },
    { id: 'album', label: 'Album' },
    { id: 'title', label: 'Title' },
    { id: 'added', label: 'Added' },
    { id: 'year', label: 'Year' },
    { id: 'genre', label: 'Genre' },
    { id: 'duration', label: 'Time' },
    { id: 'recent', label: 'Recent' },
    { id: 'plays', label: 'Most Played' },
    { id: 'loved', label: 'Loved' },
    { id: 'rating', label: 'Rating' },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          className={`pxbtn ${value === o.id ? 'is-active' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type TrackColumnKey =
  | 'play'
  | 'select'
  | 'queue'
  | 'playlist'
  | 'number'
  | 'title'
  | 'artist'
  | 'album'
  | 'year'
  | 'time'
  | 'plays'
  | 'rating'
  | 'mix'
  | 'tag'
  | 'love';

const TRACK_TABLE_COLUMN_WIDTH_KEY = 'newamp:track-table:column-widths';
const TRACK_TABLE_COLUMN_DEFAULTS: Record<TrackColumnKey, number> = {
  play: 34,
  select: 34,
  queue: 74,
  playlist: 154,
  number: 44,
  title: 340,
  artist: 210,
  album: 220,
  year: 62,
  time: 70,
  plays: 62,
  rating: 96,
  mix: 70,
  tag: 56,
  love: 44,
};
const TRACK_TABLE_COLUMN_MINS: Record<TrackColumnKey, number> = {
  play: 28,
  select: 28,
  queue: 58,
  playlist: 112,
  number: 36,
  title: 160,
  artist: 120,
  album: 130,
  year: 48,
  time: 54,
  plays: 48,
  rating: 82,
  mix: 58,
  tag: 46,
  love: 36,
};

function loadTrackTableColumnWidths(): Record<TrackColumnKey, number> {
  if (typeof window === 'undefined') return { ...TRACK_TABLE_COLUMN_DEFAULTS };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TRACK_TABLE_COLUMN_WIDTH_KEY) ?? '{}') as Partial<Record<TrackColumnKey, unknown>>;
    return normalizeTrackTableColumnWidths(parsed);
  } catch {
    return { ...TRACK_TABLE_COLUMN_DEFAULTS };
  }
}

function normalizeTrackTableColumnWidths(input: Partial<Record<TrackColumnKey, unknown>>): Record<TrackColumnKey, number> {
  const widths = { ...TRACK_TABLE_COLUMN_DEFAULTS };
  for (const key of Object.keys(TRACK_TABLE_COLUMN_DEFAULTS) as TrackColumnKey[]) {
    const raw = Number(input[key]);
    if (!Number.isFinite(raw)) continue;
    widths[key] = Math.max(TRACK_TABLE_COLUMN_MINS[key], Math.min(680, Math.round(raw)));
  }
  return widths;
}

function saveTrackTableColumnWidths(widths: Record<TrackColumnKey, number>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TRACK_TABLE_COLUMN_WIDTH_KEY, JSON.stringify(widths));
  } catch {
    /* ignore storage failures */
  }
}

export function TrackTable({
  tracks,
  currentId,
  search,
  onPlay,
  onPlayTracks,
  onPlayNext,
  onAddToQueue,
  onPlayNextTracks,
  onAddTracksToQueue,
  onToggleLove,
  onSetRating,
  onToggleAvoidAutoPlay,
  onMetadataLookup,
  onBulkMetadataSaved,
}: {
  tracks: Track[];
  currentId: number | null;
  search?: string;
  onPlay: (index: number) => void;
  onPlayTracks?: (tracks: Track[]) => void;
  onPlayNext?: (track: Track) => void;
  onAddToQueue?: (track: Track) => void;
  onPlayNextTracks?: (tracks: Track[]) => void;
  onAddTracksToQueue?: (tracks: Track[]) => void;
  onToggleLove?: (id: number) => Promise<boolean | void>;
  onSetRating?: (id: number, rating: number) => Promise<Track | null | void>;
  onToggleAvoidAutoPlay?: (id: number) => Promise<Track | null | void>;
  onMetadataLookup?: (track: Track) => void;
  onBulkMetadataSaved?: (tracks: Track[]) => void;
}): JSX.Element {
  const storeToggleLove = usePlayerStore((s) => s.toggleLove);
  const storeSetTrackRating = usePlayerStore((s) => s.setTrackRating);
  const storeToggleAvoidAutoPlay = usePlayerStore((s) => s.toggleAvoidAutoPlay);
  const [localPatches, setLocalPatches] = useState<Map<number, Partial<Track>>>(() => new Map());
  const visible = useMemo(
    () => tracks.map((track) => {
      const patch = localPatches.get(track.id);
      return patch ? { ...track, ...patch } : track;
    }),
    [tracks, localPatches],
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const showMetadataLookup = !!onMetadataLookup;
  const showQueueActions = !!onPlayNext || !!onAddToQueue;
  const [playlistTargets, setPlaylistTargets] = useState<SavedPlaylist[]>([]);
  const [playlistStatus, setPlaylistStatus] = useState<string | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [bulkAlbumArtist, setBulkAlbumArtist] = useState('');
  const [bulkAlbum, setBulkAlbum] = useState('');
  const [bulkGenre, setBulkGenre] = useState('');
  const [bulkYear, setBulkYear] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const selectedTracks = useMemo(
    () => visible.filter((track) => selectedIds.has(track.id)),
    [visible, selectedIds],
  );
  const allVisibleSelected = visible.length > 0 && visible.every((track) => selectedIds.has(track.id));
  const [columnWidths, setColumnWidths] = useState<Record<TrackColumnKey, number>>(() => loadTrackTableColumnWidths());
  const activeColumnKeys = useMemo<TrackColumnKey[]>(
    () => [
      'select',
      'play',
      ...(showQueueActions ? ['queue' as TrackColumnKey] : []),
      ...(playlistTargets.length > 0 ? ['playlist' as TrackColumnKey] : []),
      'number',
      'title',
      'artist',
      'album',
      'year',
      'time',
      'plays',
      'rating',
      'mix',
      ...(showMetadataLookup ? ['tag' as TrackColumnKey] : []),
      'love',
    ],
    [playlistTargets.length, showMetadataLookup, showQueueActions],
  );
  const tableMinWidth = activeColumnKeys.reduce((sum, key) => sum + columnWidths[key], 0);

  useEffect(() => {
    let cancelled = false;
    api.getPlaylists()
      .then((next) => {
        if (!cancelled) setPlaylistTargets(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelectedIds((current) => {
      const visibleIds = new Set(visible.map((track) => track.id));
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visible]);

  useEffect(() => {
    setLocalPatches((current) => {
      if (!current.size) return current;
      const trackIds = new Set(tracks.map((track) => track.id));
      const next = new Map([...current].filter(([id]) => trackIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [tracks]);

  function setTrackSelected(id: number, selected: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setAllVisibleSelected(selected: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const track of visible) {
        if (selected) next.add(track.id);
        else next.delete(track.id);
      }
      return next;
    });
  }

  function startColumnResize(column: TrackColumnKey, event: ReactPointerEvent<HTMLElement>): void {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[column];
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.max(
        TRACK_TABLE_COLUMN_MINS[column],
        Math.min(680, Math.round(startWidth + moveEvent.clientX - startX)),
      );
      setColumnWidths((current) => {
        if (current[column] === nextWidth) return current;
        const next = { ...current, [column]: nextWidth };
        saveTrackTableColumnWidths(next);
        return next;
      });
    };
    const onUp = (upEvent: PointerEvent): void => {
      try {
        target.releasePointerCapture(upEvent.pointerId);
      } catch {
        /* pointer may already be released */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function headerCell(
    column: TrackColumnKey,
    content: ReactNode,
    className = '',
    label: string = column,
  ): JSX.Element {
    return (
      <th
        className={`track-table-resizable-th px-2 py-[6px] ${className}`}
        style={{ width: columnWidths[column] }}
        data-newamp-track-column={column}
      >
        {content}
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label} column`}
          tabIndex={0}
          className="track-table-resize-handle"
          data-newamp-track-column-resizer={column}
          onPointerDown={(event) => startColumnResize(column, event)}
        />
      </th>
    );
  }

  function patchLocalTrack(id: number, patch: Partial<Track>): void {
    setLocalPatches((current) => {
      const next = new Map(current);
      next.set(id, { ...(next.get(id) ?? {}), ...patch });
      return next;
    });
  }

  async function toggleLoveForTrack(track: Track): Promise<void> {
    const loved = onToggleLove ? await onToggleLove(track.id) : await storeToggleLove(track.id);
    if (typeof loved === 'boolean') patchLocalTrack(track.id, { loved: loved ? 1 : 0 });
  }

  async function setRatingForTrack(track: Track, rating: number): Promise<void> {
    const updated = onSetRating
      ? await onSetRating(track.id, rating)
      : await storeSetTrackRating(track.id, rating);
    if (updated) patchLocalTrack(track.id, updated);
  }

  async function toggleAvoidForTrack(track: Track): Promise<void> {
    const updated = onToggleAvoidAutoPlay
      ? await onToggleAvoidAutoPlay(track.id)
      : await storeToggleAvoidAutoPlay(track.id);
    if (updated) patchLocalTrack(track.id, updated);
  }

  async function addToSavedPlaylist(playlistId: number, track: Track): Promise<void> {
    const updated = await api.addTracksToPlaylist({ playlistId, trackIds: [track.id] });
    if (!updated) {
      setPlaylistStatus('Playlist was not found.');
      return;
    }
    setPlaylistTargets((current) =>
      current.map((playlist) => (playlist.id === updated.id ? updated : playlist)),
    );
    setPlaylistStatus(`Added ${track.title} to ${updated.name}.`);
  }

  async function saveSelectedAsPlaylist(): Promise<void> {
    if (!selectedTracks.length) return;
    const name = newPlaylistName.trim() || selectedPlaylistDefaultName(selectedTracks);
    const saved = await api.savePlaylist({
      name,
      trackIds: selectedTracks.map((track) => track.id),
    });
    setPlaylistTargets((current) => [saved, ...current.filter((playlist) => playlist.id !== saved.id)]);
    setPlaylistStatus(`Created ${saved.name} with ${saved.trackCount.toLocaleString()} tracks.`);
    setNewPlaylistName('');
    setSelectedIds(new Set());
  }

  async function applyBulkMetadataEdit(): Promise<void> {
    if (!selectedTracks.length || bulkBusy) return;
    const patchResult = readBulkMetadataPatch({
      albumArtist: bulkAlbumArtist,
      album: bulkAlbum,
      genre: bulkGenre,
      year: bulkYear,
    });
    if (patchResult.error) {
      setPlaylistStatus(patchResult.error);
      return;
    }
    if (!patchResult.value) {
      setPlaylistStatus('Enter album artist, album, genre, or year before bulk tagging.');
      return;
    }
    const patch = patchResult.value;

    setBulkBusy(true);
    try {
      const updated: Track[] = [];
      for (const track of selectedTracks) {
        const next = await api.applyTrackMetadataEdit(track.id, patch);
        if (next) updated.push(next);
      }
      onBulkMetadataSaved?.(updated);
      setPlaylistStatus(`Updated metadata for ${updated.length.toLocaleString()} selected track${updated.length === 1 ? '' : 's'}.`);
      setBulkAlbumArtist('');
      setBulkAlbum('');
      setBulkGenre('');
      setBulkYear('');
    } finally {
      setBulkBusy(false);
    }
  }

  async function autoNumberSelectedTracks(): Promise<void> {
    if (!selectedTracks.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const updated: Track[] = [];
      for (const [index, track] of selectedTracks.entries()) {
        const next = await api.applyTrackMetadataEdit(track.id, { trackNo: index + 1 });
        if (next) updated.push(next);
      }
      onBulkMetadataSaved?.(updated);
      setPlaylistStatus(`Numbered ${updated.length.toLocaleString()} selected track${updated.length === 1 ? '' : 's'} in visible order.`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function exportSelectedWavs(): Promise<void> {
    if (!selectedTracks.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const result = await api.exportTracksWav(selectedTracks.map((track) => track.id));
      if (!result) {
        setPlaylistStatus('WAV export canceled.');
        return;
      }
      const skipped = result.skipped.length ? `; ${result.skipped.length.toLocaleString()} skipped` : '';
      setPlaylistStatus(`Exported ${result.exported.toLocaleString()} WAV file${result.exported === 1 ? '' : 's'}${skipped} to ${result.path}.`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function exportSelectedAudio(format: AudioExportFormat): Promise<void> {
    if (!selectedTracks.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const result = await api.exportTracksAudio(selectedTracks.map((track) => track.id), format);
      if (!result) {
        setPlaylistStatus(`${format.toUpperCase()} export canceled.`);
        return;
      }
      const skipped = result.skipped.length ? `; ${result.skipped.length.toLocaleString()} skipped` : '';
      setPlaylistStatus(`Exported ${result.exported.toLocaleString()} ${format.toUpperCase()} file${result.exported === 1 ? '' : 's'}${skipped} to ${result.path}.`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function analyzeSelectedReplayGain(): Promise<void> {
    if (!selectedTracks.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const result = await api.analyzeReplayGain(selectedTracks.map((track) => track.id));
      onBulkMetadataSaved?.(result.tracks);
      const skipped = result.skipped.length ? `; ${result.skipped.length.toLocaleString()} skipped` : '';
      setPlaylistStatus(`Analyzed ReplayGain for ${result.analyzed.toLocaleString()} selected track${result.analyzed === 1 ? '' : 's'}${skipped}.`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function analyzeSelectedAlbumReplayGain(): Promise<void> {
    if (!selectedTracks.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const result = await api.analyzeAlbumReplayGain(selectedTracks.map((track) => track.id));
      onBulkMetadataSaved?.(result.tracks);
      const skipped = result.skipped.length ? `; ${result.skipped.length.toLocaleString()} skipped` : '';
      const groups = result.albumGroups == null ? '' : ` across ${result.albumGroups.toLocaleString()} album group${result.albumGroups === 1 ? '' : 's'}`;
      setPlaylistStatus(`Analyzed album ReplayGain for ${result.analyzed.toLocaleString()} selected track${result.analyzed === 1 ? '' : 's'}${groups}${skipped}.`);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <>
      {playlistStatus && (
        <div
          className="border-b px-3 py-1 text-[11px]"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-2)', background: 'var(--panel)' }}
        >
          {playlistStatus}
        </div>
      )}
      {selectedTracks.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-[11px]"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-2)', background: 'var(--panel)' }}
        >
          <span style={{ color: 'var(--accent)' }}>
            {selectedTracks.length.toLocaleString()} selected
          </span>
          {onPlayTracks && (
            <button className="pxbtn is-active" onClick={() => onPlayTracks(selectedTracks)}>
              PLAY SELECTED
            </button>
          )}
          {onPlayNextTracks && (
            <button className="pxbtn" onClick={() => onPlayNextTracks(selectedTracks)}>
              NEXT SELECTED
            </button>
          )}
          {onAddTracksToQueue && (
            <button className="pxbtn" onClick={() => onAddTracksToQueue(selectedTracks)}>
              QUEUE SELECTED
            </button>
          )}
          <input
            value={newPlaylistName}
            onChange={(event) => setNewPlaylistName(event.currentTarget.value)}
            placeholder="Playlist name"
            className="bevel-in min-w-[180px] px-2 py-1 text-[11px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
            aria-label="New playlist name"
          />
          <button className="pxbtn" onClick={() => void saveSelectedAsPlaylist()}>
            SAVE SELECTED AS PLAYLIST
          </button>
          <PlaylistAppendPicker tracks={selectedTracks} label="ADD SELECTED TO PLAYLIST" />
          <button
            className="pxbtn"
            data-export-selected-wav
            onClick={() => void exportSelectedWavs()}
            disabled={bulkBusy}
            title="Transcode selected tracks to WAV files in a folder"
          >
            EXPORT SELECTED WAV
          </button>
          <button
            className="pxbtn"
            data-export-selected-mp3
            onClick={() => void exportSelectedAudio('mp3')}
            disabled={bulkBusy}
            title="Transcode selected tracks to 320 kbps MP3 files in a folder"
          >
            MP3
          </button>
          <button
            className="pxbtn"
            data-export-selected-flac
            onClick={() => void exportSelectedAudio('flac')}
            disabled={bulkBusy}
            title="Transcode selected tracks to FLAC files in a folder"
          >
            FLAC
          </button>
          <button
            className="pxbtn"
            data-export-selected-opus
            onClick={() => void exportSelectedAudio('opus')}
            disabled={bulkBusy}
            title="Transcode selected tracks to Opus files in a folder"
          >
            OPUS
          </button>
          <button
            className="pxbtn"
            data-analyze-selected-replaygain
            onClick={() => void analyzeSelectedReplayGain()}
            disabled={bulkBusy}
            title="Analyze selected tracks and store ReplayGain in the NewAmp catalog"
          >
            ANALYZE REPLAYGAIN
          </button>
          <button
            className="pxbtn"
            data-analyze-selected-album-replaygain
            onClick={() => void analyzeSelectedAlbumReplayGain()}
            disabled={bulkBusy}
            title="Analyze selected tracks as albums and store track plus album ReplayGain"
          >
            ANALYZE ALBUM GAIN
          </button>
          <div className="flex flex-wrap items-center gap-1" data-bulk-metadata-edit>
            <input
              value={bulkAlbumArtist}
              onChange={(event) => setBulkAlbumArtist(event.currentTarget.value)}
              placeholder="Album artist"
              className="bevel-in w-[118px] px-2 py-1 text-[11px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
              aria-label="Bulk album artist"
            />
            <input
              value={bulkAlbum}
              onChange={(event) => setBulkAlbum(event.currentTarget.value)}
              placeholder="Album"
              className="bevel-in w-[118px] px-2 py-1 text-[11px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
              aria-label="Bulk album"
            />
            <input
              value={bulkGenre}
              onChange={(event) => setBulkGenre(event.currentTarget.value)}
              placeholder="Genre"
              className="bevel-in w-[96px] px-2 py-1 text-[11px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
              aria-label="Bulk genre"
            />
            <input
              value={bulkYear}
              onChange={(event) => setBulkYear(event.currentTarget.value)}
              placeholder="Year"
              inputMode="numeric"
              className="bevel-in w-[64px] px-2 py-1 text-[11px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
              aria-label="Bulk year"
            />
            <button className="pxbtn" onClick={() => void applyBulkMetadataEdit()} disabled={bulkBusy}>
              {bulkBusy ? 'TAGGING' : 'BULK TAG SELECTED'}
            </button>
            <button
              className="pxbtn"
              data-auto-number-selected
              onClick={() => void autoNumberSelectedTracks()}
              disabled={bulkBusy}
              title="Assign track numbers in visible selected order"
            >
              AUTO NUMBER SELECTED
            </button>
          </div>
          <button className="pxbtn ml-auto" onClick={() => setSelectedIds(new Set())}>
            Clear
          </button>
        </div>
      )}
      <table
        className="table-fixed text-[12px]"
        style={{
          fontFamily: 'var(--font-mono)',
          borderCollapse: 'separate',
          borderSpacing: 0,
          minWidth: tableMinWidth,
          width: `max(100%, ${tableMinWidth}px)`,
        }}
      >
      <colgroup>
        {activeColumnKeys.map((column) => (
          <col key={column} style={{ width: columnWidths[column] }} />
        ))}
      </colgroup>
      <thead
        className="sticky top-0 z-10"
        style={{ background: 'var(--panel)', color: 'var(--ink-2)' }}
      >
        <tr
          className="text-left text-[9px] uppercase tracking-[0.12em]"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          {headerCell('select', (
            <input
              type="checkbox"
              aria-label="Select all visible tracks"
              checked={allVisibleSelected}
              onChange={(event) => setAllVisibleSelected(event.currentTarget.checked)}
            />
          ), '', 'select')}
          {headerCell('play', '')}
          {showQueueActions && headerCell('queue', 'Queue')}
          {playlistTargets.length > 0 && headerCell('playlist', 'Playlist')}
          {headerCell('number', '#', 'text-right tabular-nums', 'track number')}
          {headerCell('title', 'Title')}
          {headerCell('artist', 'Artist')}
          {headerCell('album', 'Album')}
          {headerCell('year', 'Year', 'text-right tabular-nums')}
          {headerCell('time', 'Time', 'text-right tabular-nums')}
          {headerCell('plays', 'Plays', 'text-right tabular-nums')}
          {headerCell('rating', 'Rating', 'text-right')}
          {headerCell('mix', 'Mix', 'text-right')}
          {showMetadataLookup && headerCell('tag', 'Tag', 'text-right')}
          {headerCell('love', '★', 'text-right', 'love')}
        </tr>
      </thead>
      <tbody>
        {visible.map((t, i) => {
          const isActive = currentId === t.id;
          const zebra = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)';
          return (
            <tr
              key={t.id}
              data-newamp-track-row
              data-track-id={t.id}
              data-track-title={t.title}
              className="cursor-pointer transition-colors"
              style={{
                background: isActive ? 'rgba(52,211,153,0.06)' : zebra,
                color: isActive ? 'var(--accent)' : 'var(--ink)',
              }}
              onDoubleClick={() => onPlay(i)}
              onMouseEnter={(e) =>
                !isActive && (e.currentTarget.style.background = 'var(--panel-2)')
              }
              onMouseLeave={(e) => !isActive && (e.currentTarget.style.background = zebra)}
            >
              <td className="px-2 py-[5px]">
                <input
                  type="checkbox"
                  aria-label={`Select ${t.title}`}
                  checked={selectedIds.has(t.id)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setTrackSelected(t.id, event.currentTarget.checked)}
                />
              </td>
              <td className="px-2 py-[5px]">
                {isActive ? (
                  <span className="eq-bars">
                    <span /><span /><span /><span />
                  </span>
                ) : (
                  <button
                    className="opacity-50 hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlay(i);
                    }}
                    title="Play"
                  >
                    ▶
                  </button>
                )}
              </td>
              {showQueueActions && (
                <td className="px-2 py-[5px]">
                  <div className="track-action-cluster">
                    {onPlayNext && (
                      <button
                        className="track-icon-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlayNext(t);
                        }}
                        aria-label="Play next"
                        title="Play next"
                      >
                        ⤴
                      </button>
                    )}
                    {onAddToQueue && (
                      <button
                        className="track-icon-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddToQueue(t);
                        }}
                        aria-label="Add to queue"
                        title="Add to queue"
                      >
                        ≡
                      </button>
                    )}
                  </div>
                </td>
              )}
              {playlistTargets.length > 0 && (
                <td className="px-2 py-[5px]">
                  <select
                    aria-label="Add to playlist"
                    title="Add to playlist"
                    value=""
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      event.stopPropagation();
                      const playlistId = Number(event.currentTarget.value);
                      if (playlistId > 0) void addToSavedPlaylist(playlistId, t);
                    }}
                    className="bevel-in w-full px-1 py-[2px] text-[10px] outline-none"
                    style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
                  >
                    <option value="">Add to playlist</option>
                    {playlistTargets.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </option>
                    ))}
                  </select>
                </td>
              )}
              <td
                className="px-2 py-[5px] text-right tabular-nums"
                style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}
              >
                {t.trackNo ?? i + 1}
              </td>
              <td className="px-2 py-[5px]">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={t.title}>
                    {search ? highlight(t.title, search) : t.title}
                  </span>
                  <button
                    className="track-icon-btn track-folder-btn"
                    data-show-in-folder
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.showInFolder(t.path);
                    }}
                    aria-label="Show in folder"
                    title="Show in folder"
                  >
                    ⌕
                  </button>
                </div>
              </td>
              <td
                className="truncate px-2 py-[5px]"
                style={{ color: isActive ? 'var(--accent)' : 'var(--ink-2)' }}
                title={t.artist}
              >
                <ArtistLink artist={t.artist} color="inherit">
                  {search ? highlight(t.artist, search) : t.artist}
                </ArtistLink>
              </td>
              <td
                className="truncate px-2 py-[5px]"
                style={{ color: isActive ? 'var(--accent)' : 'var(--ink-2)' }}
                title={t.album}
              >
                <AlbumLink
                  album={t.album}
                  albumArtist={t.albumArtist || t.artist}
                  color="inherit"
                >
                  {search ? highlight(t.album, search) : t.album}
                </AlbumLink>
              </td>
              <td
                className="px-2 py-[5px] text-right tabular-nums"
                style={{ color: 'var(--muted)' }}
              >
                {t.year ?? '—'}
              </td>
              <td
                className="px-2 py-[5px] text-right tabular-nums"
                style={{ color: 'var(--ink-2)' }}
              >
                {formatTime(t.duration ?? 0)}
              </td>
              <td
                className="px-2 py-[5px] text-right tabular-nums"
                style={{ color: t.playCount > 0 ? 'var(--ink-2)' : 'var(--muted)' }}
              >
                {t.playCount > 0 ? t.playCount.toLocaleString() : ''}
              </td>
              <td className="px-2 py-[5px] text-right" data-newamp-rating={t.rating}>
                <RatingStars
                  value={t.rating}
                  onChange={(rating) => setRatingForTrack(t, rating)}
                />
              </td>
              <td className="px-2 py-[5px] text-right">
                <button
                  className="pxbtn px-1.5 py-[1px] text-[9px]"
                  data-avoid-autoplay
                  onClick={async (e) => {
                    e.stopPropagation();
                    await toggleAvoidForTrack(t);
                  }}
                  style={{
                    color: t.avoidAutoPlay ? 'var(--warn)' : 'var(--muted)',
                    borderColor: t.avoidAutoPlay ? 'var(--warn)' : 'var(--line)',
                  }}
                  title={t.avoidAutoPlay ? 'Excluded from continuous mix and generated sets' : 'Allowed in continuous mix and generated sets'}
                >
                  {t.avoidAutoPlay ? 'NO DJ' : 'DJ OK'}
                </button>
              </td>
              {showMetadataLookup && (
                <td className="px-2 py-[5px] text-right">
                  {needsMetadataRescue(t) && (
                    <button
                      className="pxbtn px-1.5 py-[1px] text-[9px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMetadataLookup?.(t);
                      }}
                      title="Search MusicBrainz"
                    >
                      TAG
                    </button>
                  )}
                </td>
              )}
              <td className="px-2 py-[5px] text-right">
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await toggleLoveForTrack(t);
                  }}
                style={{ color: t.loved ? 'var(--accent)' : 'var(--muted)' }}
                title="Love"
              >
                {t.loved ? '★' : '☆'}
              </button>
            </td>
          </tr>
          );
        })}
      </tbody>
      </table>
    </>
  );
}

export function PlaylistAppendPicker({
  tracks,
  label,
  disabled = false,
}: {
  tracks: Track[];
  label: string;
  disabled?: boolean;
}): JSX.Element | null {
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([]);
  const [status, setStatus] = useState<string | null>(null);

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
    const trackIds = tracks.map((track) => track.id);
    const updated = await api.addTracksToPlaylist({ playlistId, trackIds });
    if (!updated) {
      setStatus('Playlist was not found.');
      return;
    }
    setPlaylists((current) =>
      current.map((playlist) => (playlist.id === updated.id ? updated : playlist)),
    );
    setStatus(`Added ${trackIds.length.toLocaleString()} tracks to ${updated.name}.`);
  }

  if (!playlists.length) return null;

  return (
    <>
      <select
        aria-label={label}
        title={label}
        value=""
        disabled={disabled || tracks.length === 0}
        onChange={(event) => {
          const playlistId = Number(event.currentTarget.value);
          if (playlistId > 0) void appendToPlaylist(playlistId);
        }}
        className="bevel-in px-2 py-1 text-[11px] outline-none"
        style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
      >
        <option value="">{label}</option>
        {playlists.map((playlist) => (
          <option key={playlist.id} value={playlist.id}>
            {playlist.name}
          </option>
        ))}
      </select>
      {status && (
        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
          {status}
        </span>
      )}
    </>
  );
}

function RatingStars({
  value,
  onChange,
}: {
  value: number;
  onChange: (rating: number) => Promise<void>;
}): JSX.Element {
  const rating = Math.max(0, Math.min(5, Math.round(value || 0)));
  return (
    <div className="inline-flex items-center justify-end gap-[1px]" role="group" aria-label="Track rating">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          className="leading-none"
          onClick={(e) => {
            e.stopPropagation();
            void onChange(rating === star ? 0 : star);
          }}
          title={`${star} star${star === 1 ? '' : 's'}`}
          style={{ color: star <= rating ? 'var(--accent)' : 'var(--muted)' }}
        >
          {star <= rating ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

function MetadataRescuePanel({
  panel,
  onClose,
  onApply,
  onManualSave,
}: {
  panel: {
    track: Track;
    candidates: MetadataLookupCandidate[];
    loading: boolean;
    status: string | null;
  };
  onClose: () => void;
  onApply: (candidate: MetadataLookupCandidate) => void;
  onManualSave: (patch: TrackMetadataPatchInput) => void;
}): JSX.Element {
  const [title, setTitle] = useState(panel.track.title);
  const [artist, setArtist] = useState(panel.track.artist);
  const [album, setAlbum] = useState(panel.track.album);
  const [albumArtist, setAlbumArtist] = useState(panel.track.albumArtist);
  const [genre, setGenre] = useState(panel.track.genre ?? '');
  const [year, setYear] = useState(panel.track.year == null ? '' : String(panel.track.year));
  const [trackNo, setTrackNo] = useState(panel.track.trackNo == null ? '' : String(panel.track.trackNo));
  const [discNo, setDiscNo] = useState(panel.track.discNo == null ? '' : String(panel.track.discNo));

  function saveManualEdit(): void {
    onManualSave({
      title,
      artist,
      album,
      albumArtist,
      genre,
      year: metadataOptionalInteger(year),
      trackNo: metadataOptionalInteger(trackNo),
      discNo: metadataOptionalInteger(discNo),
    });
  }

  return (
    <div
      className="border-b px-3 py-2"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Metadata Rescue
        </div>
        <div className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--ink-2)' }}>
          {panel.track.title} - {panel.track.artist || 'Unknown Artist'}
        </div>
        {panel.status && (
          <div className="truncate text-[10px]" style={{ color: 'var(--muted)' }}>
            {panel.status}
          </div>
        )}
        <button className="pxbtn" onClick={onClose}>
          CLOSE
        </button>
      </div>
      <div className="mb-2 grid gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--ink-2)' }}>
          Manual edit
        </div>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(136px, 1fr))' }}>
          <MetadataInput label="Title" value={title} onChange={setTitle} />
          <MetadataInput label="Artist" value={artist} onChange={setArtist} />
          <MetadataInput label="Album" value={album} onChange={setAlbum} />
          <MetadataInput label="Album artist" value={albumArtist} onChange={setAlbumArtist} />
          <MetadataInput label="Genre" value={genre} onChange={setGenre} />
          <MetadataInput label="Year" value={year} onChange={setYear} inputMode="numeric" />
          <MetadataInput label="Track" value={trackNo} onChange={setTrackNo} inputMode="numeric" />
          <MetadataInput label="Disc" value={discNo} onChange={setDiscNo} inputMode="numeric" />
        </div>
        <div className="flex justify-end">
          <button className="pxbtn is-active" onClick={saveManualEdit} disabled={!title.trim() || !artist.trim()}>
            SAVE EDITS
          </button>
        </div>
      </div>
      {panel.loading ? (
        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>Searching...</div>
      ) : panel.candidates.length ? (
        <div className="grid gap-1">
          {panel.candidates.map((candidate) => (
            <div
              key={`${candidate.recordingId}:${candidate.releaseId ?? ''}`}
              className="grid items-center gap-2 text-[11px]"
              style={{ gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 52px 72px' }}
            >
              <div className="truncate" title={candidate.title}>{candidate.title}</div>
              <div className="truncate" title={candidate.artist} style={{ color: 'var(--ink-2)' }}>
                {candidate.artist}
              </div>
              <div className="truncate" title={candidate.album} style={{ color: 'var(--ink-2)' }}>
                {candidate.album || 'Single'}
              </div>
              <div className="text-right tabular-nums" style={{ color: 'var(--muted)' }}>
                {candidate.year ?? '----'}
              </div>
              <button className="pxbtn is-active" onClick={() => onApply(candidate)}>
                APPLY
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MetadataInput({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'numeric';
}): JSX.Element {
  return (
    <label className="grid gap-1 text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--muted)' }}>
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        className="bevel-in px-2 py-1 text-[11px] normal-case tracking-[0] outline-none"
        style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
      />
    </label>
  );
}

function needsMetadataRescue(track: Track): boolean {
  return !track.album.trim() || !track.year || !track.artist.trim() || /^unknown artist$/i.test(track.artist);
}

function metadataOptionalInteger(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function readBulkMetadataPatch(input: {
  albumArtist: string;
  album: string;
  genre: string;
  year: string;
}): { value: TrackMetadataPatchInput | null; error: string | null } {
  const patch: TrackMetadataPatchInput = {};
  const albumArtist = input.albumArtist.trim();
  const album = input.album.trim();
  const genre = input.genre.trim();
  const year = input.year.trim();

  if (albumArtist) patch.albumArtist = albumArtist;
  if (album) patch.album = album;
  if (genre) patch.genre = genre;
  if (year) {
    const parsed = Number(year);
    if (!Number.isFinite(parsed)) return { value: null, error: 'Bulk year must be a number.' };
    patch.year = Math.trunc(parsed);
  }

  return Object.keys(patch).length ? { value: patch, error: null } : { value: null, error: null };
}

function selectedPlaylistDefaultName(tracks: Track[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const firstArtist = tracks.find((track) => track.artist.trim())?.artist.trim();
  return firstArtist ? `${firstArtist} Selection ${date}` : `Selected Tracks ${date}`;
}
