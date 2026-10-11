// Fullscreen visualizer input rules: which keys it owns, which click targets
// count as the stage, where the right-click menu lands, how the look lock
// behaves, where focus goes when a popover closes, and the wiring that puts
// those rules in front of the user.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Visualizer input test timed out'); process.exit(1); }, 30000);
deadline.unref();

const bundle = async (contents, { jsx = false } = {}) => {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: jsx ? { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(process.cwd() + '/package.json');" } : undefined,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const input = await bundle("export * from './src/components/visualizer-input';");
const {
  resolveVisualizerKey, isRepeatableVisualizerAction, isStageTarget, opensVisualizerMenu, isInsideMenu, keyTargetKind,
  placeMenu, placeSubmenu, stepMenuIndex, isLookLocked, toggleLookLock, pickRandomPreset, fullscreenToRestore, pickFocusRestoreTarget,
  toggleLite, toggleFourK, keyboardOpener, keyTargetInStage, visualizerTakesKey, presetStepBase, scrollKeepsWheel,
  PRESET_ECHO_WINDOW_MS,
} = input;

// ---- keys ----
const key = (k, extra = {}) => resolveVisualizerKey({ key: k, ...extra });
assert.equal(key('ArrowRight'), 'preset-next');
assert.equal(key('ArrowLeft'), 'preset-previous');
assert.equal(key(']'), 'preset-next');
assert.equal(key('['), 'preset-previous');
assert.equal(key('q'), 'quality');
assert.equal(key('Q', { shiftKey: true }), 'quality', 'a capital letter is the same key');
assert.equal(key('a'), 'art');
assert.equal(key('h'), 'chrome');
assert.equal(key('p'), 'palette');
assert.equal(key('f'), 'native-fullscreen');
assert.equal(key('r'), 'reactivity');
assert.equal(key('R', { shiftKey: true }), 'replay-clip');
assert.equal(key('?', { shiftKey: true }), 'help');
assert.equal(key('Escape'), 'escape');
// Plain L and V belong to the app-wide map (love, stop); Lite and Auto-VJ moved to Shift.
assert.equal(key('l'), null, 'plain L is the app-wide love key');
assert.equal(key('v'), null, 'plain V is the app-wide stop key');
assert.equal(key('L', { shiftKey: true }), 'lite');
assert.equal(key('V', { shiftKey: true }), 'auto-vj');
// Anything with Ctrl, Cmd or Alt is the app's or the OS's.
for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
  for (const k of ['ArrowRight', 'ArrowLeft', 'f', 'a', 'h', 'r', 'q', 'p', ']', '?', 'Escape']) {
    assert.equal(key(k, { [modifier]: true }), null, `${modifier}+${k} must be left to the app`);
  }
}
// AltGr types [ and ] on German, French, Spanish and Nordic layouts. Windows reports it
// as Ctrl and Alt together; a real Ctrl+Alt chord has no AltGraph state.
assert.equal(key('[', { ctrlKey: true, altKey: true, altGraph: true }), 'preset-previous', 'AltGr+8 on a German layout types [');
assert.equal(key(']', { ctrlKey: true, altKey: true, altGraph: true }), 'preset-next');
assert.equal(key(']', { altKey: true, altGraph: true }), 'preset-next', 'AltGr without the Ctrl that Windows adds (Linux, macOS)');
assert.equal(key('[', { ctrlKey: true, altKey: true }), null, 'Ctrl+Alt+[ with no AltGraph is a chord for the app');
assert.equal(key('[', { altKey: true }), null, 'Alt+[ alone is not AltGr');
assert.equal(key('ArrowRight', { ctrlKey: true, altKey: true, altGraph: true }), null, 'AltGr with a non-character key stays a chord');
assert.equal(key('[', { ctrlKey: true, altKey: true, altGraph: true, metaKey: true }), null, 'Cmd is never AltGr');
assert.equal(key('@', { ctrlKey: true, altKey: true, altGraph: true }), null, 'a character AltGr typed that is not ours does nothing');
assert.equal(key('ArrowRight', { arrowsOwned: true }), null, 'a focused slider or menu steps with the arrows itself');
assert.equal(key('ArrowLeft', { arrowsOwned: true }), null);
assert.equal(key(']', { arrowsOwned: true }), 'preset-next', 'brackets are still ours');
assert.equal(key('z'), null);
assert.equal(key('Enter'), null);
assert.equal(key('Tab'), null);
assert.equal(key(' '), null);
assert.equal(isRepeatableVisualizerAction('preset-next'), true);
assert.equal(isRepeatableVisualizerAction('preset-previous'), true);
for (const action of ['quality', 'art', 'chrome', 'palette', 'reactivity', 'replay-clip', 'lite', 'auto-vj', 'native-fullscreen', 'help', 'escape']) {
  assert.equal(isRepeatableVisualizerAction(action), false, `${action} must fire once per press`);
}

// ---- which key events the visualizer takes ----
const pageNode = { nodeType: 1 };
const stageNode = { nodeType: 1 };
const insideStage = { nodeType: 1 };
const overlayNode = { nodeType: 1 };
const stageBox = { contains: (value) => value === insideStage || value === stageNode };
const page = [pageNode];
assert.equal(keyTargetInStage(insideStage, stageBox, page), true, 'a key from inside the stage is the stage\'s');
assert.equal(keyTargetInStage(stageNode, stageBox, page), true);
assert.equal(keyTargetInStage(pageNode, stageBox, page), true, 'so is one with no focused element (the body)');
assert.equal(keyTargetInStage({}, stageBox, page), true, 'and one dispatched on the window, which is not a node');
assert.equal(keyTargetInStage(null, stageBox, page), true);
assert.equal(keyTargetInStage(overlayNode, stageBox, page), false, 'an overlay stacked above the stage is not');
assert.equal(keyTargetInStage(insideStage, null, page), false, 'nothing is inside a stage that is gone');
assert.equal(visualizerTakesKey('escape', 'other', true), true);
assert.equal(visualizerTakesKey('escape', 'text', true), true, 'Esc from a seed box inside the stage still closes the panel');
assert.equal(visualizerTakesKey('escape', 'other', false), false, 'an overlay above the stage keeps its own Esc');
assert.equal(visualizerTakesKey('escape', 'text', false), false);
assert.equal(visualizerTakesKey('preset-next', 'other', true), true);
assert.equal(visualizerTakesKey('quality', 'slider', true), true, 'a slider leaves the letters to us');
assert.equal(visualizerTakesKey('quality', 'text', true), false, 'a text field takes every other key');
assert.equal(visualizerTakesKey('preset-next', 'text', true), false);

// ---- render mode (Lite and 4K) ----
const mode = (tier, quality) => ({ tier, quality });
assert.deepEqual(toggleLite(mode('balanced', 'auto')), mode('low', 'auto'));
assert.deepEqual(toggleLite(mode('balanced', '4k')), mode('low', 'auto'), 'Lite drops 4K');
assert.deepEqual(toggleLite(mode('low', 'auto')), mode('balanced', 'auto'));
assert.deepEqual(toggleFourK(mode('balanced', 'auto')), mode('balanced', '4k'));
assert.deepEqual(toggleFourK(mode('balanced', '4k')), mode('balanced', 'auto'));
assert.deepEqual(toggleFourK(mode('low', 'auto')), mode('low', 'auto'), '4K is not available in Lite');
// L, Q, L back to back, each reading what the one before left (no render in between):
// Q lands while Lite is on and does nothing, so quality is still auto. A stale
// closure saw the old tier on Q and wrote 4K under a Lite badge.
let live = mode('balanced', 'auto');
for (const press of [toggleLite, toggleFourK, toggleLite]) live = press(live);
assert.deepEqual(live, mode('balanced', 'auto'));
// Q then L: Lite wins, and leaving it later does not bring 4K back.
live = mode('balanced', 'auto');
for (const press of [toggleFourK, toggleLite]) live = press(live);
assert.deepEqual(live, mode('low', 'auto'));
live = toggleLite(live);
assert.deepEqual(live, mode('balanced', 'auto'));
// Leaving Lite for 4K from the segmented control: Lite off, then Q.
live = toggleFourK(toggleLite(mode('low', 'auto')));
assert.deepEqual(live, mode('balanced', '4k'));

// ---- click targets, on a minimal stand-in for the DOM ----
// A fake element knows what it is (tag, attributes, parent); closest() answers
// the simple selectors the rules use.
const el = (tag, attrs = {}, parent = null) => {
  const node = {
    tag, attrs, parent, type: attrs.type,
    getAttribute: (name) => (name in attrs ? String(attrs[name]) : null),
    matches(selector) {
      return selector.split(',').map((part) => part.trim()).some((part) => {
        const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        if (attr) return attr[1] in this.attrs && (attr[2] === undefined || String(this.attrs[attr[1]]) === attr[2]);
        return part === this.tag;
      });
    },
    closest(selector) {
      for (let cursor = this; cursor; cursor = cursor.parent) if (cursor.matches(selector)) return cursor;
      return null;
    },
  };
  return node;
};
const stage = el('div', { 'data-newamp-fullscreen-visualizer': '' });
const canvas = el('canvas', {}, el('div', {}, stage));
const toolbar = el('div', { 'data-newamp-visualizer-toolbar': '' }, stage);
const next = el('button', {}, toolbar);
const toolbarGap = el('div', {}, toolbar);
const nowBar = el('div', { 'data-newamp-viz-now': '' }, stage);
const nowTitle = el('div', {}, nowBar);
const meter = el('div', { 'data-newamp-viz-hover-meter': '' }, stage);
const meterInput = el('input', { type: 'range' }, el('div', {}, meter));
const dialog = el('div', { role: 'dialog' }, stage);
const dialogText = el('span', {}, dialog);
const menu = el('div', { role: 'menu' }, stage);
const menuItem = el('button', { role: 'menuitem' }, menu);
const popoverBackdrop = el('div', { 'data-newamp-viz-popover-backdrop': '' }, stage);
const menuBackdrop = el('div', { 'data-newamp-viz-menu-backdrop': '' }, stage);

assert.equal(isStageTarget(stage), true, 'the stage root is the stage');
assert.equal(isStageTarget(canvas), true, 'the visualizer canvas is the stage');
assert.equal(isStageTarget(next), false, 'double-clicking next must not flip fullscreen');
assert.equal(isStageTarget(toolbarGap), false, 'nor the empty part of the toolbar');
assert.equal(isStageTarget(nowTitle), false, 'nor the now-playing block');
assert.equal(isStageTarget(meter), false, 'the hover meter resets volume instead');
assert.equal(isStageTarget(meterInput), false);
assert.equal(isStageTarget(dialogText), false, 'nor anything inside a popover');
assert.equal(isStageTarget(menuItem), false);
assert.equal(isStageTarget(popoverBackdrop), false, 'a double-click that dismisses a popover must not flip fullscreen');
assert.equal(isStageTarget(menuBackdrop), false);
assert.equal(isStageTarget(null), false);
assert.equal(isStageTarget({}), false);

assert.equal(opensVisualizerMenu(stage), true);
assert.equal(opensVisualizerMenu(canvas), true);
assert.equal(opensVisualizerMenu(toolbarGap), true, 'bare toolbar space still opens the menu');
assert.equal(opensVisualizerMenu(nowTitle), true);
assert.equal(opensVisualizerMenu(popoverBackdrop), true, 'a right-click on the scrim moves the menu there');
assert.equal(opensVisualizerMenu(menuBackdrop), true);
assert.equal(opensVisualizerMenu(next), false, 'a right-click on a button is not the stage');
assert.equal(opensVisualizerMenu(meterInput), false);
assert.equal(opensVisualizerMenu(dialogText), false);
assert.equal(opensVisualizerMenu(menuItem), false);
assert.equal(isInsideMenu(menuItem), true);
assert.equal(isInsideMenu(next), false);
assert.equal(isInsideMenu(null), false);

assert.equal(keyTargetKind(el('input', { type: 'text' })), 'text');
assert.equal(keyTargetKind(el('input', {})), 'text', 'an untyped input is a text box');
assert.equal(keyTargetKind(el('input', { type: 'range' })), 'slider');
assert.equal(keyTargetKind(el('input', { type: 'checkbox' })), 'other');
assert.equal(keyTargetKind(el('textarea')), 'text');
assert.equal(keyTargetKind(el('select')), 'text');
assert.equal(keyTargetKind(el('div', { contenteditable: 'true' })), 'text');
assert.equal(keyTargetKind(el('div', { role: 'textbox' })), 'text');
assert.equal(keyTargetKind(next), 'other');
assert.equal(keyTargetKind(null), 'other');

// ---- menu placement ----
const viewport = { width: 1280, height: 800 };
const size = { width: 220, height: 300 };
assert.deepEqual(placeMenu({ x: 300, y: 300 }, size, viewport), { left: 300, top: 300 }, 'opens at the pointer when it fits');
assert.deepEqual(placeMenu({ x: 1200, y: 300 }, size, viewport), { left: 980, top: 300 }, 'flips left of the pointer at the right edge');
assert.deepEqual(placeMenu({ x: 300, y: 700 }, size, viewport), { left: 300, top: 400 }, 'flips above the pointer at the bottom edge');
assert.deepEqual(placeMenu({ x: 1279, y: 799 }, size, viewport), { left: 1052, top: 492 }, 'the corner flips both ways and keeps the margin');
assert.deepEqual(placeMenu({ x: 0, y: 0 }, size, viewport), { left: 8, top: 8 }, 'clamped off the top-left edge');
assert.deepEqual(placeMenu({ x: 100, y: 100 }, { width: 220, height: 2000 }, viewport), { left: 100, top: 8 }, 'a menu taller than the window sits at the top margin');
const small = { width: 200, height: 150 };
for (const x of [0, 5, 100, 190, 199]) {
  for (const y of [0, 5, 70, 140, 149]) {
    const spot = placeMenu({ x, y }, { width: 120, height: 90 }, small);
    assert.ok(spot.left >= 8 && spot.left + 120 <= small.width - 8, `menu stays inside horizontally for pointer ${x},${y}: ${JSON.stringify(spot)}`);
    assert.ok(spot.top >= 8 && spot.top + 90 <= small.height - 8, `menu stays inside vertically for pointer ${x},${y}: ${JSON.stringify(spot)}`);
  }
}

const parent = { left: 300, top: 400, right: 520, bottom: 428 };
assert.deepEqual(placeSubmenu(parent, { width: 200, height: 300 }, viewport), { left: 518, top: 396 }, 'submenu goes to the right, top-aligned with its item');
assert.deepEqual(
  placeSubmenu({ left: 1060, top: 100, right: 1280, bottom: 128 }, { width: 200, height: 300 }, viewport),
  { left: 862, top: 96 },
  'submenu flips to the left when there is no room on the right',
);
assert.deepEqual(placeSubmenu({ left: 300, top: 700, right: 520, bottom: 728 }, { width: 200, height: 300 }, viewport), { left: 518, top: 492 }, 'submenu is pulled up to stay on screen');
assert.equal(placeSubmenu(parent, { width: 200, height: 3000 }, viewport).top, 8, 'a submenu taller than the window sits at the top margin');

// ---- menu keys ----
const all = [true, true, true, true];
assert.equal(stepMenuIndex(all, -1, 'ArrowDown'), 0);
assert.equal(stepMenuIndex(all, 0, 'ArrowDown'), 1);
assert.equal(stepMenuIndex(all, 3, 'ArrowDown'), 0, 'wraps from the last item to the first');
assert.equal(stepMenuIndex(all, 0, 'ArrowUp'), 3, 'wraps from the first item to the last');
assert.equal(stepMenuIndex(all, -1, 'ArrowUp'), 3);
assert.equal(stepMenuIndex(all, 2, 'Home'), 0);
assert.equal(stepMenuIndex(all, 0, 'End'), 3);
const gaps = [false, true, false, true, false];
assert.equal(stepMenuIndex(gaps, 1, 'ArrowDown'), 3, 'skips disabled items');
assert.equal(stepMenuIndex(gaps, 3, 'ArrowDown'), 1, 'and wraps past them');
assert.equal(stepMenuIndex(gaps, 1, 'ArrowUp'), 3);
assert.equal(stepMenuIndex(gaps, 0, 'Home'), 1);
assert.equal(stepMenuIndex(gaps, 0, 'End'), 3);
assert.equal(stepMenuIndex([false, false], 0, 'ArrowDown'), -1, 'nothing enabled, nothing to focus');
assert.equal(stepMenuIndex([], -1, 'Home'), -1);

// ---- look lock ----
const lookOf = (eviland, director, autoVj) => ({ eviland, director, autoVj });
assert.equal(isLookLocked(lookOf(true, true, false)), false, 'the Director is changing an Eviland look');
assert.equal(isLookLocked(lookOf(true, false, false)), true);
assert.equal(isLookLocked(lookOf(true, false, true)), false, 'Auto-VJ moves off the Eviland modes too');
assert.equal(isLookLocked(lookOf(false, true, false)), true, 'the Director does not touch the other modes');
assert.equal(isLookLocked(lookOf(false, false, true)), false);
assert.deepEqual(toggleLookLock(lookOf(true, true, false)), { director: false, autoVj: false }, 'locking an Eviland look switches the Director off');
assert.deepEqual(toggleLookLock(lookOf(true, true, true)), { director: false, autoVj: false }, 'and Auto-VJ');
assert.deepEqual(toggleLookLock(lookOf(true, false, false)), { director: true, autoVj: false }, 'unlocking an Eviland look hands it back to the Director');
assert.deepEqual(toggleLookLock(lookOf(false, true, true)), { director: true, autoVj: false }, 'locking another mode leaves the Director as it was');
assert.deepEqual(toggleLookLock(lookOf(false, true, false)), { director: true, autoVj: true }, 'unlocking another mode turns Auto-VJ on');
for (const eviland of [true, false]) {
  for (const director of [true, false]) {
    for (const autoVj of [true, false]) {
      const state = lookOf(eviland, director, autoVj);
      const next = toggleLookLock({ ...state });
      assert.notEqual(isLookLocked({ eviland, ...next }), isLookLocked(state), `toggling the lock flips it: ${JSON.stringify(state)}`);
    }
  }
}

// ---- random mode ----
const ids = ['a', 'b', 'c', 'd'];
assert.equal(pickRandomPreset(ids, 'b', () => 0), 'a');
assert.equal(pickRandomPreset(ids, 'b', () => 0.999999), 'd');
for (let step = 0; step < 100; step += 1) assert.notEqual(pickRandomPreset(ids, 'c', () => step / 100), 'c', 'never the current mode');
assert.equal(pickRandomPreset(['only'], 'only'), 'only');

// ---- leaving the visualizer ----
assert.equal(fullscreenToRestore(true, false), true, 'an app that was fullscreen stays fullscreen');
assert.equal(fullscreenToRestore(false, false), false);
assert.equal(fullscreenToRestore(true, true), false, 'deck mode is never fullscreen');
assert.equal(fullscreenToRestore(null, false), null, 'unknown until the first answer: leave the window alone');
// Detach hands over to the projector window, which a fullscreen app window would hide on one monitor.
assert.equal(fullscreenToRestore(true, false, true), false, 'popping out to the projector leaves OS fullscreen');
assert.equal(fullscreenToRestore(false, false, true), false);
assert.equal(fullscreenToRestore(null, false, true), false, 'even before the opening state is known');
assert.equal(fullscreenToRestore(true, true, true), false);

// ---- stepping a held arrow ----
// The settings write answers with the value it was sent. With two picks in flight, the first
// answer rolls the store back one step; the next press must not step from the rolled-back value.
const stepFrom = (last, now, stored) => presetStepBase(last, now, stored);
assert.equal(stepFrom(null, 1000, 'a'), 'a', 'with nothing picked, the store is the truth');
assert.equal(stepFrom({ id: 'b', at: 990 }, 1000, 'a'), 'b', 'a pick a moment ago beats a store that has not caught up');
assert.equal(stepFrom({ id: 'c', at: 1000 }, 1010, 'b'), 'c', 'two picks in flight: the first answer rolled the store back to b');
assert.equal(stepFrom({ id: 'c', at: 1000 }, 1000 + PRESET_ECHO_WINDOW_MS - 1, 'a'), 'c');
assert.equal(stepFrom({ id: 'c', at: 1000 }, 1000 + PRESET_ECHO_WINDOW_MS, 'a'), 'a', 'once the window has passed the store is the truth again');
{
  // A held key outruns the store: simulate it. Picks land at once, the answers come back late and stale.
  const order = ['a', 'b', 'c', 'd', 'e'];
  let stored = 'a';
  let last = null;
  const pick = (id, now) => { last = { id, at: now }; stored = id; };
  const step = (now) => pick(order[(order.indexOf(presetStepBase(last, now, stored)) + 1) % order.length], now);
  step(0);
  step(10);
  stored = 'b'; // the first answer lands after the second pick and rolls the store back
  step(20);
  step(30);
  assert.equal(last.id, 'e', 'four presses are four steps even with a stale answer in between');
  stored = last.id;
}
// Without the guard the same sequence stalls: the press after the rollback re-picks c.
{
  const order = ['a', 'b', 'c', 'd', 'e'];
  let stored = 'a';
  const step = () => { stored = order[(order.indexOf(stored) + 1) % order.length]; };
  step();
  step();
  stored = 'b';
  step();
  assert.equal(stored, 'c', 'stepping from the store alone repeats a preset (this is what presetStepBase avoids)');
}

// ---- scrolling lists keep the wheel ----
assert.equal(scrollKeepsWheel({ scrollHeight: 930, clientHeight: 700 }), true, 'a 28-mode list in a short window scrolls');
assert.equal(scrollKeepsWheel({ scrollHeight: 300, clientHeight: 300 }), false, 'one that fits leaves the wheel to the stage');
assert.equal(scrollKeepsWheel({ scrollHeight: 301, clientHeight: 300 }), false, 'a pixel of rounding is not a scrollbar');
assert.equal(scrollKeepsWheel({ scrollHeight: 302, clientHeight: 300 }), true);

// ---- popover focus ----
// Only a control the keyboard focused is an opener to go back to. A mouse press focuses a
// button too, and going back to it would make the next Space press it instead of pausing.
const focusable = (matchesFocusVisible) => ({
  matches: (selector) => {
    if (selector !== ':focus-visible') throw new Error(`unexpected selector ${selector}`);
    if (matchesFocusVisible === 'throws') throw new SyntaxError('not a valid selector');
    return matchesFocusVisible;
  },
});
const keyboardFocused = focusable(true);
const mouseFocused = focusable(false);
const pageBody = { body: true };
assert.equal(keyboardOpener(keyboardFocused, pageBody), keyboardFocused, 'a keyboard-focused button is an opener');
assert.equal(keyboardOpener(mouseFocused, pageBody), null, 'a button a mouse press focused is not');
assert.equal(keyboardOpener(null, pageBody), null, 'nothing focused');
assert.equal(keyboardOpener(pageBody, pageBody), null, 'the page itself is not a control to return to');
assert.equal(keyboardOpener(focusable('throws'), pageBody), null, 'no :focus-visible support: no opener');
{
  // The flow end to end: open from the toolbar, close, where does focus go?
  const stageRoot = { isConnected: true, focus() {} };
  const toggle = { isConnected: true, focus() {}, matches: () => false };
  const closedWith = (active) =>
    pickFocusRestoreTarget({
      opener: keyboardOpener(active, pageBody),
      active: pageBody,
      body: pageBody,
      panel: { contains: () => false },
      fallback: stageRoot,
    });
  const keyboardToggle = { ...toggle, matches: () => true };
  assert.equal(closedWith(toggle), stageRoot, 'opened with the mouse: focus goes to the stage, so Space pauses');
  assert.equal(closedWith(keyboardToggle), keyboardToggle, 'opened from the keyboard: back on the toggle');
}
const node = (connected = true) => ({ isConnected: connected, focus() {}, inside: [] });
const panelOf = (...inside) => ({ contains: (value) => inside.includes(value) });
const body = { body: true };
const opener = node();
const fallback = node();
const inPanel = node();
const elsewhere = node();
const restore = (overrides) => pickFocusRestoreTarget({ opener, active: inPanel, body, panel: panelOf(inPanel), fallback, ...overrides });
assert.equal(restore({}), opener, 'closing from inside the popover returns to the opener');
assert.equal(restore({ active: body }), opener, 'so does focus that fell to the page');
assert.equal(restore({ active: null }), opener);
assert.equal(restore({ active: elsewhere }), null, 'focus that moved to another control stays there');
assert.equal(restore({ opener: node(false) }), fallback, 'an opener that is gone falls back to the stage');
assert.equal(restore({ opener: null }), fallback);
assert.equal(restore({ opener: inPanel, panel: panelOf(inPanel) }), fallback, 'an opener inside the closing popover is not a place to return to');
assert.equal(restore({ opener: null, fallback: null }), null);
assert.equal(restore({ opener: null, fallback: node(false) }), null);

// ---- menu markup ----
{
  const menuModule = await bundle(
    `import { createElement } from 'react';
     import { renderToStaticMarkup } from 'react-dom/server';
     import { VisualizerMenu } from './src/components/VisualizerMenu';
     export { createElement, renderToStaticMarkup, VisualizerMenu };`,
    { jsx: true },
  );
  const noop = () => {};
  const originalError = console.error;
  console.error = () => {}; // useLayoutEffect warns under server rendering; the markup is what is under test
  let html;
  try {
    html = menuModule.renderToStaticMarkup(
      menuModule.createElement(menuModule.VisualizerMenu, {
        at: { x: 300, y: 300 },
        entries: [
          { type: 'heading', label: 'Spectrum' },
          { type: 'item', id: 'next', label: 'Next look', hint: ']', onSelect: noop },
          { type: 'item', id: 'lock', label: 'Lock look', checked: true, onSelect: noop },
          { type: 'item', id: 'off', label: 'Greyed', disabled: true, onSelect: noop },
          { type: 'separator' },
          { type: 'submenu', id: 'mode', label: 'Mode', entries: [{ type: 'item', id: 'mode:radial', label: 'Radial', checked: true, radio: true, onSelect: noop }] },
        ],
        onClose: noop,
        fallbackFocus: { current: null },
      }),
    );
  } finally {
    console.error = originalError;
  }
  assert.match(html, /role="menu"[^>]*aria-label="Visualizer menu"/, 'the menu is a role=menu');
  assert.match(html, /data-newamp-viz-menu=""/, 'and carries the smoke selector');
  assert.match(html, /left:300px;top:300px;visibility:hidden/, 'it starts at the pointer, hidden until measured');
  assert.match(html, /role="menuitem"[^>]*data-newamp-viz-menu-item="next"/, 'commands are menuitems');
  assert.match(html, /role="menuitemcheckbox" aria-checked="true"[^>]*data-newamp-viz-menu-item="lock"/, 'the lock is a checkbox item');
  assert.match(html, /aria-haspopup="menu" aria-expanded="false"[^>]*data-viz-menu-sub="mode"/, 'the mode list is a submenu');
  assert.match(html, /disabled=""[^>]*data-newamp-viz-menu-item="off"/, 'a disabled item is disabled');
  assert.match(html, /role="separator"/);
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 5, 'the list and its four items are focused by the menu, not tabbed to');
  assert.ok(!/role="menuitemradio"/.test(html), 'the closed submenu is not in the DOM yet');
}

// ---- wiring ----
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [viz, css] = await Promise.all([read('src/components/FullscreenVisualizer.tsx'), read('src/styles/views/visualizer.css')]);
assert.match(viz, /resolveVisualizerKey\(\{/, 'the key handler goes through the shared rules');
assert.match(viz, /useLatestRef\(handleKeyDown\)/, 'and is called through a ref so its toggles are never stale');
assert.match(viz, /addEventListener\('keydown', onKeyDown, true\)/, 'in the capture phase');
assert.doesNotMatch(viz, /\}, \[activeIndex, openPanel\]\)/, 'the key effect no longer closes over activeIndex and openPanel');
assert.match(viz, /event\.repeat && !isRepeatableVisualizerAction\(action\)/, 'held keys do not repeat');
assert.match(viz, /loadStoredBoolean\(VIZ_SHOW_ART_KEY, false\)/, 'the album cover overlay is off until someone turns it on');
assert.match(viz, /onDoubleClick=\{\(e\) => \{\s*if \(isStageTarget\(e\.target\)\) toggleNativeFullscreen\(\);/, 'only the stage double-click flips fullscreen');
assert.match(viz, /data-newamp-viz-hover-meter[\s\S]{0,260}onDoubleClick=\{\(\) => void setVolume\(1\)\}/, 'double-click on the hover meter sets 100%');
assert.match(viz, /double-click for 100%/, 'and its tooltip says so');
assert.match(viz, /onContextMenu=\{\(e\) => \{[\s\S]{0,300}setMenu\(\{ x: e\.clientX, y: e\.clientY \}\)/, 'right-click opens the menu at the pointer');
assert.match(viz, /<VisualizerMenu[\s\S]{0,200}at=\{menu\}/);
assert.match(viz, /if \(menu\) setMenu\(null\);\s*else if \(openPanel\) setOpenPanel\(null\);\s*else exitVisualizer\(\);/, 'Esc closes the menu, then a popover, then the visualizer');
assert.match(viz, /fullscreenToRestore\(\s*openingFullscreenRef\.current,\s*usePlayerStore\.getState\(\)\.compactMode,\s*toProjectorRef\.current,?\s*\)/, 'closing restores the fullscreen state the visualizer opened in, unless it is handing over to the projector');
assert.equal((viz.match(/detached\.open\(/g) ?? []).length, 1, 'the projector opens in one place');
assert.equal((viz.match(/openProjector\(\);/g) ?? []).length, 2, 'from the toolbar and from the projector row');
assert.match(viz, /function openProjector\(\): void \{\s*detached\.open\(detachedDisplayId \?\? undefined\);\s*toProjectorRef\.current = true;\s*exitVisualizer\(\);/, 'and both leave OS fullscreen with the overlay');
assert.match(viz, /function exitVisualizer\(\): void \{\s*setFs\(false\);\s*\}/, 'and leaving does not force windowed first');
assert.equal((viz.match(/ref=\{panelRef\}/g) ?? []).length, 3, 'all three popovers take and give back focus');
assert.match(viz, /usePopoverFocus\(panelRef, openPanel, rootRef\)/);
assert.match(viz, /useScrollKeepsWheel\(panelRef, openPanel\)/, 'a popover taller than the window scrolls on the wheel');
assert.match(viz, /altGraph: event\.getModifierState\('AltGraph'\)/, 'AltGr is read off the event');
assert.match(viz, /keyTargetInStage\(target, rootRef\.current, \[document\.body, document\.documentElement\]\);\s*if \(!visualizerTakesKey\(action, kind, inStage\)\) return;/, 'the key handler asks the shared rules whether the stage takes the key');
assert.match(viz, /presetStepBase\(lastPickRef\.current, window\.performance\.now\(\), usePlayerStore\.getState\(\)\.vizPreset\)/, 'a held arrow steps from the last pick');
assert.match(viz, /lastPickRef\.current = \{ id, at: window\.performance\.now\(\) \};\s*setPreset\(id\);/, 'every pick records itself');
assert.match(viz, /autoVjSetPresetRef = useLatestRef\(pickPreset\)/, 'including the ones Auto-VJ makes');
assert.match(viz, /data-newamp-fullscreen-visualizer[\s\S]{0,1200}role="region"\s+aria-label="Visualizer"\s+tabIndex=\{-1\}/, 'the stage that takes focus has a name for a screen reader');
const [popoverFocus, menuSource] = await Promise.all([read('src/components/usePopoverFocus.ts'), read('src/components/VisualizerMenu.tsx')]);
assert.match(popoverFocus, /keyboardOpener\(active instanceof HTMLElement \? active : null, document\.body\)/, 'the popovers, the menu and the stage share one opener rule');
assert.equal((popoverFocus.match(/focusedByKeyboard\(\)/g) ?? []).length, 3, 'defined once, used by the popover hook and the stage hook');
assert.match(menuSource, /const opener = focusedByKeyboard\(\);/, 'and so does the menu');
assert.match(menuSource, /useScrollKeepsWheel\(listRef\);/, 'the menu and its submenu scroll on the wheel when they are taller than the window');
assert.match(viz, /savingClipRef\.current/, 'a second Shift+R cannot start a second save');
assert.match(viz, /toggleFourK\(\{ tier: perfTierRef\.current, quality: qualityRef\.current \}\)/, 'Q reads the live tier, not the last render');
assert.match(viz, /toggleLite\(\{ tier: perfTierRef\.current, quality: qualityRef\.current \}\)/, 'and so does L');
assert.match(viz, /data-newamp-viz-now/, 'the now-playing block is marked as controls');
assert.match(viz, /data-newamp-viz-projector-row/, 'the projector has a row of its own');
assert.match(viz, /\{detached\.available && \(\s*<div className="viz-setting-row" data-newamp-viz-projector-row>/, 'shown in every mode, not only Eviland');
assert.doesNotMatch(viz, /Eviland \(engine\)|Crazy GPU shaders/, 'the awkward mode labels are gone');
assert.match(viz, /label: 'Shaders'/);
assert.match(viz, /activePreset === 'butterchurn' \? \(/, 'plain MilkDrop does not get a Reactivity label it cannot honour');
assert.equal((viz.match(/<kbd>Esc<\/kbd>/g) ?? []).length, 1, 'the help list has one Esc row');
assert.match(viz, /<kbd>Shift<\/kbd> <kbd>L<\/kbd>/, 'Lite is documented on Shift+L');
assert.match(viz, /<kbd>Shift<\/kbd> <kbd>V<\/kbd>/, 'Auto-VJ on Shift+V');
assert.match(viz, /<kbd>Shift<\/kbd> <kbd>R<\/kbd>/, 'and the replay clip is listed');
const backdropRule = /\.viz-popover-backdrop \{([^}]*)\}/.exec(css);
assert.ok(backdropRule, 'the popover backdrop rule exists');
assert.doesNotMatch(backdropRule[1], /backdrop-filter/, 'the scrim must not re-blur the live stage every frame');
assert.match(backdropRule[1], /rgba\(0, 0, 0, 0\.1\d*\)/, 'and is lighter than it was');
assert.match(css, /\.viz-menu \{[^}]*position: fixed/, 'the menu is placed with fixed coordinates');
assert.doesNotMatch(/\.viz-menu \{([^}]*)\}/.exec(css)[1], /backdrop-filter|transform/, 'the menu must stay the viewport-relative parent of its submenu');

console.log(JSON.stringify({ ok: true }, null, 2));
