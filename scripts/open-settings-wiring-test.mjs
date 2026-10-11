// Cmd+, on a Mac sends 'app:open-settings' from the main process. The renderer
// end of that channel has to exist in the preload, the API type, the browser
// stub and App, or the menu item raises the window and does nothing else.
// Run: node scripts/open-settings-wiring-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const preload = read('electron/preload.ts');
const types = read('shared/types.ts');
const apiStub = read('src/lib/api.ts');
const app = read('src/App.tsx');

assert.match(
  preload,
  /onOpenSettings:\s*\(cb\)\s*=>\s*\{\s*const handler = \(\) => cb\(\);\s*ipcRenderer\.on\('app:open-settings', handler\);\s*return \(\) => ipcRenderer\.off\('app:open-settings', handler\);\s*\},/,
  'the preload subscribes to app:open-settings and hands back an unsubscribe',
);
assert.match(types, /onOpenSettings: \(cb: \(\) => void\) => \(\) => void;/, 'NewAmpAPI types onOpenSettings');
assert.match(apiStub, /onOpenSettings: \(\) => \(\) => undefined,/, 'the browser stub has a no-op onOpenSettings');

// App opens Settings with openView, which leaves a compact deck or the
// fullscreen visualizer first (the sidebar is not reachable from either), and
// lets go of the listener on unmount.
assert.match(
  app,
  /const offOpenSettings = api\.onOpenSettings\(\(\) => \{\s*usePlayerStore\.getState\(\)\.openView\('settings'\);\s*\}\);/,
  'App switches to the Settings view when the main process asks',
);
assert.match(app, /offOpenSettings\(\);/, 'App unsubscribes on cleanup');

console.log('[open-settings-wiring-test] PASS');
