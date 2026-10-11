// How the sidebar is laid out for this person: which groups are collapsed,
// which items are hidden, and the order of the items inside each group. Kept in
// localStorage like the track table's columns. The sidebar's own list of groups
// and items stays in Sidebar.tsx; everything here works from ids, so a view
// added or dropped in a later version needs no migration (an id nobody lists
// is ignored, an item nobody has placed lands at the end of its group).
import { create } from 'zustand';

const STORAGE_KEY = 'newamp:sidebar-layout:v1';
export const SIDEBAR_LAYOUT_VERSION = 1;

/** Settings is how the rest of the app is reached, so it can never be hidden. */
export const SIDEBAR_PINNED_ITEMS: readonly string[] = ['settings'];

/** Starts collapsed until the library has a server or a podcast feed. */
export const SIDEBAR_STREAMING_GROUP = 'streaming';

export interface SidebarLayout {
  v: typeof SIDEBAR_LAYOUT_VERSION;
  /** Only what the person chose; a group missing here follows its default. */
  collapsed: Record<string, boolean>;
  hidden: string[];
  /** The order the person gave a group's items, for the groups they reordered. */
  order: Record<string, string[]>;
  /** A server or feed has been seen, so Streaming opens by default from now on. */
  streamingUsed: boolean;
}

// Ids are view ids and lower-cased group names. Anything else in saved data is
// junk, and this also keeps keys like __proto__ out of the maps.
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_HIDDEN = 64;
const MAX_GROUPS = 16;
const MAX_ITEMS_PER_GROUP = 32;

// A group id becomes a key of a plain object, so it must not be one the object already has (constructor, toString).
const isGroupKey = (key: string): boolean => ID_RE.test(key) && !(key in Object.prototype);

function cleanIds(input: unknown, limit: number): string[] {
  const out: string[] = [];
  for (const id of Array.isArray(input) ? input : []) {
    if (typeof id === 'string' && ID_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

export function defaultSidebarLayout(): SidebarLayout {
  return { v: SIDEBAR_LAYOUT_VERSION, collapsed: {}, hidden: [], order: {}, streamingUsed: false };
}

/** Saved input as a layout: wrong shapes, other versions and unknown ids give the default, or less of what was saved. */
export function normalizeSidebarLayout(input: unknown): SidebarLayout {
  if (!input || typeof input !== 'object') return defaultSidebarLayout();
  const raw = input as Record<string, unknown>;
  if (raw.v !== SIDEBAR_LAYOUT_VERSION) return defaultSidebarLayout();

  const collapsed: Record<string, boolean> = {};
  if (raw.collapsed && typeof raw.collapsed === 'object' && !Array.isArray(raw.collapsed)) {
    for (const [group, value] of Object.entries(raw.collapsed)) {
      if (isGroupKey(group) && typeof value === 'boolean' && Object.keys(collapsed).length < MAX_GROUPS) collapsed[group] = value;
    }
  }

  const order: Record<string, string[]> = {};
  if (raw.order && typeof raw.order === 'object' && !Array.isArray(raw.order)) {
    for (const [group, ids] of Object.entries(raw.order)) {
      if (!isGroupKey(group) || Object.keys(order).length >= MAX_GROUPS) continue;
      const kept = cleanIds(ids, MAX_ITEMS_PER_GROUP);
      if (kept.length) order[group] = kept;
    }
  }

  return {
    v: SIDEBAR_LAYOUT_VERSION,
    collapsed,
    hidden: cleanIds(raw.hidden, MAX_HIDDEN).filter((id) => !SIDEBAR_PINNED_ITEMS.includes(id)),
    order,
    streamingUsed: raw.streamingUsed === true,
  };
}

// ── what the sidebar draws ─────────────────────────────────────────────────

export interface SidebarCatalogGroup {
  id: string;
  items: readonly string[];
}

export interface ResolvedSidebarItem {
  id: string;
  hidden: boolean;
}

export interface ResolvedSidebarGroup {
  id: string;
  collapsed: boolean;
  /** Every item of the group in the person's order, hidden ones included (the customise menu lists them all). */
  items: ResolvedSidebarItem[];
}

/** The catalog's groups with the layout applied: item order, hidden marks, collapsed state. */
export function resolveSidebar(catalog: readonly SidebarCatalogGroup[], layout: SidebarLayout): ResolvedSidebarGroup[] {
  return catalog.map((group) => {
    const known = new Set(group.items);
    const preferred = (layout.order[group.id] ?? []).filter((id) => known.has(id));
    const ordered = [...new Set([...preferred, ...group.items])];
    const collapsed = layout.collapsed[group.id] ?? (group.id === SIDEBAR_STREAMING_GROUP && !layout.streamingUsed);
    return {
      id: group.id,
      collapsed,
      items: ordered.map((id) => ({ id, hidden: layout.hidden.includes(id) && !SIDEBAR_PINNED_ITEMS.includes(id) })),
    };
  });
}

/** Whether the group has anything to list. A group whose items are all hidden leaves no heading behind. */
export function sidebarGroupShown(group: ResolvedSidebarGroup, activeId: string | undefined): boolean {
  return group.items.some((item) => !item.hidden || item.id === activeId);
}

/**
 * The items to draw. The view you are on always shows, even when hidden or in a
 * collapsed group (it can be reached from Quick Play), so the sidebar never
 * loses track of where you are. Pinned items show in a collapsed group too.
 */
export function visibleSidebarItems(group: ResolvedSidebarGroup, activeId: string | undefined): ResolvedSidebarItem[] {
  return group.items.filter(
    (item) => item.id === activeId || SIDEBAR_PINNED_ITEMS.includes(item.id) || (!group.collapsed && !item.hidden),
  );
}

/** `order` with `id` moved `delta` places, stopping at the ends; unchanged when `id` is not in it. */
export function moveSidebarItem(order: readonly string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const to = Math.max(0, Math.min(order.length - 1, from + Math.trunc(delta)));
  const next = order.filter((entry) => entry !== id);
  next.splice(to, 0, id);
  return next;
}

/** The views where a music server, a podcast feed or a station is added. */
const STREAMING_VIEWS: readonly string[] = ['music-servers', 'podcasts', 'radio'];

export const isStreamingView = (view: string): boolean => STREAMING_VIEWS.includes(view);

/** Whether the library has a music server or a podcast feed. A failed lookup counts as none. */
export async function hasStreamingSources(source: {
  getMusicServers: () => Promise<readonly unknown[]>;
  listPodcastSubscriptions: () => Promise<readonly unknown[]>;
}): Promise<boolean> {
  const count = async (read: () => Promise<readonly unknown[]>): Promise<number> => {
    try {
      const list = await read();
      return Array.isArray(list) ? list.length : 0;
    } catch {
      return 0;
    }
  };
  const [servers, feeds] = await Promise.all([
    count(() => source.getMusicServers()),
    count(() => source.listPodcastSubscriptions()),
  ]);
  return servers > 0 || feeds > 0;
}

// ── the store ──────────────────────────────────────────────────────────────

function loadLayout(): SidebarLayout {
  if (typeof localStorage === 'undefined') return defaultSidebarLayout();
  try {
    return normalizeSidebarLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return defaultSidebarLayout();
  }
}

function saveLayout(layout: SidebarLayout): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* ignore storage failures */
  }
}

function snapshot(state: SidebarLayout): SidebarLayout {
  return { v: state.v, collapsed: state.collapsed, hidden: state.hidden, order: state.order, streamingUsed: state.streamingUsed };
}

interface SidebarLayoutState extends SidebarLayout {
  setCollapsed: (groupId: string, collapsed: boolean) => void;
  setHidden: (itemId: string, hidden: boolean) => void;
  /** Move `itemId` within `currentOrder`, the group's order as the sidebar shows it now. */
  moveItem: (groupId: string, currentOrder: readonly string[], itemId: string, delta: number) => void;
  markStreamingUsed: () => void;
  /** Back to the default layout. What the library holds (streamingUsed) is not a preference and stays. */
  reset: () => void;
}

export const useSidebarLayout = create<SidebarLayoutState>((set, get) => {
  function commit(patch: Partial<SidebarLayout>): void {
    const next = normalizeSidebarLayout({ ...snapshot(get()), ...patch });
    saveLayout(next);
    set(next);
  }
  return {
    ...loadLayout(),
    setCollapsed: (groupId, collapsed) => {
      if (!isGroupKey(groupId)) return;
      commit({ collapsed: { ...get().collapsed, [groupId]: collapsed } });
    },
    setHidden: (itemId, hidden) => {
      if (SIDEBAR_PINNED_ITEMS.includes(itemId) || !ID_RE.test(itemId)) return;
      const rest = get().hidden.filter((id) => id !== itemId);
      commit({ hidden: hidden ? [...rest, itemId] : rest });
    },
    moveItem: (groupId, currentOrder, itemId, delta) => {
      if (!isGroupKey(groupId)) return;
      commit({ order: { ...get().order, [groupId]: moveSidebarItem(currentOrder, itemId, delta) } });
    },
    markStreamingUsed: () => {
      if (!get().streamingUsed) commit({ streamingUsed: true });
    },
    reset: () => commit({ ...defaultSidebarLayout(), streamingUsed: get().streamingUsed }),
  };
});
