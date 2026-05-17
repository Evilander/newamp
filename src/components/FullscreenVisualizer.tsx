import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { Visualizer, type VizQuality } from './Visualizer';
import { formatTime } from '../lib/format';
import { api } from '../lib/api';
import type { VisualizerPreset } from '@shared/types';

const PRESETS = [
  { id: 'neon-waves', label: 'Neon Waves' },
  { id: 'neon-ribbons', label: 'Neon Ribbons' },
  { id: 'plasma-grid', label: 'Plasma Grid' },
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
] as const satisfies ReadonlyArray<{ id: VisualizerPreset; label: string }>;

const VIZ_QUALITY_KEY = 'newamp:viz:quality';
const VIZ_SHOW_ART_KEY = 'newamp:viz:showArt';
const VIZ_CHROME_KEY = 'newamp:viz:chrome';

function loadVisualizerQuality(): VizQuality {
  if (typeof window === 'undefined') return 'auto';
  return window.localStorage.getItem(VIZ_QUALITY_KEY) === '4k' ? '4k' : 'auto';
}

function loadStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

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
  const [quality, setQuality] = useState<VizQuality>(() => loadVisualizerQuality());
  const [showArt, setShowArt] = useState<boolean>(() => loadStoredBoolean(VIZ_SHOW_ART_KEY, false));
  const [chromeVisible, setChromeVisible] = useState<boolean>(() => loadStoredBoolean(VIZ_CHROME_KEY, true));

  const activePreset = PRESETS.some((p) => p.id === preset) ? preset : 'neon-waves';
  const activeIndex = Math.max(0, PRESETS.findIndex((p) => p.id === activePreset));

  const artUrl = useMemo(
    () => (current?.hasArt ? api.getArtUrl(current.id) : null),
    [current?.id, current?.hasArt],
  );

  function pickPreset(id: VisualizerPreset): void {
    setPreset(id);
  }

  function cyclePreset(direction: -1 | 1): void {
    const nextIndex = (activeIndex + direction + PRESETS.length) % PRESETS.length;
    pickPreset(PRESETS[nextIndex]!.id);
  }

  function toggleQuality(): void {
    setQuality((value) => {
      const next: VizQuality = value === '4k' ? 'auto' : '4k';
      window.localStorage.setItem(VIZ_QUALITY_KEY, next);
      return next;
    });
  }

  function toggleArt(): void {
    setShowArt((value) => {
      const next = !value;
      window.localStorage.setItem(VIZ_SHOW_ART_KEY, next ? '1' : '0');
      return next;
    });
  }

  function toggleChrome(): void {
    setChromeVisible((value) => {
      const next = !value;
      window.localStorage.setItem(VIZ_CHROME_KEY, next ? '1' : '0');
      return next;
    });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target)) return;
      if (event.key === 'ArrowRight' || event.key === ']') {
        event.preventDefault();
        cyclePreset(1);
      } else if (event.key === 'ArrowLeft' || event.key === '[') {
        event.preventDefault();
        cyclePreset(-1);
      } else if (event.key.toLowerCase() === 'q') {
        event.preventDefault();
        toggleQuality();
      } else if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        toggleArt();
      } else if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        toggleChrome();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex]);

  return (
    <div
      data-newamp-fullscreen-visualizer
      data-newamp-visualizer-preset={activePreset}
      data-newamp-visualizer-quality={quality}
      data-newamp-visualizer-chrome={chromeVisible ? 'visible' : 'clean'}
      data-newamp-visualizer-art={showArt ? 'visible' : 'hidden'}
      className="fullscreen-viz-root fixed inset-0 z-[90] flex items-center justify-center bg-black"
      onDoubleClick={() => setFs(false)}
    >
      <div className="absolute inset-0">
        <Visualizer
          mode={activePreset}
          quality={quality}
          className="absolute inset-0 h-full w-full"
        />
      </div>

      {showArt && artUrl && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="fullscreen-viz-cover relative">
            <img
              src={artUrl}
              alt=""
              className="pulse-soft h-full w-full object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          </div>
        </div>
      )}

      <div
        className={`fullscreen-viz-toolbar pointer-events-auto absolute inset-x-4 top-4 flex max-w-[calc(100vw-2rem)] items-center gap-2 ${chromeVisible ? '' : 'is-clean'}`}
        data-newamp-visualizer-toolbar
      >
        <button className="pxbtn" onClick={() => cyclePreset(-1)} title="Previous visualizer preset ([)">
          PREV
        </button>
        <div className="fullscreen-viz-preset-rail bevel-out">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              data-newamp-viz-preset-button={p.id}
              className={`pxbtn ${activePreset === p.id ? 'is-active' : ''}`}
              onClick={() => pickPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button className="pxbtn" onClick={() => cyclePreset(1)} title="Next visualizer preset (])">
          NEXT
        </button>
        <button
          className={`pxbtn ${quality === '4k' ? 'is-active' : ''}`}
          data-newamp-viz-quality-button
          onClick={toggleQuality}
          title="Toggle 4K render quality (Q)"
        >
          {quality === '4k' ? '4K' : 'AUTO'}
        </button>
        <button
          className={`pxbtn ${showArt ? 'is-active' : ''}`}
          data-newamp-viz-art-button
          onClick={toggleArt}
          title="Toggle album-art overlay (A)"
        >
          ART
        </button>
        <button
          className={`pxbtn ${!chromeVisible ? 'is-active' : ''}`}
          data-newamp-viz-clean-button
          onClick={toggleChrome}
          title="Clean visualizer mode (H)"
        >
          CLEAN
        </button>
        <button className="pxbtn" onClick={() => setFs(false)} title="Exit visualizer (Esc)">
          ESC X
        </button>
      </div>

      <div
        className={`fullscreen-viz-now pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col gap-2 px-8 pb-8 pt-16 ${chromeVisible ? '' : 'is-clean'}`}
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

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}
