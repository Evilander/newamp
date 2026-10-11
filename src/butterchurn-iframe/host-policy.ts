// What the Butterchurn host decides from the messages it gets, apart from the
// DOM and GL it then acts on, so the decisions can be tested on their own.

import type { BcConfigMessage, BcQuality } from './protocol';

export interface ActivityTracker {
  /**
   * Folds in one audio message. `playing` is the parent's word on whether the
   * track is playing; without it, flat samples (a paused analyser) are the
   * pause signal.
   */
  observe(now: number, flat: boolean, playing: boolean | undefined): void;
  /** Quiet for longer than the dwell: paint slowly and stop rotating presets. */
  idle(now: number): boolean;
}

export function createActivityTracker(idleAfterMs: number): ActivityTracker {
  // When the quiet began; -1 while the music is live.
  let quietSince = -1;
  return {
    observe(now, flat, playing) {
      // A quiet passage is as flat as a pause once it is quantised to bytes,
      // so a track the parent says is playing never counts as quiet.
      const quiet = playing === undefined ? flat : !playing;
      if (!quiet) quietSince = -1;
      else if (quietSince < 0) quietSince = now;
    },
    idle: (now) => quietSince >= 0 && now - quietSince > idleAfterMs,
  };
}

export interface HostConfig {
  dpr: number;
  maxPixels: number;
  quality: BcQuality;
  sampleRate: number;
}

export interface ConfigChange {
  dpr: boolean;
  maxPixels: boolean;
  quality: boolean;
  sampleRate: boolean;
}

/** Applies a config message to `config` in place and reports which fields really changed. */
export function applyConfig(config: HostConfig, message: BcConfigMessage): ConfigChange {
  const change: ConfigChange = { dpr: false, maxPixels: false, quality: false, sampleRate: false };
  if (message.dpr !== undefined && message.dpr > 0 && message.dpr !== config.dpr) {
    config.dpr = message.dpr;
    change.dpr = true;
  }
  if (message.maxPixels !== undefined && message.maxPixels > 0 && message.maxPixels !== config.maxPixels) {
    config.maxPixels = message.maxPixels;
    change.maxPixels = true;
  }
  if (message.quality !== undefined && message.quality !== config.quality) {
    config.quality = message.quality;
    change.quality = true;
  }
  if (message.sampleRate !== undefined && message.sampleRate > 0 && message.sampleRate !== config.sampleRate) {
    config.sampleRate = message.sampleRate;
    change.sampleRate = true;
  }
  return change;
}

/**
 * The canvas size for a CSS box drawn at `dpr`, shrunk to fit `maxPixels` and
 * then by `scale` (the cost governor's step).
 */
export function fitCanvasSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxPixels: number,
  scale = 1,
): { width: number; height: number } {
  const fit = Math.min(1, Math.sqrt(maxPixels / Math.max(1, cssWidth * dpr * cssHeight * dpr)));
  return {
    width: Math.max(8, Math.floor(cssWidth * dpr * fit * scale)),
    height: Math.max(8, Math.floor(cssHeight * dpr * fit * scale)),
  };
}

// Animation frames still arriving this recently mean the compositor is
// consuming what the page draws.
const FRAMES_FLOWING_MS = 100;
// With no frames and no paint for this long, paint from the message anyway,
// slowly: an occluded window gets no animation frames, but its feedback field
// should keep evolving.
export const STARVED_PAINT_MS = 250;

/**
 * Whether an audio message should paint right away. While frames are flowing
 * the picture is painted from the message, not from the next animation frame,
 * which would put it a frame behind the sound. Without frames only the slow
 * starved path runs: issuing GL at the full rate to a window the compositor
 * has stopped presenting blocks the renderer thread.
 */
export function paintsFromMessage(now: number, lastFrameAt: number, lastPaintAt: number): boolean {
  if (now - lastFrameAt < FRAMES_FLOWING_MS) return true;
  return now - lastPaintAt > STARVED_PAINT_MS;
}
