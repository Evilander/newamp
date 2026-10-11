// The Skin Workshop draft as an app-wide store: one draft behind the Settings
// page and the floating colour editor. The logic is in lib/skin-draft.ts; this
// file hands it the real page, settings and shelf.
import { createSkinDraftStore } from '../lib/skin-draft';
import { applyTheme, previewSkinDraft, previewSkinVariable, readCurrentSkinVariables, resolveCssColor } from '../lib/skins';
import { shelfSkin } from '../lib/skin-shelf';
import { pushToast } from '../lib/toast';
import { usePlayerStore } from './usePlayerStore';

export type { SkinDraftState } from '../lib/skin-draft';

export const useSkinDraft = createSkinDraftStore({
  settings: () => usePlayerStore.getState().settings,
  readCurrent: readCurrentSkinVariables,
  // One edited variable is set on its own; a tint or a restored draft moves many, so the lot is applied together.
  preview: (variables, changed) => {
    const [key] = changed;
    if (changed.length === 1 && key && variables[key]) previewSkinVariable(variables, key, variables[key]);
    else previewSkinDraft(variables);
  },
  restore: (settings) => applyTheme(settings.theme, settings.customSkin),
  save: (skin) => usePlayerStore.getState().saveCustomSkin(skin),
  shelve: (skin) => shelfSkin(skin),
  // Any new settings object, not only a new theme: choosing the same skin again
  // applies it to the page too, which wipes edits that are not saved. The draft
  // decides whether the skin really changed.
  onSettingsChange: (listener) =>
    usePlayerStore.subscribe((state, previous) => {
      if (state.settings !== previous.settings) listener();
    }),
  schedule: (run) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
    else window.setTimeout(run, 16);
  },
  notify: (toast) => pushToast({ durationMs: 7000, ...toast }),
  resolveNamed: resolveCssColor,
  now: () => Date.now(),
});
