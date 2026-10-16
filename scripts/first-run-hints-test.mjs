// First-run hints point at a control instead of floating bottom-centre over
// whatever view is open. A hint whose control is not on screen (fullscreen
// visualizer, first-launch tour, a sidebar scrolled past the control, a dialog
// in front) falls back to the title bar or waits and tries again; it is only
// marked as shown once it is actually up. Runs the real component against a
// stub of React's hooks and a fake clock (the repo has no DOM test runner).
// Run: node scripts/first-run-hints-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleComponent, findAll, mount } from './lib/hook-harness.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// --- Browser stubs -----------------------------------------------------------
const QUICK = 'newamp:firstrun:quickPlayTip';
const VIZ = 'newamp:firstrun:fullscreenVizTip';
const DECK = 'newamp:firstrun:compactDeckTip';
const TITLEBAR = '[data-newamp-hint-anchor="titlebar"]';
const VIZ_BUTTON = '[data-newamp-open-visualizer]';
const DECK_BUTTON = '[data-newamp-hint-anchor="deck"]';
const TOUR = '[data-newamp-first-launch-tutorial]';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const element = (box, extra = {}) => {
  const el = { getBoundingClientRect: () => box, box, contains: (node) => node === el, ...extra };
  return el;
};

const clock = { now: 0, nextId: 1, timers: new Map() };
const storage = new Map();
const listeners = new Map();
let dom = {};
let covers = [];
const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const inside = (box, x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
defineGlobal('document', {
  querySelector: (selector) => dom[selector] ?? null,
  // What a hit test finds: something in front first, else the smallest control under the point.
  elementFromPoint(x, y) {
    const cover = covers.find((el) => inside(el.box, x, y));
    if (cover) return cover;
    const under = Object.values(dom).filter((el) => inside(el.box, x, y));
    under.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
    return under[0] ?? null;
  },
});
defineGlobal('window', {
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, String(value)),
  },
  setTimeout(fn, delay = 0) {
    const id = clock.nextId++;
    clock.timers.set(id, { fn, at: clock.now + delay });
    return id;
  },
  clearTimeout: (id) => void clock.timers.delete(id),
  requestAnimationFrame(fn) { return this.setTimeout(fn, 16); },
  cancelAnimationFrame(id) { clock.timers.delete(id); },
  addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
  removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn)); },
  getComputedStyle: (el) => ({ visibility: el.visibility ?? 'visible' }),
});

const controls = () => ({
  [TITLEBAR]: element(rect(0, 0, 1280, 40)),
  [VIZ_BUTTON]: element(rect(70, 650, 56, 24)),
  [DECK_BUTTON]: element(rect(1050, 8, 48, 24)),
});

function advance(view, ms) {
  const target = clock.now + ms;
  for (;;) {
    const due = [...clock.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, timer] = due;
    clock.timers.delete(id);
    clock.now = timer.at;
    timer.fn();
    view.flush();
  }
  clock.now = target;
}

const { FirstRunHintsBody } = await bundleComponent('src/components/FirstRunHintsBody.tsx', {
  '../lib/format': `export const shortcutLabel = () => 'Cmd+K'; export const deckModeShortcutLabel = () => 'Cmd+Shift+D';`,
});

function start() {
  clock.now = 0;
  clock.timers.clear();
  storage.clear();
  listeners.clear();
  window.innerWidth = 1280;
  dom = controls();
  covers = [];
  const view = mount(() => FirstRunHintsBody());
  view.flush();
  return view;
}
const hintOf = (view) => view.output;
const bodyOf = (hint) => [hint.props.children].flat()[0];
const pointer = (view) => findAll(view.output, (node) => node.type === 'span' && node.props?.['aria-hidden'])[0];

// --- Each hint appears at its control ----------------------------------------
{
  const view = start();
  advance(view, 2_999);
  assert.equal(hintOf(view), null, 'nothing before the first hint is due');
  assert.equal(storage.get(QUICK), undefined);

  advance(view, 1);
  let hint = hintOf(view);
  assert.ok(hint, 'the Quick Play hint shows when due');
  assert.equal(hint.props.role, 'status');
  assert.equal(hint.props.style?.position, 'fixed', 'positioned from the control, not by the stylesheet');
  assert.match(bodyOf(hint), /Press Cmd\+K to search anything\./);
  assert.equal(storage.get(QUICK), 'shown', 'marked shown the moment it is up');
  let style = hint.props.style;
  assert.equal(style.bottom, 'auto', 'no longer pinned 122px above the bottom edge');
  assert.equal(style.top, 40 + 14, 'hangs from the title bar');
  assert.equal(style.left, 640, 'centred on the title bar');
  assert.equal(style.transform, 'translateX(-50%)');
  assert.equal(style.animation, 'none', "the stylesheet's centred entry animation is off");
  assert.equal(style.opacity, 0, 'fades in from the first frame');
  assert.equal(pointer(view).props.style.left, '50%', 'a pointer ties the hint to the title bar');
  advance(view, 16);
  assert.equal(hintOf(view).props.style.opacity, 1);

  advance(view, 6_000);
  assert.equal(hintOf(view), null, 'the hint leaves after its duration');

  advance(view, 90_000 - 3_000 - 6_000 - 16);
  hint = hintOf(view);
  assert.ok(hint, 'the visualizer hint shows when due');
  assert.match(bodyOf(hint), /Press F for the fullscreen visualizer\./);
  style = hint.props.style;
  assert.equal(style.left, 70 + 56 + 14, 'beside the VIZ button');
  assert.equal(style.top, 650 + 12);
  assert.equal(style.transform, 'translateY(-50%)');
  assert.equal(storage.get(VIZ), 'shown');
  advance(view, 7_000);
  assert.equal(hintOf(view), null);

  advance(view, 210_000 - 90_000 - 7_000);
  hint = hintOf(view);
  assert.ok(hint, 'the deck hint shows when due');
  assert.match(bodyOf(hint), /Press Cmd\+Shift\+D to shrink into the deck/);
  style = hint.props.style;
  assert.equal(style.top, 8 + 24 + 14, 'under the title bar button');
  assert.equal(style.right, 1280 - 1098, 'right-aligned to the button, so it stays inside the window');
  assert.equal(style.left, 'auto');
  assert.equal(style.transform, 'none');
  assert.equal(storage.get(DECK), 'shown');
  view.unmount();
}

// --- The visualizer hint falls back to the title bar ------------------------------
// Scrolled out of the sidebar, the VIZ button sits under the transport: in the
// DOM and inside the window, but with the transport at its centre point.
{
  const view = start();
  covers.push(element(rect(0, 600, 260, 200)));
  advance(view, 90_000);
  const hint = hintOf(view);
  assert.ok(hint, 'a covered control does not cost the user the hint');
  assert.equal(hint.props.style.top, 54, 'it hangs from the title bar instead');
  assert.equal(hint.props.style.left, 640);
  view.unmount();

  const below = start();
  dom[VIZ_BUTTON] = element(rect(70, 900, 56, 24));
  advance(below, 90_000);
  assert.equal(hintOf(below).props.style.top, 54, 'a control below the window gets the same fallback');
  below.unmount();

  const empty = start();
  dom[VIZ_BUTTON] = element(rect(70, 650, 0, 0));
  advance(empty, 90_000);
  assert.equal(hintOf(empty).props.style.top, 54, 'and so does one collapsed to nothing');
  empty.unmount();
}

// --- A hint with nowhere to point waits, and is not spent ------------------------
{
  const view = start();
  const real = dom;
  dom = {};
  advance(view, 3_000);
  assert.equal(hintOf(view), null, 'no control, no hint');
  assert.equal(storage.get(QUICK), undefined, 'a hint that was never seen is not marked shown');
  advance(view, 5_000);
  assert.equal(hintOf(view), null);
  dom = real;
  advance(view, 5_000);
  assert.ok(hintOf(view), 'it shows once the control is there');
  assert.equal(storage.get(QUICK), 'shown');
  view.unmount();
}

// The first-launch tour covers the window: the hint waits for it to close.
{
  const view = start();
  dom[TOUR] = element(rect(0, 0, 1280, 800));
  advance(view, 3_000);
  assert.equal(hintOf(view), null, 'no hint over the tour');
  assert.equal(storage.get(QUICK), undefined);
  delete dom[TOUR];
  advance(view, 5_000);
  assert.ok(hintOf(view), 'the hint comes once the tour is closed');
  view.unmount();
}

// A dialog in front of the title bar is in the way too.
{
  const view = start();
  covers.push(element(rect(0, 0, 1280, 800)));
  advance(view, 3_000);
  assert.equal(hintOf(view), null, 'nothing is shown behind a dialog');
  assert.equal(storage.get(QUICK), undefined);
  covers = [];
  advance(view, 5_000);
  assert.ok(hintOf(view), 'shown once the dialog is gone');
  view.unmount();
}

// The fullscreen visualizer hides the app chrome: a hidden control is not a place to show a hint.
{
  const view = start();
  for (const selector of [TITLEBAR, VIZ_BUTTON]) dom[selector].visibility = 'hidden';
  advance(view, 90_000);
  assert.equal(hintOf(view), null);
  assert.equal(storage.get(VIZ), undefined, 'not spent while hidden');
  for (const selector of [TITLEBAR, VIZ_BUTTON]) dom[selector].visibility = 'visible';
  advance(view, 5_000);
  assert.ok(hintOf(view), 'shown once the chrome is back');
  assert.equal(storage.get(VIZ), 'shown');
  view.unmount();
}

// A control that never comes back uses up the retries and leaves the hint for the next launch.
{
  const view = start();
  dom = {};
  advance(view, 3_000 + 12 * 5_000 + 1_000);
  assert.equal(hintOf(view), null);
  assert.equal(storage.get(QUICK), undefined, 'still unseen, so it gets another try on a later launch');
  assert.equal([...clock.timers.values()].filter((timer) => timer.at < 90_000).length, 0, 'the retries stop');
  view.unmount();
}

// Hints already shown stay shown.
{
  const view = start();
  storage.set(QUICK, 'shown');
  storage.set(VIZ, 'shown');
  storage.set(DECK, 'shown');
  view.unmount();
  const again = mount(() => FirstRunHintsBody());
  again.flush();
  advance(again, 300_000);
  assert.equal(hintOf(again), null);
  again.unmount();
}

// The hint follows its control when the window is resized, and stops listening when it goes.
{
  const view = start();
  advance(view, 3_000);
  assert.equal(hintOf(view).props.style.left, 640);
  assert.equal(listeners.get('resize').length, 1);
  window.innerWidth = 1000;
  dom[TITLEBAR] = element(rect(0, 0, 1000, 40));
  for (const listener of listeners.get('resize')) listener();
  view.flush();
  assert.equal(hintOf(view).props.style.left, 500, 'recentred on the narrower title bar');
  advance(view, 6_000);
  assert.equal(hintOf(view), null);
  assert.equal(listeners.get('resize').length, 0, 'no resize listener once the hint is gone');
  view.unmount();
}

// The bubble is narrowed to the room around its control.
{
  const view = start();
  window.innerWidth = 300;
  dom[TITLEBAR] = element(rect(0, 0, 300, 40));
  advance(view, 3_000);
  assert.equal(hintOf(view).props.style.maxWidth, 2 * (150 - 8), 'a centred bubble keeps clear of both edges');
  view.unmount();

  const side = start();
  dom[VIZ_BUTTON] = element(rect(1100, 400, 100, 30));
  advance(side, 90_000);
  const style = hintOf(side).props.style;
  assert.equal(style.left, 1214);
  assert.equal(style.maxWidth, 1280 - 1214 - 8, 'a bubble beside a control uses the room that is left');
  side.unmount();
}

// The startup chunk only carries a shell; the hints load in their own chunk.
{
  const shell = read('src/components/FirstRunHints.tsx');
  assert.match(shell, /import\('\.\/FirstRunHintsBody'\)/, 'the hints are a lazy chunk');
  assert.match(shell, /<Suspense fallback=\{null\}>/, 'nothing shows while the chunk loads');
  assert.doesNotMatch(shell, /localStorage|setTimeout/, 'the shell holds none of the hint logic');
  assert.match(read('src/App.tsx'), /<FirstRunHints \/>/, 'App still mounts the shell');
  // Chords are labelled through the platform helper, never a literal Ctrl.
  const stripped = read('src/components/FirstRunHintsBody.tsx').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(stripped, /Ctrl/, 'the hint text names chords through shortcutLabel');
}

// The anchors the hints look for are on the title bar.
{
  const titleBar = read('src/components/TitleBar.tsx');
  assert.match(titleBar, /data-newamp-hint-anchor="titlebar"/, 'the title bar carries the anchor the palette and visualizer hints use');
  assert.match(titleBar, /data-newamp-hint-anchor="deck"/, 'the title bar DECK button carries the anchor the deck hint looks for');
}

console.log('PASS first-run hints');
