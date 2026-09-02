import type { CustomSkin, Theme } from '@shared/types';
import { BUILT_IN_THEMES, SKIN_VARIABLES, THEME_REGISTRY, normalizeSkinVariableValue } from '@shared/custom-skin';
import type { ThemeRegistryEntry } from '@shared/custom-skin';

export type SkinVariable = (typeof SKIN_VARIABLES)[number];
// Single source of truth for built-in skins lives in @shared/custom-skin —
// ids, Settings card copy and swatches all come from THEME_REGISTRY.
export { BUILT_IN_THEMES, SKIN_VARIABLES, THEME_REGISTRY };
export type { ThemeRegistryEntry };

export function applyTheme(theme: Theme, customSkin?: CustomSkin | null): void {
  const root = document.documentElement;
  for (const key of SKIN_VARIABLES) root.style.removeProperty(key);

  if (theme === 'custom' && customSkin) {
    root.dataset.theme = customSkin.baseTheme;
    for (const [key, value] of Object.entries(customSkin.variables)) {
      if (!SKIN_VARIABLES.includes(key as SkinVariable)) continue;
      // Re-validate here even though normalizeCustomSkin already ran at
      // import/save time — this is the call that actually reaches the DOM
      // (document.documentElement.style.setProperty), so it's the last place
      // a value like url(https://host/id) could slip through from a settings
      // file that was hand-edited or written by an older build.
      const safe = normalizeSkinVariableValue(key, value);
      if (safe) root.style.setProperty(key, safe);
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
