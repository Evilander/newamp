import { useEffect, useMemo, useRef } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { Visualizer } from './Visualizer';
import { formatTime, playbackCodecLabel } from '../lib/format';
import { api } from '../lib/api';
import { VolumeSlider } from './VolumeSlider';

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

  return (
    <footer
      data-newamp-transport
      data-newamp-playing={isPlaying ? 'true' : 'false'}
      className="bevel-out scanlines relative flex items-stretch gap-2 px-3 py-2"
      style={{ borderTop: '1px solid var(--line)' }}
    >
      <div className="flex w-[88px] shrink-0 flex-col items-center justify-center gap-1 bevel-in p-1">
        {artUrl ? (
          <img
            src={artUrl}
            alt="cover"
            className="h-[72px] w-[72px] cursor-pointer object-cover"
            style={{ borderRadius: 'var(--radius)' }}
            onClick={() => setFs(true)}
            title="Open visualizer"
            data-newamp-open-visualizer
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
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
              {current
                ? `★ ${current.artist} — ${current.title} ${current.album ? `(${current.album})` : ''}`
                : '— no track loaded — choose something from your library —'}
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
          <button className="pxbtn" onClick={() => void prev()} title="Previous">
            ⏮
          </button>
          <button className="pxbtn" onClick={togglePlay} title="Play / Pause">
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button className="pxbtn" onClick={stop} title="Stop">
            ◼
          </button>
          <button className="pxbtn" onClick={() => void next()} title="Next">
            ⏭
          </button>
          <ScrubBar
            value={currentTime}
            max={duration || 1}
            onChange={(v) => seek(v)}
          />
          <button
            className={`pxbtn ${mode === 'shuffle' ? 'is-active' : ''}`}
            onClick={() => setMode(mode === 'shuffle' ? 'normal' : 'shuffle')}
            title="Shuffle"
          >
            ↬
          </button>
          <button
            className={`pxbtn ${mode === 'repeat-all' || mode === 'repeat-one' ? 'is-active' : ''}`}
            onClick={() =>
              setMode(mode === 'repeat-all' ? 'repeat-one' : mode === 'repeat-one' ? 'normal' : 'repeat-all')
            }
            title="Repeat mode"
          >
            {mode === 'repeat-one' ? '↺1' : '↺'}
          </button>
          <VolumeSlider value={volume} onChange={(v) => void setVolume(v)} width={120} />
        </div>
      </div>
    </footer>
  );
}

function ScrubBar({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) {
      ref.current.value = String(value);
    }
  }, [value]);
  return (
    <input
      ref={ref}
      data-newamp-scrub
      type="range"
      className="nslider flex-1"
      min={0}
      max={max}
      step={0.1}
      defaultValue={value}
      onInput={(e) => onChange(parseFloat(e.currentTarget.value))}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}
