// Pure decision for the window-all-closed handler. macOS apps stay resident
// in the dock when their last window closes — exactly like a Windows/Linux
// tray icon keeps the app resident there — until a real quit is underway.
// Getting this wrong on darwin (falling through to cleanup on every window
// close) tears down the library DB while the app keeps running, so the next
// dock reactivation talks to a closed database. Kept pure and platform-
// injectable so it's unit-testable without an Electron runtime.
export function shouldStayResidentOnWindowAllClosed(input: {
  isQuitting: boolean;
  hasTray: boolean;
  platform: NodeJS.Platform;
}): boolean {
  if (input.isQuitting) return false;
  return input.hasTray || input.platform === 'darwin';
}

export type CloseAction = 'close' | 'hide' | 'minimize' | 'quit';

// Pure decision for the main window's close button (and Cmd+W / the red
// light on macOS). On macOS the Dock keeps the app resident, so closing hides
// the window and playback carries on; Cmd+Q is the way out. Windows and Linux
// hide to the tray when there is one. Without a live tray (the shell never
// showed it, or the startup probe tore it down) hiding would strand the
// window with no way back, and closing would silently end playback while
// Settings still promises "minimize", so the window minimizes to the taskbar.
// Closing an already-minimized window (from the taskbar) is then the way out,
// since nothing else would ever let such a session end.
export function closeAction(input: {
  platform: NodeJS.Platform;
  hasTray: boolean;
  isQuitting: boolean;
  isMinimized: boolean;
  behavior: 'minimize-to-tray' | 'close-app';
}): CloseAction {
  if (input.isQuitting) return 'close';
  if (input.behavior === 'close-app') return 'quit';
  if (input.platform === 'darwin') return 'hide';
  if (input.hasTray) return 'hide';
  return input.isMinimized ? 'quit' : 'minimize';
}

export type CrashRecoveryAction = 'ignore' | 'reload' | 'give-up';

const CRASH_RELOAD_LIMIT = 2;
const CRASH_RELOAD_WINDOW_MS = 60_000;

// The main renderer holds the audio engine; when it dies the window is blank
// and every tray, thumbbar and media-key command goes to a dead page. The
// saved resume state restores the session, so reload — but a renderer that
// keeps dying right after a reload is a loop, not a recovery.
export function crashRecoveryAction(input: {
  reason: string;
  isQuitting: boolean;
  recentReloads: readonly number[];
  now: number;
}): CrashRecoveryAction {
  if (input.isQuitting || input.reason === 'clean-exit') return 'ignore';
  const recent = input.recentReloads.filter((at) => input.now - at < CRASH_RELOAD_WINDOW_MS);
  return recent.length >= CRASH_RELOAD_LIMIT ? 'give-up' : 'reload';
}

// An ambient visualizer (fullscreen, or popped out to a second display) is
// watched, not touched, so the display must not sleep under it while music is
// playing. Paused or hidden, the system's own timeout applies again.
export function shouldBlockDisplaySleep(input: { visualizerShown: boolean; isPlaying: boolean }): boolean {
  return input.visualizerShown && input.isPlaying;
}

// The renderer asks for the normal window on every load. Only a window that
// went compact, or opened compact with a normal window to return to, has
// anything to restore; for any other it must change nothing, or a reload (a
// restored backup, a crash recovery) would resize and re-center the window.
// A window that opened straight into the deck waits for the renderer to ask
// for the deck itself: its first render still holds the default (not compact)
// state and asks for the normal window before the saved settings have loaded,
// which would grow the window to full size only to shrink it again.
export function shouldLeaveCompact(input: {
  inCompact: boolean;
  hasNormalBounds: boolean;
  startupPending?: boolean;
}): boolean {
  if (input.startupPending) return false;
  return input.inCompact || input.hasNormalBounds;
}
