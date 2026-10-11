// A small shelf for custom skins that something else was about to replace.
// Settings holds one custom skin; importing, dropping or saving over it used to
// lose it. The replaced skin goes here instead, under its own name, and the
// Skin Workshop lists the shelf so any of them can be brought back.
import type { CustomSkin } from '@shared/types';
import { SKIN_VARIABLES, normalizeCustomSkin } from '@shared/custom-skin';

const STORAGE_KEY = 'newamp:skin-shelf:v1';
const NAME_LIMIT = 80;
export const SKIN_SHELF_LIMIT = 8;

type ShelfStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ShelfStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const compact = (value: string | undefined): string => (value ?? '').toLowerCase().replace(/\s+/g, '');

/** Whether two skins paint the same colours, whatever they are called. */
export function sameSkinColours(a: Record<string, string>, b: Record<string, string>): boolean {
  return SKIN_VARIABLES.every((key) => compact(a[key]) === compact(b[key]));
}

/** The name, or the name with a number after it when the shelf already has that one. */
export function uniqueShelfName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, NAME_LIMIT - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** The valid skins in saved input, newest first, one per name, at most SKIN_SHELF_LIMIT. */
export function normalizeSkinShelf(input: unknown): CustomSkin[] {
  const record = input && typeof input === 'object' ? (input as { v?: unknown; skins?: unknown }) : {};
  if (record.v !== 1 || !Array.isArray(record.skins)) return [];
  const skins: CustomSkin[] = [];
  for (const entry of record.skins) {
    const skin = normalizeCustomSkin(entry);
    if (!skin || skins.some((kept) => kept.name.toLowerCase() === skin.name.toLowerCase())) continue;
    skins.push(skin);
    if (skins.length >= SKIN_SHELF_LIMIT) break;
  }
  return skins;
}

/** `shelf` with `skin` put first. The same skin again just moves to the front; a different one under a taken name gets a number. */
export function shelveSkin(shelf: readonly CustomSkin[], skin: CustomSkin): CustomSkin[] {
  const clean = normalizeCustomSkin(skin);
  if (!clean) return [...shelf];
  const twin = shelf.find((entry) => entry.name.toLowerCase() === clean.name.toLowerCase() && sameSkinColours(entry.variables, clean.variables));
  if (twin) return [twin, ...shelf.filter((entry) => entry !== twin)];
  const name = uniqueShelfName(clean.name, shelf.map((entry) => entry.name));
  return [{ ...clean, name }, ...shelf].slice(0, SKIN_SHELF_LIMIT);
}

export function unshelveSkin(shelf: readonly CustomSkin[], name: string): CustomSkin[] {
  return shelf.filter((entry) => entry.name !== name);
}

/**
 * Whether saving `next` over `previous` would lose `previous`. Editing the same
 * skin in place does not; importing another one, or saving the edits under a
 * new name, does. A skin that paints the same colours loses nothing.
 */
export function needsShelving(previous: CustomSkin | null | undefined, next: CustomSkin, editedInPlace: boolean): boolean {
  if (!previous) return false;
  if (sameSkinColours(previous.variables, next.variables)) return false;
  return !(editedInPlace && previous.name === next.name);
}

// ── storage and subscription ───────────────────────────────────────────────

let cache: CustomSkin[] | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function loadSkinShelf(storage: ShelfStorage | null = defaultStorage()): CustomSkin[] {
  if (!storage) return [];
  try {
    return normalizeSkinShelf(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return [];
  }
}

function writeSkinShelf(skins: CustomSkin[], storage: ShelfStorage | null): void {
  cache = skins;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ v: 1, skins }));
  } catch {
    /* the shelf is a convenience; a full or blocked store loses it, not the skin */
  }
  emit();
}

/** The shelf as last read or written; the same array until it changes (for useSyncExternalStore). */
export function getSkinShelf(): readonly CustomSkin[] {
  cache ??= loadSkinShelf();
  return cache;
}

export function subscribeSkinShelf(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Puts a skin on the shelf; returns the name it is kept under (a numbered one if its own was taken). */
export function shelfSkin(skin: CustomSkin, storage: ShelfStorage | null = defaultStorage()): string | null {
  const next = shelveSkin(loadSkinShelf(storage), skin);
  writeSkinShelf(next, storage);
  return normalizeCustomSkin(skin) ? next[0]?.name ?? null : null;
}

export function removeFromShelf(name: string, storage: ShelfStorage | null = defaultStorage()): void {
  writeSkinShelf(unshelveSkin(loadSkinShelf(storage), name), storage);
}

// ── replacing the custom skin without losing it ────────────────────────────

export interface KeepPreviousDeps {
  current: () => CustomSkin | null | undefined;
  save: (skin: CustomSkin) => Promise<void>;
  shelve: (skin: CustomSkin) => string | null;
  unshelve: (name: string) => void;
  notify: (toast: { title: string; detail: string; action: { label: string; onClick: () => void } }) => void;
}

/**
 * Saves `skin` as the custom skin. When that replaces another one, the old one
 * goes on the shelf once the save has gone through, and a toast offers to undo.
 * An import or a drop never overwrites a hand-built skin silently. `fromShelf`
 * marks a skin taken off the shelf: it leaves the shelf, and comes back if the
 * apply is undone.
 */
export async function applySkinKeepingPrevious(
  skin: CustomSkin,
  deps: KeepPreviousDeps,
  options: { fromShelf?: boolean } = {},
): Promise<CustomSkin | null> {
  const previous = deps.current() ?? null;
  const keep = needsShelving(previous, skin, false) ? previous : null;
  await deps.save(skin);
  const shelvedAs = keep ? deps.shelve(keep) : null;
  if (options.fromShelf) deps.unshelve(skin.name);
  if (!keep || !shelvedAs) return null;
  deps.notify({
    title: `Applied ${skin.name}`,
    detail: `${shelvedAs} is saved under Previous skins in the Skin Workshop.`,
    action: {
      label: 'Undo',
      onClick: () => {
        void deps.save(keep).then(() => {
          deps.unshelve(shelvedAs);
          if (options.fromShelf) deps.shelve(skin);
        });
      },
    },
  });
  return keep;
}
