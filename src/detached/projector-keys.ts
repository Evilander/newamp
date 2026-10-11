// What a key press means in the projector, kept apart from main.tsx's DOM
// wiring so scripts/projector-keys-test.mjs can run it.
import { resolvePlayerShortcut } from '@shared/keyboard-shortcuts';

export type ProjectorKeyAction =
  | 'toggle-fullscreen'
  | 'exit-fullscreen'
  | 'toggle-play'
  | 'next'
  | 'previous'
  | 'seek-forward'
  | 'seek-backward'
  | 'volume-up'
  | 'volume-down';

export interface ProjectorKeyEvent {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

/**
 * The action for a key press, or null when the projector leaves it alone.
 * Cmd, not Ctrl, is the transport modifier on a Mac, so a held Ctrl or Cmd is
 * answered by the main window's chord rules and by nothing else: a chord the
 * rules turn down (an auto-repeat of Next, the Windows key's own Win+Arrow)
 * must not fall through to the plain arrows and seek.
 */
export function projectorKeyAction(event: ProjectorKeyEvent, platform?: string): ProjectorKeyAction | null {
  if (event.key === 'F11') return 'toggle-fullscreen';
  if (event.key === 'Escape') return 'exit-fullscreen';
  if (event.altKey) return null;
  if (event.ctrlKey || event.metaKey) {
    const chord = resolvePlayerShortcut({
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      platform,
    });
    return chord === 'next' || chord === 'previous' || chord === 'volume-up' || chord === 'volume-down' ? chord : null;
  }
  // Space is play/pause: the projector is the player while it sits on a second
  // monitor and the main window is behind it. A held key toggles once.
  if (event.key === ' ' || event.code === 'Space') return event.repeat ? null : 'toggle-play';
  if (event.key === 'ArrowRight') return 'seek-forward';
  if (event.key === 'ArrowLeft') return 'seek-backward';
  if (event.key === 'ArrowUp') return 'volume-up';
  if (event.key === 'ArrowDown') return 'volume-down';
  return null;
}
