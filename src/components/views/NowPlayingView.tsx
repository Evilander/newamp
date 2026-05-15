// Bloomberg-density Now Playing view, ported from claude-design reference
// 346c1cdba95b. Three-column main layout: album+queue / spectrum+VU+waveform /
// LRC lyrics. Top status strip carries hex badge + track stats. Everything
// pulls live state from the audio engine.

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore, engine } from '../../store/usePlayerStore';
import { fetchLyrics, parseLrc, type LrcLine } from '../../api/lrclib';
import { fetchArtistFacts, type ArtistFact } from '../../api/artistFacts';
import { formatTime, playbackCodecLabel } from '../../lib/format';
import { api } from '../../lib/api';
import type { LocalLyricsResult, SmartPlaylistRule, Track, TrackBookmark } from '@shared/types';
import {
  canEnablePracticeLoop,
  loopProgressPercent,
  normalizePracticeLoop,
  shouldRestartPracticeLoop,
  type PracticeLoop,
} from '@shared/practice-loop';
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  nudgePlaybackRate,
  playbackRateLabel,
} from '@shared/tempo-trainer';
import { GuitarTabCompanion } from '../GuitarTabCompanion';

type LyricPayload = Partial<Pick<LocalLyricsResult, 'plainLyrics' | 'syncedLyrics'>> & {
  instrumental?: boolean;
};
type LyricStatus = 'idle' | 'loading' | 'none' | 'ok';
type LyricSource = 'sidecar' | 'custom' | 'lrclib' | null;
type LyricsDraftMode = 'plain' | 'synced';

export function NowPlayingView(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const toggleLove = usePlayerStore((s) => s.toggleLove);
  const setTrackRating = usePlayerStore((s) => s.setTrackRating);
  const setFs = usePlayerStore((s) => s.setFullscreenViz);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const seek = usePlayerStore((s) => s.seek);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const autoDjEnabled = usePlayerStore((s) => s.autoDjEnabled);
  const autoDjTarget = usePlayerStore((s) => s.autoDjTarget);
  const autoDjSmartRuleId = usePlayerStore((s) => s.autoDjSmartRuleId);
  const setAutoDjEnabled = usePlayerStore((s) => s.setAutoDjEnabled);
  const setAutoDjSmartRuleId = usePlayerStore((s) => s.setAutoDjSmartRuleId);
  const setView = usePlayerStore((s) => s.setView);

  const [lyrics, setLyrics] = useState<{ plain?: string | null; lines: LrcLine[] | null }>(
    { lines: null, plain: null },
  );
  const [lyricStatus, setLyricStatus] = useState<LyricStatus>('idle');
  const [lyricSource, setLyricSource] = useState<LyricSource>(null);
  const [lyricsReloadKey, setLyricsReloadKey] = useState(0);
  const [lyricsEditorOpen, setLyricsEditorOpen] = useState(false);
  const [lyricsDraft, setLyricsDraft] = useState('');
  const [lyricsDraftMode, setLyricsDraftMode] = useState<LyricsDraftMode>('plain');
  const [lyricsMessage, setLyricsMessage] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<TrackBookmark[]>([]);
  const [stationRule, setStationRule] = useState<SmartPlaylistRule | null>(null);
  const [practiceLoop, setPracticeLoop] = useState<PracticeLoop>({
    start: null,
    end: null,
    enabled: false,
  });

  useEffect(() => {
    if (!current) {
      setLyrics({ lines: null, plain: null });
      setLyricStatus('idle');
      setLyricSource(null);
      setLyricsEditorOpen(false);
      setLyricsDraft('');
      setLyricsMessage(null);
      return;
    }
    const ctrl = new AbortController();
    let cancelled = false;
    setLyrics({ lines: null, plain: null });
    setLyricStatus('loading');

    const applyLyrics = (payload: LyricPayload, source: Exclude<LyricSource, null>) => {
      const next = lyricsFromPayload(payload);
      if (cancelled) return;
      setLyrics(next.lyrics);
      setLyricStatus(next.status);
      setLyricSource(next.status === 'ok' ? source : null);
    };

    const loadLyrics = async () => {
      try {
        const local = await api.getLocalLyrics(current.id).catch(() => null);
        if (cancelled) return;
        if (local) {
          applyLyrics(local, local.source);
          return;
        }

        const r = await fetchLyrics({
          artist: current.artist,
          title: current.title,
          album: current.album,
          duration: current.duration ?? undefined,
          signal: ctrl.signal,
        });
        if (!r) {
          setLyricStatus('none');
          setLyricSource(null);
          return;
        }
        applyLyrics(r, 'lrclib');
      } catch {
        if (!cancelled) {
          setLyricStatus('none');
          setLyricSource(null);
        }
      }
    };

    void loadLyrics();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [current?.id, lyricsReloadKey]);

  useEffect(() => {
    if (!current) {
      setBookmarks([]);
      return;
    }
    let cancelled = false;
    api
      .getTrackBookmarks(current.id)
      .then((rows) => {
        if (!cancelled) setBookmarks(rows);
      })
      .catch(() => {
        if (!cancelled) setBookmarks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id]);

  useEffect(() => {
    setPracticeLoop({ start: null, end: null, enabled: false });
  }, [current?.id]);

  useEffect(() => {
    if (!autoDjSmartRuleId) {
      setStationRule(null);
      return;
    }
    let cancelled = false;
    api
      .getSmartPlaylistRules()
      .then((rules) => {
        if (!cancelled) setStationRule(rules.find((rule) => rule.id === autoDjSmartRuleId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setStationRule(null);
      });
    return () => {
      cancelled = true;
    };
  }, [autoDjSmartRuleId]);

  useEffect(() => {
    if (!isPlaying || !shouldRestartPracticeLoop(practiceLoop, currentTime)) return;
    seek(practiceLoop.start ?? 0);
  }, [currentTime, isPlaying, practiceLoop, seek]);

  const artUrl = useMemo(
    () => (current?.hasArt ? api.getArtUrl(current.id) : null),
    [current?.id, current?.hasArt],
  );

  if (!current) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2"
        style={{ color: 'var(--muted)' }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.2em]"
          style={{ color: 'var(--ink-2)' }}
        >
          Now Playing
        </div>
        <div className="text-[14px]">Nothing&rsquo;s playing. Pick a track from the Library.</div>
      </div>
    );
  }

  const activeIdx = lyrics.lines ? findActive(lyrics.lines, currentTime) : -1;
  const fmtKbps = current.bitrate ? `${Math.round(current.bitrate / 1000)} kbps` : '—';
  const fmtRate = current.sampleRate ? `${(current.sampleRate / 1000).toFixed(1)} khz` : '—';
  const codecHint = playbackCodecLabel(current.path);

  async function saveBookmark(): Promise<void> {
    if (!current) return;
    const saved = await api.saveTrackBookmark({
      trackId: current.id,
      position: currentTime,
      label: `Mark ${formatTime(currentTime)}`,
    });
    setBookmarks((rows) =>
      [...rows.filter((row) => row.id !== saved.id), saved].sort((a, b) => a.position - b.position),
    );
  }

  async function deleteBookmark(id: number): Promise<void> {
    await api.deleteTrackBookmark(id);
    setBookmarks((rows) => rows.filter((row) => row.id !== id));
  }

  function openLyricsEditor(): void {
    setLyricsMessage(null);
    setLyricsEditorOpen(true);
    if (lyrics.lines?.length) {
      setLyricsDraftMode('synced');
      setLyricsDraft(lrcLinesToText(lyrics.lines));
      return;
    }
    setLyricsDraftMode('plain');
    setLyricsDraft(lyrics.plain ?? '');
  }

  async function saveCustomLyrics(): Promise<void> {
    if (!current) return;
    setLyricsMessage(null);
    const saved = await api.saveCustomLyrics({
      trackId: current.id,
      plainLyrics: lyricsDraftMode === 'plain' ? lyricsDraft : null,
      syncedLyrics: lyricsDraftMode === 'synced' ? lyricsDraft : null,
    });
    if (!saved) {
      setLyricsMessage('Nothing saved.');
      return;
    }
    const next = lyricsFromPayload(saved);
    setLyrics(next.lyrics);
    setLyricStatus(next.status);
    setLyricSource('custom');
    setLyricsEditorOpen(false);
    setLyricsMessage('Saved custom lyrics.');
  }

  async function clearCustomLyrics(): Promise<void> {
    if (!current) return;
    await api.clearCustomLyrics(current.id);
    setLyricsEditorOpen(false);
    setLyricsMessage('Custom lyrics cleared.');
    setLyricsReloadKey((value) => value + 1);
  }

  function setLoopPoint(point: 'start' | 'end'): void {
    const duration = current?.duration ?? null;
    setPracticeLoop((loop) =>
      normalizePracticeLoop({ ...loop, [point]: currentTime }, duration),
    );
  }

  function togglePracticeLoop(): void {
    const duration = current?.duration ?? null;
    setPracticeLoop((loop) =>
      normalizePracticeLoop({ ...loop, enabled: !loop.enabled }, duration),
    );
  }

  function clearPracticeLoop(): void {
    setPracticeLoop({ start: null, end: null, enabled: false });
  }

  async function stopStation(): Promise<void> {
    await setAutoDjEnabled(false);
    await setAutoDjSmartRuleId(null);
  }

  const activeStationName = autoDjEnabled
    ? autoDjSmartRuleId
      ? stationRule?.name ?? `Smart Rule #${autoDjSmartRuleId}`
      : 'Harmonic Mix'
    : null;

  return (
    <div
      data-newamp-now-playing
      className="flex h-full flex-col overflow-hidden"
      style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
    >
      {/* --- Top status strip --- */}
      <div
        className="flex items-center justify-between px-4 text-[10px] uppercase tracking-[0.08em]"
        style={{
          height: 28,
          background: 'var(--panel)',
          borderBottom: '1px solid var(--line)',
          color: 'var(--ink-2)',
          flexShrink: 0,
        }}
      >
        <div className="flex items-center gap-3">
          <span
            className="font-bold tracking-[0.15em]"
            style={{ color: 'var(--accent)', fontSize: 11 }}
          >
            NEWAMP
          </span>
          <StatusPill on={isPlaying} text={isPlaying ? 'PLAYING' : 'PAUSED'} />
          {activeStationName ? <StatusPill on text="RADIO" /> : null}
          <span style={{ color: 'var(--muted)' }}>
            OUTPUT · WASAPI · {fmtKbps} · {fmtRate}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {activeStationName ? (
            <>
              <button className="pxbtn px-2 py-[2px] text-[10px]" onClick={() => setView('playlist')} title={activeStationName}>
                {activeStationName} / {Math.max(0, queue.length - Math.max(queueIndex, 0) - 1)} left / target {autoDjTarget}
              </button>
              <button className="pxbtn px-2 py-[2px] text-[10px]" onClick={() => void stopStation()}>
                STOP RADIO
              </button>
            </>
          ) : null}
          <HexBadge label="SYS" value="10/10" />
          <Clock />
        </div>
      </div>

      {/* --- Main (album+queue / right side) --- */}
      <div
        className="grid flex-1 overflow-hidden"
        style={{ gridTemplateColumns: '420px 1fr' }}
      >
        {/* --- Album side --- */}
        <div
          className="flex flex-col overflow-hidden"
          style={{ background: 'var(--panel)', borderRight: '1px solid var(--line)' }}
        >
          <button
            type="button"
            onClick={() => setFs(true)}
            className="relative shrink-0"
            style={{
              width: 420,
              height: 420,
              background: 'var(--panel-2)',
              borderBottom: '1px solid var(--line)',
              overflow: 'hidden',
            }}
            title="Open fullscreen visualizer"
          >
            {artUrl ? (
              <img
                src={artUrl}
                alt={current.album}
                className={isPlaying ? 'pulse-soft' : ''}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
                draggable={false}
              />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center"
                style={{
                  fontSize: 120,
                  color: 'rgba(52,211,153,0.08)',
                  background:
                    'linear-gradient(135deg, rgba(52,211,153,0.06) 0%, var(--panel-2) 40%, rgba(124,92,255,0.05) 70%, rgba(255,59,106,0.04) 100%)',
                }}
              >
                ♫
              </div>
            )}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 50%)',
              }}
            />
            <div className="pointer-events-none absolute bottom-3 left-3 right-3">
              <div
                className="mb-1 text-[9px] uppercase tracking-[0.1em]"
                style={{ color: 'var(--ink-2)' }}
              >
                {current.year ?? '—'} · {current.albumArtist || current.artist}
              </div>
              <div className="text-[13px] font-bold" style={{ color: 'var(--ink)' }}>
                {current.album || 'Unknown Album'}
              </div>
            </div>
          </button>

          {/* Queue */}
          <div className="flex-1 overflow-y-auto">
            <div
              className="sticky top-0 flex items-center justify-between px-[14px] py-[7px] text-[9px] uppercase tracking-[0.1em]"
              style={{
                color: 'var(--ink-2)',
                background: 'var(--panel)',
                borderBottom: '1px solid var(--line)',
                zIndex: 1,
              }}
            >
              <span>Queue · {queue.length} tracks</span>
              <span>{queueIndex >= 0 ? `${queueIndex + 1}/${queue.length}` : '—'}</span>
            </div>
            {queue.length === 0 ? (
              <div className="px-[14px] py-3 text-[11px]" style={{ color: 'var(--muted)' }}>
                Queue is empty.
              </div>
            ) : (
              queue.map((t, i) => (
                <QueueRow
                  key={`${t.id}-${i}`}
                  track={t}
                  index={i}
                  active={i === queueIndex}
                  onPlay={() => void playQueue(queue, i)}
                />
              ))
            )}
          </div>
        </div>

        {/* --- Right side: track-info, vis+lyrics --- */}
        <div
          className="grid overflow-hidden"
          style={{ gridTemplateRows: 'auto 1fr', background: 'var(--bg)' }}
        >
          <TrackInfoHeader
            current={current}
            onLove={() => toggleLove(current.id)}
            onSetRating={(rating) => void setTrackRating(current.id, rating)}
            codecHint={codecHint}
          />

          <div
            className="grid overflow-hidden"
            style={{ gridTemplateColumns: '280px 1fr', borderTop: '1px solid var(--line)' }}
          >
            <SpectrumPanel currentTime={currentTime} duration={current.duration ?? 0} />
            <div className="grid min-h-0 overflow-hidden" style={{ gridTemplateRows: '188px 152px 104px 124px 132px 1fr' }}>
              <ArtistImageStage artist={current.artist} />
              <GuitarTabCompanion current={current} isPlaying={isPlaying} />
              <TempoTrainerPanel
                playbackRate={playbackRate}
                onChange={(rate) => void setPlaybackRate(rate)}
              />
              <PracticeLoopPanel
                loop={practiceLoop}
                currentTime={currentTime}
                duration={current.duration ?? null}
                onSetStart={() => setLoopPoint('start')}
                onSetEnd={() => setLoopPoint('end')}
                onToggle={togglePracticeLoop}
                onClear={clearPracticeLoop}
                onJumpStart={() => {
                  if (practiceLoop.start != null) seek(practiceLoop.start);
                }}
              />
              <BookmarkPanel
                bookmarks={bookmarks}
                currentTime={currentTime}
                onSave={() => void saveBookmark()}
                onDelete={(id) => void deleteBookmark(id)}
                onJump={(bookmark) => seek(bookmark.position)}
              />
              <LyricsPanel
                lyrics={lyrics}
                activeIdx={activeIdx}
                status={lyricStatus}
                source={lyricSource}
                editorOpen={lyricsEditorOpen}
                draft={lyricsDraft}
                draftMode={lyricsDraftMode}
                message={lyricsMessage}
                onOpenEditor={openLyricsEditor}
                onDraftChange={setLyricsDraft}
                onDraftModeChange={setLyricsDraftMode}
                onSaveCustom={() => void saveCustomLyrics()}
                onClearCustom={() => void clearCustomLyrics()}
                onCancelEditor={() => setLyricsEditorOpen(false)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Sub-components                                                */
/* ============================================================ */

function StatusPill({ on, text }: { on: boolean; text: string }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-[5px] border px-[7px] py-[1px] text-[9px] tracking-[0.1em]"
      style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: on ? 'var(--accent)' : 'var(--muted)',
          animation: on ? 'blink 2s ease-in-out infinite' : undefined,
        }}
      />
      {text}
    </span>
  );
}

function HexBadge({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-[6px] border px-[8px] py-[1px] text-[10px] font-bold"
      style={{ borderColor: 'var(--accent-dim)', color: 'var(--accent)' }}
    >
      <span style={{ color: 'var(--ink-2)', fontWeight: 400 }}>{label}</span>
      {value}
    </span>
  );
}

function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const ts = `${now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} ${now
    .toISOString()
    .slice(0, 10)} · ${now.toLocaleTimeString([], { hour12: false })}`;
  return (
    <span className="text-[10px]" style={{ color: 'var(--ink)' }}>
      {ts}
    </span>
  );
}

function TrackInfoHeader({
  current,
  onLove,
  onSetRating,
  codecHint,
}: {
  current: Track;
  onLove: () => void;
  onSetRating: (rating: number) => void;
  codecHint: string;
}): JSX.Element {
  return (
    <div
      className="flex items-start justify-between gap-6 px-6 py-5"
      style={{ borderBottom: '1px solid var(--line)' }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="mb-[6px] text-[9px] uppercase tracking-[0.12em]"
          style={{ color: 'var(--ink-2)' }}
        >
          Track · {current.trackNo ?? '—'}{current.discNo ? ` · disc ${current.discNo}` : ''}
        </div>
        <div
          className="leading-[1.1]"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'var(--ink)',
          }}
          title={current.title}
        >
          {current.title}
        </div>
        <div className="mt-1 text-[13px]" style={{ color: 'var(--accent)' }}>
          {current.artist}
        </div>
        <div className="mt-[8px] flex flex-wrap gap-[6px]">
          {current.genre && <Tag accent>{current.genre}</Tag>}
          {codecHint && <Tag>{codecHint}</Tag>}
          {current.sampleRate && (
            <Tag>{(current.sampleRate / 1000).toFixed(1)} khz</Tag>
          )}
          {current.bitrate && <Tag>{Math.round(current.bitrate / 1000)} kbps</Tag>}
          <button
            type="button"
            onClick={onLove}
            className="border px-[6px] text-[9px] uppercase tracking-[0.1em]"
            style={{
              borderColor: current.loved ? 'var(--accent-dim)' : 'var(--line)',
              color: current.loved ? 'var(--accent)' : 'var(--ink-2)',
            }}
          >
            {current.loved ? '★ loved' : '☆ love'}
          </button>
          <TrackRating value={current.rating} onChange={onSetRating} />
        </div>
      </div>

      <div className="flex min-w-[140px] flex-col items-end gap-2">
        <Stat label="BPM" value={current.bpm ? current.bpm.toFixed(1) : '—'} />
        <Stat label="KEY" value={current.key || '—'} />
        <Stat
          label="DUR"
          value={current.duration ? formatTime(current.duration) : '—'}
          good
        />
        <Stat label="PLAYS" value={current.playCount.toLocaleString()} />
      </div>
    </div>
  );
}

function TrackRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (rating: number) => void;
}): JSX.Element {
  const rating = Math.max(0, Math.min(5, Math.round(value || 0)));
  return (
    <div
      className="flex items-center gap-[2px] border px-[6px] py-[2px]"
      data-newamp-now-playing-rating={rating}
      style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
    >
      <span className="mr-1 text-[9px] uppercase tracking-[0.1em]">Rating</span>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(rating === star ? 0 : star)}
          title={`${star} star${star === 1 ? '' : 's'}`}
          className="leading-none"
          style={{ color: star <= rating ? 'var(--accent)' : 'var(--muted)' }}
        >
          {star <= rating ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

function Tag({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: boolean;
}): JSX.Element {
  return (
    <span
      className="border px-[6px] py-[2px] text-[9px] uppercase tracking-[0.1em]"
      style={{
        borderColor: accent ? 'var(--accent-dim)' : 'var(--line)',
        color: accent ? 'var(--accent)' : 'var(--ink-2)',
      }}
    >
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col items-end gap-[1px]">
      <div
        className="text-[8px] uppercase tracking-[0.1em]"
        style={{ color: 'var(--ink-2)' }}
      >
        {label}
      </div>
      <div
        className="text-[13px] font-bold tabular-nums"
        style={{ color: good ? 'var(--accent)' : 'var(--ink)' }}
      >
        {value}
      </div>
    </div>
  );
}

function QueueRow({
  track,
  index,
  active,
  onPlay,
}: {
  track: Track;
  index: number;
  active: boolean;
  onPlay: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPlay}
      onDoubleClick={onPlay}
      className="grid w-full cursor-pointer items-center gap-2 px-[14px] py-[7px] text-left transition-colors"
      style={{
        gridTemplateColumns: '20px 1fr auto',
        background: active ? 'rgba(52,211,153,0.06)' : 'transparent',
        borderBottom: '1px solid rgba(26,40,48,0.45)',
      }}
    >
      <span
        className="text-right text-[10px] tabular-nums"
        style={{ color: active ? 'var(--accent)' : 'var(--ink-2)' }}
      >
        {active ? '▶' : String(index + 1).padStart(2, '0')}
      </span>
      <span
        className="truncate text-[11px]"
        style={{ color: active ? 'var(--accent)' : 'var(--ink)' }}
        title={`${track.title} — ${track.artist}`}
      >
        {track.title}
      </span>
      <span
        className="text-[10px] tabular-nums"
        style={{ color: 'var(--ink-2)' }}
      >
        {track.duration ? formatTime(track.duration) : '—'}
      </span>
    </button>
  );
}

function BookmarkPanel({
  bookmarks,
  currentTime,
  onSave,
  onDelete,
  onJump,
}: {
  bookmarks: TrackBookmark[];
  currentTime: number;
  onSave: () => void;
  onDelete: (id: number) => void;
  onJump: (bookmark: TrackBookmark) => void;
}): JSX.Element {
  return (
    <div
      className="min-h-0 border-b px-4 py-3"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Track Bookmarks
        </div>
        <div className="flex-1 text-[10px] tabular-nums" style={{ color: 'var(--ink-2)' }}>
          {formatTime(currentTime)}
        </div>
        <button className="pxbtn is-active" onClick={onSave}>
          SAVE MARK
        </button>
      </div>
      {bookmarks.length ? (
        <div className="grid max-h-[78px] gap-[3px] overflow-auto pr-1">
          {bookmarks.map((bookmark) => (
            <div
              key={bookmark.id}
              className="grid items-center gap-2 text-[11px]"
              style={{ gridTemplateColumns: '52px minmax(0,1fr) 48px 24px' }}
            >
              <button
                className="text-left tabular-nums"
                style={{ color: 'var(--accent)' }}
                onClick={() => onJump(bookmark)}
                title="Jump to bookmark"
              >
                {formatTime(bookmark.position)}
              </button>
              <div className="truncate" title={bookmark.label} style={{ color: 'var(--ink)' }}>
                {bookmark.label}
              </div>
              <button className="pxbtn px-1 py-[1px] text-[9px]" onClick={() => onJump(bookmark)}>
                JUMP
              </button>
              <button className="pxbtn px-1 py-[1px] text-[9px]" onClick={() => onDelete(bookmark.id)}>
                X
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
          No marks for this track yet.
        </div>
      )}
    </div>
  );
}

function TempoTrainerPanel({
  playbackRate,
  onChange,
}: {
  playbackRate: number;
  onChange: (rate: number) => void;
}): JSX.Element {
  const slow = nudgePlaybackRate(playbackRate, -1);
  const fast = nudgePlaybackRate(playbackRate, 1);
  return (
    <div
      data-newamp-tempo-trainer
      data-newamp-playback-rate={playbackRate}
      className="border-b px-4 py-3"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Tempo Trainer
        </div>
        <div className="flex-1 text-[10px]" style={{ color: 'var(--ink-2)' }}>
          Pitch preserved
        </div>
        <div className="lcd-text text-[18px] tabular-nums" style={{ color: 'var(--accent)' }}>
          {playbackRateLabel(playbackRate)}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button className="pxbtn" onClick={() => onChange(MIN_PLAYBACK_RATE)}>
          1/2
        </button>
        <button className="pxbtn" onClick={() => onChange(slow)}>
          -5%
        </button>
        <input
          className="nslider flex-1"
          type="range"
          min={MIN_PLAYBACK_RATE}
          max={MAX_PLAYBACK_RATE}
          step={0.05}
          value={playbackRate}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
        <button className="pxbtn" onClick={() => onChange(fast)}>
          +5%
        </button>
        <button className="pxbtn is-active" onClick={() => onChange(1)}>
          1x
        </button>
      </div>
    </div>
  );
}

function PracticeLoopPanel({
  loop,
  currentTime,
  duration,
  onSetStart,
  onSetEnd,
  onToggle,
  onClear,
  onJumpStart,
}: {
  loop: PracticeLoop;
  currentTime: number;
  duration: number | null;
  onSetStart: () => void;
  onSetEnd: () => void;
  onToggle: () => void;
  onClear: () => void;
  onJumpStart: () => void;
}): JSX.Element {
  const normalized = normalizePracticeLoop(loop, duration);
  const ready = canEnablePracticeLoop(normalized);
  const progress = loopProgressPercent(normalized, currentTime);
  return (
    <div
      data-newamp-practice-loop
      data-newamp-practice-loop-enabled={normalized.enabled ? 'true' : 'false'}
      className="border-b px-4 py-3"
      style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Practice Loop
        </div>
        <div className="flex-1 text-[10px] tabular-nums" style={{ color: 'var(--ink-2)' }}>
          {ready
            ? `${formatTime(normalized.start!)} -> ${formatTime(normalized.end!)}`
            : `Set A/B at ${formatTime(currentTime)}`}
        </div>
        <button className="pxbtn" onClick={onSetStart}>SET A</button>
        <button className="pxbtn" onClick={onSetEnd}>SET B</button>
      </div>
      <div className="mb-2 h-[6px] overflow-hidden bevel-in" style={{ background: 'var(--display-bg)' }}>
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background: normalized.enabled ? 'var(--accent)' : 'var(--accent-dim)',
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <button className={`pxbtn ${normalized.enabled ? 'is-active' : ''}`} onClick={onToggle} disabled={!ready}>
          {normalized.enabled ? 'LOOP ON' : 'LOOP OFF'}
        </button>
        <button className="pxbtn" onClick={onJumpStart} disabled={normalized.start == null}>
          JUMP A
        </button>
        <button className="pxbtn" onClick={onClear} disabled={normalized.start == null && normalized.end == null}>
          CLEAR
        </button>
        <span className="ml-auto text-[10px] tabular-nums" style={{ color: 'var(--muted)' }}>
          {ready ? `${Math.round(progress)}%` : 'A/B unset'}
        </span>
      </div>
    </div>
  );
}

function SpectrumPanel({
  currentTime,
  duration,
}: {
  currentTime: number;
  duration: number;
}): JSX.Element {
  const barsRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const BARS = 24;
    const freq = new Uint8Array(engine.analyser.frequencyBinCount);
    const peaks = new Float32Array(BARS);
    let raf = 0;
    const tick = (): void => {
      engine.getFreqData(freq as Uint8Array<ArrayBuffer>);
      const container = barsRef.current;
      const peakContainer = peakRef.current;
      if (!container) {
        raf = requestAnimationFrame(tick);
        return;
      }
      // Map FFT bins logarithmically to BARS columns.
      for (let i = 0; i < BARS; i++) {
        const lo = Math.floor(Math.pow(i / BARS, 2) * freq.length);
        const hi = Math.floor(Math.pow((i + 1) / BARS, 2) * freq.length);
        let max = 0;
        for (let k = lo; k < hi && k < freq.length; k++) {
          if ((freq[k] ?? 0) > max) max = freq[k] ?? 0;
        }
        const norm = max / 255;
        peaks[i] = Math.max(peaks[i]! - 0.012, norm);
        const bar = container.children.item(i) as HTMLElement | null;
        if (bar) bar.style.height = `${Math.max(2, norm * 100)}%`;
        const peak = peakContainer?.children.item(i) as HTMLElement | null;
        if (peak) peak.style.bottom = `${Math.max(0, peaks[i]! * 100 - 1)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="flex flex-col gap-[10px] px-4 py-3"
      style={{ borderRight: '1px solid var(--line)', background: 'var(--panel)' }}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[9px] uppercase tracking-[0.1em]"
          style={{ color: 'var(--ink-2)' }}
        >
          Spectrum
        </span>
        <span className="text-[9px] tabular-nums" style={{ color: 'var(--muted)' }}>
          24 bands
        </span>
      </div>

      <div className="relative" style={{ height: 120 }}>
        <div
          ref={barsRef}
          className="absolute inset-0 flex items-end gap-[2px]"
        >
          {Array.from({ length: 24 }, (_, i) => (
            <div
              key={i}
              className="flex-1"
              style={{
                background: 'var(--accent-dim)',
                minHeight: 2,
                height: '2%',
                transition: 'height 80ms ease-out',
              }}
            />
          ))}
        </div>
        <div
          ref={peakRef}
          className="pointer-events-none absolute inset-0 flex items-end gap-[2px]"
        >
          {Array.from({ length: 24 }, (_, i) => (
            <div key={i} className="relative flex-1">
              <div
                className="absolute left-0 right-0"
                style={{
                  bottom: '0%',
                  height: 2,
                  background: 'var(--accent)',
                  boxShadow: '0 0 6px var(--accent-glow)',
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <VuMeter />

      <div>
        <div
          className="mb-[6px] flex items-center justify-between text-[9px] uppercase tracking-[0.1em]"
          style={{ color: 'var(--ink-2)' }}
        >
          <span>Overview</span>
          <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
            {duration > 0 ? `${Math.round((currentTime / duration) * 100)}%` : '0%'}
          </span>
        </div>
        <WaveformOverview currentTime={currentTime} duration={duration} />
      </div>
    </div>
  );
}

function VuMeter(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const time = new Uint8Array(engine.analyser.fftSize);
    let l = 0,
      r = 0;
    let raf = 0;
    const tick = (): void => {
      engine.getTimeData(time as Uint8Array<ArrayBuffer>);
      // Single-channel approx — we don't have split L/R from the analyser.
      let sumSq = 0;
      for (let i = 0; i < time.length; i++) {
        const v = (time[i]! - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / time.length); // 0..1
      // Simulate a tiny channel split so the visual reads "stereo"
      l = Math.max(l * 0.86, rms * 0.96);
      r = Math.max(r * 0.86, rms * 1.02);
      const el = ref.current;
      if (el) {
        const lf = el.querySelector<HTMLElement>('[data-vu="L"]');
        const rf = el.querySelector<HTMLElement>('[data-vu="R"]');
        if (lf) lf.style.width = `${Math.min(100, l * 100)}%`;
        if (rf) rf.style.width = `${Math.min(100, r * 100)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={ref} className="flex flex-col gap-1">
      {(['L', 'R'] as const).map((side) => (
        <div key={side} className="flex items-center gap-2">
          <span
            className="w-[14px] text-[9px]"
            style={{ color: 'var(--ink-2)' }}
          >
            {side}
          </span>
          <div
            className="relative h-[6px] flex-1"
            style={{ background: 'var(--panel-2)', overflow: 'hidden' }}
          >
            <div
              data-vu={side}
              className="h-full"
              style={{
                width: 0,
                background:
                  'linear-gradient(to right, var(--accent-dim), var(--accent), var(--warn), var(--error))',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function WaveformOverview({
  currentTime,
  duration,
}: {
  currentTime: number;
  duration: number;
}): JSX.Element {
  // Decorative pseudo-waveform — real PCM peak data would require off-thread
  // decode at scan time; this gives the right "shape signature" for now.
  const path = useMemo(() => {
    const N = 64;
    let d = `M 0 20`;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 100;
      const seed = Math.sin(i * 1.7) * Math.cos(i * 0.31) + Math.sin(i * 5.3) * 0.4;
      const y = 20 - Math.abs(seed) * 14 - 1.5;
      d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    for (let i = N - 1; i >= 0; i--) {
      const x = (i / (N - 1)) * 100;
      const seed = Math.sin(i * 1.7) * Math.cos(i * 0.31) + Math.sin(i * 5.3) * 0.4;
      const y = 20 + Math.abs(seed) * 14 + 1.5;
      d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return d + ' Z';
  }, []);

  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <svg width="100%" height={40} viewBox="0 0 100 40" preserveAspectRatio="none">
      <defs>
        <linearGradient id="wave-played" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent-dim)" />
        </linearGradient>
        <linearGradient id="wave-unplayed">
          <stop offset="0%" stopColor="var(--panel-3)" />
          <stop offset="100%" stopColor="var(--panel-3)" />
        </linearGradient>
        <clipPath id="wave-clip-played">
          <rect x="0" y="0" width={pct} height="40" />
        </clipPath>
        <clipPath id="wave-clip-unplayed">
          <rect x={pct} y="0" width={100 - pct} height="40" />
        </clipPath>
      </defs>
      <path d={path} fill="url(#wave-unplayed)" clipPath="url(#wave-clip-unplayed)" />
      <path d={path} fill="url(#wave-played)" clipPath="url(#wave-clip-played)" />
      <line
        x1={pct}
        y1="0"
        x2={pct}
        y2="40"
        stroke="var(--ink)"
        strokeWidth="0.3"
        strokeDasharray="1 1"
      />
    </svg>
  );
}

function ArtistImageStage({ artist }: { artist: string }): JSX.Element {
  const [fact, setFact] = useState<ArtistFact | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'none' | 'ok'>('idle');

  useEffect(() => {
    if (!artist || artist === 'Unknown Artist') {
      setFact(null);
      setStatus('idle');
      return;
    }
    const ctrl = new AbortController();
    setFact(null);
    setStatus('loading');
    fetchArtistFacts(artist, ctrl.signal)
      .then((next) => {
        setFact(next);
        setStatus(next ? 'ok' : 'none');
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus('none');
      });
    return () => ctrl.abort();
  }, [artist]);

  const imageUrl = fact?.imageUrl ?? fact?.originalImageUrl;

  return (
    <div
      className="relative overflow-hidden border-b"
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--line)',
      }}
    >
      {imageUrl && (
        <div
          className="absolute inset-0 opacity-45"
          style={{
            backgroundImage: `linear-gradient(90deg, rgba(6,10,14,0.96), rgba(6,10,14,0.82) 52%, rgba(6,10,14,0.42)), url(${JSON.stringify(imageUrl)})`,
            backgroundPosition: 'center',
            backgroundSize: 'cover',
          }}
        />
      )}
      <div
        className="relative grid h-full gap-3 px-4 py-3"
        style={{ gridTemplateColumns: imageUrl ? '108px 1fr' : '1fr' }}
      >
        {imageUrl && (
          <img
            src={imageUrl}
            alt={fact?.title ?? artist}
            className="h-[142px] w-[108px] self-center object-cover"
            style={{ borderRadius: 'var(--radius)', boxShadow: '0 0 0 1px var(--line)' }}
            draggable={false}
          />
        )}
        <div className="min-w-0 self-center">
          <div
            className="mb-2 flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.1em]"
            style={{ color: 'var(--ink-2)' }}
          >
            <span>Artist Image - Facts</span>
            <span className="shrink-0" style={{ color: 'var(--muted)' }}>
              {status === 'loading' ? 'fetching...' : status === 'none' ? 'no match' : 'wikipedia'}
            </span>
          </div>
          {fact ? (
            <>
              <a
                href={fact.url}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-[13px] font-bold"
                style={{ color: 'var(--accent)' }}
              >
                {fact.title}
              </a>
              {fact.description && (
                <div className="mt-1 truncate text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--ink-2)' }}>
                  {fact.description}
                </div>
              )}
              <p className="mt-2 line-clamp-5 text-[11px] leading-[1.42]" style={{ color: 'var(--ink-2)' }}>
                {fact.summary}
              </p>
            </>
          ) : (
            <div className="flex h-[108px] items-center text-[11px]" style={{ color: 'var(--muted)' }}>
              {status === 'loading' ? 'Looking up artist image and context...' : 'Artist image and context will appear when a match is found.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LyricsPanel({
  lyrics,
  activeIdx,
  status,
  source,
  editorOpen,
  draft,
  draftMode,
  message,
  onOpenEditor,
  onDraftChange,
  onDraftModeChange,
  onSaveCustom,
  onClearCustom,
  onCancelEditor,
}: {
  lyrics: { plain?: string | null; lines: LrcLine[] | null };
  activeIdx: number;
  status: LyricStatus;
  source: LyricSource;
  editorOpen: boolean;
  draft: string;
  draftMode: LyricsDraftMode;
  message: string | null;
  onOpenEditor: () => void;
  onDraftChange: (value: string) => void;
  onDraftModeChange: (mode: LyricsDraftMode) => void;
  onSaveCustom: () => void;
  onClearCustom: () => void;
  onCancelEditor: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!lyrics.lines || activeIdx < 0 || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-line="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, lyrics.lines]);

  return (
    <div
      data-newamp-lyrics-panel
      data-newamp-lyrics-status={status}
      data-newamp-lyrics-source={source ?? ''}
      data-newamp-lyrics-mode={lyrics.lines ? 'synced' : lyrics.plain ? 'plain' : 'empty'}
      data-newamp-lyrics-line-count={lyrics.lines?.length ?? 0}
      data-newamp-lyrics-plain-length={lyrics.plain?.length ?? 0}
      className="flex flex-col overflow-hidden"
      style={{ background: 'var(--bg)' }}
    >
      <div
        className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 text-[9px] uppercase tracking-[0.1em]"
        style={{
          background: 'var(--bg)',
          borderBottom: '1px solid var(--line)',
          color: 'var(--ink-2)',
        }}
      >
        <span>{lyricsSourceLabel(source)}</span>
        <span style={{ color: 'var(--muted)' }}>
          {status === 'loading'
            ? 'syncing…'
            : status === 'none'
              ? 'no match'
              : status === 'ok' && lyrics.lines
                ? `${lyrics.lines.length} lines · synced`
                : status === 'ok'
                  ? 'plain text'
                  : ''}
        </span>
      </div>
      <div
        className="flex items-center gap-2 border-b px-4 py-2 text-[10px]"
        style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
      >
        <button className="pxbtn" onClick={onOpenEditor}>
          {source === 'custom' ? 'EDIT SAVED LYRICS' : 'SAVE / EDIT LYRICS'}
        </button>
        <button className="pxbtn" onClick={onClearCustom}>
          CLEAR SAVED
        </button>
        {message && <span style={{ color: 'var(--accent)' }}>{message}</span>}
      </div>
      {editorOpen && (
        <div
          data-newamp-lyrics-editor
          className="border-b px-4 py-3"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          <div className="mb-2 flex items-center gap-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
              Custom Lyrics
            </div>
            <button
              className={`pxbtn ${draftMode === 'plain' ? 'is-active' : ''}`}
              onClick={() => onDraftModeChange('plain')}
            >
              PLAIN
            </button>
            <button
              className={`pxbtn ${draftMode === 'synced' ? 'is-active' : ''}`}
              onClick={() => onDraftModeChange('synced')}
            >
              LRC
            </button>
            <button className="pxbtn is-active" onClick={onSaveCustom} disabled={!draft.trim()}>
              SAVE
            </button>
            <button className="pxbtn" onClick={onCancelEditor}>
              CANCEL
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.currentTarget.value)}
            className="bevel-in h-[150px] w-full resize-y px-3 py-2 text-[12px] outline-none"
            placeholder={draftMode === 'synced' ? '[00:12.00]First synced line' : 'Paste corrected lyrics here'}
            style={{
              background: 'var(--display-bg)',
              color: 'var(--display-fg)',
              fontFamily: 'var(--font-display)',
            }}
          />
        </div>
      )}
      <div ref={ref} className="flex-1 overflow-y-auto">
        {lyrics.lines ? (
          lyrics.lines.map((l, i) => {
            const state =
              i === activeIdx ? 'current' : i < activeIdx ? 'past' : 'upcoming';
            return (
              <div
                key={i}
                data-line={i}
                data-newamp-lyric-line
                data-newamp-lyric-time={l.time}
                data-newamp-lyric-state={state}
                className="grid items-baseline gap-[10px] px-4 py-[8px] text-[12px] transition-colors"
                style={{
                  gridTemplateColumns: '52px 1fr',
                  background:
                    state === 'current' ? 'rgba(52,211,153,0.07)' : undefined,
                  borderBottom: '1px solid rgba(26,40,48,0.45)',
                  color:
                    state === 'past'
                      ? 'rgba(143,156,170,0.42)'
                      : state === 'current'
                        ? 'var(--ink)'
                        : 'var(--ink-2)',
                }}
              >
                <span
                  className="text-[9px] tabular-nums"
                  style={{
                    color: state === 'current' ? 'var(--accent)' : 'var(--ink-2)',
                    opacity: state === 'current' ? 1 : 0.55,
                  }}
                >
                  {formatTime(l.time)}
                </span>
                <span
                  style={{
                    color: state === 'current' ? 'var(--accent)' : undefined,
                    fontWeight: state === 'current' ? 500 : 400,
                  }}
                >
                  {l.text || '♪'}
                </span>
              </div>
            );
          })
        ) : lyrics.plain ? (
          <pre
            data-newamp-plain-lyrics
            className="whitespace-pre-wrap px-6 py-4 text-[13px] leading-[1.7]"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}
          >
            {lyrics.plain}
          </pre>
        ) : (
          <div
            className="flex h-full items-center justify-center px-6 text-center text-[12px]"
            style={{ color: 'var(--muted)' }}
          >
            {status === 'loading'
              ? 'fetching lyrics…'
              : 'No lyrics found on LRCLIB. Contribute synced lyrics at lrclib.net.'}
          </div>
        )}
      </div>
    </div>
  );
}

function findActive(lines: LrcLine[], t: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i]?.time ?? 0) <= t) idx = i;
    else break;
  }
  return idx;
}

function lyricsSourceLabel(source: LyricSource): string {
  if (source === 'sidecar') return 'Local Lyrics';
  if (source === 'custom') return 'Saved Lyrics';
  return 'LRC Lyrics · lrclib.net';
}

function lrcLinesToText(lines: LrcLine[]): string {
  return lines.map((line) => `[${formatLrcTime(line.time)}]${line.text}`).join('\n');
}

function formatLrcTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const centiseconds = Math.round((safe % 1) * 100);
  const totalSeconds = Math.floor(safe) + (centiseconds === 100 ? 1 : 0);
  const minutes = Math.floor(totalSeconds / 60);
  const wholeSeconds = totalSeconds % 60;
  const hundredths = centiseconds === 100 ? 0 : centiseconds;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

function lyricsFromPayload(payload: LyricPayload): {
  lyrics: { plain?: string | null; lines: LrcLine[] | null };
  status: LyricStatus;
} {
  if (payload.syncedLyrics) {
    const lines = parseLrc(payload.syncedLyrics);
    if (lines.length) return { lyrics: { lines, plain: payload.plainLyrics }, status: 'ok' };
  }
  if (payload.plainLyrics) return { lyrics: { lines: null, plain: payload.plainLyrics }, status: 'ok' };
  if (payload.instrumental) return { lyrics: { lines: null, plain: '(instrumental)' }, status: 'ok' };
  return { lyrics: { lines: null, plain: null }, status: 'none' };
}
