import { useMemo, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { Visualizer } from './Visualizer';
import { formatTime } from '../lib/format';
import { api } from '../lib/api';

const PRESETS = [
  { id: 'neon-waves', label: 'Neon Waves' },
  { id: 'prism-bars', label: 'Prism Bars' },
  { id: 'confetti', label: 'Confetti' },
  { id: 'burning-cloud', label: 'Burning Cloud' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'radial', label: 'Radial' },
  { id: 'tunnel', label: 'Tunnel' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'galaxy', label: 'Galaxy' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'oscilloscope', label: 'Oscilloscope' },
  { id: 'butterchurn', label: 'Milkdrop' },
] as const;

export function FullscreenVisualizer(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setFs = usePlayerStore((s) => s.setFullscreenViz);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const preset = usePlayerStore((s) => s.vizPreset);
  const setPreset = usePlayerStore((s) => s.setVizPreset);

  const [showChrome, setShowChrome] = useState(true);
  const activePreset = PRESETS.some((p) => p.id === preset) ? preset : 'neon-waves';

  const artUrl = useMemo(
    () => (current?.hasArt ? api.getArtUrl(current.id) : null),
    [current?.id, current?.hasArt],
  );

  return (
    <div
      data-newamp-fullscreen-visualizer
      data-newamp-visualizer-preset={activePreset}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black"
      onMouseMove={() => setShowChrome(true)}
      onMouseLeave={() => setShowChrome(false)}
      onDoubleClick={() => setFs(false)}
    >
      <div className="absolute inset-0">
        <Visualizer
          mode={activePreset}
          className="absolute inset-0 h-full w-full"
        />
      </div>

      {artUrl && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative">
            <img
              src={artUrl}
              alt=""
              className="pulse-soft h-[420px] w-[420px] object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
              style={{
                borderRadius: '12px',
                boxShadow: '0 0 80px var(--accent-glow), 0 0 200px var(--accent-glow)',
                opacity: 0.92,
              }}
            />
          </div>
        </div>
      )}

      <div
        className={`pointer-events-auto absolute right-4 top-4 flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-end gap-2 transition-opacity duration-300 ${
          showChrome ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex flex-wrap justify-end gap-1 bevel-out p-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              data-newamp-viz-preset-button={p.id}
              className={`pxbtn ${preset === p.id ? 'is-active' : ''}`}
              onClick={() => setPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button className="pxbtn" onClick={() => setFs(false)} title="Exit visualizer (Esc)">
          ESC X
        </button>
      </div>

      <div
        className={`pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col gap-2 px-8 pb-8 pt-16 transition-opacity duration-300 ${
          showChrome ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.85) 100%)',
        }}
      >
        <div className="flex items-center justify-between text-white">
          <div className="flex flex-col">
            <div className="text-3xl font-semibold tracking-tight">
              {current ? current.title : 'No track loaded'}
            </div>
            <div className="text-base" style={{ color: 'rgba(255,255,255,0.7)' }}>
              {current ? `${current.artist}${current.album ? ` - ${current.album}` : ''}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="pxbtn" onClick={() => void prev()} title="Previous">PREV</button>
            <button className="pxbtn !min-w-[58px]" onClick={togglePlay} title="Play / Pause">
              {isPlaying ? 'PAUSE' : 'PLAY'}
            </button>
            <button className="pxbtn" onClick={() => void next()} title="Next">NEXT</button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs" style={{ color: 'rgba(255,255,255,0.6)' }}>
          <span>{formatTime(currentTime)}</span>
          <input
            type="range"
            className="nslider flex-1"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={(e) => seek(parseFloat(e.target.value))}
          />
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
