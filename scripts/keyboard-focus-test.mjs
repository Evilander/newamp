// Keyboard focus and platform chords: the shortcut resolver's slider, Cmd and
// platform handling, the chord helpers and label renderer, the target
// classifier's mouse-focus rule, and the ScrubBar thumb/focus behaviour, which
// runs against a stub of React's hooks because the repo has no DOM test
// runner.
// Run with: npm run test:keyboard-focus

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('keyboard focus test timed out'); process.exit(1); }, 30000);
deadline.unref();

async function bundle(entry, extra = {}) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
    ...extra,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const {
  resolvePlayerShortcut,
  isDeckModeChord,
  isLibrarySearchChord,
  deckModeChord,
  formatShortcut,
  inputShortcutRole,
  createShortcutTargetTracker,
} = await bundle('shared/keyboard-shortcuts.ts');
const { buildAppMenuTemplate } = await bundle('electron/app-menu.ts');

const base = { key: '', code: '', targetEditable: false, fullscreenVisualizer: false };
const press = (input) => resolvePlayerShortcut({ ...base, ...input });

// --- A focused slider keeps its arrow keys and nothing else ---------------
const slider = { targetIsSlider: true };
assert.equal(press({ ...slider, code: 'Space', key: ' ' }), 'toggle-play', 'Space plays/pauses with a slider focused');
assert.equal(press({ ...slider, code: 'ArrowLeft', key: 'ArrowLeft' }), null, 'a focused slider keeps ArrowLeft');
assert.equal(press({ ...slider, code: 'ArrowRight', key: 'ArrowRight' }), null, 'a focused slider keeps ArrowRight');
assert.equal(press({ ...slider, code: 'ArrowUp', key: 'ArrowUp' }), null, 'a focused slider keeps ArrowUp');
assert.equal(press({ ...slider, code: 'ArrowDown', key: 'ArrowDown', shiftKey: true }), null, 'Shift+Arrow is still the slider\'s');
assert.equal(press({ ...slider, code: 'Home', key: 'Home' }), null);
assert.equal(press({ ...slider, code: 'ArrowRight', key: 'ArrowRight', ctrlKey: true }), 'next', 'Ctrl+Right skips even over a slider');
assert.equal(press({ ...slider, code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true }), 'previous');
assert.equal(press({ ...slider, key: 'l', code: 'KeyL' }), 'toggle-love', 'L still loves with a slider focused');
assert.equal(press({ ...slider, key: '4', code: 'Digit4' }), 'rate-4', 'digits still rate with a slider focused');
assert.equal(press({ ...slider, key: 'f', code: 'KeyF' }), 'toggle-fullscreen-visualizer');
assert.equal(press({ code: 'ArrowRight', key: 'ArrowRight' }), 'seek-forward', 'without a slider, arrows still seek');
assert.equal(press({ ...slider, targetEditable: true, code: 'Space', key: ' ' }), null, 'text entry still wins');

// --- Cmd on a Mac, Ctrl everywhere else -----------------------------------
const mac = { platform: 'darwin' };
assert.equal(press({ ...mac, metaKey: true, code: 'ArrowLeft', key: 'ArrowLeft' }), 'previous', 'Cmd+Left is previous on a Mac');
assert.equal(press({ ...mac, metaKey: true, code: 'ArrowRight', key: 'ArrowRight' }), 'next', 'Cmd+Right is next on a Mac');
assert.equal(press({ ...mac, metaKey: true, code: 'ArrowUp', key: 'ArrowUp' }), 'volume-up', 'Cmd+Up is volume up on a Mac');
assert.equal(press({ ...mac, metaKey: true, code: 'ArrowDown', key: 'ArrowDown' }), 'volume-down', 'Cmd+Down is volume down on a Mac');
assert.equal(press({ ...mac, ctrlKey: true, code: 'ArrowRight', key: 'ArrowRight' }), 'next', 'Ctrl+Right keeps working on a Mac');
assert.equal(press({ ...mac, ctrlKey: true, code: 'ArrowUp', key: 'ArrowUp' }), null, 'Ctrl+Up is Mission Control, not volume');
assert.equal(press({ ...mac, metaKey: true, key: 'k', code: 'KeyK' }), null, 'Cmd+K is the palette\'s, not a player command');
assert.equal(press({ ...mac, metaKey: true, key: 'z', code: 'KeyZ' }), null, 'Cmd+Z must not become previous');
assert.equal(press({ ...mac, metaKey: true, code: 'Space', key: ' ' }), null);
assert.equal(press({ ...mac, metaKey: true, altKey: true, code: 'ArrowLeft', key: 'ArrowLeft' }), null, 'Alt chords are left alone');
assert.equal(press({ ...mac, metaKey: true, targetEditable: true, code: 'ArrowLeft', key: 'ArrowLeft' }), null, 'Cmd+Left moves the caret in a text field');
assert.equal(press({ ...mac, metaKey: true, code: 'ArrowRight', key: 'ArrowRight', repeat: true }), null, 'track skips ignore key repeat');
assert.equal(press({ ...mac, metaKey: true, code: 'ArrowUp', key: 'ArrowUp', repeat: true }), 'volume-up', 'volume may repeat');
assert.equal(press({ ...mac, metaKey: true, code: 'ArrowRight', key: 'ArrowRight', fullscreenVisualizer: true }), 'next', 'Cmd+Right skips inside the visualizer');
assert.equal(press({ ...mac, ...slider, metaKey: true, code: 'ArrowLeft', key: 'ArrowLeft' }), 'previous', 'Cmd+Left skips over a slider');

for (const platform of ['win32', 'linux', 'browser', undefined]) {
  assert.equal(press({ platform, metaKey: true, code: 'ArrowRight', key: 'ArrowRight' }), null, `Meta chords are the OS's on ${platform}`);
  assert.equal(press({ platform, ctrlKey: true, code: 'ArrowRight', key: 'ArrowRight' }), 'next', `Ctrl+Right is next on ${platform}`);
  assert.equal(press({ platform, ctrlKey: true, code: 'ArrowLeft', key: 'ArrowLeft' }), 'previous', `Ctrl+Left is previous on ${platform}`);
  assert.equal(press({ platform, ctrlKey: true, code: 'ArrowUp', key: 'ArrowUp' }), null, `Ctrl+Up stays unbound on ${platform}`);
}

// --- Deck mode and Library search chords ----------------------------------
const chord = (key, flags = {}) => ({ key, code: `Key${key.toUpperCase()}`, ...flags });
assert.equal(isDeckModeChord(chord('m', { ctrlKey: true }), 'win32'), true, 'Ctrl+M is the deck chord on Windows');
assert.equal(isDeckModeChord(chord('m', { ctrlKey: true }), 'linux'), true);
assert.equal(isDeckModeChord(chord('M', { ctrlKey: true, shiftKey: true }), 'win32'), false);
assert.equal(isDeckModeChord(chord('m', { ctrlKey: true, altKey: true }), 'win32'), false);
assert.equal(isDeckModeChord(chord('m', { metaKey: true }), 'win32'), false, 'Win+M is the OS\'s');
assert.equal(isDeckModeChord(chord('m', { ctrlKey: true }), undefined), true);
assert.equal(isDeckModeChord(chord('m', { metaKey: true }), 'darwin'), false, 'Cmd+M must stay Minimize on a Mac');
assert.equal(isDeckModeChord(chord('M', { metaKey: true, shiftKey: true }), 'darwin'), true, 'Cmd+Shift+M is the Mac deck chord');
assert.equal(isDeckModeChord(chord('m', { ctrlKey: true }), 'darwin'), true, 'Ctrl+M keeps working on a Mac');
assert.equal(isDeckModeChord(chord('M', { metaKey: true, shiftKey: true, ctrlKey: true }), 'darwin'), false);
assert.equal(isDeckModeChord(chord('k', { ctrlKey: true }), 'win32'), false);
assert.equal(deckModeChord('darwin'), 'Mod+Shift+M');
assert.equal(deckModeChord('win32'), 'Mod+M');

assert.equal(isLibrarySearchChord(chord('f', { ctrlKey: true }), 'win32'), true, 'Ctrl+F searches the library on Windows');
assert.equal(isLibrarySearchChord(chord('f', { ctrlKey: true }), 'linux'), true);
assert.equal(isLibrarySearchChord(chord('f', { metaKey: true }), 'win32'), false);
assert.equal(isLibrarySearchChord(chord('f', { metaKey: true }), 'darwin'), true, 'Cmd+F searches the library on a Mac');
assert.equal(isLibrarySearchChord(chord('f', { ctrlKey: true }), 'darwin'), false, 'Ctrl+F is forward-char in a Mac text field');
assert.equal(isLibrarySearchChord(chord('f', { ctrlKey: true, metaKey: true }), 'darwin'), false, 'Ctrl+Cmd+F is the View menu\'s full screen');
assert.equal(isLibrarySearchChord(chord('F', { ctrlKey: true, shiftKey: true }), 'win32'), false);
assert.equal(isLibrarySearchChord(chord('f', { ctrlKey: true, altKey: true }), 'win32'), false);
assert.equal(isLibrarySearchChord({ key: 'f' }, 'win32'), false, 'plain F is the visualizer');

// The Mac menu's Window role owns Cmd+M (Minimize), so the deck chord moved off it; and
// no chord the renderer reads may also be an accelerator in that menu, written out
// or implied by a role. Accelerators are compared as chords, not as spellings.
const ACCELERATOR_MODIFIERS = {
  cmdorctrl: 'cmd', commandorcontrol: 'cmd', cmd: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd',
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
};
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];
const ARROW_KEYS = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };

function normalizeAccelerator(accelerator) {
  const parts = String(accelerator).split('+').map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  const modifiers = [...new Set(parts.map((part) => ACCELERATOR_MODIFIERS[part] ?? part))]
    .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return { modifiers, key, text: [...modifiers, key].join('+') };
}

function acceleratorEvent({ modifiers, key }) {
  const arrow = ARROW_KEYS[key];
  const code = arrow ?? (/^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key);
  return {
    key: arrow ?? key,
    code,
    ctrlKey: modifiers.includes('ctrl'),
    altKey: modifiers.includes('alt'),
    shiftKey: modifiers.includes('shift'),
    metaKey: modifiers.includes('cmd'),
  };
}

function claimedByRenderer(accelerator) {
  const event = acceleratorEvent(normalizeAccelerator(accelerator));
  return (
    isDeckModeChord(event, 'darwin') ||
    isLibrarySearchChord(event, 'darwin') ||
    press({ ...event, platform: 'darwin' }) !== null ||
    ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'j'))
  );
}

assert.equal(normalizeAccelerator('Shift+CmdOrCtrl+M').text, 'shift+cmd+m');
assert.equal(normalizeAccelerator('Command+Shift+m').text, normalizeAccelerator('Cmd+Shift+M').text, 'spellings of one chord compare equal');
for (const claimed of [
  'Command+Shift+M', 'Shift+CmdOrCtrl+M', 'Cmd+Shift+m', 'CmdOrCtrl+F', 'Cmd+K', 'Command+J',
  'CmdOrCtrl+Left', 'Cmd+Up', 'Ctrl+M', 'Control+Right',
]) {
  assert.ok(claimedByRenderer(claimed), `${claimed} is a chord the renderer reads`);
}
for (const free of ['Cmd+M', 'CmdOrCtrl+,', 'Ctrl+Cmd+F', 'Cmd+Z', 'CmdOrCtrl+R', 'Alt+Cmd+I', 'CmdOrCtrl+0']) {
  assert.ok(!claimedByRenderer(free), `${free} is not one the renderer reads`);
}

// What Electron's menu roles bind on a Mac without the template saying so.
const ROLE_ACCELERATORS = {
  windowmenu: ['CmdOrCtrl+M'],
  minimize: ['CmdOrCtrl+M'],
  editmenu: ['Cmd+Z', 'Shift+Cmd+Z', 'Cmd+X', 'Cmd+C', 'Cmd+V', 'Cmd+A'],
  reload: ['CmdOrCtrl+R'],
  forcereload: ['CmdOrCtrl+Shift+R'],
  resetzoom: ['CmdOrCtrl+0'],
  zoomout: ['CmdOrCtrl+-'],
  togglefullscreen: ['Ctrl+Cmd+F'],
  hide: ['Cmd+H'],
  hideothers: ['Cmd+Alt+H'],
  quit: ['Cmd+Q'],
};
// The Settings item (and its accelerator) only exists when a handler is wired.
const macMenu = buildAppMenuTemplate('darwin', { appName: 'NewAmp', appVersion: '0.0.0', isPackaged: true, onPreferences: () => {} });
const menuChords = new Map();
const collect = (items) => {
  for (const item of items ?? []) {
    const written = item.accelerator ? [item.accelerator] : [];
    const implied = ROLE_ACCELERATORS[String(item.role ?? '').toLowerCase()] ?? [];
    for (const accelerator of [...written, ...implied]) menuChords.set(normalizeAccelerator(accelerator).text, accelerator);
    collect(Array.isArray(item.submenu) ? item.submenu : []);
  }
};
collect(macMenu);
assert.ok(menuChords.has('cmd+m'), 'the Window menu\'s Minimize is accounted for');
assert.ok(menuChords.has('cmd+,'), 'the explicit Settings accelerator is read');
for (const [chordText, accelerator] of menuChords) {
  assert.ok(!claimedByRenderer(accelerator), `the Mac menu must not also claim ${accelerator} (${chordText})`);
}

// --- Labels ----------------------------------------------------------------
assert.equal(formatShortcut('Mod+K', 'win32'), 'Ctrl+K');
assert.equal(formatShortcut('Mod+K', 'linux'), 'Ctrl+K');
assert.equal(formatShortcut('Mod+K', undefined), 'Ctrl+K');
assert.equal(formatShortcut('Mod+K', 'win32', ' '), 'Ctrl K', 'the spaced form sidebar hints use');
assert.equal(formatShortcut('Mod+K', 'darwin'), '⌘K');
assert.equal(formatShortcut('Mod+K', 'darwin', ' '), '⌘K', 'a Mac label never takes a separator');
assert.equal(formatShortcut('Mod+Shift+M', 'darwin'), '⇧⌘M', 'Mac glyphs run Shift before Command');
assert.equal(formatShortcut('Mod+Shift+M', 'win32'), 'Ctrl+Shift+M');
assert.equal(formatShortcut('Ctrl+Alt+Shift+Mod+X', 'darwin'), '⌃⌥⇧⌘X');
assert.equal(formatShortcut('Mod+←', 'darwin'), '⌘←');
assert.equal(formatShortcut('Mod+←', 'win32'), 'Ctrl+←');
assert.equal(formatShortcut('F', 'darwin'), 'F');
assert.equal(formatShortcut('F', 'win32'), 'F');
assert.ok(!formatShortcut(deckModeChord('darwin'), 'darwin').includes('Ctrl'), 'no Ctrl in the Mac deck label');

// --- Input types -----------------------------------------------------------
for (const type of ['text', 'search', 'number', 'email', 'password', 'url', 'tel', 'date', '', 'something-new']) {
  assert.deepEqual(inputShortcutRole(type), { editable: true, space: false, arrows: false }, `${type || '(empty)'} is text entry`);
}
assert.deepEqual(inputShortcutRole('range'), { editable: false, space: false, arrows: true });
assert.deepEqual(inputShortcutRole('RANGE'), { editable: false, space: false, arrows: true }, 'type match is case-insensitive');
assert.deepEqual(inputShortcutRole('radio'), { editable: false, space: true, arrows: true });
for (const type of ['checkbox', 'button', 'submit', 'reset', 'image', 'color', 'file']) {
  assert.deepEqual(inputShortcutRole(type), { editable: false, space: true, arrows: false }, `${type} is a control`);
}

// --- Target classifier: duck-typed nodes -----------------------------------
const matches = (node, selector) => {
  const parts = selector.split(',').map((part) => part.trim());
  return parts.some((part) => {
    if (part === node.tagName.toLowerCase()) return true;
    const attr = /^\[([\w-]+)="?([^"\]]*)"?\]$/.exec(part);
    return !!attr && node.attrs?.[attr[1]] === attr[2];
  });
};
function node(tagName, { type, attrs, parent } = {}) {
  const self = {
    tagName: tagName.toUpperCase(),
    type,
    attrs,
    parent,
    closest(selector) {
      for (let current = self; current; current = current.parent) {
        if (matches(current, selector)) return current;
      }
      return null;
    },
  };
  return self;
}
const tracker = createShortcutTargetTracker();
const none = { editable: false, button: false, slider: false };
assert.deepEqual(tracker.classify(null), none);
assert.deepEqual(tracker.classify(node('div')), none);
assert.deepEqual(tracker.classify(node('input', { type: 'text' })), { editable: true, button: false, slider: false });
assert.deepEqual(tracker.classify(node('textarea')), { editable: true, button: false, slider: false });
assert.deepEqual(tracker.classify(node('select')), { editable: true, button: false, slider: false });
assert.deepEqual(tracker.classify(node('div', { attrs: { contenteditable: 'true' } })).editable, true);
assert.deepEqual(tracker.classify(node('span', { parent: node('div', { attrs: { role: 'textbox' } }) })).editable, true);
assert.deepEqual(tracker.classify(node('input', { type: 'range' })), { editable: false, button: false, slider: true }, 'a range input is a slider, not text entry');
assert.deepEqual(tracker.classify(node('input', { type: 'checkbox' })), { editable: false, button: true, slider: false });
assert.deepEqual(tracker.classify(node('input', { type: 'radio' })), { editable: false, button: true, slider: true });
assert.deepEqual(tracker.classify(node('button')), { editable: false, button: true, slider: false });
const row = node('div', { attrs: { role: 'button' } });
assert.equal(tracker.classify(node('span', { parent: row })).button, true, 'children of a role="button" row count as the row');
const tableRow = node('tr', { attrs: { tabindex: '0' } });
assert.equal(tracker.classify(tableRow).button, false, 'a focused library table row is not a button');
assert.equal(
  press({ code: 'Space', key: ' ', targetIsButton: tracker.classify(tableRow).button }),
  'toggle-play',
  'Space with a library row focused still plays or pauses',
);

// A mouse press leaves focus on the control; Space there should play, until Tab moves on.
const next = node('button');
const star = node('button');
tracker.pointerDown(next);
assert.equal(tracker.classify(next).button, false, 'Space after clicking a button is not that button\'s');
assert.equal(tracker.classify(star).button, true, 'a different button, reached from the keyboard, still owns Space');
tracker.pointerDown(node('span', { parent: next }));
assert.equal(tracker.classify(next).button, false, 'a press on a child of the button counts as a press on it');
tracker.keyDown('ArrowLeft');
assert.equal(tracker.classify(next).button, false, 'other keys do not hand focus back');
tracker.keyDown('Tab');
assert.equal(tracker.classify(next).button, true, 'after Tab the button is the keyboard\'s again');
tracker.pointerDown(node('div'));
assert.equal(tracker.classify(next).button, true, 'a press on a non-control forgets the earlier one');
const volume = node('input', { type: 'range' });
tracker.pointerDown(volume);
assert.deepEqual(tracker.classify(volume), { editable: false, button: false, slider: true });
// Form controls keep their own Space: a click on a checkbox or radio is followed by Space toggling it again.
for (const type of ['checkbox', 'radio']) {
  const control = node('input', { type });
  tracker.pointerDown(control);
  assert.equal(tracker.classify(control).button, true, `Space after clicking a ${type} is still the ${type}'s`);
}
// A dialog's buttons keep Space too.
const dialogButton = node('button', { parent: node('section', { attrs: { 'aria-modal': 'true' } }) });
tracker.pointerDown(dialogButton);
assert.equal(tracker.classify(dialogButton).button, true, "Space after clicking a button inside a dialog is still that button's");
tracker.pointerDown(next);
assert.equal(tracker.classify(next).button, false, 'a transport button outside any dialog hands Space to the player');
tracker.pointerDown(volume);
assert.equal(tracker.classify(next).button, true, 'pressing a form control forgets the earlier button');

// --- Browser stubs ----------------------------------------------------------
// No DOM runner in this repo, so the components run against hand-rolled stand-ins
// for the few browser and React APIs they touch.
const env = { activeElement: null, now: 1000, elements: [] };
const listeners = new Map();
const timers = new Map();
let timerId = 0;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('window', {
  location: { search: '' },
  addEventListener(type, fn, capture) {
    listeners.set(type, [...(listeners.get(type) ?? []), { fn, capture: !!capture }]);
  },
  removeEventListener(type, fn, capture) {
    listeners.set(type, (listeners.get(type) ?? []).filter((entry) => !(entry.fn === fn && entry.capture === !!capture)));
  },
  dispatchEvent(event) {
    fire(event.type, event);
    return true;
  },
  setTimeout(fn, delay = 0) {
    timers.set(++timerId, { fn, delay });
    return timerId;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
});

const attrSelector = /^\[([\w-]+)(?:="([^"]*)")?\]$/;
const hasAttr = (element, selector) => {
  const match = attrSelector.exec(selector);
  if (!match) throw new Error(`the DOM stub does not know the selector ${selector}`);
  return match[1] in (element.attrs ?? {}) && (match[2] === undefined || element.attrs[match[1]] === match[2]);
};
define('document', {
  get activeElement() { return env.activeElement; },
  body: {},
  querySelector(selector) {
    const [scope, descendant] = selector.split(' ');
    const hit = env.elements.find((element) => hasAttr(element, scope));
    if (!hit || !descendant) return hit ?? null;
    return (hit.children ?? []).find((child) => child.tagName === descendant.toUpperCase()) ?? null;
  },
});
define('performance', { now: () => env.now });

const observers = [];
define('MutationObserver', class {
  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    observers.push(this);
  }
  observe() { this.connected = true; }
  disconnect() { this.connected = false; }
});

const fire = (type, event = { type }) => { for (const { fn } of [...(listeners.get(type) ?? [])]) fn(event); };
const listenerCount = (type) => (listeners.get(type) ?? []).length;
// One pass over the timers due within `maxDelay`; ones they schedule wait for the next call.
const flushTimers = (maxDelay = Infinity) => {
  for (const [id, timer] of [...timers]) {
    if (timer.delay > maxDelay || !timers.has(id)) continue;
    timers.delete(id);
    timer.fn();
  }
};

const stubs = {
  react: `export function useRef(initial) { const h = globalThis.__hooks; const i = h.index++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; }
    export function useState(initial) { const h = globalThis.__hooks; const i = h.index++; if (!(i in h.slots)) h.slots[i] = { value: initial }; const slot = h.slots[i]; return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }]; }
    export function useEffect(fn, deps) { const h = globalThis.__hooks; h.effects.push({ index: h.index++, fn, deps }); }
    export function lazy() { return function LazyBody() { return null; }; }
    export const Suspense = Symbol('Suspense');`,
  'react/jsx-runtime': 'export function jsx(type, props) { return { type, props }; } export const jsxs = jsx; export const Fragment = Symbol("Fragment");',
  '../lib/api': 'export const api = { get platform() { return globalThis.__launcher.platform; } };',
  '../store/usePlayerStore': 'export const usePlayerStore = { getState: () => globalThis.__launcher.store };',
  './QuickPlayPalette': 'export const QuickPlayPaletteBody = () => null;',
};
const virtualModules = {
  name: 'virtual-modules',
  setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|\.\.\/lib\/api|\.\.\/store\/usePlayerStore|\.\/QuickPlayPalette)$/ }, (args) => ({ path: args.path, namespace: 'virtual' }));
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => ({ loader: 'js', contents: stubs[args.path] }));
  },
};

// Runs a component's hooks the way React would: slots persist between renders and
// an effect re-runs only when its deps change.
function createHarness() {
  const hooks = { slots: {}, index: 0, effects: [], deps: {}, cleanups: {} };
  return {
    render(component, beforeEffects) {
      globalThis.__hooks = hooks;
      hooks.index = 0;
      hooks.effects = [];
      const output = component();
      beforeEffects?.(output);
      for (const effect of hooks.effects) {
        const previous = hooks.deps[effect.index];
        const changed = !previous || effect.deps.length !== previous.length || effect.deps.some((dep, i) => !Object.is(dep, previous[i]));
        if (!changed) continue;
        hooks.cleanups[effect.index]?.();
        hooks.deps[effect.index] = effect.deps;
        const cleanup = effect.fn();
        hooks.cleanups[effect.index] = typeof cleanup === 'function' ? cleanup : undefined;
      }
      return output;
    },
    unmount() { for (const cleanup of Object.values(hooks.cleanups)) cleanup?.(); },
  };
}

// --- ScrubBar ----------------------------------------------------------------
const { ScrubBar } = await bundle('src/components/ScrubBar.tsx', { jsx: 'automatic', plugins: [virtualModules] });

function mountScrubBar(onSeek) {
  const harness = createHarness();
  const input = {
    value: '',
    blur() {
      if (env.activeElement !== input) return;
      env.activeElement = null;
      latest.props.onBlur({ currentTarget: input });
    },
  };
  let latest = null;
  return {
    input,
    get element() { return latest; },
    render(value) {
      latest = harness.render(() => ScrubBar({ value, max: 200, onSeek }), (element) => { element.props.ref.current = input; });
    },
    unmount: harness.unmount,
    type(value) {
      input.value = String(value);
      latest.props.onInput({ currentTarget: input });
    },
  };
}
const pointer = (pointerId) => ({ type: 'pointerup', pointerId });

// Click to seek: the thumb follows the playhead again once the pointer is released, focus or not.
{
  const seeks = [];
  const bar = mountScrubBar((seconds) => seeks.push(seconds));
  bar.render(10);
  assert.equal(bar.input.value, '10', 'the thumb mirrors the playhead');
  env.activeElement = bar.input;
  bar.element.props.onPointerDown({ pointerId: 1 });
  bar.type(42);
  assert.deepEqual(seeks, [42], 'dragging seeks');
  bar.render(11);
  assert.equal(bar.input.value, '42', 'the thumb stays under the pointer mid-drag');
  fire('pointerup', pointer(1));
  assert.equal(listenerCount('pointerup'), 0, 'the release listener cleans up after itself');
  assert.equal(listenerCount('pointercancel'), 0);
  assert.equal(env.activeElement, bar.input, 'focus is released after the release events, not during them');
  flushTimers(0);
  assert.equal(env.activeElement, null, 'the pointer hands focus back so the shortcut keys apply');
  assert.equal(bar.input.value, '42', 'releasing focus must not snap the thumb back to the stale playhead');
  bar.render(43);
  assert.equal(bar.input.value, '43', 'the thumb follows playback after a click-to-seek');
  bar.render(44);
  assert.equal(bar.input.value, '44');
  flushTimers();
  assert.equal(bar.input.value, '44', 'the trailing resync agrees with the playhead');
  bar.unmount();
}

// A seek that moves nothing (no track loaded) must not leave the thumb parked at the click.
{
  const bar = mountScrubBar(() => undefined);
  bar.render(0);
  env.activeElement = bar.input;
  bar.element.props.onPointerDown({ pointerId: 1 });
  bar.type(0.4);
  fire('pointerup', pointer(1));
  flushTimers(0);
  assert.equal(bar.input.value, '0.4', 'the release alone leaves the thumb where it was clicked');
  flushTimers();
  assert.equal(bar.input.value, '0', 'with nothing to follow it settles back on the playhead');
  bar.unmount();
}

// Only the pointer that started the drag ends it.
{
  const bar = mountScrubBar(() => undefined);
  bar.render(5);
  env.activeElement = bar.input;
  bar.element.props.onPointerDown({ pointerId: 1 });
  bar.type(30);
  fire('pointerup', pointer(2));
  assert.equal(listenerCount('pointerup'), 1, 'another pointer lifting leaves the drag running');
  bar.render(6);
  assert.equal(bar.input.value, '30', 'the thumb is still held');
  flushTimers(0);
  assert.equal(env.activeElement, bar.input, 'and focus stays');
  fire('pointerup', pointer(1));
  assert.equal(listenerCount('pointerup'), 0);
  flushTimers(0);
  assert.equal(env.activeElement, null);
  flushTimers();
  bar.unmount();
}

// Focus alone never freezes the thumb.
{
  const bar = mountScrubBar(() => undefined);
  bar.render(5);
  env.activeElement = bar.input;
  bar.render(6);
  assert.equal(bar.input.value, '6', 'a focused scrub bar still follows playback');
  env.activeElement = null;
  bar.unmount();
}

// A lost release does not leak listeners or strand the drag state.
{
  const bar = mountScrubBar(() => undefined);
  bar.render(5);
  bar.element.props.onPointerDown({ pointerId: 1 });
  bar.element.props.onPointerDown({ pointerId: 1 });
  assert.equal(listenerCount('pointerup'), 1, 'a second press replaces the first release listener');
  bar.render(9);
  assert.equal(bar.input.value, '5', 'mid-drag the thumb is left alone');
  fire('pointercancel', { type: 'pointercancel', pointerId: 1 });
  assert.equal(listenerCount('pointerup'), 0);
  bar.render(10);
  assert.equal(bar.input.value, '10', 'a cancelled gesture ends the drag');
  flushTimers(0);
  bar.element.props.onPointerDown({ pointerId: 1 });
  bar.unmount();
  assert.equal(listenerCount('pointerup'), 0, 'unmounting mid-drag removes the listeners');
  flushTimers(0);
  assert.equal(timers.size, 0, 'unmounting cancels the pending resync');
}

// Keyboard scrubbing holds the thumb briefly, and only for keys that scrub.
{
  const bar = mountScrubBar(() => undefined);
  bar.render(20);
  env.now = 5000;
  bar.element.props.onKeyDown({ key: 'ArrowRight' });
  bar.type(20.1);
  env.now = 5400;
  bar.render(21);
  assert.equal(bar.input.value, '20.1', 'the thumb holds still just after a scrubbing key');
  env.now = 5000 + 1600;
  flushTimers();
  assert.equal(bar.input.value, '21', 'what the hold skipped is caught up when it runs out');
  bar.render(22);
  assert.equal(bar.input.value, '22', 'then it rejoins the playhead');
  env.now = 9000;
  bar.element.props.onKeyDown({ key: 'ArrowRight', ctrlKey: true });
  bar.render(30);
  assert.equal(bar.input.value, '30', 'Ctrl+Right is a track skip, not a scrub');
  bar.element.props.onKeyDown({ key: 'Tab' });
  bar.render(31);
  assert.equal(bar.input.value, '31', 'other keys do not hold the thumb');
  bar.unmount();
}

// A blur that is not the pointer's still resyncs the thumb.
{
  const bar = mountScrubBar(() => undefined);
  bar.render(50);
  bar.input.value = '77';
  bar.render(51);
  bar.element.props.onBlur({ currentTarget: bar.input });
  assert.equal(bar.input.value, '51', 'tabbing away drops an uncommitted position');
  bar.unmount();
}

// --- Quick play launcher -------------------------------------------------------
const { QuickPlayPalette, openQuickPlay } = await bundle('src/components/QuickPlayLauncher.tsx', { jsx: 'automatic', plugins: [virtualModules] });

// The tour's overlay carries the marker; the dialog inside it is aria-modal like the columns popover.
const tourDom = [{ attrs: { 'data-newamp-first-launch-tutorial': '' } }, { attrs: { role: 'dialog', 'aria-modal': 'true' } }];
const columnsPopover = { attrs: { role: 'dialog', 'aria-modal': 'true', 'data-newamp-track-columns-menu': '' } };
const searchInput = { tagName: 'INPUT', focused: false, selected: false, focus() { this.focused = true; }, select() { this.selected = true; } };
const librarySearch = { attrs: { 'data-newamp-library-search-command': '' }, children: [searchInput] };

function mountLauncher(platform = 'win32') {
  const harness = createHarness();
  const store = {
    view: 'home',
    compactMode: false,
    fullscreenViz: false,
    compactCalls: [],
    setView(view) { this.view = view; },
    setCompactMode(on) { this.compactCalls.push(on); this.compactMode = on; },
  };
  globalThis.__launcher = { platform, store };
  const launcher = {
    store,
    output: null,
    render() { launcher.output = harness.render(QuickPlayPalette); },
    unmount: harness.unmount,
  };
  launcher.render();
  return launcher;
}

let eventTime = 0;
function keydown(init) {
  const event = {
    type: 'keydown', key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
    timeStamp: (eventTime += 1000), defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...init,
  };
  fire('keydown', event);
  return event;
}
const ctrl = (key, flags = {}) => keydown({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true, ...flags });

// Ctrl+K and Ctrl+J toggle the palette.
{
  const launcher = mountLauncher();
  assert.equal(launcher.output, null, 'the palette starts closed');
  assert.equal(listenerCount('keydown'), 1, 'one capture listener serves every chord');
  assert.equal(ctrl('k').defaultPrevented, true);
  launcher.render();
  assert.notEqual(launcher.output, null, 'Ctrl+K opens the palette');
  ctrl('k');
  launcher.render();
  assert.equal(launcher.output, null, 'Ctrl+K again closes it');
  ctrl('j');
  launcher.render();
  assert.notEqual(launcher.output, null, 'Ctrl+J opens it too');
  keydown({ key: 'Escape', code: 'Escape' });
  launcher.render();
  assert.equal(launcher.output, null, 'Escape closes it');

  // Over the first-launch tour the palette stays shut and the key is left alone; closing is always allowed.
  env.elements = tourDom;
  const blocked = ctrl('k');
  launcher.render();
  assert.equal(launcher.output, null, 'Ctrl+K does not open over the tour');
  assert.equal(blocked.defaultPrevented, false, 'and does not swallow the key');
  env.elements = [];
  ctrl('k');
  launcher.render();
  assert.notEqual(launcher.output, null);
  env.elements = tourDom;
  ctrl('k');
  launcher.render();
  assert.equal(launcher.output, null, 'an open palette still closes when the tour appears');

  // The table columns popover is aria-modal but sits below the palette, so it does not get in the way.
  env.elements = [columnsPopover];
  ctrl('k');
  launcher.render();
  assert.notEqual(launcher.output, null, 'Ctrl+K opens over the table columns popover');
  ctrl('k');
  launcher.render();
  env.elements = [];

  // The deck chord also closes the palette it was typed over.
  ctrl('k');
  launcher.render();
  assert.notEqual(launcher.output, null);
  ctrl('m');
  launcher.render();
  assert.equal(launcher.output, null, 'switching to the deck closes the palette');
  launcher.unmount();
  assert.equal(listenerCount('keydown'), 0, 'unmounting removes the listener');
}

// The deck chord toggles both ways, ignores a held key, and does not double-flip inside the round trip.
{
  const launcher = mountLauncher();
  const first = ctrl('m');
  assert.equal(first.defaultPrevented, true);
  assert.deepEqual(launcher.store.compactCalls, [true], 'Ctrl+M shrinks into the deck');
  const second = ctrl('m', { timeStamp: first.timeStamp + 100 });
  assert.equal(second.defaultPrevented, true, 'a quick second press is still ours');
  assert.deepEqual(launcher.store.compactCalls, [true], 'but it does not flip the window again before the first lands');
  ctrl('m', { timeStamp: first.timeStamp + 400 });
  assert.deepEqual(launcher.store.compactCalls, [true, false], 'the same chord restores the window once it has settled');
  ctrl('m', { repeat: true });
  assert.deepEqual(launcher.store.compactCalls, [true, false], 'a held chord flips nothing');
  ctrl('m', { shiftKey: true });
  assert.deepEqual(launcher.store.compactCalls, [true, false], 'Ctrl+Shift+M is not the deck chord');
  launcher.unmount();
}

// Ctrl+F lands in the Library search, switching to the Library first.
{
  const launcher = mountLauncher();
  searchInput.focused = false;
  searchInput.selected = false;
  env.elements = [librarySearch];
  const event = ctrl('f');
  assert.equal(event.defaultPrevented, true);
  assert.equal(launcher.store.view, 'library', 'Ctrl+F opens the Library');
  assert.ok(searchInput.focused && searchInput.selected, 'and focuses and selects the search input');
  assert.equal(observers.length, 0, 'an input already on screen needs no watching');

  // Coming from another view the Library chunk loads first: wait for the input, once.
  searchInput.focused = false;
  searchInput.selected = false;
  launcher.store.view = 'home';
  env.elements = [];
  ctrl('f');
  assert.equal(launcher.store.view, 'library');
  assert.equal(observers.length, 1);
  assert.ok(observers[0].connected, 'the launcher watches the page for the input');
  observers[0].callback();
  assert.equal(searchInput.focused, false, 'a change that does not bring the input is ignored');
  assert.ok(observers[0].connected);
  env.elements = [librarySearch];
  observers[0].callback();
  assert.ok(searchInput.focused && searchInput.selected, 'the input is focused as soon as it mounts');
  assert.equal(observers[0].connected, false, 'and the watch ends');
  assert.equal(timers.size, 0, 'along with its give-up timer');

  // An input that never arrives ends the watch on its own.
  env.elements = [];
  ctrl('f');
  assert.equal(observers.length, 2);
  assert.ok(observers[1].connected);
  flushTimers();
  assert.equal(observers[1].connected, false, 'the watch gives up');

  // Where the search is not on screen to land in, the chord is left alone.
  const stays = (why) => {
    launcher.store.view = 'home';
    const before = observers.length;
    const result = ctrl('f');
    assert.equal(result.defaultPrevented, false, why);
    assert.equal(launcher.store.view, 'home', why);
    assert.equal(observers.length, before, why);
  };
  env.elements = [librarySearch];
  launcher.store.compactMode = true;
  stays('Ctrl+F does nothing in the deck');
  launcher.store.compactMode = false;
  launcher.store.fullscreenViz = true;
  stays('Ctrl+F is the fullscreen visualizer\'s to ignore');
  launcher.store.fullscreenViz = false;
  env.elements = [librarySearch, ...tourDom];
  stays('Ctrl+F does nothing over the tour');
  env.elements = [librarySearch];
  ctrl('k');
  launcher.render();
  stays('Ctrl+F does nothing while the palette is open');
  env.elements = [];
  launcher.unmount();
}

// A Mac swaps the modifiers.
{
  const launcher = mountLauncher('darwin');
  env.elements = [librarySearch];
  const mac = (key, flags) => keydown({ key, code: `Key${key.toUpperCase()}`, ...flags });
  mac('m', { metaKey: true });
  assert.deepEqual(launcher.store.compactCalls, [], 'Cmd+M stays the Window menu\'s Minimize');
  const deck = mac('M', { metaKey: true, shiftKey: true });
  assert.equal(deck.defaultPrevented, true);
  assert.deepEqual(launcher.store.compactCalls, [true], 'Cmd+Shift+M is the deck chord');
  assert.equal(mac('f', { ctrlKey: true }).defaultPrevented, false, 'Ctrl+F belongs to the text field on a Mac');
  assert.equal(launcher.store.view, 'home');
  launcher.store.compactMode = false;
  assert.equal(mac('f', { metaKey: true }).defaultPrevented, true, 'Cmd+F searches the Library');
  assert.equal(launcher.store.view, 'library');
  assert.equal(mac('k', { ctrlKey: true }).defaultPrevented, false, 'Ctrl+K kills to the end of the line in a Mac text field');
  assert.equal(mac('j', { ctrlKey: true }).defaultPrevented, false, 'and Ctrl+J is a newline');
  launcher.render();
  assert.equal(launcher.output, null, 'neither opens the palette');
  assert.equal(mac('k', { metaKey: true }).defaultPrevented, true, 'Cmd+K opens the palette');
  launcher.render();
  assert.notEqual(launcher.output, null);
  env.elements = [];
  launcher.unmount();
}

// A button opens the palette without a chord: the same on every platform, never over the tour, and it opens rather than toggles.
for (const platform of ['win32', 'darwin', 'linux']) {
  const launcher = mountLauncher(platform);
  openQuickPlay();
  launcher.render();
  assert.notEqual(launcher.output, null, `${platform}: the open request opens the palette`);
  openQuickPlay();
  launcher.render();
  assert.notEqual(launcher.output, null, `${platform}: asking again does not close it`);
  keydown({ key: 'Escape', code: 'Escape' });
  launcher.render();
  assert.equal(launcher.output, null);
  env.elements = tourDom;
  openQuickPlay();
  launcher.render();
  assert.equal(launcher.output, null, `${platform}: not over the first-launch tour`);
  env.elements = [];
  launcher.unmount();
  assert.deepEqual([...listeners].filter(([, list]) => list.length).map(([type]) => type), [], `${platform}: unmounting leaves no listener behind`);
}

// --- Source wiring ---------------------------------------------------------
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8').then((text) => text.replace(/\r\n/g, '\n'));
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const [app, launcherSource, scrub, sidebar, hints, tour, library, nowPlaying] = await Promise.all([
  'src/App.tsx',
  'src/components/QuickPlayLauncher.tsx',
  'src/components/ScrubBar.tsx',
  'src/components/Sidebar.tsx',
  'src/components/FirstRunHints.tsx',
  'src/components/FirstLaunchTutorial.tsx',
  'src/components/views/LibraryView.tsx',
  'src/components/views/NowPlayingView.tsx',
].map(read));

assert.match(app, /platform: api\.platform/, 'the global handler passes the host platform to the resolver');
assert.match(app, /targetIsSlider: isSliderShortcutTarget\(e\.target\)/, 'the global handler tells the resolver about sliders');
assert.match(app, /shortcutTargets\.pointerDown\(/, 'mouse presses are tracked');
assert.match(app, /shortcutTargets\.keyDown\(e\.key\)/, 'Tab hands focus back to the keyboard');
assert.match(app, /if \(e\.defaultPrevented\) return;/, 'a surface that already took the key keeps it');
assert.doesNotMatch(app, /play: \(\) => usePlayerStore\.getState\(\)\.togglePlay\(\)/, 'an OS play action must not toggle');
const chromeEnd = app.indexOf('<FirstRunHints />');
const palette = app.indexOf('<QuickPlayPalette />', chromeEnd);
assert.ok(chromeEnd > 0 && palette > app.indexOf('<FullscreenVisualizer />'), 'the palette is mounted after the visualizer, outside .app-chrome');
assert.equal(app.slice(0, chromeEnd).split('<QuickPlayPalette />').length - 1, 1, 'only the deck branch mounts the palette before the chrome closes');

assert.match(launcherSource, /isLibrarySearchChord\(event, api\.platform\)/, 'the launcher owns the Library search chord');
assert.match(launcherSource, /z-\[100\]/, 'the palette gets a stacking context above the fullscreen visualizer');
const searchSelector = /LIBRARY_SEARCH_INPUT = '(\[[^']+\]) input'/.exec(launcherSource);
assert.ok(searchSelector, 'the launcher finds the Library search input by a data attribute');
assert.ok(library.includes(searchSelector[1].slice(1, -1)), 'LibraryView still carries the attribute the launcher looks for');
assert.match(library, /data-newamp-library-search-command>\s*<span>[^<]*<\/span>\s*<input/, 'the attributed element still wraps the search input');
assert.ok(Object.keys(librarySearch.attrs).includes(searchSelector[1].slice(1, -1)), 'the stub Library search carries the real marker');
const tourSelector = /TOUR_OPEN = '(\[[^']+\])'/.exec(launcherSource);
assert.ok(tourSelector, 'the launcher recognises the tour by a data attribute');
assert.ok(tour.includes(tourSelector[1].slice(1, -1)), 'the tour still carries the attribute the launcher looks for');
assert.ok(Object.keys(tourDom[0].attrs).includes(tourSelector[1].slice(1, -1)), 'the stub tour carries the real marker');

const resyncBody = scrub.slice(scrub.indexOf('const resync = '), scrub.indexOf('useEffect(resync, [value]);'));
assert.ok(resyncBody.includes('el.value = String(valueRef.current)'), 'found the playhead sync');
assert.doesNotMatch(resyncBody, /activeElement/, 'the thumb sync must not depend on focus');

// Now Playing opens the palette through the launcher, not by faking its chord.
assert.match(nowPlaying, /import \{ openQuickPlay \} from '\.\.\/QuickPlayLauncher'/);
assert.doesNotMatch(nowPlaying, /new KeyboardEvent\(/, 'no faked chord');
// Karaoke leaves fullscreen only if it was the one that entered.
assert.match(nowPlaying, /winctl\.isFullscreen\(\)\.then\(\(already\) => \{\s*if \(cancelled \|\| already\) return;\s*entered = true;\s*void setWindowFullscreen\(true, winctl\);/);
assert.match(nowPlaying, /if \(entered\) void setWindowFullscreen\(false, winctl\);/);
assert.doesNotMatch(nowPlaying, /winctl\.setFullscreen\(/, 'karaoke goes through the ordered, state-checking setter');
// Queue-row hints follow the platform; Backspace removes a row as Delete does.
assert.match(nowPlaying, /shortcut=\{shortcutLabel\('Alt\+↑'\)\}/);
assert.match(nowPlaying, /shortcut=\{shortcutLabel\('Alt\+↓'\)\}/);
assert.match(nowPlaying, /shortcut=\{api\.platform === 'darwin' \? '⌫' : 'Delete'\}/);
assert.match(nowPlaying, /aria-keyshortcuts="Delete Backspace Alt\+ArrowUp Alt\+ArrowDown"/);
assert.match(nowPlaying, /event\.key === 'Delete' \|\| event\.key === 'Backspace'/);
assert.match(nowPlaying, /api\.platform === 'darwin' \? 'Show in Finder' : 'Show in folder'/);

for (const [name, source] of [['Sidebar', sidebar], ['FirstRunHints', hints], ['FirstLaunchTutorial', tour], ['QuickPlayLauncher', launcherSource]]) {
  assert.doesNotMatch(stripComments(source), /Ctrl/, `${name} must label chords through the platform helper, not a literal Ctrl`);
}

console.log(JSON.stringify({ ok: true }, null, 2));
