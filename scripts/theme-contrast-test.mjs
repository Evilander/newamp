// Contrast and wiring checks for the built-in skins.
//
// Reads src/styles/tokens.css the way the cascade does (:root plus one
// [data-theme] block, with var() and color-mix() resolved) and asserts WCAG AA
// for the text and surface pairs the UI draws: 4.5:1 for body text and
// labels, 3:1 on the hover surface (--panel-3), where text is rare. Also
// checks the pieces that make the label colour on accent fills independent
// of --bg (including custom and imported skins, and the Skin Workshop
// preview), the text-role tokens custom skins carry, the disabled button
// style, the 24 px button target, the specificity of the Midnight button
// rules against the shells' pressed fills, and the Text size scaling chain.
//
// Run: npm run test:theme-contrast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Selector lists split at top-level commas only, so :where(a, b) stays whole.
function splitSelectorList(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(' || list[i] === '[') depth += 1;
    else if (list[i] === ')' || list[i] === ']') depth -= 1;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

// Selectors Level 4 specificity as [ids, classes, types]: :where() counts for
// nothing, :not() / :is() / :has() for their most specific argument.
function specificity(selector) {
  const total = [0, 0, 0];
  const add = (found) => found.forEach((n, i) => { total[i] += n; });
  let rest = selector.replace(/(['"]).*?\1/g, '""');
  rest = rest.replace(/:(where|not|is|has)\(((?:[^()]|\([^()]*\))*)\)/g, (_, name, args) => {
    if (name !== 'where') add(splitSelectorList(args).map(specificity).reduce((best, next) => (outranks(next, best) > 0 ? next : best), [0, 0, 0]));
    return '';
  });
  rest = rest.replace(/\[[^\]]*\]/g, () => { total[1] += 1; return ''; });
  rest = rest.replace(/#[\w-]+/g, () => { total[0] += 1; return ''; });
  rest = rest.replace(/\.[\w-]+/g, () => { total[1] += 1; return ''; });
  rest = rest.replace(/::[\w-]+(\([^)]*\))?/g, () => { total[2] += 1; return ''; });
  rest = rest.replace(/:[\w-]+(\([^)]*\))?/g, () => { total[1] += 1; return ''; });
  total[2] += rest.split(/[\s>+~]+/).filter((part) => part && part !== '*').length;
  return total;
}
const outranks = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// [selector, declarations] for every rule in a stylesheet, one per selector in a list.
function rulesOf(css) {
  const rules = [];
  for (const rule of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    for (const selector of splitSelectorList(rule[1])) rules.push([selector, rule[2]]);
  }
  return rules;
}

// The product's own colour maths and skin application, bundled in memory.
const bundled = await build({
  stdin: {
    contents: `
      export { BUILT_IN_THEMES, SKIN_VARIABLES, COLOR_SKIN_VARIABLES, contrastRatio, deriveOnAccent, parseSkinColorRgb, normalizeCustomSkin, normalizeSkinVariableValue } from './shared/custom-skin';
      export { applyTheme, deriveSkinOnAccent, deriveSkinTextTokens, previewSkinVariable } from './src/lib/skins';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  logLevel: 'silent',
});
const {
  BUILT_IN_THEMES,
  SKIN_VARIABLES,
  COLOR_SKIN_VARIABLES,
  contrastRatio,
  deriveOnAccent,
  parseSkinColorRgb,
  normalizeCustomSkin,
  normalizeSkinVariableValue,
  applyTheme,
  deriveSkinOnAccent,
  deriveSkinTextTokens,
  previewSkinVariable,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// --- tokens.css as the cascade sees it -----------------------------------
const tokensCss = stripComments(read('src/styles/tokens.css'));
const blocks = {};
for (const block of tokensCss.matchAll(/(:root|\[data-theme='([^']+)'\])\s*\{([^}]*)\}/g)) {
  const key = block[2] ?? 'root';
  blocks[key] ??= {};
  for (const decl of block[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    blocks[key][decl[1]] = decl[2].trim().replace(/\s+/g, ' ');
  }
}
const themes = Object.keys(blocks).filter((key) => key !== 'root');
assert.deepEqual([...themes].sort(), [...BUILT_IN_THEMES].sort(), 'tokens.css should define exactly the registered built-in skins');

const envFor = (theme) => ({ ...blocks.root, ...blocks[theme] });

function substitute(value, env, depth = 0) {
  assert.ok(depth < 16, `var() chain too deep: ${value}`);
  return value.replace(/var\((--[\w-]+)(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_, name, fallback) => {
    if (env[name] !== undefined) return substitute(env[name], env, depth + 1);
    assert.ok(fallback !== undefined, `${name} is not defined`);
    return substitute(fallback, env, depth + 1);
  });
}

// srgb color-mix() with two opaque colours, the only form tokens.css uses.
function toRgb(value) {
  const text = value.trim();
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+)\)$/.exec(text);
  if (mix) {
    const first = toRgb(mix[1]);
    const second = toRgb(mix[3]);
    const share = Number(mix[2]) / 100;
    return first.map((channel, i) => channel * share + second[i] * (1 - share));
  }
  const rgb = parseSkinColorRgb(text);
  assert.ok(rgb, `cannot read colour ${text}`);
  return rgb;
}

const token = (theme, name) => {
  const env = envFor(theme);
  assert.ok(env[name] !== undefined, `${theme} resolves no ${name}`);
  return toRgb(substitute(env[name], env));
};

// Linear gradient colour at a 0..1 position, honouring explicit stop
// positions and spacing the rest evenly.
function gradientAt(value, at) {
  const body = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'));
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')') depth -= 1;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());
  const stops = parts
    .map((part) => /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*(?:([\d.]+)%)?$/i.exec(part))
    .filter(Boolean)
    .map((match) => ({ rgb: toRgb(match[1]), at: match[2] === undefined ? null : Number(match[2]) / 100 }));
  assert.ok(stops.length >= 2, `not a gradient: ${value}`);
  stops[0].at ??= 0;
  stops[stops.length - 1].at ??= 1;
  for (let i = 1; i < stops.length - 1; i += 1) {
    if (stops[i].at !== null) continue;
    let next = i + 1;
    while (stops[next].at === null) next += 1;
    const prev = stops[i - 1].at;
    stops[i].at = prev + ((stops[next].at - prev) * 1) / (next - i + 1);
  }
  if (at <= stops[0].at) return stops[0].rgb;
  for (let i = 1; i < stops.length; i += 1) {
    if (at <= stops[i].at) {
      const span = stops[i].at - stops[i - 1].at || 1;
      const t = (at - stops[i - 1].at) / span;
      return stops[i - 1].rgb.map((channel, c) => channel + (stops[i].rgb[c] - channel) * t);
    }
  }
  return stops[stops.length - 1].rgb;
}

// --- the pairs -----------------------------------------------------------
const AA = 4.5;
const UI = 3;
// Steel's --bg is the dark frame around its light panels; text sits on the
// panels, so ink on --bg isn't a pair that gets drawn there.
const FRAME_BG = new Set(['steel']);
// A 14 px title in the 40 px bar covers roughly the middle 40% of its height.
const TITLEBAR_BAND = [0.3, 0.4, 0.5, 0.6, 0.7];

const mixOver = (top, share, bottom) => top.map((channel, i) => channel * share + bottom[i] * (1 - share));

const failures = [];
function check(theme, label, foreground, backgrounds, minimum) {
  for (const [name, background] of Object.entries(backgrounds)) {
    const ratio = contrastRatio(foreground, background);
    if (ratio + 1e-9 < minimum) failures.push(`${theme}: ${label} on ${name} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
  }
}

for (const theme of themes) {
  const surfaces = {
    '--panel': token(theme, '--panel'),
    '--panel-2': token(theme, '--panel-2'),
    ...(FRAME_BG.has(theme) ? {} : { '--bg': token(theme, '--bg') }),
  };
  for (const name of ['--ink', '--ink-2', '--muted', '--accent-text', '--warn-text', '--error-text']) {
    check(theme, name, token(theme, name), surfaces, AA);
  }
  for (const name of ['--accent-text', '--warn-text', '--error-text']) {
    check(theme, name, token(theme, name), { '--panel-3': token(theme, '--panel-3') }, UI);
  }

  // Readout text on the display, and the dim tone Transport uses on it.
  const displayBg = { '--display-bg': token(theme, '--display-bg') };
  check(theme, '--display-fg', token(theme, '--display-fg'), displayBg, AA);
  check(theme, '--display-dim', token(theme, '--display-dim'), displayBg, AA);

  // The label on pressed pills and other accent fills.
  check(theme, '--on-accent', token(theme, '--on-accent'), { '--accent': token(theme, '--accent') }, AA);

  // Title bar: the gradient (Retro, Concourse), the flat --bg (Modern) and
  // the translucent panel over --bg (Liquid Glass).
  const titlebar = substitute(envFor(theme)['--titlebar'], envFor(theme));
  const titleText = token(theme, '--titlebar-fg');
  for (const at of TITLEBAR_BAND) {
    check(theme, `--titlebar-fg (bar at ${Math.round(at * 100)}%)`, titleText, { '--titlebar': gradientAt(titlebar, at) }, AA);
  }
  check(theme, '--titlebar-fg-flat', token(theme, '--titlebar-fg-flat'), { '--bg': token(theme, '--bg') }, AA);

  // Liquid Glass: --panel at --titlebar-glass-mix over the blurred body, which
  // paints accent, accent-dim and warn halos over --bg (shells.css). The plain
  // case has no halo; the worst case stacks all three at full strength, which
  // no single point of the bar actually sees. Blur and saturation aren't modelled.
  const glassShare = parseFloat(substitute(envFor(theme)['--titlebar-glass-mix'], envFor(theme))) / 100;
  assert.ok(glassShare > 0 && glassShare <= 1, `${theme} --titlebar-glass-mix should be a percentage`);
  let haloed = token(theme, '--bg');
  haloed = mixOver(token(theme, '--warn'), 0.18, haloed);
  haloed = mixOver(token(theme, '--accent-dim'), 0.28, haloed);
  haloed = mixOver(token(theme, '--accent'), 0.32, haloed);
  check(theme, '--titlebar-fg (glass bar)', titleText, {
    'panel over --bg': mixOver(token(theme, '--panel'), glassShare, token(theme, '--bg')),
    'panel over the accent halos': mixOver(token(theme, '--panel'), glassShare, haloed),
  }, AA);

  assert.ok(blocks[theme]['--on-accent'], `${theme} should define --on-accent itself`);
  for (const name of COLOR_SKIN_VARIABLES) {
    const value = blocks[theme][name];
    if (value !== undefined) assert.equal(normalizeSkinVariableValue(name, value), value, `${theme} ${name} should be a value the skin grammar accepts`);
  }
}

// Midnight tints the active nav row with a wash of the accent over the panel.
const midnightWash = token('midnight', '--accent').map((channel, i) => channel * 0.12 + token('midnight', '--panel')[i] * 0.88);
check('midnight', '--accent-text (active nav row)', token('midnight', '--accent-text'), { 'accent wash over --panel': midnightWash }, AA);
assert.ok(blocks.root['--on-accent'], ':root should define the default --on-accent');

// Classic's three text tiers stay apart: --muted sits on the 4.5:1 floor, so
// the room for hierarchy is above it.
{
  const panel2 = token('classic', '--panel-2');
  const [ink, ink2, muted] = ['--ink', '--ink-2', '--muted'].map((name) => contrastRatio(token('classic', name), panel2));
  assert.ok(ink - ink2 >= 1 && ink2 - muted >= 0.8, `Classic text tiers on --panel-2 should step apart (${ink.toFixed(2)}, ${ink2.toFixed(2)}, ${muted.toFixed(2)})`);
}
assert.deepEqual(failures, [], `contrast failures:\n  ${failures.join('\n  ')}`);

// --- text on accent fills no longer follows --bg ----------------------------
const shellsCss = stripComments(read('src/styles/shells.css'));
const activeRules = [...shellsCss.matchAll(/([^{}]*\.pxbtn\.is-active[^{}]*)\{([^}]*)\}/g)]
  .filter((rule) => !/:disabled|aria-disabled/.test(rule[1]));
assert.equal(activeRules.length, 3, 'Modern, Liquid Glass and Concourse each paint an is-active pill');
for (const [, selector, body] of activeRules) {
  assert.match(body, /color:\s*var\(--on-accent\)/, `${selector.trim()} should take its label from --on-accent`);
  assert.doesNotMatch(body, /var\(--bg\)/, `${selector.trim()} must not read --bg`);
}
assert.doesNotMatch(shellsCss, /color:[^;]*var\(--bg\)/, 'no shell text colour should be derived from --bg');

// The workshop lists it, with its own words.
assert.ok(COLOR_SKIN_VARIABLES.includes('--on-accent'), '--on-accent is a colour skin variable');
assert.ok(SKIN_VARIABLES.includes('--on-accent'));
const skinHintsSource = read('src/lib/skin-hints.ts');
assert.match(skinHintsSource, /'--on-accent': \{ label: 'Text on accent', hint: 'Pressed buttons and other accent fills' \}/);

// --- deriving the label colour ----------------------------------------------
assert.equal(deriveOnAccent('#ffffff'), '#000000');
assert.equal(deriveOnAccent('#f5f5f0'), '#000000');
assert.equal(deriveOnAccent('#102040'), '#ffffff');
assert.equal(deriveOnAccent('rgb(16 32 64)'), '#ffffff');
assert.equal(deriveOnAccent('rgba(255, 255, 0, 0.5)'), '#000000');
assert.equal(deriveOnAccent('hsl(50 100% 50%)'), '#000000');
assert.equal(deriveOnAccent('hsl(240, 100%, 20%)'), '#ffffff');
assert.equal(deriveOnAccent('#fff'), '#000000');
assert.equal(deriveOnAccent('red'), null, 'named colours are resolved by the renderer');
assert.equal(deriveOnAccent('not a colour'), null);
// Whatever the accent, the derived label reads on it.
let seed = 7;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
for (let i = 0; i < 400; i += 1) {
  const accent = `hsl(${Math.round(next() * 360)} ${Math.round(next() * 100)}% ${Math.round(next() * 100)}%)`;
  const label = deriveOnAccent(accent);
  assert.ok(contrastRatio(parseSkinColorRgb(label), parseSkinColorRgb(accent)) >= AA, `${label} on ${accent}`);
}

// Custom, saved and imported skins: the label follows the accent, not --bg.
const colorNames = { red: 'rgb(255, 0, 0)', yellow: 'rgb(255, 255, 0)' };
const baseValues = (theme) => {
  const env = envFor(theme);
  return Object.fromEntries(
    ['--accent', '--on-accent', '--warn', '--error', '--accent-text', '--warn-text', '--error-text'].map((name) => [name, substitute(env[name], env)]),
  );
};
const basePair = (theme) => {
  const values = baseValues(theme);
  return { accent: values['--accent'], onAccent: values['--on-accent'], warn: values['--warn'], error: values['--error'] };
};
const inline = new Map();
const root = {
  dataset: {},
  style: {
    removeProperty: (key) => inline.delete(key),
    setProperty: (key, value) => inline.set(key, value),
    getPropertyValue: (key) => inline.get(key) ?? '',
  },
};
globalThis.document = {
  documentElement: root,
  body: { appendChild() {} },
  createElement: () => ({
    style: { color: '' },
    remove() {},
  }),
};
globalThis.getComputedStyle = (element) => {
  // Inline values win over the theme's, as in the browser.
  if (element === root) return { getPropertyValue: (key) => inline.get(key) ?? baseValues(root.dataset.theme)[key] ?? '' };
  return { color: colorNames[element.style.color] ?? '' };
};
const skin = (baseTheme, variables) => ({ name: 'Test', baseTheme, variables, updatedAt: 1 });

applyTheme('custom', skin('classic', { '--bg': '#000000' }));
assert.equal(root.dataset.theme, 'classic');
assert.equal(inline.get('--bg'), '#000000');
assert.equal(inline.has('--on-accent'), false, 'changing --bg leaves the base label colour alone');

applyTheme('custom', skin('classic', { '--accent': '#ffffff' }));
assert.equal(inline.get('--on-accent'), '#000000', 'a light accent gets a dark label');

applyTheme('custom', skin('classic', { '--accent': '#102040' }));
assert.equal(inline.get('--on-accent'), '#ffffff', 'a dark accent gets a light label');

applyTheme('custom', skin('steel', { '--accent': 'hsl(50 100% 50%)', '--on-accent': baseValues('steel')['--on-accent'] }));
assert.equal(inline.get('--on-accent'), '#000000', 'a saved skin that repeats the base label still follows a new accent');

applyTheme('custom', skin('steel', { '--accent': baseValues('steel')['--accent'], '--on-accent': baseValues('steel')['--on-accent'] }));
assert.equal(inline.get('--on-accent'), baseValues('steel')['--on-accent'], 'an untouched accent keeps the hand-tuned base label');

applyTheme('custom', skin('classic', { '--accent': baseValues('classic')['--accent'], '--on-accent': '#dddddd' }));
assert.equal(inline.get('--on-accent'), '#000000', 'a picked label that cannot be read is replaced even when the accent did not move');

applyTheme('custom', skin('classic', { '--accent': baseValues('classic')['--accent'], '--on-accent': '#003300' }));
assert.equal(inline.get('--on-accent'), '#003300', 'a readable picked label is kept on an unchanged accent');

applyTheme('custom', skin('classic', { '--accent': '#ffffff', '--on-accent': '#ff0000' }));
assert.equal(inline.get('--on-accent'), '#ff0000', 'a label the author picked is kept');

applyTheme('custom', skin('classic', { '--accent': '#102040', '--on-accent': '#000000' }));
assert.equal(inline.get('--on-accent'), '#ffffff', 'a label saved for an earlier, lighter accent is replaced once it cannot be read');

applyTheme('custom', skin('classic', { '--accent': '#ffffff', '--on-accent': '#dddddd' }));
assert.equal(inline.get('--on-accent'), '#000000', 'a near-invisible picked label is replaced');

applyTheme('custom', skin('classic', { '--accent': 'yellow', '--on-accent': 'yellow' }));
assert.equal(inline.get('--on-accent'), '#000000', 'named colours are compared through the browser too');

applyTheme('custom', skin('classic', { '--accent': 'yellow' }));
assert.equal(inline.get('--on-accent'), '#000000', 'named accents are resolved through the browser');

applyTheme('custom', skin('classic', { '--accent': 'url(https://example.test/a.png)' }));
assert.equal(inline.has('--accent'), false, 'values outside the grammar still never reach the DOM');
assert.equal(inline.has('--on-accent'), false);

applyTheme('custom', skin('classic', { '--accent': '#ffffff', '--warn': '#ffff00', '--error': '#ff0000' }));
assert.equal(inline.get('--accent-text'), '#ffffff');
applyTheme('steel');
assert.equal(inline.size, 0, 'switching to a built-in skin clears every inline skin variable and derived colour');
assert.equal(root.dataset.theme, 'steel');

assert.equal(deriveSkinOnAccent({}, basePair('classic')), null);
assert.equal(deriveSkinOnAccent({ '--on-accent': '#123456' }, basePair('classic')), null, 'a label without an accent change has nothing to derive from');

// Text-role tokens follow a skin's own accent, warn and error.
applyTheme('custom', skin('midnight', { '--accent': '#ff0000' }));
assert.equal(inline.get('--accent-text'), '#ff0000', "a new accent replaces Midnight's own --accent-text");
assert.equal(inline.has('--warn-text') || inline.has('--error-text'), false, 'warn and error text stay with the base theme');

applyTheme('custom', skin('classic', { '--error': '#cc0000', '--warn': '#ffcc00' }));
assert.equal(inline.get('--error-text'), '#cc0000');
assert.equal(inline.get('--warn-text'), '#ffcc00');
assert.equal(inline.has('--accent-text'), false);

applyTheme('custom', skin('steel', Object.fromEntries(['--accent', '--warn', '--error'].map((name) => [name, baseValues('steel')[name]]))));
for (const token of ['--accent-text', '--warn-text', '--error-text']) {
  assert.equal(inline.has(token), false, `a Workshop skin that repeats the base colour keeps the base ${token}`);
}

applyTheme('custom', skin('classic', { '--error': 'url(https://example.test/a.png)', '--warn': 'var(--bg)' }));
assert.equal(inline.has('--error-text') || inline.has('--warn-text'), false, 'values outside the grammar derive nothing');

assert.deepEqual(deriveSkinTextTokens({}, basePair('classic')), {});
assert.deepEqual(deriveSkinTextTokens({ '--accent': ' #00FF66 ' }, basePair('classic')), {}, 'comparison ignores case and spacing');
assert.deepEqual(
  deriveSkinTextTokens({ '--accent': '#123456', '--error': '#654321' }, basePair('classic')),
  { '--accent-text': '#123456', '--error-text': '#654321' },
);

// Skin Workshop preview: the same derived colours as Save and re-apply.
{
  applyTheme('steel');
  const baseDraft = (theme) => Object.fromEntries(Object.entries(baseValues(theme)).filter(([name]) => !name.endsWith('-text')));
  const draft = baseDraft('steel');
  previewSkinVariable(draft, '--bg', '#000000');
  assert.deepEqual([...inline.keys()], ['--bg'], 'a variable that feeds no derived colour touches nothing else');

  previewSkinVariable(draft, '--accent', 'hsl(50 100% 50%)');
  assert.equal(inline.get('--accent'), 'hsl(50 100% 50%)');
  assert.equal(inline.get('--on-accent'), '#000000', 'the preview derives the label for a new accent');
  assert.equal(inline.get('--accent-text'), 'hsl(50 100% 50%)', 'and the accent text colour');

  previewSkinVariable(draft, '--accent', '#12');
  assert.equal(inline.get('--accent'), 'hsl(50 100% 50%)', 'a half-typed value changes nothing');
  assert.equal(inline.get('--on-accent'), '#000000');

  previewSkinVariable(draft, '--accent', baseValues('steel')['--accent']);
  assert.equal(inline.get('--on-accent'), baseValues('steel')['--on-accent'], 'back on the base accent the label returns to the base one');
  assert.equal(inline.has('--accent-text'), false, 'and the accent text colour to the base theme');

  previewSkinVariable({ ...draft, '--on-accent': '#ff0000' }, '--accent', '#ffffff');
  assert.equal(inline.get('--on-accent'), '#ff0000', 'a label the author picked survives the preview');

  previewSkinVariable({ ...draft, '--accent': '#ffffff', '--on-accent': '#dddddd' }, '--on-accent', '#dddddd');
  assert.equal(inline.get('--on-accent'), '#000000', 'a picked label that cannot be read on the accent is replaced in the preview too');

  applyTheme('custom', skin('classic', { '--accent': '#ffffff' }));
  const classicDraft = baseDraft('classic');
  previewSkinVariable(classicDraft, '--accent', baseValues('classic')['--accent']);
  assert.equal(inline.has('--accent-text'), false, "the preview compares with the base theme's accent, not the skin's inline one");

  previewSkinVariable(classicDraft, '--error', '#cc0000');
  assert.equal(inline.get('--error-text'), '#cc0000');
  applyTheme('steel');
  assert.equal(inline.size, 0);
}

// An older saved or imported skin has no --on-accent at all and still loads.
const legacy = normalizeCustomSkin({ name: 'Old', baseTheme: 'oxide', variables: { '--accent': '#fff200' }, updatedAt: 1 });
assert.ok(legacy && !('--on-accent' in legacy.variables));
applyTheme('custom', legacy);
assert.equal(inline.get('--on-accent'), '#000000');
assert.equal(normalizeCustomSkin({ name: 'N', baseTheme: 'oxide', variables: { '--on-accent': '#123456' } }).variables['--on-accent'], '#123456');
assert.equal(normalizeCustomSkin({ name: 'N', baseTheme: 'oxide', variables: { '--on-accent': 'var(--bg)' } }), null, 'a var() reference is not a colour');

// --- disabled buttons and the 24 px target ----------------------------------
const chromeCss = stripComments(read('src/styles/chrome.css'));
assert.match(chromeCss, /\.pxbtn:disabled/, 'chrome.css should style disabled buttons');
assert.match(chromeCss, /\.pxbtn\[aria-disabled='true'\]/, 'chrome.css should style aria-disabled buttons');
const disabledRule = /\.pxbtn:disabled,\s*\.pxbtn\[aria-disabled='true'\]\s*\{([^}]*)\}/.exec(chromeCss);
assert.ok(disabledRule, 'the base disabled rule should name both selectors');
assert.match(disabledRule[1], /opacity:\s*0\.4/);
assert.match(disabledRule[1], /cursor:\s*default/);
assert.match(chromeCss, /\.pxbtn\.is-active:disabled/, 'a disabled is-active button drops its lit state');
for (const shell of ['modern', 'liquid-glass', 'concourse']) {
  assert.match(shellsCss, new RegExp(`\\[data-shell='${shell}'\\] \\.pxbtn\\.is-active:disabled`), `${shell} should drop the accent fill from a disabled is-active button`);
}

assert.match(chromeCss, /:root\s*\{[^}]*--pxbtn-h:\s*24px/, '.pxbtn is 24 px tall by default');
assert.match(chromeCss, /\.pxbtn\s*\{[^}]*height:\s*var\(--pxbtn-h\)/);
assert.doesNotMatch(chromeCss, /\.pxbtn\s*\{[^}]*white-space:/, 'the base .pxbtn rule leaves wrapping to the nowrap rule that skips table cells');
const nowrap = /([^{}]*)\{\s*white-space:\s*nowrap;\s*\}/.exec(chromeCss);
assert.ok(nowrap, 'button labels stay on one line');
assert.deepEqual(
  splitSelectorList(nowrap[1]),
  ['.pxbtn:not(:where(td, th) .pxbtn)', '.pxbtn-xs'],
  'labels stay on one line outside table cells and on .pxbtn-xs; cell buttons keep wrapping until they take .pxbtn-xs',
);
const dense = /([^{}]*)\{\s*--pxbtn-h:\s*22px;[^}]*\}/.exec(chromeCss);
assert.ok(dense, 'dense surfaces keep 22 px buttons');
for (const scope of ['td', 'th', '[data-newamp-playlist-track-row]', '[data-newamp-queue-track-row]', '[data-newamp-compact-deck-root]', '.deck-record-player', '.deck-jukebox', '.deck-cassette', '.deck-discman', '.deck-winamp-classic', '.deck-retro-tv']) {
  assert.ok(dense[1].split(',').map((part) => part.trim()).includes(scope), `${scope} should keep the dense button height`);
}
assert.match(chromeCss, /\.pxbtn-xs\s*\{[^}]*--pxbtn-h:\s*22px/, '.pxbtn-xs is the dense size');
const primitivesCss = stripComments(read('src/styles/components/primitives.css'));
assert.match(primitivesCss, /\.chip-md\s*\{[^}]*height:\s*var\(--chip-h\)/);
assert.match(chromeCss, /--chip-h:\s*24px/);
const extrasCss = stripComments(read('src/styles/components/chrome-extras.css'));
assert.doesNotMatch(extrasCss, /\[data-theme='midnight'\] \.pxbtn[^{]*\{[^}]*\bheight:/, "Midnight's button height rides --pxbtn-h so dense surfaces keep theirs");
assert.match(extrasCss, /\[data-theme='midnight'\]\s*\{\s*--pxbtn-h:\s*32px/);
assert.match(extrasCss, /\.display\s*\{[^}]*--ink-2:\s*var\(--display-dim\)/, 'text inside the display uses the display-tuned secondary colour');
assert.match(extrasCss, /\.display\s*\{[^}]*--warn-text:\s*var\(--warn\)[^}]*--error-text:\s*var\(--error\)/, 'the display keeps the plain warn and error colours for its own surface');

// --- cascade -----------------------------------------------------------------
// The specificity helper itself.
assert.deepEqual(specificity('.pxbtn:not(.pxbtn-xs, [data-a] .pxbtn)'), [0, 3, 0], ':not() takes its most specific argument');
assert.deepEqual(specificity('.pxbtn:not(:where(.pxbtn-xs, [data-a] .pxbtn))'), [0, 1, 0], ':where() counts for nothing');
assert.deepEqual(specificity("[data-shell='modern'] .pxbtn.is-active"), [0, 3, 0]);
assert.deepEqual(specificity('td .pxbtn'), [0, 1, 1]);
assert.deepEqual(specificity('.lcd-text::placeholder'), [0, 1, 1]);

// Midnight's button skin must not outrank the shells' pressed fill. A plain
// :not() once took its argument's specificity, which put Midnight's
// transparent background over [data-shell] .pxbtn.is-active.
const hasRule = (css, selector, pattern, message) => {
  assert.ok(rulesOf(css).some(([rule, body]) => rule === selector && pattern.test(body)), message ?? `${selector} should match ${pattern}`);
};
{
  const pressed = rulesOf(shellsCss).filter(([selector]) => /\.pxbtn\.is-active$/.test(selector));
  assert.equal(pressed.length, 3, 'Modern, Liquid Glass and Concourse each paint a pressed pill');
  const midnight = rulesOf(extrasCss).filter(([selector, body]) => selector.startsWith("[data-theme='midnight'] .pxbtn") && /\b(background|box-shadow)\s*:/.test(body));
  assert.ok(midnight.length >= 2, "Midnight restyles .pxbtn's background");
  for (const [selector] of midnight) {
    for (const [shellSelector] of pressed) {
      assert.ok(
        selector.includes(':not(:where(.is-active))') || outranks(specificity(selector), specificity(shellSelector)) < 0,
        `${selector} must not outrank ${shellSelector}`,
      );
    }
  }
}
assert.match(extrasCss, /\.pxbtn:not\(:where\(\.pxbtn-xs, \[data-newamp-compact-deck-root\] \.pxbtn\)\)/, "Midnight's button exclusions sit in :where()");

// --- the title bar, placeholder and text-role wiring --------------------------
const titleBarSource = read('src/components/TitleBar.tsx');
assert.equal((titleBarSource.match(/className="lcd-text titlebar-text /g) ?? []).length, 2, 'the wordmark and the track title both wear .titlebar-text');
assert.match(titleBarSource, /aria-label="Close"[\s\S]{0,120}style=\{\{ color: 'var\(--error-text\)' \}\}/, 'the Close button reads the error text colour');
hasRule(extrasCss, '.titlebar-text', /color:\s*var\(--titlebar-fg\);\s*text-shadow:\s*var\(--titlebar-shadow\)/);
hasRule(shellsCss, "[data-shell='modern'] .titlebar-text", /color:\s*var\(--titlebar-fg-flat\);\s*text-shadow:\s*var\(--titlebar-shadow-wide\)/, 'Modern paints the title on the flat bar, so it takes the flat title colour');
assert.ok(
  shellsCss.indexOf("[data-shell='modern'] .titlebar-text") > shellsCss.indexOf("[data-shell='modern'] .lcd-text"),
  "Modern's title rule comes after its .lcd-text glow rule so it wins the tie",
);
hasRule(shellsCss, "[data-shell='liquid-glass'] .titlebar-drag", /var\(--panel\) var\(--titlebar-glass-mix\)/, 'the glass bar takes its panel share from --titlebar-glass-mix');
assert.ok(blocks.root['--titlebar-glass-mix'], ':root should define --titlebar-glass-mix');
hasRule(chromeCss, '.lcd-text::placeholder', /color:\s*var\(--display-dim\)[\s\S]*text-shadow:\s*none/, 'a placeholder is dimmed and does not glow');

hasRule(chromeCss, '.pxbtn.is-primary', /(^|[;\s])color:\s*var\(--accent-text\)/);
hasRule(chromeCss, '.track-icon-btn:hover', /(^|[;\s])color:\s*var\(--accent-text\)/);
hasRule(primitivesCss, '.chip-ok', /(^|[;\s])color:\s*var\(--accent-text\)/);
hasRule(primitivesCss, '.chip-warn', /(^|[;\s])color:\s*var\(--warn-text\)/);
hasRule(primitivesCss, '.chip-error', /(^|[;\s])color:\s*var\(--error-text\)/);
hasRule(primitivesCss, '.confirm-action.is-armed', /--confirm-text:\s*var\(--error-text\)[\s\S]*(^|[;\s])color:\s*var\(--confirm-text\)/);
hasRule(primitivesCss, '.confirm-action.confirm-tone-warn.is-armed', /--confirm-text:\s*var\(--warn-text\)/);

// --- Text size scaling chain -------------------------------------------------
const rootTokens = blocks.root;
assert.equal(rootTokens['--newamp-text-scale'], '1', 'text scale defaults to 1');
const scaleBlock = /\[data-text-scale='custom'\]\s*\{([^}]*)\}/.exec(tokensCss);
assert.ok(scaleBlock, "tokens.css should define the [data-text-scale='custom'] block");
const scaled = Object.fromEntries([...scaleBlock[1].matchAll(/(--text-[\w]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const ramp = Object.keys(rootTokens).filter((name) => /^--text-(2xs|xs|sm|base|md|lg|xl|2xl|3xl)$/.test(name));
assert.equal(ramp.length, 9, 'the type ramp has nine named sizes');
for (const name of ramp) {
  assert.equal(
    scaled[name],
    `calc(${rootTokens[name]} * var(--newamp-text-scale))`,
    `${name} should scale from its unscaled value by --newamp-text-scale`,
  );
}

console.log(`[theme-contrast-test] PASS (${themes.length} skins, ${ramp.length} type sizes)`);
