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
  | 'exit-fullscreen-visualizer';

export interface PlayerShortcutInput {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  targetEditable?: boolean;
  fullscreenVisualizer?: boolean;
}

export function resolvePlayerShortcut(input: PlayerShortcutInput): PlayerShortcutCommand | null {
  if (input.targetEditable || input.altKey || input.metaKey) return null;

  const code = input.code ?? '';
  const key = (input.key ?? '').toLowerCase();
  const command = input.ctrlKey
    ? resolveControlShortcut(code)
    : resolveUnmodifiedShortcut(code, key, !!input.fullscreenVisualizer);

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
  fullscreenVisualizer: boolean,
): PlayerShortcutCommand | null {
  if (code === 'Space' || key === ' ') return 'toggle-play';
  if (code === 'Escape' || key === 'escape') {
    return fullscreenVisualizer ? 'exit-fullscreen-visualizer' : null;
  }
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
