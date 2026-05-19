import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import {
  Visualizer,
  detectPerformanceTier,
  type VizPalette,
  type VizPerformance,
  type VizQuality,
  type VizReactivity,
} from './Visualizer';
import { formatTime } from '../lib/format';
import { api, winctl } from '../lib/api';
import type { VisualizerPreset } from '@shared/types';
import { volumeLabel } from './VolumeSlider';

const PRESETS = [
  { id: 'tempo-pulse', label: 'Tempo Pulse' },
  { id: 'lattice-strobe', label: 'Lattice Strobe' },
  { id: 'neon-waves', label: 'Neon Waves' },
  { id: 'neon-ribbons', label: 'Neon Ribbons' },
  { id: 'plasma-grid', label: 'Plasma Grid' },
  { id: 'prism-bars', label: 'Prism Bars' },
  { id: 'confetti', label: 'Confetti' },
  { id: 'burning-cloud', label: 'Burning Cloud' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'orbital-rings', label: 'Orbital Rings' },
  { id: 'radial', label: 'Radial' },
  { id: 'tunnel', label: 'Tunnel' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'galaxy', label: 'Galaxy' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'oscilloscope', label: 'Oscilloscope' },
  { id: 'album-breathe', label: 'Album Breathe' },
  { id: 'butterchurn', label: 'Milkdrop' },
] as const satisfies ReadonlyArray<{ id: VisualizerPreset; label: string }>;

type CanvasVisualizerPreset = Exclude<VisualizerPreset, 'album-breathe'>;

const VIZ_QUALITY_KEY = 'newamp:viz:quality';
const VIZ_SHOW_ART_KEY = 'newamp:viz:showArt';
const VIZ_CHROME_KEY = 'newamp:viz:chrome';
const VIZ_TOP_NAV_KEY = 'newamp:viz:topNav';
const VIZ_PALETTE_KEY = 'newamp:viz:palette';
const VIZ_PERFORMANCE_KEY = 'newamp:viz:performance';
const VIZ_REACTIVITY_KEY = 'newamp:viz:reactivity';
const VIZ_AUTO_VJ_KEY = 'newamp:viz:autoVj';

const PALETTES = [
  { id: 'theme', label: 'Theme' },
  { id: 'phosphor', label: 'Phosphor' },
  { id: 'ice', label: 'Ice' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'rainbow', label: 'Cycle' },
] as const satisfies ReadonlyArray<{ id: VizPalette; label: string }>;

const REACTIVITY_MODES = [
  { id: 'truth', label: 'Truth' },
  { id: 'punch', label: 'Punch' },
  { id: 'wild', label: 'Wild' },
] as const satisfies ReadonlyArray<{ id: VizReactivity; label: string }>;

const AUTO_VJ_BALANCED: VisualizerPreset[] = [
  'tempo-pulse',
  'lattice-strobe',
  'neon-waves',
  'plasma-grid',
  'orbital-rings',
  'neon-ribbons',
  'burning-cloud',
  'prism-bars',
  'radial',
  'tunnel',
  'galaxy',
  'aurora',
  'confetti',
  'pulse',
  'oscilloscope',
];

const AUTO_VJ_LOW: VisualizerPreset[] = [
  'spectrum',
  'oscilloscope',
  'album-breathe',
  'prism-bars',
  'orbital-rings',
  'pulse',
];

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

function loadVisualizerPalette(): VizPalette {
  if (typeof window === 'undefined') return 'theme';
  const raw = window.localStorage.getItem(VIZ_PALETTE_KEY);
  return PALETTES.some((item) => item.id === raw) ? raw as VizPalette : 'theme';
}

function loadVisualizerPerformance(): VizPerformance {
  if (typeof window === 'undefined') return 'balanced';
  const stored = window.localStorage.getItem(VIZ_PERFORMANCE_KEY);
  if (stored === 'low' || stored === 'balanced') return stored;
  // No saved preference yet. Auto-detect, but never demote below balanced for
  // first-run users with no obvious red flag — Electron's renderer often
  // reports SwiftShader/software in offscreen contexts which would otherwise
  // hide the 4K mode behind a low-end gate the user didn't ask for.
  const detected = detectPerformanceTier();
  return detected === 'low' && (navigator.hardwareConcurrency ?? 0) >= 4 ? 'balanced' : detected;
}

function loadVisualizerReactivity(): VizReactivity {
  if (typeof window === 'undefined') return 'punch';
  const raw = window.localStorage.getItem(VIZ_REACTIVITY_KEY);
  return REACTIVITY_MODES.some((item) => item.id === raw) ? raw as VizReactivity : 'punch';
}

export function FullscreenVisualizer(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const setFs = usePlayerStore((s) => s.setFullscreenViz);
  const engine = usePlayerStore((s) => s.engine);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const preset = usePlayerStore((s) => s.vizPreset);
  const setPreset = usePlayerStore((s) => s.setVizPreset);
  const [quality, setQuality] = useState<VizQuality>(() => loadVisualizerQuality());
  const [artPulseEnabled, setArtPulseEnabled] = useState<boolean>(() => loadStoredBoolean(VIZ_SHOW_ART_KEY, true));
  const [artPulseVisible, setArtPulseVisible] = useState(false);
  const [chromeVisible, setChromeVisible] = useState<boolean>(() => loadStoredBoolean(VIZ_CHROME_KEY, true));
  const [topNavVisible, setTopNavVisible] = useState<boolean>(() => loadStoredBoolean(VIZ_TOP_NAV_KEY, true));
  const [palette, setPalette] = useState<VizPalette>(() => loadVisualizerPalette());
  const [performance, setPerformance] = useState<VizPerformance>(() => loadVisualizerPerformance());
  const [reactivity, setReactivity] = useState<VizReactivity>(() => loadVisualizerReactivity());
  const [autoVjEnabled, setAutoVjEnabled] = useState<boolean>(() => loadStoredBoolean(VIZ_AUTO_VJ_KEY, false));
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const levelMeterRef = useRef<HTMLSpanElement>(null);

  const activePreset = PRESETS.some((p) => p.id === preset) ? preset : 'neon-waves';
  const activeIndex = Math.max(0, PRESETS.findIndex((p) => p.id === activePreset));

  const artUrl = useMemo(
    () => (current ? api.getArtUrl(current.id) : null),
    [current?.id],
  );
  const volumePct = Math.max(0, Math.min(100, Math.round((volume / 2) * 100)));

  function pickPreset(id: VisualizerPreset): void {
    setPreset(id);
  }

  function cyclePreset(direction: -1 | 1): void {
    const nextIndex = (activeIndex + direction + PRESETS.length) % PRESETS.length;
    pickPreset(PRESETS[nextIndex]!.id);
  }

  function toggleQuality(): void {
    if (performance === 'low') return;
    setQuality((value) => {
      const next: VizQuality = value === '4k' ? 'auto' : '4k';
      window.localStorage.setItem(VIZ_QUALITY_KEY, next);
      return next;
    });
  }

  function toggleArt(): void {
    setArtPulseEnabled((value) => {
      const next = !value;
      window.localStorage.setItem(VIZ_SHOW_ART_KEY, next ? '1' : '0');
      return next;
    });
  }

  function toggleNativeFullscreen(): void {
    setNativeFullscreen((value) => {
      const next = !value;
      void winctl.setFullscreen(next);
      return next;
    });
  }

  function exitVisualizer(): void {
    void winctl.setFullscreen(false);
    setNativeFullscreen(false);
    setFs(false);
  }

  function toggleChrome(): void {
    setChromeVisible((value) => {
      const next = !value;
      window.localStorage.setItem(VIZ_CHROME_KEY, next ? '1' : '0');
      return next;
    });
  }

  function toggleTopNav(): void {
    setTopNavVisible((value) => {
      const next = !value;
      window.localStorage.setItem(VIZ_TOP_NAV_KEY, next ? '1' : '0');
      return next;
    });
  }

  function cyclePalette(): void {
    setPalette((value) => {
      const index = Math.max(0, PALETTES.findIndex((item) => item.id === value));
      const next = PALETTES[(index + 1) % PALETTES.length]!.id;
      window.localStorage.setItem(VIZ_PALETTE_KEY, next);
      return next;
    });
  }

  function togglePerformance(): void {
    setPerformance((value) => {
      const next: VizPerformance = value === 'low' ? 'balanced' : 'low';
      window.localStorage.setItem(VIZ_PERFORMANCE_KEY, next);
      if (next === 'low') {
        window.localStorage.setItem(VIZ_QUALITY_KEY, 'auto');
        setQuality('auto');
      }
      return next;
    });
  }

  function cycleReactivity(): void {
    setReactivity((value) => {
      const index = Math.max(0, REACTIVITY_MODES.findIndex((item) => item.id === value));
      const next = REACTIVITY_MODES[(index + 1) % REACTIVITY_MODES.length]!.id;
      window.localStorage.setItem(VIZ_REACTIVITY_KEY, next);
      return next;
    });
  }

  function toggleAutoVj(): void {
    setAutoVjEnabled((value) => {
      const next = !value;
      window.localStorage.setItem(VIZ_AUTO_VJ_KEY, next ? '1' : '0');
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    void winctl.isFullscreen().then((value) => {
      if (!cancelled) setNativeFullscreen(value);
    });
    return () => {
      cancelled = true;
      void winctl.setFullscreen(false);
    };
  }, []);

  useEffect(() => {
    if (!artPulseEnabled || !artUrl) {
      setArtPulseVisible(false);
      return undefined;
    }
    let cancelled = false;
    let showTimer = 0;
    let hideTimer = 0;

    const schedulePulse = () => {
      showTimer = window.setTimeout(() => {
        if (cancelled) return;
        setArtPulseVisible(true);
        hideTimer = window.setTimeout(() => {
          if (cancelled) return;
          setArtPulseVisible(false);
          schedulePulse();
        }, 1500 + Math.random() * 1400);
      }, 2200 + Math.random() * 6200);
    };

    schedulePulse();
    return () => {
      cancelled = true;
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, [artPulseEnabled, artUrl]);

  useEffect(() => {
    const wave = new Uint8Array(new ArrayBuffer(engine.fftSize));
    let raf = 0;
    let level = 0;
    const tick = () => {
      engine.getTimeData(wave);
      let sumSq = 0;
      for (let i = 0; i < wave.length; i += 1) {
        const centered = (wave[i]! - 128) / 128;
        sumSq += centered * centered;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, wave.length));
      const audibleLevel = Math.min(1, rms * 3.6 * Math.max(0.02, Math.min(2, volume)) / 2);
      level = Math.max(level * 0.82, audibleLevel);
      const bar = levelMeterRef.current;
      if (bar) {
        const height = Math.max(2, Math.round(level * 100));
        bar.style.height = `${height}%`;
        bar.dataset.newampVizLevel = String(height);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [engine, volume]);

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
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        toggleTopNav();
      } else if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        cyclePalette();
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        cycleReactivity();
      } else if (event.key.toLowerCase() === 'v') {
        event.preventDefault();
        toggleAutoVj();
      } else if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        togglePerformance();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleNativeFullscreen();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex]);

  useEffect(() => {
    if (!autoVjEnabled) return undefined;
    const freq = new Uint8Array(new ArrayBuffer(engine.frequencyBinCount));
    let raf = 0;
    let lastSwitchAt = window.performance.now();

    const tick = (now: number) => {
      if (isPlaying) {
        engine.getFreqData(freq);
        const energy = visualizerEnergy(freq);
        const elapsed = now - lastSwitchAt;
        if (elapsed > 14000 && (energy > 0.42 || elapsed > 30000)) {
          const nextPreset = pickAutoVjPreset(activePreset, energy, performance);
          if (nextPreset !== activePreset) {
            setPreset(nextPreset);
            lastSwitchAt = now;
          }
        }
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [activePreset, autoVjEnabled, engine, isPlaying, performance, setPreset]);

  return (
    <div
      data-newamp-fullscreen-visualizer
      data-newamp-visualizer-preset={activePreset}
      data-newamp-visualizer-quality={quality}
      data-newamp-visualizer-chrome={chromeVisible ? 'visible' : 'clean'}
      data-newamp-visualizer-nav={topNavVisible ? 'visible' : 'hidden'}
      data-newamp-visualizer-palette={palette}
      data-newamp-visualizer-performance={performance}
      data-newamp-visualizer-reactivity={reactivity}
      data-newamp-visualizer-auto-vj={autoVjEnabled ? 'on' : 'off'}
      data-newamp-visualizer-art={artPulseEnabled ? (artPulseVisible ? 'pulse' : 'armed') : 'hidden'}
      data-newamp-native-fullscreen={nativeFullscreen ? 'true' : 'false'}
      className="fullscreen-viz-root fixed inset-0 z-[90] flex items-center justify-center bg-black"
      onDoubleClick={exitVisualizer}
    >
      {activePreset === 'album-breathe' ? (
        <div
          className="fullscreen-viz-album-breathe absolute inset-0 flex items-center justify-center"
          data-newamp-album-breathe-visualizer
        >
          {artUrl ? (
            <img src={artUrl} alt="" draggable={false} />
          ) : (
            <div className="fullscreen-viz-album-breathe-fallback">
              {current ? current.title.slice(0, 2).toUpperCase() : 'NA'}
            </div>
          )}
        </div>
      ) : (
        <div className="absolute inset-0">
          <Visualizer
            mode={activePreset as CanvasVisualizerPreset}
            quality={quality}
            performance={performance}
            palette={palette}
            reactivity={reactivity}
            className="absolute inset-0 h-full w-full"
          />
        </div>
      )}

      {artPulseEnabled && artUrl && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className={`fullscreen-viz-cover relative ${artPulseVisible ? 'is-visible' : ''}`}>
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
        className={`fullscreen-viz-toolbar pointer-events-auto absolute inset-x-4 top-4 flex max-w-[calc(100vw-2rem)] items-center gap-2 ${chromeVisible ? '' : 'is-clean'} ${topNavVisible ? '' : 'is-top-hidden'}`}
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
          disabled={performance === 'low'}
          title={quality === '4k' ? 'Use balanced performance render quality (Q)' : 'Use sharper 4K render quality (Q)'}
        >
          {performance === 'low' ? 'LOW' : quality === '4k' ? '4K' : 'PERF'}
        </button>
        <button
          className={`pxbtn ${performance === 'low' ? 'is-active' : ''}`}
          data-newamp-viz-performance-button
          onClick={togglePerformance}
          title="Low-end mode for older CPUs/GPUs (L)"
        >
          LOW-END
        </button>
        <button
          className={`pxbtn ${artPulseEnabled ? 'is-active' : ''}`}
          data-newamp-viz-art-button
          onClick={toggleArt}
          title="Toggle album-art overlay (A)"
        >
          ART PULSE
        </button>
        <button
          className="pxbtn"
          data-newamp-viz-palette-button
          onClick={cyclePalette}
          title="Cycle visualizer colors (P)"
        >
          {PALETTES.find((item) => item.id === palette)?.label ?? 'Theme'}
        </button>
        <button
          className="pxbtn"
          data-newamp-viz-reactivity-button
          onClick={cycleReactivity}
          title="Cycle visualizer signal response (R)"
        >
          REACT {REACTIVITY_MODES.find((item) => item.id === reactivity)?.label ?? 'Punch'}
        </button>
        <button
          className={`pxbtn ${autoVjEnabled ? 'is-active' : ''}`}
          data-newamp-viz-auto-vj-button
          onClick={toggleAutoVj}
          title="Auto-switch visualizer scenes on song energy (V)"
        >
          AUTO VJ
        </button>
        <button
          className={`pxbtn ${nativeFullscreen ? 'is-active' : ''}`}
          data-newamp-viz-screen-button
          onClick={toggleNativeFullscreen}
          title="Take over the physical screen (F)"
        >
          SCREEN
        </button>
        <button
          className={`pxbtn ${!chromeVisible ? 'is-active' : ''}`}
          data-newamp-viz-clean-button
          onClick={toggleChrome}
          title="Clean visualizer mode (H)"
        >
          CLEAN
        </button>
        <button
          className={`pxbtn ${topNavVisible ? 'is-active' : ''}`}
          data-newamp-viz-nav-button
          onClick={toggleTopNav}
          title="Hide or show the top visualizer navigation (T)"
        >
          TOP NAV
        </button>
        <button className="pxbtn" onClick={exitVisualizer} title="Exit visualizer (Esc)">
          ESC X
        </button>
      </div>

      {!topNavVisible && (
        <button
          className="fullscreen-viz-toolbar-tab pointer-events-auto absolute left-1/2 top-3 -translate-x-1/2"
          data-newamp-viz-show-toolbar
          onClick={toggleTopNav}
          title="Show visualizer controls (T)"
        >
          VIS MENU
        </button>
      )}

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

      <div
        className="fullscreen-viz-hover-meter pointer-events-none absolute right-6 top-1/2 w-[148px] -translate-y-1/2"
        data-newamp-viz-hover-meter
      >
        <div className="fullscreen-viz-hover-meter-label">
          <span>VOL</span>
          <strong>{volumeLabel(volume)}</strong>
        </div>
        <div className="fullscreen-viz-hover-meter-track">
          <span
            ref={levelMeterRef}
            data-newamp-viz-level-meter-bar
            style={{ height: `${Math.max(2, volumePct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

function visualizerEnergy(freq: Uint8Array): number {
  if (!freq.length) return 0;
  const low = averageBand(freq, 0, 36) / 255;
  const mid = averageBand(freq, 36, 180) / 255;
  const high = averageBand(freq, 180, 420) / 255;
  return Math.min(1, Math.pow(low * 0.48 + mid * 0.36 + high * 0.16, 0.72));
}

function averageBand(freq: Uint8Array, from: number, to: number): number {
  let total = 0;
  let count = 0;
  for (let index = from; index < to && index < freq.length; index += 1) {
    total += freq[index]!;
    count += 1;
  }
  return count ? total / count : 0;
}

function pickAutoVjPreset(current: VisualizerPreset, energy: number, performance: VizPerformance): VisualizerPreset {
  const pool = performance === 'low' ? AUTO_VJ_LOW : AUTO_VJ_BALANCED;
  const currentIndex = Math.max(0, pool.indexOf(current));
  if (energy < 0.12) return 'album-breathe';
  if (energy > 0.68 && performance !== 'low') {
    const highEnergy = ['plasma-grid', 'neon-ribbons', 'burning-cloud', 'confetti'] as const;
    return highEnergy[(currentIndex + 1) % highEnergy.length]!;
  }
  return pool[(currentIndex + 1) % pool.length]!;
}
