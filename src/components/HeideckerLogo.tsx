// Themed New Heidecker badge. The source PNG is a red brushed-metal medallion
// with Heidecker's portrait + a "NewAmp" wordmark. We re-tint the badge to
// match the active skin by walking the PNG's pixels on a hidden canvas and
// recoloring red-dominant pixels (the rim + wordmark) with the active accent.
// What we preserve untouched:
//   - Heidecker's face (skin tones are NOT red-dominant by ratio)
//   - black backgrounds (red channel below the brightness floor)
//   - metallic highlights and shadows (we multiply the accent by the source
//     pixel's red-channel luminance so the badge keeps its 3D feel)
//
// Result data URLs are cached per accent so we never re-process on re-render.
// A MutationObserver on the document root catches data-theme / data-shell /
// inline-style updates from the skin picker and triggers a re-tint.

import { useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../../build/logo.png';

type Rgb = { r: number; g: number; b: number };

const TINT_CACHE = new Map<string, string>();
let cachedSourceImage: HTMLImageElement | null = null;
let cachedSourcePromise: Promise<HTMLImageElement> | null = null;

function loadSourceImage(): Promise<HTMLImageElement> {
  if (cachedSourceImage) return Promise.resolve(cachedSourceImage);
  if (cachedSourcePromise) return cachedSourcePromise;
  cachedSourcePromise = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      cachedSourceImage = img;
      resolve(img);
    };
    img.onerror = (err) => reject(err);
    img.src = logoUrl;
  });
  return cachedSourcePromise;
}

function parseAccent(raw: string): Rgb | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex) {
    const value = hex[1]!;
    if (value.length === 3) {
      return {
        r: parseInt(value[0]! + value[0]!, 16),
        g: parseInt(value[1]! + value[1]!, 16),
        b: parseInt(value[2]! + value[2]!, 16),
      };
    }
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(trimmed);
  if (rgb) {
    const parts = rgb[1]!.split(',').map((p) => Number.parseFloat(p));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { r: parts[0]!, g: parts[1]!, b: parts[2]! };
    }
  }
  // Last resort: ask the browser to resolve named/keyword colors.
  if (typeof document !== 'undefined') {
    const probe = document.createElement('span');
    probe.style.color = trimmed;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    if (computed && computed !== trimmed) return parseAccent(computed);
  }
  return null;
}

function readActiveAccent(): Rgb {
  if (typeof document === 'undefined') return { r: 255, g: 16, b: 16 };
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  return parseAccent(raw) ?? { r: 255, g: 16, b: 16 };
}

function tintImage(source: HTMLImageElement, accent: Rgb): string {
  const cacheKey = `${accent.r}|${accent.g}|${accent.b}`;
  const hit = TINT_CACHE.get(cacheKey);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return logoUrl;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const accentMaxChannel = Math.max(accent.r, accent.g, accent.b, 1) / 255;
  // Walk pixels; red-dominant rim + wordmark get re-tinted, the rest stays put.
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    if (a === 0) continue;
    if (r > 70 && r > g * 1.55 && r > b * 1.55) {
      const lum = (r / 255) / Math.max(0.6, accentMaxChannel);
      data[i] = Math.min(255, accent.r * lum);
      data[i + 1] = Math.min(255, accent.g * lum);
      data[i + 2] = Math.min(255, accent.b * lum);
    }
  }
  ctx.putImageData(imageData, 0, 0);
  const url = canvas.toDataURL('image/png');
  TINT_CACHE.set(cacheKey, url);
  return url;
}

interface HeideckerLogoProps {
  size?: number;
  title?: string;
  withGlow?: boolean;
}

export function HeideckerLogo({
  size = 22,
  title = 'NewAmp',
  withGlow = true,
}: HeideckerLogoProps): JSX.Element {
  const [accent, setAccent] = useState<Rgb>(() => readActiveAccent());
  const [tintedSrc, setTintedSrc] = useState<string>(() => logoUrl);
  const accentKey = `${accent.r}|${accent.g}|${accent.b}`;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const refresh = (): void => {
      const next = readActiveAccent();
      setAccent((prev) =>
        prev.r === next.r && prev.g === next.g && prev.b === next.b ? prev : next,
      );
    };
    const observer = new MutationObserver(refresh);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'data-shell'],
    });
    // Custom skins may set CSS variables after mount; double-check on next frame.
    const handle = requestAnimationFrame(refresh);
    return () => {
      mountedRef.current = false;
      observer.disconnect();
      cancelAnimationFrame(handle);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined') return;
    loadSourceImage()
      .then((img) => {
        if (cancelled || !mountedRef.current) return;
        try {
          const url = tintImage(img, accent);
          setTintedSrc(url);
        } catch (err) {
          console.warn('Heidecker tint failed; using source logo.', err);
          setTintedSrc(logoUrl);
        }
      })
      .catch(() => {
        if (!cancelled) setTintedSrc(logoUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [accentKey]);

  const filter = withGlow ? 'drop-shadow(0 0 6px var(--accent-glow))' : undefined;

  return useMemo(
    () => (
      <img
        src={tintedSrc}
        alt={title}
        width={size}
        height={size}
        draggable={false}
        className="newamp-logo"
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          filter,
        }}
        data-newamp-logo-accent={accentKey}
      />
    ),
    [tintedSrc, title, size, filter, accentKey],
  );
}
