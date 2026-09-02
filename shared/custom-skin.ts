import type { BuiltInTheme, CustomSkin } from './types.js';

// Skin variables split by the kind of CSS value they hold, so imported/typed
// values can be checked against a grammar for that kind rather than one
// generic "looks safe" blacklist. See normalizeSkinVariableValue below.
export const COLOR_SKIN_VARIABLES = [
  '--bg',
  '--panel',
  '--panel-2',
  '--panel-3',
  '--line',
  '--accent',
  '--accent-dim',
  '--accent-glow',
  '--ink',
  '--ink-2',
  '--muted',
  '--warn',
  '--error',
  '--display-bg',
  '--display-fg',
  '--bevel-light',
  '--bevel-dark',
] as const;

export const LENGTH_SKIN_VARIABLES = [
  '--radius',
  '--radius-card',
] as const;

export const SKIN_VARIABLES = [...COLOR_SKIN_VARIABLES, ...LENGTH_SKIN_VARIABLES] as const;

export type SkinVariable = (typeof SKIN_VARIABLES)[number];

export interface ThemeRegistryEntry {
  id: BuiltInTheme;
  /** Card title shown in Settings → Skin. */
  label: string;
  /** One-line pitch under the label. */
  tagline: string;
  /** Swatch hexes on the card: [panel, accent, ink]. */
  swatches: [string, string, string];
}

/**
 * The ONE registry for built-in skins — id, display copy and swatches.
 * Order here is the order the Settings skin grid renders. The [data-theme]
 * CSS blocks live in src/styles/tokens.css under the same ids.
 */
export const THEME_REGISTRY: ThemeRegistryEntry[] = [
  { id: 'classic', label: 'Classic', tagline: 'Vintage Winamp 2.x — cast-metal chrome, green LCD', swatches: ['#2c3438', '#00ff66', '#c8d4d8'] },
  { id: 'ops', label: 'Ops', tagline: 'Trader-dashboard density — emerald cyan, hex grid', swatches: ['#0b1014', '#34d399', '#e2e8ee'] },
  { id: 'midnight', label: 'Midnight', tagline: 'Clean modern dark with violet accents', swatches: ['#11141b', '#7c5cff', '#e8ecf3'] },
  { id: 'neon', label: 'Neon', tagline: 'Cyberpunk magenta with scanlines', swatches: ['#160a26', '#ff36e0', '#ffe9fe'] },
  { id: 'amber', label: 'Amber', tagline: '70s terminal phosphor orange', swatches: ['#1b1408', '#ffb000', '#ffe2a1'] },
  { id: 'oxide', label: 'Oxide', tagline: 'Industrial steel with cyan meters and rust warning lights', swatches: ['#101419', '#51e6d8', '#f38d3c'] },
  { id: 'steel', label: 'Steel', tagline: 'Late-90s brushed metal deck with blue LCD', swatches: ['#c5cad0', '#2357d8', '#101826'] },
  { id: 'walnut', label: 'Record Deck', tagline: 'Turntable plinth, round album platter, amber meters', swatches: ['#21160f', '#f0a629', '#d7c0a0'] },
  { id: 'jukebox', label: 'Jukebox', tagline: 'Chrome arch, bubble controls, glowing title glass', swatches: ['#2a1018', '#ffcf4a', '#52f0d0'] },
  { id: 'terminal', label: 'Vintage Computer', tagline: 'CRT shell, phosphor display, square hardware keys', swatches: ['#101612', '#59ff85', '#cbd8c8'] },
  { id: 'ice', label: 'Ice', tagline: 'Frosted silver skin with cyan glass display', swatches: ['#e8eef2', '#00a6d6', '#14212a'] },
  { id: 'miami', label: 'Miami', tagline: 'Bright daylight deck with coral controls and teal LCD', swatches: ['#f3f4ef', '#ff4f79', '#10282e'] },
  { id: 'mono', label: 'Mono', tagline: 'High-contrast black, white, and red for long sessions', swatches: ['#080808', '#f5f5f0', '#ff3d3d'] },
];

export const BUILT_IN_THEMES: BuiltInTheme[] = THEME_REGISTRY.map((entry) => entry.id);

const SKIN_VARIABLE_SET = new Set<string>(SKIN_VARIABLES);
const COLOR_VARIABLE_SET = new Set<string>(COLOR_SKIN_VARIABLES);
const LENGTH_VARIABLE_SET = new Set<string>(LENGTH_SKIN_VARIABLES);
const THEME_SET = new Set<string>(BUILT_IN_THEMES);
const SKIN_FORMAT = 'newamp.custom-skin';
const SKIN_VERSION = 1;

// Function-like tokens that must never survive into a value we hand to
// document.documentElement.style.setProperty — rgb()/rgba()/hsl()/hsla() are
// the only functions a skin value is ever allowed to use, so anything else
// that opens a paren is a rejection regardless of which variable it's in.
// This list is a second net alongside the allowlist grammar below, not the
// primary defense — the allowlist regexes reject these on their own because
// none of them can ever match rgb()/rgba()/hsl()/hsla() or a bare length.
const BANNED_VALUE_TOKENS = [
  'url(',
  'image-set(',
  'cross-fade(',
  'element(',
  'src(',
  '@import',
  'expression(',
  'var(',
];

// The standard CSS named-color keywords, plus the two special color
// keywords. Anything not on this list has to parse as hex or as an
// rgb()/rgba()/hsl()/hsla() function to be accepted as a color.
const NAMED_COLORS = new Set([
  'transparent', 'currentcolor',
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow',
  'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet',
  'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
]);

// Numeric token shared by the color-function and length grammars: an
// integer or decimal, optionally followed by a percent sign.
const NUM = '(?:\\d+\\.?\\d*|\\.\\d+)%?';
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const RGB_COLOR_RE = new RegExp(`^rgba?\\(${NUM},${NUM},${NUM}(?:,${NUM})?\\)$`);
const HSL_COLOR_RE = new RegExp(`^hsla?\\(${NUM}(?:deg)?,${NUM},${NUM}(?:,${NUM})?\\)$`);
const LENGTH_RE = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)$/;
// Generous upper bounds — big enough for any real skin, small enough that a
// stray value can't blow up layout. 512px maps to the same ceiling in rem/em
// terms at the default 16px root font size.
const LENGTH_MAX_BY_UNIT: Record<string, number> = { px: 512, rem: 32, em: 32, '%': 100 };

function stripCssComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Validates one skin variable's value against an allowlist grammar for its
 * kind (color or length), returning the cleaned value to store/apply or null
 * to reject it. This is the single choke point every skin value must pass
 * through before it can reach parseCustomSkinFile's output, a persisted
 * setting, or document.documentElement.style.setProperty — see the call
 * sites in normalizeSkinVariables (here) and applyTheme (src/lib/skins.ts).
 *
 * A blacklist of bad characters isn't enough here: `url(https://host/id)` is
 * a syntactically fine CSS value that turns into an outbound network request
 * the instant it lands on a background/color slot the renderer's CSP allows
 * https: images for. So every value has to positively match a known-safe
 * shape instead — hex/rgb/hsl for colors, a bounded number+unit for lengths.
 */
export function normalizeSkinVariableValue(key: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // A backslash means a CSS escape (e.g. u\72l(...) spells "url(" with the
  // \72 hex escape for "r") or something trying to look like one. Reject
  // outright rather than attempting to unescape and re-check.
  if (raw.includes('\\')) return null;
  const stripped = stripCssComments(raw).trim();
  if (!stripped || stripped.length > 160) return null;
  // The grammar checks run against a lowercased, whitespace-free copy so
  // "URL( https://x )" and "url(https://x)" are caught the same way — but we
  // return `stripped`, not this collapsed form, so a value that already
  // matches (e.g. every built-in skin's "rgba(57, 255, 20, 0.55)") round-trips
  // byte-for-byte instead of being reformatted.
  const collapsed = stripped.toLowerCase().replace(/\s+/g, '');
  if (!collapsed || BANNED_VALUE_TOKENS.some((token) => collapsed.includes(token))) return null;

  if (COLOR_VARIABLE_SET.has(key)) {
    if (HEX_COLOR_RE.test(collapsed)) return stripped;
    if (RGB_COLOR_RE.test(collapsed) || HSL_COLOR_RE.test(collapsed)) return stripped;
    if (!collapsed.includes('(') && NAMED_COLORS.has(collapsed)) return stripped;
    return null;
  }

  if (LENGTH_VARIABLE_SET.has(key)) {
    const match = LENGTH_RE.exec(collapsed);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount < 0 || amount > LENGTH_MAX_BY_UNIT[unit]) return null;
    return stripped;
  }

  return null;
}

export interface NewAmpSkinFile {
  format: typeof SKIN_FORMAT;
  version: typeof SKIN_VERSION;
  exportedAt: number;
  skin: CustomSkin;
}

export function normalizeCustomSkin(value: unknown): CustomSkin | null {
  if (!isObject(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 80) : '';
  const baseTheme = THEME_SET.has(String(value.baseTheme))
    ? value.baseTheme as BuiltInTheme
    : 'classic';
  const variables = normalizeSkinVariables(value.variables);
  if (!Object.keys(variables).length) return null;

  return {
    name: name || 'NewAmp Custom',
    baseTheme,
    variables,
    updatedAt: normalizeTimestamp(value.updatedAt),
  };
}

export function skinToFile(skin: CustomSkin, now = Date.now()): NewAmpSkinFile {
  const normalized = normalizeCustomSkin(skin);
  if (!normalized) throw new Error('Custom skin has no valid variables.');
  return {
    format: SKIN_FORMAT,
    version: SKIN_VERSION,
    exportedAt: normalizeTimestamp(now),
    skin: normalized,
  };
}

export function serializeCustomSkin(skin: CustomSkin): string {
  return `${JSON.stringify(skinToFile(skin), null, 2)}\n`;
}

export function parseCustomSkinFile(content: string): CustomSkin {
  const parsed = JSON.parse(content) as unknown;
  const candidate = isObject(parsed) && isObject(parsed.skin) ? parsed.skin : parsed;
  const skin = normalizeCustomSkin(candidate);
  if (!skin) throw new Error('This file does not contain a valid NewAmp custom skin.');
  return skin;
}

function normalizeSkinVariables(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SKIN_VARIABLE_SET.has(key)) continue;
    const cleaned = normalizeSkinVariableValue(key, raw);
    if (cleaned) out[key] = cleaned;
  }
  return out;
}

function normalizeTimestamp(value: unknown): number {
  const timestamp = Math.trunc(Number(value));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
