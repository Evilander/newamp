// Album-art palette extraction + theme blending for Eviland.
//
// MilkDrop presets ship their own fixed colors; Eviland instead *sees the
// record sleeve*: the dominant colors of the current album art are blended
// into the EvilandPalette that drives the scene overlay, the reactor event
// canvas, and the projector's fallback renderer — so a red album burns red
// and a teal album glows teal, per track, with zero shader changes (every
// layer already takes its colors from the palette contract).
//
// Extraction is a coarse hue histogram over a 32×32 downsample, taken in
// OKLCh so a pixel's weight is its chroma and a hue is a hue whatever its
// lightness — deliberately not k-means. It runs once per track change
// (cached by URL, in-flight deduped) and must never block the audio/render
// path: fully async, best-effort, null on any failure, and callers fall back
// to the pure theme palette whenever it yields nothing (grayscale sleeves,
// missing art, decode errors).

import type { EvilandPalette } from './eviland';
import { blendThemeWithSleeve, maxChroma, oklchToRgb, rgbToOklch } from './eviland-appearance';

export interface ArtPalette {
  /** Most vibrant dominant color — becomes the accent. */
  vibrant: [number, number, number];
  /** Second distinct hue (or a lightened vibrant when the art is one-hued). */
  secondary: [number, number, number];
  /** The vibrant hue, dark and quiet — trails/shadows. */
  muted: [number, number, number];
}

const SAMPLE_SIZE = 32;
const HUE_BINS = 24;
const BIN_DEGREES = 360 / HUE_BINS;
const CACHE_CAP = 24;
/** A cover that failed to load or read is tried again after this long (a slow share may have caught up). */
const FAILURE_RETRY_MS = 30_000;
const MUTED_LIGHTNESS = 0.38;
const MUTED_CHROMA = 0.08;
/** OKLCh hues that read as olive or khaki below about L 0.7, and as gold above it. */
const OLIVE_HUES = { from: 50, to: 115 };
/** Where a cover in that band is lit, so a sepia sleeve gives amber rather than olive. */
const OLIVE_LIGHTNESS = 0.76;

interface CacheEntry {
  palette: ArtPalette | null;
  /** When the entry stops being believed: never for a cover that was read, FAILURE_RETRY_MS for one that was not. */
  until: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ArtPalette | null>>();

/** The cover loaded but could not be read (tainted canvas, no 2D context); not the same as a grey cover. */
const UNREADABLE: unique symbol = Symbol('unreadable');

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
    // newart:// is another origin from the page. Without this the canvas below
    // is tainted and getImageData throws for every cover.
    img.crossOrigin = 'anonymous';
    img.src = url;
  });
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * The palette of a size×size RGBA buffer, or null when it has no colour worth
 * following. Pure: the buffer in, the palette out.
 *
 * A pixel votes for its hue with the weight of its chroma, faded out where it
 * is nearly black or nearly white, since the hue of a shadow or a highlight
 * says little about the cover. The one-pixel border is skipped; scanned covers
 * and sleeves with a printed frame would otherwise vote for the frame. Hues go
 * into 24 bins, smoothed across their neighbours, so a red that straddles 0
 * degrees is one hue and not two.
 *
 * `vibrant` is the weighted mean of the winning hue's pixels in OKLab, then
 * given a usable lightness (0.62 to 0.78) and at least 0.6 of the chroma sRGB
 * can show there, capped at 0.85 so a pastel cover stays pastel: a dark or
 * dusty cover still gives an accent. A hue in the olive band (50 to 115
 * degrees) is lit at 0.76 or more, where it reads as amber or gold. `secondary`
 * is the next peak at least 50 degrees away, lit for the light role (L 0.85); a
 * cover of one hue gets the analogous turn instead.
 */
export function analyzePixels(data: Uint8ClampedArray, size: number): ArtPalette | null {
  const bins = new Float64Array(HUE_BINS);
  const binOf = new Int32Array(size * size).fill(-1);
  const weightOf = new Float32Array(size * size);
  const lab = new Float32Array(size * size * 3);
  let counted = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      counted++;
      if (data[i * 4 + 3]! < 128) continue;
      const o = rgbToOklch([data[i * 4]! / 255, data[i * 4 + 1]! / 255, data[i * 4 + 2]! / 255]);
      const w = clamp01((o.c - 0.03) / 0.12) * smoothstep(0.08, 0.25, o.l) * (1 - smoothstep(0.85, 0.97, o.l));
      if (!(w > 0)) continue;
      const rad = (o.h * Math.PI) / 180;
      const bin = Math.floor(o.h / BIN_DEGREES) % HUE_BINS;
      bins[bin]! += w;
      binOf[i] = bin;
      weightOf[i] = w;
      lab[i * 3] = o.l;
      lab[i * 3 + 1] = o.c * Math.cos(rad);
      lab[i * 3 + 2] = o.c * Math.sin(rad);
    }
  }

  const smooth = new Float64Array(HUE_BINS);
  for (let k = 0; k < HUE_BINS; k++) {
    smooth[k] = bins[k]! * 0.5 + (bins[(k + HUE_BINS - 1) % HUE_BINS]! + bins[(k + 1) % HUE_BINS]!) * 0.25;
  }
  let best = 0;
  for (let k = 1; k < HUE_BINS; k++) if (smooth[k]! > smooth[best]!) best = k;
  // Not enough chroma to say anything (grayscale/near-mono art) → let the
  // theme palette stand untouched.
  if (smooth[best]! < counted * 0.01) return null;

  // Mean of the winning hue's pixels (its bin and the two beside it) in OKLab.
  let sumW = 0;
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < size * size; i++) {
    const bin = binOf[i]!;
    if (bin < 0) continue;
    const away = Math.min((bin - best + HUE_BINS) % HUE_BINS, (best - bin + HUE_BINS) % HUE_BINS);
    if (away > 1) continue;
    const w = weightOf[i]!;
    sumW += w;
    sumL += lab[i * 3]! * w;
    sumA += lab[i * 3 + 1]! * w;
    sumB += lab[i * 3 + 2]! * w;
  }
  const meanHue = ((Math.atan2(sumB, sumA) * 180) / Math.PI + 360) % 360;
  const meanChroma = Math.hypot(sumA, sumB) / sumW;
  let lightness = Math.min(0.78, Math.max(0.62, sumL / sumW));
  if (meanHue > OLIVE_HUES.from && meanHue < OLIVE_HUES.to) lightness = Math.max(lightness, OLIVE_LIGHTNESS);
  const reach = maxChroma(lightness, meanHue);
  const vibrant = oklchToRgb(lightness, Math.min(0.85 * reach, Math.max(meanChroma, 0.6 * reach)), meanHue);

  // The second hue: the strongest bin at least four bins (60 degrees) from the
  // winner, counted only from pixels at least 50 degrees from the vibrant hue
  // itself, so the winner's own shoulder cannot pass for a second colour.
  let second = -1;
  for (let k = 0; k < HUE_BINS; k++) {
    const away = Math.min((k - best + HUE_BINS) % HUE_BINS, (best - k + HUE_BINS) % HUE_BINS);
    if (away < 4 || smooth[k]! <= smooth[best]! * 0.2) continue;
    if (second < 0 || smooth[k]! > smooth[second]!) second = k;
  }
  // A one-hued cover gets the analogous turn, away from the olive band: from
  // 40 to 110 degrees +40 lands in khaki, so those turn the other way.
  const turnAway = meanHue >= 40 && meanHue <= 110 ? -40 : 40;
  let secondaryHue = (meanHue + turnAway + 360) % 360;
  if (second >= 0) {
    let w2 = 0;
    let a2 = 0;
    let b2 = 0;
    for (let i = 0; i < size * size; i++) {
      const bin = binOf[i]!;
      if (bin < 0) continue;
      const away = Math.min((bin - second + HUE_BINS) % HUE_BINS, (second - bin + HUE_BINS) % HUE_BINS);
      if (away > 1) continue;
      const a = lab[i * 3 + 1]!;
      const b = lab[i * 3 + 2]!;
      if (hueGap((Math.atan2(b, a) * 180) / Math.PI + 360, meanHue) < 50) continue;
      w2 += weightOf[i]!;
      a2 += a * weightOf[i]!;
      b2 += b * weightOf[i]!;
    }
    if (w2 > 0) secondaryHue = ((Math.atan2(b2, a2) * 180) / Math.PI + 360) % 360;
  }
  const secondary = oklchToRgb(0.85, 0.5 * maxChroma(0.85, secondaryHue), secondaryHue);

  return { vibrant, secondary, muted: shadowTone(vibrant) };
}

function analyze(img: HTMLImageElement): ArtPalette | null | typeof UNREADABLE {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return UNREADABLE;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return UNREADABLE; // tainted canvas / decode failure
  }
  return analyzePixels(data, SAMPLE_SIZE);
}

/**
 * The shadow tone for a cover: its vibrant hue at a fixed dark, quiet OKLCh.
 * The mean of the whole image washes out to a grey-brown on most covers.
 */
export function shadowTone(vibrant: readonly [number, number, number]): [number, number, number] {
  return oklchToRgb(MUTED_LIGHTNESS, MUTED_CHROMA, rgbToOklch(vibrant).h);
}

/**
 * Dominant-color extraction for an album-art URL. Cached, deduped, and
 * best-effort — resolves null on any failure so callers can just fall back.
 * A cover that was read stays cached (a grey one as null); one that failed to
 * load or could not be read is forgotten after 30 s, so a slow share that
 * times out once does not leave the track without its colours for the session.
 */
export function extractArtPalette(url: string): Promise<ArtPalette | null> {
  if (!url) return Promise.resolve(null);
  const now = Date.now();
  const hit = cache.get(url);
  if (hit) {
    if (hit.until > now) {
      // Re-insert so the eviction below drops the least recently used.
      cache.delete(url);
      cache.set(url, hit);
      return Promise.resolve(hit.palette);
    }
    cache.delete(url);
  }
  const pending = inflight.get(url);
  if (pending) return pending;
  const p = loadImage(url, 4000)
    .then((img): ArtPalette | null | typeof UNREADABLE => (img ? analyze(img) : UNREADABLE))
    .catch((): typeof UNREADABLE => UNREADABLE)
    .then((outcome): ArtPalette | null => {
      inflight.delete(url);
      const failed = outcome === UNREADABLE;
      const palette = failed ? null : outcome;
      if (cache.size >= CACHE_CAP) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(url, { palette, until: failed ? Date.now() + FAILURE_RETRY_MS : Infinity });
      return palette;
    });
  inflight.set(url, p);
  return p;
}

/** How many more times a cover that would not read is asked for while its track plays. */
const WATCH_RETRIES = 2;

/**
 * Hands `take` the cover's colours once they are known. A cover that failed to
 * read is asked for again after its failure has expired (a slow share that
 * timed out at the start of a track may have caught up), as long as `current`
 * still says the track is the one playing, so the track gets its colours later
 * and not only the next time it is played. A grey cover has no palette and is
 * a cache hit each time, so asking again costs nothing.
 */
export function watchArtPalette(
  url: string,
  current: () => boolean,
  take: (palette: ArtPalette) => void,
  extract: (url: string) => Promise<ArtPalette | null> = extractArtPalette,
): void {
  if (!url) return;
  const ask = (retriesLeft: number): void => {
    void extract(url).then((art) => {
      if (!current()) return;
      if (art) take(art);
      else if (retriesLeft > 0) setTimeout(() => { if (current()) ask(retriesLeft - 1); }, FAILURE_RETRY_MS + 1000);
    });
  };
  ask(WATCH_RETRIES);
}

/**
 * Blend album-art colors into a theme EvilandPalette. The background stays
 * pure theme (legibility contract); accent leans hardest into the art, the
 * light tone least — bright layers must stay bright regardless of the sleeve.
 */
export function blendPaletteWithArt(
  theme: EvilandPalette,
  art: ArtPalette | null,
  mix = 1,
): EvilandPalette {
  return blendThemeWithSleeve(theme, art, mix);
}
