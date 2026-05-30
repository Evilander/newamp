// Dominant-accent extraction from album art for live per-track theming.
// Downscales art to a tiny canvas and quantizes a 12-bit color histogram —
// sub-millisecond, meant to run on requestIdleCallback once per track.
// No dependencies: deliberately plain.

export interface AccentPalette {
  accent: string; // vibrant accent, hsl()
  bg1: string; // dark wash tone
  bg2: string; // darker wash tone
  ink: string; // readable text color on the accent
}

const cache = new Map<string, AccentPalette | null>();
const MAX_CACHE = 200;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function quantize(data: Uint8ClampedArray): AccentPalette | null {
  // 4 bits per channel → up to 4096 buckets; a downscaled cover fills few.
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue; // skip transparent
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { r: 0, g: 0, b: 0, n: 0 };
      buckets.set(key, bucket);
    }
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
  }
  if (buckets.size === 0) return null;

  let best: { h: number; s: number; l: number; score: number } | null = null;
  let popular: { h: number; s: number; l: number; n: number } | null = null;
  for (const bucket of buckets.values()) {
    const r = bucket.r / bucket.n;
    const g = bucket.g / bucket.n;
    const b = bucket.b / bucket.n;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (!popular || bucket.n > popular.n) popular = { h, s, l, n: bucket.n };
    // Favor saturated, mid-lightness, well-populated colors for a usable accent.
    const lWeight = Math.max(0, 1 - Math.abs(l - 0.55) * 1.4);
    const score = bucket.n * s * lWeight;
    if (!best || score > best.score) best = { h, s, l, score };
  }

  const pick = best && best.score > 0 ? best : popular;
  if (!pick) return null;

  const accentS = Math.max(0.45, Math.min(0.9, pick.s));
  const accentL = Math.max(0.45, Math.min(0.62, pick.l || 0.5));
  return {
    accent: hsl(pick.h, accentS, accentL),
    ink: accentL > 0.55 ? 'hsl(0 0% 8%)' : 'hsl(0 0% 96%)',
    bg1: hsl(pick.h, Math.min(0.5, accentS), 0.12),
    bg2: hsl(pick.h, Math.min(0.4, accentS), 0.06),
  };
}

function sample(url: string): Promise<AccentPalette | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        resolve(quantize(ctx.getImageData(0, 0, size, size).data));
      } catch {
        resolve(null); // tainted canvas / decode failure
      }
    };
    img.src = url;
  });
}

export async function extractAccent(url: string): Promise<AccentPalette | null> {
  if (cache.has(url)) return cache.get(url) ?? null;
  let result: AccentPalette | null = null;
  try {
    result = await sample(url);
  } catch {
    result = null;
  }
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, result);
  return result;
}
