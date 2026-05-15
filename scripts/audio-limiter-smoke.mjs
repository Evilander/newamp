import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeLimiterEnabled, normalizePreampDb, preampDbToLinear } from '../dist-electron/shared/audio-limiter.js';
import { SettingsStore } from '../dist-electron/electron/settings.js';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'audio-limiter-smoke');
const settingsPath = join(smokeRoot, 'settings.json');

await rm(smokeRoot, { recursive: true, force: true });

assert.equal(normalizeLimiterEnabled(undefined), true, 'limiter should default on');
assert.equal(normalizeLimiterEnabled(false), false, 'limiter toggle should preserve explicit off');
assert.equal(normalizePreampDb(-40), -12, 'preamp should clamp low cuts');
assert.equal(normalizePreampDb(7.2), 6, 'preamp should clamp unsafe boosts');
assert.equal(normalizePreampDb(1.26), 1.5, 'preamp should snap to half-dB steps');
assert.equal(Number(preampDbToLinear(6).toFixed(6)), 1.995262, 'preamp gain should use dB to linear conversion');

const settings = new SettingsStore(settingsPath);
assert.equal(settings.get().limiterEnabled, true, 'settings default should enable clipping protection');
assert.equal(settings.get().preampDb, 0, 'settings default should keep neutral preamp');

const saved = settings.set({ limiterEnabled: false, preampDb: 9.1 });
assert.equal(saved.limiterEnabled, false, 'settings should persist explicit limiter off');
assert.equal(saved.preampDb, 6, 'settings should normalize preamp on write');

const reloaded = new SettingsStore(settingsPath).get();
assert.equal(reloaded.limiterEnabled, false, 'limiter setting should reload from disk');
assert.equal(reloaded.preampDb, 6, 'preamp setting should reload from disk');

const [typesSource, engineSource, storeSource, settingsViewSource, apiSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /limiterEnabled/, 'AppSettings should persist limiter enablement');
assert.match(typesSource, /preampDb/, 'AppSettings should persist preamp dB');
assert.match(engineSource, /createDynamicsCompressor/, 'AudioEngine should use Web Audio compression for clipping protection');
assert.match(engineSource, /setLimiterEnabled/, 'AudioEngine should expose limiter control');
assert.match(engineSource, /setPreampDb/, 'AudioEngine should expose preamp control');
assert.match(storeSource, /setLimiterEnabled/, 'player store should apply limiter settings');
assert.match(storeSource, /setPreampDb/, 'player store should apply preamp settings');
assert.match(settingsViewSource, /Clipping protection/, 'Settings should expose limiter controls');
assert.match(settingsViewSource, /Preamp/, 'Settings should expose preamp controls');
assert.match(apiSource, /limiterEnabled/, 'browser defaults should include limiter settings');
assert.match(packageSource, /smoke:audio-limiter/, 'package scripts should include the limiter smoke');

console.log(JSON.stringify({ ok: true, limiterEnabled: reloaded.limiterEnabled, preampDb: reloaded.preampDb }, null, 2));
