// Spectral Cover Art — deterministic procedural SVG for albums that have no
// embedded or sidecar art. Same artist+album always produces the same image,
// so the user's collection feels consistent across launches without us baking
// any extra files to disk.
//
// The look is a soft three-stop OKLCH-ish gradient over a vertical "bands"
// spectrogram-style figure, with the artist + album name set across the
// lower band in small caps. Deterministic via FNV-1a 32-bit hash + LCG, so
// the artwork is stable but doesn't repeat across libraries.

export interface SpectralArtSeed {
  artist: string;
  album: string;
}

export interface SpectralArtPalette {
  bg1: string;
  bg2: string;
  accent: string;
  ink: string;
}

export function spectralArtSvg(seed: SpectralArtSeed, size = 256): string {
  const labelArtist = (seed.artist || '').trim() || 'Unknown';
  const labelAlbum = (seed.album || '').trim() || 'Untitled';
  const hash = fnv1a(`${labelArtist}::${labelAlbum}`);
  const palette = palettefor(hash);
  const bars = barHeights(hash, 14);
  const gradientId = `g${(hash & 0xfffff).toString(36)}`;

  const barWidth = (size * 0.78) / bars.length;
  const barInset = size * 0.11;
  const barTop = size * 0.18;
  const barBottom = size * 0.66;
  const barAreaHeight = barBottom - barTop;

  const barPaths = bars.map((h, i) => {
    const x = barInset + i * barWidth + barWidth * 0.18;
    const w = barWidth * 0.64;
    const barHeight = Math.max(barAreaHeight * 0.18, barAreaHeight * h);
    const y = barBottom - barHeight;
    return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(barHeight)}" rx="${num(w * 0.32)}" />`;
  }).join('');

  const subPaths = bars.slice(0, 5).map((_, i) => {
    const angle = (i / 5) * Math.PI * 2 + (hash & 31) * 0.04;
    const cx = size / 2 + Math.cos(angle) * size * 0.08;
    const cy = size * 0.32 + Math.sin(angle) * size * 0.04;
    const r = size * (0.04 + ((hash >> (i * 3)) & 7) / 64);
    return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" />`;
  }).join('');

  const artistLabel = clipLabel(labelArtist, 28).toUpperCase();
  const albumLabel = clipLabel(labelAlbum, 30).toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeAttr(labelAlbum)} by ${escapeAttr(labelArtist)}">
  <defs>
    <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.bg1}" />
      <stop offset="55%" stop-color="${palette.bg2}" />
      <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0.4" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#${gradientId})" />
  <g fill="${palette.accent}" fill-opacity="0.18">${subPaths}</g>
  <g fill="${palette.accent}" fill-opacity="0.78">${barPaths}</g>
  <g fill="${palette.ink}" font-family="ui-monospace, 'Cascadia Mono', 'Consolas', monospace" font-weight="700">
    <text x="${num(size / 2)}" y="${num(size * 0.82)}" font-size="${num(size * 0.058)}" letter-spacing="${num(size * 0.012)}" text-anchor="middle" opacity="0.88">${escapeText(artistLabel)}</text>
    <text x="${num(size / 2)}" y="${num(size * 0.9)}" font-size="${num(size * 0.046)}" letter-spacing="${num(size * 0.008)}" text-anchor="middle" opacity="0.62">${escapeText(albumLabel)}</text>
  </g>
</svg>`;
}

export function spectralArtDataUrl(seed: SpectralArtSeed, size = 256): string {
  const svg = spectralArtSvg(seed, size);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function spectralArtPalette(seed: SpectralArtSeed): SpectralArtPalette {
  const hash = fnv1a(`${(seed.artist || '').trim()}::${(seed.album || '').trim()}`);
  return palettefor(hash);
}

function palettefor(hash: number): SpectralArtPalette {
  const hueA = hash % 360;
  const hueB = (hueA + 35 + ((hash >> 8) & 0x3f)) % 360;
  const hueAccent = (hueA + 180 + ((hash >> 12) & 0x1f) - 16) % 360;
  return {
    bg1: `hsl(${hueA}, 70%, 18%)`,
    bg2: `hsl(${hueB}, 60%, 28%)`,
    accent: `hsl(${hueAccent}, 85%, 62%)`,
    ink: `hsl(${(hueA + 12) % 360}, 30%, 92%)`,
  };
}

function barHeights(hash: number, count: number): number[] {
  let state = (hash + 0x1234567) >>> 0;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    state = Math.imul(state, 1664525) + 1013904223;
    state >>>= 0;
    const v = (state & 0xffffff) / 0xffffff;
    out[i] = 0.28 + v * 0.7;
  }
  return out;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clipLabel(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1).trim()}…`;
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

function num(value: number): string {
  return Number(value.toFixed(3)).toString();
}
