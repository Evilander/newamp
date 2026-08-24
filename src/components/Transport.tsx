import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { Visualizer } from './Visualizer';
import { formatTime, playbackCodecLabel } from '../lib/format';
import { api } from '../lib/api';
import { VolumeSlider } from './VolumeSlider';
import { spectralArtDataUrl } from '@shared/spectral-art';
import { isShuffleMode, repeatModeOf } from '@shared/types';
import { PrevIcon, NextIcon, StopIcon, PlayPauseIcon, ShuffleIcon, RepeatIcon } from './TransportIcons';
import { ScrubBar } from './ScrubBar';
import { ArtistLink, AlbumLink } from './EntityLink';
import { SignalPathBadge } from './SignalPathBadge';

export function Transport(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  // NOTE: deliberately NOT subscribing to s.currentTime here — it updates
  // 10x/sec during playback and used to reconcile the whole footer (mini
  // Visualizer, links, badges, volume, buttons) on every tick. The two
  // clock-driven leaves below (TransportElapsed, TransportScrubBar)
  // subscribe to it themselves instead.
  const duration = usePlayerStore((s) => s.duration);
  const playbackError = usePlayerStore((s) => s.playbackError);
  const volume = usePlayerStore((s) => s.volume);
  const mode = usePlayerStore((s) => s.mode);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const seek = usePlayerStore((s) => s.seek);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const stop = () => usePlayerStore.getState().engine.stop();
  const setFs = usePlayerStore((s) => s.setFullscreenViz);

  const artUrl = useMemo(
    () => (current ? api.getArtUrl(current.id) : null),
    [current?.id],
  );
  // Generated spectral SVG fallback — deterministic per (artist, album), so
  // every track without embedded art still gets a consistent cover instead of
  // a music-note placeholder. Tracks across the user's library are visually
  // distinguishable even when none have folder art.
  const fallbackArtUrl = useMemo(
    () => (current ? spectralArtDataUrl({ artist: current.artist, album: current.album }, 144) : null),
    [current?.artist, current?.album],
  );
  // When the real artUrl request fails, we flip to the fallback. Tracking
  // it as state means the failed load isn't permanently hidden — switching
  // to a new track resets the flag.
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => {
    setArtFailed(false);
  }, [current?.id]);
  const shownArtUrl = artUrl && !artFailed ? artUrl : fallbackArtUrl;

  return (
    <footer
      data-newamp-transport
      data-newamp-playing={isPlaying ? 'true' : 'false'}
      className="bevel-out scanlines relative flex items-stretch gap-2 px-3 py-2"
      style={{ borderTop: '1px solid var(--line)' }}
    >
      {/* amp-art-frame: hook for the Resonance breathing ring (tokens.css
          reactive block) — a ::after halo, so it needs a positioned parent. */}
      <div className="amp-art-frame relative flex w-[88px] shrink-0 flex-col items-center justify-center gap-1 bevel-in p-1">
        {shownArtUrl ? (
          <img
            src={shownArtUrl}
            alt="cover"
            className="h-[72px] w-[72px] cursor-pointer object-cover"
            style={{ borderRadius: 'var(--radius)' }}
            onClick={() => setFs(true)}
            title="Open visualizer"
            data-newamp-open-visualizer
            data-newamp-art-source={artUrl && !artFailed ? 'embedded' : 'spectral'}
            onError={() => setArtFailed(true)}
          />
        ) : (
          <div
            className="flex h-[72px] w-[72px] cursor-pointer items-center justify-center text-[11px]"
            style={{ color: 'var(--muted)', borderRadius: 'var(--radius)' }}
            onClick={() => setFs(true)}
            title="Open visualizer"
            data-newamp-open-visualizer
          >
            ♪
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1">
        <div className="display flex h-[42px] items-center gap-3 px-3">
          <div className="flex w-[64px] flex-col items-end leading-none">
            <TransportElapsed />
            <div className="lcd-text text-[10px]" style={{ color: 'var(--ink-2)' }}>
              {formatTime(duration)}
            </div>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <div
              data-newamp-current-title={current ? `${current.artist} - ${current.title}` : ''}
              className="lcd-text text-[18px]"
              style={{ whiteSpace: 'nowrap', maxWidth: '100%', textOverflow: 'ellipsis', overflow: 'hidden' }}
              title={current ? `${current.artist} — ${current.title}` : ''}
            >
              {current ? (
                <>
                  {'★ '}
                  <ArtistLink artist={current.artist} color="inherit" title={`Show all ${current.artist} albums`} />
                  {' — '}
                  {current.title}
                  {current.album ? (
                    <>
                      {' ('}
                      <AlbumLink
                        album={current.album}
                        albumArtist={current.albumArtist || current.artist}
                        color="inherit"
                        title={`Show ${current.album} in Albums`}
                      />
                      {')'}
                    </>
                  ) : null}
                </>
              ) : (
                '— no track loaded — choose something from your library —'
              )}
            </div>
            <div className="lcd-text flex items-center gap-2 text-[11px]" style={{ color: 'var(--ink-2)' }}>
              {playbackError ? (
                <span data-newamp-playback-error style={{ color: 'var(--error)' }}>
                  {playbackError}
                </span>
              ) : (
                <>
                  <span>
                    {current ? playbackCodecLabel(current.path) : 'AUDIO'}
                    {current && current.bitrate ? `  ${Math.round(current.bitrate / 1000)} kbps` : '  --'}
                    {current && current.sampleRate ? `  ·  ${(current.sampleRate / 1000).toFixed(1)} kHz` : ''}
                    {current && current.year ? `  ·  ${current.year}` : ''}
                  </span>
                  <SignalPathBadge />
                </>
              )}
            </div>
          </div>
          <Visualizer mode="mini" width={120} height={36} />
        </div>

        <div className="flex items-center gap-2">
          <button className="pxbtn pxbtn-icon" onClick={() => void prev()} title="Previous (Ctrl+←)" aria-label="Previous track">
            <PrevIcon />
          </button>
          <button
            className="pxbtn pxbtn-icon is-primary amp-beat-scale"
            onClick={togglePlay}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            aria-pressed={isPlaying}
          >
            <PlayPauseIcon playing={isPlaying} />
          </button>
          <button className="pxbtn pxbtn-icon" onClick={stop} title="Stop" aria-label="Stop">
            <StopIcon />
          </button>
          <button className="pxbtn pxbtn-icon" onClick={() => void next()} title="Next (Ctrl+→)" aria-label="Next track">
            <NextIcon />
          </button>
          {/* amp-scrub-wrap: hook for the Resonance progress glow tail (tokens.css
              reactive block). --scrub-progress feeds the tail's scaleX from the
              clock-subscribed leaf below, not this component. */}
          <TransportScrubBar duration={duration} seek={seek} />
          <button
            className={`pxbtn pxbtn-icon ${isShuffleMode(mode) ? 'is-active' : ''}`}
            onClick={toggleShuffle}
            title="Shuffle"
            aria-label="Shuffle"
            aria-pressed={isShuffleMode(mode)}
          >
            <ShuffleIcon />
          </button>
          <button
            className={`pxbtn pxbtn-icon ${repeatModeOf(mode) !== 'off' ? 'is-active' : ''}`}
            data-state={repeatModeOf(mode)}
            onClick={cycleRepeat}
            title="Repeat mode"
            aria-label={
              repeatModeOf(mode) === 'one'
                ? 'Repeat one. Press to turn repeat off.'
                : repeatModeOf(mode) === 'all'
                  ? 'Repeat all. Press to switch to repeat one.'
                  : 'Repeat off. Press to repeat all.'
            }
          >
            <RepeatIcon one={repeatModeOf(mode) === 'one'} />
          </button>
          <VolumeSlider value={volume} onChange={(v) => void setVolume(v)} width={120} />
        </div>
      </div>
    </footer>
  );
}

/** Clock-subscribed leaf: the elapsed-time LCD readout. */
function TransportElapsed(): JSX.Element {
  const currentTime = usePlayerStore((s) => s.currentTime);
  return (
    <div className="lcd-text text-[20px]" data-newamp-current-time={currentTime.toFixed(3)}>
      {formatTime(currentTime)}
    </div>
  );
}

/** Clock-subscribed leaf: the Resonance progress-glow wrapper + scrub bar. */
function TransportScrubBar({
  duration,
  seek,
}: {
  duration: number;
  seek: (seconds: number) => void;
}): JSX.Element {
  const currentTime = usePlayerStore((s) => s.currentTime);
  return (
    <div
      className="amp-scrub-wrap relative min-w-0 flex-1"
      style={{ '--scrub-progress': duration > 0 ? Math.min(1, currentTime / duration) : 0 } as CSSProperties}
    >
      <ScrubBar
        value={currentTime}
        max={duration || 1}
        onSeek={(v) => seek(v)}
        className="nslider block w-full"
        data-newamp-scrub
      />
    </div>
  );
}
