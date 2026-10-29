// Unit test for buildAppMenuTemplate (esbuild harness).
// Run: node scripts/app-menu-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/app-menu-test-result.txt');
writeFileSync(RESULT, '[app-menu-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/app-menu.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/app-menu-bundle.mjs'), logLevel: 'silent',
});
const { buildAppMenuTemplate } = await import(pathToFileURL(resolve('tmp/app-menu-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const calls = { preferences: 0, external: [] };
const menuOptions = (isPackaged, withPreferences = true) => ({
  appName: 'NewAmp',
  appVersion: '1.10.0',
  isPackaged,
  ...(withPreferences ? { onPreferences: () => { calls.preferences += 1; } } : {}),
  onOpenExternal: (url) => { calls.external.push(url); },
});
const submenuOf = (template, label) => template.find((item) => item.label === label || item.role === label)?.submenu ?? [];
const rolesOf = (items) => items.map((item) => item.role).filter(Boolean);

const mac = buildAppMenuTemplate('darwin', menuOptions(true));
log.push('darwin top level: ' + JSON.stringify(mac.map((m) => m.label ?? m.role)));
for (const want of ['editMenu', 'window', 'help']) {
  if (!mac.some((item) => item.role === want)) fail(`darwin menu missing role ${want}`);
}
// Cmd+W: the stock windowMenu role has no Close item on macOS.
const windowMenu = submenuOf(mac, 'Window');
for (const want of ['minimize', 'zoom', 'close', 'front']) {
  if (!rolesOf(windowMenu).includes(want)) fail(`darwin Window menu missing role ${want}`);
}

// Cmd+, opens Settings from the app menu.
const appMenu = submenuOf(mac, 'NewAmp');
const preferences = appMenu.find((item) => item.accelerator === 'CmdOrCtrl+,');
if (!preferences) fail('darwin app menu has no item on CmdOrCtrl+,');
else {
  preferences.click?.();
  if (calls.preferences !== 1) fail('the Settings item should call onPreferences');
}
for (const want of ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']) {
  if (!rolesOf(appMenu).includes(want)) fail(`darwin app menu missing role ${want}`);
}
// The package name is "newamp"; the items that name the app must say NewAmp.
for (const role of ['about', 'hide', 'quit']) {
  const label = appMenu.find((item) => item.role === role)?.label ?? '';
  if (!label.includes('NewAmp')) fail(`darwin ${role} item is labelled "${label}", wanted the product name`);
}
const settingsAt = appMenu.findIndex((item) => item.accelerator === 'CmdOrCtrl+,');
const servicesAt = appMenu.findIndex((item) => item.role === 'services');
if (settingsAt === -1 || servicesAt === -1 || settingsAt > servicesAt) fail('Settings should come before Services');

// Without a handler there is no Settings item at all: no dead Cmd+, and no
// doubled separator where it would have been.
const bare = submenuOf(buildAppMenuTemplate('darwin', menuOptions(true, false)), 'NewAmp');
log.push('app menu without a Settings handler: ' + JSON.stringify(bare.map((item) => item.role ?? item.type ?? item.label)));
if (bare.some((item) => item.accelerator === 'CmdOrCtrl+,' || item.label === 'Settings…')) {
  fail('no Settings item should be built when onPreferences is not supplied');
}
if (bare.some((item, index) => item.type === 'separator' && bare[index + 1]?.type === 'separator')) {
  fail('leaving Settings out must not leave two separators in a row');
}
for (const want of ['about', 'services', 'hide', 'quit']) {
  if (!rolesOf(bare).includes(want)) fail(`app menu without Settings missing role ${want}`);
}

// A stray Cmd+R must not reload the page (and stop playback) in a shipped build.
const packagedView = submenuOf(mac, 'View');
log.push('packaged View roles: ' + JSON.stringify(rolesOf(packagedView)));
for (const banned of ['reload', 'forceReload', 'toggleDevTools']) {
  if (rolesOf(packagedView).includes(banned)) fail(`packaged View menu must not include ${banned}`);
}
for (const want of ['togglefullscreen', 'resetZoom', 'zoomIn', 'zoomOut']) {
  if (!rolesOf(packagedView).includes(want)) fail(`packaged View menu missing ${want}`);
}

const devView = submenuOf(buildAppMenuTemplate('darwin', menuOptions(false)), 'View');
log.push('development View roles: ' + JSON.stringify(rolesOf(devView)));
for (const want of ['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen']) {
  if (!rolesOf(devView).includes(want)) fail(`development View menu missing ${want}`);
}

// Help menu links go through the opener the caller supplies.
const help = submenuOf(mac, 'help');
if (help.length < 1) fail('help menu should have entries');
for (const item of help) item.click?.();
if (!calls.external.length || !calls.external.every((url) => url.startsWith('https://github.com/'))) {
  fail('help entries should open https://github.com links, got ' + JSON.stringify(calls.external));
}

// Controls: the Dock menu's transport in the menu bar, between View and Window.
const sent = [];
const withPlayback = (isPlaying) => buildAppMenuTemplate('darwin', { ...menuOptions(true), playback: { isPlaying, onCommand: (c) => sent.push(c) } });
const stopped = withPlayback(false);
const order = stopped.map((m) => m.label ?? m.role);
log.push('darwin top level with playback: ' + JSON.stringify(order));
if (order.indexOf('Controls') !== order.indexOf('View') + 1 || order.indexOf('Window') !== order.indexOf('Controls') + 1) {
  fail('Controls should sit between View and Window');
}
const controls = submenuOf(stopped, 'Controls');
const byLabel = (items, label) => items.find((item) => item.label === label);
if (!byLabel(controls, 'Play') || byLabel(controls, 'Pause')) fail('stopped: Controls should offer Play, not Pause');
if (!byLabel(submenuOf(withPlayback(true), 'Controls'), 'Pause')) fail('playing: Controls should offer Pause');
if (byLabel(controls, 'Next')?.accelerator !== 'Cmd+Right') fail('Next should carry Cmd+Right');
if (byLabel(controls, 'Previous')?.accelerator !== 'Cmd+Left') fail('Previous should carry Cmd+Left');
// Space belongs to the page: a focused button would let it reach the menu.
if (controls.some((item) => /space/i.test(item.accelerator ?? ''))) fail('no Controls item may take Space');
for (const label of ['Play', 'Stop', 'Next', 'Previous']) byLabel(controls, label).click();
if (JSON.stringify(sent) !== JSON.stringify(['toggle-play', 'stop', 'next', 'previous'])) fail('Controls items should send their commands, got ' + JSON.stringify(sent));
if (mac.some((item) => item.label === 'Controls')) fail('without a playback handler there is no Controls menu');

const win = buildAppMenuTemplate('win32', menuOptions(true));
log.push('win32 template length: ' + win.length);
if (win.length !== 0) fail('non-darwin should return an empty template (keep current chromeless behavior)');

const report = log.join('\n') + '\n' + (pass ? '[app-menu-test] PASS' : '[app-menu-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
