import { useMemo } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { api, winctl } from '../lib/api';
import { formatTime } from '../lib/format';
import { Visualizer } from './Visualizer';

export function CompactPlayer(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const mode = usePlayerStore((s) => s.mode);
  const setMode = usePlayerStore((s) => s.setMode);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const seek = usePlayerStore((s) => s.seek);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const setFullscreenViz = usePlayerStore((s) => s.setFullscreenViz);
  const stop = () => usePlayerStore.getState().engine.stop();

  const artUrl = useMemo(
    () => (current?.hasArt ? api.getArtUrl(current.id) : null),
    [current?.id, current?.hasArt],
  );

  return (
    <div className="compact-root">
      <section className="compact-shell titlebar-drag">
        <button
          type="button"
          className="compact-art titlebar-nodrag"
          onClick={() => setFullscreenViz(true)}
          title="Open visualizer"
        >
          {artUrl ? <img src={artUrl} alt={current?.album || 'cover'} draggable={false} /> : <span>NP</span>}
        </button>

        <div className="compact-main">
          <div className="compact-topline">
            <button className="compact-brand titlebar-nodrag" onClick={() => setCompactMode(false)}>
              NEWAMP
            </button>
            <div className="compact-leds" aria-hidden="true">
              <span className={isPlaying ? 'on' : ''} />
              <span className={mode === 'shuffle' ? 'on' : ''} />
              <span className={mode !== 'normal' ? 'on' : ''} />
            </div>
            <div className="compact-window titlebar-nodrag">
              <button onClick={() => void winctl.minimize()} title="Minimize">_</button>
              <button onClick={() => setCompactMode(false)} title="Full library">FULL</button>
              <button onClick={() => void winctl.close()} title="Close">x</button>
            </div>
          </div>

          <button
            type="button"
            className="compact-display titlebar-nodrag"
            onClick={() => setFullscreenViz(true)}
            title="Open fullscreen visualizer"
          >
            <span className="compact-time">{formatTime(currentTime)}</span>
            <span className="compact-title">
              {current ? `${current.artist} - ${current.title}` : 'Drop in a library and press play'}
            </span>
            <span className="compact-total">{formatTime(duration)}</span>
          </button>

          <div className="compact-controls titlebar-nodrag">
            <button onClick={() => void prev()} title="Previous">&lt;&lt;</button>
            <button onClick={togglePlay} title="Play / Pause">{isPlaying ? '||' : '>'}</button>
            <button onClick={stop} title="Stop">[]</button>
            <button onClick={() => void next()} title="Next">&gt;&gt;</button>
            <input
              type="range"
              className="nslider compact-seek"
              min={0}
              max={duration || 1}
              step={0.1}
              value={currentTime}
              onChange={(e) => seek(parseFloat(e.target.value))}
            />
            <button
              className={mode === 'shuffle' ? 'active' : ''}
              onClick={() => setMode(mode === 'shuffle' ? 'normal' : 'shuffle')}
              title="Shuffle"
            >
              SHUF
            </button>
            <input
              type="range"
              className="nslider compact-volume"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => void setVolume(parseFloat(e.target.value))}
              title="Volume"
            />
          </div>
        </div>

        <div className="compact-viz">
          <Visualizer mode="mini" width={118} height={96} />
        </div>
      </section>
    </div>
  );
}
