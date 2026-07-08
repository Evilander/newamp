import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { readStyleBundle } from './style-bundle.mjs';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const brandLogoSource = await readFile(new URL('../src/components/BrandLogo.tsx', import.meta.url), 'utf8');
const startupSplashSource = await readFile(new URL('../src/components/StartupSplash.tsx', import.meta.url), 'utf8');
const styleSource = await readStyleBundle();
const mainSource = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
const readmeSource = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const releaseGateSource = await readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8');

assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/views\/HomeView'\)/, 'Home view should be route-lazy');
assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/views\/NowPlayingView'\)/, 'Now Playing view should be route-lazy');
assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/CompactPlayer'\)/, 'Deck player should be lazy-loaded');
assert.match(appSource, /lazy\(\(\) =>[\s\S]*?import\('\.\/components\/FullscreenVisualizer'\)/, 'Fullscreen visualizer should be lazy-loaded');
assert.doesNotMatch(appSource, /import \{ HomeView \} from '\.\/components\/views\/HomeView'/, 'HomeView should not be imported eagerly');
assert.doesNotMatch(appSource, /import \{ NowPlayingView \} from '\.\/components\/views\/NowPlayingView'/, 'NowPlayingView should not be imported eagerly');

assert.match(brandLogoSource, /logo-app\.webp/, 'Renderer should use the display-sized app logo');
assert.match(brandLogoSource, /<img[\s\S]*data-newamp-brand-logo/, 'brand logo should render the original image');
assert.doesNotMatch(brandLogoSource, /brand-logo-themed|WebkitMaskImage|maskImage/, 'brand logo should not use theme-colored masks');
assert.doesNotMatch(brandLogoSource, /filter:/, 'brand logo should not tint or recolor the original artwork');
assert.match(startupSplashSource, /withGlow=\{false\}/, 'startup splash logo should not be recolored by skin glow');
assert.match(startupSplashSource, /startup-splash-logo/, 'startup splash should have a dedicated original-logo style hook');
assert.doesNotMatch(startupSplashSource, /startup-splash-wordmark|startup-splash-subtitle/, 'startup splash should render only the circle logo');
assert.match(styleSource, /\.startup-splash\s*\{[\s\S]*?background:\s*transparent;/, 'startup splash should not paint a black overlay');
assert.doesNotMatch(styleSource, /brand-logo-themed/, 'theme-colored logo skin CSS should not ship');
assert.doesNotMatch(styleSource, /\.startup-splash-logo\s*\{[\s\S]*?filter:/, 'startup splash should not add a color-changing logo filter');
assert.match(mainSource, /STARTUP_SPLASH_HOLD_MS = 5600/, 'native startup splash should linger long enough to read the logo');
assert.match(mainSource, /show:\s*false/, 'main window should start hidden behind the native logo splash');
assert.match(mainSource, /createStartupSplashWindow\(\);[\s\S]*?mainWin = createWindow\(\)/, 'native logo splash should open before the main window');
assert.match(mainSource, /closeStartupSplashWindow\(\);[\s\S]*?win\.show\(\)/, 'main window should reveal only after the splash closes');
const appLogo = await stat(new URL('../build/logo-app.webp', import.meta.url));
assert.ok(appLogo.size < 120_000, `display app logo should stay below 120KB, got ${appLogo.size}`);
const readmeLogo = await stat(new URL('../assets/github/logo-readme.png', import.meta.url));
assert.ok(readmeLogo.size < 650_000, `README logo should be mobile-safe and not use the oversized build asset, got ${readmeLogo.size}`);
assert.match(readmeSource, /assets\/github\/logo-readme\.png/, 'README should use the dedicated mobile-safe GitHub logo asset');
assert.doesNotMatch(readmeSource, /<img src="build\/logo\.png"/, 'README should not embed the oversized packaging logo directly');

const assetDir = new URL('../dist/assets/', import.meta.url);
const assets = await readdir(assetDir);
const sourceMaps = assets.filter((asset) => asset.endsWith('.map'));
assert.deepEqual(sourceMaps, [], 'production renderer build should not emit public source maps by default');
const mainScripts = [];
for (const asset of assets) {
  if (!/^(index|main)-.*\.js$/.test(asset)) continue;
  const assetStat = await stat(new URL(asset, assetDir));
  mainScripts.push({ asset, bytes: assetStat.size });
}
assert.ok(mainScripts.length >= 1, 'production build should emit a main index chunk');
const largestMain = mainScripts.sort((a, b) => b.bytes - a.bytes)[0];
// Budget history: 420KB through 1.17; raised to 440KB for 2.0 Reference Grade
// (toast host, THEME_REGISTRY, token bridge, and shared primitives live in the
// main chunk by design — 422.4KB actual at release, ~132KB gzipped).
assert.ok(largestMain.bytes < 440_000, `main renderer chunk should stay below 440KB, got ${largestMain.bytes}`);

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
