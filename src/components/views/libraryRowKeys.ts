// Rating and love keys while a track row has focus. The app-wide map reads 0-5
// and L the same way but acts on the playing track; a row that has focus is
// what the person is looking at, so the keys act on it instead.
import { resolvePlayerShortcut, type PlayerShortcutInput } from '@shared/keyboard-shortcuts';

export type RowShortcut = { kind: 'love' } | { kind: 'rate'; rating: number };

type RowKeyEvent = Pick<
  PlayerShortcutInput,
  'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat'
>;

export interface RowShortcutEvent extends RowKeyEvent {
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface RowShortcutHandlers {
  onToggleLove(): void;
  onSetRating(rating: number): void;
}

/** The row action a key press means, or null when the key is not a rating or love key. */
export function rowShortcut(event: RowKeyEvent, platform?: string): RowShortcut | null {
  const command = resolvePlayerShortcut({ ...event, platform });
  if (command === 'toggle-love') return { kind: 'love' };
  const rating = /^rate-([0-5])$/.exec(command ?? '');
  return rating ? { kind: 'rate', rating: Number(rating[1]) } : null;
}

/** A field that takes typed characters, which keeps its digits and its L. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const input = target.closest('input');
  if (input) return !/^(checkbox|radio|range|button|submit|reset|image|color|file)$/i.test(input.type);
  return !!target.closest('textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
}

/**
 * Rates or loves the row for a rating or love key and keeps the press from also
 * reaching the app-wide map. False, with nothing done, for any other key and for
 * a press inside a text field.
 */
export function runRowShortcut(event: RowShortcutEvent, platform: string | undefined, handlers: RowShortcutHandlers): boolean {
  if (isTextEntryTarget(event.target)) return false;
  const shortcut = rowShortcut(event, platform);
  if (!shortcut) return false;
  event.preventDefault();
  event.stopPropagation();
  if (shortcut.kind === 'love') handlers.onToggleLove();
  else handlers.onSetRating(shortcut.rating);
  return true;
}
