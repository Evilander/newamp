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

export const BUILT_IN_THEMES: BuiltInTheme[] = [
  'classic',
  'ops',
  'oxide',
  'midnight',
  'neon',
  'miami',
  'amber',
  'mono',
];

const SKIN_VARIABLE_SET = new Set<string>(SKIN_VARIABLES);
const THEME_SET = new Set<string>(BUILT_IN_THEMES);
const SKIN_FORMAT = 'newamp.custom-skin';
const SKIN_VERSION = 1;

export interface NewampSkinFile {
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
    name: name || 'Newamp Custom',
    baseTheme,
    variables,
    updatedAt: normalizeTimestamp(value.updatedAt),
  };
}

export function skinToFile(skin: CustomSkin, now = Date.now()): NewampSkinFile {
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
  if (!skin) throw new Error('This file does not contain a valid Newamp custom skin.');
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
