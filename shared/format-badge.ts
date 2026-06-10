// Audiophile-visible format badges. Pure, unit-testable helper that classifies
// a Track's file/audio metadata into one or more small chip descriptors which
// the UI renders next to titles, in the Now Playing header, and elsewhere.
//
// We deliberately rely on classifyAudioQuality() for codec family / hi-res /
// lossless determination so a single source of truth governs every UI surface.
// This file adds the *display* concerns: bit-depth/rate labels, DSD multiplier
// labels, lossy bitrate visibility rules, tone hints for skin tokens.
//
// No I/O, no React, no DOM. Safe to import from both the renderer and Node
// (virtual-rows-style esbuild tests can pull it in directly).

import {
  audioExtension,
  classifyAudioQuality,
  type AudioQualityTrackInput,
} from './audio-quality.js';

export type FormatBadgeKind = 'lossless' | 'hires' | 'dsd' | 'lossy';
export type FormatBadgeTone = 'accent' | 'warn' | 'plain' | 'muted';

export interface FormatBadge {
  /** Stable kind for keying + CSS hooks. */
  kind: FormatBadgeKind;
  /** Short uppercase label, e.g. "FLAC", "24/96", "DSD64", "320". */
  label: string;
  /** Color tone (resolves to skin tokens in CSS). */
  tone: FormatBadgeTone;
  /** Long-form tooltip text. */
  title: string;
}

export interface FormatBadgeInput extends AudioQualityTrackInput {
  /** Optional explicit bit depth (e.g. 16/24). Track payload doesn't carry it
   *  today — when null we omit it from the hi-res label. */
  bitsPerSample?: number | null;
}

export interface FormatBadgeOptions {
  /** When true, omit the muted "320" / "192" chip for lossy tracks unless they
   *  are notably low/high. Library rows pass this so we don't render an extra
   *  chip on every MP3 in a 50k-track view. */
  density?: 'comfortable' | 'compact';
  /** When true (Now Playing header / transport), surface every meaningful
   *  badge including the lossy bitrate chip. */
  verbose?: boolean;
}

/**
 * Classify a track into 0..3 small chip descriptors. Returns an empty array
 * when nothing is meaningfully surfaceable (e.g. no codec data at all).
 */
export function formatBadgesForTrack(
  input: FormatBadgeInput,
  options: FormatBadgeOptions = {},
): FormatBadge[] {
  const density = options.density ?? 'compact';
  const verbose = options.verbose ?? false;
  const signal = classifyAudioQuality(input);
  const ext = audioExtension(input.path);
  const badges: FormatBadge[] = [];

  if (signal.isDsd) {
    const dsdLabel = dsdLabelFromSampleRate(input.sampleRate);
    badges.push({
      kind: 'dsd',
      label: dsdLabel,
      tone: 'accent',
      title: `${signal.displayExt} · ${dsdRateHumanLabel(input.sampleRate)}. Plays via FFmpeg → PCM in Chromium.`,
    });
    return badges;
  }

  if (signal.isLossless) {
    badges.push({
      kind: 'lossless',
      label: codecLabel(ext, signal.displayExt),
      tone: 'accent',
      title: `${signal.displayExt} · lossless codec.`,
    });
    if (signal.isHiRes) {
      const bits = normalizeBits(input.bitsPerSample);
      const rateKhz = hzToKhzLabel(input.sampleRate);
      const hiResLabel = bits != null && rateKhz != null
        ? `${bits}/${rateKhz}`
        : rateKhz != null
          ? `${rateKhz}k`
          : 'HI-RES';
      const bitsLine = bits != null ? `${bits}-bit · ` : '';
      const rateLine = input.sampleRate != null
        ? `${(input.sampleRate / 1000).toFixed(1)} kHz`
        : 'high sample rate';
      badges.push({
        kind: 'hires',
        label: hiResLabel,
        tone: 'warn',
        title: `Hi-res lossless · ${bitsLine}${rateLine}. Verify your DAC matches the rate in Settings → Audio.`,
      });
    }
    return badges;
  }

  // Lossy. Always surface the codec in verbose mode; in compact mode rely on
  // the row's existing context (filename / column) and only chip the bitrate
  // when it's interesting.
  if (verbose) {
    badges.push({
      kind: 'lossy',
      label: codecLabel(ext, signal.displayExt),
      tone: 'muted',
      title: `${signal.displayExt} · lossy codec.`,
    });
  }
  const bitrate = input.bitrate;
  if (bitrate != null && bitrate > 0) {
    const kbps = Math.round(bitrate / 1000);
    const interesting = verbose
      || density === 'comfortable'
      || kbps < 192        // visibly compressed; surface so users notice
      || kbps >= 320;      // notably high quality; reward
    if (interesting) {
      badges.push({
        kind: 'lossy',
        label: String(kbps),
        tone: kbps < 192 ? 'warn' : kbps >= 320 ? 'accent' : 'muted',
        title: `${kbps} kbps ${signal.displayExt}.`,
      });
    }
  }
  return badges;
}

/** Short display label for the codec, with a few familiar overrides. */
function codecLabel(ext: string, fallback: string): string {
  if (!ext) return fallback;
  switch (ext) {
    case 'aif':
      return 'AIFF';
    case 'oga':
      return 'OGG';
    case 'm4a':
      return 'AAC';
    case 'wv':
      return 'WV';
    case 'tta':
      return 'TTA';
    default:
      return ext.toUpperCase();
  }
}

/**
 * Map a DSD sample rate to the familiar DSD64/128/256/512 multiplier label.
 * DSD64 base rate = 44.1 kHz × 64 = 2,822,400 Hz; allow ±5% slop for tagger
 * rounding.
 */
export function dsdLabelFromSampleRate(sampleRate: number | null | undefined): string {
  const rate = numberOrNull(sampleRate);
  if (rate == null) return 'DSD';
  const base = 44100;
  const multipliers = [64, 128, 256, 512, 1024] as const;
  for (const m of multipliers) {
    const target = base * m;
    if (Math.abs(rate - target) <= target * 0.05) return `DSD${m}`;
  }
  return 'DSD';
}

function dsdRateHumanLabel(sampleRate: number | null | undefined): string {
  const rate = numberOrNull(sampleRate);
  if (rate == null) return 'DSD source';
  return `${(rate / 1_000_000).toFixed(2)} MHz`;
}

function hzToKhzLabel(sampleRate: number | null | undefined): string | null {
  const rate = numberOrNull(sampleRate);
  if (rate == null) return null;
  const khz = rate / 1000;
  // 96 → "96", 88.2 → "88.2" — collapse trailing ".0" so the chip stays narrow.
  return Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
}

function normalizeBits(bits: number | null | undefined): number | null {
  if (bits == null || !Number.isFinite(bits) || bits <= 0) return null;
  return Math.round(bits);
}

function numberOrNull(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}
