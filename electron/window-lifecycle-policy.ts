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
