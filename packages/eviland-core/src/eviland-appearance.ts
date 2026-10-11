import type { EvilandFrame } from './eviland-audio';
import type { OperatorConfig, PaletteConfig, RGB } from './eviland-operators';
import { hashSeed } from './eviland-rng';

export type EvilandPaletteMode = 'look' | 'theme' | 'phosphor' | 'ice' | 'sunset' | 'rainbow';
export type EvilandReactivity = 'truth' | 'punch' | 'wild';

// Palettes made here are cached by the colours they were made from, never by
// the identity of the object that carried them: the Director lerps a look's
// palette in place every frame, so one object holds different colours from
// frame to frame. A key is the role colours (bg, dark, accent, light) as twelve
// numbers, then whatever else the result depends on.
const PALETTE_ROLES = ['bg', 'dark', 'accent', 'light'] as const;

function holdsPalette(key: Float64Array, palette: PaletteConfig): boolean {
  for (let r = 0; r < 4; r++) {
    const c = palette[PALETTE_ROLES[r]!];
    const o = r * 3;
    if (key[o] !== c[0] || key[o + 1] !== c[1] || key[o + 2] !== c[2]) return false;
  }
  return true;
}

function keepPalette(key: Float64Array, palette: PaletteConfig): void {
  for (let r = 0; r < 4; r++) {
    const c = palette[PALETTE_ROLES[r]!];
    key[r * 3] = c[0];
    key[r * 3 + 1] = c[1];
    key[r * 3 + 2] = c[2];
  }
}

function holdsColour(key: Float64Array, at: number, c: RGB): boolean {
  return key[at] === c[0] && key[at + 1] === c[1] && key[at + 2] === c[2];
}

function keepColour(key: Float64Array, at: number, c: RGB): void {
  key[at] = c[0];
  key[at + 1] = c[1];
  key[at + 2] = c[2];
}

// The last key-shifted theme palette. The shift only moves for a couple of
// seconds after a modulation; the rest of the time this is a cache hit and
// resolving the palette allocates nothing. Key: palette, then the shift.
const shiftedKey = new Float64Array(13);
let shifted: PaletteConfig | null = null;

/** Rotate a colour's hue about the grey axis by `turns` (1 = full circle); brightness is kept. */
function rotateHue(rgb: RGB, turns: number): RGB {
  const angle = turns * Math.PI * 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle) / Math.sqrt(3);
  const k = (1 - c) / 3;
  const [r, g, b] = rgb;
  return [
    Math.max(0, r * (c + k) + g * (k - s) + b * (k + s)),
    Math.max(0, r * (k + s) + g * (c + k) + b * (k - s)),
    Math.max(0, r * (k - s) + g * (k + s) + b * (c + k)),
  ];
}

// ── OKLCh ─────────────────────────────────────────────────────────────────
// Palettes are built and turned in OKLCh, where lightness and chroma are
// separate from hue, so a hue change never changes how bright a colour is.
// HSV does not have that property: at full value, blue is about half as light
// as yellow. Colours here are sRGB, 0..1.

/** Lightness 0..1, chroma 0..~0.4, hue in degrees [0, 360). */
export interface Oklch { l: number; c: number; h: number }

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const fromLinear = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function rgbToOklch(rgb: readonly [number, number, number]): Oklch {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c,
    h: c < 1e-5 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  };
}

function oklchToLinear(l: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l3 = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m3 = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s3 = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function fitsSrgb(l: number, c: number, h: number): boolean {
  const lin = oklchToLinear(l, c, h);
  return lin[0] >= -1e-4 && lin[0] <= 1.0001 && lin[1] >= -1e-4 && lin[1] <= 1.0001 && lin[2] >= -1e-4 && lin[2] <= 1.0001;
}

/** The most chroma sRGB can show at this lightness and hue. */
export function maxChroma(l: number, h: number): number {
  if (l <= 0 || l >= 1) return 0;
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (fitsSrgb(l, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** OKLCh → sRGB. A colour outside sRGB loses chroma until it fits; its lightness and hue stay. */
export function oklchToRgb(l: number, c: number, h: number): RGB {
  const hue = ((h % 360) + 360) % 360;
  const lin = oklchToLinear(l, Math.min(Math.max(c, 0), maxChroma(l, hue)), hue);
  return [fromLinear(clamp01(lin[0])), fromLinear(clamp01(lin[1])), fromLinear(clamp01(lin[2]))];
}

// OKLCh hues between these read as olive or brown at the dark role's lightness.
const MUD_HUES = { from: 50, to: 115 };

/** Move a hue out of the olive/brown band: the nearer half goes to red, the other to green. */
export function leaveMud(h: number): number {
  if (h <= MUD_HUES.from || h >= MUD_HUES.to) return h;
  const half = (MUD_HUES.from + MUD_HUES.to) / 2;
  const reach = half - MUD_HUES.from;
  return h < half ? 20 + ((h - MUD_HUES.from) / reach) * 15 : 150 - ((MUD_HUES.to - h) / reach) * 15;
}

/**
 * A palette turned so its accent sits on `hue`; every colour keeps its
 * lightness and chroma. The dark role steps round the olive/brown band, as it
 * does when a look is first made.
 */
export function turnPaletteToHue(palette: PaletteConfig, hue: number): PaletteConfig {
  const delta = hue - rgbToOklch(palette.accent).h;
  const turn = (rgb: RGB, keep: (h: number) => number = (h) => h): RGB => {
    const o = rgbToOklch(rgb);
    return oklchToRgb(o.l, o.c, keep((((o.h + delta) % 360) + 360) % 360));
  };
  return { bg: turn(palette.bg), dark: turn(palette.dark, leaveMud), accent: turn(palette.accent), light: turn(palette.light) };
}

/** The colours Eviland takes from an album sleeve (see art-palette.ts). */
export interface SleeveColours {
  vibrant: RGB;
  secondary: RGB;
  muted: RGB;
}

/** A sleeve and the seed that decides, per look, whether the look follows it. */
export interface Sleeve {
  art: SleeveColours | null;
  seed: string;
  /**
   * Mid-fade: the look being faded to, and how far along the fade is (0..1).
   * `seed` is then the look being faded from. Whether a look follows the
   * sleeve is a yes or no per look, so a fade between one that does and one
   * that doesn't moves the palette across, instead of flipping it halfway.
   */
  fade?: { seed: string; t: number } | null;
}

/** Fill `into` for the look `config` describes: its own seed and, during a Director fade, the look it is fading to. */
export function sleeveFor(config: OperatorConfig, art: SleeveColours | null, into: Sleeve): Sleeve {
  into.art = art;
  const from = config._from;
  const to = config._to;
  if (from && to && typeof config._transition === 'number' && config._transition < 1) {
    into.seed = from.seed ?? '';
    const fade = into.fade ?? (into.fade = { seed: '', t: 0 });
    fade.seed = to.seed ?? '';
    fade.t = config._transition;
  } else {
    into.seed = config.seed ?? '';
    into.fade = null;
  }
  return into;
}

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Blend sleeve colours into a theme palette. The background stays the theme's
 * (legibility contract); the accent leans hardest into the art, the light
 * tone least, so bright layers stay bright whatever the sleeve.
 */
export function blendThemeWithSleeve(theme: PaletteConfig, art: SleeveColours | null, mix = 0.6): PaletteConfig {
  if (!art) return theme;
  return {
    accent: mixRgb(theme.accent, art.vibrant, mix),
    dark: mixRgb(theme.dark, art.muted, mix),
    light: mixRgb(theme.light, art.secondary, mix * 0.7),
    bg: theme.bg,
  };
}

// Half of the looks follow the sleeve's hue; which half is decided by the seed.
const followsSleeve = new Map<string, boolean>();
// Key: look palette, then the cover's vibrant colour (the only part that turns it).
const turnedKey = new Float64Array(15);
let turned: PaletteConfig | null = null;
// Key: theme palette, then the cover's vibrant, secondary and muted colours.
const blendedKey = new Float64Array(21);
let blended: PaletteConfig | null = null;

function looksFollowSleeve(seed: string): boolean {
  let follows = followsSleeve.get(seed);
  if (follows === undefined) {
    follows = hashSeed(`${seed}::sleeve`) % 2 === 0;
    if (followsSleeve.size >= 64) followsSleeve.clear();
    followsSleeve.set(seed, follows);
  }
  return follows;
}

function lookForSleeve(look: PaletteConfig, sleeve: Sleeve): PaletteConfig {
  const art = sleeve.art;
  if (!art) return look;
  const from = looksFollowSleeve(sleeve.seed) ? 1 : 0;
  const fade = sleeve.fade;
  const to = fade ? (looksFollowSleeve(fade.seed) ? 1 : 0) : from;
  const t = fade ? clamp01(fade.t) : 0;
  const weight = from + (to - from) * t;
  if (!(weight > 0)) return look;
  let target: PaletteConfig;
  if (turned && holdsPalette(turnedKey, look) && holdsColour(turnedKey, 12, art.vibrant)) {
    target = turned;
  } else {
    keepPalette(turnedKey, look);
    keepColour(turnedKey, 12, art.vibrant);
    turned = turnPaletteToHue(look, rgbToOklch(art.vibrant).h);
    target = turned;
  }
  if (weight >= 1) return target;
  return {
    bg: mixRgb(look.bg, target.bg, weight),
    dark: mixRgb(look.dark, target.dark, weight),
    accent: mixRgb(look.accent, target.accent, weight),
    light: mixRgb(look.light, target.light, weight),
  };
}

function themeForSleeve(theme: PaletteConfig, sleeve: Sleeve | null | undefined): PaletteConfig {
  const art = sleeve?.art;
  if (!art) return theme;
  if (blended && holdsPalette(blendedKey, theme)
    && holdsColour(blendedKey, 12, art.vibrant) && holdsColour(blendedKey, 15, art.secondary) && holdsColour(blendedKey, 18, art.muted)) return blended;
  keepPalette(blendedKey, theme);
  keepColour(blendedKey, 12, art.vibrant);
  keepColour(blendedKey, 15, art.secondary);
  keepColour(blendedKey, 18, art.muted);
  blended = blendThemeWithSleeve(theme, art);
  return blended;
}

/**
 * Resolve once for the complete image, before any source is drawn.
 *
 * `keyShift` (turns, from the song score) rotates the palette when the music
 * modulates away from its home key. It applies to 'theme' and 'rainbow' only:
 * a palette the user picked by name stays exactly that palette.
 *
 * 'look' paints each look in the palette it was generated with (`look`, the
 * active config's palette), so looks differ in colour as well as in motion;
 * the Director lerps it across a fade. A look without one falls back to the
 * theme.
 *
 * `sleeve` brings the album art in. 'theme' takes the sleeve's colours
 * (every host passes it, so on-screen Eviland, Eviland Live and the projector
 * resolve the same palette). 'look' keeps its own lightness and chroma but, on
 * the half of the looks the sleeve's seed picks, turns its hues so the accent
 * lands on the sleeve's: a red cover gets red looks, the rest stay free.
 *
 * Pass `sleeve` or a theme already blended with the sleeve's colours
 * (blendPaletteWithArt), not both: 'theme' would mix the sleeve in twice.
 */
export function resolveEvilandPalette(
  mode: EvilandPaletteMode,
  theme: PaletteConfig,
  seconds = 0,
  keyShift = 0,
  look?: PaletteConfig | null,
  sleeve?: Sleeve | null,
): PaletteConfig {
  if (mode === 'look') {
    if (!look) return resolveEvilandPalette('theme', theme, seconds, keyShift, null, sleeve);
    return sleeve ? lookForSleeve(look, sleeve) : look;
  }
  if (mode === 'theme') {
    const base = themeForSleeve(theme, sleeve);
    const turns = Math.round(keyShift * 720) / 720;
    if (turns === 0) return base;
    if (shifted && holdsPalette(shiftedKey, base) && shiftedKey[12] === turns) return shifted;
    keepPalette(shiftedKey, base);
    shiftedKey[12] = turns;
    shifted = { bg: base.bg, dark: rotateHue(base.dark, turns), accent: rotateHue(base.accent, turns), light: rotateHue(base.light, turns) };
    return shifted;
  }
  if (mode === 'phosphor') return { bg: [0.002, 0.01, 0.004], dark: [0.02, 0.22, 0.06], accent: [0.2, 1, 0.35], light: [0.62, 1, 0.7] };
  if (mode === 'ice') return { bg: [0.003, 0.008, 0.025], dark: [0.03, 0.15, 0.45], accent: [0.1, 0.68, 1], light: [0.55, 0.95, 1] };
  if (mode === 'sunset') return { bg: [0.018, 0.002, 0.012], dark: [0.45, 0.03, 0.22], accent: [1, 0.12, 0.24], light: [1, 0.68, 0.16] };
  const hue = (offset: number): RGB => [0, 1, 2].map(i =>
    0.12 + 0.88 * Math.max(0, Math.cos((seconds * 0.035 + keyShift + offset - i / 3) * Math.PI * 2)),
  ) as RGB;
  return { bg: [0.006, 0.004, 0.012], dark: hue(0.66).map(c => c * 0.35) as RGB, accent: hue(0), light: hue(0.25) };
}

/**
 * How firmly Eviland Live's final image is pulled onto the resolved palette.
 * A palette the user picked by name owns the picture outright. 'theme' (skin +
 * album art) leaves part of the MilkDrop preset's own hue variation in, and
 * 'rainbow' leaves most of it — its whole point is colour travel. 'look'
 * matches it: the look's palette changes with every look, and the preset's
 * own colours are a large part of why MilkDrop looks the way it does.
 */
export function liveGradeFor(mode: EvilandPaletteMode): number {
  if (mode === 'look') return 0.45;
  if (mode === 'theme') return 0.72;
  if (mode === 'rainbow') return 0.45;
  return 1;
}

/** Tune visual amplitude without changing band classification, tempo or sections. */
export function tuneEvilandFrame(frame: EvilandFrame, mode: EvilandReactivity): EvilandFrame {
  if (mode === 'truth') return frame;
  const gain = mode === 'wild' ? 1.85 : 1.35;
  const curve = mode === 'wild' ? 0.72 : 0.86;
  const amp = (v: number): number => Math.min(1, Math.pow(Math.max(0, v), curve) * gain);
  return {
    ...frame, bands: frame.bands.map(amp),
    onsets: frame.onsets.map(o => ({ ...o, intensity: amp(o.intensity) })),
    energy: amp(frame.energy), kick: amp(frame.kick), bass: amp(frame.bass),
    snare: amp(frame.snare), hat: amp(frame.hat), vocal: amp(frame.vocal),
  };
}
