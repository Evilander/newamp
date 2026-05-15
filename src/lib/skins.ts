import type { BuiltInTheme, CustomSkin, Theme } from '@shared/types';
import { SKIN_VARIABLES } from '@shared/custom-skin';

export type SkinVariable = (typeof SKIN_VARIABLES)[number];
export { SKIN_VARIABLES };

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

export function applyTheme(theme: Theme, customSkin?: CustomSkin | null): void {
  const root = document.documentElement;
  for (const key of SKIN_VARIABLES) root.style.removeProperty(key);

  if (theme === 'custom' && customSkin) {
    root.dataset.theme = customSkin.baseTheme;
    for (const [key, value] of Object.entries(customSkin.variables)) {
      if (SKIN_VARIABLES.includes(key as SkinVariable) && value.trim()) {
        root.style.setProperty(key, value);
      }
    }
    return;
  }

  root.dataset.theme = theme === 'custom' ? 'classic' : theme;
}

export function readCurrentSkinVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    SKIN_VARIABLES.map((key) => [key, styles.getPropertyValue(key).trim()]),
  );
}
