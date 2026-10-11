// Unit tests for electron/window-lifecycle-policy.ts.
//
// shouldStayResidentOnWindowAllClosed: window-all-closed's early-return
// condition was `!isQuitting && tray && process.platform !== 'darwin'`, which
// can never be true on darwin (process.platform !== 'darwin' is always false
// there), so closing the last window on macOS always fell through to
// scanner.cancel()/library.close()/settings.flushSync() even though the app
// is expected to stay resident in the dock — the next dock reactivation then
// talks to a closed library.
//
// closeAction: on macOS no tray is ever created, so the close handler's hide
// branch (guarded on a live tray) never ran and every close destroyed the
// window and the audio engine with it.
//
// Run: node scripts/window-lifecycle-policy-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/window-lifecycle-policy-test-result.txt');
writeFileSync(RESULT, '[window-lifecycle-policy-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/window-lifecycle-policy.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/window-lifecycle-policy-bundle.mjs'), logLevel: 'silent',
});
const {
  shouldStayResidentOnWindowAllClosed: decide,
  closeAction,
  crashRecoveryAction,
  shouldBlockDisplaySleep,
  shouldLeaveCompact,
} = await import(pathToFileURL(resolve('tmp/window-lifecycle-policy-bundle.mjs')).href);

const log = [];
let pass = true;
const check = (label, actual, expected) => {
  log.push(`${label}: ${actual}`);
  if (actual !== expected) { pass = false; log.push(`FAIL: ${label} expected ${expected}, got ${actual}`); }
};

// The regression: macOS, last window closed normally (not quitting) — must
// stay resident (true) so the library/tray are never torn down.
check(
  'darwin, !isQuitting, no tray -> stays resident',
  decide({ isQuitting: false, hasTray: false, platform: 'darwin' }),
  true,
);
check(
  'darwin, !isQuitting, with tray -> stays resident',
  decide({ isQuitting: false, hasTray: true, platform: 'darwin' }),
  true,
);
// A real quit in progress on macOS must still run cleanup.
check(
  'darwin, isQuitting -> cleanup runs',
  decide({ isQuitting: true, hasTray: false, platform: 'darwin' }),
  false,
);
check(
  'darwin, isQuitting, with tray -> cleanup runs',
  decide({ isQuitting: true, hasTray: true, platform: 'darwin' }),
  false,
);

// Non-mac behavior must be unchanged: tray keeps the app resident, no tray
// means closing the last window quits.
check(
  'win32, !isQuitting, with tray -> stays resident',
  decide({ isQuitting: false, hasTray: true, platform: 'win32' }),
  true,
);
check(
  'win32, !isQuitting, no tray -> cleanup + quit',
  decide({ isQuitting: false, hasTray: false, platform: 'win32' }),
  false,
);
check(
  'win32, isQuitting, with tray -> cleanup + quit',
  decide({ isQuitting: true, hasTray: true, platform: 'win32' }),
  false,
);
check(
  'linux, !isQuitting, no tray -> cleanup + quit',
  decide({ isQuitting: false, hasTray: false, platform: 'linux' }),
  false,
);

// Close button. macOS: hide (playback continues) with or without a tray.
const keep = 'minimize-to-tray';
check('darwin, no tray, keep running -> hide', closeAction({ platform: 'darwin', hasTray: false, isQuitting: false, isMinimized: false, behavior: keep }), 'hide');
check('darwin, tray, keep running -> hide', closeAction({ platform: 'darwin', hasTray: true, isQuitting: false, isMinimized: false, behavior: keep }), 'hide');
check('darwin, close-app -> quit', closeAction({ platform: 'darwin', hasTray: false, isQuitting: false, isMinimized: false, behavior: 'close-app' }), 'quit');
check('darwin, Cmd+Q in progress -> let the window close', closeAction({ platform: 'darwin', hasTray: false, isQuitting: true, isMinimized: false, behavior: keep }), 'close');
// Windows: the existing setting still decides.
check('win32, tray, keep running -> hide', closeAction({ platform: 'win32', hasTray: true, isQuitting: false, isMinimized: false, behavior: keep }), 'hide');
check('win32, tray, close-app -> quit', closeAction({ platform: 'win32', hasTray: true, isQuitting: false, isMinimized: false, behavior: 'close-app' }), 'quit');
check('win32, quitting -> let the window close', closeAction({ platform: 'win32', hasTray: true, isQuitting: true, isMinimized: false, behavior: keep }), 'close');
// The tray probe can destroy the tray; closing must not quietly end playback.
check('win32, tray destroyed, keep running -> minimize', closeAction({ platform: 'win32', hasTray: false, isQuitting: false, isMinimized: false, behavior: keep }), 'minimize');
check('win32, tray destroyed, close-app -> quit', closeAction({ platform: 'win32', hasTray: false, isQuitting: false, isMinimized: false, behavior: 'close-app' }), 'quit');
check('win32, tray destroyed, window already minimized -> quit', closeAction({ platform: 'win32', hasTray: false, isQuitting: false, isMinimized: true, behavior: keep }), 'quit');
check('win32, tray, window minimized -> still hide', closeAction({ platform: 'win32', hasTray: true, isQuitting: false, isMinimized: true, behavior: keep }), 'hide');
check('darwin, window minimized -> hide', closeAction({ platform: 'darwin', hasTray: false, isQuitting: false, isMinimized: true, behavior: keep }), 'hide');
check('linux, no tray, keep running -> minimize', closeAction({ platform: 'linux', hasTray: false, isQuitting: false, isMinimized: false, behavior: keep }), 'minimize');

// Renderer crash recovery.
const now = 1_000_000;
check('crash, first -> reload', crashRecoveryAction({ reason: 'crashed', isQuitting: false, recentReloads: [], now }), 'reload');
check('clean exit -> ignore', crashRecoveryAction({ reason: 'clean-exit', isQuitting: false, recentReloads: [], now }), 'ignore');
check('crash while quitting -> ignore', crashRecoveryAction({ reason: 'crashed', isQuitting: true, recentReloads: [], now }), 'ignore');
check('oom, one recent reload -> reload', crashRecoveryAction({ reason: 'oom', isQuitting: false, recentReloads: [now - 10_000], now }), 'reload');
check('two reloads in the last minute -> give up', crashRecoveryAction({ reason: 'crashed', isQuitting: false, recentReloads: [now - 50_000, now - 5_000], now }), 'give-up');
check('old reloads do not count -> reload', crashRecoveryAction({ reason: 'crashed', isQuitting: false, recentReloads: [now - 120_000, now - 90_000], now }), 'reload');
check('exactly 60 s ago no longer counts', crashRecoveryAction({ reason: 'crashed', isQuitting: false, recentReloads: [now - 60_000, now - 1_000], now }), 'reload');

// Display sleep is held only while a visualizer is on screen and music plays.
check('visualizer shown, playing -> block', shouldBlockDisplaySleep({ visualizerShown: true, isPlaying: true }), true);
check('visualizer shown, paused -> allow sleep', shouldBlockDisplaySleep({ visualizerShown: true, isPlaying: false }), false);
check('no visualizer, playing -> allow sleep', shouldBlockDisplaySleep({ visualizerShown: false, isPlaying: true }), false);
check('nothing shown, paused -> allow sleep', shouldBlockDisplaySleep({ visualizerShown: false, isPlaying: false }), false);

// The renderer asks for the normal window on every load.
check('never went compact -> leave the window alone', shouldLeaveCompact({ inCompact: false, hasNormalBounds: false }), false);
check('in the deck -> restore', shouldLeaveCompact({ inCompact: true, hasNormalBounds: true }), true);
check('in the deck with nothing remembered -> restore to a default', shouldLeaveCompact({ inCompact: true, hasNormalBounds: false }), true);
check('relaunched into the deck, normal window remembered -> restore', shouldLeaveCompact({ inCompact: false, hasNormalBounds: true }), true);
// Relaunch into the deck: the first render's set-compact(false) arrives before
// the renderer has loaded the saved compact mode, and must not grow the window.
check('opened in the deck, renderer not caught up -> leave it alone', shouldLeaveCompact({ inCompact: true, hasNormalBounds: true, startupPending: true }), false);
check('opened with a normal window remembered, renderer not caught up -> leave it alone', shouldLeaveCompact({ inCompact: false, hasNormalBounds: true, startupPending: true }), false);
check('the renderer has asked for the deck -> restore works again', shouldLeaveCompact({ inCompact: true, hasNormalBounds: true, startupPending: false }), true);

const report = log.join('\n') + '\n' + (pass ? '[window-lifecycle-policy-test] PASS' : '[window-lifecycle-policy-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
