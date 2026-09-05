import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ListeningHistoryItem, ListeningInsights } from '@shared/types';
import { api } from '../../lib/api';
import { pushToast } from '../../lib/toast';
import { formatDuration, formatTime } from '../../lib/format';
import { usePlayerStore } from '../../store/usePlayerStore';
import { LoadMoreFooter } from './LoadMoreFooter';
import { ViewHeader } from '../ViewHeader';
import { ConfirmAction } from '../ConfirmAction';
import { ArtistLink, AlbumLink } from '../EntityLink';
import { useVirtualRows } from '../../hooks/useVirtualRows';
import { HistoryImport } from '../HistoryImport';

const HISTORY_PAGE_SIZE = 500;
// py-[5px] cell padding (10px) plus ~18px line height for the text-[12px]
// mono rows — same derivation as LibraryView's LIBRARY_ROW_HEIGHT.
const HISTORY_ROW_HEIGHT = 28;

export function HistoryView(): JSX.Element {
  const [items, setItems] = useState<ListeningHistoryItem[]>([]);
  const [insights, setInsights] = useState<ListeningInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [revision, setRevision] = useState(0);
  const [importing, setImporting] = useState(false);
  const playQueue = usePlayerStore((s) => s.playQueue);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getListeningHistory({ limit: HISTORY_PAGE_SIZE + 1, offset: 0 }),
      api.getListeningInsights(),
    ])
      .then(([rows, nextInsights]) => {
        if (!cancelled) {
          setItems(rows.slice(0, HISTORY_PAGE_SIZE));
          setInsights(nextInsights);
          setHasMoreHistory(rows.length > HISTORY_PAGE_SIZE);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setInsights(emptyListeningInsights());
          setHasMoreHistory(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const tracks = useMemo(() => items.map((item) => item.track), [items]);

  const historyWindow = useVirtualRows({
    rowCount: items.length,
    rowHeight: HISTORY_ROW_HEIGHT,
    enabled: !loading && items.length > 0,
  });

  async function clearHistory(): Promise<void> {
    const cleared = items.length;
    await api.clearListeningHistory();
    setItems([]);
    setInsights(emptyListeningInsights());
    setHasMoreHistory(false);
    pushToast({
      tone: 'ok',
      title: 'Listening history cleared',
      detail: `${cleared.toLocaleString()}${hasMoreHistory ? '+' : ''} play${cleared === 1 ? '' : 's'} removed.`,
    });
  }

  async function loadMoreHistory(): Promise<void> {
    if (loadingMore || !hasMoreHistory) return;
    setLoadingMore(true);
    try {
      const rows = await api.getListeningHistory({
        limit: HISTORY_PAGE_SIZE + 1,
        offset: items.length,
      });
      const nextRows = rows.slice(0, HISTORY_PAGE_SIZE);
      const seen = new Set(items.map((item) => item.id));
      const freshRows = nextRows.filter((item) => !seen.has(item.id));
      // Append race-safe: re-dedupe against the LATEST committed list inside the
      // functional updater so a StrictMode double-fire or two in-flight pages
      // can't both append the same rows from this stale `items` snapshot.
      setItems((currentItems) => {
        if (!freshRows.length) return currentItems;
        const have = new Set(currentItems.map((item) => item.id));
        const add = freshRows.filter((item) => !have.has(item.id));
        return add.length ? [...currentItems, ...add] : currentItems;
      });
      // Stop paging once the server returns a full page that dedupes to nothing
      // new — otherwise overlap-heavy pages trigger endless no-op loads.
      setHasMoreHistory(rows.length > HISTORY_PAGE_SIZE && freshRows.length > 0);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex h-full flex-col" style={{ fontFamily: 'var(--font-mono)' }}>
      {/* Reference ViewHeader implementation — stage 2 rolls this voice out
          to the other views. */}
      <ViewHeader
        eyebrow="Yours"
        title="Listening History"
        count={`${items.length.toLocaleString()}${hasMoreHistory ? '+' : ''} play${items.length === 1 ? '' : 's'}`}
        actions={
          <>
            <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)} disabled={!tracks.length}>
              PLAY FROM TOP
            </button>
            <ConfirmAction
              label="CLEAR"
              confirmLabel="SURE?"
              tone="error"
              disabled={!items.length || importing}
              title="Erase all listening history"
              onConfirm={() => void clearHistory()}
            />
          </>
        }
      />
      <HistoryImport onImported={() => setRevision((current) => current + 1)} onBusy={setImporting} />
      {insights && insights.total.plays > 0 && <HistoryInsights insights={insights} />}
      <div className="flex-1 overflow-auto" ref={historyWindow.scrollRef} onScroll={historyWindow.onScroll}>
        {loading ? (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading...
          </div>
        ) : items.length ? (
          <>
            <HistoryTable
              items={items}
              onPlay={(index) => void playQueue(tracks, index)}
              virtualWindow={historyWindow}
            />
            <LoadMoreFooter
              shown={items.length}
              noun="recent plays"
              hasMore={hasMoreHistory}
              loading={loadingMore}
              loadLabel="Load more history"
              onLoadMore={() => void loadMoreHistory()}
            />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            No listening history yet.
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryInsights({ insights }: { insights: ListeningInsights }): JSX.Element {
  return (
    <div
      data-newamp-history-insights
      className="grid gap-3 border-b px-3 py-2 text-[11px]"
      style={{
        borderColor: 'var(--line)',
        background: 'var(--panel)',
        gridTemplateColumns: 'minmax(180px,0.8fr) minmax(180px,1fr) minmax(180px,1fr) minmax(170px,0.9fr)',
      }}
    >
      <div className="min-w-0">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Listening Insights
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums" style={{ color: 'var(--ink-2)' }}>
          <span>All time</span><span className="text-right">{formatPlays(insights.total.plays)}</span>
          <span>Skips</span><span className="text-right">{formatSkips(insights.total.skips)}</span>
          <span>Unique</span><span className="text-right">{insights.total.uniqueTracks.toLocaleString()}</span>
          <span>Skipped tracks</span><span className="text-right">{insights.total.uniqueSkippedTracks.toLocaleString()}</span>
          <span>Today</span><span className="text-right">{formatPlays(insights.today.plays)}</span>
          <span>7 days</span><span className="text-right">{formatPlays(insights.week.plays)}</span>
        </div>
        <div className="mt-2 flex justify-between gap-2 tabular-nums" style={{ color: 'var(--muted)' }}>
          <span>{formatDuration(insights.today.duration)} / {formatSkips(insights.today.skips)} today</span>
          <span>{formatDuration(insights.week.duration)} / {formatSkips(insights.week.skips)} week</span>
        </div>
      </div>
      <InsightList
        title="Top Artists"
        emptyLabel="No artist data."
        items={insights.topArtists.slice(0, 4).map((item) => ({
          key: item.artist,
          primary: <ArtistLink artist={item.artist} color="inherit" />,
          primaryTitle: item.artist,
          secondary: formatDuration(item.duration),
          plays: item.plays,
          skips: item.skips,
        }))}
      />
      <InsightList
        title="Top Albums"
        emptyLabel="No album data."
        items={insights.topAlbums.slice(0, 4).map((item) => ({
          key: `${item.albumArtist}:${item.album}`,
          primary: <AlbumLink album={item.album} albumArtist={item.albumArtist} color="inherit" />,
          primaryTitle: item.album,
          secondary: <ArtistLink artist={item.albumArtist} color="inherit" />,
          secondaryTitle: item.albumArtist,
          plays: item.plays,
          skips: item.skips,
        }))}
      />
      <InsightList
        title="Recent Days"
        emptyLabel="No recent activity."
        items={insights.recentDays.slice(0, 4).map((item) => ({
          key: item.date,
          primary: formatHistoryDay(item.date),
          secondary: formatDuration(item.duration),
          plays: item.plays,
          skips: item.skips,
        }))}
      />
    </div>
  );
}

function InsightList({
  title,
  emptyLabel,
  items,
}: {
  title: string;
  emptyLabel: string;
  items: Array<{
    key: string;
    primary: ReactNode;
    primaryTitle?: string;
    secondary: ReactNode;
    secondaryTitle?: string;
    plays: number;
    skips: number;
  }>;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-2)' }}>
        {title}
      </div>
      {items.length ? (
        <div className="mt-1 grid gap-[2px]">
          {items.map((item) => (
            <div key={item.key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
              <div className="min-w-0">
                <div
                  className="truncate"
                  title={item.primaryTitle ?? (typeof item.primary === 'string' ? item.primary : undefined)}
                >
                  {item.primary}
                </div>
                <div
                  className="truncate text-[10px]"
                  title={item.secondaryTitle ?? (typeof item.secondary === 'string' ? item.secondary : undefined)}
                  style={{ color: 'var(--muted)' }}
                >
                  {item.secondary}
                </div>
              </div>
              <div className="text-right tabular-nums" style={{ color: 'var(--accent)' }}>
                <div>{formatPlays(item.plays)}</div>
                {item.skips > 0 && (
                  <div className="text-[10px]" style={{ color: 'var(--muted)' }}>{formatSkips(item.skips)}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1" style={{ color: 'var(--muted)' }}>{emptyLabel}</div>
      )}
    </div>
  );
}

function HistoryTable({
  items,
  onPlay,
  virtualWindow,
}: {
  items: ListeningHistoryItem[];
  onPlay: (index: number) => void;
  virtualWindow: { startIndex: number; endIndex: number; topPad: number; bottomPad: number };
}): JSX.Element {
  const { startIndex, endIndex, topPad, bottomPad } = virtualWindow;
  const COLS = 6;
  return (
    <table
      className="w-full table-fixed text-[12px]"
      style={{ fontFamily: 'var(--font-mono)', borderCollapse: 'separate', borderSpacing: 0 }}
    >
      <thead className="sticky top-0 z-10" style={{ background: 'var(--panel)', color: 'var(--ink-2)' }}>
        <tr className="text-left text-[9px] uppercase tracking-[0.12em]">
          <th className="w-[150px] px-2 py-[6px]">Played</th>
          <th className="px-2 py-[6px]">Title</th>
          <th className="w-[22%] px-2 py-[6px]">Artist</th>
          <th className="w-[22%] px-2 py-[6px]">Album</th>
          <th className="w-[62px] px-2 py-[6px] text-right tabular-nums">Time</th>
          <th className="w-[56px] px-2 py-[6px] text-right tabular-nums">Plays</th>
        </tr>
      </thead>
      <tbody>
        {topPad > 0 && (
          <tr aria-hidden><td colSpan={COLS} style={{ height: topPad, padding: 0, border: 0 }} /></tr>
        )}
        {items.slice(startIndex, endIndex + 1).map((item, sliceIdx) => {
          const index = startIndex + sliceIdx;
          const track = item.track;
          const zebra = index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)';
          return (
            <tr
              key={item.id}
              className="cursor-pointer transition-colors"
              style={{ background: zebra, color: 'var(--ink)' }}
              onDoubleClick={() => onPlay(index)}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--panel-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = zebra)}
            >
              <td className="px-2 py-[5px] tabular-nums" style={{ color: 'var(--muted)' }}>
                {formatPlayedAt(item.playedAt)}
              </td>
              <td className="truncate px-2 py-[5px]" title={track.title}>{track.title}</td>
              <td className="truncate px-2 py-[5px]" title={track.artist} style={{ color: 'var(--ink-2)' }}>
                <ArtistLink artist={track.artist} color="inherit" />
              </td>
              <td className="truncate px-2 py-[5px]" title={track.album} style={{ color: 'var(--ink-2)' }}>
                <AlbumLink album={track.album} albumArtist={track.albumArtist || track.artist} color="inherit" />
              </td>
              <td className="px-2 py-[5px] text-right tabular-nums" style={{ color: 'var(--ink-2)' }}>
                {formatTime(track.duration ?? 0)}
              </td>
              <td className="px-2 py-[5px] text-right tabular-nums" style={{ color: 'var(--muted)' }}>
                {track.playCount ? track.playCount.toLocaleString() : ''}
              </td>
            </tr>
          );
        })}
        {bottomPad > 0 && (
          <tr aria-hidden><td colSpan={COLS} style={{ height: bottomPad, padding: 0, border: 0 }} /></tr>
        )}
      </tbody>
    </table>
  );
}

function formatPlayedAt(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatHistoryDay(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
  });
}

function formatPlays(value: number): string {
  return `${value.toLocaleString()} play${value === 1 ? '' : 's'}`;
}

function formatSkips(value: number): string {
  return `${value.toLocaleString()} skip${value === 1 ? '' : 's'}`;
}

function emptyListeningInsights(): ListeningInsights {
  return {
    generatedAt: Date.now(),
    total: {
      plays: 0,
      duration: 0,
      skips: 0,
      uniqueTracks: 0,
      uniqueSkippedTracks: 0,
      firstPlayedAt: null,
      lastPlayedAt: null,
      lastSkippedAt: null,
    },
    today: { plays: 0, duration: 0, skips: 0 },
    week: { plays: 0, duration: 0, skips: 0 },
    topArtists: [],
    topAlbums: [],
    recentDays: [],
  };
}
