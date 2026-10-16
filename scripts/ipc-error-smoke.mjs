import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';

// What a handler's error looks like in the renderer. One window has plain
// ipcRenderer.invoke and shows what Electron does to the message; the other
// loads the real preload (dist-electron) and must hand the UI the real one.
// Needs `npm run build:electron` first and a display.

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const preloadPath = join(repoRoot, 'dist-electron', 'electron', 'preload.js');
const rawPreloadPath = join(repoRoot, 'scripts', 'ipc-error-smoke-app', 'raw-preload.mjs');
const userData = mkdtempSync(join(tmpdir(), 'newamp-ipc-error-'));
app.setPath('userData', userData);

function finish(code, message) {
  if (message) console[code ? 'error' : 'log'](message);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* the temp folder is not worth failing over */
  }
  app.exit(code);
}

// Channels the real preload uses, each failing a different way.
ipcMain.on('app:get-info-sync', (event) => {
  event.returnValue = { platform: process.platform, appVersion: 'smoke' };
});
ipcMain.handle('library:cancel-scan', () => {
  throw new Error('Scan was already stopped');
});
ipcMain.handle('library:get-albums', () => {
  throw new TypeError('opts.sort is not a string');
});
ipcMain.handle('library:get-folders', () => Promise.reject('folder gone'));
ipcMain.handle('library:get-track-count', () => 42);

async function windowWith(preload) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>ipc</title>'));
  return win;
}

const probe = (call) => `(async () => {
  try {
    const value = await ${call};
    return { ok: true, value };
  } catch (err) {
    return { ok: false, message: String(err && err.message), name: String(err && err.name), stack: String(err && err.stack) };
  }
})()`;

app.whenReady().then(async () => {
  try {
    const raw = await windowWith(rawPreloadPath);
    const rawFailure = await raw.webContents.executeJavaScript(probe("window.rawIpc.invoke('library:cancel-scan')"));
    assert.equal(rawFailure.ok, false);
    assert.equal(
      rawFailure.message,
      "Error invoking remote method 'library:cancel-scan': Error: Scan was already stopped",
      'plain invoke should show the wrapped message, or this smoke no longer tests the problem',
    );

    const win = await windowWith(preloadPath);
    const consoleLines = [];
    win.webContents.on('console-message', (details) => consoleLines.push(String(details.message)));
    const exec = (call) => win.webContents.executeJavaScript(probe(call));

    const stopped = await exec('window.newamp.cancelScan()');
    assert.equal(stopped.message, 'Scan was already stopped');
    assert.equal(stopped.name, 'Error');
    // Only message and name cross the context bridge, so the channel is
    // logged where the failure is caught.
    assert.ok(
      consoleLines.some((line) => line.includes('library:cancel-scan failed: Scan was already stopped')),
      `the channel should be logged, got: ${JSON.stringify(consoleLines)}`,
    );

    const typed = await exec('window.newamp.getAlbums({})');
    // A typed error keeps its type: that part is information, not wrapping.
    assert.equal(typed.message, 'TypeError: opts.sort is not a string');

    const thrownString = await exec('window.newamp.getFolders(null)');
    assert.equal(thrownString.message, 'folder gone');

    const fine = await exec('window.newamp.getTrackCount({})');
    assert.deepEqual(fine, { ok: true, value: 42 }, 'a call that succeeds should be left alone');

    finish(0, '[ipc-error-smoke] ok');
  } catch (err) {
    finish(1, `[ipc-error-smoke] FAIL: ${err instanceof Error ? err.stack : String(err)}`);
  }
});
