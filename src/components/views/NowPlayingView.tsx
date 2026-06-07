// Bloomberg-density Now Playing view, ported from claude-design reference
// 346c1cdba95b. Three-column main layout: album+queue / spectrum+VU+waveform /
// LRC lyrics. Top status strip carries hex badge + track stats. Everything
// pulls live state from the audio engine.

import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { usePlayerStore, engine } from '../../store/usePlayerStore';
import { fetchLyrics, parseLrc, type LrcLine } from '../../api/lrclib';
import { fetchArtistFacts, type ArtistFact } from '../../api/artistFacts';
import { fetchAlbumFacts, type AlbumFact } from '../../api/albumFacts';
import { formatTime, playbackCodecLabel } from '../../lib/format';
import { api, winctl } from '../../lib/api';
import { aiAssistSummary } from '../../lib/aiAssist';
import { musicEntitySearchText, wikipediaSearchUrl } from '../../lib/wiki';
import { ScoreRating } from '../ScoreRating';
import { LinerNotesPanel } from '../LinerNotesPanel';
import { classifyAudioQuality } from '@shared/audio-quality';

type SideTab = 'on-air' | 'album' | 'lyrics';
type SpectrumStyle = 'classic' | 'wide' | 'needles' | 'stacked';
import type { LocalLyricsResult, SimilarTrack, SmartPlaylistRule, Track, TrackBookmark } from '@shared/types';
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

type LyricPayload = Partial<Pick<LocalLyricsResult, 'plainLyrics' | 'syncedLyrics'>> & {
  instrumental?: boolean;
};
type LyricStatus = 'idle' | 'loading' | 'none' | 'ok';
type LyricSource = 'sidecar' | 'custom' | 'lrclib' | null;
type LyricsDraftMode = 'plain' | 'synced';
const LYRICS_TEXT_SCALE_KEY = 'newamp:lyrics:textScale';

function clampLyricsTextScale(value: number): number {
  return Math.max(0.75, Math.min(2.4, Math.round(value * 20) / 20));
}

export function NowPlayingView(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const toggleLove = usePlayerStore((s) => s.toggleLove);
  const setTrackRating = usePlayerStore((s) => s.setTrackRating);
  const setTrackRatingScore = usePlayerStore((s) => s.setTrackRatingScore);
  const toggleAvoidAutoPlay = usePlayerStore((s) => s.toggleAvoidAutoPlay);
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
  const navigateToArtist = usePlayerStore((s) => s.navigateToArtist);
  const navigateToAlbum = usePlayerStore((s) => s.navigateToAlbum);
  const settings = usePlayerStore((s) => s.settings);

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
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [lyricsKaraokeMode, setLyricsKaraokeMode] = useState(false);
  const [lyricsTextScale, setLyricsTextScale] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const parsed = Number.parseFloat(window.localStorage.getItem(LYRICS_TEXT_SCALE_KEY) ?? '');
    return Number.isFinite(parsed) ? clampLyricsTextScale(parsed) : 1;
  });
  const [practiceLoop, setPracticeLoop] = useState<PracticeLoop>({
    start: null,
    end: null,
    enabled: false,
  });
  const [sideTab, setSideTab] = useState<SideTab>(() => {
    if (typeof window === 'undefined') return 'on-air';
    const saved = window.localStorage.getItem('newamp:np:sideTab');
    return saved === 'album' || saved === 'lyrics' || saved === 'on-air' ? saved : 'on-air';
  });
  const [spectrumStyle, setSpectrumStyle] = useState<SpectrumStyle>(() => {
    if (typeof window === 'undefined') return 'classic';
    const saved = window.localStorage.getItem('newamp:np:spectrumStyle');
    return saved === 'wide' || saved === 'needles' || saved === 'stacked' ? saved : 'classic';
  });
  const [spectrumFrac, setSpectrumFrac] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.42;
    const raw = window.localStorage.getItem('newamp:np:spectrumFrac');
    const parsed = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(parsed) ? Math.min(0.7, Math.max(0.2, parsed)) : 0.42;
  });

  useEffect(() => {
    window.localStorage.setItem('newamp:np:sideTab', sideTab);
  }, [sideTab]);

  useEffect(() => {
    window.localStorage.setItem('newamp:np:spectrumStyle', spectrumStyle);
  }, [spectrumStyle]);

  useEffect(() => {
    window.localStorage.setItem(LYRICS_TEXT_SCALE_KEY, String(lyricsTextScale));
  }, [lyricsTextScale]);

  useEffect(() => {
    if (!lyricsKaraokeMode) return undefined;
    void winctl.setFullscreen(true);
    return () => {
      void winctl.setFullscreen(false);
    };
  }, [lyricsKaraokeMode]);

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
    () => (current ? api.getArtUrl(current.id) : null),
    [current?.id],
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

  async function exportCurrentWav(): Promise<void> {
    if (!current || exportBusy) return;
    setExportBusy(true);
    setExportMessage(null);
    try {
      const result = await api.exportTrackWav(current.id);
      setExportMessage(result ? `Exported WAV (${formatBytes(result.bytes)}).` : 'Export canceled.');
    } catch (err) {
      setExportMessage(err instanceof Error ? err.message : 'WAV export failed.');
    } finally {
      setExportBusy(false);
    }
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
          {settings?.replayGain !== 'off' ? <StatusPill on text="RG" /> : null}
          <span style={{ color: 'var(--muted)' }}>
            OUTPUT · WASAPI · {fmtKbps} · {fmtRate}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {activeStationName ? (
            <>
              <button className="pxbtn px-2 py-[2px] text-[10px]" onClick={() => setView('playlist')} title={activeStationName}>
                {activeStationName} / {Math.max(0, queue.length - Math.max(queueIndex, 0) - 1)} left / goal {autoDjTarget}
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
        className="newamp-now-grid grid flex-1 overflow-hidden"
      >
        {/* --- Album side --- */}
        <div
          className="flex flex-col overflow-hidden"
          style={{ background: 'var(--panel)', borderRight: '1px solid var(--line)' }}
        >
          <button
            type="button"
            onClick={() => setFs(true)}
            className="newamp-now-art relative shrink-0"
            data-newamp-open-visualizer
            style={{
              background: 'var(--panel-2)',
              borderBottom: '1px solid var(--line)',
              overflow: 'hidden',
            }}
            title="Open fullscreen visualizer"
          >
            <AlbumArtPlaceholder label={current.album || current.title} />
            {artUrl ? (
              <img
                src={artUrl}
                alt={current.album}
                className={isPlaying ? 'pulse-soft' : ''}
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
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
            onSetRatingScore={(score) => void setTrackRatingScore(current.id, score)}
            onToggleAvoid={() => void toggleAvoidAutoPlay(current.id)}
            onShowInFolder={() => void api.showInFolder(current.path)}
            onExportWav={() => void exportCurrentWav()}
            exportBusy={exportBusy}
            exportMessage={exportMessage}
            codecHint={codecHint}
            artistHref={wikipediaSearchUrl(musicEntitySearchText(current.artist, 'musician'))}
            albumHref={current.album ? wikipediaSearchUrl(musicEntitySearchText(current.artist, current.album, 'album')) : null}
            navigateToArtist={navigateToArtist}
            navigateToAlbum={navigateToAlbum}
          />

          <div
            className="newamp-right-grid grid overflow-hidden"
            style={{
              borderTop: '1px solid var(--line)',
              '--newamp-spectrum-frac': `${(spectrumFrac * 100).toFixed(2)}%`,
            } as CSSProperties}
          >
            <SpectrumPanel
              current={current}
              currentTime={currentTime}
              duration={current.duration ?? 0}
              aiAssistReady={!!settings?.openaiApiKey}
              aiModel={settings?.openaiModel ?? null}
              spectrumStyle={spectrumStyle}
              onSpectrumStyleChange={setSpectrumStyle}
            />
            <SplitHandle
              orientation="vertical"
              onDrag={(frac) => {
                const next = Math.min(0.7, Math.max(0.2, frac));
                setSpectrumFrac(next);
                window.localStorage.setItem('newamp:np:spectrumFrac', String(next));
              }}
            />
            <div className="newamp-side-stack flex min-h-0 flex-col overflow-hidden">
              <ArtistImageStage artist={current.artist} />
              <div
                className="side-tab-bar"
                role="tablist"
                aria-label="Now Playing side panel"
              >
                <SideTabButton active={sideTab === 'on-air'} onClick={() => setSideTab('on-air')}>
                  On Air
                </SideTabButton>
                <SideTabButton active={sideTab === 'album'} onClick={() => setSideTab('album')}>
                  Album
                </SideTabButton>
                <SideTabButton active={sideTab === 'lyrics'} onClick={() => setSideTab('lyrics')}>
                  Lyrics
                </SideTabButton>
              </div>
              <div className="side-tab-body flex min-h-0 flex-1 flex-col overflow-hidden">
                {sideTab === 'on-air' ? (
                  <LinerNotesPanel
                    track={current}
                    lyrics={{ lines: lyrics.lines, plain: lyrics.plain }}
                    aiAssistReady={!!settings?.openaiApiKey}
                    aiModel={settings?.openaiModel ?? null}
                  />
                ) : sideTab === 'album' ? (
                  <div className="flex min-h-0 flex-col overflow-y-auto">
                    <AlbumContextPanel track={current} />
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
                  </div>
                ) : (
                  <LyricsPanel
                    lyrics={lyrics}
                    activeIdx={activeIdx}
                    status={lyricStatus}
                    source={lyricSource}
                    editorOpen={lyricsEditorOpen}
                    draft={lyricsDraft}
                    draftMode={lyricsDraftMode}
                    message={lyricsMessage}
                    karaokeMode={lyricsKaraokeMode}
                    textScale={lyricsTextScale}
                    onTextScaleChange={setLyricsTextScale}
                    onToggleKaraoke={() => setLyricsKaraokeMode(true)}
                    onOpenEditor={openLyricsEditor}
                    onDraftChange={setLyricsDraft}
                    onDraftModeChange={setLyricsDraftMode}
                    onSaveCustom={() => void saveCustomLyrics()}
                    onClearCustom={() => void clearCustomLyrics()}
                    onCancelEditor={() => setLyricsEditorOpen(false)}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {lyricsKaraokeMode && (
        <KaraokeOverlay
          lyrics={lyrics}
          activeIdx={activeIdx}
          status={lyricStatus}
          source={lyricSource}
          currentTime={currentTime}
          current={current}
          textScale={lyricsTextScale}
          onTextScaleChange={setLyricsTextScale}
          onExit={() => setLyricsKaraokeMode(false)}
        />
      )}
    </div>
  );
}

/* ============================================================ */
/*  Sub-components                                                */
/* ============================================================ */

function AlbumArtPlaceholder({ label }: { label: string }): JSX.Element {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'NP';

  return (
    <div className="album-art-placeholder flex h-full w-full items-center justify-center">
      <span>{initials}</span>
    </div>
  );
}

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
  // All three parts use the local timezone (en-CA renders YYYY-MM-DD) so the
  // weekday, date, and time can't disagree across a UTC/local midnight.
  const ts = `${now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} ${now.toLocaleDateString(
    'en-CA',
  )} · ${now.toLocaleTimeString([], { hour12: false })}`;
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
  onSetRatingScore,
  onToggleAvoid,
  onShowInFolder,
  onExportWav,
  exportBusy,
  exportMessage,
  codecHint,
  artistHref,
  albumHref,
  navigateToArtist,
  navigateToAlbum,
}: {
  current: Track;
  onLove: () => void;
  onSetRating: (rating: number) => void;
  onSetRatingScore: (score: number | null) => void;
  onToggleAvoid: () => void;
  onShowInFolder: () => void;
  onExportWav: () => void;
  exportBusy: boolean;
  exportMessage: string | null;
  codecHint: string;
  artistHref: string;
  albumHref: string | null;
  navigateToArtist: (name: string) => void;
  navigateToAlbum: (album: string, albumArtist: string) => void;
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
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          {/* Artist/album are in-app navigation actions: clicking jumps to
              the Artists or Albums view filtered to that entity. The
              external Wikipedia search now lives behind the small ↗ icons
              next to each name so the dominant click still routes the user
              into their own library context. */}
          <button
            type="button"
            data-newamp-now-playing-artist-nav
            className="truncate underline-offset-2 hover:underline"
            style={{ color: 'var(--accent)', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
            onClick={() => navigateToArtist(current.artist)}
            title={`Show all ${current.artist} albums in your library`}
          >
            {current.artist}
          </button>
          <a
            href={artistHref}
            target="_blank"
            rel="noreferrer"
            data-newamp-now-playing-artist-link
            style={{ color: 'var(--ink-2)', fontSize: '11px', textDecoration: 'none' }}
            title={`Open Wikipedia for ${current.artist}`}
          >
            ↗
          </a>
          {current.album ? (
            <>
              <span style={{ color: 'var(--muted)' }}>/</span>
              <button
                type="button"
                data-newamp-now-playing-album-nav
                className="truncate underline-offset-2 hover:underline"
                style={{ color: 'var(--ink-2)', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() => navigateToAlbum(current.album, current.albumArtist || current.artist)}
                title={`Show ${current.album} in Albums`}
              >
                {current.album}
              </button>
              <a
                href={albumHref ?? wikipediaSearchUrl(musicEntitySearchText(current.artist, current.album, 'album'))}
                target="_blank"
                rel="noreferrer"
                data-newamp-now-playing-album-link
                style={{ color: 'var(--ink-2)', fontSize: '11px', textDecoration: 'none' }}
                title={`Open Wikipedia for ${current.album}`}
              >
                ↗
              </a>
            </>
          ) : null}
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
          <button
            type="button"
            data-now-playing-avoid-autoplay
            onClick={onToggleAvoid}
            className="border px-[6px] text-[9px] uppercase tracking-[0.1em]"
            style={{
              borderColor: current.avoidAutoPlay ? 'var(--warn)' : 'var(--line)',
              color: current.avoidAutoPlay ? 'var(--warn)' : 'var(--ink-2)',
            }}
            title={current.avoidAutoPlay ? 'Excluded from Auto DJ and generated mixes' : 'Allow in Auto DJ and generated mixes'}
          >
            {current.avoidAutoPlay ? 'avoid Auto DJ' : 'Auto DJ ok'}
          </button>
          <TrackRating value={current.rating} onChange={onSetRating} />
          <div className="score-rating-shell">
            <span className="score-rating-shell-label">Song</span>
            <ScoreRating
              value={current.ratingScore}
              stars={current.rating}
              onChange={onSetRatingScore}
            />
          </div>
          <AlbumScoreInline track={current} />
          <button
            type="button"
            data-now-playing-show-in-folder
            onClick={onShowInFolder}
            className="border px-[6px] text-[9px] uppercase tracking-[0.1em]"
            style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
            title={current.path}
          >
            Show in folder
          </button>
          <button
            type="button"
            data-export-track-wav
            onClick={onExportWav}
            disabled={exportBusy}
            className="border px-[6px] text-[9px] uppercase tracking-[0.1em] disabled:opacity-50"
            style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
            title="Export current track as WAV"
          >
            {exportBusy ? 'Exporting WAV' : 'Export WAV'}
          </button>
          {exportMessage ? (
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
              {exportMessage}
            </span>
          ) : null}
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

/**
 * Album-level rating slider that lives next to the per-song slider in the
 * Now Playing header. Loads the stored album rating from the library on
 * track change, and writes back to album_ratings (NOT to the track table)
 * so the album score and the per-song scores stay independent.
 *
 * Album-artist fallback: a track with empty `albumArtist` tag but a valid
 * `artist` still appears in AlbumsView via the SQL `COALESCE(NULLIF(...))`
 * grouping. Mirror that fallback here so those albums can also be rated.
 */
function AlbumScoreInline({ track }: { track: Track }): JSX.Element | null {
  const [albumRating, setAlbumRating] = useState<{ rating: number; ratingScore: number | null } | null>(null);
  const writeGenRef = useRef(0);
  // Mirror the SQL `COALESCE(NULLIF(album_artist,''), artist)` fallback so a
  // track tagged with an Artist but empty AlbumArtist can still be rated.
  const ratingArtist = track.albumArtist || track.artist;
  const albumKey = `${ratingArtist}|${track.album}`;

  useEffect(() => {
    let cancelled = false;
    if (!track.album || !ratingArtist) {
      setAlbumRating(null);
      return;
    }
    void api
      .getAlbumRating(ratingArtist, track.album)
      .then((row) => {
        if (cancelled) return;
        setAlbumRating(
          row ? { rating: row.rating, ratingScore: row.ratingScore } : { rating: 0, ratingScore: null },
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // Don't silently replace the prior value with 0/null — that's the
        // 1.5.4-class anti-pattern where a transient IPC failure looked
        // identical to "user never rated this album" and the next slider
        // drag would silently overwrite the real stored rating. Keep the
        // previous state and surface the failure in the console.
        console.error('[newamp] getAlbumRating failed:', { albumKey, err });
        setAlbumRating((prev) => prev ?? { rating: 0, ratingScore: null });
      });
    return () => {
      cancelled = true;
    };
    // `albumKey` is a pure function of `ratingArtist` + `track.album` —
    // listing the two raw deps too is redundant. ESLint exhaustive-deps
    // wants the raw values; the derived key is sufficient because its
    // string identity changes iff the raw deps change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumKey]);

  if (!track.album || !ratingArtist) return null;

  async function handleChange(score: number | null): Promise<void> {
    // Write-generation guard: a slow IPC followed by a fast track-skip
    // must not let the previous track's resolved write overwrite the new
    // track's displayed rating. Capture the gen + the (artist, album)
    // pair at call time and bail if either has changed when the IPC
    // resolves.
    const myGen = ++writeGenRef.current;
    const writeArtist = ratingArtist;
    const writeAlbum = track.album;
    try {
      const updated = await api.setAlbumRatingScore(writeArtist, writeAlbum, score);
      if (writeGenRef.current !== myGen) return;
      if (writeArtist !== ratingArtist || writeAlbum !== track.album) return;
      setAlbumRating(
        updated ? { rating: updated.rating, ratingScore: updated.ratingScore } : { rating: 0, ratingScore: null },
      );
    } catch (err) {
      console.error('[newamp] setAlbumRatingScore failed:', { writeArtist, writeAlbum, score, err });
      // Leave the prior state in place so the user sees the value that
      // is actually stored on disk, not a fake "cleared" zero.
    }
  }

  return (
    <div className="score-rating-shell" data-newamp-now-playing-album-rating>
      <span className="score-rating-shell-label">Album</span>
      <ScoreRating
        value={albumRating?.ratingScore ?? null}
        stars={albumRating?.rating ?? 0}
        onChange={(score) => void handleChange(score)}
      />
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
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

const SPECTRUM_STYLES: { id: SpectrumStyle; label: string; shortLabel: string }[] = [
  { id: 'classic', label: 'Classic 24-band analyzer', shortLabel: '24' },
  { id: 'wide', label: 'Wide 12-band analyzer', shortLabel: '12' },
  { id: 'needles', label: 'Needle peaks', shortLabel: 'PK' },
  { id: 'stacked', label: 'Stacked block spectrum', shortLabel: 'STK' },
];

function spectrumBandCount(style: SpectrumStyle): number {
  if (style === 'wide') return 12;
  if (style === 'needles') return 36;
  return 24;
}

function SpectrumPanel({
  current,
  currentTime,
  duration,
  aiAssistReady,
  aiModel,
  spectrumStyle,
  onSpectrumStyleChange,
}: {
  current: Track;
  currentTime: number;
  duration: number;
  aiAssistReady: boolean;
  aiModel: string | null;
  spectrumStyle: SpectrumStyle;
  onSpectrumStyleChange: (style: SpectrumStyle) => void;
}): JSX.Element {
  const barsRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);
  const seek = usePlayerStore((s) => s.seek);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const barCount = spectrumBandCount(spectrumStyle);

  useEffect(() => {
    const bars = spectrumBandCount(spectrumStyle);
    // Don't run the analyser rAF while paused — there's no signal to draw and
    // it was burning a frame budget on the Now Playing screen indefinitely.
    // Park the bars low so they don't freeze mid-spectrum.
    if (!isPlaying) {
      const container = barsRef.current;
      if (container) {
        for (let i = 0; i < bars; i++) {
          const bar = container.children.item(i) as HTMLElement | null;
          if (bar) bar.style.height = '2%';
        }
      }
      return;
    }
    const freq = new Uint8Array(engine.frequencyBinCount);
    const peaks = new Float32Array(bars);
    let raf = 0;
    const tick = (): void => {
      engine.getFreqData(freq as Uint8Array<ArrayBuffer>);
      const container = barsRef.current;
      const peakContainer = peakRef.current;
      if (!container) {
        raf = requestAnimationFrame(tick);
        return;
      }
      for (let i = 0; i < bars; i++) {
        const curve = spectrumStyle === 'wide' ? 1.35 : 2;
        const lo = Math.floor(Math.pow(i / bars, curve) * freq.length);
        const hi = Math.floor(Math.pow((i + 1) / bars, curve) * freq.length);
        let max = 0;
        for (let k = lo; k < hi && k < freq.length; k++) {
          if ((freq[k] ?? 0) > max) max = freq[k] ?? 0;
        }
        const norm = max / 255;
        const falloff = spectrumStyle === 'needles' ? 0.022 : 0.012;
        peaks[i] = Math.max(peaks[i]! - falloff, norm);
        const bar = container.children.item(i) as HTMLElement | null;
        if (bar) {
          const nextHeight = spectrumStyle === 'stacked'
            ? Math.max(4, Math.round(norm * 10) * 10)
            : Math.max(2, norm * 100);
          bar.style.height = `${nextHeight}%`;
        }
        const peak = peakContainer?.children.item(i) as HTMLElement | null;
        if (peak) peak.style.bottom = `${Math.max(0, peaks[i]! * 100 - 1)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spectrumStyle, isPlaying]);

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
        <div className="flex items-center gap-1" data-newamp-spectrum-style-picker>
          {SPECTRUM_STYLES.map((style) => (
            <button
              key={style.id}
              className={`pxbtn ${spectrumStyle === style.id ? 'is-active' : ''}`}
              onClick={() => onSpectrumStyleChange(style.id)}
              title={style.label}
            >
              {style.shortLabel}
            </button>
          ))}
        </div>
      </div>

      <div className={`spectrum-stage is-${spectrumStyle} relative`} style={{ height: 120 }}>
        <div
          ref={barsRef}
          className="absolute inset-0 flex items-end gap-[2px]"
        >
          {Array.from({ length: barCount }, (_, i) => (
            <div
              key={i}
              className="spectrum-bar flex-1"
              style={{
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
          {Array.from({ length: barCount }, (_, i) => (
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

      <TrackSignalPanel
        track={current}
        currentTime={currentTime}
        duration={duration}
        aiAssistReady={aiAssistReady}
        aiModel={aiModel}
      />

      <SoundsLikePanel trackId={current.id} />

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
        <WaveformOverview currentTime={currentTime} duration={duration} onSeek={seek} />
      </div>
    </div>
  );
}

function AlbumContextPanel({ track }: { track: Track }): JSX.Element {
  const deferredTrack = useDeferredValue(track);
  const [albumTracks, setAlbumTracks] = useState<Track[]>([]);
  const [sameYearAlbums, setSameYearAlbums] = useState<{ album: string; albumArtist: string; year: number | null }[]>([]);
  const [fact, setFact] = useState<AlbumFact | null>(null);
  const [artistFallback, setArtistFallback] = useState<ArtistFact | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'none' | 'ok'>('idle');

  useEffect(() => {
    const album = deferredTrack.album;
    const albumArtist = deferredTrack.albumArtist || deferredTrack.artist;
    if (!album || album === 'Unknown Album') {
      setAlbumTracks([]);
      setSameYearAlbums([]);
      setFact(null);
      setArtistFallback(null);
      setStatus('idle');
      return;
    }

    const ctrl = new AbortController();
    setStatus('loading');
    void (async () => {
      const [tracks, nextFact] = await Promise.all([
        api.getAlbumTracks(albumArtist, album).catch(() => []),
        fetchAlbumFacts(album, albumArtist, ctrl.signal).catch(() => null),
      ]);
      if (ctrl.signal.aborted) return;
      const albumYear = deferredTrack.year ?? tracks.find((item) => item.year)?.year ?? null;
      const albums = albumYear == null
        ? []
        : await api.getAlbums({
          year: albumYear,
          yearWindow: 0,
          excludeAlbum: album,
          excludeAlbumArtist: albumArtist,
          limit: 4,
        }).catch(() => []);
      if (ctrl.signal.aborted) return;
      setAlbumTracks(tracks);
      setSameYearAlbums(
        albums
          .filter((item) =>
            item.album !== album &&
            item.year != null &&
            albumYear != null &&
            item.year === albumYear)
          .slice(0, 4)
          .map((item) => ({ album: item.album, albumArtist: item.albumArtist, year: item.year })),
      );
      setFact(nextFact);
      // If Wikipedia couldn't locate the specific album, fall back to the
      // artist's Wikipedia page so the user still gets real context instead
      // of an empty panel. This is what makes the album tab non-useless.
      if (!nextFact && albumArtist) {
        const artistInfo = await fetchArtistFacts(albumArtist, ctrl.signal).catch(() => null);
        if (!ctrl.signal.aborted) setArtistFallback(artistInfo);
      } else {
        setArtistFallback(null);
      }
      setStatus(nextFact ? 'ok' : 'none');
    })();
    return () => ctrl.abort();
  }, [deferredTrack.album, deferredTrack.albumArtist, deferredTrack.artist, deferredTrack.year]);

  const albumYear = deferredTrack.year ?? albumTracks.find((item) => item.year)?.year ?? null;
  const duration = albumTracks.reduce((sum, item) => sum + (item.duration ?? 0), 0);
  const knownCredits = albumTracks
    .flatMap((item) => [item.artist, item.albumArtist])
    .filter((value): value is string => Boolean(value && value !== 'Unknown Artist'));
  const creditNames = Array.from(new Set(knownCredits)).slice(0, 6);
  const releaseNote = albumReleaseNote(fact, albumYear);
  const scoreValues = albumTracks
    .map((item) => item.ratingScore ?? item.rating * 20)
    .filter((score) => Number.isFinite(score) && score > 0);
  // Only treat the per-track average as an album-level signal when the user
  // has actually rated most of the album. A single rated song shouldn't make
  // the "Library signal" line look like the album received a rating.
  const ratedCount = scoreValues.length;
  const totalAlbumTracks = albumTracks.length || 0;
  const meaningfulSample = ratedCount >= 3 || (totalAlbumTracks > 0 && ratedCount / totalAlbumTracks >= 0.5);
  const averageScore = meaningfulSample
    ? Math.round(scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length)
    : null;
  const lovedCount = albumTracks.filter((item) => item.loved).length;
  const totalPlays = albumTracks.reduce((sum, item) => sum + item.playCount, 0);
  const sortedAlbumTracks = [...albumTracks].sort(albumTrackOrder);
  const opener = sortedAlbumTracks[0] ?? null;
  const closer = sortedAlbumTracks[sortedAlbumTracks.length - 1] ?? null;
  const longestTrack = albumTracks.reduce<Track | null>(
    (best, item) => (!best || (item.duration ?? 0) > (best.duration ?? 0) ? item : best),
    null,
  );
  const albumShape = albumShapeNote(albumTracks, averageScore, lovedCount, totalPlays);

  return (
    <section className="album-context-panel" data-newamp-album-context-panel>
      <div className="album-context-head">
        <div>
          <span>Album Context</span>
          <strong>{deferredTrack.album || 'Unknown Album'}</strong>
        </div>
        <div className="album-context-meta">
          <span>{albumYear ?? 'year unset'}</span>
          <span>{albumTracks.length || 1} track{albumTracks.length === 1 ? '' : 's'}</span>
          <span>{duration ? formatTime(duration) : 'duration unknown'}</span>
        </div>
      </div>

      {fact ? (
        <a href={fact.url} target="_blank" rel="noreferrer" className="album-context-story">
          {fact.imageUrl && <img src={fact.imageUrl} alt={fact.title} draggable={false} />}
          <span>
            <strong>{fact.title}</strong>
            {fact.description && <em>{fact.description}</em>}
            <small className="album-context-summary">{fact.summary}</small>
          </span>
        </a>
      ) : artistFallback ? (
        <a href={artistFallback.url} target="_blank" rel="noreferrer" className="album-context-story" data-newamp-album-context-artist-fallback>
          {artistFallback.imageUrl && <img src={artistFallback.imageUrl} alt={artistFallback.title} draggable={false} />}
          <span>
            <strong>About {artistFallback.title}</strong>
            {artistFallback.description && <em>{artistFallback.description}</em>}
            <small className="album-context-summary">
              {artistFallback.summary}
            </small>
            <small className="album-context-summary" style={{ opacity: 0.7, fontStyle: 'italic' }}>
              No Wikipedia page for this album yet — showing the artist instead.
            </small>
          </span>
        </a>
      ) : (
        <div className="album-context-empty">
          {status === 'loading'
            ? 'Looking for release notes and album story...'
            : 'No online album story found yet. Local tags still build the release card below.'}
        </div>
      )}

      <div className="album-context-grid">
        <div>
          <span>Credits from tags</span>
          <strong>{creditNames.length ? creditNames.join(' / ') : deferredTrack.albumArtist || deferredTrack.artist}</strong>
        </div>
        <div>
          <span>Release notes</span>
          <strong>{releaseNote}</strong>
        </div>
        <div>
          <span>Same-year in your library</span>
          <strong>
            {sameYearAlbums.length
              ? sameYearAlbums.map((item) => `${item.albumArtist} - ${item.album} (${item.year})`).join(' / ')
              : albumYear ? `No other local albums tagged ${albumYear}.` : 'Add release years to compare local era matches.'}
          </strong>
        </div>
      </div>

      <div className="album-context-insights" data-newamp-album-context-insights>
        <AlbumInsight label="Album shape" value={albumShape} />
        <AlbumInsight label="Bookends" value={opener && closer ? `${opener.title} / ${closer.title}` : 'Track order is not tagged yet.'} />
        <AlbumInsight
          label="Your album signal"
          value={
            averageScore != null
              ? `${averageScore}/100 avg across ${ratedCount} rated tracks / ${lovedCount} loved / ${totalPlays.toLocaleString()} plays`
              : ratedCount > 0
                ? `${ratedCount} of ${totalAlbumTracks} tracks rated / ${lovedCount} loved / ${totalPlays.toLocaleString()} plays`
                : `unrated / ${lovedCount} loved / ${totalPlays.toLocaleString()} plays`
          }
        />
        <AlbumInsight label="Longest cut" value={longestTrack ? `${longestTrack.title} (${formatTime(longestTrack.duration ?? 0)})` : 'Duration tags are missing.'} />
      </div>

      {albumTracks.length > 1 && (
        <ol className="album-context-tracklist">
          {albumTracks.slice(0, 10).map((item) => (
            <li key={item.id}>
              <span>{item.trackNo ?? '-'}</span>
              <strong>{item.title}</strong>
              <em>{item.duration ? formatTime(item.duration) : '--:--'}</em>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AlbumInsight({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function albumTrackOrder(a: Track, b: Track): number {
  return (a.discNo ?? 1) - (b.discNo ?? 1) ||
    (a.trackNo ?? Number.MAX_SAFE_INTEGER) - (b.trackNo ?? Number.MAX_SAFE_INTEGER) ||
    a.title.localeCompare(b.title);
}

function albumShapeNote(tracks: Track[], averageScore: number | null, lovedCount: number, totalPlays: number): string {
  if (!tracks.length) return 'Waiting for local album tracks.';
  const minutes = Math.round(tracks.reduce((sum, item) => sum + (item.duration ?? 0), 0) / 60);
  const hasSignal = averageScore != null || lovedCount > 0 || totalPlays > 0;
  if (hasSignal) {
    return `${tracks.length} tracks / ${minutes || '?'} min / ${averageScore ?? '--'} avg score`;
  }
  return `${tracks.length} tracks / ${minutes || '?'} min / ready for rating and plays`;
}

function albumReleaseNote(fact: AlbumFact | null, albumYear: number | null): string {
  const summary = fact?.summary?.trim() ?? '';
  const releaseSentence = summary
    .split(/(?<=[.!?])\s+/)
    .find((sentence) => /\breleased\b/i.test(sentence) && sentence.length <= 260);
  if (releaseSentence) return releaseSentence;
  if (albumYear) return `Tagged release year: ${albumYear}.`;
  return 'No reliable release date found yet.';
}

function TrackSignalPanel({
  track,
  currentTime,
  duration,
  aiAssistReady,
  aiModel,
}: {
  track: Track;
  currentTime: number;
  duration: number;
  aiAssistReady: boolean;
  aiModel: string | null;
}): JSX.Element {
  const quality = classifyAudioQuality(track);
  const folder = parentFolder(track.path);
  const elapsed = duration > 0 ? currentTime / duration : 0;
  const density = quality.densityBytesPerSecond;
  const archiveFlags = quality.flags.length ? quality.flags.join(' / ') : 'Archive signal clean';
  const chips = [
    ['FORMAT', quality.displayExt],
    ['ARCHIVE', quality.family.toUpperCase()],
    ['DECODE', quality.decodePath === 'ffmpeg-pcm-fallback' ? 'FFMPEG PCM' : 'NATIVE'],
    ['BITRATE', track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : 'unknown'],
    ['RATE', track.sampleRate ? `${(track.sampleRate / 1000).toFixed(track.sampleRate % 1000 === 0 ? 0 : 1)} kHz` : 'unknown'],
    ['SIZE', formatOptionalBytes(track.size)],
    ['RG', replayGainLabel(track)],
    ['BPM', track.bpm ? `${Math.round(track.bpm)}` : 'unset'],
    ['KEY', track.key || 'unset'],
  ] as const;

  return (
    <section className="track-signal-panel" data-newamp-track-signal-panel>
      <div className="track-signal-head">
        <span>Signal Bay</span>
        <strong>{quality.label}</strong>
      </div>
      <div className="track-signal-chips">
        {chips.map(([label, value]) => (
          <div key={label} className="track-signal-chip">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="track-signal-strip">
        <span style={{ width: `${Math.max(2, Math.min(100, elapsed * 100))}%` }} />
      </div>
      <div className="track-signal-detail">
        <span title={folder}>{folder || 'No folder path'}</span>
        <span>{track.year ?? 'year unset'} / {track.genre || 'genre unset'}</span>
        <span>{track.playCount} plays / {track.skipCount} skips</span>
        <span>{density ? `${formatBytes(density)}/s` : 'density unknown'}</span>
        <span title={archiveFlags}>{archiveFlags}</span>
      </div>
      <div className="track-signal-ai">
        <span>{aiAssistReady ? `ChatGPT assist ready: ${aiModel || 'model set'}` : 'ChatGPT assist: add your API key in Settings'}</span>
        <span>{aiAssistSummary()}</span>
      </div>
    </section>
  );
}

function SoundsLikePanel({ trackId }: { trackId: number }): JSX.Element | null {
  const [similar, setSimilar] = useState<SimilarTrack[]>([]);
  const [needsAnalysis, setNeedsAnalysis] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playQueue = usePlayerStore((s) => s.playQueue);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setNeedsAnalysis(false);
    setSimilar([]);
    void (async () => {
      const dna = await api.getTrackDna(trackId);
      if (cancelled) return;
      if (!dna) {
        setNeedsAnalysis(true);
        return;
      }
      const matches = await api.findSimilarTracks(trackId, 8);
      if (cancelled) return;
      setSimilar(matches);
    })();
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  async function analyzeNow(): Promise<void> {
    setAnalyzing(true);
    setError(null);
    try {
      const result = await api.analyzeTracksDna([trackId]);
      if (result.analyzed === 1) {
        const matches = await api.findSimilarTracks(trackId, 8);
        setSimilar(matches);
        setNeedsAnalysis(false);
      } else if (result.skipped.length) {
        setError(result.skipped[0]!);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  async function playSimilar(): Promise<void> {
    if (!similar.length) return;
    await playQueue(similar.map((s) => s.track), 0);
  }

  if (needsAnalysis) {
    return (
      <section className="bevel-out p-2" style={{ background: 'var(--panel)' }}>
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
            Sounds Like
          </span>
          <button className="pxbtn text-[10px]" onClick={() => void analyzeNow()} disabled={analyzing}>
            {analyzing ? 'Analyzing audio…' : 'Analyze DNA'}
          </button>
        </div>
        <div className="mt-1 text-[10px]" style={{ color: 'var(--muted)' }}>
          No DNA computed for this track yet. Click to extract perceptual features.
        </div>
        {error && <div className="mt-1 text-[10px]" style={{ color: 'var(--error)' }}>{error}</div>}
      </section>
    );
  }

  if (!similar.length) return null;

  return (
    <section className="bevel-out p-2" style={{ background: 'var(--panel)' }}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>
          Sounds Like
        </span>
        <span className="text-[9px]" style={{ color: 'var(--muted)' }}>
          DNA cosine match
        </span>
        <button className="pxbtn ml-auto text-[10px]" onClick={() => void playSimilar()}>
          Play set
        </button>
      </div>
      <ol className="m-0 grid gap-[2px] p-0 text-[10px]" style={{ color: 'var(--ink-2)' }}>
        {similar.slice(0, 5).map((row, idx) => (
          <li key={row.track.id} className="flex items-baseline gap-2 truncate">
            <span className="font-mono" style={{ color: 'var(--muted)', minWidth: 18 }}>
              {String(idx + 1).padStart(2, '0')}
            </span>
            <span className="truncate font-bold" style={{ color: 'var(--ink)' }}>{row.track.title}</span>
            <span className="truncate" style={{ color: 'var(--muted)' }}>· {row.track.artist}</span>
            <span className="ml-auto tabular-nums" style={{ color: 'var(--accent)' }}>
              {Math.round(row.score * 100)}%
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function parentFolder(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(Math.max(0, parts.length - 3), -1).join(' / ');
}

function formatOptionalBytes(value: number | null): string {
  if (!value || value <= 0) return 'unknown';
  return formatBytes(value);
}

function replayGainLabel(track: Track): string {
  if (track.replayGainTrackDb != null) return `track ${formatDb(track.replayGainTrackDb)}`;
  if (track.replayGainAlbumDb != null) return `album ${formatDb(track.replayGainAlbumDb)}`;
  return 'missing';
}

function formatDb(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function VuMeter(): JSX.Element {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const lRef = useRef<HTMLDivElement>(null);
  const rRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isPlaying) {
      // Drain to zero and stop — no point polling a silent analyser, and
      // querySelector-per-frame against a paused signal was pure waste.
      if (lRef.current) lRef.current.style.width = '0%';
      if (rRef.current) rRef.current.style.width = '0%';
      return;
    }
    const left = new Uint8Array(new ArrayBuffer(engine.frequencyBinCount));
    const right = new Uint8Array(new ArrayBuffer(engine.frequencyBinCount));
    let l = 0;
    let r = 0;
    let raf = 0;
    // Real per-channel level from the engine's dedicated L/R analysers (no more
    // faked *0.96 / *1.02 mono split). Mean bin energy, lightly gained so
    // typical music sits mid-scale.
    const channelLevel = (buf: Uint8Array): number => {
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]!;
      return Math.min(1, (sum / (buf.length * 255)) * 3.2);
    };
    const tick = (): void => {
      engine.getLeftFreqData(left as Uint8Array<ArrayBuffer>);
      engine.getRightFreqData(right as Uint8Array<ArrayBuffer>);
      l = Math.max(l * 0.86, channelLevel(left));
      r = Math.max(r * 0.86, channelLevel(right));
      if (lRef.current) lRef.current.style.width = `${Math.min(100, l * 100)}%`;
      if (rRef.current) rRef.current.style.width = `${Math.min(100, r * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  return (
    <div className="flex flex-col gap-1">
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
              ref={side === 'L' ? lRef : rRef}
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
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
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

  // Click or drag anywhere on the waveform to seek. Previously this big,
  // scrubber-looking surface was purely decorative — the user could only seek
  // from the small transport bar. Pointer capture keeps the drag tracking even
  // when the cursor leaves the 40px-tall strip.
  const draggingRef = useRef(false);
  const seekFromPointer = (clientX: number, target: Element): void => {
    if (duration <= 0) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(frac * duration);
  };

  return (
    <svg
      width="100%"
      height={40}
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      data-newamp-waveform-seek
      style={{ cursor: duration > 0 ? 'pointer' : 'default', touchAction: 'none' }}
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromPointer(e.clientX, e.currentTarget);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) seekFromPointer(e.clientX, e.currentTarget);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already released */
        }
      }}
    >
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
              <p className="artist-fact-summary mt-2 text-[11px] leading-[1.42]" style={{ color: 'var(--ink-2)' }}>
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
  karaokeMode,
  textScale,
  onTextScaleChange,
  onToggleKaraoke,
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
  karaokeMode: boolean;
  textScale: number;
  onTextScaleChange: (value: number) => void;
  onToggleKaraoke: () => void;
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
      data-newamp-lyrics-karaoke={karaokeMode ? 'true' : 'false'}
      data-newamp-lyrics-line-count={lyrics.lines?.length ?? 0}
      data-newamp-lyrics-plain-length={lyrics.plain?.length ?? 0}
      className="flex flex-col overflow-hidden"
      style={{ background: 'var(--bg)', '--newamp-lyric-scale': textScale } as CSSProperties}
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
        className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[10px]"
        style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
      >
        <button
          className={`pxbtn ${karaokeMode ? 'is-active' : ''}`}
          onClick={onToggleKaraoke}
          title="Center the current lyric line for sing-along playback"
        >
          Karaoke Fullscreen
        </button>
        <div className="lyrics-text-size-control" data-newamp-lyrics-size-control>
          <button className="pxbtn" onClick={() => onTextScaleChange(clampLyricsTextScale(textScale - 0.1))} title="Smaller lyrics">
            A-
          </button>
          <input
            type="range"
            min={0.75}
            max={2.4}
            step={0.05}
            value={textScale}
            onChange={(event) => onTextScaleChange(clampLyricsTextScale(Number(event.currentTarget.value)))}
            data-newamp-lyrics-size-slider
            aria-label="Lyrics text size"
          />
          <button className="pxbtn" onClick={() => onTextScaleChange(clampLyricsTextScale(textScale + 0.1))} title="Larger lyrics">
            A+
          </button>
        </div>
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
      <div ref={ref} className={`flex-1 overflow-y-auto ${karaokeMode ? 'lyrics-karaoke' : ''}`}>
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
                className="lyric-line grid items-baseline gap-[10px] px-4 py-[8px] transition-colors"
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
                  className="lyric-line-time tabular-nums"
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
            className="plain-lyrics-text whitespace-pre-wrap px-6 py-4 leading-[1.7]"
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

function KaraokeOverlay({
  lyrics,
  activeIdx,
  status,
  source,
  currentTime,
  current,
  textScale,
  onTextScaleChange,
  onExit,
}: {
  lyrics: { plain?: string | null; lines: LrcLine[] | null };
  activeIdx: number;
  status: LyricStatus;
  source: LyricSource;
  currentTime: number;
  current: Track;
  textScale: number;
  onTextScaleChange: (value: number) => void;
  onExit: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onExit();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onExit]);

  useEffect(() => {
    if (!lyrics.lines || activeIdx < 0 || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-line="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, lyrics.lines]);

  return (
    <div
      data-newamp-karaoke-fullscreen
      data-newamp-lyrics-source={source ?? ''}
      data-newamp-lyrics-status={status}
      className="karaoke-fullscreen fixed inset-0 z-[92] flex flex-col overflow-hidden"
      style={{ '--newamp-lyric-scale': textScale } as CSSProperties}
    >
      <div className="karaoke-fullscreen-header">
        <div className="min-w-0">
          <div className="karaoke-fullscreen-title" title={current.title}>{current.title}</div>
          <div className="karaoke-fullscreen-meta">
            {current.artist}{current.album ? ` / ${current.album}` : ''} / {formatTime(currentTime)}
          </div>
        </div>
        <div className="lyrics-text-size-control">
          <button className="pxbtn" onClick={() => onTextScaleChange(clampLyricsTextScale(textScale - 0.1))}>
            A-
          </button>
          <input
            type="range"
            min={0.75}
            max={2.4}
            step={0.05}
            value={textScale}
            onChange={(event) => onTextScaleChange(clampLyricsTextScale(Number(event.currentTarget.value)))}
            data-newamp-karaoke-size-slider
            aria-label="Karaoke text size"
          />
          <button className="pxbtn" onClick={() => onTextScaleChange(clampLyricsTextScale(textScale + 0.1))}>
            A+
          </button>
          <button className="pxbtn" onClick={onExit}>
            EXIT
          </button>
        </div>
      </div>
      <div ref={ref} className="karaoke-fullscreen-body lyrics-karaoke">
        {lyrics.lines ? (
          lyrics.lines.map((line, i) => {
            const state = i === activeIdx ? 'current' : i < activeIdx ? 'past' : 'upcoming';
            return (
              <div
                key={i}
                data-line={i}
                data-newamp-lyric-line
                data-newamp-lyric-time={line.time}
                data-newamp-lyric-state={state}
                className="lyric-line karaoke-line"
              >
                <span className="lyric-line-time tabular-nums">{formatTime(line.time)}</span>
                <span>{line.text || '\u266a'}</span>
              </div>
            );
          })
        ) : lyrics.plain ? (
          <pre data-newamp-plain-lyrics className="plain-lyrics-text karaoke-plain">
            {lyrics.plain}
          </pre>
        ) : (
          <div className="karaoke-empty">
            {status === 'loading' ? 'Fetching lyrics...' : 'No lyrics loaded for karaoke.'}
          </div>
        )}
      </div>
    </div>
  );
}

function SideTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`side-tab-btn ${active ? 'is-active' : ''}`}
    >
      {children}
    </button>
  );
}

function SplitHandle({
  orientation,
  onDrag,
}: {
  orientation: 'vertical' | 'horizontal';
  /** Emits the parent-relative fraction (0..1) for the pointer position at each move. */
  onDrag: (frac: number) => void;
}): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      tabIndex={0}
      className={`np-split-handle ${orientation === 'vertical' ? 'is-vertical' : 'is-horizontal'}`}
      onPointerDown={(event) => {
        event.preventDefault();
        const target = event.currentTarget;
        const parent = target.parentElement;
        if (!parent) return;
        target.setPointerCapture(event.pointerId);
        const emit = (moveEvent: { clientX: number; clientY: number }): void => {
          const rect = parent.getBoundingClientRect();
          if (orientation === 'vertical') {
            if (!rect.width) return;
            onDrag((moveEvent.clientX - rect.left) / rect.width);
          } else {
            if (!rect.height) return;
            onDrag((moveEvent.clientY - rect.top) / rect.height);
          }
        };
        emit(event);
        const move = (moveEvent: PointerEvent): void => emit(moveEvent);
        const up = (upEvent: PointerEvent): void => {
          target.releasePointerCapture(upEvent.pointerId);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
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
