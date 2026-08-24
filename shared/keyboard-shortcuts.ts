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
  fullscreenVisualizer?: boolean;
}

export function resolvePlayerShortcut(input: PlayerShortcutInput): PlayerShortcutCommand | null {
  if (input.targetEditable || input.altKey || input.metaKey) return null;

  const code = input.code ?? '';
  const key = (input.key ?? '').toLowerCase();
  const isSpace = code === 'Space' || key === ' ';
  if (isSpace && input.targetIsButton) return null;
  const command = input.ctrlKey
    ? resolveControlShortcut(code)
    : resolveUnmodifiedShortcut(code, key, !!input.shiftKey, !!input.fullscreenVisualizer);

  if (!command) return null;
  if (input.repeat && !isRepeatableShortcut(command)) return null;
  return command;
}

function resolveControlShortcut(code: string): PlayerShortcutCommand | null {
  if (code === 'ArrowLeft') return 'previous';
  if (code === 'ArrowRight') return 'next';
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
