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
  CONTAINER_AUDIO_EXTENSIONS,
  type AudioQualityTrackInput,
} from './audio-quality.js';

export type FormatBadgeKind = 'lossless' | 'hires' | 'dsd' | 'lossy' | 'container';
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

// bitsPerSample (e.g. 16/24) rides along on the quality input; when it is
// null the hi-res label leaves it out.
export type FormatBadgeInput = AudioQualityTrackInput;

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
      title: signal.decodePath === 'ffmpeg-pcm-fallback'
        ? `${signal.displayExt} · ${dsdRateHumanLabel(input.sampleRate)}. Plays via FFmpeg → PCM in Chromium.`
        : `${signal.displayExt} · ${dsdRateHumanLabel(input.sampleRate)}. Raw DSD server streams are not playable in the browser. Enable conversion to PCM or another browser-compatible format on your music server.`,
    });
    return badges;
  }

  if (signal.isLossless) {
    const codecName = containerCodecName(ext, input.codec);
    badges.push({
      kind: 'lossless',
      label: codecLabel(ext, signal.displayExt, codecName),
      tone: 'accent',
      title: codecName && codecName !== signal.displayExt
        ? `${signal.displayExt} · ${codecName}, lossless codec.`
        : `${signal.displayExt} · lossless codec.`,
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

  // A container (.m4a, .mka) whose codec no scan has recorded yet could hold
  // either family, so it gets a neutral chip instead of a lossy claim.
  if (signal.family === 'container') {
    if (verbose || density === 'comfortable') {
      badges.push({
        kind: 'container',
        label: signal.displayExt,
        tone: 'muted',
        title: `${signal.displayExt} container · codec not read yet.`,
      });
      const kbps = bitrateKbps(input.bitrate);
      if (kbps != null) {
        badges.push({ kind: 'container', label: String(kbps), tone: 'muted', title: `${kbps} kbps ${signal.displayExt}.` });
      }
    }
    return badges;
  }

  // Lossy. Always surface the codec in verbose mode; in compact mode rely on
  // the row's existing context (filename / column) and only chip the bitrate
  // when it's interesting.
  if (verbose) {
    const codecName = containerCodecName(ext, input.codec);
    badges.push({
      kind: 'lossy',
      label: codecLabel(ext, signal.displayExt, codecName),
      tone: 'muted',
      title: codecName && codecName !== signal.displayExt
        ? `${signal.displayExt} · ${codecName}, lossy codec.`
        : `${signal.displayExt} · lossy codec.`,
    });
  }
  const kbps = bitrateKbps(input.bitrate);
  if (kbps != null) {
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

function bitrateKbps(bitrate: number | null | undefined): number | null {
  return bitrate != null && bitrate > 0 ? Math.round(bitrate / 1000) : null;
}

const containerExtSet = new Set<string>(CONTAINER_AUDIO_EXTENSIONS);

// The file's own codec name, for the containers whose extension cannot say
// (an .m4a is ALAC or AAC). Elsewhere the extension is the label.
function containerCodecName(ext: string, codec: string | null | undefined): string | null {
  if (!containerExtSet.has(ext)) return null;
  const name = (codec ?? '').toLowerCase();
  if (name.includes('alac')) return 'ALAC';
  if (name.includes('aac')) return 'AAC';
  if (name.includes('flac')) return 'FLAC';
  if (name.includes('opus')) return 'OPUS';
  if (name.includes('vorbis')) return 'VORBIS';
  if (/mp3|layer 3|layer3/.test(name)) return 'MP3';
  if (/ac-?3/.test(name)) return 'AC3';
  return null;
}

/** Short display label for the codec, with a few familiar overrides. */
function codecLabel(ext: string, fallback: string, codecName: string | null = null): string {
  if (codecName) return codecName;
  if (!ext) return fallback;
  switch (ext) {
    case 'aif':
      return 'AIFF';
    case 'oga':
      return 'OGG';
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
 * The multiplier convention names the rate CLASS (DSD64 ≈ 2.8 MHz, DSD128 ≈
 * 5.6 MHz, …), not the underlying base, so both 44.1k-base and 48k-base
 * sources should classify to the same label. We accept either base with the
 * same ±5% tolerance for tagger rounding; bare "DSD" is only returned when
 * neither family matches.
 */
export function dsdLabelFromSampleRate(sampleRate: number | null | undefined): string {
  const rate = numberOrNull(sampleRate);
  if (rate == null) return 'DSD';
  const bases = [44100, 48000];
  const multipliers = [64, 128, 256, 512, 1024] as const;
  for (const base of bases) {
    for (const m of multipliers) {
      const target = base * m;
      if (Math.abs(rate - target) <= target * 0.05) return `DSD${m}`;
    }
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
