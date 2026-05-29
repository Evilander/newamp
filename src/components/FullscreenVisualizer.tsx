import { useEffect, useMemo, useRef, useState } from 'react';
import { useLatestRef } from '../hooks/useLatestRef';
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
  { id: 'particle-flow', label: 'Particle Flow' },
  { id: 'tempo-pulse', label: 'Tempo Pulse' },
  { id: 'lattice-strobe', label: 'Lattice Strobe' },
  { id: 'liquid-mercury', label: 'Liquid Mercury' },
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
  'particle-flow',
  'tempo-pulse',
  'lattice-strobe',
  'liquid-mercury',
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
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
  const setVolume = usePlayerStore((s) => s.setVolume);
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
  const [palette, setPalette] = useState<VizPalette>(() => loadVisualizerPalette());
  const [perfTier, setPerfTier] = useState<VizPerformance>(() => loadVisualizerPerformance());
  const [reactivity, setReactivity] = useState<VizReactivity>(() => loadVisualizerReactivity());
  const [autoVjEnabled, setAutoVjEnabled] = useState<boolean>(() => loadStoredBoolean(VIZ_AUTO_VJ_KEY, false));
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  // Auto-hide tracking: when the mouse is idle in fullscreen we collapse the
  // top toolbar so the visualizer can be enjoyed without UI clutter. Any
  // cursor movement re-shows it for a few seconds before hiding again.
  const [cursorActive, setCursorActive] = useState(true);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const levelMeterRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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
    if (perfTier === 'low') return;
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

  function cyclePalette(): void {
    setPalette((value) => {
      const index = Math.max(0, PALETTES.findIndex((item) => item.id === value));
      const next = PALETTES[(index + 1) % PALETTES.length]!.id;
      window.localStorage.setItem(VIZ_PALETTE_KEY, next);
      return next;
    });
  }

  function togglePerfTier(): void {
    setPerfTier((value) => {
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

  // Cursor-position-driven chrome reveal. Cursor near the top edge shows the
  // toolbar; moving away hides it after a short delay. Effect runs once on
  // mount — listeners read fresh state via refs to avoid re-binding storms.
  useEffect(() => {
    const TOP_REVEAL_PX = 110;
    const HIDE_DELAY_MS = 1400;
    let hideTimer = 0;
    let shown = false;
    function show(): void {
      if (!shown) {
        shown = true;
        setCursorActive(true);
      }
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
    }
    function scheduleHide(delay = HIDE_DELAY_MS): void {
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        shown = false;
        setCursorActive(false);
        hideTimer = 0;
      }, delay);
    }
    function handleMove(e: MouseEvent): void {
      if (e.clientY <= TOP_REVEAL_PX) {
        show();
      } else if (shown && !hideTimer) {
        scheduleHide();
      }
    }
    function handleKey(): void {
      show();
      scheduleHide(2400);
    }
    setCursorActive(false);
    window.addEventListener('mousemove', handleMove, { passive: true });
    window.addEventListener('keydown', handleKey, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('keydown', handleKey);
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
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

  // Level meter loop. Decouple from `volume` so dragging the slider doesn't
  // restart the RAF + re-allocate the wave buffer on every tick — that was
  // a per-frame allocation source during volume drags and contributed to
  // gradual slowdown over long sessions.
  const volumeRef = useLatestRef(volume);
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
      const liveVolume = Math.max(0.02, Math.min(2, volumeRef.current));
      const audibleLevel = Math.min(1, rms * 3.6 * liveVolume / 2);
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
  }, [engine]);

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
        togglePerfTier();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleNativeFullscreen();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex]);

  // Mouse wheel anywhere over the fullscreen visualizer drives volume.
  // Outside the viz this has no effect — wheel still scrolls the page
  // normally. Tyler wants this restricted to fullscreen viz so it doesn't
  // hijack scrolling in the library views.
  const wheelVolumeRef = useLatestRef(volume);
  const wheelSetVolumeRef = useLatestRef(setVolume);
  useEffect(() => {
    function onWheel(event: WheelEvent): void {
      if (isEditableTarget(event.target)) return;
      // Don't fight existing wheel handlers (preset rail, volume slider
      // input). If the event target is inside an interactive control that
      // already wheel-binds, let it own the event.
      if (
        event.target instanceof Element &&
        event.target.closest('input, select, [data-newamp-viz-volume-input]')
      ) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.12 : 0.04;
      const delta = event.deltaY > 0 ? -step : step;
      const next = Math.max(0, Math.min(2, wheelVolumeRef.current + delta));
      void wheelSetVolumeRef.current(next);
    }
    // Bind on the root via ref — keeps the listener attached to the
    // exact DOM node React owns instead of a CSS-selector lookup that
    // can race against parent re-mounts.
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
    // useLatestRef returns a stable MutableRefObject — listing them in
    // the deps array would never re-run the effect, so we omit them and
    // let the closure read .current fresh on each wheel event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AutoVJ loop. Depend only on the stable handles (engine, autoVjEnabled);
  // read current preset / isPlaying / performance via refs so changing them
  // doesn't restart the RAF + re-allocate the freq buffer. The previous
  // shape re-allocated on every preset switch — over a long session that
  // accumulated GC pressure and contributed to the gradual slowdown.
  const autoVjActivePresetRef = useLatestRef(activePreset);
  const autoVjIsPlayingRef = useLatestRef(isPlaying);
  const autoVjPerfTierRef = useLatestRef(perfTier);
  const autoVjSetPresetRef = useLatestRef(setPreset);
  useEffect(() => {
    if (!autoVjEnabled) return undefined;
    const freq = new Uint8Array(new ArrayBuffer(engine.frequencyBinCount));
    let raf = 0;
    let lastSwitchAt = window.performance.now();

    const tick = (now: number) => {
      if (autoVjIsPlayingRef.current) {
        engine.getFreqData(freq);
        const energy = visualizerEnergy(freq);
        const elapsed = now - lastSwitchAt;
        if (elapsed > 14000 && (energy > 0.42 || elapsed > 30000)) {
          const currentPreset = autoVjActivePresetRef.current;
          const nextPreset = pickAutoVjPreset(currentPreset, energy, autoVjPerfTierRef.current);
          if (nextPreset !== currentPreset) {
            autoVjSetPresetRef.current(nextPreset);
            lastSwitchAt = now;
          }
        }
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [autoVjEnabled, engine]);

  // Stop an in-flight recording if the visualizer is closed mid-capture.
  useEffect(() => () => {
    try {
      recorderRef.current?.stop();
    } catch {
      /* recorder already stopped */
    }
  }, []);

  const captureStem = (): string =>
    current ? `NewAmp - ${current.artist} - ${current.title}` : 'NewAmp Visualizer';

  const captureRect = (): { x: number; y: number; width: number; height: number } | undefined => {
    const el = rootRef.current;
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  // Still capture uses capturePage (main process) so it works for every mode —
  // including the sandboxed Butterchurn iframe and the WebGL2 particle field.
  const captureStill = async (): Promise<void> => {
    const dataUrl = await api.captureVisualizerPng(captureRect());
    if (!dataUrl) return;
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    await api.saveCaptureBytes({ base64, defaultName: captureStem(), filterName: 'PNG image', ext: 'png' });
  };

  const copyStill = async (): Promise<void> => {
    const dataUrl = await api.captureVisualizerPng(captureRect());
    if (dataUrl) await api.copyPngToClipboard(dataUrl);
  };

  // Clip recording streams the live visualizer canvas (the rendering surface —
  // for Butterchurn that's the canvas inside its iframe) to a WebM via
  // MediaRecorder. Toggle to start/stop; on stop we offer a save dialog.
  const toggleRecord = (): void => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    let canvas = rootRef.current?.querySelector(
      'canvas[data-newamp-visualizer-canvas]',
    ) as HTMLCanvasElement | null;
    const iframe = rootRef.current?.querySelector('iframe') as HTMLIFrameElement | null;
    const frameCanvas = iframe?.contentDocument?.getElementById('bc') as HTMLCanvasElement | null;
    if (frameCanvas) canvas = frameCanvas;
    if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
    } catch {
      return;
    }
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      setRecording(false);
      recorderRef.current = null;
      if (!chunks.length) return;
      const dataUrl = await blobToDataUrl(new Blob(chunks, { type: 'video/webm' }));
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      await api.saveCaptureBytes({ base64, defaultName: captureStem(), filterName: 'WebM video', ext: 'webm' });
    };
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  };

  return (
    <div
      ref={rootRef}
      data-newamp-fullscreen-visualizer
      data-newamp-visualizer-preset={activePreset}
      data-newamp-visualizer-quality={quality}
      data-newamp-visualizer-chrome={chromeVisible ? 'visible' : 'clean'}
      data-newamp-visualizer-nav={cursorActive ? 'visible' : 'hidden'}
      data-newamp-visualizer-palette={palette}
      data-newamp-visualizer-performance={perfTier}
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
            performance={perfTier}
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
        className={`fullscreen-viz-toolbar pointer-events-auto absolute inset-x-3 top-3 flex max-w-[calc(100vw-1.5rem)] items-center gap-[6px] ${chromeVisible ? '' : 'is-clean'} ${cursorActive ? '' : 'is-top-hidden'}`}
        data-newamp-visualizer-toolbar
        data-newamp-visualizer-toolbar-idle={!cursorActive ? 'idle' : 'active'}
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
          disabled={perfTier === 'low'}
          title={quality === '4k' ? 'Use balanced performance render quality (Q)' : 'Use sharper 4K render quality (Q)'}
        >
          {perfTier === 'low' ? 'LOW' : quality === '4k' ? '4K' : 'PERF'}
        </button>
        <button
          className={`pxbtn ${perfTier === 'low' ? 'is-active' : ''}`}
          data-newamp-viz-performance-button
          onClick={togglePerfTier}
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
          className="pxbtn"
          data-newamp-viz-capture-button
          onClick={() => void captureStill()}
          title="Save a PNG still of the visualizer (press H first for a clean shot)"
        >
          CAPTURE
        </button>
        <button
          className="pxbtn"
          data-newamp-viz-copy-button
          onClick={() => void copyStill()}
          title="Copy a PNG still to the clipboard"
        >
          COPY
        </button>
        <button
          className={`pxbtn ${recording ? 'is-active' : ''}`}
          data-newamp-viz-record-button
          onClick={toggleRecord}
          title={recording ? 'Stop recording and save a WebM clip' : 'Record a WebM clip of the visualizer'}
        >
          {recording ? '■ STOP' : '● REC'}
        </button>
        <button
          className={`pxbtn ${!chromeVisible ? 'is-active' : ''}`}
          data-newamp-viz-clean-button
          onClick={toggleChrome}
          title="Clean visualizer mode (H)"
        >
          CLEAN
        </button>
        <button className="pxbtn" onClick={exitVisualizer} title="Exit visualizer (Esc)">
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

      <div
        className="fullscreen-viz-hover-meter pointer-events-auto absolute right-6 top-1/2 w-[160px] -translate-y-1/2"
        data-newamp-viz-hover-meter
      >
        <div className="fullscreen-viz-hover-meter-label">
          <span>VOL</span>
          <strong>{volumeLabel(volume)}</strong>
        </div>
        <div className="fullscreen-viz-hover-meter-track" data-newamp-viz-volume-slider>
          {/* Live RMS-driven level meter sits beneath the interactive slider so
              the bar still reacts to audio while the user can also drag to set
              volume. The slider is the source of truth for volume control. */}
          <span
            ref={levelMeterRef}
            data-newamp-viz-level-meter-bar
            style={{ height: `${Math.max(2, volumePct)}%` }}
          />
          <input
            type="range"
            className="fullscreen-viz-hover-meter-input"
            data-newamp-viz-volume-input
            min={0}
            max={200}
            step={1}
            value={Math.round(volume * 100)}
            onChange={(event) => {
              const raw = Number(event.target.value);
              if (Number.isFinite(raw)) void setVolume(Math.max(0, Math.min(2, raw / 100)));
            }}
            onWheel={(event) => {
              event.preventDefault();
              const delta = event.deltaY > 0 ? -0.05 : 0.05;
              void setVolume(Math.max(0, Math.min(2, volume + delta)));
            }}
            aria-label="Visualizer volume"
            title={`Volume ${volumeLabel(volume)} — drag or scroll to change`}
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

function pickAutoVjPreset(current: VisualizerPreset, energy: number, perfTier: VizPerformance): VisualizerPreset {
  const pool = perfTier === 'low' ? AUTO_VJ_LOW : AUTO_VJ_BALANCED;
  const currentIndex = Math.max(0, pool.indexOf(current));
  if (energy < 0.12) return 'album-breathe';
  if (energy > 0.68 && perfTier !== 'low') {
    const highEnergy = ['plasma-grid', 'neon-ribbons', 'burning-cloud', 'confetti'] as const;
    return highEnergy[(currentIndex + 1) % highEnergy.length]!;
  }
  return pool[(currentIndex + 1) % pool.length]!;
}
