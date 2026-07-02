// Headless Eviland frame producer.
//
// The detached visualizer window is a pure frame consumer: it owns a WebGL2
// EvilandRenderer but no audio. Frames are produced in the MAIN renderer and
// shipped across a MessagePort by frame-bus. Previously the ONLY producer was
// the on-screen <Visualizer mode="eviland">, so the detached window went black
// unless the user was sitting in the fullscreen 'eviland' preset — and it died
// the moment they left fullscreen to browse their library.
//
// This module decouples frame production from the UI entirely: a singleton
// reactor + director run a rAF loop whenever a detached window is attached,
// regardless of which preset (or no visualizer at all) is on-screen. The user
// can pop the projector onto a 2nd monitor and keep using NewAmp normally.
//
// Cost when no detached window is open: zero (the loop isn't running). When
// open: one reactor.analyze + one director.update per frame — the same work
// the on-screen Eviland branch already does.

import type { AudioEngine } from '../audio/engine';
import { createEvilandReactor, type EvilandReactor } from './eviland-audio';
import { createDirector, type Director } from './eviland-director';
import { generate as generateEvilandConfig, decode as decodeEvilandConfig } from './eviland-randomizer';
import type { OperatorConfig, WaveMode } from './eviland-operators';
import type { EvilandPalette } from './eviland';
import { frameBus } from './frame-bus';
import { createMemoryBridge, sceneSeedForTrack, type MemoryBridge } from './eviland-memory-bridge';
import { blendPaletteWithArt, extractArtPalette, type ArtPalette } from './art-palette';
import { api } from '../lib/api';
import { BUTTERCHURN_FFT_SIZE } from '../butterchurn-iframe/protocol';

// Mild pre-emphasis (~1.4x with soft-clip) so the detached window's MilkDrop
// field reacts to transients the way the on-screen one does — same constant as
// Visualizer.tsx's butterchurn pump.
const WAVE_PREEMPHASIS = 1.4;

export interface EvilandProducerUiState {
  /** AI Director on → look conducts itself to the song. */
  director: boolean;
  /** Manual seed code (randomize / paste). Null = renderer default. */
  seed: string | null;
  /** Bumped on every manual config request so the producer re-applies the seed. */
  nonce: number;
  /** Waveform-layer override applied on top of the active config. */
  waveMode: 'off' | 'line' | 'radial' | 'bars';
  /** Current track id (re-arms the director's section memory on change). */
  trackId: number | null;
  /**
   * Render tier for the detached projector (derived from the user's
   * visualizer prefs — see lib/vizPrefs). Pushed to the consumer on change;
   * previously hardcoded 'high', which double-billed weak GPUs the moment
   * both windows ran.
   */
  projectorQuality: 'high' | 'medium' | 'low';
  /**
   * Live transport snapshot for the detached projector's floating control bar.
   * Null when nothing is playing (the projector renders an idle state).
   */
  transport?: {
    title: string | null;
    artist: string | null;
    album: string | null;
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    /** Perceptual volume 0..2 — drives the projector's volume slider. */
    volume: number;
  } | null;
}

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#39ff14';
}

function parseRgbVec(color: string): [number, number, number] {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;
    if ([r, g, b].every(Number.isFinite)) return [r, g, b];
  }
  return [0.22, 1, 0.08];
}

function readPalette(): EvilandPalette {
  return {
    accent: parseRgbVec(getCssVar('--accent')),
    dark: parseRgbVec(getCssVar('--accent-dim') || getCssVar('--accent')),
    light: parseRgbVec(getCssVar('--ink') || '#ffffff'),
    bg: parseRgbVec(getCssVar('--bg') || '#05060a'),
  };
}

function applyManualSeed(seed: string | null): OperatorConfig | null {
  if (!seed) return null;
  const decoded = decodeEvilandConfig(seed);
  if (decoded) return decoded;
  return generateEvilandConfig(seed).config;
}

function applyWaveformOverride(
  config: OperatorConfig,
  waveMode: 'off' | 'line' | 'radial' | 'bars',
): OperatorConfig {
  if (waveMode === 'off') return config;
  return { ...config, waveform: { ...config.waveform, mode: waveMode as WaveMode } };
}

let activeStop: (() => void) | null = null;

/**
 * Producer-side: hot-load the persisted plan into the local Director so the
 * detached projector remembers the track without being on-screen. READ-ONLY:
 * we never call observeSection or flush — the on-screen Visualizer's bridge
 * owns writes.
 *
 * Cancellation: captures the trackId at call time and compares against the
 * producer's CURRENT trackId after the IPC resolves. If the producer's track
 * changed mid-flight, the loaded plan is discarded (loadPlan is NOT called)
 * so the now-reset director for the new track isn't repopulated with stale
 * sections. This is the producer-side mirror of the on-screen Visualizer's
 * captured-bridge identity guard (finding #5 from the pre-release review).
 *
 * The `getCurrentTrackId` getter reads the producer's `lastTrackId` closure
 * variable lazily — it's the source of truth for the producer's current track,
 * updated synchronously by the rAF loop's track-change branch.
 */
function maybeLoadPlanIntoProducerDirector(
  director: Director,
  trackId: number | null,
  getCurrentTrackId: () => number | null,
  onSceneSeed: (seed: string) => void,
): void {
  if (trackId == null) return;
  const readOnlyBridge: MemoryBridge = createMemoryBridge({ trackId, api });
  const target = director;
  const capturedTrackId = trackId;
  void readOnlyBridge.loadOrSeed().then((plan) => {
    // Discard if the producer's track changed while we were waiting.
    if (getCurrentTrackId() !== capturedTrackId) {
      void readOnlyBridge.flushAndDispose('manual');
      return;
    }
    if (plan) {
      target.loadPlan(plan);
      // Upgrade the projector's scene-rotation seed to the lineage-aware key
      // under the same identity guard, so a remembered track's scene walk
      // matches the on-screen composition (and evolves with its generation).
      const seed = sceneSeedForTrack(capturedTrackId, plan);
      if (seed) onSceneSeed(seed);
    }
    // Dispose without flushing — the bridge has no buffered sections (we
    // never observed) so this is a clean teardown of the visibility listener.
    void readOnlyBridge.flushAndDispose('manual');
  });
}

/**
 * Start the singleton headless producer. Idempotent — a second call replaces
 * the previous producer. Returns a stop function (cleanup for the host effect).
 */
export function startEvilandProducer(
  engine: AudioEngine,
  getUiState: () => EvilandProducerUiState,
): () => void {
  activeStop?.();

  let timer = 0;
  let loopActive = false;
  let reactor: EvilandReactor | null = null;
  let director: Director | null = null;
  let lastNow = 0;
  let lastTrackId: number | null = null;
  let sceneSeed: string | null = null;
  let lastAppliedNonce = -1;
  let manualConfig: OperatorConfig | null = null;
  let paletteTick = 0;
  let palette = readPalette();
  // Album-art tint for the projector: extracted once per track (async,
  // best-effort), blended into every published palette so the detached
  // window's scenes/reactor/fallback renderer glow in the sleeve's colors.
  let artPalette: ArtPalette | null = null;
  let artTrackId: number | null = null;
  function refreshArtPalette(trackId: number | null): void {
    artTrackId = trackId;
    artPalette = null;
    if (trackId == null) return;
    const captured = trackId;
    void extractArtPalette(api.getArtUrl(trackId)).then((art) => {
      if (artTrackId === captured) artPalette = art;
    });
  }
  let freq: Uint8Array<ArrayBuffer> | null = null;
  let onsetFreq: Uint8Array<ArrayBuffer> | null = null;
  let leftFreq: Uint8Array<ArrayBuffer> | null = null;
  let rightFreq: Uint8Array<ArrayBuffer> | null = null;
  let rawWave: Uint8Array<ArrayBuffer> | null = null;
  const waveSamples = new Uint8Array(new ArrayBuffer(BUTTERCHURN_FFT_SIZE));

  function ensureBuffers(): void {
    const n = engine.frequencyBinCount;
    if (!freq || freq.length !== n) {
      freq = new Uint8Array(new ArrayBuffer(n));
      onsetFreq = new Uint8Array(new ArrayBuffer(n));
      leftFreq = new Uint8Array(new ArrayBuffer(n));
      rightFreq = new Uint8Array(new ArrayBuffer(n));
    }
    if (!rawWave || rawWave.length !== engine.fftSize) {
      rawWave = new Uint8Array(new ArrayBuffer(engine.fftSize));
    }
  }

  // Decimate the analyser's time-domain bytes to BUTTERCHURN_FFT_SIZE and
  // apply pre-emphasis + soft-clip — byte-identical math to the on-screen
  // butterchurn pump so the projector's MilkDrop reacts the same way.
  function fillWaveSamples(): void {
    if (!rawWave) return;
    engine.getOnsetTimeData(rawWave);
    const stride = Math.max(1, Math.floor(rawWave.length / BUTTERCHURN_FFT_SIZE));
    for (let i = 0; i < BUTTERCHURN_FFT_SIZE; i++) {
      const centered = ((rawWave[i * stride] ?? 128) - 128) / 128;
      const lifted = centered * WAVE_PREEMPHASIS;
      const clipped = lifted / (1 + Math.abs(lifted));
      waveSamples[i] = 128 + Math.round(clipped * 127);
    }
  }

  let tickCount = 0;
  let lastTickAt = 0;

  const tick = (): void => {
    if (!loopActive) return;
    const now = performance.now();
    tickCount += 1;
    lastTickAt = now;
    if (!frameBus.hasDetachedConsumer()) return;
    if (engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});

    if (!reactor) {
      reactor = createEvilandReactor({
        sampleRate: engine.getSampleRate(),
        fftSize: engine.fftSize,
        binCount: engine.frequencyBinCount,
      });
    }
    ensureBuffers();
    engine.getFreqData(freq!);
    engine.getOnsetFreqData(onsetFreq!);
    engine.getLeftFreqData(leftFreq!);
    engine.getRightFreqData(rightFreq!);

    const dtMs = lastNow ? now - lastNow : 16.7;
    lastNow = now;
    const frame = reactor.analyze(freq!, onsetFreq!, leftFreq!, rightFreq!, dtMs, now);

    // Refresh the palette ~2x/sec so theme changes reach the projector without
    // forcing a style recalc every frame.
    if (paletteTick++ % 30 === 0) palette = readPalette();

    const ui = getUiState();
    // Deduped inside the bus — only a real tier change reaches the consumer.
    frameBus.setDetachedQuality(ui.projectorQuality);
    const setSceneSeed = (seed: string): void => {
      sceneSeed = seed;
    };
    if (!director) {
      director = createDirector({ songId: ui.trackId != null ? `track-${ui.trackId}` : 'eviland' });
      // Set lastTrackId BEFORE issuing the read so getCurrentTrackId() returns
      // the right value if the IPC resolves before the next rAF tick.
      lastTrackId = ui.trackId;
      sceneSeed = sceneSeedForTrack(ui.trackId, null);
      refreshArtPalette(ui.trackId);
      // Producer-side bridge is READ-ONLY: it loads the plan into the local
      // Director so the projector remembers, but it does NOT observe sections
      // or flush. The on-screen Visualizer's bridge is the sole writer; this
      // avoids double-flush + double-counted plays when both run at once.
      maybeLoadPlanIntoProducerDirector(director, ui.trackId, () => lastTrackId, setSceneSeed);
    }
    if (ui.trackId !== lastTrackId) {
      lastTrackId = ui.trackId;
      sceneSeed = sceneSeedForTrack(ui.trackId, null);
      refreshArtPalette(ui.trackId);
      director.reset(ui.trackId != null ? `track-${ui.trackId}` : 'eviland');
      maybeLoadPlanIntoProducerDirector(director, ui.trackId, () => lastTrackId, setSceneSeed);
    }

    let config: OperatorConfig;
    if (ui.director) {
      config = applyWaveformOverride(director.update(frame, dtMs), ui.waveMode);
    } else {
      if (ui.nonce !== lastAppliedNonce) {
        lastAppliedNonce = ui.nonce;
        manualConfig = applyManualSeed(ui.seed);
      }
      config = applyWaveformOverride(manualConfig ?? director.current(), ui.waveMode);
    }

    fillWaveSamples();
    frameBus.publish(frame, blendPaletteWithArt(palette, artPalette), dtMs, config, {
      wave: waveSamples,
      sampleRate: engine.getSampleRate(),
      trackId: ui.trackId,
      sceneSeed,
      // null (not undefined) when nothing is playing — the projector's
      // control bar resets to its idle state on this explicit signal.
      transport: ui.transport ?? null,
    });
  };

  // setInterval, NOT requestAnimationFrame: rAF is tied to the compositor's
  // BeginFrame stream, which stops when the main window is occluded — e.g.
  // when the projector window covers it on a single-monitor setup. The
  // producer is headless (analysis + postMessage; it paints nothing), so a
  // steady 30Hz timer is the right clock. The Electron main process disables
  // backgroundThrottling on this window while a projector is attached so the
  // timer keeps full rate even hidden/minimized.
  const TICK_MS = 33;

  function startLoop(): void {
    if (loopActive) return;
    loopActive = true;
    lastNow = 0;
    timer = window.setInterval(tick, TICK_MS);
  }

  function stopLoop(): void {
    loopActive = false;
    if (timer) window.clearInterval(timer);
    timer = 0;
    reactor = null;
    director = null;
  }

  const offConsumer = frameBus.onConsumerChange((hasDetached) => {
    if (hasDetached) {
      frameBus.setDetachedQuality(getUiState().projectorQuality);
      startLoop();
    } else {
      stopLoop();
    }
  });

  // Live diagnostics for smokes/DevTools.
  Object.defineProperty(window, '__newampProducerDiag', {
    configurable: true,
    get: () => ({
      loopActive,
      tickCount,
      lastTickAgoMs: lastTickAt ? Math.round(performance.now() - lastTickAt) : -1,
      hasConsumer: frameBus.hasDetachedConsumer(),
      bus: frameBus.debugStats(),
    }),
  });

  if (frameBus.hasDetachedConsumer()) {
    frameBus.setDetachedQuality(getUiState().projectorQuality);
    startLoop();
  }

  const stop = (): void => {
    offConsumer();
    stopLoop();
    if (activeStop === stop) activeStop = null;
  };
  activeStop = stop;
  return stop;
}
