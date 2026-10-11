// The Skin Workshop's draft: the colours being edited, whether they differ from
// the saved skin, and the live preview on the page. It lives in a store, not in
// the Settings view, so the floating editor and the Workshop page are two views
// of one draft, edits survive moving between views, and they end only by being
// saved or discarded. The store takes its surroundings (the page, settings,
// the shelf) as `deps`, so it runs the same in a test as in the app.
import { create } from 'zustand';
import type { BuiltInTheme, CustomSkin, Theme } from '@shared/types';
import { SKIN_VARIABLES, normalizeSkinVariableValue } from '@shared/custom-skin';
import { NEUTRAL_TINT, followAccentLabel, transformSkin, type NamedColorResolver, type SkinTint } from '@shared/skin-color';
import { needsShelving } from './skin-shelf';

export const DEFAULT_SKIN_NAME = 'NewAmp Custom';
const NAME_LIMIT = 80;
const SKIN_VARIABLE_SET = new Set<string>(SKIN_VARIABLES);

export interface SkinDraftSettings {
  theme: Theme;
  customSkin?: CustomSkin | null;
}

export interface SkinDraftToast {
  tone?: 'info' | 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
}

export interface SkinDraftDeps {
  settings: () => SkinDraftSettings | null;
  /** The colours on the page right now, as the base theme and any custom skin paint them. */
  readCurrent: () => Record<string, string>;
  /** Put the draft on the page. `changed` is what moved since the last call: one variable can be set alone, many are applied together. */
  preview: (variables: Record<string, string>, changed: readonly string[]) => void;
  /** Put the saved skin back on the page. */
  restore: (settings: SkinDraftSettings) => void;
  save: (skin: CustomSkin) => Promise<void>;
  /** Keep a skin on the shelf; returns the name it was kept under. */
  shelve: (skin: CustomSkin) => string | null;
  /** Calls back when the saved theme or custom skin changes. */
  onSettingsChange: (listener: () => void) => () => void;
  /** Runs `run` once, soon (the next animation frame in the app). */
  schedule: (run: () => void) => void;
  notify: (toast: SkinDraftToast) => void;
  resolveNamed?: NamedColorResolver;
  now: () => number;
}

export interface SkinDraftState {
  /** A session is open: `draft` and `baseline` mean something. */
  active: boolean;
  name: string;
  baseTheme: BuiltInTheme;
  /** What the fields hold, half-typed values included. */
  draft: Record<string, string>;
  /** What the session started from, and what a discard returns to. */
  baseline: Record<string, string>;
  baselineName: string;
  /** The session started on the saved custom skin, so saving edits that skin rather than replacing another. */
  editingCustom: boolean;
  dirty: boolean;
  tint: SkinTint;
  /** Counts previews put on the page, so a reader of the page's colours knows when to look again. */
  previewRev: number;
  /** Counts saves. */
  savedRev: number;
  begin: () => void;
  setVar: (key: string, value: string) => void;
  setName: (name: string) => void;
  setTint: (tint: Partial<SkinTint>) => void;
  resetTint: () => void;
  /** Put the saved skin back on the page and end the session. */
  discard: () => void;
  save: () => Promise<CustomSkin | null>;
  /** The skin the draft would save, or null with no session. */
  buildSkin: () => CustomSkin | null;
}

const text = (value: string | undefined): string => (value ?? '').trim();

export interface SkinSaveOutcome {
  skin: CustomSkin | null;
  /** Why the save failed, in words for the editor's footer. */
  error: string | null;
}

/** Runs a save and reports how it went; a failure comes back as a message instead of a throw. */
export async function runSkinSave(save: () => Promise<CustomSkin | null>): Promise<SkinSaveOutcome> {
  try {
    return { skin: await save(), error: null };
  } catch (error) {
    return { skin: null, error: error instanceof Error && error.message ? error.message : 'Could not save the skin.' };
  }
}

export interface EditorFooterStatus {
  text: string;
  tone: 'error' | 'dirty' | 'ok';
}

/** What the editor's footer says. A failed save comes before everything: unsaved changes are the reason it matters. */
export function editorFooterStatus(input: { dirty: boolean; error: string | null; saved: string | null }): EditorFooterStatus {
  if (input.error) return { text: `Not saved: ${input.error}`, tone: 'error' };
  if (input.dirty) return { text: 'Unsaved changes', tone: 'dirty' };
  return { text: input.saved ?? 'Matches the saved skin', tone: 'ok' };
}

export function pickSkinVariables(source: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SKIN_VARIABLES) {
    const value = text(source[key]);
    if (value) out[key] = value;
  }
  return out;
}

export function skinDraftIsDirty(
  draft: Record<string, string>,
  baseline: Record<string, string>,
  name: string,
  baselineName: string,
): boolean {
  if (name.trim() !== baselineName.trim()) return true;
  return SKIN_VARIABLES.some((key) => text(draft[key]) !== text(baseline[key]));
}

/** Changes whenever the saved theme or the saved custom skin does. */
export function skinSettingsKey(settings: SkinDraftSettings): string {
  const skin = settings.customSkin;
  return `${settings.theme}|${skin ? `${skin.name}|${skin.updatedAt}` : ''}`;
}

function baseThemeOf(settings: SkinDraftSettings): BuiltInTheme {
  if (settings.theme !== 'custom') return settings.theme;
  return settings.customSkin?.baseTheme ?? 'classic';
}

const clampTint = (tint: SkinTint): SkinTint => ({
  hue: Math.max(-360, Math.min(360, Number.isFinite(tint.hue) ? tint.hue : 0)),
  sat: Math.max(0, Math.min(2, Number.isFinite(tint.sat) ? tint.sat : 1)),
  light: Math.max(0, Math.min(2, Number.isFinite(tint.light) ? tint.light : 1)),
});

export function createSkinDraftStore(deps: SkinDraftDeps) {
  // The baseline a tint is computed from; null until a slider moves after the last other edit.
  let tintBase: Record<string, string> | null = null;
  // The last value of each variable the page accepted: a half-typed value keeps the colour already on screen.
  let applied: Record<string, string> = {};
  // Variables edited since the last preview reached the page.
  const pending = new Set<string>();
  // The last accent the draft held that the skin grammar accepts: the label
  // colour follows from it, and a half-typed accent must not lose its place.
  let lastAccent: string | null = null;
  let generation = 0;
  let flushQueued = false;
  let saving = false;
  let sessionKey = '';
  let watching = false;

  const store = create<SkinDraftState>((set, get) => {
    function invalidate(): void {
      generation += 1;
      flushQueued = false;
    }

    function endSession(): void {
      invalidate();
      tintBase = null;
      applied = {};
      lastAccent = null;
      pending.clear();
      set({ active: false, draft: {}, baseline: {}, dirty: false, tint: NEUTRAL_TINT });
    }

    function acceptedDraft(): Record<string, string> {
      const { draft, baseline } = get();
      const out: Record<string, string> = {};
      for (const key of SKIN_VARIABLES) {
        const value = normalizeSkinVariableValue(key, draft[key]) ?? applied[key] ?? baseline[key];
        if (value) out[key] = value;
      }
      return out;
    }

    function schedulePreview(): void {
      if (flushQueued) return;
      flushQueued = true;
      const ticket = generation;
      deps.schedule(() => {
        if (ticket !== generation) return;
        flushQueued = false;
        if (!get().active) return;
        applied = acceptedDraft();
        const changed = [...pending];
        pending.clear();
        deps.preview(applied, changed);
        set((state) => ({ previewRev: state.previewRev + 1 }));
      });
    }

    // Something else repainted the page (the saved skin applied again): put the
    // whole draft back on it. Naming every variable sends it down the
    // whole-draft path rather than the single-variable one.
    function repaintDraft(): void {
      for (const key of SKIN_VARIABLES) if (text(get().draft[key])) pending.add(key);
      schedulePreview();
    }

    function acceptedAccent(draft: Record<string, string>): string | null {
      return normalizeSkinVariableValue('--accent', draft['--accent']) ?? null;
    }

    function draftSkin(nameSuffix = ''): CustomSkin {
      const state = get();
      const base = state.name.trim().slice(0, NAME_LIMIT) || DEFAULT_SKIN_NAME;
      return {
        name: `${base.slice(0, NAME_LIMIT - nameSuffix.length)}${nameSuffix}`,
        baseTheme: state.baseTheme,
        variables: acceptedDraft(),
        updatedAt: deps.now(),
      };
    }

    // The theme or custom skin changed under an open session: a card in
    // Settings, skin surf, a dropped file. The session cannot describe the new
    // page, so it ends; edits not yet saved go on the shelf rather than vanish.
    function onSettingsChange(): void {
      if (!get().active || saving) return;
      const settings = deps.settings();
      if (!settings) return;
      // The same skin saved again, or the same theme chosen again: the page was
      // repainted from the saved skin, which wipes edits that are not saved.
      if (skinSettingsKey(settings) === sessionKey) {
        if (get().dirty) repaintDraft();
        return;
      }
      if (get().dirty) {
        const kept = deps.shelve(draftSkin(' (unsaved)'));
        deps.notify({
          tone: 'warn',
          title: 'Skin changed',
          detail: kept ? `Your unsaved colour edits are saved as ${kept} under Previous skins.` : 'Your unsaved colour edits were dropped.',
        });
      }
      endSession();
    }

    return {
      active: false,
      name: DEFAULT_SKIN_NAME,
      baseTheme: 'classic',
      draft: {},
      baseline: {},
      baselineName: DEFAULT_SKIN_NAME,
      editingCustom: false,
      dirty: false,
      tint: NEUTRAL_TINT,
      previewRev: 0,
      savedRev: 0,

      begin: () => {
        if (get().active) return;
        const settings = deps.settings();
        if (!settings) return;
        const custom = settings.theme === 'custom' ? settings.customSkin ?? null : null;
        const baseline = pickSkinVariables({ ...deps.readCurrent(), ...(custom?.variables ?? {}) });
        const name = settings.customSkin?.name ?? DEFAULT_SKIN_NAME;
        invalidate();
        tintBase = null;
        applied = { ...baseline };
        lastAccent = acceptedAccent(baseline);
        pending.clear();
        sessionKey = skinSettingsKey(settings);
        if (!watching) {
          watching = true;
          deps.onSettingsChange(onSettingsChange);
        }
        set({
          active: true,
          name,
          baselineName: name,
          baseTheme: baseThemeOf(settings),
          draft: { ...baseline },
          baseline,
          editingCustom: !!custom,
          dirty: false,
          tint: NEUTRAL_TINT,
        });
      },

      setVar: (key, value) => {
        if (!get().active) get().begin();
        const state = get();
        if (!state.active || !SKIN_VARIABLE_SET.has(key)) return;
        const draft = { ...state.draft, [key]: value };
        // The text on the accent follows the accent while it is the automatic
        // black or white, so a pressed button stays readable as the colour moves.
        if (key === '--accent') {
          const accent = acceptedAccent(draft);
          if (accent) {
            const label = followAccentLabel(draft['--on-accent'], lastAccent ?? undefined, accent, deps.resolveNamed);
            if (label) draft['--on-accent'] = label;
            lastAccent = accent;
          }
        }
        tintBase = null;
        set({ draft, tint: NEUTRAL_TINT, dirty: skinDraftIsDirty(draft, state.baseline, state.name, state.baselineName) });
        // Preview only what the skin grammar accepts; a half-typed or
        // unsupported value stays in the field without reaching the page.
        if (normalizeSkinVariableValue(key, value) !== null) {
          pending.add(key);
          schedulePreview();
        }
      },

      setName: (name) => {
        if (!get().active) get().begin();
        const state = get();
        if (!state.active) return;
        set({ name, dirty: skinDraftIsDirty(state.draft, state.baseline, name, state.baselineName) });
      },

      setTint: (partial) => {
        if (!get().active) get().begin();
        const state = get();
        if (!state.active) return;
        const tint = clampTint({ ...state.tint, ...partial });
        tintBase ??= { ...state.draft };
        const tinted = transformSkin(tintBase, tint, { resolveNamed: deps.resolveNamed });
        const draft = { ...state.draft, ...tinted };
        lastAccent = acceptedAccent(draft) ?? lastAccent;
        set({ tint, draft, dirty: skinDraftIsDirty(draft, state.baseline, state.name, state.baselineName) });
        for (const key of Object.keys(tinted)) pending.add(key);
        schedulePreview();
      },

      resetTint: () => {
        get().setTint(NEUTRAL_TINT);
        tintBase = null;
      },

      discard: () => {
        const settings = deps.settings();
        if (settings) deps.restore(settings);
        endSession();
      },

      buildSkin: () => (get().active ? draftSkin() : null),

      save: async () => {
        const state = get();
        if (!state.active) return null;
        const skin = draftSkin();
        const previous = deps.settings()?.customSkin ?? null;
        // Any edit replaces these objects, so an unchanged pair means nothing moved during the save.
        const { draft: draftAtSave, name: nameAtSave } = state;
        saving = true;
        try {
          await deps.save(skin);
        } finally {
          saving = false;
        }
        // The skin it replaced is only kept once the replacement is saved: a
        // failed save leaves the old one in place and nothing on the shelf.
        if (previous && needsShelving(previous, skin, state.editingCustom)) deps.shelve(previous);
        const after = deps.settings();
        if (after) sessionKey = skinSettingsKey(after);
        const now = get();
        if (!now.active) {
          // Discarded while the save was in flight; the saved skin stands.
          set({ savedRev: now.savedRev + 1 });
          return skin;
        }
        if (now.draft !== draftAtSave || now.name !== nameAtSave) {
          // Edits made while the save was in flight are not in the saved skin.
          // Keep them as unsaved changes on top of it, and put them back on the
          // page, which the save has just repainted from the saved skin.
          set({
            baseTheme: skin.baseTheme,
            baseline: { ...skin.variables },
            baselineName: skin.name,
            editingCustom: true,
            dirty: skinDraftIsDirty(now.draft, skin.variables, now.name, skin.name),
            savedRev: now.savedRev + 1,
          });
          invalidate();
          repaintDraft();
          return skin;
        }
        // Start over from what was saved.
        invalidate();
        tintBase = null;
        applied = { ...skin.variables };
        lastAccent = acceptedAccent(skin.variables);
        pending.clear();
        set((current) => ({
          name: skin.name,
          baselineName: skin.name,
          baseTheme: skin.baseTheme,
          draft: { ...skin.variables },
          baseline: { ...skin.variables },
          editingCustom: true,
          dirty: false,
          tint: NEUTRAL_TINT,
          savedRev: current.savedRev + 1,
        }));
        return skin;
      },
    };
  });

  return store;
}
