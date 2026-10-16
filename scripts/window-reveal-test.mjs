// A window created hidden is shown from ready-to-show. On native Wayland
// Chromium sometimes never sends it, which left the main window, its splash
// and the projector invisible while the app ran on. On Linux a timer after the
// page loaded now shows the window anyway; whichever comes first wins.
//
// Also pins the Linux window icon: the PNG ships in the app's resources and
// the main process hands it to every window.
// Run: node scripts/window-reveal-test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const read = (path) => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');

mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('electron/window-lifecycle-policy.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/window-reveal-bundle.mjs'), logLevel: 'silent',
});
const { createRevealGate, revealWhenReady, LINUX_REVEAL_FALLBACK_MS } = await import(
  pathToFileURL(resolve('tmp/window-reveal-bundle.mjs')).href
);

// A BrowserWindow as far as the reveal sees it, with a clock the test drives.
function fakeWindow() {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.timers = [];
  win.setTimer = (callback, ms) => { win.timers.push({ callback, ms }); return win.timers.length; };
  win.runTimers = () => { for (const timer of win.timers.splice(0)) timer.callback(); };
  return win;
}

// ---- the gate: first wins ----
{
  let shown = 0;
  const gate = createRevealGate(() => { shown += 1; });
  assert.equal(gate.revealed, false);
  assert.equal(gate.trigger(), true);
  assert.equal(gate.trigger(), false, 'a second trigger does nothing');
  assert.equal(shown, 1);
  assert.equal(gate.revealed, true);
}

// ---- ready-to-show alone shows the window once, on every platform ----
for (const platform of ['win32', 'darwin', 'linux']) {
  const win = fakeWindow();
  let shown = 0;
  revealWhenReady(win, () => { shown += 1; }, { platform, setTimer: win.setTimer });
  win.emit('ready-to-show');
  win.emit('ready-to-show');
  assert.equal(shown, 1, `${platform}: ready-to-show reveals once`);
}

// ---- Wayland: ready-to-show never comes, the load finishing is enough ----
{
  const win = fakeWindow();
  let shown = 0;
  revealWhenReady(win, () => { shown += 1; }, { platform: 'linux', setTimer: win.setTimer });
  assert.equal(win.timers.length, 0, 'nothing is armed before the page has loaded');
  win.webContents.emit('did-finish-load');
  assert.equal(win.timers.length, 1);
  assert.equal(win.timers[0].ms, LINUX_REVEAL_FALLBACK_MS, 'the fallback waits the stated time');
  assert.equal(shown, 0, 'not shown before the timer');
  win.runTimers();
  assert.equal(shown, 1, 'the window is shown without ready-to-show');
  win.emit('ready-to-show');
  assert.equal(shown, 1, 'a late ready-to-show does not show it again');
}

// ---- ready-to-show first: the later timer is a no-op ----
{
  const win = fakeWindow();
  let shown = 0;
  revealWhenReady(win, () => { shown += 1; }, { platform: 'linux', setTimer: win.setTimer });
  win.webContents.emit('did-finish-load');
  win.emit('ready-to-show');
  assert.equal(shown, 1);
  win.runTimers();
  assert.equal(shown, 1, 'the fallback does not reveal twice');
}

// ---- a page that failed to load is still shown, once ----
{
  const win = fakeWindow();
  let shown = 0;
  revealWhenReady(win, () => { shown += 1; }, { platform: 'linux', setTimer: win.setTimer });
  win.webContents.emit('did-fail-load');
  win.webContents.emit('did-finish-load');
  assert.equal(win.timers.length, 1, 'a failed load and a finished one arm a single timer');
  win.runTimers();
  assert.equal(shown, 1);
}

// ---- a window destroyed before the timer is left alone ----
{
  const win = fakeWindow();
  let shown = 0;
  revealWhenReady(win, () => { shown += 1; }, { platform: 'linux', setTimer: win.setTimer });
  win.webContents.emit('did-finish-load');
  win.destroyed = true;
  win.runTimers();
  assert.equal(shown, 0, 'a destroyed window is not shown');
}

// ---- Windows and macOS keep waiting for ready-to-show; no timer ----
for (const platform of ['win32', 'darwin']) {
  const win = fakeWindow();
  let shown = 0;
  revealWhenReady(win, () => { shown += 1; }, { platform, setTimer: win.setTimer });
  win.webContents.emit('did-finish-load');
  assert.equal(win.timers.length, 0, `${platform}: no fallback timer`);
  win.runTimers();
  assert.equal(shown, 0, `${platform}: still waits for ready-to-show`);
}

// ---- every hidden window in the main process goes through it ----
{
  const main = read('electron/main.ts');
  assert.doesNotMatch(main, /\.once\('ready-to-show'/, 'no window waits on ready-to-show alone');
  const uses = main.match(/revealWhenReady\(/g) ?? [];
  assert.equal(uses.length, 4, 'main window, projector, splash and tab windows');
  for (const [label, pattern] of [
    ['main window', /revealWhenReady\(win, \(\) => \{\n {4}if \(smokeMode\) return;/],
    ['projector', /revealWhenReady\(win, \(\) => \{\n {4}if \(!detachedVizWin \|\| detachedVizWin\.isDestroyed\(\)\) return;/],
    ['splash', /revealWhenReady\(startupSplashWin, \(\) => \{/],
    ['tab window', /revealWhenReady\(win, \(\) => win\.show\(\), \{ platform: process\.platform \}\);/],
  ]) {
    assert.match(main, pattern, `${label} is revealed through revealWhenReady`);
  }
}

// ---- the Linux window icon ----
{
  const main = read('electron/main.ts');
  const icon = main.match(/function resolveWindowIconPath\(\): string \| undefined \{[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.match(icon, /if \(process\.platform === 'linux'\) return resolveLinuxWindowIconPath\(\);/, 'Linux gets an icon path');
  assert.match(icon, /return resolveTrayIconPath\(\) \?\? undefined;/, 'Windows keeps the .ico');
  const linux = main.match(/function resolveLinuxWindowIconPath\(\): string \| undefined \{[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.match(linux, /join\(process\.resourcesPath, 'build', 'icon\.png'\)/, 'the packaged location');
  assert.match(linux, /join\(app\.getAppPath\(\), 'build', 'icon\.png'\)/, 'the development location');
  assert.match(linux, /app\.asar/, 'a path inside the asar is skipped, the window manager cannot open it');

  // The PNG is a real file and the Linux package carries it next to the app.
  assert.ok(existsSync(resolve('build/icon.png')), 'build/icon.png exists');
  const png = readFileSync(resolve('build/icon.png'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'it is a PNG');
  const pkg = JSON.parse(read('package.json'));
  const extra = pkg.build.extraResources.find((entry) => entry.to === 'build');
  assert.ok(extra?.filter?.includes('icon.png'), 'build/icon.png ships in the resources folder');
}

console.log('PASS window reveal: ready-to-show or the Linux load timer, whichever is first, for every hidden window; Linux icon');
