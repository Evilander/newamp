// The Settings row for the window's close button names what actually keeps the
// app running on each platform (the Dock on a Mac, the tray elsewhere) and says
// what happens without a tray.
// Run: node scripts/close-button-copy-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { code } = await transform(read('src/lib/close-button-copy.ts'), { loader: 'ts', format: 'esm' });
const { closeButtonCopy } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const mac = closeButtonCopy('darwin');
assert.equal(mac.label, 'Close button', 'a Mac has no X to point at');
assert.equal(mac.keepRunning, 'Keep playing in the Dock');
assert.equal(mac.quit, 'Quit NewAmp');
assert.match(mac.hint, /Cmd\+Q/, 'the Mac hint names the way to quit from the keyboard');
assert.doesNotMatch(JSON.stringify(mac), /tray/i, 'the Mac copy never mentions a tray');

for (const platform of ['win32', 'linux']) {
  const copy = closeButtonCopy(platform);
  assert.equal(copy.label, 'Close button (X)', `${platform} keeps the X wording`);
  assert.equal(copy.keepRunning, 'Minimize to tray');
  assert.equal(copy.quit, 'Close the app');
  assert.match(copy.hint, /Without a tray icon, X minimizes to the taskbar/, `${platform} says what happens with no tray`);
  assert.doesNotMatch(JSON.stringify(copy), /Dock/, `${platform} copy never mentions the Dock`);
}

// The row is built from that copy and still stores the same two values.
const settings = read('src/components/views/SettingsView.tsx');
assert.match(settings, /const CLOSE_BUTTON_COPY = closeButtonCopy\(api\.platform\);/);
assert.match(settings, /<Row label=\{CLOSE_BUTTON_COPY\.label\}>/);
assert.match(settings, /aria-label=\{CLOSE_BUTTON_COPY\.label\}/);
assert.match(settings, /<option value="minimize-to-tray">\{CLOSE_BUTTON_COPY\.keepRunning\}<\/option>/);
assert.match(settings, /<option value="close-app">\{CLOSE_BUTTON_COPY\.quit\}<\/option>/);
assert.match(settings, /data-newamp-close-button-behavior/, 'the row keeps its test hook');

console.log('[close-button-copy-test] PASS');
