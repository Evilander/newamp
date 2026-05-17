import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const brandLogoSource = await readFile(new URL('../src/components/BrandLogo.tsx', import.meta.url), 'utf8');
const startupSplashSource = await readFile(new URL('../src/components/StartupSplash.tsx', import.meta.url), 'utf8');
const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
const releaseGateSource = await readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8');

assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/views\/HomeView'\)/, 'Home view should be route-lazy');
assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/views\/NowPlayingView'\)/, 'Now Playing view should be route-lazy');
assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/CompactPlayer'\)/, 'Deck player should be lazy-loaded');
assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/FullscreenVisualizer'\)/, 'Fullscreen visualizer should be lazy-loaded');
assert.doesNotMatch(appSource, /import \{ HomeView \} from '\.\/components\/views\/HomeView'/, 'HomeView should not be imported eagerly');
assert.doesNotMatch(appSource, /import \{ NowPlayingView \} from '\.\/components\/views\/NowPlayingView'/, 'NowPlayingView should not be imported eagerly');

assert.match(brandLogoSource, /logo-app\.webp/, 'Renderer should use the display-sized app logo');
assert.match(startupSplashSource, /themed=\{false\}/, 'startup splash should use the original logo colors');
assert.match(startupSplashSource, /withGlow=\{false\}/, 'startup splash logo should not be recolored by skin glow');
assert.match(startupSplashSource, /startup-splash-logo/, 'startup splash should have a dedicated original-logo style hook');
const appLogo = await stat(new URL('../build/logo-app.webp', import.meta.url));
assert.ok(appLogo.size < 120_000, `display app logo should stay below 120KB, got ${appLogo.size}`);

const assetDir = new URL('../dist/assets/', import.meta.url);
const assets = await readdir(assetDir);
const sourceMaps = assets.filter((asset) => asset.endsWith('.map'));
assert.deepEqual(sourceMaps, [], 'production renderer build should not emit public source maps by default');
const mainScripts = [];
for (const asset of assets) {
  if (!/^index-.*\.js$/.test(asset)) continue;
  const assetStat = await stat(new URL(asset, assetDir));
  mainScripts.push({ asset, bytes: assetStat.size });
}
assert.ok(mainScripts.length >= 1, 'production build should emit a main index chunk');
const largestMain = mainScripts.sort((a, b) => b.bytes - a.bytes)[0];
assert.ok(largestMain.bytes < 420_000, `main renderer chunk should stay below 420KB, got ${largestMain.bytes}`);

assert.match(packageSource, /"smoke:startup-bundle"/, 'package.json must expose startup bundle smoke');
assert.match(releaseGateSource, /'smoke:startup-bundle'/, 'release gate must run startup bundle smoke');
const viteConfigSource = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
assert.match(viteConfigSource, /NEWAMP_SOURCE_MAPS/, 'source maps should remain opt-in for debug builds');
assert.doesNotMatch(viteConfigSource, /sourcemap:\s*true/, 'production source maps should not be forced on');

console.log(JSON.stringify({
  ok: true,
  appLogoBytes: appLogo.size,
  mainChunk: largestMain,
  sourceMaps: sourceMaps.length,
}, null, 2));
