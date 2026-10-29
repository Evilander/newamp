// Input rules for the fullscreen visualizer: which key means what, which
// click targets count as the bare stage, where a pointer-anchored menu lands
// and where focus goes when a popover closes. No React and no DOM globals, so
// scripts/visualizer-input-test.mjs can run it directly.
import type { VizPerformance, VizQuality } from './Visualizer';

export type VisualizerKeyAction =
  | 'preset-next'
  | 'preset-previous'
  | 'quality'
  | 'art'
  | 'chrome'
  | 'palette'
  | 'reactivity'
  | 'replay-clip'
  | 'lite'
  | 'auto-vj'
  | 'native-fullscreen'
  | 'help'
  | 'escape';

export interface VisualizerKeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** AltGr is down (`getModifierState('AltGraph')`). Windows reports it as Ctrl and Alt together. */
  altGraph?: boolean;
  /** Focus is on a slider or inside a menu: it steps with the arrow keys itself. */
  arrowsOwned?: boolean;
}

/**
 * The visualizer's own keys. Anything with Ctrl, Cmd or Alt held belongs to the
 * app (track skip, search, the OS), and plain L and V stay with the app-wide
 * map (love, stop), so Lite and Auto-VJ sit on Shift. AltGr is how many layouts
 * type [ and ], so a character it typed counts as unmodified. On a Mac the same
 * layouts type them with Option, which reports no AltGraph; the bracket itself
 * is what shows it was typed (Option with a letter makes a symbol that matches
 * nothing here).
 */
export function resolveVisualizerKey(input: VisualizerKeyInput): VisualizerKeyAction | null {
  const { key } = input;
  const typedWithAltGr = input.altGraph === true && key.length === 1;
  const typedWithOption = !!input.altKey && !input.ctrlKey && (key === '[' || key === ']');
  if (input.metaKey || (!typedWithAltGr && !typedWithOption && (input.ctrlKey || input.altKey))) return null;
  if (key === 'ArrowRight') return input.arrowsOwned ? null : 'preset-next';
  if (key === 'ArrowLeft') return input.arrowsOwned ? null : 'preset-previous';
  if (key === ']') return 'preset-next';
  if (key === '[') return 'preset-previous';
  if (key === 'Escape') return 'escape';
  if (key === '?') return 'help';
  switch (key.toLowerCase()) {
    case 'q': return 'quality';
    case 'a': return 'art';
    case 'h': return 'chrome';
    case 'p': return 'palette';
    case 'f': return 'native-fullscreen';
    case 'r': return input.shiftKey ? 'replay-clip' : 'reactivity';
    case 'l': return input.shiftKey ? 'lite' : null;
    case 'v': return input.shiftKey ? 'auto-vj' : null;
    default: return null;
  }
}

/** Holding the key down keeps stepping presets; every other action fires once per press. */
export function isRepeatableVisualizerAction(action: VisualizerKeyAction): boolean {
  return action === 'preset-next' || action === 'preset-previous';
}

interface ClosestLike {
  closest(selector: string): unknown;
}

function hasClosest(target: unknown): target is ClosestLike {
  return typeof target === 'object' && target !== null && typeof (target as ClosestLike).closest === 'function';
}

const CONTROL_SELECTOR = 'button, input, select, textarea, a, [role="dialog"], [role="menu"]';
const CHROME_SELECTOR = [
  CONTROL_SELECTOR,
  '[data-newamp-visualizer-toolbar]',
  '[data-newamp-viz-now]',
  '[data-newamp-viz-hover-meter]',
  '[data-newamp-viz-popover-backdrop]',
  '[data-newamp-viz-menu-backdrop]',
].join(', ');

/** True only for the bare stage: a double-click there toggles OS fullscreen, on any control it must not. */
export function isStageTarget(target: unknown): boolean {
  return hasClosest(target) && !target.closest(CHROME_SELECTOR);
}

/** The visualizer menu opens on a right-click anywhere but on a control. */
export function opensVisualizerMenu(target: unknown): boolean {
  return !hasClosest(target) || !target.closest(CONTROL_SELECTOR);
}

export function isInsideMenu(target: unknown): boolean {
  return hasClosest(target) && !!target.closest('[role="menu"]');
}

export type KeyTargetKind = 'text' | 'slider' | 'other';

const NON_TEXT_INPUT_TYPES = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'color', 'file']);

interface InputLike extends ClosestLike {
  type?: string;
  getAttribute?(name: string): string | null;
}

/**
 * What a key event's target does with keys. Text fields and selects take every
 * key, a slider takes the arrows, and everything else leaves the keys to us.
 * A floating panel over the stage (the colour editor) takes its own keys too,
 * so its buttons and sliders never step the presets behind it.
 */
export function keyTargetKind(target: unknown): KeyTargetKind {
  if (!hasClosest(target)) return 'other';
  if (target.closest('textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [data-newamp-floating-panel]')) return 'text';
  const input = target.closest('input') as InputLike | null;
  if (!input) return 'other';
  const type = (input.type ?? input.getAttribute?.('type') ?? 'text').toLowerCase();
  if (type === 'range') return 'slider';
  return NON_TEXT_INPUT_TYPES.has(type) ? 'other' : 'text';
}

interface NodeLike {
  nodeType?: unknown;
}

interface Container {
  contains(node: unknown): boolean;
}

/**
 * Whether a key event is aimed at the stage: something inside it, or the page
 * itself when nothing has focus. An overlay stacked above the stage is neither.
 */
export function keyTargetInStage(target: unknown, stage: Container | null, page: readonly unknown[]): boolean {
  const isNode = typeof target === 'object' && target !== null && typeof (target as NodeLike).nodeType === 'number';
  return !isNode || page.includes(target) || !!stage?.contains(target);
}

/**
 * Whether the visualizer takes a key it has an action for. A text field takes
 * every key, except Esc from inside the stage (the seed boxes in the settings
 * panel), which still closes the panel. An overlay stacked above the stage
 * keeps its own Esc.
 */
export function visualizerTakesKey(action: VisualizerKeyAction, kind: KeyTargetKind, inStage: boolean): boolean {
  return action === 'escape' ? inStage : kind !== 'text';
}

export interface RenderMode {
  tier: VizPerformance;
  quality: VizQuality;
}

/** Lite on or off. Lite always renders at auto quality, and leaving it keeps whatever quality was set. */
export function toggleLite(mode: RenderMode): RenderMode {
  return mode.tier === 'low' ? { tier: 'balanced', quality: mode.quality } : { tier: 'low', quality: 'auto' };
}

/** 4K on or off. Not available while Lite is on. */
export function toggleFourK(mode: RenderMode): RenderMode {
  if (mode.tier === 'low') return mode;
  return { tier: mode.tier, quality: mode.quality === '4k' ? 'auto' : '4k' };
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function placeAxis(anchor: number, length: number, room: number, margin: number): number {
  const start = anchor + length + margin > room ? anchor - length : anchor;
  return Math.max(margin, Math.min(start, room - length - margin));
}

/** Top-left for a menu opened at a point: at the pointer, flipped across it when it would overflow, then clamped on screen. */
export function placeMenu(at: Point, size: Size, viewport: Size, margin = 8): { left: number; top: number } {
  return {
    left: placeAxis(at.x, size.width, viewport.width, margin),
    top: placeAxis(at.y, size.height, viewport.height, margin),
  };
}

const SUBMENU_OVERLAP = 2;

/** Top-left for a submenu hanging off an item: beside it on whichever side has room, top-aligned, clamped on screen. */
export function placeSubmenu(parent: Box, size: Size, viewport: Size, margin = 8): { left: number; top: number } {
  const roomRight = viewport.width - parent.right - margin;
  const roomLeft = parent.left - margin;
  const onRight = size.width <= roomRight || (size.width > roomLeft && roomRight >= roomLeft);
  const start = onRight ? parent.right - SUBMENU_OVERLAP : parent.left - size.width + SUBMENU_OVERLAP;
  return {
    left: Math.max(margin, Math.min(start, viewport.width - size.width - margin)),
    top: Math.max(margin, Math.min(parent.top - 4, viewport.height - size.height - margin)),
  };
}

/** Next enabled item for an arrow, Home or End key, wrapping at the ends. -1 when nothing can take focus. */
export function stepMenuIndex(
  enabled: readonly boolean[],
  current: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number {
  if (!enabled.some(Boolean)) return -1;
  if (key === 'Home') return enabled.indexOf(true);
  if (key === 'End') return enabled.lastIndexOf(true);
  const step = key === 'ArrowDown' ? 1 : -1;
  const count = enabled.length;
  let index = current;
  for (let tries = 0; tries < count; tries += 1) {
    index = index < 0 ? (step > 0 ? 0 : count - 1) : (index + step + count) % count;
    if (enabled[index]) return index;
  }
  return -1;
}

export interface LookState {
  /** The active mode is an Eviland one, so the Director is what moves its look. */
  eviland: boolean;
  director: boolean;
  autoVj: boolean;
}

/** A look is locked when nothing is going to change it on its own. */
export function isLookLocked(state: LookState): boolean {
  return !state.autoVj && !(state.eviland && state.director);
}

/**
 * Lock holds the look by switching off whatever changes it (Auto-VJ, and the
 * Director on the Eviland modes); unlock turns back on the one that fits the
 * mode. The Director is left alone off the Eviland modes so it is not found
 * switched off the next time one is chosen.
 */
export function toggleLookLock(state: LookState): { director: boolean; autoVj: boolean } {
  if (isLookLocked(state)) {
    return state.eviland ? { director: true, autoVj: state.autoVj } : { director: state.director, autoVj: true };
  }
  return { director: state.eviland ? false : state.director, autoVj: false };
}

/** A uniformly random id other than the current one. */
export function pickRandomPreset<T extends string>(ids: readonly T[], current: T, random: () => number = Math.random): T {
  const others = ids.filter((id) => id !== current);
  if (!others.length) return current;
  return others[Math.min(others.length - 1, Math.floor(random() * others.length))]!;
}

/**
 * A held arrow steps from the preset last asked for, not the stored one. The
 * settings write answers with the value it was sent, and that answer can land
 * after a newer pick and roll the store back a step. Once the window has
 * passed, the stored value is the truth again.
 */
export const PRESET_ECHO_WINDOW_MS = 1500;

export function presetStepBase<T>(
  last: { id: T; at: number } | null,
  now: number,
  stored: T,
  windowMs: number = PRESET_ECHO_WINDOW_MS,
): T {
  return last && now - last.at < windowMs ? last.id : stored;
}

/**
 * Whether the window should be put back into OS fullscreen when the visualizer
 * closes: the state it was in when the visualizer opened. Deck mode is never
 * fullscreen, and the opening state is not known if the visualizer is closed
 * before the first answer arrives. Popping out to the projector always leaves
 * fullscreen, or on one monitor the projector opens behind the window.
 */
export function fullscreenToRestore(opening: boolean | null, deckMode: boolean, toProjector = false): boolean | null {
  if (toProjector) return false;
  if (opening === null) return null;
  return deckMode ? false : opening;
}

export interface WindowFullscreenControl {
  isFullscreen(): Promise<boolean>;
  setFullscreen(on: boolean): Promise<void>;
}

let fullscreenChain: Promise<void> = Promise.resolve();

/**
 * Puts the window in the given OS fullscreen state, and does nothing when it
 * is already there. Asking a windowed Windows window to leave fullscreen is not
 * a no-op: the main window is transparent, and for those Electron answers
 * setFullScreen(false) by resizing to a restore rectangle it only records on the
 * way in. Without one the window drops to its minimum size at the top-left
 * corner, and that size is then saved as the window's normal bounds. Calls run
 * one after another so a leave right behind an enter sees the state the enter
 * produced.
 */
export function setWindowFullscreen(target: boolean, win: WindowFullscreenControl): Promise<void> {
  const run = async (): Promise<void> => {
    if ((await win.isFullscreen()) === target) return;
    await win.setFullscreen(target);
  };
  const done = fullscreenChain.then(run, run);
  fullscreenChain = done.catch(() => undefined);
  return done;
}

/** A list that scrolls keeps the wheel; the stage behind it would turn it into a volume change. */
export function scrollKeepsWheel(box: { scrollHeight: number; clientHeight: number }): boolean {
  return box.scrollHeight - box.clientHeight > 1;
}

interface FocusVisibleNode {
  matches(selector: string): boolean;
}

/**
 * The control to give focus back to when a popover or the stage closes, or
 * null. Only one the keyboard focused qualifies: a mouse press focuses a button
 * too, and returning to it would make the next Space press it again instead of
 * pausing.
 */
export function keyboardOpener<T extends FocusVisibleNode>(active: T | null, body: unknown): T | null {
  if (!active || active === body) return null;
  try {
    return active.matches(':focus-visible') ? active : null;
  } catch {
    return null;
  }
}

interface FocusNode {
  isConnected: boolean;
  focus(): void;
}

/**
 * Where focus goes when a popover closes: back to what had it when the
 * popover opened, else the fallback. Null when focus has since moved on to
 * something outside the popover, which a click on another control does.
 */
export function pickFocusRestoreTarget<T extends FocusNode>(input: {
  opener: T | null;
  active: unknown;
  body: unknown;
  panel: Container;
  fallback: T | null;
}): T | null {
  const { opener, active, body, panel, fallback } = input;
  const lost = !active || active === body;
  if (!lost && !panel.contains(active)) return null;
  if (opener?.isConnected && !panel.contains(opener)) return opener;
  return fallback?.isConnected ? fallback : null;
}
