// The first time the close button hides the window to the tray, NewAmp says so
// once: the app is still running, how to bring the window back, how to quit,
// and where to change it. Before this the window and its taskbar button just
// vanished while the music played on.
// Run: node scripts/tray-close-notice-test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const read = (path) => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');

mkdirSync(resolve('tmp'), { recursive: true });
for (const [entry, out] of [
  ['electron/window-lifecycle-policy.ts', 'tmp/tray-notice-policy-bundle.mjs'],
  ['electron/settings.ts', 'tmp/tray-notice-settings-bundle.mjs'],
]) {
  await build({
    entryPoints: [resolve(entry)],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent',
    outfile: resolve(out),
    external: ['electron'],
  });
}
const { shouldExplainTrayClose, trayCloseNotice, closeAction } = await import(
  pathToFileURL(resolve('tmp/tray-notice-policy-bundle.mjs')).href
);
const { SettingsStore } = await import(pathToFileURL(resolve('tmp/tray-notice-settings-bundle.mjs')).href);

// ---- when the notice is due ----
for (const platform of ['win32', 'linux']) {
  assert.equal(shouldExplainTrayClose({ action: 'hide', platform, alreadyExplained: false }), true, `${platform}: the first hide explains itself`);
  assert.equal(shouldExplainTrayClose({ action: 'hide', platform, alreadyExplained: true }), false, `${platform}: only once`);
  for (const action of ['close', 'quit', 'minimize']) {
    assert.equal(shouldExplainTrayClose({ action, platform, alreadyExplained: false }), false, `${platform}: ${action} hides nothing`);
  }
}
assert.equal(shouldExplainTrayClose({ action: 'hide', platform: 'darwin', alreadyExplained: false }), false, 'the Dock already says the app is running');

// A user who picked "close the app" never reaches the hide, so never sees it.
assert.equal(closeAction({ platform: 'win32', hasTray: true, isQuitting: false, isMinimized: false, behavior: 'close-app' }), 'quit');

// ---- what it says ----
for (const platform of ['win32', 'linux']) {
  const notice = trayCloseNotice(platform);
  assert.match(notice.message, /tray/i, 'says where it went');
  assert.match(notice.message, /playing/i, 'says the music goes on');
  assert.match(notice.detail, /Quit NewAmp/, 'how to quit: the tray menu entry, by its name');
  assert.match(notice.detail, /right-click the tray icon/i);
  assert.match(notice.detail, /Close button \(X\) in Settings/, 'where to change it, by the setting\'s name');
  assert.match(notice.detail, /bring the window back/i, 'how to get the window back');
  assert.equal(notice.quitLabel, 'Quit NewAmp');
  assert.ok(notice.keepLabel.length > 0);
}
assert.match(trayCloseNotice('win32').detail, /arrow next to the clock/, 'Windows hides new tray icons under the overflow arrow');
assert.doesNotMatch(trayCloseNotice('linux').detail, /clock/, 'the overflow hint is Windows only');

// The Settings row the notice points at exists under that name.
{
  const copy = read('src/lib/close-button-copy.ts');
  assert.match(copy, /label: 'Close button \(X\)'/, 'the setting is called what the notice calls it');
}

// ---- the flag is remembered across launches, and is not a user setting ----
{
  const dir = mkdtempSync(join(tmpdir(), 'newamp-tray-notice-'));
  try {
    const file = join(dir, 'settings.json');
    const first = new SettingsStore(file);
    assert.equal(first.get().trayNoticeShown, false, 'a new profile has not seen it');
    first.set({ trayNoticeShown: true });
    assert.equal(new SettingsStore(file).get().trayNoticeShown, true, 'it is on disk after one set');
    first.set({ closeButtonBehavior: 'close-app' });
    assert.equal(new SettingsStore(file).get().trayNoticeShown, true, 'other settings do not reset it');
    first.set({ trayNoticeShown: 'yes' });
    assert.equal(new SettingsStore(file).get().trayNoticeShown, false, 'only true counts');
    const older = join(dir, 'older.json');
    writeFileSync(older, JSON.stringify({ libraryRoots: ['D:/Music'], closeButtonBehavior: 'minimize-to-tray' }));
    assert.equal(new SettingsStore(older).get().trayNoticeShown, true, 'a profile saved before the notice existed is not told');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- main.ts asks before it hides ----
{
  const main = read('electron/main.ts');
  const createWindow = main.slice(main.indexOf('function createWindow(): BrowserWindow {'));
  const close = createWindow.slice(createWindow.indexOf("win.on('close'"), createWindow.indexOf('A reload after a renderer crash'));
  assert.match(close, /shouldExplainTrayClose\(\{ action, platform: process\.platform, alreadyExplained: settings\.get\(\)\.trayNoticeShown === true \}\)/);
  assert.match(close, /if \(trayCloseNoticeOpen\) return;/, 'a second X while the notice is open waits for it');
  assert.ok(close.indexOf('event.preventDefault()') < close.indexOf('explainTrayClose(win)'), 'the window stays up while the notice is read');

  const explain = main.match(/async function explainTrayClose\(win: BrowserWindow\): Promise<void> \{[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.ok(explain, 'explainTrayClose exists');
  assert.ok(
    explain.indexOf('trayNoticeShown: true') < explain.indexOf('dialog.showMessageBox'),
    'the flag is stored before the dialog opens, so dismissing it any way counts',
  );
  assert.match(explain, /dialog\.showMessageBox\(win, \{[\s\S]*?buttons: \[notice\.keepLabel, notice\.quitLabel\],[\s\S]*?cancelId: 0,/, 'closing the dialog keeps the app running');
  assert.match(explain, /if \(response === 1\) \{\s*isQuitting = true;\s*app\.quit\(\);\s*return;\s*\}/, 'Quit quits');
  assert.match(explain, /if \(!win\.isDestroyed\(\)\) hideMainWindow\(win\);/, 'Keep hides the window as before');
}

console.log('PASS tray close notice: shown once on the first hide to the tray, says how to quit and where to change it');
