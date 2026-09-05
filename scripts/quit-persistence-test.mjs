// Run the actual quit handlers with Electron's explicit-quit and resident flows.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { shouldStayResidentOnWindowAllClosed } from '../dist-electron/electron/window-lifecycle-policy.js';

const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf("app.on('before-quit'"), source.indexOf("app.on('activate'"));
assert.ok(handlers.includes("app.on('will-quit'"));

function fixture(platform, hasTray, radio = false) {
  const calls = [];
  const app = new EventEmitter();
  let quitCount = 0;
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
    globalShortcut: { unregisterAll() {} }, closeStartupSplashWindow() {},
    libraryWatcher: { stop() { calls.push('watcher-stop'); } },
    scanner: { cancel() { calls.push('scanner-cancel'); } },
    library: { close() { calls.push('library-close'); } },
    settings: { flushSync() { calls.push('settings-flush'); } },
    exclusiveOutput: { dispose() {} },
    tray: hasTray ? { destroy() {} } : null,
    killAllDnaFfmpeg() {}, killAllTranscodeFfmpeg() {},
    radioBrain: radio ? { async stop() { calls.push('radio-stop'); } } : null,
    shouldStayResidentOnWindowAllClosed,
  };
  vm.runInNewContext(handlers, context);
  return { app, calls };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  const f = fixture(platform, true);
  f.app.emit('window-all-closed');
  assert.deepEqual(f.calls, [], 'closing a resident window must not close its stores');
  f.app.quit();
  assert.deepEqual(f.calls, ['watcher-stop', 'scanner-cancel', 'library-close', 'settings-flush'], `${platform} explicit Quit saves both stores`);
}
for (const platform of ['win32', 'linux']) {
  const f = fixture(platform, false);
  f.app.emit('window-all-closed');
  assert.ok(f.calls.includes('library-close'));
  assert.ok(f.calls.includes('settings-flush'));
}
const radio = fixture('linux', false, true);
radio.app.quit();
await new Promise(setImmediate);
assert.equal(radio.calls.filter((call) => call === 'radio-stop').length, 1);
assert.equal(radio.calls.filter((call) => call === 'defer-quit').length, 1);
console.log('PASS quit persistence: explicit Quit, resident windows, last-window quit, async radio shutdown');
