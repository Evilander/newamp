// Resolve markup classes, inline colours and inheritance against the complete
// imported CSS cascade. No copied foreground/background token-pair list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { build } from 'esbuild';
import selectorParser from 'postcss-selector-parser';

const require = createRequire(import.meta.url);
const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function value(node) {
  if (!node) return '';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // A template's fixed classes; the ones it substitutes are left out.
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  if (ts.isJsxExpression(node)) return value(node.expression);
  if (ts.isConditionalExpression(node)) return value(node.whenTrue) || value(node.whenFalse);
  return '';
}
// Keep JSX ancestry and every branch/map body, substituting only dynamic data.
// Class membership is read as a set by the browser, never by class order.
function markup(file) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxText(node)) return escape(node.text.trim());
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(source);
      const htmlTag = /^[a-z][a-z0-9]*$/.test(tag) ? tag : 'x-component';
      const attrs = [];
      for (const attr of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = attr.name.getText(source);
        if (name.startsWith('data-')) attrs.push(`${name}="${escape(value(attr.initializer) || 'true')}"`);
        if (name === 'className') attrs.push(`class="${escape(value(attr.initializer))}"`);
        if (name === 'style' && ts.isJsxExpression(attr.initializer) && attr.initializer.expression && ts.isObjectLiteralExpression(attr.initializer.expression)) {
          const styles = attr.initializer.expression.properties.filter(ts.isPropertyAssignment).map((prop) => {
            const name = prop.name.getText(source).replace(/['"]/g, '').replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
            const text = value(prop.initializer);
            return text && `${name}: ${text}`;
          }).filter(Boolean);
          attrs.push(`style="${escape(styles.join(';'))}"`);
        }
      }
      const location = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1;
      attrs.push(`data-source="${file}:${location}"`);
      const hasText = ts.isJsxElement(node) && node.children.some((child) => ts.isJsxText(child) ? !!child.text.trim() : ts.isJsxExpression(child) && !!child.expression);
      if (hasText) attrs.push('data-text="true"');
      const children = ts.isJsxElement(node) ? node.children.map(visit).join('') : '';
      // Dynamic leaf data still occupies a text node in the actual UI.
      return `<${htmlTag} ${attrs.join(' ')}>${children || ''}</${htmlTag}>`;
    }
    return children(node);
  }
  function children(node) {
    const output = [];
    ts.forEachChild(node, (child) => { output.push(visit(child)); });
    return output.join('');
  }
  return visit(source);
}
function stylesheet(file) {
  return readFileSync(file, 'utf8').replace(/@import\s+['"]([^'"]+)['"];[^\n]*/g, (_, path) => {
    const target = path.startsWith('.') ? resolve(dirname(file), path) : require.resolve(path);
    return stylesheet(target);
  });
}
const css = (await postcss([tailwindcss(), autoprefixer()]).process(stylesheet(resolve(root, 'src/styles/index.css')), { from: resolve(root, 'src/styles/index.css') })).css;
const files = ['DiscoverView', 'HomeView', 'LibraryView', 'SettingsView', 'NowPlayingView', 'AlbumsView'].map((name) => `src/components/views/${name}.tsx`);
files.push('src/components/ErrorBoundary.tsx');
const html = files.map(markup).join('');
const maths = await build({ stdin: { contents: `export { BUILT_IN_THEMES, contrastRatio, parseSkinColorRgb } from './shared/custom-skin'; export { applyTheme } from './src/lib/skins'; export { scoreTier } from './src/components/ScoreRating';`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { BUILT_IN_THEMES, contrastRatio, parseSkinColorRgb, applyTheme, scoreTier } = await import(`data:text/javascript;base64,${Buffer.from(maths.outputFiles[0].text).toString('base64')}`);

// Static JSX supplies a tree, while PostCSS supplies every imported rule in
// source order. Resolve selector specificity, inline declarations, inheritance,
// local custom properties, alpha compositing and gradient endpoints. Dynamic
// data/conditional branches are represented by samples; this is not a pixel test.
const tree = { tag: 'html', classes: new Set(), attrs: {}, children: [], parent: null };
let parent = tree;
const nodes = [];
for (const match of html.matchAll(/<([^>]+)>/g)) {
  const tag = match[1];
  if (tag.startsWith('/')) { parent = parent.parent; continue; }
  const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
  const node = { tag: tag.split(' ')[0], classes: new Set((attrs.class || '').split(/\s+/)), attrs, children: [], parent };
  parent.children.push(node); nodes.push(node); parent = node;
}
const parsed = postcss.parse(css);
const selectors = new Map();
const parseSelector = (text) => {
  if (!selectors.has(text)) selectors.set(text, selectorParser().astSync(text));
  return selectors.get(text);
};
function weight(nodes) {
  return nodes.reduce((total, node) => {
    if (node.type === 'id') total += 10000;
    else if (node.type === 'class' || node.type === 'attribute') total += 100;
    else if (node.type === 'tag') total += 1;
    else if (node.type === 'pseudo' && node.value !== ':where') {
      total += node.nodes?.length ? Math.max(...node.nodes.map((part) => weight(part.nodes))) : 100;
    }
    return total;
  }, 0);
}
function matches(node, parts) {
  if (!node) return false;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'combinator') {
      if (part.value.trim() === '>') return matches(node.parent, parts.slice(0, i));
      if (part.value.trim()) return false;
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) if (matches(ancestor, parts.slice(0, i))) return true;
      return false;
    }
    if (part.type === 'class' && !node.classes.has(part.value)) return false;
    if (part.type === 'tag' && node.tag !== part.value) return false;
    if (part.type === 'id' && node.attrs.id !== part.value) return false;
    if (part.type === 'attribute') {
      if (!(part.attribute in node.attrs)) return false;
      if (part.operator === '=' && node.attrs[part.attribute] !== part.value) return false;
      if (part.operator && part.operator !== '=') return false;
    }
    if (part.type === 'pseudo') {
      if (part.value === ':root') { if (node !== tree) return false; }
      else if ([':is', ':where', ':not'].includes(part.value)) {
        const any = part.nodes.some((selector) => matches(node, selector.nodes));
        if (part.value === ':not' ? any : !any) return false;
      } else if (part.value === ':first-child') { if (node.parent?.children[0] !== node) return false; }
      else if (part.value === ':last-child') { if (node.parent?.children.at(-1) !== node) return false; }
      else return false; // Hover/focus states and pseudo-elements are separate states.
    }
  }
  return true;
}
const rules = [];
parsed.walkRules((rule) => {
  // Use the desktop/normal-motion state; narrow layout has no colour changes.
  for (let at = rule.parent; at; at = at.parent) {
    if (at.type === 'atrule' && (at.name.includes('keyframes') || at.name === 'media' && /max-width|reduced-motion/.test(at.params))) return;
  }
  for (const selector of parseSelector(rule.selector).nodes) {
    rules.push({ selector: selector.nodes, weight: weight(selector.nodes), decls: rule.nodes.filter((n) => n.type === 'decl') });
  }
});
function declarations(node, extra = []) {
  const chosen = new Map();
  let order = 0;
  for (const rule of [...rules, ...extra]) {
    // A pseudo-element takes only the rules that name it, matched on its element.
    if (node.pseudo ? !(rule.selector.at(-1)?.value === node.pseudo && matches(node.parent, rule.selector.slice(0, -1))) : !matches(node, rule.selector)) continue;
    for (const decl of rule.decls) {
      order++;
      const score = rule.weight + (decl.important ? 1e8 : 0);
      if (!chosen.has(decl.prop) || chosen.get(decl.prop).score <= score) chosen.set(decl.prop, { value: decl.value, score, order });
    }
  }
  for (const decl of (node.attrs.style || '').split(';')) {
    const index = decl.indexOf(':');
    if (index !== -1) chosen.set(decl.slice(0,index).trim(), { value: decl.slice(index+1).trim(), score: 1e6 });
  }
  const shorthand = chosen.get('background');
  const longhand = chosen.get('background-color');
  if (longhand && (!shorthand || longhand.score > shorthand.score || longhand.score === shorthand.score && longhand.order > shorthand.order)) {
    const layers = shorthand ? split(shorthand.value).filter((layer) => /gradient\(/.test(layer)) : [];
    chosen.set('background', { value: [...layers, longhand.value].join(','), score: longhand.score });
  }
  return Object.fromEntries([...chosen].map(([key, { value }]) => [key,value]));
}
function substitute(text, vars) {
  for (let count = 0; text.includes('var('); count++) {
    assert.ok(count < 100, `cyclic CSS variable: ${text}`);
    const start = text.lastIndexOf('var(');
    let depth = 1; let end = start + 4;
    for (; depth && end < text.length; end++) {
      if (text[end] === '(') depth++;
      if (text[end] === ')') depth--;
    }
    const [key, ...fallback] = split(text.slice(start + 4, end - 1));
    text = text.slice(0,start) + (vars[key] ?? fallback.join(',') ?? '') + text.slice(end);
  }
  return text;
}

function split(text) {
  let depth = 0; let start = 0; const parts = [];
  for (let i=0; i<text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (text[i] === ',' && depth === 0) { parts.push(text.slice(start,i).trim()); start=i+1; }
  }
  parts.push(text.slice(start).trim()); return parts;
}
function color(text) {
  if (text === 'transparent') return [0,0,0,0];
  if (text.startsWith('color-mix(')) {
    const [, a, b] = split(text.slice(10,-1));
    const stop = (text) => { const m = /^(.*) ([\d.]+)%$/.exec(text); return [color(m ? m[1] : text), m ? Number(m[2])/100 : null]; };
    const [first, shareA] = stop(a); const [second, shareB] = stop(b);
    const share = shareA ?? 1-(shareB ?? 0.5);
    const alpha = first[3]*share + second[3]*(1-share);
    return [...first.slice(0,3).map((v,i) => alpha ? (v*first[3]*share+second[i]*second[3]*(1-share))/alpha : 0), alpha];
  }
  const rgb = parseSkinColorRgb(text);
  assert.ok(rgb, `unsupported CSS colour ${text}`);
  const alpha = /^rgba/.test(text) ? Number(text.slice(text.lastIndexOf(',')+1,-1)) : 1;
  return [...rgb,alpha];
}
const over = (top, bottom) => top.slice(0,3).map((v,i) => v*top[3]+bottom[i]*(1-top[3]));
function surface(text, underneath) {
  if (!text || text === 'none') return underneath;
  const layers = split(text);
  let result = underneath;
  for (const layer of layers.reverse()) {
    if (/^(?:repeating-)?(linear|radial)-gradient\(/.test(layer)) {
      const stops = split(layer.slice(layer.indexOf('(')+1,-1)).filter((stop) => /^(#|rgba?\(|hsla?\(|transparent|color-mix\()/.test(stop));
      result = stops.flatMap((stop) => result.map((base) => over(color(stop.replace(/\s+[-\d.]+(?:%|px)?(?:\s+[-\d.]+(?:%|px)?)?$/, '')),base)));
    } else result = result.map((base) => over(color(layer),base));
  }
  return result;
}
const isWell = (node) => node.classes.has('bevel-in') || ['album-context-panel','track-signal-panel','library-search-command','album-context-meta','album-context-grid','album-context-insights','home-hero-pick-reason','home-rated-card-score','first-run-tip'].some((name) => node.classes.has(name));
// Every view sits on main's --bg. These trees draw accent labels straight on
// it; in the others the unpainted root stands in for the panels around them.
const ON_VIEW_BG = ['src/components/ErrorBoundary.tsx', 'src/components/views/AlbumsView.tsx'];
const hex = (rgb) => rgb.slice(0,3).map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('');
const brightness = (text) => contrastRatio(color(text).slice(0,3), [0,0,0]);
// Dark panels under light ink and a dark display under a light readout.
const isDark = (vars) => brightness(vars['--panel']) < brightness(vars['--ink']) && brightness(vars['--display-bg']) < brightness(vars['--display-fg']);
function resolveNode(node, inherited, backgrounds, extra = []) {
  const decls = declarations(node, extra);
  const rawVars = { ...inherited.vars, ...Object.fromEntries(Object.entries(decls).filter(([key]) => key.startsWith('--'))) };
  const vars = Object.fromEntries(Object.entries(rawVars).map(([key,text]) => [key,substitute(text,rawVars)]));
  const resolved = Object.fromEntries(Object.entries(decls).filter(([key]) => !key.startsWith('--')).map(([key,text]) => [key,substitute(text,vars)]));
  const ownColor = resolved.color && resolved.color !== 'inherit' ? resolved.color : inherited.color;
  const bg = surface(resolved.background ?? resolved['background-color'], backgrounds);
  return { vars, color: ownColor, bg, resolved };
}
const inline = new Map();
let baseVars;
const mockRoot = { dataset: {}, style: {
  setProperty: (key,value) => inline.set(key,value),
  removeProperty: (key) => inline.delete(key),
  getPropertyValue: (key) => inline.get(key) || '',
} };
globalThis.document = { documentElement: mockRoot, body: { appendChild() {} }, createElement: () => ({ style: { color: '' }, remove() {} }) };
globalThis.getComputedStyle = (el) => el === mockRoot ? { getPropertyValue: (key) => inline.get(key) ?? baseVars[key] ?? '' } : { color: `rgb(${color(el.style.color).slice(0,3).join(',')})` };
function checkThemes(themes = BUILT_IN_THEMES, extra = []) {
const failures = [];
let checked = 0;
for (const theme of themes) {
  tree.attrs['data-theme'] = theme;
  const initial = resolveNode(tree, { vars: {}, color: '#000000' }, [[255,255,255]]);
  baseVars = initial.vars;
  applyTheme(theme);
  Object.assign(initial.vars, Object.fromEntries(inline));
  if (theme === 'classic') {
    for (const [derived, original] of [['--well-ink','--ink'], ['--well-secondary','--ink-2'], ['--well-dim','--muted'], ['--well-accent','--accent'], ['--well-warn','--warn']]) {
      assert.equal(initial.vars[derived], initial.vars[original], `Classic keeps its original ${original} in display cards`);
    }
  }
  const viewBg = color(initial.vars['--bg']).slice(0,3);
  function inspect(node, inherited, bg, inWell = false, inControl = false, painted = false) {
    const state = resolveNode(node, inherited, bg, extra);
    inWell ||= isWell(node);
    inControl ||= node.classes.has('pxbtn') || node.classes.has('score-rating');
    const fill = state.resolved.background ?? state.resolved['background-color'];
    painted ||= !!fill && !/^(transparent|none)$/.test(fill);
    const style = node.attrs.style || '';
    const accent = node.classes.has('text-accent') || /--accent(?:-ink|-text|-frame)?\)/.test(style);
    // Text on a tree that paints nothing sits on main's --bg: always for the
    // frame colour, and for every accent label in the trees drawn straight on it.
    const onViewBg = !painted && accent && (style.includes('--accent-frame)') || ON_VIEW_BG.some((file) => node.attrs['data-source']?.startsWith(`${file}:`)));
    // Text beside an image is still text; the image is the other branch.
    if ((inWell || accent) && !inControl && node.attrs['data-text'] && node.children.every((child) => child.tag === 'img') && state.color && state.resolved.display !== 'none') {
      for (const background of onViewBg ? [viewBg] : state.bg) {
        const ratio = contrastRatio(over(color(state.color),background),background);
        checked++;
        if (ratio + 1e-6 < 4.5) failures.push(`${theme}: ${node.attrs['data-source']} ${[...node.classes].join(' ')} = ${ratio.toFixed(2)}:1 (${state.color} on ${background})`);
      }
      // A dark skin keeps the accent these labels had where it reads on --bg.
      const accentRgb = color(initial.vars['--accent']).slice(0,3);
      if (onViewBg && isDark(initial.vars) && contrastRatio(accentRgb, viewBg) >= 4.5 && hex(color(state.color)) !== hex(accentRgb)) {
        failures.push(`${theme}: ${node.attrs['data-source']} changed its accent from ${initial.vars['--accent']} to ${state.color}`);
      }
    }
    for (const child of node.children) inspect(child, state, state.bg, inWell, inControl, painted);
  }
  for (const node of tree.children) inspect(node, initial, [color(initial.vars['--panel']).slice(0,3)]);
}
return { failures, checked };
}
const { failures, checked } = checkThemes();
assert.equal(failures.length, 0, `resolved markup contrast:\n${[...new Set(failures)].join('\n')}`);
assert.ok(checked > 100, 'inspect actual markup across all skins');

// Text outside the static views, built from the classes its components use.
// Each names the colour it had in 2.10.0. A dark skin keeps that colour unless
// it fell short of 4.5:1 on its surface; on every skin the text must read.
const scrim = [0,0,0];
// A link in the chain taken from the views' own markup, so it follows the source.
const fromMarkup = (test) => {
  const node = nodes.find(test);
  assert.ok(node, `missing markup for ${test}`);
  return [[...node.classes].join(' '), node.tag, node.attrs.style ?? ''];
};
const samples = [
  { name: 'signal chip caption', chain: [['track-signal-panel'], ['track-signal-chip'], ['', 'span']], was: 'var(--muted)' },
  { name: 'visualizer volume', under: scrim, chain: [['fullscreen-viz-hover-meter'], ['fullscreen-viz-hover-meter-label'], ['', 'strong']], was: 'var(--ink)' },
  { name: 'visualizer volume label', under: scrim, chain: [['fullscreen-viz-hover-meter'], ['fullscreen-viz-hover-meter-label'], ['', 'span']], was: 'color-mix(in srgb, var(--ink) 78%, transparent)' },
  { name: 'rated card score', chain: [['home-rated-card-art'], ['home-rated-card-score']], was: 'var(--ink)' },
  { name: 'rated card strong score', chain: [['home-rated-card-art'], ['home-rated-card-score is-strong']], was: 'var(--accent)' },
  { name: 'tempo readout', chain: [['bg-panel'], ['lcd-text text-accent']], was: 'var(--display-fg)' },
  { name: 'album track time', chain: [['album-context-panel'], ['album-context-tracklist', 'ol'], ['', 'li'], ['', 'em']], was: 'var(--muted)' },
  { name: 'secondary text in a well', chain: [['', 'div', 'color: var(--ink-2)'], ['bevel-in display-well']], was: 'var(--ink-2)' },
  { name: 'muted text in a well', chain: [['', 'div', 'color: var(--muted)'], ['bevel-in display-well'], ['', 'pre']], was: 'var(--muted)' },
  ...[10, 40, 60, 75, 90].map((score) => ({ name: `score ${score}`, chain: [['score-rating'], ['score-rating-display'], ['score-rating-input', 'input', `color: ${scoreTier(score).text}`]], was: scoreTier(score).text })),
  // Tailwind's placeholder grey, which the field used before it had a rule of its own.
  { name: 'unrated score placeholder', chain: [['score-rating'], ['score-rating-display'], ['score-rating-input', 'input', `color: ${scoreTier(null).text}`]], pseudo: '::placeholder', was: '#9ca3af' },
  { name: 'album page note', chain: [['album-context-panel'], ['album-context-story', 'a'], ['', 'span'], fromMarkup((node) => node.classes.has('album-context-summary') && /italic/.test(node.attrs.style ?? ''))], was: 'color-mix(in srgb, var(--ink-2) 70%, transparent)' },
  { name: 'album card matched songs', onViewBg: true, chain: [fromMarkup((node) => 'data-newamp-album-matched-songs' in node.attrs)], was: 'var(--accent)' },
];
const sampleFailures = [];
for (const theme of BUILT_IN_THEMES) {
  tree.attrs['data-theme'] = theme;
  const initial = resolveNode(tree, { vars: {}, color: '#000000' }, [[255,255,255]]);
  baseVars = initial.vars;
  applyTheme(theme);
  Object.assign(initial.vars, Object.fromEntries(inline));
  for (const { name, chain, was, under, pseudo, onViewBg } of samples) {
    let state = initial;
    let bg = [under ?? color(initial.vars[onViewBg ? '--bg' : '--panel']).slice(0,3)];
    let parent = tree;
    for (const [classes, tag = 'div', style = ''] of chain) {
      parent = { tag, classes: new Set(classes.split(' ').filter(Boolean)), attrs: style ? { style } : {}, children: [], parent };
      state = resolveNode(parent, state, bg);
      bg = state.bg;
    }
    if (pseudo) state = resolveNode({ tag: '', classes: new Set(), attrs: {}, children: [], parent, pseudo }, state, bg);
    const shown = bg.map((background) => over(color(state.color), background));
    const before = bg.map((background) => over(color(substitute(was, initial.vars)), background));
    const ratios = shown.map((rgb, i) => contrastRatio(rgb, bg[i]));
    if (Math.min(...ratios) + 1e-6 < 4.5) sampleFailures.push(`${theme}: ${name} is ${Math.min(...ratios).toFixed(2)}:1 (${state.color})`);
    if (isDark(initial.vars) && before.every((rgb, i) => contrastRatio(rgb, bg[i]) >= 4.5) && shown.some((rgb, i) => hex(rgb) !== hex(before[i]))) {
      sampleFailures.push(`${theme}: ${name} changed from ${substitute(was, initial.vars)} to ${state.color}`);
    }
  }
}
assert.deepEqual(sampleFailures, [], `component text:\n${sampleFailures.join('\n')}`);
assert.ok(BUILT_IN_THEMES.filter((theme) => {
  tree.attrs['data-theme'] = theme;
  return isDark(resolveNode(tree, { vars: {}, color: '#000000' }, [[255,255,255]]).vars);
}).length >= 8, 'the dark skins are told apart from the light ones');
// The selector/cascade checks do not depend on class order or CSS file origin.
const probe = { tag: 'div', classes: new Set(['p-3','display-well','bevel-in','text-accent']), attrs: {}, parent: tree };
assert.ok(matches(probe, parseSelector('.bevel-in.display-well').nodes[0].nodes));
probe.classes = new Set(['text-accent','bevel-in','p-3','display-well']);
assert.ok(matches(probe, parseSelector('.bevel-in.display-well').nodes[0].nodes));
const later = { selector: parseSelector('.bevel-in').nodes[0].nodes, weight: 100, decls: [{prop:'background',value:'#ffffff'}] };
assert.equal(declarations(probe,[later]).background, '#ffffff', 'a later rule from any imported file wins');
console.log(`[theme-render-test] PASS (${checked} markup/CSS pairs; static cascade, not pixels)`);

// Mutation guards exercise the same resolver against actual markup nodes.
const card = nodes.find((node) => node.classes.has('bevel-in') && node.classes.has('display-well'));
assert.ok(card);
card.classes.delete('display-well');
assert.ok(checkThemes(['ice','steel']).failures.length > 0, 'removing the text-surface class is detected');
card.classes.add('display-well');
const panelLabel = nodes.find((node) => node.attrs['data-source']?.includes('AlbumsView') && node.attrs.style?.includes('color: var(--accent-ink)'));
assert.ok(panelLabel);
const heldStyle = panelLabel.attrs.style;
panelLabel.attrs.style = heldStyle.replace('--accent-ink','--accent');
assert.ok(checkThemes(['ice']).failures.length > 0, 'raw accent text on a light panel is detected');
panelLabel.attrs.style = heldStyle;
const laterSurface = { selector: parseSelector('.bevel-in').nodes[0].nodes, weight: 100, decls: [{ prop: 'background', value: 'var(--panel-2)' }] };
assert.ok(checkThemes(['ice'], [laterSurface]).failures.length > 0, 'a later stylesheet surface override is detected');
for (const node of nodes) node.classes = new Set([...node.classes].reverse());
assert.deepEqual(checkThemes().failures, [], 'markup class order never changes the result');
console.log('[theme-render-test] PASS: missing class, raw accent, later surface override and class-order mutation guards');
