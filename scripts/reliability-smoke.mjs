import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { SettingsStore } from '../dist-electron/electron/settings.js';

const smokeRoot = resolve('tmp', 'reliability-smoke');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const settingsPath = join(smokeRoot, 'settings.json');
await writeFile(settingsPath, '{ broken json', 'utf8');
const settings = new SettingsStore(settingsPath);
assert.deepEqual(settings.get().libraryRoots, [], 'corrupt settings should recover to defaults');
assert.ok(settings.recoveryEvents.length > 0, 'settings recovery should record a diagnostic event');
assert.equal(settings.recoveryEvents[0].store, 'settings');
assert.ok(existsSync(settings.recoveryEvents[0].backupPath), 'corrupt settings should be quarantined');
assert.ok(
  readdirSync(smokeRoot).some((name) => name.startsWith('settings.json.corrupt-')),
  'settings quarantine file should be discoverable next to settings.json',
);

const libraryPath = join(smokeRoot, 'library.db');
await writeFile(libraryPath, Buffer.from('not a sqlite database'));
const library = await LibraryStore.open(libraryPath);
assert.ok(library.recoveryEvents.length > 0, 'library recovery should record a diagnostic event');
assert.equal(library.recoveryEvents[0].store, 'library');
assert.ok(existsSync(library.recoveryEvents[0].backupPath), 'corrupt library DB should be quarantined');
assert.equal(library.getStats().tracks, 0, 'recovered library should open as an empty catalog');
library.close();

const [packageSource, preloadSource, settingsViewSource, mainSource] = await Promise.all([
  import('node:fs/promises').then((fs) => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
  import('node:fs/promises').then((fs) => fs.readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8')),
  import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8')),
  import('node:fs/promises').then((fs) => fs.readFile(new URL('../electron/main.ts', import.meta.url), 'utf8')),
]);

assert.match(packageSource, /"smoke:reliability"/, 'package.json should expose the reliability smoke');
assert.match(preloadSource, /getSupportDiagnostics/, 'preload should expose support diagnostics');
assert.match(settingsViewSource, /Support Diagnostics/, 'Settings should expose support diagnostics');
assert.match(settingsViewSource, /Show crash log/, 'Settings should expose local crash diagnostics');
assert.match(mainSource, /OPEN_DEVTOOLS/, 'devtools should be opt-in so normal dev launches stay usable');
assert.match(mainSource, /crashDumpsPath/, 'support diagnostics should include the local crash dump path');
assert.match(mainSource, /openDevTools/, 'main window should still support explicit devtools opening');

console.log(
  JSON.stringify(
    {
      ok: true,
      settingsBackup: settings.recoveryEvents[0].backupPath,
      libraryBackup: library.recoveryEvents[0].backupPath,
    },
    null,
    2,
  ),
);
