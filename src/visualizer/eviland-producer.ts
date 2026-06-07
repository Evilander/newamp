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
 * Start the singleton headless producer. Idempotent — a second call replaces
 * the previous producer. Returns a stop function (cleanup for the host effect).
 */
export function startEvilandProducer(
  engine: AudioEngine,
  getUiState: () => EvilandProducerUiState,
): () => void {
  activeStop?.();

  let raf = 0;
  let loopActive = false;
  let reactor: EvilandReactor | null = null;
  let director: Director | null = null;
  let lastNow = 0;
  let lastTrackId: number | null = null;
  let lastAppliedNonce = -1;
  let manualConfig: OperatorConfig | null = null;
  let paletteTick = 0;
  let palette = readPalette();
  let freq: Uint8Array<ArrayBuffer> | null = null;
  let onsetFreq: Uint8Array<ArrayBuffer> | null = null;
  let leftFreq: Uint8Array<ArrayBuffer> | null = null;
  let rightFreq: Uint8Array<ArrayBuffer> | null = null;

  function ensureBuffers(): void {
    const n = engine.frequencyBinCount;
    if (!freq || freq.length !== n) {
      freq = new Uint8Array(new ArrayBuffer(n));
      onsetFreq = new Uint8Array(new ArrayBuffer(n));
      leftFreq = new Uint8Array(new ArrayBuffer(n));
      rightFreq = new Uint8Array(new ArrayBuffer(n));
    }
  }

  const tick = (now: number): void => {
    if (!loopActive) return;
    raf = requestAnimationFrame(tick);
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
    if (!director) {
      director = createDirector({ songId: ui.trackId != null ? `track-${ui.trackId}` : 'eviland' });
    }
    if (ui.trackId !== lastTrackId) {
      lastTrackId = ui.trackId;
      director.reset(ui.trackId != null ? `track-${ui.trackId}` : 'eviland');
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

    frameBus.publish(frame, palette, dtMs, config);
  };

  function startLoop(): void {
    if (loopActive) return;
    loopActive = true;
    lastNow = 0;
    raf = requestAnimationFrame(tick);
  }

  function stopLoop(): void {
    loopActive = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    reactor = null;
    director = null;
  }

  const offConsumer = frameBus.onConsumerChange((hasDetached) => {
    if (hasDetached) {
      frameBus.setDetachedQuality('high');
      startLoop();
    } else {
      stopLoop();
    }
  });

  if (frameBus.hasDetachedConsumer()) {
    frameBus.setDetachedQuality('high');
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
