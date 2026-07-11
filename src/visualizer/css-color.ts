export type RgbVec = [number, number, number];

let colorProbe: CanvasRenderingContext2D | null | undefined;

export function parseCssRgbVec(color: string, fallback: RgbVec = [0.22, 1, 0.08]): RgbVec {
  const direct = parseNormalizedColor(color);
  if (direct) return direct;

  if (typeof document !== 'undefined') {
    colorProbe ??= document.createElement('canvas').getContext('2d');
    if (colorProbe) {
      colorProbe.fillStyle = '#010203';
      colorProbe.fillStyle = color;
      const resolved = String(colorProbe.fillStyle);
      if (resolved === '#010203' && color.trim().toLowerCase() !== '#010203') {
        return [fallback[0], fallback[1], fallback[2]];
      }
      const normalized = parseNormalizedColor(resolved);
      if (normalized) return normalized;
    }
  }

  return [fallback[0], fallback[1], fallback[2]];
}

function parseNormalizedColor(value: string): RgbVec | null {
  const color = value.trim().toLowerCase();
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4
      ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
      : hex.slice(0, 6);
    return [
      Number.parseInt(expanded.slice(0, 2), 16) / 255,
      Number.parseInt(expanded.slice(2, 4), 16) / 255,
      Number.parseInt(expanded.slice(4, 6), 16) / 255,
    ];
  }

  if (!color.startsWith('rgb(') && !color.startsWith('rgba(')) return null;
  const body = color.slice(color.indexOf('(') + 1, color.lastIndexOf(')')).split('/')[0] ?? '';
  const channels = body.trim().split(/[\s,]+/).filter(Boolean);
  if (channels.length < 3) return null;
  const parsed = channels.slice(0, 3).map(parseChannel);
  if (parsed.some((channel) => channel === null)) return null;
  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

function parseChannel(value: string): number | null {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  const normalized = value.endsWith('%') ? numeric / 100 : numeric / 255;
  return Math.max(0, Math.min(1, normalized));
}
