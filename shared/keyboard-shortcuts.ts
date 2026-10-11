export type PlayerShortcutCommand =
  | 'toggle-play'
  | 'play'
  | 'pause'
  | 'stop'
  | 'previous'
  | 'next'
  | 'seek-backward'
  | 'seek-forward'
  | 'volume-up'
  | 'volume-down'
  | 'toggle-love'
  | 'rate-0'
  | 'rate-1'
  | 'rate-2'
  | 'rate-3'
  | 'rate-4'
  | 'rate-5'
  | 'toggle-fullscreen-visualizer'
  | 'exit-fullscreen-visualizer'
  | 'cycle-skin';

export interface PlayerShortcutInput {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  targetEditable?: boolean;
  /**
   * Focus is on a <button> or role="button" element — the browser (native
   * buttons) or the element's own onKeyDown (custom role="button" rows, used
   * throughout the track lists) already turns Space into a click on that
   * element. Letting the global toggle-play shortcut also resolve on the
   * same keydown double-fires: a focused track row both starts its track
   * AND immediately toggles playback of whatever just started.
   */
  targetIsButton?: boolean;
  /**
   * Focus is on a control that steps with the arrow keys: a range slider or a
   * radio group. Plain arrows (and Home/End/Page keys) stay with it; every
   * other key, Space included, still reaches the shortcut map. Without this a
   * click on the seek bar or the volume slider silenced the whole map until
   * focus moved somewhere else.
   */
  targetIsSlider?: boolean;
  fullscreenVisualizer?: boolean;
  /**
   * `process.platform` of the host. Only `darwin` changes anything: Cmd, not
   * Ctrl, is the transport modifier there (Ctrl+Left/Right is Mission
   * Control's Spaces switcher), and Meta chords are ours to read.
   */
  platform?: string;
}

export function resolvePlayerShortcut(input: PlayerShortcutInput): PlayerShortcutCommand | null {
  if (input.targetEditable || input.altKey) return null;
  const mac = input.platform === 'darwin';
  // Off a Mac, Meta is the OS key (Win+arrows snap windows) and never ours.
  if (input.metaKey && !mac) return null;

  const code = input.code ?? '';
  const key = (input.key ?? '').toLowerCase();
  const isSpace = code === 'Space' || key === ' ';
  if (isSpace && input.targetIsButton) return null;
  const chord = !!(input.ctrlKey || input.metaKey);
  if (!chord && input.targetIsSlider && isSliderKey(code, key)) return null;
  const command = chord
    ? resolveChordShortcut(code, mac && !!input.metaKey)
    : resolveUnmodifiedShortcut(code, key, !!input.shiftKey, !!input.fullscreenVisualizer);

  if (!command) return null;
  if (input.repeat && !isRepeatableShortcut(command)) return null;
  return command;
}

const SLIDER_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown']);

function isSliderKey(code: string, key: string): boolean {
  return SLIDER_KEYS.has(code.toLowerCase()) || SLIDER_KEYS.has(key);
}

function resolveChordShortcut(code: string, command: boolean): PlayerShortcutCommand | null {
  if (code === 'ArrowLeft') return 'previous';
  if (code === 'ArrowRight') return 'next';
  // Music.app keeps volume on Cmd+Up/Down. Ctrl+Up/Down is Mission Control on
  // a Mac and plain Up/Down already covers volume everywhere else.
  if (command && code === 'ArrowUp') return 'volume-up';
  if (command && code === 'ArrowDown') return 'volume-down';
  return null;
}

function resolveUnmodifiedShortcut(
  code: string,
  key: string,
  shiftKey: boolean,
  fullscreenVisualizer: boolean,
): PlayerShortcutCommand | null {
  if (code === 'Space' || key === ' ') return 'toggle-play';
  if (code === 'Escape' || key === 'escape') {
    return fullscreenVisualizer ? 'exit-fullscreen-visualizer' : null;
  }
  // In fullscreen visualizer, ←/→ cycle presets — let the visualizer's own
  // keydown handler own them. Returning null here avoids the double-fire
  // where seek-backward/forward ran alongside cyclePreset and skipped time
  // every time the user changed preset. Up/Down still nudge volume.
  if (fullscreenVisualizer && (code === 'ArrowLeft' || code === 'ArrowRight')) return null;
  if (code === 'ArrowLeft') return 'seek-backward';
  if (code === 'ArrowRight') return 'seek-forward';
  if (code === 'ArrowUp') return 'volume-up';
  if (code === 'ArrowDown') return 'volume-down';

  const rating = ratingFromKey(code, key);
  if (rating != null) return `rate-${rating}` as PlayerShortcutCommand;

  if (key === 'z') return 'previous';
  if (key === 'x') return 'play';
  if (key === 'c') return 'pause';
  if (key === 'v') return 'stop';
  if (key === 'b') return 'next';
  if (key === 'l') return 'toggle-love';
  if (key === 'f') return 'toggle-fullscreen-visualizer';
  // Shift+S: skin surf — cycle to the next built-in skin in THEME_REGISTRY
  // order (App.tsx routes this to usePlayerStore.cycleTheme, which toasts the
  // new skin's name). Shift-gated so a plain 's' stays free.
  if (shiftKey && key === 's') return 'cycle-skin';

  return null;
}

function ratingFromKey(code: string, key: string): number | null {
  // With NumLock off the numpad keys keep their Numpad0-5 codes but send arrows,
  // Home, End and the rest as the key value; those are not ratings.
  if (code.startsWith('Numpad') && !/^[0-9]$/.test(key)) return null;
  const digitCode = /^(?:Digit|Numpad)([0-5])$/.exec(code);
  if (digitCode) return Number(digitCode[1]);
  return /^[0-5]$/.test(key) ? Number(key) : null;
}

function isRepeatableShortcut(command: PlayerShortcutCommand): boolean {
  return (
    command === 'seek-backward' ||
    command === 'seek-forward' ||
    command === 'volume-up' ||
    command === 'volume-down'
  );
}

export interface ShortcutChordEvent {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

// The key value decides, so a letter that sits on another physical key (Dvorak,
// Colemak) or a symbol on this one (AZERTY puts "," where QWERTY has M) never
// fires the chord. Only a non-Latin layout (Cyrillic, Greek) has no key value
// to match, and there the physical position stands in.
export function isLetterKey(event: ShortcutChordEvent, letter: string): boolean {
  const key = event.key ?? '';
  if (key.toLowerCase() === letter) return true;
  return /^\p{L}$/u.test(key) && !/^\p{Script=Latin}$/u.test(key) && event.code === `Key${letter.toUpperCase()}`;
}

// Cmd on a Mac, Ctrl everywhere else, and never both at once.
function hasCommandModifier(event: ShortcutChordEvent, platform?: string): boolean {
  return platform === 'darwin' ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}

/** Chord written in the `formatShortcut` notation that switches deck mode on and off. */
export function deckModeChord(platform?: string): string {
  return platform === 'darwin' ? 'Mod+Shift+M' : 'Mod+M';
}

export function isDeckModeChord(event: ShortcutChordEvent, platform?: string): boolean {
  if (event.altKey || !isLetterKey(event, 'm')) return false;
  if (platform === 'darwin') {
    // Cmd+M is the Window menu's Minimize, so the deck takes Cmd+Shift+M.
    // Ctrl+M stays accepted for anyone who learned it before.
    if (event.metaKey) return !!event.shiftKey && !event.ctrlKey;
    return !!event.ctrlKey && !event.shiftKey;
  }
  return hasCommandModifier(event, platform) && !event.shiftKey;
}

/**
 * Focus the Library search. On a Mac only Cmd+F counts: Ctrl+F moves the
 * cursor forward in every text field and Ctrl+Cmd+F is the View menu's full
 * screen.
 */
export function isLibrarySearchChord(event: ShortcutChordEvent, platform?: string): boolean {
  return !event.altKey && !event.shiftKey && isLetterKey(event, 'f') && hasCommandModifier(event, platform);
}

const MAC_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const MAC_MODIFIER_GLYPHS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };

/**
 * Renders a chord written with `Mod` for the command modifier ("Mod+Shift+M")
 * as the host shows it: "Ctrl+Shift+M", or "⇧⌘M" on a Mac, where the glyphs
 * run Control, Option, Shift, Command and sit right against the key.
 */
export function formatShortcut(chord: string, platform?: string, separator = '+'): string {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  if (platform === 'darwin') {
    const glyphs = parts
      .sort((a, b) => MAC_MODIFIER_ORDER.indexOf(a) - MAC_MODIFIER_ORDER.indexOf(b))
      .map((modifier) => MAC_MODIFIER_GLYPHS[modifier] ?? modifier);
    return [...glyphs, key].join('');
  }
  return [...parts.map((modifier) => (modifier === 'Mod' ? 'Ctrl' : modifier)), key].join(separator);
}

export interface InputShortcutRole {
  /** Takes typed characters, so every shortcut yields to it. */
  editable: boolean;
  /** Space activates it. */
  space: boolean;
  /** Arrow keys step it. */
  arrows: boolean;
}

/**
 * How an <input> of this type treats the keys the shortcut map wants. Only the
 * types that take typed characters are text entry; a slider or a checkbox is a
 * control, and treating it like a text box left the map dead after any click
 * on one.
 */
export function inputShortcutRole(type: string): InputShortcutRole {
  switch (type.toLowerCase()) {
    case 'range':
      return { editable: false, space: false, arrows: true };
    case 'radio':
      return { editable: false, space: true, arrows: true };
    case 'checkbox':
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
    case 'color':
    case 'file':
      return { editable: false, space: true, arrows: false };
    default:
      return { editable: true, space: false, arrows: false };
  }
}

/** The slice of a DOM element the target classifier reads, so it runs without a DOM. */
export interface ShortcutTargetNode {
  tagName: string;
  /** Set on <input>. */
  type?: string;
  closest(selector: string): ShortcutTargetNode | null;
}

export interface ShortcutTargetTraits {
  /** Feeds PlayerShortcutInput.targetEditable. */
  editable: boolean;
  /** Feeds PlayerShortcutInput.targetIsButton. */
  button: boolean;
  /** Feeds PlayerShortcutInput.targetIsSlider. */
  slider: boolean;
}

export interface ShortcutTargetTracker {
  /** A mouse press landed on `target`. */
  pointerDown(target: ShortcutTargetNode | null): void;
  /** A key went down; Tab hands focus back to the keyboard. */
  keyDown(key: string): void;
  classify(target: ShortcutTargetNode | null): ShortcutTargetTraits;
}

const EDITABLE_TARGETS = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
const CONTROL_TARGETS = 'button, [role="button"], input';
const MODAL_TARGETS = '[aria-modal="true"]';

/**
 * Sorts the element that has focus into the three questions the resolver asks.
 * It also remembers the button a mouse press landed on: Chromium leaves focus
 * there, and Space on it should play or pause rather than press that button
 * again, so `button` reads false for it until Tab moves focus on. That is
 * for the transport-style buttons of the main window only. A checkbox or radio
 * keeps Space as its own toggle, and a dialog's controls keep it too.
 */
export function createShortcutTargetTracker(): ShortcutTargetTracker {
  let pointerFocused: ShortcutTargetNode | null = null;
  const closestControl = (target: ShortcutTargetNode | null): ShortcutTargetNode | null =>
    target?.closest(CONTROL_TARGETS) ?? null;
  const isInput = (node: ShortcutTargetNode): boolean => node.tagName.toLowerCase() === 'input';

  return {
    pointerDown(target) {
      const control = closestControl(target);
      pointerFocused = control && !isInput(control) && !control.closest(MODAL_TARGETS) ? control : null;
    },
    keyDown(key) {
      if (key === 'Tab') pointerFocused = null;
    },
    classify(target) {
      if (!target) return { editable: false, button: false, slider: false };
      const field = target.closest(EDITABLE_TARGETS);
      const editable = !!field && (!isInput(field) || inputShortcutRole(field.type ?? 'text').editable);
      const control = closestControl(target);
      const inputRole = control && isInput(control) ? inputShortcutRole(control.type ?? 'text') : null;
      return {
        editable,
        button: !!control && control !== pointerFocused && (inputRole ? inputRole.space : true),
        slider: !!inputRole && inputRole.arrows,
      };
    },
  };
}
