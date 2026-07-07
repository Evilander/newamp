import type { BuiltInTheme, CustomSkin } from './types.js';

export const SKIN_VARIABLES = [
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
  '--radius',
  '--radius-card',
] as const;

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
const THEME_SET = new Set<string>(BUILT_IN_THEMES);
const SKIN_FORMAT = 'newamp.custom-skin';
const SKIN_VERSION = 1;

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
    if (!SKIN_VARIABLE_SET.has(key) || typeof raw !== 'string') continue;
    const cleaned = cleanCssVariableValue(raw);
    if (cleaned) out[key] = cleaned;
  }
  return out;
}

function cleanCssVariableValue(value: string): string | null {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 160) return null;
  if (/[\x00-\x1f<>;{}]/.test(cleaned)) return null;
  return cleaned;
}

function normalizeTimestamp(value: unknown): number {
  const timestamp = Math.trunc(Number(value));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
