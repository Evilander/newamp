import type { CustomSkin, Theme } from '@shared/types';
import {
  BUILT_IN_THEMES,
  SKIN_VARIABLES,
  THEME_REGISTRY,
  contrastRatio,
  deriveOnAccent,
  normalizeSkinVariableValue,
  parseSkinColorRgb,
} from '@shared/custom-skin';
import type { ThemeRegistryEntry } from '@shared/custom-skin';

export type SkinVariable = (typeof SKIN_VARIABLES)[number];
// Single source of truth for built-in skins lives in @shared/custom-skin —
// ids, Settings card copy and swatches all come from THEME_REGISTRY.
export { BUILT_IN_THEMES, SKIN_VARIABLES, THEME_REGISTRY };
export type { ThemeRegistryEntry };

// Text-role tokens follow the colour they are the text version of. Without
// this a skin that sets its own --accent, --warn or --error would keep the base
// theme's --accent-text, --warn-text and --error-text on the elements that read
// them (primary buttons, chips, armed confirmations).
const TEXT_ROLE_TOKENS = [
  { source: '--accent', token: '--accent-text', base: 'accent' },
  { source: '--warn', token: '--warn-text', base: 'warn' },
  { source: '--error', token: '--error-text', base: 'error' },
] as const;

// The variables a derived colour is computed from.
const DERIVED_INPUTS = ['--accent', '--on-accent', '--warn', '--error'] as const;

export function applyTheme(theme: Theme, customSkin?: CustomSkin | null): void {
  const root = document.documentElement;
  for (const key of SKIN_VARIABLES) root.style.removeProperty(key);
  for (const { token } of TEXT_ROLE_TOKENS) root.style.removeProperty(token);
  for (const token of ['--accent-ink', '--accent-frame', '--well-dim', '--well-warn', '--panel-dim', '--panel-detail-ink', '--panel-lcd', '--well-ink', '--well-secondary', '--well-accent', '--well-error', '--well-color', '--scrim-ink', '--scrim-accent', '--panel-note', '--display-placeholder']) root.style.removeProperty(token);

  if (theme === 'custom' && customSkin) {
    root.dataset.theme = customSkin.baseTheme;
    applySkinVariables(root, customSkin.variables);
    return;
  }

  root.dataset.theme = theme === 'custom' ? 'classic' : theme;
  applyAccentInk(root);
}

function applySkinVariables(root: HTMLElement, variables: Record<string, string>): void {
  const base = readBaseSkinColors(root);
  const applied: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!SKIN_VARIABLES.includes(key as SkinVariable)) continue;
    // Re-validate here even though normalizeCustomSkin already ran at
    // import/save time — this is the call that actually reaches the DOM
    // (document.documentElement.style.setProperty), so it's the last place
    // a value like url(https://host/id) could slip through from a settings
    // file that was hand-edited or written by an older build.
    const safe = normalizeSkinVariableValue(key, value);
    if (!safe) continue;
    root.style.setProperty(key, safe);
    applied[key] = safe;
  }
  applyDerivedColors(root, applied, base);
  applyAccentInk(root);
}

/**
 * Puts a whole draft on the page the way Save and re-apply would, without
 * touching the base theme. For edits that move many variables at once (the
 * tint sliders); one edited variable goes through previewSkinVariable.
 */
export function previewSkinDraft(variables: Record<string, string>): void {
  const root = document.documentElement;
  for (const key of SKIN_VARIABLES) root.style.removeProperty(key);
  for (const { token } of TEXT_ROLE_TOKENS) root.style.removeProperty(token);
  applySkinVariables(root, variables);
}

/**
 * Live preview of one Skin Workshop edit. Sets the variable the way applyTheme
 * would, then redoes the derived colours from the draft, so a pressed pill in
 * the preview already carries the label that Save and re-apply will give it.
 */
export function previewSkinVariable(draft: Record<string, string>, key: string, value: string): void {
  const safe = normalizeSkinVariableValue(key, value);
  if (safe === null) return;
  const root = document.documentElement;
  root.style.setProperty(key, safe);
  if (!(DERIVED_INPUTS as readonly string[]).includes(key)) {
    applyAccentInk(root);
    return;
  }

  // The base theme's own colours: read with the inline overrides lifted, then put back.
  const held = DERIVED_INPUTS.map((name) => [name, root.style.getPropertyValue(name)] as const);
  for (const [name] of held) root.style.removeProperty(name);
  const base = readBaseSkinColors(root);
  for (const [name, previous] of held) if (previous) root.style.setProperty(name, previous);

  const inputs: Record<string, string> = {};
  for (const [name, previous] of held) {
    // A half-typed value keeps the colour already on screen. The label is the
    // exception: what is on screen may be one derived earlier, and it only
    // counts as chosen when the draft has it.
    const fallback = name === '--on-accent' ? null : previous;
    const usable = name === key ? safe : normalizeSkinVariableValue(name, draft[name]) ?? fallback;
    if (usable) inputs[name] = usable;
  }
  for (const { token } of TEXT_ROLE_TOKENS) root.style.removeProperty(token);
  if (inputs['--on-accent']) root.style.setProperty('--on-accent', inputs['--on-accent']);
  else root.style.removeProperty('--on-accent');
  applyDerivedColors(root, inputs, base);
  applyAccentInk(root);
}

function applyDerivedColors(root: HTMLElement, applied: Record<string, string>, base: BaseSkinColors): void {
  const onAccent = deriveSkinOnAccent(applied, base);
  if (onAccent) root.style.setProperty('--on-accent', onAccent);
  for (const [token, value] of Object.entries(deriveSkinTextTokens(applied, base))) {
    root.style.setProperty(token, value);
  }
}

export interface BaseSkinColors {
  accent: string;
  onAccent: string;
  warn: string;
  error: string;
}

// The base theme's accent, label, warn and error colours, read before a custom
// skin's inline variables land on the root.
function readBaseSkinColors(root: HTMLElement): BaseSkinColors {
  if (typeof getComputedStyle !== 'function') return { accent: '', onAccent: '', warn: '', error: '' };
  const styles = getComputedStyle(root);
  const read = (name: string): string => styles.getPropertyValue(name).trim();
  return { accent: read('--accent'), onAccent: read('--on-accent'), warn: read('--warn'), error: read('--error') };
}

function sameColorText(a: string, b: string): boolean {
  const compact = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '');
  return compact(a) === compact(b);
}

// Named colours (and anything else deriveOnAccent can't read) go through the
// browser's own parser.
export function resolveCssColor(value: string): string | null {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('span');
  probe.style.color = value;
  if (!probe.style.color) return null;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

function readColor(value: string): ReturnType<typeof parseSkinColorRgb> {
  const parse = (text: string): ReturnType<typeof parseSkinColorRgb> => {
    const direct = parseSkinColorRgb(text);
    if (direct) return direct;
    // Chromium computes color-mix() as color(srgb ...), not rgb().
    const srgb = /^color\(srgb ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+)/i.exec(text);
    return srgb ? [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255] : null;
  };
  const direct = parse(value);
  if (direct) return direct;
  const resolved = resolveCssColor(value);
  return resolved ? parse(resolved) : null;
}

// Below this a label is close to invisible on its fill, whoever picked it.
const MIN_PICKED_LABEL_CONTRAST = 3;

function unreadableOn(label: string, fill: string): boolean {
  const labelRgb = readColor(label);
  const fillRgb = readColor(fill);
  return !!labelRgb && !!fillRgb && contrastRatio(labelRgb, fillRgb) < MIN_PICKED_LABEL_CONTRAST;
}

/**
 * The --on-accent to set on top of a custom skin's own variables, or null
 * when the label already in place is the right one. A skin that moves --accent
 * but doesn't pick a label colour gets one derived from its accent. The Skin
 * Workshop saves every variable, so a value that just repeats the base theme's
 * counts as not picked; a label the author chose is kept unless it can barely
 * be read on the accent, whether or not the accent moved (the Workshop also
 * saves the label that was derived for an earlier accent).
 */
export function deriveSkinOnAccent(variables: Record<string, string>, base: BaseSkinColors): string | null {
  const accent = variables['--accent'];
  if (!accent) return null;
  const chosen = variables['--on-accent'];
  const picked = chosen && !sameColorText(chosen, base.onAccent) ? chosen : null;
  if (picked && !unreadableOn(picked, accent)) return null;
  if (!picked && sameColorText(accent, base.accent)) return null;
  const derived = deriveOnAccent(accent);
  if (derived) return derived;
  const resolved = resolveCssColor(accent);
  return resolved ? deriveOnAccent(resolved) : null;
}

/**
 * The text-role tokens (--accent-text, --warn-text, --error-text) to set on top
 * of a custom skin's own variables. A skin that moves --accent, --warn or
 * --error gets its own colour as the text colour too, as those elements used
 * the plain token before the text roles existed. A value that just repeats the
 * base theme's is left out, so a skin saved from the Workshop keeps the base
 * theme's hand-tuned text colours until it really changes the colour.
 */
export function deriveSkinTextTokens(variables: Record<string, string>, base: BaseSkinColors): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const { source, token, base: baseKey } of TEXT_ROLE_TOKENS) {
    const value = variables[source];
    if (value && !sameColorText(value, base[baseKey])) tokens[token] = value;
  }
  return tokens;
}

export function readCurrentSkinVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    SKIN_VARIABLES.map((key) => [key, styles.getPropertyValue(key).trim()]),
  );
}

/** Keep the accent unchanged wherever it already reads on panel surfaces. */
export function deriveAccentInk(accent: string, ink: string, surfaces: string[]): string {
  const start = readColor(accent);
  const end = readColor(ink);
  const backgrounds = surfaces.map(readColor);
  if (!start || !end || backgrounds.some((color) => !color)) return accent;
  const readable = (color: number[]): boolean => backgrounds.every((background) => contrastRatio(color as [number, number, number], background!) >= 4.5);
  if (readable(start)) return accent;
  for (let step = 1; step <= 1024; step += 1) {
    const mixed = start.map((channel, i) => Math.round(channel + (end[i]! - channel) * step / 1024));
    if (readable(mixed)) return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }
  return ink;
}

function applyAccentInk(root: HTMLElement): void {
  if (typeof getComputedStyle !== 'function') return;
  const styles = getComputedStyle(root);
  const read = (name: string): string => styles.getPropertyValue(name).trim();
  const mix = (foreground: string, share: number, background: string): string => {
    const fg = readColor(foreground);
    const bg = readColor(background);
    return fg && bg ? `rgb(${fg.map((channel, i) => channel * share + bg[i]! * (1 - share)).join(',')})` : background;
  };
  const panels = [read('--panel'), read('--panel-2')];
  // Beveled panels retain their original 18% black wash.
  const shaded = panels.map((panel) => mix('#000000', 0.18, panel));
  const surfaces = [...panels, ...shaded, ...shaded.map((panel) => mix(read('--accent'), 0.08, panel))];
  root.style.setProperty('--accent-ink', deriveAccentInk(read('--accent'), read('--ink'), surfaces));
  // The album panel paints --panel under a fading 8% accent wash.
  const albumPanel = [read('--panel'), mix(read('--accent'), 0.08, read('--panel'))];
  root.style.setProperty('--panel-dim', deriveAccentInk(read('--muted'), read('--ink'), albumPanel));
  root.style.setProperty('--panel-detail-ink', deriveAccentInk(read('--ink-2'), read('--ink'), surfaces));
  root.style.setProperty('--panel-lcd', deriveAccentInk(read('--display-fg'), read('--ink'), surfaces));
  root.style.setProperty('--accent-frame', deriveAccentInk(read('--accent'), read('--titlebar-fg-flat') || read('--ink'), [read('--bg')]));
  const readsOn = (value: string, backgrounds: string[]): boolean => {
    const rgb = readColor(value);
    return !!rgb && backgrounds.every((surface) => {
      const background = readColor(surface);
      return !!background && contrastRatio(rgb, background) >= 4.5;
    });
  };
  // Its "no album page" note is --ink-2 at 70% wherever that still reads.
  root.style.setProperty('--panel-note', albumPanel.every((panel) => readsOn(mix(read('--ink-2'), 0.7, panel), [panel])) ? `color-mix(in srgb, ${read('--ink-2')} 70%, transparent)` : read('--ink-2'));
  const display = read('--display-bg');
  // The score field keeps Tailwind's placeholder grey wherever it reads there.
  root.style.setProperty('--display-placeholder', readsOn('#9ca3af', [display]) ? '#9ca3af' : deriveAccentInk(read('--display-dim'), read('--display-fg'), [display]));
  // Modern paints a well flat; the other shells darken it by 35% to 15%.
  const wells = [display, ...[0.35, 0.15].map((share) => mix('#000000', share, display))];
  wells.push(...panels.map((panel) => mix(display, 0.72, mix(read('--accent'), 0.08, panel))));
  const wellText = (source: string, displayToken: string): string => {
    const original = read(source);
    if (readsOn(original, wells)) return original;
    return deriveAccentInk(read(displayToken), read('--display-fg'), wells);
  };
  // Accent, warning and error keep their own hue in a well, lightened or
  // darkened only as far as it takes, so the three still tell apart.
  const extreme = readsOn('#ffffff', wells) ? '#ffffff' : '#000000';
  const wellTone = (source: string, hue: string): string => {
    const original = read(source);
    return readsOn(original, wells) ? original : deriveAccentInk(read(hue), extreme, wells);
  };
  const wellInk = wellText('--ink', '--display-fg');
  const wellSecondary = wellText('--ink-2', '--display-dim');
  const wellDim = wellText('--muted', '--display-dim');
  root.style.setProperty('--well-ink', wellInk);
  root.style.setProperty('--well-secondary', wellSecondary);
  root.style.setProperty('--well-dim', wellDim);
  root.style.setProperty('--well-accent', wellTone('--accent-text', '--accent'));
  root.style.setProperty('--well-warn', wellTone('--warn-text', '--warn'));
  root.style.setProperty('--well-error', wellTone('--error-text', '--error'));
  // A well only repaints the text it inherits when the skin's own tones fail there.
  if (wellInk === read('--ink') && wellSecondary === read('--ink-2') && wellDim === read('--muted')) root.style.removeProperty('--well-color');
  else root.style.setProperty('--well-color', wellInk);
  // The black scrims over album art and the visualizer. A colour that has to
  // be replaced there is picked to read over white art as well.
  const scrims = ['#000000', mix('#000000', 0.72, read('--panel'))];
  const anyArt = [...scrims, mix('#000000', 0.72, '#ffffff')];
  const onScrim = (source: string, start: string): string => readsOn(read(source), scrims) ? read(source) : deriveAccentInk(read(start), '#ffffff', anyArt);
  root.style.setProperty('--scrim-ink', onScrim('--ink', '--display-fg'));
  root.style.setProperty('--scrim-accent', onScrim('--accent', '--accent'));
}
