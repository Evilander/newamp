import type { EvilandFrame } from './eviland-audio';
import type { OperatorConfig, PaletteConfig, RGB } from './eviland-operators';
import { hashSeed } from './eviland-rng';

export type EvilandPaletteMode = 'look' | 'theme' | 'phosphor' | 'ice' | 'sunset' | 'rainbow';
export type EvilandReactivity = 'truth' | 'punch' | 'wild';

// Palettes made here are cached by the colours they were made from, never by
// the identity of the object that carried them: the Director lerps a look's
// palette in place every frame, so one object holds different colours from
// frame to frame. A key is the role colours (bg, dark, accent, light, accent2)
// as fifteen numbers, then whatever else the result depends on.
const PALETTE_ROLES = ['bg', 'dark', 'accent', 'light', 'accent2'] as const;
const ROLE_COUNT = PALETTE_ROLES.length;
const KEY_PALETTE = ROLE_COUNT * 3;
// A palette without a second accent keys as -1s, which no colour can be.
const NO_ROLE: RGB = [-1, -1, -1];

function holdsPalette(key: Float64Array, palette: PaletteConfig): boolean {
  for (let r = 0; r < ROLE_COUNT; r++) {
    const c = palette[PALETTE_ROLES[r]!] ?? NO_ROLE;
    const o = r * 3;
    if (key[o] !== c[0] || key[o + 1] !== c[1] || key[o + 2] !== c[2]) return false;
  }
  return true;
}

function keepPalette(key: Float64Array, palette: PaletteConfig): void {
  for (let r = 0; r < ROLE_COUNT; r++) {
    const c = palette[PALETTE_ROLES[r]!] ?? NO_ROLE;
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

// The last key-shifted palette. The shift only moves for a couple of seconds
// after a modulation; the rest of the time this is a cache hit and resolving
// the palette allocates nothing. Key: palette, then the shift.
const shiftedKey = new Float64Array(KEY_PALETTE + 1);
let shifted: PaletteConfig | null = null;
// The last palette taken through the section's mood. Key: palette, then the mood.
const moodedKey = new Float64Array(KEY_PALETTE + 1);
let mooded: PaletteConfig | null = null;

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

// A dark role that is turned (not built) cannot hop out of the band: the key
// shift glides half a degree at a time and a hop would show as a tint pop. It
// keeps its hue and loses chroma instead. The band is fully grey (this share
// of its chroma) from 65 to 100 degrees and eases back to full over the fifteen
// degrees to either edge, so a hue leaveMud leaves alone (everything outside
// 50 to 115) is never touched and a glide starts from the look as it was made.
const MUD_CHROMA_FLOOR = 0.15;
const MUD_CORE = { from: 65, to: 100 };

/** The share of its chroma a dark role keeps at hue `h`: continuous in the hue, so a glide through the olive band has no step. */
export function mudChromaShare(h: number): number {
  const hue = ((h % 360) + 360) % 360;
  if (hue <= MUD_HUES.from || hue >= MUD_HUES.to) return 1;
  if (hue >= MUD_CORE.from && hue <= MUD_CORE.to) return MUD_CHROMA_FLOOR;
  const t = hue < MUD_CORE.from ? (hue - MUD_CORE.from) / (MUD_HUES.from - MUD_CORE.from) : (hue - MUD_CORE.to) / (MUD_HUES.to - MUD_CORE.to);
  const s = t * t * (3 - 2 * t);
  return MUD_CHROMA_FLOOR + (1 - MUD_CHROMA_FLOOR) * s;
}

/**
 * A palette turned so its accent sits on `hue`; every colour keeps its
 * lightness and chroma, the second accent included, so the pair stays the
 * same distance apart round the wheel. The dark role goes grey rather than
 * olive or brown when the turn lands it in that band (see mudChromaShare).
 */
export function turnPaletteToHue(palette: PaletteConfig, hue: number): PaletteConfig {
  const delta = hue - rgbToOklch(palette.accent).h;
  const turn = (rgb: RGB, chromaShare: (h: number) => number = () => 1): RGB => {
    const o = rgbToOklch(rgb);
    const h = (((o.h + delta) % 360) + 360) % 360;
    return oklchToRgb(o.l, o.c * chromaShare(h), h);
  };
  const turned: PaletteConfig = { bg: turn(palette.bg), dark: turn(palette.dark, mudChromaShare), accent: turn(palette.accent), light: turn(palette.light) };
  if (palette.accent2) turned.accent2 = turn(palette.accent2);
  return turned;
}

// How far round the wheel a derived second accent sits from the first.
const PAIR_TURN = 35;
const pairKey = new Float64Array(3);
let pairSeed = '';
let pair: RGB | null = null;

/**
 * The palette's second accent. A palette made before there was one (an old
 * saved look, a replay, a seed code from an earlier version) gets an
 * analogous partner, 35 degrees round the wheel at the accent's lightness
 * and chroma. `seed` is the look's seed: it decides which side the partner
 * falls on, so one look always lands the same way and a fade between an old
 * look and a new one has no snap to find. Never complementary: a look with
 * a single lit hue stays inside its own colour family.
 */
export function accentPair(palette: PaletteConfig, seed = ''): RGB {
  if (palette.accent2) return palette.accent2;
  const accent = palette.accent;
  if (pair && pairSeed === seed && pairKey[0] === accent[0] && pairKey[1] === accent[1] && pairKey[2] === accent[2]) return pair;
  const side = seed !== '' && hashSeed(`${seed}::accent2`) % 2 === 1 ? -1 : 1;
  pairSeed = seed;
  pairKey[0] = accent[0];
  pairKey[1] = accent[1];
  pairKey[2] = accent[2];
  const o = rgbToOklch(accent);
  pair = oklchToRgb(o.l, o.c, o.h + side * PAIR_TURN);
  return pair;
}

/** Two colours mixed in OKLCh: lightness and chroma linearly, hue along the short arc. */
export function mixOklch(a: RGB, b: RGB, t: number): RGB {
  if (!(t > 0)) return [a[0], a[1], a[2]];
  if (t >= 1) return [b[0], b[1], b[2]];
  const x = rgbToOklch(a);
  const y = rgbToOklch(b);
  // A near-grey colour has no hue of its own; take the other side's.
  let h: number;
  if (x.c < 0.004) h = y.h;
  else if (y.c < 0.004) h = x.h;
  else {
    let d = y.h - x.h;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    h = x.h + d * t;
  }
  return oklchToRgb(x.l + (y.l - x.l) * t, x.c + (y.c - x.c) * t, h);
}

/** A colour at OKLCh lightness `l` and hue `h` carrying `share` of the chroma sRGB can show there. */
function role(l: number, share: number, h: number): RGB {
  return oklchToRgb(l, maxChroma(l, h) * share, h);
}

/**
 * The palette a skin gives Eviland, built in OKLCh from its accent. The light
 * role is the accent's hue at L 0.92 with half its chroma, so the top of every
 * ramp carries the skin's colour instead of the UI's near-white ink; a skin
 * that wants the ink there sets `--viz-light`. The dark role is the skin's own
 * `--accent-dim` when it has one, else the hue stepped out of the olive band at
 * L 0.40. The second accent is the analogous partner.
 */
export function themePaletteFromAccent(accent: RGB, dim: RGB | null, bg: RGB, light?: RGB | null): PaletteConfig {
  const o = rgbToOklch(accent);
  return {
    bg,
    dark: dim ?? role(0.4, 0.6, leaveMud(o.h)),
    accent,
    light: light ?? role(0.92, 0.5, o.h),
    accent2: oklchToRgb(o.l, o.c, o.h + PAIR_TURN),
  };
}

/**
 * The section's mood on a palette. A minor key lowers lightness (6%) and
 * chroma (12%) and pulls the accents 6 degrees round the wheel; a major key
 * does the reverse. `minor` is 0 for a major section and 1 for a minor one,
 * glided by the conductor, and `confidence` is how sure the score is of the
 * key: a section it cannot place (confidence 0) leaves the palette alone, and
 * so does the halfway point of a glide. Colours that would leave sRGB lose
 * chroma and keep their lightness and hue.
 */
export function moodShift(palette: PaletteConfig, minor: number, confidence: number): PaletteConfig {
  const strength = Math.round(Math.max(-1, Math.min(1, (minor * 2 - 1) * confidence)) * 64) / 64;
  if (!(Math.abs(strength) > 0)) return palette;
  if (mooded && holdsPalette(moodedKey, palette) && moodedKey[KEY_PALETTE] === strength) return mooded;
  keepPalette(moodedKey, palette);
  moodedKey[KEY_PALETTE] = strength;
  const tone = (rgb: RGB, hueShift: number): RGB => {
    const o = rgbToOklch(rgb);
    return oklchToRgb(Math.min(0.985, o.l * (1 - 0.06 * strength)), o.c * (1 - 0.12 * strength), o.h - hueShift * strength);
  };
  const next: PaletteConfig = { bg: palette.bg, dark: tone(palette.dark, 0), accent: tone(palette.accent, 6), light: tone(palette.light, 6) };
  if (palette.accent2) next.accent2 = tone(palette.accent2, 6);
  mooded = next;
  return next;
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

/**
 * Blend sleeve colours into a theme palette, in OKLCh so a green skin meeting
 * a red cover does not pass through olive. The background stays the theme's
 * (legibility contract); the accent leans hardest into the art (0.75), the
 * dark role next (0.6) and the light tone least (0.45), so bright layers stay
 * bright whatever the sleeve. The second accent goes to the sleeve's second
 * hue, lit like the sleeve's vibrant colour (its lightness and chroma share),
 * because the sleeve's own secondary is a pale tone made for the light role. `mix` scales
 * all three weights.
 */
export function blendThemeWithSleeve(theme: PaletteConfig, art: SleeveColours | null, mix = 1): PaletteConfig {
  if (!art) return theme;
  const accentWeight = clamp01(0.75 * mix);
  const accent = mixOklch(theme.accent, art.vibrant, accentWeight);
  const vibrant = rgbToOklch(art.vibrant);
  const share = clamp01(vibrant.c / Math.max(1e-4, maxChroma(vibrant.l, vibrant.h)));
  const second = rgbToOklch(art.secondary);
  return {
    accent,
    dark: mixOklch(theme.dark, art.muted, clamp01(0.6 * mix)),
    light: mixOklch(theme.light, art.secondary, clamp01(0.45 * mix)),
    bg: theme.bg,
    accent2: mixOklch(accentPair(theme), role(vibrant.l, share * 0.9, second.h), accentWeight),
  };
}

// Half of the looks follow the sleeve's hue; which half is decided by the seed.
const followsSleeve = new Map<string, boolean>();
// Key: look palette, then the cover's vibrant colour (the only part that turns it).
const turnedKey = new Float64Array(KEY_PALETTE + 3);
let turned: PaletteConfig | null = null;
// Key: theme palette, then the cover's vibrant, secondary and muted colours.
const blendedKey = new Float64Array(KEY_PALETTE + 9);
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
  if (turned && holdsPalette(turnedKey, look) && holdsColour(turnedKey, KEY_PALETTE, art.vibrant)) {
    target = turned;
  } else {
    keepPalette(turnedKey, look);
    keepColour(turnedKey, KEY_PALETTE, art.vibrant);
    turned = turnPaletteToHue(look, rgbToOklch(art.vibrant).h);
    target = turned;
  }
  if (weight >= 1) return target;
  const faded: PaletteConfig = {
    bg: mixOklch(look.bg, target.bg, weight),
    dark: mixOklch(look.dark, target.dark, weight),
    accent: mixOklch(look.accent, target.accent, weight),
    light: mixOklch(look.light, target.light, weight),
  };
  if (look.accent2 && target.accent2) faded.accent2 = mixOklch(look.accent2, target.accent2, weight);
  return faded;
}

function themeForSleeve(theme: PaletteConfig, sleeve: Sleeve | null | undefined): PaletteConfig {
  const art = sleeve?.art;
  if (!art) return theme;
  if (blended && holdsPalette(blendedKey, theme)
    && holdsColour(blendedKey, KEY_PALETTE, art.vibrant) && holdsColour(blendedKey, KEY_PALETTE + 3, art.secondary) && holdsColour(blendedKey, KEY_PALETTE + 6, art.muted)) return blended;
  keepPalette(blendedKey, theme);
  keepColour(blendedKey, KEY_PALETTE, art.vibrant);
  keepColour(blendedKey, KEY_PALETTE + 3, art.secondary);
  keepColour(blendedKey, KEY_PALETTE + 6, art.muted);
  blended = blendThemeWithSleeve(theme, art);
  return blended;
}

/**
 * The palette turned by the song's key: the accent's hue moves `keyShift`
 * turns round the OKLCh wheel and every other role goes with it, keeping its
 * lightness and chroma. Only the background stays where it was. The shift
 * moves for a couple of seconds after a modulation and is quantised to
 * 1/720 of a turn, so the rest of the time this is a cache hit.
 */
function keyShifted(base: PaletteConfig, keyShift: number): PaletteConfig {
  const turns = Math.round(keyShift * 720) / 720;
  if (!(Math.abs(turns) > 0)) return base;
  if (shifted && holdsPalette(shiftedKey, base) && shiftedKey[KEY_PALETTE] === turns) return shifted;
  keepPalette(shiftedKey, base);
  shiftedKey[KEY_PALETTE] = turns;
  shifted = turnPaletteToHue(base, rgbToOklch(base.accent).h + turns * 360);
  shifted.bg = base.bg;
  return shifted;
}

// Phosphor, ice and sunset are palettes the user picked by name, so each is one
// fixed object. The second accent is designed against the first: amber against
// phosphor green, violet against ice blue, magenta against sunset red. The
// lights carry a little of the hue, so the top of the ramp is never a flat white.
const PHOSPHOR: PaletteConfig = { bg: [0.002, 0.01, 0.004], dark: [0.02, 0.22, 0.06], accent: [0.2, 1, 0.35], light: [0.62, 1, 0.7], accent2: [1, 0.72, 0.12] };
const ICE: PaletteConfig = { bg: [0.003, 0.008, 0.025], dark: [0.03, 0.15, 0.45], accent: [0.1, 0.68, 1], light: [0.55, 0.95, 1], accent2: [0.56, 0.4, 1] };
const SUNSET: PaletteConfig = { bg: [0.018, 0.002, 0.012], dark: [0.45, 0.03, 0.22], accent: [1, 0.12, 0.24], light: [1, 0.68, 0.16], accent2: [0.82, 0.1, 0.85] };

// The rainbow's hue is snapped to half a degree, well under what the eye tells
// apart at this lightness, so the 720 palettes are built once, on first use,
// and every frame after that is a lookup that allocates nothing.
const RAINBOW_STEPS = 720;
const rainbowTable: (PaletteConfig | undefined)[] = new Array(RAINBOW_STEPS);

/** Rainbow: a hue that travels round the wheel at fixed lightness, so yellow is no brighter than blue. Starts on red. */
function rainbow(seconds: number, keyShift: number): PaletteConfig {
  const turn = Number.isFinite(seconds) && Number.isFinite(keyShift) ? seconds * 0.035 + keyShift : 0;
  const step = ((Math.round((29 + turn * 360) * 2) % RAINBOW_STEPS) + RAINBOW_STEPS) % RAINBOW_STEPS;
  const cached = rainbowTable[step];
  if (cached) return cached;
  const hue = step / 2;
  const dark = (hue + 240) % 360;
  const built: PaletteConfig = {
    bg: [0.006, 0.004, 0.012],
    dark: oklchToRgb(0.4, maxChroma(0.4, dark) * 0.6 * mudChromaShare(dark), dark),
    accent: role(0.74, 0.85, hue),
    light: role(0.93, 0.4, hue + 90),
    accent2: role(0.74, 0.8, hue + 120),
  };
  rainbowTable[step] = built;
  return built;
}

/**
 * Resolve once for the complete image, before any source is drawn.
 *
 * `keyShift` (turns, from the song score) rotates the palette when the music
 * modulates away from its home key, in OKLCh so lightness holds still. It
 * applies to 'look' and 'theme' and is built into 'rainbow'; a palette the
 * user picked by name stays exactly that palette.
 *
 * `minor` (0 major, 1 minor, from the score) and `keyConfidence` (0..1) give
 * 'look' and 'theme' the section's mood: minor sections go a touch darker,
 * greyer and cooler, major ones the reverse (see moodShift). Left at zero,
 * the palette is untouched.
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
  minor = 0,
  keyConfidence = 0,
): PaletteConfig {
  if (mode === 'look' || mode === 'theme') {
    const base = mode === 'look' && look ? (sleeve ? lookForSleeve(look, sleeve) : look) : themeForSleeve(theme, sleeve);
    return moodShift(keyShifted(base, keyShift), minor, keyConfidence);
  }
  if (mode === 'phosphor') return PHOSPHOR;
  if (mode === 'ice') return ICE;
  if (mode === 'sunset') return SUNSET;
  return rainbow(seconds, keyShift);
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
