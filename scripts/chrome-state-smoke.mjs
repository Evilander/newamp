import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from '../dist-electron/electron/settings.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'chrome-state-smoke');
const settingsPath = join(smokeRoot, 'settings.json');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const settings = new SettingsStore(settingsPath);
assert.equal(settings.get().compactMode, false, 'compact deck should default to full library mode');

const compactSaved = settings.set({ compactMode: true });
assert.equal(compactSaved.compactMode, true, 'compact deck preference should save');
assert.equal(new SettingsStore(settingsPath).get().compactMode, true, 'compact deck preference should reload');

const normalized = settings.set({ compactMode: 'yes' });
assert.equal(normalized.compactMode, false, 'compact deck preference should reject non-boolean values');

const [typesSource, settingsSource, storeSource, appSource, titleBarSource, packageSource, gateSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/TitleBar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /compactMode: boolean/, 'AppSettings should include compact deck persistence');
assert.match(settingsSource, /compactMode: false/, 'SettingsStore should default compact mode to false');
assert.match(settingsSource, /parsed\.compactMode === true/, 'SettingsStore should normalize loaded compact mode');
assert.match(settingsSource, /patch\.compactMode === true/, 'SettingsStore should normalize patched compact mode');
assert.match(storeSource, /compactMode: settings\.compactMode/, 'player store should initialize compact mode from settings');
assert.match(storeSource, /setSettings\(\{ compactMode: on \}\)/, 'player store should persist compact mode changes');
assert.match(appSource, /winctl\.setCompact\(compact\)/, 'renderer should sync compact mode to the native window');
assert.match(titleBarSource, /api\.appVersion/, 'title bar should display the real app version');
assert.doesNotMatch(titleBarSource, /v0\.1/, 'title bar should not show stale pre-release version text');

for (const marker of ['\u00c3', '\u00e2', '\ufffd']) {
  assert.equal(titleBarSource.includes(marker), false, 'title bar controls should not contain mojibake glyphs');
}

assert.match(packageSource, /"smoke:chrome-state"/, 'package.json should expose chrome state smoke');
assert.match(gateSource, /'smoke:chrome-state'/, 'release gate should run chrome state smoke');

console.log(
  JSON.stringify(
    {
      ok: true,
      compactModePersists: true,
      titleBarVersion: true,
    },
    null,
    2,
  ),
);
