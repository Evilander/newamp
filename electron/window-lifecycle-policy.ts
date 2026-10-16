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

// A window created hidden is shown from ready-to-show. On native Wayland
// Chromium sometimes never sends it for a window that has not been mapped yet
// (electron#48859), so the main window, its splash and the projector stayed
// invisible for good while the app ran on without them. A load that finished
// proves the page is there, so on Linux a short timer after it shows the
// window anyway. Whichever of the two comes first wins; the other is a no-op.
export const LINUX_REVEAL_FALLBACK_MS = 1500;

export interface RevealGate {
  trigger(): boolean;
  readonly revealed: boolean;
}

export function createRevealGate(reveal: () => void): RevealGate {
  let revealed = false;
  return {
    trigger() {
      if (revealed) return false;
      revealed = true;
      reveal();
      return true;
    },
    get revealed() {
      return revealed;
    },
  };
}

// The part of a BrowserWindow the reveal needs, so it can be driven by a fake.
export interface RevealTarget {
  once(event: 'ready-to-show', listener: () => void): unknown;
  isDestroyed(): boolean;
  webContents: { once(event: 'did-finish-load' | 'did-fail-load', listener: () => void): unknown };
}

export interface RevealOptions {
  platform: NodeJS.Platform;
  fallbackMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
}

// A page that failed to load is revealed too: an empty window the user can
// close beats an app that looks hung.
export function revealWhenReady(target: RevealTarget, reveal: () => void, options: RevealOptions): RevealGate {
  const gate = createRevealGate(reveal);
  target.once('ready-to-show', () => {
    gate.trigger();
  });
  if (options.platform === 'linux') {
    const setTimer = options.setTimer ?? setTimeout;
    let armed = false;
    const arm = () => {
      if (armed || gate.revealed) return;
      armed = true;
      setTimer(() => {
        if (!target.isDestroyed()) gate.trigger();
      }, options.fallbackMs ?? LINUX_REVEAL_FALLBACK_MS);
    };
    target.webContents.once('did-finish-load', arm);
    target.webContents.once('did-fail-load', arm);
  }
  return gate;
}

// The first time the close button sends the window to the tray, nothing on
// screen says the app is still running, and Windows 11 files a new tray icon
// under the overflow arrow. macOS has the Dock, which says it already.
export function shouldExplainTrayClose(input: {
  action: CloseAction;
  platform: NodeJS.Platform;
  alreadyExplained: boolean;
}): boolean {
  return input.action === 'hide' && input.platform !== 'darwin' && !input.alreadyExplained;
}

export interface TrayCloseNotice {
  title: string;
  message: string;
  detail: string;
  keepLabel: string;
  quitLabel: string;
}

export function trayCloseNotice(platform: NodeJS.Platform): TrayCloseNotice {
  const overflow = platform === 'win32' ? ' It may be under the ^ arrow next to the clock.' : '';
  return {
    title: 'NewAmp is still running',
    message: 'Closing the window keeps NewAmp playing in the tray.',
    detail:
      `Click the tray icon to bring the window back.${overflow} Starting NewAmp again does the same.\n\n` +
      'To quit, right-click the tray icon and choose Quit NewAmp.\n\n' +
      'To make the X button quit instead, change Close button (X) in Settings.',
    keepLabel: 'Keep playing in the tray',
    quitLabel: 'Quit NewAmp',
  };
}
