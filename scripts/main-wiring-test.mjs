// Source pins for how electron/main.ts is wired to its pure helpers. The helpers
// have their own tests; these catch the call site drifting away from them, which
// no unit test of the helper would notice. The macOS-only behaviours (Dock menu,
// Spaces, simple fullscreen, traffic lights) are pinned here but can only be
// confirmed by running the app on a Mac.
// Run: node scripts/main-wiring-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = read('electron/main.ts');
const preload = read('electron/preload.ts');

// The text of a top-level function, from its declaration to the next one.
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `main.ts has ${signature}`);
  const next = source.slice(start + signature.length).search(/\n(?:async )?function \w+\(/);
  return next === -1 ? source.slice(start) : source.slice(start, start + signature.length + next);
}

// Every channel the main process pushes to the main window has a listener in
// the preload, so a menu item or shortcut cannot end up sending into nothing.
{
  const listened = new Set([...preload.matchAll(/ipcRenderer\.(?:on|once)\(\s*'([^']+)'/g)].map((m) => m[1]));
  const sent = [...main.matchAll(/(\w+)\??\.webContents\.send\(\s*'([^']+)'/g)]
    .filter((m) => m[1] !== 'detachedVizWin' && m[1] !== 'startupSplashWin')
    .map((m) => m[2]);
  assert.ok(sent.length > 5, 'the scan finds the main window channels');
  const unheard = [...new Set(sent)].filter((channel) => !listened.has(channel));
  assert.deepEqual(unheard, [], `main.ts sends channels the preload never listens for: ${unheard.join(', ')}`);
}

// The permission handlers go in during bootstrap, before any window
// exists, and list the app's own origins (the dev server only in development).
{
  const bootstrap = functionBody(main, 'async function bootstrap(): Promise<void> {');
  const installAt = bootstrap.indexOf('installPermissionHandlers(session.defaultSession');
  const firstWindowAt = bootstrap.indexOf('createWindow()');
  assert.ok(installAt !== -1, 'bootstrap installs the permission handlers on the default session');
  assert.ok(installAt < firstWindowAt, 'the handlers are installed before the first window is created');
  assert.match(bootstrap, /allowedOrigins: isDev \? \['newamp-app:\/\/app', 'http:\/\/localhost:5173'\] : \['newamp-app:\/\/app'\]/);
  assert.match(bootstrap, /onDenied: \(denial\) => writeDiagnosticEvent\('permission-denied'/, 'denials leave a diagnostic event');
}

const createWindow = functionBody(main, 'function createWindow(): BrowserWindow {');

// The close button asks closeAction, with the live tray state.
{
  const close = createWindow.slice(createWindow.indexOf("win.on('close'"));
  assert.match(close, /closeAction\(\{[\s\S]*?platform: process\.platform,[\s\S]*?hasTray: !!tray && !tray\.isDestroyed\(\),[\s\S]*?isQuitting,[\s\S]*?isMinimized: win\.isMinimized\(\),[\s\S]*?behavior: settings\.get\(\)\.closeButtonBehavior,/);
  assert.match(close, /if \(action === 'close'\) return;/);
  assert.match(close, /if \(action === 'quit'\) \{[\s\S]*?isQuitting = true;[\s\S]*?app\.quit\(\);/);
  assert.match(close, /event\.preventDefault\(\);[\s\S]*?if \(action === 'minimize'\) win\.minimize\(\);[\s\S]*?else hideMainWindow\(win\);/);
}

// A dead renderer is reloaded through crashRecoveryAction, then gives up with a dialog.
{
  const gone = createWindow.slice(createWindow.indexOf("win.webContents.on('render-process-gone'"));
  assert.match(gone, /crashRecoveryAction\(\{ reason: details\.reason, isQuitting, recentReloads: crashReloads, now \}\)/);
  assert.match(gone, /if \(action === 'ignore'\) return;/);
  assert.match(gone, /if \(action === 'reload'\) \{[\s\S]*?crashReloads\.push\(now\);[\s\S]*?win\.webContents\.reload\(\);/);
  assert.match(gone, /dialog\s*\.showMessageBox\(win,/);
}

// The thumbnail toolbar comes back whenever the window does.
assert.match(createWindow, /win\.on\('show', \(\) => applyThumbarButtons\(win\)\);/);
assert.match(createWindow, /win\.on\('restore', \(\) => applyThumbarButtons\(win\)\);/);

// The window is revealed on ready-to-show (or, on Linux, the timer after the load that covers
// Wayland never sending it), after at most what is left of the splash minimum.
assert.match(createWindow, /revealWhenReady\(win, \(\) => \{/);
assert.doesNotMatch(createWindow, /win\.once\('ready-to-show'/, 'the reveal goes through revealWhenReady');
assert.match(createWindow, /STARTUP_SPLASH_MIN_MS - \(Date\.now\(\) - startupSplashStartedAt\)/);

// Opening into the deck leaves the renderer's first set-compact(false) alone.
{
  const geometry = functionBody(main, 'function startupWindowGeometry(): StartupWindowGeometry {');
  assert.equal(geometry.match(/startupCompactPending = true;/g)?.length, 1, 'only the deck-relaunch path sets the flag');
  assert.ok(
    geometry.indexOf('startupCompactPending = true;') > geometry.indexOf('normalBounds = {'),
    'the flag is set once the normal window to return to is remembered',
  );
  const startAt = createWindow.indexOf('startupCompactPending = false;');
  assert.ok(startAt !== -1 && startAt < createWindow.indexOf('startupWindowGeometry()'), 'a new window starts with the flag cleared');
  const compact = functionBody(main, 'async function setCompactMode(');
  assert.match(compact, /if \(on\) startupCompactPending = false;/, 'the renderer asking for the deck clears the flag');
  assert.match(compact, /shouldLeaveCompact\(\{ inCompact, hasNormalBounds: !!normalBounds, startupPending: startupCompactPending \}\)/);
  assert.equal(main.match(/startupCompactPending = /g)?.length, 4, 'the flag is only assigned in the four places above');
}

// The deck waits for fullscreen to finish before it sizes the window.
{
  const compact = functionBody(main, 'async function setCompactMode(');
  assert.match(compact, /if \(isWindowFullScreen\(mainWin\)\) await leaveFullScreen\(mainWin\);/);
}

// The traffic lights go in the deck and come back out of it, and when a
// hidden window leaves fullscreen.
{
  const compact = functionBody(main, 'async function setCompactMode(');
  assert.match(compact, /process\.platform === 'darwin'\) win\.setWindowButtonVisibility\(false\);/);
  assert.match(compact, /process\.platform === 'darwin'\) win\.setWindowButtonVisibility\(true\);/);
  const hide = functionBody(main, 'function hideMainWindow(win: BrowserWindow): void {');
  assert.match(hide, /win\.setSimpleFullScreen\(false\);\s*win\.setWindowButtonVisibility\(!inCompact\);/);
  assert.match(hide, /win\.once\('leave-full-screen', \(\) => \{\s*if \(win\.isDestroyed\(\)\) return;\s*win\.setWindowButtonVisibility\(!inCompact\);\s*win\.hide\(\);/);
}

// The visualizer uses simple fullscreen on macOS.
assert.match(main, /ipcMain\.handle\('win:set-fullscreen'[\s\S]*?setSimpleFullScreen\(true\)/);

// A pinned deck follows the user across Spaces and over fullscreen apps.
assert.match(main, /ipcMain\.handle\('win:set-always-on-top'[\s\S]*?setVisibleOnAllWorkspaces\(!!on, \{ visibleOnFullScreen: !!on/);

// The Dock menu is built on macOS only and carries the playback commands.
{
  const dock = functionBody(main, 'function buildDockMenu(): Menu {');
  for (const command of ['previous', 'toggle-play', 'next', 'stop']) assert.ok(dock.includes(`'${command}'`), `Dock menu sends ${command}`);
  const refresh = functionBody(main, 'function refreshDockMenu(): void {');
  assert.match(refresh, /process\.platform !== 'darwin' \|\| smokeMode \|\| !app\.dock/);
}

// The macOS menu only carries a Settings item when the renderer can act on it.
// Comments are dropped first so a note about onPreferences does not count as
// wiring it, and the check takes any spelling (property, shorthand, spread).
{
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const install = stripComments(functionBody(main, 'function installApplicationMenu(): void {'));
  assert.ok(/\bbuildAppMenuTemplate\(/.test(install), 'the menu is still built by installApplicationMenu');
  if (/\bonPreferences\b/.test(install)) {
    assert.ok(preload.includes("ipcRenderer.on('app:open-settings'"), 'a Settings menu item needs a renderer listener to open it');
    assert.match(
      main,
      /\bsend\(\s*'app:open-settings'/,
      'a Settings menu item sends app:open-settings, the channel the renderer listens on',
    );
  }
}

// The display stays awake only for a visualizer that is on screen, and a quit lets go.
{
  const blocker = functionBody(main, 'function refreshDisplaySleepBlocker(): void {');
  assert.match(blocker, /detachedVizWin\.isVisible\(\) && !detachedVizWin\.isMinimized\(\)/, 'a minimized projector is not on screen');
  assert.match(blocker, /shouldBlockDisplaySleep\(\{/);
  const created = main.slice(main.indexOf("app.on('browser-window-created'"));
  for (const event of ['show', 'hide', 'minimize', 'restore', 'closed']) {
    assert.ok(created.slice(0, 500).includes(`created.on('${event}', refreshDisplaySleepBlocker)`), `the blocker is re-checked on ${event}`);
  }
  // Other modules may hang their own will-quit listeners; one of them must let go of the blocker.
  const quitHandlers = [...main.matchAll(/app\.on\('will-quit'/g)].map((m) => main.slice(m.index, m.index + 600));
  assert.ok(quitHandlers.length > 0, 'a quit handler exists');
  assert.ok(quitHandlers.some((body) => /powerSaveBlocker\.stop\(displaySleepBlockerId\)/.test(body)), 'a quit lets go of the display-sleep blocker');
}

// The files the renderer took at launch ride along with a batch that follows.
{
  assert.match(main, /ipcMain\.handle\('open:consume-pending-files'[\s\S]*?handedOffFiles = \{ paths: \[\.\.\.files\], at: Date\.now\(\) \}/);
  const deliver = functionBody(main, 'function deliverOpenFiles(paths: string[]): void {');
  assert.match(deliver, /mergeHandedOff\(paths, handedOffFiles, Date\.now\(\), COLD_START_MERGE_MS\)/);
  assert.match(deliver, /send\('app:open-files', merged\.files\)/);
}

console.log('PASS main wiring: permissions, close, crash recovery, thumbar, startup deck, macOS window handling, open-file hand-off');
