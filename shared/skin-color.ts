import { COLOR_SKIN_VARIABLES, contrastRatio, deriveOnAccent, parseSkinColorRgb } from './custom-skin.js';

// Colour maths for the skin editors: reading a skin value into channels and
// alpha, writing one back, re-tinting a whole skin, and the contrast pairs the
// editor reports. Nothing here touches the DOM; a colour name (red, teal) is
// only readable through the `resolveNamed` hook the renderer supplies.

export interface SkinColor {
  hex: string;
  alpha: number;
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Turns a colour name into the `rgb()` / `rgba()` text a browser computes for it, or null. */
export type NamedColorResolver = (name: string) => string | null;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const byte = (value: number): number => clamp(Math.round(value), 0, 255);
const toHexPair = (value: number): string => byte(value).toString(16).padStart(2, '0');
const HEX6_RE = /^#[0-9a-f]{6}$/i;

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexPair(r)}${toHexPair(g)}${toHexPair(b)}`;
}

function parseAlphaToken(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const percent = token.endsWith('%');
  const amount = Number.parseFloat(percent ? token.slice(0, -1) : token);
  if (!Number.isFinite(amount)) return null;
  return clamp(percent ? amount / 100 : amount, 0, 1);
}

function readDirect(text: string): RgbaColor | null {
  const channels = parseSkinColorRgb(text);
  if (!channels) return null;
  let alpha: number | null = 1;
  if (text.startsWith('#')) {
    const digits = text.slice(1);
    if (digits.length === 4) alpha = parseInt(digits[3]! + digits[3]!, 16) / 255;
    else if (digits.length === 8) alpha = parseInt(digits.slice(6, 8), 16) / 255;
  } else {
    const inner = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
    alpha = parseAlphaToken(inner.replace(/\s*[,/]\s*/g, ' ').trim().split(/\s+/)[3]);
  }
  if (alpha === null) return null;
  return { r: byte(channels[0]), g: byte(channels[1]), b: byte(channels[2]), a: Math.round(alpha * 1000) / 1000 };
}

/** Any colour the skin grammar accepts, as 0-255 channels and alpha (0-1). Null when unreadable. */
export function parseSkinColorRgba(value: string, resolveNamed?: NamedColorResolver): RgbaColor | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const direct = readDirect(text);
  if (direct) return direct;
  if (!resolveNamed || !/^[a-z]+$/.test(text)) return null;
  const resolved = resolveNamed(text)?.trim().toLowerCase();
  return resolved ? readDirect(resolved) : null;
}

/** A colour as the hex a colour picker needs, plus the alpha a pick should keep. */
export function parseSkinColor(value: string, resolveNamed?: NamedColorResolver): SkinColor | null {
  const color = parseSkinColorRgba(value, resolveNamed);
  return color ? { hex: rgbToHex(color.r, color.g, color.b), alpha: color.a } : null;
}

/** The skin value for a picked hex and alpha: the bare hex when opaque, else `rgba()`. */
export function pickedSkinColor(hex: string, alpha: number): string {
  const opacity = clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1);
  if (opacity >= 1 || !HEX6_RE.test(hex)) return hex;
  const channel = (at: number): number => parseInt(hex.slice(at, at + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${Number(opacity.toFixed(2))})`;
}

/** Surfaces a skin is meant to paint solid; a translucent one shows the window behind it. */
const SOLID_SKIN_VARIABLES: readonly string[] = ['--bg', '--panel', '--panel-2', '--panel-3', '--display-bg'];

/** Whether the editor offers an alpha slider for this variable. A value that already carries alpha always gets one. */
export function skinVariableTakesAlpha(key: string, value: string, resolveNamed?: NamedColorResolver): boolean {
  if (!(COLOR_SKIN_VARIABLES as readonly string[]).includes(key)) return false;
  if (!SOLID_SKIN_VARIABLES.includes(key)) return true;
  const color = parseSkinColorRgba(value, resolveNamed);
  return !!color && color.a < 1;
}

// ── contrast ───────────────────────────────────────────────────────────────

/** Contrast of two skin colours, or null when either is translucent (what it sits on decides) or unreadable. */
export function contrastBetween(foreground: string, background: string, resolveNamed?: NamedColorResolver): number | null {
  const first = parseSkinColorRgba(foreground, resolveNamed);
  const second = parseSkinColorRgba(background, resolveNamed);
  if (!first || !second || first.a < 1 || second.a < 1) return null;
  return contrastRatio([first.r, first.g, first.b], [second.r, second.g, second.b]);
}

/** "4.49:1" — cut, not rounded, so a pair just under its threshold never reads as passing. */
export function formatContrastRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

export interface ContrastPair {
  id: string;
  label: string;
  foreground: string;
  background: string;
  /** Text pairs need 4.5:1, the accent against a panel 3:1 (it is a graphic more than a word). */
  min: number;
}

export const SKIN_CONTRAST_PAIRS: readonly ContrastPair[] = [
  { id: 'ink-panel', label: 'Text on panels', foreground: '--ink', background: '--panel', min: 4.5 },
  { id: 'ink2-panel', label: 'Secondary text on panels', foreground: '--ink-2', background: '--panel', min: 4.5 },
  { id: 'muted-panel', label: 'Muted text on panels', foreground: '--muted', background: '--panel', min: 4.5 },
  { id: 'ink-bg', label: 'Text on background', foreground: '--ink', background: '--bg', min: 4.5 },
  { id: 'lcd', label: 'LCD text on LCD', foreground: '--display-fg', background: '--display-bg', min: 4.5 },
  { id: 'accent-panel', label: 'Accent on panels', foreground: '--accent', background: '--panel', min: 3 },
  { id: 'on-accent', label: 'Text on accent', foreground: '--on-accent', background: '--accent', min: 4.5 },
];

export interface ContrastReading {
  pair: ContrastPair;
  /** Null when a side is missing, translucent or not a colour the editor can read. */
  ratio: number | null;
  /** Null exactly when `ratio` is. */
  pass: boolean | null;
}

export function skinContrastReadings(values: Record<string, string>, resolveNamed?: NamedColorResolver): ContrastReading[] {
  return SKIN_CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastBetween(values[pair.foreground] ?? '', values[pair.background] ?? '', resolveNamed);
    return { pair, ratio, pass: ratio === null ? null : ratio + 1e-9 >= pair.min };
  });
}

// ── hue / saturation / brightness ──────────────────────────────────────────

export interface Hsl {
  /** Degrees, 0-360. */
  h: number;
  /** 0-1. */
  s: number;
  /** 0-1. */
  l: number;
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === red) h = ((green - blue) / delta) % 6;
  else if (max === green) h = (blue - red) / delta + 2;
  else h = (red - green) / delta + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const spread = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return (l - spread * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [byte(channel(0)), byte(channel(8)), byte(channel(4))];
}

export interface SkinTint {
  /** Degrees added to every hue. */
  hue: number;
  /** Multiplies saturation. */
  sat: number;
  /** Below 1 darkens in proportion; above 1 moves each colour that share of the way to white. */
  light: number;
}

export const NEUTRAL_TINT: SkinTint = { hue: 0, sat: 1, light: 1 };

export function isNeutralTint(tint: SkinTint): boolean {
  return tint.hue === 0 && tint.sat === 1 && tint.light === 1;
}

/** Warning and error colours keep their meaning whatever the skin's hue. */
export const TINT_KEEP_DEFAULT: readonly string[] = ['--warn', '--error'];

function tintLightness(l: number, light: number): number {
  return clamp(light <= 1 ? l * light : l + (1 - l) * (light - 1), 0, 1);
}

/**
 * The colour variables of `baseline` re-tinted, as skin values the grammar
 * accepts (hex, or `rgba()` where there is alpha). Always computed from the
 * baseline, never from a previous result, so dragging a slider back and forth
 * does not wear the colours down. Variables that are not readable colours,
 * and the ones in `keep`, are left out of the result. The label colour
 * follows the new accent when it was the automatic black or white before.
 * A neutral tint returns the baseline values unchanged.
 */
export function transformSkin(
  baseline: Record<string, string>,
  tint: SkinTint,
  options: { keep?: readonly string[]; resolveNamed?: NamedColorResolver } = {},
): Record<string, string> {
  const keep = options.keep ?? TINT_KEEP_DEFAULT;
  const neutral = isNeutralTint(tint);
  const out: Record<string, string> = {};
  for (const key of COLOR_SKIN_VARIABLES) {
    if (key === '--on-accent' || keep.includes(key)) continue;
    const value = baseline[key];
    const color = value ? parseSkinColorRgba(value, options.resolveNamed) : null;
    if (!value || !color) continue;
    if (neutral) {
      out[key] = value;
      continue;
    }
    const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
    const [r, g, b] = hslToRgb({ h: (((h + tint.hue) % 360) + 360) % 360, s: clamp(s * tint.sat, 0, 1), l: tintLightness(l, tint.light) });
    out[key] = pickedSkinColor(rgbToHex(r, g, b), color.a);
  }

  const label = baseline['--on-accent'];
  const accent = baseline['--accent'];
  if (label && accent && out['--accent']) {
    if (neutral) {
      out['--on-accent'] = label;
    } else {
      const next = followAccentLabel(label, accent, out['--accent'], options.resolveNamed);
      if (next) out['--on-accent'] = next;
    }
  }
  return out;
}

/** The black or white that reads best on `accent`, from any colour the skin grammar accepts (a name needs the resolver). */
export function autoLabelFor(accent: string, resolveNamed?: NamedColorResolver): string | null {
  const color = parseSkinColorRgba(accent, resolveNamed);
  return color ? deriveOnAccent(rgbToHex(color.r, color.g, color.b)) : null;
}

function sameColour(a: string, b: string, resolveNamed?: NamedColorResolver): boolean {
  const first = parseSkinColorRgba(a, resolveNamed);
  const second = parseSkinColorRgba(b, resolveNamed);
  return !!first && !!second && first.r === second.r && first.g === second.g && first.b === second.b;
}

/**
 * The label colour to use once the accent moves from `previousAccent` to
 * `nextAccent`, or null to leave the label as it is. It follows only when it
 * was the automatic black or white for the accent it is leaving; a label
 * somebody picked stays theirs.
 */
export function followAccentLabel(
  label: string | undefined,
  previousAccent: string | undefined,
  nextAccent: string,
  resolveNamed?: NamedColorResolver,
): string | null {
  if (!label || !previousAccent) return null;
  const was = autoLabelFor(previousAccent, resolveNamed);
  if (!was || !sameColour(was, label, resolveNamed)) return null;
  return autoLabelFor(nextAccent, resolveNamed);
}
