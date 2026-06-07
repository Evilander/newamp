import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { Visualizer } from './Visualizer';
import { formatTime, playbackCodecLabel } from '../lib/format';
import { api } from '../lib/api';
import { VolumeSlider } from './VolumeSlider';
import { spectralArtDataUrl } from '@shared/spectral-art';
import { PrevIcon, NextIcon, StopIcon, PlayPauseIcon, ShuffleIcon, RepeatIcon } from './TransportIcons';
import { ScrubBar } from './ScrubBar';
import { ArtistLink, AlbumLink } from './EntityLink';

export function Transport(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const playbackError = usePlayerStore((s) => s.playbackError);
  const volume = usePlayerStore((s) => s.volume);
  const mode = usePlayerStore((s) => s.mode);
  const setMode = usePlayerStore((s) => s.setMode);
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
      <div className="flex w-[88px] shrink-0 flex-col items-center justify-center gap-1 bevel-in p-1">
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
            <div className="lcd-text text-[20px]" data-newamp-current-time={currentTime.toFixed(3)}>
              {formatTime(currentTime)}
            </div>
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
            <div className="lcd-text text-[11px]" style={{ color: 'var(--ink-2)' }}>
              {playbackError ? (
                <span data-newamp-playback-error style={{ color: 'var(--error)' }}>
                  {playbackError}
                </span>
              ) : (
                <>
                  {current ? playbackCodecLabel(current.path) : 'AUDIO'}
                  {current && current.bitrate ? `  ${Math.round(current.bitrate / 1000)} kbps` : '  --'}
                  {current && current.sampleRate ? `  ·  ${(current.sampleRate / 1000).toFixed(1)} kHz` : ''}
                  {current && current.year ? `  ·  ${current.year}` : ''}
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
          <ScrubBar
            value={currentTime}
            max={duration || 1}
            onSeek={(v) => seek(v)}
            className="nslider flex-1"
            data-newamp-scrub
          />
          <button
            className={`pxbtn pxbtn-icon ${mode === 'shuffle' ? 'is-active' : ''}`}
            onClick={() => setMode(mode === 'shuffle' ? 'normal' : 'shuffle')}
            title="Shuffle"
            aria-label="Shuffle"
            aria-pressed={mode === 'shuffle'}
          >
            <ShuffleIcon />
          </button>
          <button
            className={`pxbtn pxbtn-icon ${mode === 'repeat-all' || mode === 'repeat-one' ? 'is-active' : ''}`}
            data-state={mode === 'repeat-all' ? 'all' : mode === 'repeat-one' ? 'one' : 'off'}
            onClick={() =>
              setMode(mode === 'repeat-all' ? 'repeat-one' : mode === 'repeat-one' ? 'normal' : 'repeat-all')
            }
            title="Repeat mode"
            aria-label={
              mode === 'repeat-one'
                ? 'Repeat one. Press to turn repeat off.'
                : mode === 'repeat-all'
                  ? 'Repeat all. Press to switch to repeat one.'
                  : 'Repeat off. Press to repeat all.'
            }
          >
            <RepeatIcon one={mode === 'repeat-one'} />
          </button>
          <VolumeSlider value={volume} onChange={(v) => void setVolume(v)} width={120} />
        </div>
      </div>
    </footer>
  );
}
