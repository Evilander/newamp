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
assert.equal(settings.get().visualizerPreset, 'neon-waves', 'visualizer preset should default to Xbox-style Neon Waves');
assert.equal(settings.get().firstLaunchTutorialSeen, false, 'first-launch tutorial should show by default');
assert.equal(settings.get().textScale, 1, 'text scale should default to 100%');

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
assert.equal(settings.set({ visualizerPreset: 'plasma-grid' }).visualizerPreset, 'plasma-grid', 'Xbox-style Plasma Grid preset should save');
assert.equal(settings.set({ visualizerPreset: 'bogus' }).visualizerPreset, 'neon-waves', 'visualizer preset should reject unknown values');
assert.equal(settings.set({ firstLaunchTutorialSeen: true }).firstLaunchTutorialSeen, true, 'first-launch tutorial completion should save');
assert.equal(new SettingsStore(settingsPath).get().firstLaunchTutorialSeen, true, 'first-launch tutorial completion should reload');
assert.equal(settings.set({ textScale: 1.25 }).textScale, 1.25, 'text scale should save');
assert.equal(settings.set({ textScale: 9 }).textScale, 1.35, 'text scale should clamp oversized values');

const [typesSource, settingsSource, storeSource, appSource, titleBarSource, compactSource, preloadSource, apiSource, viteEnvSource, fullscreenSource, mainSource, packageSource, gateSource, startupSource, firstLaunchSource, appVersionSource, customSkinSource, lastfmProofSource, liveServicesSource, openAiAssistSource, linerNotesSource] =
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
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/StartupSplash.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/FirstLaunchTutorial.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../shared/app-version.ts', import.meta.url), 'utf8'),
    readFile(new URL('../shared/custom-skin.ts', import.meta.url), 'utf8'),
    readFile(new URL('./lastfm-live-proof.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./live-services-readiness-smoke.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../electron/openai-assist.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/LinerNotesPanel.tsx', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /compactMode: boolean/, 'AppSettings should include compact deck persistence');
assert.match(typesSource, /alwaysOnTop: boolean/, 'AppSettings should include always-on-top persistence');
assert.match(typesSource, /visualizerPreset: VisualizerPreset/, 'AppSettings should include visualizer preset persistence');
assert.match(typesSource, /openaiApiKey: string \| null/, 'AppSettings should include optional ChatGPT assist key persistence');
assert.match(typesSource, /firstLaunchTutorialSeen: boolean/, 'AppSettings should persist first-launch tutorial state');
assert.match(settingsSource, /compactMode: false/, 'SettingsStore should default compact mode to false');
assert.match(settingsSource, /alwaysOnTop: false/, 'SettingsStore should default always-on-top to false');
assert.match(settingsSource, /parsed\.compactMode === true/, 'SettingsStore should normalize loaded compact mode');
assert.match(settingsSource, /parsed\.alwaysOnTop === true/, 'SettingsStore should normalize loaded always-on-top');
assert.match(settingsSource, /patch\.compactMode === true/, 'SettingsStore should normalize patched compact mode');
assert.match(settingsSource, /patch\.alwaysOnTop === true/, 'SettingsStore should normalize patched always-on-top');
assert.match(settingsSource, /normalizeVisualizerPreset/, 'SettingsStore should normalize visualizer presets');
assert.match(settingsSource, /normalizeOpenAiModel/, 'SettingsStore should normalize ChatGPT assist model names');
assert.match(settingsSource, /openaiModel: 'gpt-5\.4-mini'/, 'ChatGPT assist should default to a current cost-sensitive OpenAI model');
assert.match(settingsSource, /firstLaunchTutorialSeen: false/, 'SettingsStore should default first-launch tutorial to visible');
assert.match(settingsSource, /patch\.firstLaunchTutorialSeen === true/, 'SettingsStore should normalize patched first-launch tutorial state');
assert.match(storeSource, /compactMode: settings\.compactMode/, 'player store should initialize compact mode from settings');
assert.match(storeSource, /alwaysOnTop: settings\.alwaysOnTop/, 'player store should initialize always-on-top from settings');
assert.match(storeSource, /setSettings\(\{ compactMode: on \}\)/, 'player store should persist compact mode changes');
assert.match(storeSource, /setSettings\(\{ alwaysOnTop: on \}\)/, 'player store should persist always-on-top changes');
assert.match(storeSource, /vizPreset: settings\.visualizerPreset/, 'player store should initialize visualizer preset from settings');
assert.match(storeSource, /setSettings\(\{ visualizerPreset: name \}\)/, 'player store should persist visualizer preset changes');
assert.match(appSource, /winctl\.setCompact\(compact\)/, 'renderer should sync compact mode to the native window');
assert.match(appSource, /winctl\.setAlwaysOnTop\(compact \|\| alwaysOnTop\)/, 'renderer should sync pinned/native topmost state');
assert.match(appSource, /\{fullscreen && <FullscreenVisualizer \/>\}/, 'fullscreen visualizer should render outside app chrome');
assert.match(appSource, /StartupSplash/, 'app should show the NewAmp logo on launch');
assert.match(appSource, /FirstLaunchTutorial/, 'app should show first-launch tutorial');
assert.match(appSource, /setShowSplash\(false\), 3600/, 'startup logo animation should remain visible long enough to see');
assert.match(startupSource, /BrandLogo size=\{220\}/, 'startup splash should use the large current NewAmp logo');
assert.match(appSource, /AboutView/, 'app should expose an About view');
assert.match(settingsSource, /textScale/, 'settings should persist global text scale');
assert.match(appSource, /--newamp-text-scale/, 'app should apply persisted text scale to the document');
assert.match(packageSource, /"productName": "NewAmp"/, 'package product name should use NewAmp casing');
assert.equal(packageSource.includes('\u00e2'), false, 'package metadata should not contain mojibake text');
assert.match(mainSource, /'NewAmp', 'session-data'/, 'normal session data should use current NewAmp casing');
assert.match(customSkinSource, /NewAmp Custom/, 'custom skin defaults should use current NewAmp casing');
assert.match(customSkinSource, /valid NewAmp custom skin/, 'custom skin errors should use current NewAmp casing');
assert.match(lastfmProofSource, /'NewAmp', 'settings\.json'/, 'Last.fm proof should check current NewAmp settings path');
assert.match(liveServicesSource, /'NewAmp', 'settings\.json'/, 'live service proof should check current NewAmp settings path');
const packageVersion = JSON.parse(packageSource).version;
assert.match(appVersionSource, new RegExp(`NEWAMP_VERSION = '${escapeRegExp(packageVersion)}'`), 'shared app version should match package.json');
assert.match(appVersionSource, /NewAmp\/\$\{NEWAMP_VERSION\}/, 'shared user agent should use current NewAmp casing');
assert.match(firstLaunchSource, /data-newamp-first-launch-tutorial/, 'first-launch tutorial should expose a stable UI marker');
assert.match(firstLaunchSource, /data-newamp-openai-key-prompt/, 'first-launch tutorial should prompt for a ChatGPT API key');
assert.match(typesSource, /generateLinerNotes: \(input: AiLinerNotesInput\)/, 'shared API should expose native ChatGPT liner notes');
assert.match(preloadSource, /ai:liner-notes/, 'preload should expose native ChatGPT liner notes IPC');
assert.match(mainSource, /generateOpenAiLinerNotes/, 'main process should own ChatGPT assist calls');
assert.match(openAiAssistSource, /https:\/\/api\.openai\.com\/v1\/responses/, 'ChatGPT assist should use the Responses API');
assert.match(openAiAssistSource, /store: false/, 'ChatGPT assist should disable response storage');
assert.match(openAiAssistSource, /type: 'json_schema'/, 'ChatGPT assist should request structured liner notes');
assert.match(linerNotesSource, /data-newamp-ai-liner-notes/, 'On Air liner notes should render ChatGPT assist output');
assert.match(storeSource, /fullscreenViz: on \? false : get\(\)\.fullscreenViz/, 'entering compact deck should clear fullscreen visualizer state');
assert.match(mainSource, /setResizable\(false\)/, 'compact deck window should lock user resizing');
assert.match(mainSource, /setResizable\(true\)/, 'full library window should restore resizing');
assert.match(mainSource, /NEWAMP_DISABLE_HARDWARE_ACCELERATION/, 'main process should expose explicit rendering-mode controls');
assert.match(preloadSource, /win:set-always-on-top/, 'preload should expose always-on-top IPC');
assert.match(apiSource, /setAlwaysOnTop/, 'renderer window-control API should expose always-on-top');
assert.match(viteEnvSource, /setAlwaysOnTop/, 'window control types should include always-on-top');
assert.match(titleBarSource, /PIN/, 'title bar should expose a pin button');
assert.match(titleBarSource, /setAlwaysOnTop\(!alwaysOnTop\)/, 'title bar pin should toggle persisted topmost state');
assert.match(compactSource, /onSetAlwaysOnTop: setAlwaysOnTop/, 'compact deck should expose the same pin toggle');
assert.match(compactSource, /setCompact\(true, deck\.size\)/, 'compact deck should force the native window to the selected skin size');
assert.match(mainSource, /resolveTrayIconImage/, 'tray should use the packaged NewAmp logo/icon asset');
assert.doesNotMatch(packageSource, /generate-icon\.mjs/, 'package scripts must not regenerate and overwrite custom icons');
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
