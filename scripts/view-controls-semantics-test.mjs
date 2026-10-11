// Roles, names and pressed state on the controls the views draw, the text-role
// colour tokens at the call sites that paint plain text, and the shared Today
// pick. The score control and the About data row are rendered; the views that
// need the player store are pinned at the source.
// Run: node scripts/view-controls-semantics-test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

async function load(entry, plugins = []) {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
    plugins,
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  vm.compileFunction(bundled.outputFiles[0].text, ['module', 'exports', 'require'])(mod, mod.exports, require);
  return mod.exports;
}
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// --- ScoreRating names and value text ---
{
  const { ScoreRating, scoreValueText, scoreTier } = await load('src/components/ScoreRating.tsx');
  const render = (value, stars = 0) => renderToStaticMarkup(createElement(ScoreRating, { value, stars, onChange() {} }));

  const rated = render(88.3, 4);
  assert.match(rated, /<input[^>]*aria-label="Score out of 100"/, 'the number field is named');
  assert.match(rated, /role="slider"[^>]*aria-label="Rating"/, 'the bar has a fixed name');
  assert.doesNotMatch(rated, /aria-label="Rating 88/, 'the value is not packed into the name');
  assert.match(rated, /aria-valuenow="88.3"[^>]*aria-valuetext="88.3 out of 100, top tier"/, 'the bar reads the score and tier');
  assert.match(rated, /<span[^>]*class="score-rating-stars"[^>]*role="img"[^>]*aria-label="4 of 5 stars"|<span[^>]*role="img"[^>]*aria-label="4 of 5 stars"[^>]*class="score-rating-stars"/, 'the stars are an image with a label');

  const unrated = render(null);
  assert.match(unrated, /aria-valuetext="Unrated"/, 'an unrated track says so');
  assert.equal(scoreValueText(30), '30.0 out of 100, okay');
  assert.equal(scoreValueText(null), 'Unrated');

  // The number and the label are text on a panel; the bar keeps the plain tone.
  assert.deepEqual(
    [scoreTier(90).color, scoreTier(90).text, scoreTier(40).text, scoreTier(10).text],
    ['var(--accent)', 'var(--accent-text)', 'var(--warn-text)', 'var(--error-text)'],
  );
  assert.match(rated, /class="score-rating-input"[^>]*style="color:var\(--accent-text\)"/);
  assert.match(rated, /class="score-rating-fill"[^>]*linear-gradient\(to right, var\(--accent-dim\), var\(--accent\)\)/);

  // Every tier's text colour reads on the panels it sits on, in every built-in
  // skin. --accent-dim is a bar and border tone and fails that on most of them.
  const { BUILT_IN_THEMES, contrastRatio, parseSkinColorRgb } = await load('shared/custom-skin.ts');
  const tokensCss = read('src/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = {};
  for (const block of tokensCss.matchAll(/(:root|\[data-theme='([^']+)'\])\s*\{([^}]*)\}/g)) {
    blocks[block[2] ?? 'root'] ??= {};
    for (const decl of block[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) blocks[block[2] ?? 'root'][decl[1]] = decl[2].trim().replace(/\s+/g, ' ');
  }
  const resolve = (value, env) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(env[name], env));
  const rgbOf = (value) => {
    const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+)\)$/.exec(value.trim());
    if (!mix) return parseSkinColorRgb(value.trim());
    const [first, second] = [rgbOf(mix[1]), rgbOf(mix[3])];
    return first.map((channel, i) => channel * (Number(mix[2]) / 100) + second[i] * (1 - Number(mix[2]) / 100));
  };
  const texts = new Set([10, 40, 60, 75, 90].map((score) => scoreTier(score).text));
  assert.equal(texts.size, 5, 'each tier but the unrated one has its own text colour');
  assert.ok(![...texts].some((text) => text.includes('--accent-dim')), 'no tier paints text with --accent-dim');
  for (const theme of BUILT_IN_THEMES) {
    const env = { ...blocks.root, ...blocks[theme] };
    for (const surface of theme === 'steel' ? ['--panel', '--panel-2'] : ['--panel', '--panel-2', '--bg']) {
      for (const text of [...texts, scoreTier(null).text]) {
        const ratio = contrastRatio(rgbOf(resolve(text, env)), rgbOf(resolve(env[surface], env)));
        assert.ok(ratio >= 4.5, `${theme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
      }
    }
  }
}

// --- About: where the data lives ---
{
  const stubs = {
    name: 'about-stubs',
    setup(b) {
      b.onResolve({ filter: /(^|\/)(BrandLogo|api)$/ }, (args) => ({ path: args.path.split('/').pop(), namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: args.path === 'api'
          ? `export const api = { appVersion: '0.0.0', platform: 'win32', getSupportDiagnostics: async () => ({ userDataPath: '' }) };`
          : `export const BrandLogo = () => null;`,
        loader: 'js',
      }));
    },
  };
  const { AboutDataRow } = await load('src/components/views/AboutView.tsx', [stubs]);
  const row = renderToStaticMarkup(createElement(AboutDataRow, { path: 'D:\\Apps\\NewAmp Data' }));
  assert.match(row, /Data folder/);
  assert.match(row, /<strong title="D:\\Apps\\NewAmp Data">D:\\Apps\\NewAmp Data<\/strong>/, 'the path is shown and kept whole in the tooltip');
  assert.equal(renderToStaticMarkup(createElement(AboutDataRow, { path: '' })), '', 'the browser preview has no data folder to show');

  const about = read('src/components/views/AboutView.tsx');
  assert.match(about, /api\s*\.getSupportDiagnostics\(\)\s*\.then\(\(diagnostics\) => \{\s*if \(!cancelled\) setDataPath\(diagnostics\.userDataPath\);/, 'the row reads userDataPath from the support diagnostics');
  assert.match(about, /<AboutDataRow path=\{dataPath\} \/>/);
}

// --- Toggles carry their state; calls to action are not selections ---------
{
  const titleBar = read('src/components/TitleBar.tsx');
  assert.match(titleBar, /aria-label="Pin window on top"\s*aria-pressed=\{alwaysOnTop\}/, 'PIN reports pressed');

  const discover = read('src/components/views/DiscoverView.tsx');
  assert.match(discover, /aria-pressed=\{lowEndMode\}\s*onClick=\{toggleLowEnd\}/, 'Light Viz reports pressed');

  const albums = read('src/components/views/AlbumsView.tsx');
  assert.match(albums, /aria-pressed=\{showMissingArtOnly\}\s*onClick=\{\(\) => setShowMissingArtOnly/, 'Missing art reports pressed');

  for (const file of ['LovedView', 'HistoryView']) {
    const source = read(`src/components/views/${file}.tsx`);
    assert.doesNotMatch(source, /pxbtn is-active/, `${file} draws no lit button for an action`);
    assert.match(source, /pxbtn is-primary" onClick=\{\(\) => void playQueue\(tracks, 0\)\} disabled=\{!tracks\.length\}/, `${file} play is the primary action`);
  }
  const home = read('src/components/views/HomeView.tsx');
  for (const guard of ['!tracks.length', '!current', '!visible.length']) {
    assert.ok(home.split('\n').some((line) => line.includes('pxbtn is-primary') && line.includes(`disabled={${guard}}`)), `Home has a primary action disabled by ${guard}`);
  }
  assert.doesNotMatch(
    home.split('\n').filter((line) => /disabled=\{!(tracks|current|visible)/.test(line)).join('\n'),
    /is-active/,
    'no disabled action on Home is drawn lit',
  );
  assert.match(home, /<button className="pxbtn is-primary" onClick=\{\(\) => void api\.scanLibrary\(\)\}>/, 'the empty-library scan is the primary action');
  assert.deepEqual(
    home.split('\n').filter((line) => /pxbtn is-active/.test(line)).map((line) => line.trim().replace(/^<button className="([^"]*)".*$/, '$1')),
    ['pxbtn is-active px-1.5 py-[2px] text-[10px]'],
    'the only lit button left on Home is the compact RADIO chip',
  );
  for (const file of ['DiscoverView', 'AlbumsView']) {
    const source = read(`src/components/views/${file}.tsx`);
    const toggles = source.split('\n').filter((line) => /pxbtn \$\{/.test(line));
    for (const line of toggles) assert.ok(!/is-primary/.test(line), `${file}: a toggle is never drawn as the primary action`);
  }
}

// --- Home shares the Today pick --------------------------------------------
{
  const home = read('src/components/views/HomeView.tsx');
  assert.match(home, /import \{ pickToday, trackScorePercent, type TodayPick \} from '\.\.\/\.\.\/lib\/today-pick';/);
  assert.doesNotMatch(home, /^function pickToday\(/m, 'Home keeps no private copy of pickToday');
  assert.doesNotMatch(home, /^interface TodayPick\b/m, 'Home keeps no private TodayPick');
  assert.doesNotMatch(home, /^function trackScorePercent\(/m, 'Home keeps no private score helper');
}

// --- Text-role tokens at the call sites ---
{
  const servers = read('src/components/views/MusicServersView.tsx');
  assert.match(servers, /color: 'var\(--warn-text\)' \}\}>HTTP sends login/, 'the cleartext warning reads warn-text');
  assert.match(servers, /<p role="alert" style=\{\{ color: 'var\(--error-text\)' \}\}>/, 'the connection error reads error-text');
  assert.doesNotMatch(servers, /color: 'var\(--(warn|error)\)'/, 'no plain warn or error text is left');

  const transport = read('src/components/Transport.tsx');
  assert.match(transport, /data-newamp-playback-error style=\{\{ color: 'var\(--error-text\)' \}\}/, 'the playback error reads error-text');

  const badges = read('src/styles/components/badges.css');
  const rule = (selector) => {
    const found = badges.match(new RegExp(`(?:^|\\n)${selector.replace(/[.\-]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(found, `badges.css has ${selector}`);
    return found[1];
  };
  assert.match(rule('.format-badge-tone-accent'), /\n\s*color: var\(--accent-text\);/);
  assert.match(rule('.format-badge-tone-warn'), /\n\s*color: var\(--warn-text\);/);
  assert.match(rule('.signal-path-badge-ok'), /\n\s*color: var\(--accent-text\);/);
  assert.match(rule('.signal-path-badge-warn'), /\n\s*color: var\(--warn-text\);/);
  // The transport display is dark glass whatever the skin, so the accent badges keep the plain accent there.
  assert.match(badges, /\.display \.format-badge-tone-accent,\s*\.display \.signal-path-badge-ok \{\s*color: var\(--accent\);\s*\}/);
}

// --- Previous / Next tooltips follow the platform ----------------------------
{
  const transport = read('src/components/Transport.tsx');
  assert.match(transport, /import \{ formatTime, playbackCodecLabel, shortcutLabel \} from '\.\.\/lib\/format';/);
  assert.match(transport, /title=\{`Previous \(\$\{shortcutLabel\('Mod\+←'\)\}\)`\}/);
  assert.match(transport, /title=\{`Next \(\$\{shortcutLabel\('Mod\+→'\)\}\)`\}/);
  assert.doesNotMatch(transport, /Ctrl\+/, 'Transport names no literal Ctrl chord');

  const { formatShortcut } = await load('shared/keyboard-shortcuts.ts');
  assert.equal(formatShortcut('Mod+←', 'win32'), 'Ctrl+←');
  assert.equal(formatShortcut('Mod+→', 'darwin'), '⌘→');
}

console.log('[view-controls-semantics-test] PASS');
