// Album-art palette extraction + theme blending for Eviland.
//
// MilkDrop presets ship their own fixed colors; Eviland instead *sees the
// record sleeve*: the dominant colors of the current album art are blended
// into the EvilandPalette that drives the scene overlay, the reactor event
// canvas, and the projector's fallback renderer — so a red album burns red
// and a teal album glows teal, per track, with zero shader changes (every
// layer already takes its colors from the palette contract).
//
// Extraction is a coarse saturation-weighted hue histogram over a 24×24
// downsample — deliberately not k-means. It runs once per track change
// (cached by URL, in-flight deduped) and must never block the audio/render
// path: fully async, best-effort, null on any failure, and callers fall back
// to the pure theme palette whenever it yields nothing (grayscale sleeves,
// missing art, decode errors).

import type { EvilandPalette } from './eviland';

export interface ArtPalette {
  /** Most vibrant dominant color — becomes the accent. */
  vibrant: [number, number, number];
  /** Second distinct hue (or a lightened vibrant when the art is one-hued). */
  secondary: [number, number, number];
  /** Darkened overall tone — trails/shadows. */
  muted: [number, number, number];
}

const SAMPLE_SIZE = 24;
const HUE_BUCKETS = 12;
const CACHE_CAP = 24;

const cache = new Map<string, ArtPalette | null>();
const inflight = new Map<string, Promise<ArtPalette | null>>();

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function loadImage(url: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const settle = (value: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => settle(null), timeoutMs);
    img.onload = () => settle(img);
    img.onerror = () => settle(null);
    img.src = url;
  });
}

function analyze(img: HTMLImageElement): ArtPalette | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return null; // tainted canvas / decode failure
  }

  // Saturation×value-weighted hue histogram, plus a whole-image mean for the
  // muted tone. Near-black and washed-out pixels don't vote for hues.
  const weight = new Float32Array(HUE_BUCKETS);
  const sumR = new Float32Array(HUE_BUCKETS);
  const sumG = new Float32Array(HUE_BUCKETS);
  const sumB = new Float32Array(HUE_BUCKETS);
  let meanR = 0;
  let meanG = 0;
  let meanB = 0;
  const pixels = SAMPLE_SIZE * SAMPLE_SIZE;
  for (let i = 0; i < pixels; i++) {
    const r = data[i * 4]! / 255;
    const g = data[i * 4 + 1]! / 255;
    const b = data[i * 4 + 2]! / 255;
    meanR += r;
    meanG += g;
    meanB += b;
    const [h, s, v] = rgbToHsv(r, g, b);
    if (v < 0.12 || s < 0.14) continue;
    const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS));
    const w = s * v;
    weight[bucket] += w;
    sumR[bucket] += r * w;
    sumG[bucket] += g * w;
    sumB[bucket] += b * w;
  }
  meanR /= pixels;
  meanG /= pixels;
  meanB /= pixels;

  let best = -1;
  for (let i = 0; i < HUE_BUCKETS; i++) {
    if (weight[i]! > (best < 0 ? 0 : weight[best]!)) best = i;
  }
  // Not enough chroma to say anything (grayscale/near-mono art) → let the
  // theme palette stand untouched.
  if (best < 0 || weight[best]! < pixels * 0.01) return null;

  const bucketColor = (i: number): [number, number, number] => [
    sumR[i]! / weight[i]!,
    sumG[i]! / weight[i]!,
    sumB[i]! / weight[i]!,
  ];
  const vibrant = bucketColor(best);

  // Second hue must sit at least 2 buckets away so "vibrant vs slightly
  // different vibrant" doesn't masquerade as a two-color palette.
  let second = -1;
  for (let i = 0; i < HUE_BUCKETS; i++) {
    const dist = Math.min(Math.abs(i - best), HUE_BUCKETS - Math.abs(i - best));
    if (dist < 2 || weight[i]! <= 0) continue;
    if (second < 0 || weight[i]! > weight[second]!) second = i;
  }
  const lighten = (c: [number, number, number], t: number): [number, number, number] => [
    c[0] + (1 - c[0]) * t,
    c[1] + (1 - c[1]) * t,
    c[2] + (1 - c[2]) * t,
  ];
  const secondary =
    second >= 0 && weight[second]! > weight[best]! * 0.2
      ? lighten(bucketColor(second), 0.25)
      : lighten(vibrant, 0.45);

  const muted: [number, number, number] = [meanR * 0.45, meanG * 0.45, meanB * 0.45];
  return { vibrant, secondary, muted };
}

/**
 * Dominant-color extraction for an album-art URL. Cached, deduped, and
 * best-effort — resolves null on any failure so callers can just fall back.
 */
export function extractArtPalette(url: string): Promise<ArtPalette | null> {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
  const pending = inflight.get(url);
  if (pending) return pending;
  const p = loadImage(url, 4000)
    .then((img) => (img ? analyze(img) : null))
    .catch(() => null)
    .then((palette) => {
      inflight.delete(url);
      if (cache.size >= CACHE_CAP) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(url, palette);
      return palette;
    });
  inflight.set(url, p);
  return p;
}

const mixVec = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Blend album-art colors into a theme EvilandPalette. The background stays
 * pure theme (legibility contract); accent leans hardest into the art, the
 * light tone least — bright layers must stay bright regardless of the sleeve.
 */
export function blendPaletteWithArt(
  theme: EvilandPalette,
  art: ArtPalette | null,
  mix = 0.6,
): EvilandPalette {
  if (!art) return theme;
  return {
    accent: mixVec(theme.accent, art.vibrant, mix),
    dark: mixVec(theme.dark, art.muted, mix),
    light: mixVec(theme.light, art.secondary, mix * 0.7),
    bg: theme.bg,
  };
}
