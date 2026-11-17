import { startCanvasVisualizer, createFrameGate, createFallbackPainter, releaseGlContext, getCssVar } from '../visualizer/canvas-renderer';
export { startShaderVisualizer } from '../visualizer/canvas-renderer';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import {
  BUTTERCHURN_FFT_SIZE,
  type BcAudioMessage,
  type BcConfigMessage,
  type BcDisposeMessage,
  type BcFrameMessage,
  type BcInitMessage,
} from '../butterchurn-iframe/protocol';
import { feedSampleRate, fillButterchurnSamples, waveGainFor } from '../butterchurn-iframe/feed';
import { createEvilandRenderer, type EvilandPalette } from '../visualizer/eviland';
import { liveGradeFor, resolveEvilandPalette, sleeveFor, themePaletteFromAccent, tuneEvilandFrame, type Sleeve } from '../visualizer/eviland-appearance';
import { watchContextFallback } from '../visualizer/context-fallback';
import { createLookRequestCursor } from '../visualizer/look-requests';
import { createGovernor } from '../visualizer/eviland-governor';
import { createEvilandReactor } from '../visualizer/eviland-audio';
import { createDirector } from '../visualizer/eviland-director';
import {
  generate as generateEvilandConfig,
  decode as decodeEvilandConfig,
} from '../visualizer/eviland-randomizer';
import { applyWaveformOverride, cloneConfig, stripTransitionMeta, type OperatorConfig } from '../visualizer/eviland-operators';
import { createMemoryBridge, sceneSeedForTrack, type MemoryBridge } from '../visualizer/eviland-memory-bridge';
import { createEngineScoreFeed } from '../visualizer/eviland-score-feed';
import { watchArtPalette } from '../visualizer/art-palette';
import {
  publishActiveBridge,
  acquireBridgeForTrack,
  releaseBridgeForTrack,
  notifySectionReturn,
} from '../visualizer/eviland-memory-bridge-registry';
import { createEmptyPlan } from '../visualizer/eviland-memory-types';
import { hashSeed } from '../visualizer/eviland-rng';
import { parseCssRgbVec as parseRgbVec } from '../visualizer/css-color';
import { HAZARD_AREA } from '../visualizer/flash-guard';
import {
  attachFlashGuard,
  gpuFlashGuardSupported,
} from '../visualizer/flash-guard-host';
import { createSampleRateWatch } from '../visualizer/band-edges';
import { boostFrequencyData, type SpectrumReactivity } from '../visualizer/viz-features';
import { api } from '../lib/api';
import {
  startPacedLoop,
  watchDisplayChange,
} from '../lib/pacedFrame';

export type VizMode =
  | 'mini'
  | 'spectrum'
  | 'oscilloscope'
  | 'galaxy'
  | 'aurora'
  | 'radial'
  | 'tunnel'
  | 'pulse'
  | 'orbital-rings'
  | 'neon-waves'
  | 'neon-ribbons'
  | 'plasma-grid'
  | 'prism-bars'
  | 'confetti'
  | 'burning-cloud'
  | 'tempo-pulse'
  | 'lattice-strobe'
  | 'liquid-mercury'
  | 'particle-flow'
  | 'eviland'
  | 'eviland-live'
  | 'kaleido-bloom'
  | 'liquid-aurora-storm'
  | 'fractal-pulse'
  | 'starfield-warp'
  | 'spectral-tunnel'
  | 'butterchurn';

export type VizQuality = 'auto' | '4k';
export type VizPerformance = 'balanced' | 'low';

// Auto-detect a reasonable performance tier for this machine. Run once per
// session — the first call computes, subsequent calls return the cache.
let detectedTier: VizPerformance | null = null;
export function detectPerformanceTier(): VizPerformance {
  if (detectedTier) return detectedTier;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return (detectedTier = 'balanced');
  }
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  let score = 0;
  if (cores >= 8) score += 2;
  else if (cores >= 4) score += 1;
  if (memory >= 8) score += 2;
  else if (memory >= 4) score += 1;

  // GPU sniff via WebGL — software rasterizers (SwiftShader, llvmpipe) get
  // demoted to low. The unmasked renderer string is the most reliable signal.
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL ?? 0) ?? '') : '';
      const lower = renderer.toLowerCase();
      if (/swiftshader|llvmpipe|software|microsoft basic/.test(lower)) score -= 3;
      else if (/intel/.test(lower) && !/arc|iris xe/.test(lower)) score -= 1;
      else if (/(rtx|radeon (rx|vii)|apple m[1-9]|nvidia)/.test(lower)) score += 1;
    } else {
      score -= 2;
    }
  } catch {
    /* no webgl, ignore */
  }
  return (detectedTier = score >= 2 ? 'balanced' : 'low');
}
export type VizPalette = 'look' | 'theme' | 'phosphor' | 'ice' | 'sunset' | 'rainbow';
export type VizReactivity = SpectrumReactivity;

interface Props {
  mode: VizMode;
  width?: number;
  height?: number;
  className?: string;
  quality?: VizQuality;
  performance?: VizPerformance;
  palette?: VizPalette;
  reactivity?: VizReactivity;
}

export function Visualizer({
  mode,
  width,
  height,
  className,
  quality = 'auto',
  performance = 'balanced',
  palette = 'look',
  reactivity = 'punch',
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const butterchurnIframeRef = useRef<HTMLIFrameElement>(null);
  const engine = usePlayerStore((s) => s.engine);
  // The renderer's GPU context was taken and did not come back (see
  // watchContextFallback): the surface it happened on. That surface paints with
  // the 2D fallback from then on, until the mode or tier changes.
  const surfaceKey = `${mode}-${quality}-${performance}`;
  const [fellBackFrom, setFellBackFrom] = useState<string | null>(null);
  const glFellBack = fellBackFrom === surfaceKey;
  // Eviland-only state mirrored into a ref so the rAF loop can read live values
  // without restarting on every toggle. The loop reads `evilandStateRef.current`
  // each frame; the ref updates in a tiny effect below. This is the same
  // technique FullscreenVisualizer uses for its Auto-VJ loop.
  const evilandDirectorEnabled = usePlayerStore((s) => s.evilandDirector);
  const evilandSeed = usePlayerStore((s) => s.evilandSeed);
  const evilandConfigNonce = usePlayerStore((s) => s.evilandConfigNonce);
  const evilandWaveMode = usePlayerStore((s) => s.evilandWaveMode);
  const currentTrackId = usePlayerStore((s) => s.current?.id ?? null);
  const fullscreenVizActive = usePlayerStore((s) => s.fullscreenViz);
  const evilandStateRef = useRef({
    director: evilandDirectorEnabled,
    seed: evilandSeed,
    nonce: evilandConfigNonce,
    waveMode: evilandWaveMode,
    trackId: currentTrackId,
  });
  useEffect(() => {
    evilandStateRef.current = {
      director: evilandDirectorEnabled,
      seed: evilandSeed,
      nonce: evilandConfigNonce,
      waveMode: evilandWaveMode,
      trackId: currentTrackId,
    };
  }, [evilandDirectorEnabled, evilandSeed, evilandConfigNonce, evilandWaveMode, currentTrackId]);

  // Palette + reactivity are LIVE tuning, not renderer identity: every render
  // loop reads this ref each frame, so changing either prop (or the app skin,
  // which only moves CSS variables) retunes the running visualizer with zero
  // teardown. Only mode/quality/performance stay identity-bearing — they set
  // buffer sizes, frame budgets, and renderer topology, which genuinely need
  // a rebuild. Same ref technique as evilandStateRef above.
  const tuningRef = useRef({ palette, reactivity });
  useEffect(() => {
    tuningRef.current = { palette, reactivity };
  }, [palette, reactivity]);

  const isFullscreen = width == null && height == null && mode !== 'mini';
  const suspendedByFullscreen = fullscreenVizActive && !isFullscreen;
  const frameIntervalMs = isFullscreen
    ? performance === 'low'
      ? 1000 / 30
      : quality === '4k' ? 1000 / 30 : 1000 / 45
    : 1000 / 30;
  // '4K' is the 3840x2160 budget at the display's own pixel ratio, up to 2x.
  // Every renderer at this tier runs under a cost governor that trims it back
  // on a machine that cannot hold the cadence: Eviland's and the MilkDrop
  // frame's own, and the one the other modes are given below. The MilkDrop
  // frame is also told the pixel budget, since it sizes itself.
  const dprCap = isFullscreen
    ? performance === 'low'
      ? 0.75
      : quality === '4k' ? 2 : 1
    : 2;
  const maxPixels = isFullscreen
    ? performance === 'low'
      ? 1_050_000
      : quality === '4k' ? 8_300_000 : 2_100_000
    : 2_000_000;
  // The other modes have no governor of their own at the lower budgets, which
  // they stay within; at this one they get the same trim as Eviland.
  const fourK = isFullscreen && performance !== 'low' && quality === '4k';
  // Whether this surface can ever cover enough of the screen for a flash to
  // be a hazard (HAZARD_AREA in visualizer/flash-guard.ts). The transport
  // meter and the smallest deck windows can't, and skip the flash guard.
  const screenArea = typeof screen === 'undefined' ? 0 : screen.width * screen.height;
  const mayFlashLarge = width == null || height == null || width * height >= HAZARD_AREA * screenArea;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || suspendedByFullscreen) return;

    if (mode === 'butterchurn' || mode === 'eviland-live') {
      // Butterchurn runs inside an iframe (butterchurn-iframe.html) so its
      // preset-shader eval is scoped to a frame whose CSP permits 'unsafe-eval'
      // — the main renderer stays on script-src 'self'. The frame is same-origin
      // and carries no sandbox attribute, so that CSP is the only fence round it. Web Audio
      // nodes can't cross the iframe boundary, so we post raw time-domain bytes
      // each frame and the iframe feeds them to butterchurn's render({ audioLevels })
      // path. If the frame can't host butterchurn (load error / missing feature /
      // timeout) we drop to the non-eval canvas-2D fallback so it never goes dark.
      //
      // 'eviland-live' uses the same iframe, and the iframe owns the WHOLE
      // image: scenes, fluid, chemistry and reactor events are drawn into
      // MilkDrop's feedback texture there (eviland-live-pipeline.ts) and one
      // palette grades the result. This side only analyses audio, runs the
      // Director and posts the look for each frame.
      const iframe = butterchurnIframeRef.current;
      if (!iframe) return;
      let fallbackCancel = () => {};
      let disposed = false;
      let ready = false;
      let mounted = false;

      const currentDpr = (): number => Math.min(window.devicePixelRatio || 1, dprCap);
      const dpr = currentDpr();
      const canPaint = createFrameGate(canvasRef, frameIntervalMs);
      const wave = new Uint8Array(new ArrayBuffer(engine.fftSize));
      const samples = new Uint8Array(BUTTERCHURN_FFT_SIZE);

      // --- Eviland Live: audio analysis + Director for the iframe's pipeline ---
      const liveMode = mode === 'eviland-live';
      const binCount = engine.frequencyBinCount;
      const ovFreq = liveMode ? new Uint8Array(new ArrayBuffer(binCount)) : null;
      const ovOnsetFreq = liveMode ? new Uint8Array(new ArrayBuffer(binCount)) : null;
      const ovLeftFreq = liveMode ? new Uint8Array(new ArrayBuffer(binCount)) : null;
      const ovRightFreq = liveMode ? new Uint8Array(new ArrayBuffer(binCount)) : null;
      let ovReactor = liveMode
        ? createEvilandReactor({ sampleRate: engine.getSampleRate(), fftSize: engine.fftSize, binCount })
        : null;
      // Bit-Perfect output can move the device to another rate between tracks.
      const rateChanged = createSampleRateWatch(() => engine.getSampleRate(), engine.getSampleRate());
      const liveDirector = liveMode ? createDirector({ songId: 'eviland-live' }) : null;
      const lookRequests = createLookRequestCursor();
      // Look-ahead cues from the track's song score (sections on the bar
      // line, builds, drops, key changes). No-op until a score is available.
      const liveScoreFeed = liveMode ? createEngineScoreFeed(engine, () => usePlayerStore.getState().current) : null;
      let liveConfig: OperatorConfig | null = null;
      let liveNonce = -1;
      let latestLive: BcAudioMessage['eviland'];
      let overlayLastNow = 0;
      // One palette for the whole composition — theme base re-read ~1x/sec on
      // the paint cadence and change-gated, so a skin change re-tints the
      // running image WITHOUT tearing down the stage. The album art's dominant
      // colors (async, best-effort, cached by URL) go in through the sleeve:
      // resolveEvilandPalette blends them into the theme and turns half the
      // looks toward them. The toolbar's palette choice is applied on top of
      // this in updateComposition().
      let themePalette = readThemePalette();
      const sleeve: Sleeve = { art: null, seed: '' };
      let sleeveArt: Sleeve['art'] = null;
      let themeTick = 0;
      const refreshThemePalette = (): void => {
        if (themeTick++ % 30 !== 0) return;
        const next = readThemePalette();
        if (evilandPaletteEquals(next, themePalette)) return;
        themePalette = next;
      };
      let artTrackId: number | null | undefined = undefined;
      const refreshArtPalette = (): void => {
        const tid = usePlayerStore.getState().current?.id ?? null;
        if (tid === artTrackId) return;
        artTrackId = tid;
        sleeveArt = null;
        if (tid == null) return;
        const captured = tid;
        watchArtPalette(api.getArtUrl(tid), () => artTrackId === captured, (art) => {
          sleeveArt = art;
        });
      };
      // Lineage-aware scene seed. The bare `track-<id>` key applies instantly
      // on track change; a read-only bridge (same pattern as the headless
      // producer — loadOrSeed then dispose, never observe/flush, so the
      // eviland WebGL branch stays the sole writer) upgrades it to
      // `track-<id>::g<gen>-r<rootSeed>` when the track has a persisted plan.
      // Result: a remembered song's scene rotation evolves with its visual
      // generation, matching the projector byte-for-byte.
      let sceneSeedTrackId: number | null | undefined = undefined;
      let sceneSeedValue = 'idle';
      const refreshSceneSeed = (): void => {
        const tid = usePlayerStore.getState().current?.id ?? null;
        if (tid === sceneSeedTrackId) return;
        sceneSeedTrackId = tid;
        ovReactor?.reset();
        liveDirector?.reset(`track-${tid ?? 'idle'}`);
        sceneSeedValue = sceneSeedForTrack(tid, null) ?? 'idle';
        if (tid == null) return;
        const captured = tid;
        const readOnlyBridge = createMemoryBridge({ trackId: tid, api });
        void readOnlyBridge.loadOrSeed().then((plan) => {
          if (sceneSeedTrackId === captured && plan) {
            sceneSeedValue = sceneSeedForTrack(captured, plan) ?? sceneSeedValue;
            liveDirector?.loadPlan(plan);
          }
          void readOnlyBridge.flushAndDispose('manual');
        });
      };

      const updateComposition = (now: number): void => {
        if (!ovReactor || !liveDirector || !ovFreq || !ovOnsetFreq || !ovLeftFreq || !ovRightFreq) return;
        refreshSceneSeed();
        engine.getFreqData(ovFreq);
        engine.getOnsetFreqData(ovOnsetFreq);
        engine.getLeftFreqData(ovLeftFreq);
        engine.getRightFreqData(ovRightFreq);
        const dt = overlayLastNow ? now - overlayLastNow : 1000 / 60;
        overlayLastNow = now;
        refreshThemePalette();
        refreshArtPalette();
        const rawFrame = ovReactor.analyze(ovFreq, ovOnsetFreq, ovLeftFreq, ovRightFreq, dt, now);
        liveScoreFeed?.conduct(rawFrame, dt);
        const ui = evilandStateRef.current;
        if (!liveConfig || liveNonce !== ui.nonce) {
          liveNonce = ui.nonce;
          liveConfig = (ui.seed && decodeEvilandConfig(ui.seed)) || generateEvilandConfig(ui.seed ?? sceneSeedValue).config;
        }
        lookRequests.drain(liveDirector, ui.director);
        const config = ui.director ? liveDirector.update(rawFrame, dt) : liveConfig;
        latestLive = {
          frame: tuneEvilandFrame(rawFrame, tuningRef.current.reactivity),
          palette: resolveEvilandPalette(
            tuningRef.current.palette,
            themePalette,
            now / 1000,
            rawFrame.score?.keyShift,
            config.palette,
            sleeveFor(config, sleeveArt, sleeve),
            rawFrame.score?.minor,
            rawFrame.score?.keyConfidence,
          ),
          // The iframe blends presets itself; the fade's two full looks would
          // only triple every frame's message. It still gets the slim look the
          // fade is heading to, so it prepares that look as the fade begins.
          config: applyWaveformOverride(config._from ? { ...config, _from: undefined, _to: undefined } : config, ui.waveMode),
          next: config._to ? { seed: config._to.seed, archetype: config._to.archetype, composition: config._to.composition } : undefined,
          seed: sceneSeedValue,
          waveMode: ui.waveMode,
          grade: liveGradeFor(tuningRef.current.palette),
        };
      };

      // The iframe guards its own output (butterchurn-iframe/main.ts); this
      // painter only runs when the frame couldn't host MilkDrop.
      let fallbackPainter: ReturnType<typeof createFallbackPainter> | null = null;
      let fallbackStarted = false;
      const startFallback = () => {
        if (fallbackStarted) return;
        const node = canvasRef.current;
        if (!node) return;
        fallbackStarted = true;
        iframe.style.display = 'none';
        const painter = createFallbackPainter(node, engine);
        fallbackPainter = painter;
        // The frame is gone, so there is nobody to feed. The painter gets its
        // own gate: sharing the pump's would leave it every slot already taken.
        stopPump();
        fallbackCancel = startPacedLoop(createFrameGate(canvasRef, frameIntervalMs), (now) => painter.paint(now), {
          retryMs: frameIntervalMs,
          rescue: true,
        });
      };

      // A GPU context the frame lost is rebuilt inside it ('context-restored').
      // If neither news arrives within the grace period the picture is frozen,
      // so the 2D painter takes over, as it does when the frame cannot start.
      const contextWatch = watchContextFallback(startFallback);

      const onMessage = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;
        const msg = event.data as BcFrameMessage | undefined;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'context-lost') {
          contextWatch.onEvent('lost');
        } else if (msg.type === 'context-restored') {
          contextWatch.onEvent('restored');
        } else if (msg.type === 'ready') {
          ready = true;
          const init: BcInitMessage = {
            type: 'init',
            // The rate of the samples the pump sends, which is the device
            // rate unless it is above what the iframe accepts.
            sampleRate: feedSampleRate(engine.getSampleRate()),
            dpr,
            maxPixels,
            eviland: liveMode,
            quality: performance === 'low' ? 'low' : quality === '4k' ? 'high' : 'medium',
          };
          iframe.contentWindow?.postMessage(init, '*');
        } else if (msg.type === 'mounted') {
          mounted = true;
          // Mirror the legacy boot signal the ui-visualizer smoke asserts on.
          canvasRef.current?.setAttribute('data-newamp-butterchurn-mounted', 'true');
        } else if (msg.type === 'failed') {
          console.error('[newamp] butterchurn iframe failed to start:', msg.error);
          canvasRef.current?.setAttribute('data-newamp-butterchurn-mounted', 'failed');
          startFallback();
        }
      };
      window.addEventListener('message', onMessage);

      // Resume the AudioContext so the analyser produces real bytes.
      if (engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});

      const postConfig = (config: Omit<BcConfigMessage, 'type'>): void => {
        if (ready) iframe.contentWindow?.postMessage({ type: 'config', ...config } satisfies BcConfigMessage, '*');
      };
      // A window dragged onto a display with another pixel ratio renders at
      // the new one instead of keeping the ratio it started with.
      const stopDisplayWatch = watchDisplayChange(() => postConfig({ dpr: currentDpr() }));

      const pump = (now: number) => {
        // The reactor's band map and MilkDrop's band edges both follow the
        // sample rate; both are told when Bit-Perfect output changes it.
        const newRate = rateChanged(now);
        if (newRate) {
          if (liveMode) ovReactor = createEvilandReactor({ sampleRate: newRate, fftSize: engine.fftSize, binCount });
          postConfig({ sampleRate: feedSampleRate(newRate) });
        }
        if (liveMode) updateComposition(now);
        if (!ready) return;
        // The window comes from the unsmoothed onset analyser tap so
        // transients reach butterchurn on the same frame they happen (the
        // smoothed analyser would lag ~1.3 frames). The reactivity control
        // reaches MilkDrop as a linear gain on it, limited at full scale.
        engine.getOnsetTimeData(wave);
        fillButterchurnSamples(wave, samples, waveGainFor(tuningRef.current.reactivity), engine.getSampleRate());
        const audio: BcAudioMessage = { type: 'audio', samples, eviland: latestLive, playing: engine.getState().playing };
        iframe.contentWindow?.postMessage(audio, '*');
      };
      // Feeds the frame from a timer if animation frames stop while the page
      // still reports itself visible: the iframe paints from these messages.
      const stopPump = startPacedLoop(canPaint, pump, { retryMs: frameIntervalMs, rescue: true });

      // dev: http://localhost:5173/butterchurn-iframe.html
      // prod: newamp-app://app/butterchurn-iframe.html
      iframe.src = new URL('butterchurn-iframe.html', window.location.href).toString();

      const mountTimeout = window.setTimeout(() => {
        if (!mounted && !disposed) {
          console.error('[newamp] butterchurn iframe did not mount within timeout; using fallback');
          canvasRef.current?.setAttribute('data-newamp-butterchurn-mounted', 'failed');
          startFallback();
        }
        // 20s: the full preset catalog (base+Extra+Extra2+MD1) takes longer to
        // parse than the old single pack; 8s false-failed slow cold boots.
      }, 20000);

      return () => {
        disposed = true;
        stopPump();
        stopDisplayWatch();
        fallbackCancel();
        contextWatch.dispose();
        window.clearTimeout(mountTimeout);
        window.removeEventListener('message', onMessage);
        fallbackPainter?.dispose();
        liveScoreFeed?.dispose();
        try {
          const dispose: BcDisposeMessage = { type: 'dispose' };
          iframe.contentWindow?.postMessage(dispose, '*');
        } catch {
          /* frame already torn down */
        }
        iframe.src = 'about:blank';
      };
    }

    if (mode === 'eviland') {
      // Flagship: WebGL2 RGBA16F feedback-field reactor driven by the 24-band
      // onset bus + structural memory. Returns null when WebGL2 or float
      // render targets are unavailable, in which case we keep the canvas
      // alive with the non-eval 2D fallback so it never goes dark.
      const smoke = Boolean((window as Window & { __newampSmoke?: unknown }).__newampSmoke);
      const evilandQuality: 'high' | 'medium' | 'low' =
        performance === 'low' ? 'low' : isFullscreen ? 'high' : 'medium';
      // Auto-Pilot governor: detectPerformanceTier()'s one-shot hardware sniff
      // can't see thermal throttling, battery savers, or a GPU busy elsewhere.
      // The governor watches the MEASURED per-frame render cost and steps the
      // internal resolution (then, at its floor, the paint cadence) down when
      // this machine sustainably can't hold budget — and back up when headroom
      // returns. Steps are discrete with dwell + cooldown, so FBO reallocation
      // from resize stays rare.
      const gov = createGovernor({ costBudgetMs: isFullscreen ? 12 : 8 });
      const canPaint = createFrameGate(canvasRef, () => gov.intervalMs(frameIntervalMs));
      let baseDpr = Math.min(window.devicePixelRatio || 1, dprCap);
      const stopDisplayWatch = watchDisplayChange(() => {
        baseDpr = Math.min(window.devicePixelRatio || 1, dprCap);
      });
      // A context the GPU takes is asked back and the renderer rebuilds on it.
      // If it has not come back in a few seconds the surface paints with the
      // 2D fallback instead (the canvas stays bound to WebGL, so React swaps it
      // for a new one: see surfaceKey).
      const contextWatch = watchContextFallback(() => setFellBackFrom(surfaceKey));
      // Only where its output can be flash-guarded: asked before the renderer
      // binds this canvas, so the guarded 2D fallback can still draw on it.
      const renderer = gpuFlashGuardSupported() && !glFellBack
        ? createEvilandRenderer(canvas, { quality: evilandQuality, smoke, onContextEvent: contextWatch.onEvent })
        : null;
      // Photosensitivity limiter on the finished frame, in the renderer's own
      // context. A renderer whose output can't be guarded doesn't run.
      const flashGuard = renderer ? attachFlashGuard(canvas.getContext('webgl2'), canvas) : null;

      if (!renderer || !flashGuard) {
        renderer?.dispose();
        contextWatch.dispose();
        const painter = createFallbackPainter(canvas, engine);
        const stopFallback = startPacedLoop(canPaint, (now) => painter.paint(now), { retryMs: frameIntervalMs, rescue: true });
        return () => {
          stopFallback();
          stopDisplayWatch();
          painter.dispose();
        };
      }

      const binCount = engine.frequencyBinCount;
      const freq = new Uint8Array(new ArrayBuffer(binCount));
      const onsetFreq = new Uint8Array(new ArrayBuffer(binCount));
      const leftFreq = new Uint8Array(new ArrayBuffer(binCount));
      const rightFreq = new Uint8Array(new ArrayBuffer(binCount));
      // Time-domain bytes for the renderer's waveform layer. 256 samples is the
      // tap size the renderer expects; reuse one buffer across the lifetime of
      // the effect to keep the hot path allocation-free.
      const evWave = new Uint8Array(256);
      let reactor = createEvilandReactor({
        sampleRate: engine.getSampleRate(),
        fftSize: engine.fftSize,
        binCount,
      });
      // Bit-Perfect output can move the device to another rate between tracks.
      const rateChanged = createSampleRateWatch(() => engine.getSampleRate(), engine.getSampleRate());
      const scoreFeed = createEngineScoreFeed(engine, () => usePlayerStore.getState().current);
      let lastNow = 0;
      if (engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});

      // Hoist the palette out of the rAF loop. getComputedStyle forces a style
      // recalc; calling it 4x per frame + allocating 4 fresh rgb arrays was
      // burning real CPU. Refreshed ~1x/sec on the paint cadence inside the
      // loop (same tick pattern as the 2D modes) so a skin change re-tints
      // the running WebGL2 renderer live — renderer.render() consumes the
      // palette every frame, so theme colors flow as uniform updates with no
      // remount and no setConfig call.
      let palette = readThemePalette();
      let paletteTick = 0;
      // The cover's colours for the current track (async, best-effort, cached
      // by URL). resolveEvilandPalette takes them through the sleeve, the same
      // way Eviland Live and the projector do.
      const sleeve: Sleeve = { art: null, seed: '' };
      let sleeveArt: Sleeve['art'] = null;
      let artTrackId: number | null | undefined = undefined;
      const refreshArtPalette = (trackId: number | null): void => {
        if (trackId === artTrackId) return;
        artTrackId = trackId;
        sleeveArt = null;
        if (trackId == null) return;
        watchArtPalette(api.getArtUrl(trackId), () => artTrackId === trackId, (art) => {
          sleeveArt = art;
        });
      };

      // ── Eviland AI Director + manual look state ───────────────────────────
      // The Director morphs the operator config across song sections; manual
      // looks (randomize / shared seed) are applied once when the store's
      // nonce changes and persist until the user randomizes again or re-
      // enables the director.
      //
      // The MemoryBridge owns persistence + lineage evolution; the Director
      // stays pure (no Date.now, no IPC). We construct the Director WITHOUT
      // a plan, then loadOrSeed → loadPlan asynchronously so a track-load
      // race never blocks the renderer's first frame.
      //
      // Bridge ownership: we ask the registry's keyed cache for the bridge
      // matching the current trackId. The cache survives same-track remounts
      // (quality/performance changes re-run this effect mid-song;
      // palette/reactivity are live-tuned via
      // tuningRef and no longer remount at all). On track change we
      // explicitly releaseBridgeForTrack(oldId), which flushes + drops the
      // cache entry. On effect cleanup we DO NOT release: a remount caused by
      // a deps change is the common case and we want zero IPC churn.
      const initial = evilandStateRef.current;
      let bridge: MemoryBridge = acquireBridgeForTrack({ trackId: initial.trackId, api });
      const director = createDirector({
        songId: initial.trackId != null ? `track-${initial.trackId}` : 'eviland',
        // onSectionLearn captures `bridge` by reference via a closure that
        // reads the current value — so the Director keeps writing into
        // whatever bridge is active after a track change, not the original.
        onSectionLearn: (section) => bridge.observeSection(section),
        // Bounded priming defer: hold the first-ever fresh-mint
        // for ~30 frames (~500ms @ 60fps) while loadOrSeed's IPC resolves,
        // so a track with a persisted plan doesn't render its opening
        // moments under the default lineage. loadPlan() opens the gate the
        // instant the plan lands; the gate expires by itself if no plan
        // arrives (the song is genuinely new) so a brand-new track sees
        // <500ms of default-config rendering before the priming look mints.
        deferPrimingFrames: 30,
      });
      bridge.attachDirector(director);
      publishActiveBridge(bridge);
      // Same-track remount fast path: if the cached bridge
      // already has an in-memory plan (we just re-attached an existing
      // bridge across a quality/performance remount), prime the fresh
      // Director from that plan synchronously. No IPC round-trip.
      const cachedPlan = bridge.getCurrentPlan();
      if (cachedPlan) director.loadPlan(cachedPlan);
      // Captured identity guard: if a track change replaces `bridge` before
      // this IPC resolves, the .then closure sees `bridge !== originalBridge`
      // and bails — never calling loadPlan onto the now-reset director with
      // an old track's plan. Same shape as the track-change branch below.
      // We still call loadOrSeed even on a cached bridge so a stale row that
      // was persisted by another writer can refresh us — but the cachedPlan
      // path above ensures the Director is bound BEFORE the first frame
      // either way, killing the "fresh-mint look on remount" race.
      const originalBridge = bridge;
      void originalBridge.loadOrSeed().then((plan) => {
        if (bridge !== originalBridge) return;
        if (plan) director.loadPlan(plan);
      });
      const lookRequests = createLookRequestCursor();
      let lastAppliedNonce = -1;
      let lastTrackId: number | null = initial.trackId;
      let manualConfig: OperatorConfig | null = null;
      // Edge-detect frame.sectionReturn for the lineage counter. We compare
      // integers only and route through the registry — wrong-track events
      // are no-ops, no-bridge events are no-ops. Allocation-free.
      let lastSectionReturn = -1;

      function applyManualSeed(seed: string | null): OperatorConfig | null {
        if (!seed) return null;
        // Prefer decode() so user-shared codes round-trip exactly; fall back to
        // generate() for derived "seed-N" strings the store mints.
        const decoded = decodeEvilandConfig(seed);
        if (decoded) return decoded;
        return generateEvilandConfig(seed).config;
      }



      const loop = (now: number) => {
        // NOTE: `performance` is the component's tier prop in this scope —
        // the clock must be window.performance.
        const renderStart = window.performance.now();
        const newRate = rateChanged(now);
        if (newRate) reactor = createEvilandReactor({ sampleRate: newRate, fftSize: engine.fftSize, binCount });
        const node = canvasRef.current;
        if (node) {
          const cssW = node.clientWidth || 100;
          const cssH = node.clientHeight || 100;
          const fit = Math.min(1, Math.sqrt(maxPixels / Math.max(1, cssW * baseDpr * cssH * baseDpr)));
          renderer.resize(cssW, cssH, baseDpr * fit * gov.scale());
        }
        engine.getFreqData(freq);
        engine.getOnsetFreqData(onsetFreq);
        engine.getLeftFreqData(leftFreq);
        engine.getRightFreqData(rightFreq);
        engine.getTimeData(evWave);
        renderer.setWaveform(evWave);

        const dtMs = lastNow ? now - lastNow : 16.7;
        const evFrame = reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, now);
        lastNow = now;
        // Look-ahead cues from the track's song score; a no-op without one.
        scoreFeed.conduct(evFrame, dtMs);

        // The detached/projector window is fed by the headless producer
        // (src/visualizer/eviland-producer.ts), NOT from here — that keeps the
        // projector alive while the user browses NewAmp with no on-screen
        // visualizer mounted. This branch only renders the on-screen canvas.

        // Live UI state (director toggle, randomize nonce, waveform override).
        // Read via ref — no per-frame React subscription, no rAF restart.
        const ui = evilandStateRef.current;
        refreshArtPalette(ui.trackId);
        if (ui.trackId !== lastTrackId) {
          // Track change: release the OLD bridge from the keyed cache (this
          // flushes-and-disposes it asynchronously — we don't await), reset
          // the Director for the new song, then acquire a bridge for the new
          // track from the cache. lastSectionReturn resets so the first frame
          // of the new track doesn't fire a spurious section-return event.
          const previousTrackId = lastTrackId;
          void releaseBridgeForTrack(previousTrackId, 'track-change');
          lastTrackId = ui.trackId;
          lastSectionReturn = -1;
          // The reactor's own structural memory (novelty baseline, section
          // fingerprints/ids, tempo tracking) otherwise survives every track
          // change for the life of this effect: the old track's spectrum and
          // timestamps make the new track's first analyze() read as a huge
          // jump, likely firing a spurious sectionChanged before the
          // deferPrimingFrames guard below even applies (that guard only
          // covers the no-boundary-yet priming path, not a genuine
          // sectionChanged from stale memory).
          reactor.reset();
          director.reset(ui.trackId != null ? `track-${ui.trackId}` : 'eviland');
          bridge = acquireBridgeForTrack({ trackId: ui.trackId, api });
          bridge.attachDirector(director);
          publishActiveBridge(bridge);
          // Captured identity guard: a subsequent track change before this
          // resolves invalidates the .then. Belt-and-suspenders for finding
          // #3: ALWAYS call director.loadPlan, falling back to an empty plan
          // when loadOrSeed yields null, so the Director's pendingPlan is
          // ALWAYS bound to the new track. The Director-side reset() clear
          // (eviland-director.ts) is the load-bearing fix; this is the
          // belt-and-suspenders pass.
          const currentBridge = bridge;
          const capturedTrackId = ui.trackId;
          void currentBridge.loadOrSeed().then((plan) => {
            if (bridge !== currentBridge) return;
            if (plan) {
              director.loadPlan(plan);
            } else if (capturedTrackId != null) {
              // No own plan + no neighbor borrow → seed the Director with an
              // empty plan stamped for THIS trackId so reset()'s pendingPlan
              // can never hold a previous track's data. createEmptyPlan
              // produces a deterministic rootSeed derived from `track-${id}`,
              // matching the Director's first-play seedFor() path so this
              // doesn't change the visible look.
              director.loadPlan(createEmptyPlan(
                capturedTrackId,
                `track-${capturedTrackId}`,
                hashSeed(`track-${capturedTrackId}`),
              ));
            }
          });
        }

        // Section-return edge detect → lineage counter. Allocation-free
        // integer compare; routed through the registry so wrong-track and
        // no-bridge cases are cheap no-ops. Only fires on the RISING edge
        // (i.e. the frame where sectionReturn transitions from -1 to >=0).
        if (evFrame.sectionReturn >= 0 && evFrame.sectionReturn !== lastSectionReturn) {
          notifySectionReturn(ui.trackId);
        }
        lastSectionReturn = evFrame.sectionReturn;

        // Skips pressed while a manual look is up are dropped, not saved.
        if (!ui.director) lookRequests.drain(director, false);
        if (ui.director) {
          // Director owns the config: it produces a fresh OperatorConfig each
          // frame (a smoothstep crossfade between section looks). Push it to
          // the renderer every frame so live audio reactivity stays current.
          lookRequests.drain(director, true);
          const directed = director.update(evFrame, dtMs);
          renderer.setConfig(applyWaveformOverride(directed, ui.waveMode));
          // Reset manual tracking so the next director→off flip re-applies
          // the manual look (or default) cleanly.
          lastAppliedNonce = -1;
          manualConfig = null;
        } else if (ui.nonce !== lastAppliedNonce) {
          // A randomize / paste-seed / waveform-mode change just landed.
          // Rebuild + apply the look exactly once, then idle the setConfig
          // path until the next nonce bump.
          const base = ui.seed ? applyManualSeed(ui.seed) : null;
          // Turning the Director off mid-fade must not freeze its half-done
          // transition: keep the look, drop the fade.
          manualConfig = base ?? stripTransitionMeta(cloneConfig(renderer.getConfig()));
          renderer.setConfig(applyWaveformOverride(manualConfig, ui.waveMode));
          lastAppliedNonce = ui.nonce;
        }
        // else: director off + no pending change → renderer keeps its last
        // config (default or last manual look). No per-frame setConfig.

        if (paletteTick++ % 30 === 0) {
          palette = readThemePalette();
          // Observability breadcrumb (~1x/sec): smokes and bug reports can
          // read the governor's live verdict straight off the DOM.
          if (node) {
            const snap = gov.snapshot();
            node.setAttribute('data-newamp-gov', `${snap.verdict}@${snap.scale}`);
            node.setAttribute('data-newamp-render-size', `${node.width}x${node.height}`);
          }
        }
        try {
          const look = renderer.getConfig();
          renderer.render(
            tuneEvilandFrame(evFrame, tuningRef.current.reactivity),
            resolveEvilandPalette(
              tuningRef.current.palette,
              palette,
              now / 1000,
              evFrame.score?.keyShift,
              look.palette,
              sleeveFor(look, sleeveArt, sleeve),
              evFrame.score?.minor,
              evFrame.score?.keyConfidence,
            ),
            dtMs,
            'host',
          );
        } finally {
          // Even when render throws after drawing: whatever reached the
          // backbuffer is shown, so it is guarded. Inside the governed cost on
          // purpose: the governor may trim the resolution the guard runs at,
          // never the guard itself.
          flashGuard?.apply(dtMs);
        }
        gov.endFrame(now, window.performance.now() - renderStart);
      };
      // Sleeps between paints instead of waking on every vsync to skip most of
      // them. The next wake-up is booked before a frame is drawn.
      const stopLoop = startPacedLoop(canPaint, loop, { retryMs: frameIntervalMs });

      return () => {
        stopLoop();
        stopDisplayWatch();
        flashGuard?.dispose();
        // Finding #6 fix: do NOT flushAndDispose here. The registry's keyed
        // cache holds the bridge across same-track remounts (quality/
        // performance changes mid-song re-run this effect). The
        // bridge's in-memory plan, buffered learning, and counters all carry
        // forward — no IPC round-trip, no race between an old fire-and-forget
        // flush and the new mount's loadOrSeed. Persistence still happens via
        // the bridge's own dirty-threshold + visibility-hidden flush triggers
        // (LEARN_FLUSH_THRESHOLD and VISIBILITY_FLUSH_DEBOUNCE_MS), and on
        // true track-change via releaseBridgeForTrack() above.
        publishActiveBridge(null);
        scoreFeed.dispose();
        contextWatch.dispose();
        renderer.dispose();
        releaseGlContext(canvas);
      };
    }

    return startCanvasVisualizer({
      canvas, engine, mode, performance, quality, tuning: tuningRef, frameIntervalMs, dprCap, maxPixels, isFullscreen, mayFlashLarge,
      onGpuStart: () => { if (engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {}); },
    });
  }, [dprCap, engine, frameIntervalMs, glFellBack, isFullscreen, maxPixels, mayFlashLarge, mode, suspendedByFullscreen, surfaceKey]);

  const style: CSSProperties = {};
  if (width != null) style.width = `${width}px`;
  if (height != null) style.height = `${height}px`;

  // Butterchurn mode layers an iframe (the actual Milkdrop render)
  // over a placeholder canvas. The canvas keeps the smoke selector + mount flag
  // and is the surface the canvas-2D fallback paints to if the iframe can't host.
  // 'eviland-live' uses the same stack: the iframe carries the complete Live
  // composition, so there are no extra overlay canvases to keep in sync.
  if (mode === 'butterchurn' || mode === 'eviland-live') {
    return (
      <div
        // Zero-hitch theming: palette/reactivity deliberately NOT in the key
        // (or the effect deps) — they flow into the live render loops via
        // tuningRef, and skin colors via the tick-gated getCssVar refresh.
        // Only mode/quality/performance rebuild the renderer.
        key={`${surfaceKey}${glFellBack ? '-2d' : ''}`}
        className={className ?? 'h-full w-full'}
        style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius)', ...style }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          data-newamp-visualizer-canvas
          data-newamp-visualizer-mode={mode}
          style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', borderRadius: 'var(--radius)' }}
        />
        <iframe
          ref={butterchurnIframeRef}
          title="NewAmp Milkdrop visualizer"
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', borderRadius: 'var(--radius)', display: 'block', pointerEvents: 'none' }}
        />
      </div>
    );
  }

  return (
    <canvas
      // Zero-hitch theming: palette/reactivity deliberately NOT in the key —
      // see the identical note on the butterchurn/eviland-live wrapper above.
      // A canvas that has held WebGL cannot give a 2D context, so the fallback
      // after a lost context gets a new one.
      key={`${surfaceKey}${glFellBack ? '-2d' : ''}`}
      ref={canvasRef}
      aria-hidden="true"
      data-newamp-visualizer-canvas
      data-newamp-visualizer-mode={mode}
      className={className ?? 'h-full w-full'}
      style={{ display: 'block', borderRadius: 'var(--radius)', ...style }}
    />
  );
}

/**
 * The skin's colours as Eviland's theme palette. `--accent-dim` is the dark
 * role when the skin has one, and `--viz-light` the light role when a skin
 * wants a specific colour at the top of the ramp (UI ink is otherwise off the
 * table: it is near white, and every ramp topped out there). The rest is built
 * in OKLCh from the accent, in themePaletteFromAccent, which the projector
 * uses too so every host resolves the same palette.
 */
function readThemePalette(): EvilandPalette {
  const dim = getCssVar('--accent-dim', '');
  const light = getCssVar('--viz-light', '');
  return themePaletteFromAccent(
    parseRgbVec(getCssVar('--accent')),
    dim ? parseRgbVec(dim) : null,
    parseRgbVec(getCssVar('--bg', '#05060a'), [0.02, 0.024, 0.04]),
    light ? parseRgbVec(light, [1, 1, 1]) : null,
  );
}

function rgbVecEquals(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Change gate for the live theme-palette refresh — avoids re-blending the
 * album-art mix (eviland-live overlay) when the skin hasn't actually moved. */
function evilandPaletteEquals(a: EvilandPalette, b: EvilandPalette): boolean {
  return (
    rgbVecEquals(a.accent, b.accent) &&
    rgbVecEquals(a.dark, b.dark) &&
    rgbVecEquals(a.light, b.light) &&
    rgbVecEquals(a.bg, b.bg) &&
    (a.accent2 === undefined ? b.accent2 === undefined : b.accent2 !== undefined && rgbVecEquals(a.accent2, b.accent2))
  );
}
