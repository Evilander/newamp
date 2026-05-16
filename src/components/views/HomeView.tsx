import { useEffect, useMemo, useState } from 'react';
import type { LibraryHealth, ListeningHistoryItem, ListeningInsights, SavedPlaylist, SmartPlaylistRule, SmartPlaylistSuggestion, Track } from '@shared/types';
import { api } from '../../lib/api';
import { formatDuration, formatNumber, formatTime } from '../../lib/format';
import { usePlayerStore } from '../../store/usePlayerStore';
import { HeideckerLogo } from '../HeideckerLogo';

interface HomeData {
  stats: { tracks: number; albums: number; artists: number; duration: number };
  health: LibraryHealth | null;
  insights: ListeningInsights;
  fresh: Track[];
  loved: Track[];
  history: ListeningHistoryItem[];
  heavy: Track[];
  harmonic: Track[];
  taste: Track[];
  rated: Track[];
  playlists: SavedPlaylist[];
  smartRules: SmartPlaylistRule[];
  suggestedStations: SmartPlaylistSuggestion[];
}

const EMPTY_INSIGHTS: ListeningInsights = {
  generatedAt: 0,
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

const EMPTY_DATA: HomeData = {
  stats: { tracks: 0, albums: 0, artists: 0, duration: 0 },
  health: null,
  insights: EMPTY_INSIGHTS,
  fresh: [],
  loved: [],
  history: [],
  heavy: [],
  harmonic: [],
  taste: [],
  rated: [],
  playlists: [],
  smartRules: [],
  suggestedStations: [],
};

const HOME_LIMIT = 12;

export function HomeView(): JSX.Element {
  const [data, setData] = useState<HomeData>(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const autoDjEnabled = usePlayerStore((s) => s.autoDjEnabled);
  const autoDjTarget = usePlayerStore((s) => s.autoDjTarget);
  const autoDjSmartRuleId = usePlayerStore((s) => s.autoDjSmartRuleId);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const setAutoDjEnabled = usePlayerStore((s) => s.setAutoDjEnabled);
  const setAutoDjSmartRuleId = usePlayerStore((s) => s.setAutoDjSmartRuleId);
  const setView = usePlayerStore((s) => s.setView);

  useEffect(() => {
    void refreshHome();
  }, [current?.id]);

  const recentTracks = useMemo(() => {
    const seen = new Set<number>();
    return data.history
      .map((item) => item.track)
      .filter((track) => {
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
      });
  }, [data.history]);

  const missingTotal = data.health
    ? data.health.missing.artist +
      data.health.missing.album +
      data.health.missing.year +
      data.health.missing.art +
      data.health.missing.duration
    : 0;
  const activeStationName = autoDjEnabled
    ? autoDjSmartRuleId
      ? data.smartRules.find((rule) => rule.id === autoDjSmartRuleId)?.name ?? `Smart Rule #${autoDjSmartRuleId}`
      : 'Harmonic Mix'
    : null;
  const todayPick = useMemo(
    () => pickToday(data.rated, recentTracks, current?.id ?? null),
    [current?.id, data.rated, recentTracks],
  );
  const newestFreshDate = data.fresh[0]?.mtime ? formatYmd(data.fresh[0].mtime) : null;

  async function refreshHome(): Promise<void> {
    setLoading(true);
    setStatus(null);
    try {
      const [stats, health, insights, fresh, loved, history, heavy, harmonic, taste, rated, playlists, smartRules, suggestedStations] = await Promise.all([
        api.getStats(),
        api.getLibraryHealth(),
        api.getListeningInsights({}),
        api.getTracks({ sort: 'added', limit: HOME_LIMIT, offset: 0 }),
        api.getTracks({ sort: 'loved', limit: HOME_LIMIT, offset: 0 }),
        api.getListeningHistory({ limit: 30, offset: 0 }),
        api.getTracks({ sort: 'plays', limit: HOME_LIMIT, offset: 0 }),
        api.buildHarmonicMix({ seedTrackId: current?.id ?? null, count: HOME_LIMIT }),
        api.buildTasteMix({ seedTrackId: current?.id ?? null, count: HOME_LIMIT }),
        api.getTracks({ sort: 'rating', limit: HOME_LIMIT, offset: 0 }),
        api.getPlaylists(),
        api.getSmartPlaylistRules(),
        api.getSuggestedSmartPlaylistRules(),
      ]);
      setData({
        stats,
        health,
        insights,
        fresh,
        loved,
        history,
        heavy,
        harmonic,
        taste,
        rated,
        playlists: playlists.slice(0, 8),
        smartRules: smartRules.slice(0, 6),
        suggestedStations: suggestedStations.slice(0, 6),
      });
    } finally {
      setLoading(false);
    }
  }

  async function saveSet(name: string, tracks: Track[]): Promise<void> {
    if (!tracks.length) return;
    const date = new Date().toISOString().slice(0, 10);
    const playlist = await api.savePlaylist({
      name: `${name} ${date}`,
      trackIds: tracks.map((track) => track.id),
    });
    setStatus(`Saved ${playlist.name} with ${playlist.trackCount.toLocaleString()} tracks.`);
    void refreshHome();
  }

  async function playSavedPlaylist(playlist: SavedPlaylist): Promise<void> {
    const tracks = await api.getPlaylistTracks(playlist.id);
    if (!tracks.length) {
      setStatus(`${playlist.name} has no playable tracks.`);
      return;
    }
    await playQueue(tracks, 0);
  }

  async function playSmartRule(rule: SmartPlaylistRule): Promise<void> {
    const tracks = await api.runSmartPlaylistRule(rule.id);
    if (!tracks.length) {
      setStatus(`${rule.name} generated no playable tracks.`);
      return;
    }
    await playQueue(tracks, 0);
  }

  async function startSmartRuleRadio(rule: SmartPlaylistRule): Promise<void> {
    const tracks = await api.runSmartPlaylistRule(rule.id);
    if (!tracks.length) {
      setStatus(`${rule.name} generated no playable tracks.`);
      return;
    }
    await playQueue(tracks, 0);
    await setAutoDjSmartRuleId(rule.id);
    await setAutoDjEnabled(true);
    setStatus(`Smart Rule Radio started from ${rule.name}.`);
  }

  async function startSuggestedStation(suggestion: SmartPlaylistSuggestion): Promise<void> {
    const existing = data.smartRules.find((rule) => sameSmartRule(rule, suggestion.rule));
    const rule = existing ?? await api.saveSmartPlaylistRule(suggestion.rule);
    const tracks = await api.runSmartPlaylistRule(rule.id);
    if (!tracks.length) {
      setStatus(`${suggestion.title} generated no playable tracks.`);
      return;
    }
    await playQueue(tracks, 0);
    await setAutoDjSmartRuleId(rule.id);
    await setAutoDjEnabled(true);
    setStatus(`Station started: ${rule.name}.`);
    if (!existing) void refreshHome();
  }

  async function stopStation(): Promise<void> {
    await setAutoDjEnabled(false);
    await setAutoDjSmartRuleId(null);
    setStatus('Station stopped. Current queue stays loaded.');
  }

  return (
    <div className="flex h-full flex-col" style={{ fontFamily: 'var(--font-mono)' }}>
      <div className="flex items-center gap-3 border-b px-3 py-2" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
        <div className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--accent)' }}>
          Home
        </div>
        <div className="text-[11px] tabular-nums" style={{ color: 'var(--ink-2)' }}>
          {formatNumber(data.stats.tracks)} tracks / {formatNumber(data.stats.albums)} albums / {formatNumber(data.stats.artists)} artists
        </div>
        {status && <div className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }}>{status}</div>}
        <button className="pxbtn ml-auto" onClick={() => void refreshHome()} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {data.stats.tracks === 0 && !loading ? (
          <div className="bevel-in flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-[14px] font-bold">No library scanned yet.</div>
            <div className="max-w-[520px] text-[12px]" style={{ color: 'var(--ink-2)' }}>
              Scan your music folder, then Home becomes the command center for fresh imports, mixes, history, playlists, and library health.
            </div>
            <div className="flex gap-2">
              <button className="pxbtn is-active" onClick={() => void api.scanLibrary()}>
                SCAN DEFAULT LIBRARY
              </button>
              <button className="pxbtn" onClick={() => setView('settings')}>
                SETTINGS
              </button>
            </div>
          </div>
        ) : (
          <div className="home-magazine flex flex-col gap-3">
            <HomeHero
              current={current}
              currentTime={currentTime}
              duration={duration}
              isPlaying={isPlaying}
              queueLength={queue.length}
              queueRemaining={Math.max(0, queue.length - Math.max(index, 0) - 1)}
              stationName={activeStationName}
              stationTarget={autoDjTarget}
              stats={data.stats}
              todayPick={todayPick}
              onTogglePlay={togglePlay}
              onNowPlaying={() => setView('now-playing')}
              onQueue={() => setView('playlist')}
              onStopStation={() => void stopStation()}
              onPlayPick={(track) => void playQueue([track], 0)}
            />

            <div className="grid gap-3 lg:grid-cols-[1.4fr_0.78fr_0.72fr]">
              <RatedHighlightRail
                tracks={data.rated}
                onPlay={(start) => void playQueue(data.rated, start)}
                onNext={() => queueTracksNext(data.rated)}
                onQueue={() => addTracksToQueue(data.rated)}
                onAction={() => void saveSet('Top Rated', data.rated)}
              />
              <NewsCard fresh={data.fresh} loved={data.loved} top={data.rated[0] ?? null} />
              <ListeningStatsPanel insights={data.insights} history={data.history} />
            </div>

            <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.7fr)]">
              <div className="flex min-w-0 flex-col gap-3">
                <HomeRail
                  title={current ? 'Harmonic From Now' : 'Harmonic Library Mix'}
                  subtitle={current ? `Seeded by ${current.artist} — ${current.title}` : 'BPM/key-aware sequence from the catalog'}
                  tracks={data.harmonic}
                  actionLabel="SAVE MIX"
                  onPlay={(start) => void playQueue(data.harmonic, start)}
                  onNext={() => queueTracksNext(data.harmonic)}
                  onQueue={() => addTracksToQueue(data.harmonic)}
                  onAction={() => void saveSet('Home Harmonic Mix', data.harmonic)}
                />

                <HomeRail
                  title="Taste Match"
                  subtitle="Learns from plays, loves, ratings, and skips"
                  tracks={data.taste}
                  actionLabel="SAVE TASTE"
                  onPlay={(start) => void playQueue(data.taste, start)}
                  onNext={() => queueTracksNext(data.taste)}
                  onQueue={() => addTracksToQueue(data.taste)}
                  onAction={() => void saveSet('Taste Match', data.taste)}
                />

                <div className="grid gap-3 lg:grid-cols-2">
                  <HomeRail
                    title="Fresh Imports"
                    subtitle={newestFreshDate ? `Newest: ${newestFreshDate}` : 'Newest files NewAmp has seen on disk'}
                    tracks={data.fresh}
                    compact
                    actionLabel="SAVE FRESH"
                    onPlay={(start) => void playQueue(data.fresh, start)}
                    onNext={() => queueTracksNext(data.fresh)}
                    onQueue={() => addTracksToQueue(data.fresh)}
                    onAction={() => void saveSet('Fresh Imports', data.fresh)}
                  />
                  <HomeRail
                    title="Heavy Rotation"
                    subtitle={data.heavy.length ? 'Tracks with the most NewAmp plays' : 'Appears after NewAmp records plays'}
                    tracks={data.heavy}
                    compact
                    onPlay={(start) => void playQueue(data.heavy, start)}
                    onNext={() => queueTracksNext(data.heavy)}
                    onQueue={() => addTracksToQueue(data.heavy)}
                  />
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <HomeRail
                    title="Recently Played"
                    subtitle={recentTracks.length ? 'Pick up a listening thread' : 'Appears after playback history exists'}
                    tracks={recentTracks}
                    compact
                    onPlay={(start) => void playQueue(recentTracks, start)}
                    onNext={() => queueTracksNext(recentTracks)}
                    onQueue={() => addTracksToQueue(recentTracks)}
                  />
                  <HomeRail
                    title="Loved Signal"
                    subtitle="Your strongest manual taste signal"
                    tracks={data.loved}
                    compact
                    actionLabel="SAVE LOVED"
                    onPlay={(start) => void playQueue(data.loved, start)}
                    onNext={() => queueTracksNext(data.loved)}
                    onQueue={() => addTracksToQueue(data.loved)}
                    onAction={() => void saveSet('Loved Signal', data.loved)}
                  />
                </div>
              </div>

              <div className="flex min-w-0 flex-col gap-3">
                <HealthPanel
                  missingTotal={missingTotal}
                  duplicateCount={data.health?.duplicateGroups.length ?? 0}
                  legacyCount={data.health?.legacyFormats.reduce((sum, item) => sum + item.count, 0) ?? 0}
                  onOpenLibrary={() => setView('library')}
                />

                <SuggestedStationsPanel
                  suggestions={data.suggestedStations}
                  onRadio={(suggestion) => void startSuggestedStation(suggestion)}
                />

                <PlaylistPanel
                  playlists={data.playlists}
                  smartRules={data.smartRules}
                  onPlay={(playlist) => void playSavedPlaylist(playlist)}
                  onPlaySmartRule={(rule) => void playSmartRule(rule)}
                  onSmartRuleRadio={(rule) => void startSmartRuleRadio(rule)}
                  onOpen={() => setView('playlist')}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SuggestedStationsPanel({
  suggestions,
  onRadio,
}: {
  suggestions: SmartPlaylistSuggestion[];
  onRadio: (suggestion: SmartPlaylistSuggestion) => void;
}): JSX.Element {
  return (
    <section className="bevel-out p-3" style={{ background: 'var(--panel)' }}>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
          Suggested Stations
        </div>
        <span className="ml-auto text-[10px] uppercase tracking-[0.1em]" style={{ color: 'var(--muted)' }}>
          Library-built
        </span>
      </div>
      {suggestions.length ? (
        <div className="flex flex-col gap-1">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="bevel-in grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-2 py-2 text-left text-[11px]"
              onClick={() => onRadio(suggestion)}
              title={suggestion.reason}
            >
              <span className="min-w-0">
                <span className="block truncate">{suggestion.title}</span>
                <span className="block truncate text-[10px]" style={{ color: 'var(--muted)' }}>
                  {suggestion.subtitle} / {suggestion.sampleCount.toLocaleString()} ready
                </span>
              </span>
              <span className="self-center tabular-nums" style={{ color: 'var(--accent)' }}>
                RADIO
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="bevel-in px-3 py-4 text-[11px]" style={{ color: 'var(--muted)' }}>
          Suggested stations appear after Newamp sees genre, year, loved, rating, or play-count signals.
        </div>
      )}
    </section>
  );
}

function NowPanel({
  current,
  currentTime,
  duration,
  isPlaying,
  queueLength,
  queueRemaining,
  stationName,
  stationTarget,
  onTogglePlay,
  onNowPlaying,
  onQueue,
  onStopStation,
}: {
  current: Track | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  queueLength: number;
  queueRemaining: number;
  stationName: string | null;
  stationTarget: number;
  onTogglePlay: () => void;
  onNowPlaying: () => void;
  onQueue: () => void;
  onStopStation: () => void;
}): JSX.Element {
  const progress = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  return (
    <section className="bevel-out p-3" style={{ background: 'var(--panel)' }}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>
            Continue
          </div>
          <div className="truncate text-[18px] font-bold">{current ? current.title : 'Nothing loaded'}</div>
          <div className="truncate text-[12px]" style={{ color: 'var(--ink-2)' }}>
            {current ? `${current.artist} / ${current.album || 'Unknown album'}` : 'Start from a mix, playlist, folder, or search.'}
          </div>
          <div className="mt-3 h-2 overflow-hidden bevel-in" style={{ background: 'var(--display-bg)' }}>
            <div className="h-full" style={{ width: `${progress}%`, background: 'var(--accent)' }} />
          </div>
          <div className="mt-1 flex text-[10px] tabular-nums" style={{ color: 'var(--muted)' }}>
            <span>{formatTime(currentTime)}</span>
            <span className="ml-auto">{formatTime(duration)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button className="pxbtn is-active" onClick={onTogglePlay} disabled={!current}>
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </button>
          <button className="pxbtn" onClick={onNowPlaying} disabled={!current}>
            NOW PLAYING
          </button>
          <button className="pxbtn" onClick={onQueue} disabled={!queueLength}>
            QUEUE {queueLength ? `(${queueRemaining})` : ''}
          </button>
        </div>
      </div>
      {stationName ? (
        <div
          className="mt-3 flex items-center gap-2 border-t pt-2 text-[11px]"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
        >
          <span className="font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
            Station Active
          </span>
          <span className="min-w-0 flex-1 truncate">{stationName} / target {stationTarget}</span>
          <button className="pxbtn px-2 py-[2px] text-[10px]" onClick={onStopStation}>
            STOP RADIO
          </button>
        </div>
      ) : null}
    </section>
  );
}

function HealthPanel({
  missingTotal,
  duplicateCount,
  legacyCount,
  onOpenLibrary,
}: {
  missingTotal: number;
  duplicateCount: number;
  legacyCount: number;
  onOpenLibrary: () => void;
}): JSX.Element {
  return (
    <section className="bevel-out p-3" style={{ background: 'var(--panel)' }}>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
          Library Health
        </div>
        <button className="pxbtn ml-auto" onClick={onOpenLibrary}>
          OPEN
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Metric label="Missing" value={missingTotal} />
        <Metric label="Duplicates" value={duplicateCount} />
        <Metric label="Legacy" value={legacyCount} />
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="bevel-in px-2 py-2">
      <div className="lcd-text text-[18px] leading-none" style={{ color: value ? 'var(--warn)' : 'var(--accent)' }}>
        {value.toLocaleString()}
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-[0.1em]" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
    </div>
  );
}

function HomeRail({
  title,
  subtitle,
  tracks,
  actionLabel,
  compact = false,
  onPlay,
  onNext,
  onQueue,
  onAction,
}: {
  title: string;
  subtitle: string;
  tracks: Track[];
  actionLabel?: string;
  compact?: boolean;
  onPlay: (startIndex: number) => void;
  onNext: () => void;
  onQueue: () => void;
  onAction?: () => void;
}): JSX.Element {
  const totalDuration = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
  const rows = tracks.slice(0, compact ? 5 : 7);
  return (
    <section className="bevel-out p-3" style={{ background: 'var(--panel)' }}>
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold">{title}</div>
          <div className="truncate text-[10px]" style={{ color: 'var(--ink-2)' }}>
            {subtitle}
          </div>
        </div>
        <div className="text-right text-[10px] tabular-nums" style={{ color: 'var(--muted)' }}>
          <div>{tracks.length.toLocaleString()} tracks</div>
          <div>{formatDuration(totalDuration)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 pb-2">
        <button className="pxbtn is-active" onClick={() => onPlay(0)} disabled={!tracks.length}>
          PLAY
        </button>
        <button className="pxbtn" onClick={onNext} disabled={!tracks.length}>
          NEXT
        </button>
        <button className="pxbtn" onClick={onQueue} disabled={!tracks.length}>
          QUEUE
        </button>
        {actionLabel && (
          <button className="pxbtn" onClick={onAction} disabled={!tracks.length}>
            {actionLabel}
          </button>
        )}
      </div>
      {rows.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          {rows.map((track, index) => (
            <button
              key={`${track.id}-${index}`}
              className="grid w-full grid-cols-[minmax(0,1fr)_46px] gap-2 px-1 py-[5px] text-left text-[11px]"
              style={{ color: 'var(--ink)' }}
              onClick={() => onPlay(index)}
              title={`${track.artist} - ${track.title}`}
            >
              <span className="min-w-0">
                <span className="block truncate">{track.title}</span>
                <span className="block truncate text-[10px]" style={{ color: 'var(--muted)' }}>
                  {track.artist}
                </span>
              </span>
              <span className="self-center text-right tabular-nums" style={{ color: 'var(--ink-2)' }}>
                {formatTime(track.duration ?? 0)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="bevel-in px-3 py-4 text-[11px]" style={{ color: 'var(--muted)' }}>
          No tracks available yet.
        </div>
      )}
    </section>
  );
}

function PlaylistPanel({
  playlists,
  smartRules,
  onPlay,
  onPlaySmartRule,
  onSmartRuleRadio,
  onOpen,
}: {
  playlists: SavedPlaylist[];
  smartRules: SmartPlaylistRule[];
  onPlay: (playlist: SavedPlaylist) => void;
  onPlaySmartRule: (rule: SmartPlaylistRule) => void;
  onSmartRuleRadio: (rule: SmartPlaylistRule) => void;
  onOpen: () => void;
}): JSX.Element {
  return (
    <section className="bevel-out p-3" style={{ background: 'var(--panel)' }}>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
          Playlists
        </div>
        <button className="pxbtn ml-auto" onClick={onOpen}>
          OPEN
        </button>
      </div>
      {playlists.length || smartRules.length ? (
        <div className="flex flex-col gap-1">
          {playlists.map((playlist) => (
            <button
              key={playlist.id}
              className="bevel-in grid grid-cols-[36px_minmax(0,1fr)_auto] gap-2 px-2 py-2 text-left text-[11px]"
              onClick={() => onPlay(playlist)}
              title={playlist.trackCount ? `Play ${playlist.name}` : `${playlist.name} is empty`}
            >
              <span
                className="flex h-9 w-9 items-center justify-center overflow-hidden border text-[10px] font-bold"
                style={{ borderColor: 'var(--line)', background: 'var(--panel-2)', color: 'var(--muted)' }}
              >
                {playlist.hasCoverArt ? (
                  <img
                    src={api.getPlaylistCoverUrl(playlist.id, playlist.coverArtUpdatedAt)}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  'PL'
                )}
              </span>
              <span className="min-w-0 self-center">
                <span className="block truncate">{playlist.name}</span>
                <span className="block truncate text-[10px]" style={{ color: 'var(--muted)' }}>
                  {playlist.trackCount.toLocaleString()} tracks / {formatDuration(playlist.duration)}
                </span>
              </span>
              <span className="self-center tabular-nums" style={{ color: playlist.trackCount ? 'var(--accent)' : 'var(--muted)' }}>
                {playlist.trackCount ? 'PLAY' : 'EMPTY'}
              </span>
            </button>
          ))}
          {smartRules.map((rule) => (
            <div
              key={rule.id}
              className="bevel-in grid grid-cols-[36px_minmax(0,1fr)_auto] gap-2 px-2 py-2 text-left text-[11px]"
            >
              <span
                className="flex h-9 w-9 items-center justify-center overflow-hidden border text-[9px] font-bold"
                style={{ borderColor: 'var(--line)', background: 'var(--panel-2)', color: 'var(--accent)' }}
              >
                AUTO
              </span>
              <button
                type="button"
                className="min-w-0 self-center text-left"
                onClick={() => onPlaySmartRule(rule)}
                title={`Generate ${rule.name}`}
              >
                <span className="block truncate">{rule.name}</span>
                <span className="block truncate text-[10px]" style={{ color: 'var(--muted)' }}>
                  {smartRuleSummary(rule)}
                </span>
              </button>
              <span className="flex items-center gap-1 self-center">
                <button className="pxbtn px-1.5 py-[2px] text-[10px]" onClick={() => onPlaySmartRule(rule)}>
                  SMART
                </button>
                <button className="pxbtn is-active px-1.5 py-[2px] text-[10px]" onClick={() => onSmartRuleRadio(rule)}>
                  RADIO
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="bevel-in px-3 py-4 text-[11px]" style={{ color: 'var(--muted)' }}>
          Saved mixes, smart rules, and custom playlists appear here.
        </div>
      )}
    </section>
  );
}

function HomeHero({
  current,
  currentTime,
  duration,
  isPlaying,
  queueLength,
  queueRemaining,
  stationName,
  stationTarget,
  stats,
  todayPick,
  onTogglePlay,
  onNowPlaying,
  onQueue,
  onStopStation,
  onPlayPick,
}: {
  current: Track | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  queueLength: number;
  queueRemaining: number;
  stationName: string | null;
  stationTarget: number;
  stats: { tracks: number; albums: number; artists: number; duration: number };
  todayPick: TodayPick | null;
  onTogglePlay: () => void;
  onNowPlaying: () => void;
  onQueue: () => void;
  onStopStation: () => void;
  onPlayPick: (track: Track) => void;
}): JSX.Element {
  const progress = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  const heroArt = current?.hasArt ? api.getArtUrl(current.id) : null;
  const topRatedSeed = todayPick?.track ?? null;
  const pickArt = topRatedSeed?.hasArt ? api.getArtUrl(topRatedSeed.id) : null;
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 5) return 'Late shift';
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Afternoon set';
    if (hour < 21) return 'Evening rotation';
    return 'After hours';
  }, []);
  return (
    <section className="home-hero" data-cell="HOME-01">
      {heroArt ? (
        <div
          className="home-hero-bg"
          style={{ backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0.92)), url(${JSON.stringify(heroArt)})` }}
          aria-hidden="true"
        />
      ) : (
        <div className="home-hero-bg home-hero-bg-empty" aria-hidden="true" />
      )}
      <div className="home-hero-content">
        <div className="home-hero-meta">
          <HeideckerLogo size={38} withGlow={false} />
          <div className="home-hero-meta-text">
            <span className="home-hero-greet">{greeting}</span>
            <span className="home-hero-sub">
              {formatNumber(stats.tracks)} tracks · {formatNumber(stats.albums)} albums · {formatNumber(stats.artists)} artists
            </span>
          </div>
          {stationName ? (
            <div className="home-hero-station">
              <span className="home-hero-station-tag">ON AIR</span>
              <span className="home-hero-station-name">{stationName}</span>
              <button className="pxbtn" onClick={onStopStation}>STOP</button>
              <span className="home-hero-station-target">target {stationTarget}</span>
            </div>
          ) : null}
        </div>

        <div className="home-hero-now">
          <div className="home-hero-art">
            {heroArt ? (
              <img src={heroArt} alt={current?.album ?? ''} draggable={false} />
            ) : (
              <span className="home-hero-art-empty">{current ? '♪' : 'NEW'}</span>
            )}
          </div>
          <div className="home-hero-track">
            <span className="home-hero-eyebrow">{current ? 'Continue listening' : 'Nothing loaded'}</span>
            <h1 className="home-hero-title">
              {current ? current.title : 'NewAmp · ready when you are'}
            </h1>
            <p className="home-hero-credits">
              {current ? `${current.artist} / ${current.album || 'Unknown album'}` : 'Drop a folder, pick a playlist, or pop into the Library.'}
            </p>
            <div className="home-hero-progress">
              <div className="home-hero-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="home-hero-progress-meta">
              <span>{formatTime(currentTime)}</span>
              <span className="home-hero-progress-stat">
                {queueLength ? `${queueRemaining} left in queue` : 'no queue · build one from a rail below'}
              </span>
              <span>{formatTime(duration)}</span>
            </div>
            <div className="home-hero-actions">
              <button className="pxbtn is-active" onClick={onTogglePlay} disabled={!current}>
                {isPlaying ? 'PAUSE' : 'PLAY'}
              </button>
              <button className="pxbtn" onClick={onNowPlaying} disabled={!current}>
                NOW PLAYING
              </button>
              <button className="pxbtn" onClick={onQueue} disabled={!queueLength}>
                QUEUE
              </button>
            </div>
          </div>

          {topRatedSeed ? (
            <button
              type="button"
              className="home-hero-pick"
              onClick={() => onPlayPick(topRatedSeed)}
              title={`Today's pick: ${topRatedSeed.artist} — ${topRatedSeed.title}`}
            >
              <span className="home-hero-pick-tag">Today&rsquo;s Pick</span>
              <div className="home-hero-pick-art">
                {pickArt ? (
                  <img src={pickArt} alt={topRatedSeed.album ?? ''} draggable={false} />
                ) : (
                  <span>♪</span>
                )}
              </div>
              <span className="home-hero-pick-title">{topRatedSeed.title}</span>
              <span className="home-hero-pick-artist">{topRatedSeed.artist}</span>
              <span className="home-hero-pick-score">
                {topRatedSeed.ratingScore != null
                  ? `${topRatedSeed.ratingScore.toFixed(1)} / 100`
                  : `${topRatedSeed.rating}/5`}
              </span>
              <span className="home-hero-pick-reason">Why this pick? {todayPick?.reason}</span>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function RatedHighlightRail({
  tracks,
  onPlay,
  onNext,
  onQueue,
  onAction,
}: {
  tracks: Track[];
  onPlay: (startIndex: number) => void;
  onNext: () => void;
  onQueue: () => void;
  onAction: () => void;
}): JSX.Element {
  const visible = tracks.slice(0, 8);
  return (
    <section className="bevel-out home-rated p-3" data-cell="RATE-02" style={{ background: 'var(--panel)' }}>
      <div className="mb-3 flex items-baseline gap-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--accent)' }}>
          Your Highest Rated
        </div>
        <div className="text-[10px]" style={{ color: 'var(--ink-2)' }}>
          Sorted by score · top-of-library
        </div>
        <div className="ml-auto flex gap-1">
          <button className="pxbtn is-active" onClick={() => onPlay(0)} disabled={!visible.length}>PLAY</button>
          <button className="pxbtn" onClick={onNext} disabled={!visible.length}>NEXT</button>
          <button className="pxbtn" onClick={onQueue} disabled={!visible.length}>QUEUE</button>
          <button className="pxbtn" onClick={onAction} disabled={!visible.length}>SAVE</button>
        </div>
      </div>
      {visible.length ? (
        <div className="home-rated-grid">
          {visible.map((track, idx) => {
            const art = track.hasArt ? api.getArtUrl(track.id) : null;
            const score = track.ratingScore != null ? track.ratingScore.toFixed(1) : `${track.rating}/5`;
            const scoreStrong = (track.ratingScore ?? track.rating * 20) >= 85;
            return (
              <button
                key={track.id}
                type="button"
                className="home-rated-card"
                onClick={() => onPlay(idx)}
                title={`Play ${track.artist} — ${track.title}`}
              >
                <div className="home-rated-card-art">
                  {art ? <img src={art} alt={track.album ?? ''} draggable={false} loading="lazy" decoding="async" /> : <span>♪</span>}
                  <span className={`home-rated-card-score ${scoreStrong ? 'is-strong' : ''}`}>{score}</span>
                </div>
                <div className="home-rated-card-meta">
                  <span className="home-rated-card-title" title={track.title}>{track.title}</span>
                  <span className="home-rated-card-artist" title={track.artist}>{track.artist}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="bevel-in px-3 py-4 text-[11px]" style={{ color: 'var(--muted)' }}>
          Rate tracks 0–100 and your top picks land here. Cmd/Ctrl-click the score in Now Playing for fine adjustment.
        </div>
      )}
    </section>
  );
}

function NewsCard({ fresh, loved, top }: { fresh: Track[]; loved: Track[]; top: Track | null }): JSX.Element {
  const newestImport = fresh[0] ?? null;
  const featured = top ?? loved[0] ?? newestImport ?? null;
  const headline = featured
    ? `${featured.artist} — “${featured.title}”`
    : 'NewAmp · field report from the desk';
  const blurb = featured
    ? `New Heidecker writes: a strong entry from ${featured.artist}. ${featured.year ? `Vintage ${featured.year}. ` : ''}${featured.bpm ? `Sits at ${featured.bpm.toFixed(0)} BPM, ` : ''}${featured.genre ? `${featured.genre} territory, ` : ''}and it would slot nicely between bagels.`
    : 'When the library has tracks, this column comes alive with reviews, comparisons, and bagel ratings from New Heidecker.';
  return (
    <section className="bevel-out home-news p-3" data-cell="NEWS-03" style={{ background: 'var(--panel)' }}>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--accent)' }}>
          NewAmp News
        </div>
        <span className="text-[10px]" style={{ color: 'var(--ink-2)' }}>
          Field report · {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </div>
      <div className="home-news-headline" title={headline}>{headline}</div>
      <p className="home-news-body">{blurb}</p>
      {newestImport ? (
        <div className="home-news-foot">
          <span className="home-news-foot-eyebrow">Most recent import</span>
          <span className="home-news-foot-title">{newestImport.artist} — {newestImport.title}</span>
        </div>
      ) : null}
    </section>
  );
}

interface TodayPick {
  track: Track;
  reason: string;
}

function pickToday(rated: Track[], recent: Track[], currentId: number | null): TodayPick | null {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const recentIds = new Set(recent.map((track) => track.id));
  const scored = rated.filter((track) => (track.ratingScore ?? track.rating * 20) >= 80);
  const qualified = scored.find((track) =>
    track.id !== currentId &&
    (track.lastPlayed == null || now - track.lastPlayed > thirtyDays),
  );
  const fallback = rated[0] ?? null;
  const track = qualified ?? fallback;
  if (!track) return null;
  const scoreLabel = 'Top-rated';
  if (track.lastPlayed == null) return { track, reason: `${scoreLabel} · never played` };
  const weeks = Math.max(1, Math.round((now - track.lastPlayed) / (7 * 24 * 60 * 60 * 1000)));
  if (qualified) return { track, reason: `${scoreLabel} · hasn't played in ${weeks} ${weeks === 1 ? 'week' : 'weeks'}` };
  if (track.id === currentId) return { track, reason: `${scoreLabel} · currently loaded` };
  if (recentIds.has(track.id)) return { track, reason: `${scoreLabel} · recent favorite` };
  return { track, reason: `${scoreLabel} · highest score available` };
}

function topGenreFromTracks(tracks: Track[]): string {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    const genre = track.genre?.trim();
    if (!genre) continue;
    counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return top?.[0] ?? '—';
}

function formatYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function ListeningStatsPanel({
  insights,
  history,
}: {
  insights: ListeningInsights;
  history: ListeningHistoryItem[];
}): JSX.Element {
  const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekTracks = history.filter((item) => item.playedAt >= weekStart).map((item) => item.track);
  const distinctArtists = new Set(weekTracks.map((track) => track.artist).filter(Boolean));
  const topGenre = topGenreFromTracks(weekTracks);
  const minutes = Math.round((insights.week.duration ?? 0) / 60);
  return (
    <section className="bevel-out home-listening-stats p-3" style={{ background: 'var(--panel)' }}>
      <div className="mb-3 flex items-baseline gap-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--accent)' }}>
          Listening Stats This Week
        </div>
        <div className="ml-auto text-[10px] tabular-nums" style={{ color: 'var(--muted)' }}>
          {insights.week.plays.toLocaleString()} plays
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Minutes" value={minutes} />
        <Metric label="Artists" value={distinctArtists.size} />
        <div className="bevel-in px-2 py-2">
          <div className="lcd-text truncate text-[18px] leading-none" title={topGenre} style={{ color: 'var(--accent)' }}>
            {topGenre}
          </div>
          <div className="mt-1 text-[9px] uppercase tracking-[0.1em]" style={{ color: 'var(--muted)' }}>
            Top genre
          </div>
        </div>
      </div>
    </section>
  );
}

function smartRuleSummary(rule: SmartPlaylistRule): string {
  const parts = [`${rule.count.toLocaleString()} dynamic`, rule.mood === 'deep-cuts' ? 'deep cuts' : rule.mood];
  if (rule.genreQuery) parts.push(rule.genreQuery);
  if (rule.searchQuery) parts.push(rule.searchQuery);
  if (rule.minYear || rule.maxYear) parts.push(`${rule.minYear ?? 'any'}-${rule.maxYear ?? 'any'}`);
  if (rule.minRating) parts.push(`${rule.minRating}+ stars`);
  if (rule.lovedOnly) parts.push('loved');
  if (rule.unplayedOnly) parts.push('fresh');
  return parts.join(' / ');
}

function sameSmartRule(rule: SmartPlaylistRule, input: SmartPlaylistSuggestion['rule']): boolean {
  return rule.name === input.name &&
    rule.mood === input.mood &&
    rule.genreQuery === (input.genreQuery ?? null) &&
    rule.searchQuery === (input.searchQuery ?? null) &&
    rule.minYear === (input.minYear ?? null) &&
    rule.maxYear === (input.maxYear ?? null) &&
    rule.minBpm === (input.minBpm ?? null) &&
    rule.maxBpm === (input.maxBpm ?? null) &&
    rule.minRating === (input.minRating ?? null) &&
    rule.lovedOnly === !!input.lovedOnly &&
    rule.unplayedOnly === !!input.unplayedOnly;
}
