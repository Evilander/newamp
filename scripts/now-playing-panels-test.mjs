// Exercise the production panel and score handlers without an Electron profile.
// Layout assertions pin the CSS/markup contract; pixel layout still needs a GUI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transform } from 'esbuild';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scorePath = 'src/components/ScoreRating.tsx';
const viewPath = 'src/components/views/NowPlayingView.tsx';
const css = read('src/styles/decks-compact.css');
const ratingCss = read('src/styles/components/rating.css');
function rule(selector, source = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `missing ${selector}`);
  return match[1];
}
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
};
function all(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
  return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
}
const byClass = (node, name) => all(node, (item) => item.props?.className?.split(' ').includes(name));
function hooks(initial = []) {
  const slots = [];
  let index = 0;
  return {
    reset() { index = 0; },
    useState(value) {
      const at = index++;
      if (!(at in slots)) slots[at] = at in initial ? initial[at] : typeof value === 'function' ? value() : value;
      return [slots[at], (next) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }];
    },
    useRef(value) {
      const at = index++;
      if (!(at in slots)) slots[at] = { current: value };
      return slots[at];
    },
    useEffect() {},
    useDeferredValue: (value) => value,
    memo: (component) => component,
  };
}
async function load(path, names, bindings) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const snippets = names.map((name) => {
    const node = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name ||
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some((decl) => decl.name.getText(source) === name));
    assert.ok(node, `missing ${name}`);
    return node.getText(source).replace(/^export /, '');
  });
  const code = (await transform(`${snippets.join('\n')}\nObject.assign(globalThis, { ${names.join(', ')} });`, { loader: 'tsx', jsx: 'transform' })).code;
  const context = vm.createContext({ React, ...bindings });
  vm.runInContext(code, context);
  return context;
}
const scoreNames = ['SCORE_MAX', 'SCORE_STEP_FINE', 'SCORE_STEP_COARSE', 'SCORE_STEP_LEAP', 'clampScore', 'formatScore', 'parseScoreDraft', 'scoreTier', 'scoreValueText', 'ScoreRating'];
const scoreHooks = hooks();
const score = await load(scorePath, scoreNames, scoreHooks);
for (const [draft, expected] of [['100,0', 100], ['88,3', 88.3], ['88.3', 88.3], ['100.0', 100], ['101', 100], ['-5', 0], ['.5', 0.5], ['2.600', null], ['1,000', null], ['1,2,3', null], ['NaN', null], ['', null], ['٨٧٫٥', 87.5], ['۸۷٫۵', 87.5], ['８７.５', 87.5], ['８７．５', 87.5]]) {
  assert.equal(score.parseScoreDraft(draft), expected, draft);
}
async function editor(value, stars = 0) {
  const writes = [];
  const starWrites = [];
  const bindings = hooks();
  const component = await load(scorePath, scoreNames, bindings);
  const props = { value, stars, onChange: (next) => writes.push(next) };
  const render = () => { bindings.reset(); return component.ScoreRating(props); };
  const input = () => byClass(render(), 'score-rating-input')[0].props;
  const target = { select() {}, blur() { input().onBlur(); } };
  const key = (key, modifiers = {}) => input().onKeyDown({ key, preventDefault() {}, currentTarget: target, ...modifiers });
  return { writes, starWrites, props, render, input, key,
    focus: () => input().onFocus({ currentTarget: target }),
    type: (value) => input().onChange({ currentTarget: { value } }),
    blur: () => input().onBlur(),
    stars: () => all(byClass(render(), 'score-rating-stars')[0], (node) => node.type === 'button'),
    enableStars() { props.onStarsChange = (next) => starWrites.push(next); },
  };
}
let edit = await editor(100, 5);
{
  // The track ends while a score is half typed. The edit is dropped, the field
  // stays where it is, and what is typed next is not saved to the new track.
  const across = await editor(40);
  across.props.identity = 1;
  across.focus(); across.type('8');
  across.props.identity = 2; across.props.value = 10;
  across.render();
  assert.equal(across.input().value, '10.0', "the field shows the next track's score");
  across.type('5'); across.blur();
  assert.deepEqual(across.writes, [], 'nothing typed across the change is saved');
  assert.equal(across.input().value, '10.0');
  across.focus(); across.type('55'); across.blur();
  assert.deepEqual(across.writes, [55], 'a fresh edit rates the track now playing');
  // A held arrow on the bar keeps repeating into the next track.
  const bar = () => byClass(across.render(), 'score-rating-bar')[0].props;
  across.props.identity = 3; across.props.value = 20;
  across.render();
  bar().onKeyDown({ key: 'ArrowRight', repeat: true, preventDefault() {} });
  assert.deepEqual(across.writes, [55], 'repeats of a key held across the change do nothing');
  let tabStopped = false;
  bar().onKeyDown({ key: 'Tab', repeat: true, preventDefault() { tabStopped = true; } });
  assert.equal(tabStopped, false, 'a held Tab still moves through the bar');
  bar().onKeyDown({ key: 'ArrowRight', repeat: false, preventDefault() {} });
  assert.equal(across.writes.length, 2, 'a new press nudges the new track');
}
assert.equal(edit.input().type, 'text');
assert.equal(edit.input().inputMode, 'decimal');
assert.equal(edit.input().role, 'spinbutton');
assert.equal(edit.input().value, '100.0');
assert.match(rule('.score-rating-input', ratingCss), /width:\s*calc\(5ch \+ 10px\)/);
assert.match(rule('.score-rating-input', ratingCss), /flex-shrink:\s*0/);
assert.equal(byClass(edit.render(), 'score-rating-stars')[0].props.role, 'img');
assert.match(byClass(edit.render(), 'score-rating-stars')[0].props.title, /stars follow its score/);
for (const [action, expected] of [['Enter', [88.3]], ['Escape', []], ['blur', [88.3]]]) {
  edit = await editor(70);
  edit.focus(); edit.type('88,3');
  if (action === 'blur') edit.blur(); else edit.key(action);
  assert.deepEqual(edit.writes, expected, `${action} writes exactly once or cancels`);
  assert.equal(edit.input().value, action === 'Escape' ? '70.0' : '88.3');
}
for (const value of [null, 70]) {
  edit = await editor(value); edit.focus(); edit.blur();
  assert.deepEqual(edit.writes, [], 'unchanged blur never writes or clears');
}
for (const text of ['2.600', '1,000', 'bad']) {
  edit = await editor(70); edit.focus(); edit.type(text); edit.blur();
  assert.deepEqual(edit.writes, []); assert.equal(edit.input().value, '70.0');
}
edit = await editor(70); edit.focus(); edit.key('ArrowUp'); edit.key('ArrowUp', { shiftKey: true });
assert.deepEqual(edit.writes, [], 'arrows only change the draft');
assert.equal(edit.input().value, '71.1'); edit.key('Enter');
assert.deepEqual(edit.writes, [71.1], 'arrow draft saves once on Enter and its resulting blur');
edit = await editor(70); edit.focus(); edit.key('ArrowDown'); edit.blur();
assert.deepEqual(edit.writes, [69.9], 'arrow draft saves once on blur');
edit = await editor(70); edit.focus(); edit.key('ArrowUp');
assert.equal(edit.input()['aria-valuenow'], 70.1, 'a nudged draft is the value the field announces');
assert.equal(edit.input()['aria-valuetext'], '70.1 out of 100, great');
edit.type('bad');
assert.equal(edit.input()['aria-valuenow'], 70, 'an unreadable draft announces the stored score');
edit.key('Escape');
assert.equal(edit.input()['aria-valuenow'], 70, 'a cancelled draft announces the stored score again');
edit = await editor(70); edit.focus(); edit.type(''); edit.blur();
assert.deepEqual(edit.writes, [null], 'deliberately emptying a rated field clears it');
edit = await editor(87.3, 4); edit.enableStars();
assert.equal(byClass(edit.render(), 'score-rating-stars')[0].props.role, 'radiogroup');
assert.equal(edit.stars().filter((node) => node.props.tabIndex === 0).length, 1);
edit.stars()[3].props.onClick();
assert.deepEqual(edit.starWrites, [], 'the shown album star preserves its fine score');
edit.stars()[2].props.onMouseEnter();
assert.equal(edit.stars().filter((node) => node.props.children[0] === '★').length, 3, 'hover previews every star through the pointer');
byClass(edit.render(), 'score-rating-stars')[0].props.onMouseLeave();
assert.equal(edit.stars().filter((node) => node.props.children[0] === '★').length, 4);
const focused = [];
const target = { parentElement: { querySelectorAll: () => [1, 2, 3, 4, 5].map((star) => ({ focus: () => focused.push(star) })) } };
for (const [at, key, expected] of [[3, 'ArrowRight', 5], [4, 'ArrowRight', 1], [0, 'ArrowLeft', 5], [2, 'ArrowUp', 2], [1, 'ArrowDown', 3], [2, 'Home', 1], [1, 'End', 5]]) {
  edit.stars()[at].props.onKeyDown({ key, preventDefault() {}, currentTarget: target });
  assert.equal(edit.starWrites.at(-1), expected); assert.equal(focused.at(-1), expected);
  assert.equal(edit.stars().filter((node) => node.props.tabIndex === 0).length, 1);
}
byClass(edit.render(), 'score-rating-clear')[0].props.onClick();
assert.deepEqual(edit.writes, [null], 'CLR explicitly clears');
assert.match(rule('[data-newamp-album-rating] .score-rating', ratingCss), /minmax\(180px, 1fr\)/, 'Albums keeps the original full-size bar minimum when it fits');
assert.match(ratingCss, /@container \(max-width: 480px\)/, 'small album rows move the star targets below the bar');
assert.match(rule('.score-rating-input', ratingCss), /background:\s*var\(--display-bg\)/, 'score readouts retain their original dark well');
assert.match(rule('.score-rating-stars button', ratingCss), /width:\s*24px/);
assert.match(rule('.score-rating-stars button', ratingCss), /height:\s*24px/);
assert.match(read('src/components/views/AlbumsView.tsx'), /onStarsChange=\{\(stars\) => void setAlbumScore\(stars \* 20\)\}/, 'Albums uses the same editable stars');

const track = { id: 1, albumKey: 'album-key', album: 'Album', albumArtist: '', artist: 'Artist', year: 2003 };
const albumWrites = [];
const albumHooks = hooks([{ rating: 0, ratingScore: null }]);
const album = await load(viewPath, ['AlbumScoreInline'], {
  ...albumHooks, ScoreRating: score.ScoreRating,
  api: { async setAlbumRatingScore(...args) { albumWrites.push(args); return { rating: 3, ratingScore: 60 }; } },
});
albumHooks.reset();
const albumControl = all(album.AlbumScoreInline({ track }), (node) => node.type === score.ScoreRating)[0];
assert.equal(typeof albumControl.props.onStarsChange, 'function');
albumControl.props.onStarsChange(3);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(albumWrites, [['Artist', 'Album', 60, 'album-key']], 'stars use the independent album score API with the artist fallback and album identity');

// When playback moves to another album, its control starts over: no draft or
// score of the last album carries across, and a slow write for it lands nowhere.
{
  const ratingHooks = hooks();
  const ran = [];
  let effect = 0;
  const reset = ratingHooks.reset;
  ratingHooks.reset = () => { reset(); effect = 0; };
  ratingHooks.useEffect = (run, deps) => {
    const at = effect++;
    if (!ran[at] || deps.some((dep, i) => dep !== ran[at][i])) { ran[at] = deps; run(); }
  };
  const pending = new Map();
  const view = await load(viewPath, ['AlbumScoreInline'], {
    ...ratingHooks, ScoreRating: score.ScoreRating,
    api: {
      getAlbumRating: (_artist, album) => new Promise((resolve, reject) => pending.set(album, { resolve, reject })),
      setAlbumRatingScore: (_artist, album, value) => new Promise((resolve) => pending.set(`write ${album}`, () => resolve({ rating: 4, ratingScore: value }))),
    },
  });
  const render = (album) => {
    ratingHooks.reset();
    return view.AlbumScoreInline({ track: { ...track, album, albumKey: `key ${album}` } });
  };
  const show = (album) => all(render(album), (node) => node.type === score.ScoreRating)[0].props;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  show('A');
  pending.get('A').resolve({ rating: 4, ratingScore: 80 });
  await settle();
  assert.equal(show('A').value, 80);
  assert.equal(show('A').identity, 'key A', 'the album score field is told which album it rates');
  show('A').onChange(70);
  const first = show('B');
  assert.deepEqual([first.value, first.stars], [null, 0], "the first render for a new album does not paint the last album's score");
  assert.equal(show('B').identity, 'key B', 'a new album is a new thing to rate, so a draft for the last one is dropped');
  assert.deepEqual([show('B').value, show('B').stars], [null, 0], "the last album's score is not shown while this one loads");
  pending.get('write A')();
  await settle();
  assert.equal(show('B').value, null, "a slow write for the last album does not land on this one");
  pending.get('B').resolve({ rating: 2, ratingScore: 41 });
  await settle();
  assert.equal(show('B').value, 41);
  render('C');
  pending.get('C').reject(new Error('database busy'));
  await settle();
  const failed = render('C');
  assert.equal(all(failed, (node) => node.type === score.ScoreRating).length, 0, 'an album whose score failed to load offers no editor that could overwrite it');
  assert.deepEqual(all(failed, (node) => node.props?.['data-newamp-album-rating-unavailable'] !== undefined).flatMap((node) => node.props.children), ['Score unavailable']);
  assert.equal(show('B').value, null, 'going back to an album loads it again');
}
{
  const header = ts.createSourceFile(viewPath, read(viewPath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const keys = [];
  (function find(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(header) === 'ScoreRating') {
      assert.equal(node.attributes.properties.some((prop) => prop.name?.getText(header) === 'key'), false, 'a keyed field would be rebuilt and lose the focus mid-edit');
      keys.push(node.attributes.properties.find((prop) => prop.name?.getText(header) === 'identity')?.initializer?.expression?.getText(header));
    }
    ts.forEachChild(node, find);
  })(header);
  assert.deepEqual(keys, ['current.id', 'albumKey'], 'each Now Playing score field is told what it rates, so a typed score never moves to the next track');
}

const panelNames = ['AlbumContextPanel', 'AlbumInsight', 'albumTrackOrder', 'albumShapeNote', 'albumReleaseNote'];
for (const fallback of [false, true]) {
  for (const imageUrl of [null, 'cover.png']) {
    const fact = { title: 'A long album or artist title', summary: 'A full story that should use the available panel width.', description: 'Release story', url: 'https://example.test', imageUrl };
    const panelHooks = hooks([[], [], fallback ? null : fact, fallback ? fact : null, 'ok']);
    const panel = await load(viewPath, panelNames, { ...panelHooks, Fragment: 'fragment', ArtistLink: 'artist-link', AlbumLink: 'album-link', TrackLink: 'track-link', formatTime: String });
    panelHooks.reset();
    const story = byClass(panel.AlbumContextPanel({ track }), 'album-context-story')[0];
    assert.ok(story);
    assert.equal(all(story, (node) => node.type === 'img').length, imageUrl ? 1 : 0);
  }
}
assert.match(rule('.album-context-story'), /grid-template-columns:\s*minmax\(0, 1fr\)/, 'the no-image story uses the full width');
assert.match(rule('.album-context-story:has(> img)'), /grid-template-columns:\s*58px minmax\(0, 1fr\)/, 'only an image reserves the thumbnail column');
assert.match(rule('.album-context-panel'), /linear-gradient\(135deg/, 'restore the album accent gradient');
assert.match(rule('.track-signal-panel'), /linear-gradient\(180deg/, 'restore the Signal Bay accent gradient');
for (const file of ['DiscoverView', 'HomeView']) assert.match(read(`src/components/views/${file}.tsx`), /className="lcd-text[^"]*text-\[(?:18|20)px\]/, 'metrics retain their LCD font and glow');
assert.match(rule('.album-context-head strong'), /overflow-wrap:\s*anywhere/);
assert.match(rule('.album-context-head'), /flex-wrap:\s*wrap/);
assert.match(rule('.newamp-right-grid'), /min\(var\(--newamp-spectrum-frac, 42%\), calc\(100% - 348px\)\)/, 'the splitter leaves room for the side panel and its handle');
assert.match(rule('.newamp-right-grid'), /minmax\(min\(240px/, 'Signal Bay keeps 240 px when space permits');
assert.match(rule('.score-rating', ratingCss), /minmax\(180px, 280px\)/, 'the bar keeps the width it had in 2.10.0');
const source = ts.createSourceFile(viewPath, read(viewPath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let scrollClass;
function walk(node) {
  if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((prop) => prop.name?.getText(source) === 'data-newamp-album-tab-panels')) {
    scrollClass = node.attributes.properties.find((prop) => prop.name?.getText(source) === 'className').initializer.text;
  }
  ts.forEachChild(node, walk);
}
walk(source);
assert.ok(scrollClass?.includes('overflow-y-auto'));
assert.ok(!scrollClass.split(' ').includes('flex'), 'tab panels keep natural block heights instead of shrinking through their contents');
const bookmarkHooks = hooks();
const bookmark = await load(viewPath, ['BookmarkPanel'], { ...bookmarkHooks, usePlayerStore: (select) => select({ currentTime: 456 }), formatTime: () => '7:36' });
const bookmarkTree = bookmark.BookmarkPanel({ bookmarks: [], onSave() {}, onDelete() {}, onJump() {} });
assert.ok(!bookmarkTree.props.className.includes('min-h-0'), 'the bookmark border cannot collapse through its header');
assert.ok(bookmarkTree.props['data-newamp-track-bookmarks'] !== undefined);
console.log('[now-playing-panels-test] PASS: image/no-image stories, natural panel heights, album stars, decimal scores and keyboard entry');
