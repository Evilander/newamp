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
assert.equal(settings.get().alwaysOnTop, false, 'always-on-top should default to off');
assert.equal(settings.get().visualizerPreset, 'spectrum', 'visualizer preset should default to spectrum');

const compactSaved = settings.set({ compactMode: true });
assert.equal(compactSaved.compactMode, true, 'compact deck preference should save');
assert.equal(new SettingsStore(settingsPath).get().compactMode, true, 'compact deck preference should reload');

const pinnedSaved = settings.set({ alwaysOnTop: true });
assert.equal(pinnedSaved.alwaysOnTop, true, 'always-on-top preference should save');
assert.equal(new SettingsStore(settingsPath).get().alwaysOnTop, true, 'always-on-top preference should reload');
assert.equal(settings.set({ alwaysOnTop: 'yes' }).alwaysOnTop, false, 'always-on-top should reject non-boolean values');

const normalized = settings.set({ compactMode: 'yes' });
assert.equal(normalized.compactMode, false, 'compact deck preference should reject non-boolean values');

const visualizerSaved = settings.set({ visualizerPreset: 'galaxy' });
assert.equal(visualizerSaved.visualizerPreset, 'galaxy', 'visualizer preset should save');
assert.equal(new SettingsStore(settingsPath).get().visualizerPreset, 'galaxy', 'visualizer preset should reload');
assert.equal(settings.set({ visualizerPreset: 'bogus' }).visualizerPreset, 'spectrum', 'visualizer preset should reject unknown values');

const [typesSource, settingsSource, storeSource, appSource, titleBarSource, compactSource, preloadSource, apiSource, viteEnvSource, fullscreenSource, packageSource, gateSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/TitleBar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/CompactPlayer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/vite-env.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/FullscreenVisualizer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /compactMode: boolean/, 'AppSettings should include compact deck persistence');
assert.match(typesSource, /alwaysOnTop: boolean/, 'AppSettings should include always-on-top persistence');
assert.match(typesSource, /visualizerPreset: VisualizerPreset/, 'AppSettings should include visualizer preset persistence');
assert.match(settingsSource, /compactMode: false/, 'SettingsStore should default compact mode to false');
assert.match(settingsSource, /alwaysOnTop: false/, 'SettingsStore should default always-on-top to false');
assert.match(settingsSource, /parsed\.compactMode === true/, 'SettingsStore should normalize loaded compact mode');
assert.match(settingsSource, /parsed\.alwaysOnTop === true/, 'SettingsStore should normalize loaded always-on-top');
assert.match(settingsSource, /patch\.compactMode === true/, 'SettingsStore should normalize patched compact mode');
assert.match(settingsSource, /patch\.alwaysOnTop === true/, 'SettingsStore should normalize patched always-on-top');
assert.match(settingsSource, /normalizeVisualizerPreset/, 'SettingsStore should normalize visualizer presets');
assert.match(storeSource, /compactMode: settings\.compactMode/, 'player store should initialize compact mode from settings');
assert.match(storeSource, /alwaysOnTop: settings\.alwaysOnTop/, 'player store should initialize always-on-top from settings');
assert.match(storeSource, /setSettings\(\{ compactMode: on \}\)/, 'player store should persist compact mode changes');
assert.match(storeSource, /setSettings\(\{ alwaysOnTop: on \}\)/, 'player store should persist always-on-top changes');
assert.match(storeSource, /vizPreset: settings\.visualizerPreset/, 'player store should initialize visualizer preset from settings');
assert.match(storeSource, /setSettings\(\{ visualizerPreset: name \}\)/, 'player store should persist visualizer preset changes');
assert.match(appSource, /winctl\.setCompact\(compact\)/, 'renderer should sync compact mode to the native window');
assert.match(appSource, /winctl\.setAlwaysOnTop\(compact \|\| alwaysOnTop\)/, 'renderer should sync pinned/native topmost state');
assert.match(preloadSource, /win:set-always-on-top/, 'preload should expose always-on-top IPC');
assert.match(apiSource, /setAlwaysOnTop/, 'renderer window-control API should expose always-on-top');
assert.match(viteEnvSource, /setAlwaysOnTop/, 'window control types should include always-on-top');
assert.match(titleBarSource, /PIN/, 'title bar should expose a pin button');
assert.match(titleBarSource, /setAlwaysOnTop\(!alwaysOnTop\)/, 'title bar pin should toggle persisted topmost state');
assert.match(compactSource, /setAlwaysOnTop\(!alwaysOnTop\)/, 'compact deck should expose the same pin toggle');
assert.match(titleBarSource, /api\.appVersion/, 'title bar should display the real app version');
assert.doesNotMatch(titleBarSource, /v0\.1/, 'title bar should not show stale pre-release version text');

for (const marker of ['\u00c3', '\u00e2', '\ufffd']) {
  assert.equal(titleBarSource.includes(marker), false, 'title bar controls should not contain mojibake glyphs');
  assert.equal(fullscreenSource.includes(marker), false, 'fullscreen visualizer controls should not contain mojibake glyphs');
}

assert.match(packageSource, /"smoke:chrome-state"/, 'package.json should expose chrome state smoke');
assert.match(gateSource, /'smoke:chrome-state'/, 'release gate should run chrome state smoke');

console.log(
  JSON.stringify(
    {
      ok: true,
      compactModePersists: true,
      visualizerPresetPersists: true,
      titleBarVersion: true,
    },
    null,
    2,
  ),
);
