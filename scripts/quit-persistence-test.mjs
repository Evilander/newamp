// Run the actual quit handlers with Electron's explicit-quit and resident flows.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { shouldStayResidentOnWindowAllClosed } from '../dist-electron/electron/window-lifecycle-policy.js';

const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf("app.on('before-quit'"), source.indexOf("app.on('activate'"));
assert.ok(handlers.includes("app.on('will-quit'"));

function fixture(platform, hasTray, radio = false, displaySleepBlockerId = null) {
  const calls = [];
  const stoppedBlockers = [];
  const app = new EventEmitter();
  let quitCount = 0;
  let gaplessClosed = 0;
  app.quit = () => {
    quitCount++;
    assert.ok(quitCount < 4, 'quit must finish after bounded radio shutdown');
    app.emit('before-quit');
    // app.quit/Cmd+Q intentionally bypass window-all-closed.
    app.emit('will-quit', { preventDefault() { calls.push('defer-quit'); } });
  };
  const context = {
    app, process: { platform }, console,
    isQuitting: false, radioBrainShutdownStarted: false,
    displaySleepBlockerId,
    powerSaveBlocker: { stop(id) { stoppedBlockers.push(id); } },
    globalShortcut: { unregisterAll() {} }, closeStartupSplashWindow() {},
    libraryWatcher: { stop() { calls.push('watcher-stop'); } },
    scanner: { cancel() { calls.push('scanner-cancel'); } },
    libraryAnalysis: { async stop() { calls.push('analysis-stop'); } },
    library: { close() { calls.push('library-close'); } },
    settings: { flushSync() { calls.push('settings-flush'); } },
    podcastStore: { flushProgressSync() { calls.push('podcast-flush'); } },
    exclusiveOutput: { dispose() {} },
    tray: hasTray ? { destroy() {} } : null,
    killAllDnaFfmpeg() {}, killAllAnalysisFfmpeg() {}, killAllScoreFfmpeg() {}, killAllWaveformFfmpeg() {}, killAllTranscodeFfmpeg() {},
    closeAllGaplessSessions() { gaplessClosed++; },
    radioBrain: radio ? { async stop() { calls.push('radio-stop'); } } : null,
    shouldStayResidentOnWindowAllClosed,
  };
  vm.runInNewContext(handlers, context);
  return { app, calls, context, stoppedBlockers, gaplessClosed: () => gaplessClosed };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  const f = fixture(platform, true);
  f.app.emit('window-all-closed');
  assert.deepEqual(f.calls, [], 'closing a resident window must not close its stores');
  f.app.quit();
  assert.deepEqual(f.calls, ['watcher-stop', 'scanner-cancel', 'analysis-stop', 'library-close', 'settings-flush', 'podcast-flush'], `${platform} explicit Quit saves every store, after the analysis queue has written its results`);
  assert.equal(f.gaplessClosed(), 1, `${platform} explicit Quit stops the gapless decoders`);
  assert.deepEqual(f.stoppedBlockers, [], `${platform} explicit Quit has no display-sleep blocker to release`);
}
{
  // The display-sleep blocker held for an ambient visualizer is released on quit.
  const f = fixture('darwin', true, false, 7);
  f.app.quit();
  assert.deepEqual(f.stoppedBlockers, [7], 'explicit Quit releases the display-sleep blocker');
  assert.equal(f.context.displaySleepBlockerId, null, 'the released blocker is forgotten');
}
for (const platform of ['win32', 'linux']) {
  const f = fixture(platform, false);
  f.app.emit('window-all-closed');
  assert.ok(f.calls.includes('library-close'));
  assert.ok(f.calls.includes('settings-flush'));
  assert.ok(f.calls.includes('podcast-flush'));
}
const radio = fixture('linux', false, true);
radio.app.quit();
await new Promise(setImmediate);
assert.equal(radio.calls.filter((call) => call === 'radio-stop').length, 1);
assert.equal(radio.calls.filter((call) => call === 'defer-quit').length, 1);
console.log('PASS quit persistence: explicit Quit, resident windows, last-window quit, async radio shutdown');
