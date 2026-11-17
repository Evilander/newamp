// Regression coverage for persistent previews, Auto-VJ timing, and Projector
// frame/command plumbing. No Electron or music library needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import ts from 'typescript';

const bundle = async (path) => {
  const result = await build({ stdin: { contents: `export * from '${path}';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const data = new Map();
const events = new EventTarget();
globalThis.window = {
  localStorage: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
  addEventListener: (...args) => events.addEventListener(...args),
  removeEventListener: (...args) => events.removeEventListener(...args),
  dispatchEvent: (event) => events.dispatchEvent(event),
};
const { readVjDwell, setVjDwell, watchVjDwell, normalizeVjDwell, vjSwitchDue, vjElapsedMs, pickAutoVjPreset, readAutoVj, setAutoVj } = await bundle('./src/lib/vizVj');
assert.equal(readAutoVj(), false);
setAutoVj(true); assert.equal(readAutoVj(), true);
assert.equal(data.get('newamp:viz:autoVj'), '1');
setAutoVj(false); assert.equal(readAutoVj(), false);
for (const tier of ['low', 'balanced']) {
  for (const energy of [0, 0.11, 0.12, 0.42, 0.69, 1]) {
    let current = 'spectrum';
    for (let i = 0; i < 100; i++) {
      current = pickAutoVjPreset(current, energy, tier);
      assert.ok(!['butterchurn', 'eviland-live'].includes(current), 'Auto-VJ never loads MilkDrop');
    }
  }
}
assert.equal(pickAutoVjPreset('spectrum', 0.1, 'balanced'), 'album-breathe');
assert.equal(pickAutoVjPreset('spectrum', 0.9, 'balanced'), 'neon-ribbons');
assert.equal(pickAutoVjPreset('spectrum', 0.3, 'low'), 'oscilloscope');
assert.equal(readVjDwell(), 0, 'first run retains energy-led timing');
for (const [elapsed, energy, expected] of [[14000, 1, false], [14001, 0.43, true], [30000, 0.1, false], [30001, 0.1, true]]) {
  assert.equal(vjSwitchDue(elapsed, energy, 0), expected, 'original timing boundaries');
}
for (const seconds of [5, 30, 60, 120, 300, 3600]) {
  assert.equal(vjSwitchDue(seconds * 1000 - 1, 1, seconds), false, 'loud passages cannot bypass dwell');
  assert.equal(vjSwitchDue(seconds * 1000, 0, seconds), true, 'quiet passages advance at the selected duration');
}
assert.equal(normalizeVjDwell(Infinity), 0);
assert.equal(normalizeVjDwell(NaN), 0);
assert.equal(normalizeVjDwell(-10), 0);
assert.equal(normalizeVjDwell(1), 5);
assert.equal(normalizeVjDwell(99999), 3600);
let heard = -1;
const unwatch = watchVjDwell((seconds) => { heard = seconds; });
setVjDwell(73);
assert.equal(readVjDwell(), 73);
assert.equal(heard, 73, 'same-window settings changes are live');
data.set('newamp:viz:vj-dwell', '120');
const storage = new Event('storage'); Object.defineProperty(storage, 'key', { value: 'newamp:viz:vj-dwell' });
events.dispatchEvent(storage);
assert.equal(heard, 120, 'Projector/settings changes in other windows are live');
unwatch(); setVjDwell(30); assert.equal(heard, 120, 'cleanup unsubscribes');
const { flashGuardEnabled, setFlashGuardEnabled } = await bundle('./src/lib/vizPrefs');
assert.equal(flashGuardEnabled(), true, 'photosensitivity protection remains on by default');
setFlashGuardEnabled(false); assert.equal(flashGuardEnabled(), false);
setFlashGuardEnabled(true); assert.equal(flashGuardEnabled(), true);

const { frameBus } = await bundle('./src/visualizer/frame-bus');
let posted;
const port = { postMessage: (payload) => { posted = structuredClone(payload); }, start() {}, close() {}, onmessage: null };
frameBus.attachDetachedPort(port);
const commands = [];
const stopCommands = frameBus.onDetachedCommand((cmd) => commands.push(cmd));
for (const command of ['next-look', 'previous-look', 'randomize', 'toggle-director', 'bad-command']) port.onmessage({ data: { type: 'look-command', command } });
assert.deepEqual(commands, ['next-look', 'previous-look', 'randomize', 'toggle-director']);
stopCommands(); port.onmessage({ data: { type: 'look-command', command: 'next-look' } });
assert.equal(commands.length, 4);
assert.equal(frameBus.needsDetachedAnalysis(), false);
port.onmessage({ data: { type: 'analysis-demand', enabled: true } });
assert.equal(frameBus.needsDetachedAnalysis(), true);
const analysis = { frequency: new Uint8Array([5, 10]), onsetFrequency: new Uint8Array([15, 20]), waveform: new Uint8Array([128, 150, 80, 128]), fftSize: 4, sampleRate: 48000 };
frameBus.publish({ energy: 0.2 }, {}, 33, undefined, { analysis, artUrl: 'newamp-art://1', director: false });
assert.deepEqual(posted.analysis, analysis);
assert.equal(posted.director, false);
assert.equal(posted.artUrl, 'newamp-art://1');
analysis.frequency.fill(99);
assert.deepEqual([...posted.analysis.frequency], [5, 10], 'reused producer buffers do not mutate in-flight data');
const { createProjectorAudio } = await bundle('./src/detached/projector-audio');
let audioNow = 0;
const audio = createProjectorAudio(() => audioNow); audio.update(posted.analysis, true);
assert.equal(audio.frequencyBinCount, 2); assert.equal(audio.fftSize, 4); assert.equal(audio.getSampleRate(), 48000);
assert.equal(audio.getState().playing, true);
const out = new Uint8Array(6); audio.getTimeData(out);
assert.deepEqual([...out], [128, 150, 80, 128, 128, 128]);
audio.getFreqData(out); assert.deepEqual([...out], [5, 10, 0, 0, 0, 0]);
audioNow = 500; assert.equal(audio.getState().playing, true);
audioNow = 501; assert.equal(audio.getState().playing, false, 'stalled producer stops playback');
audio.getFreqData(out); assert.deepEqual([...out], [0, 0, 0, 0, 0, 0]);
audio.getOnsetFreqData(out); assert.deepEqual([...out], [0, 0, 0, 0, 0, 0]);
audio.getTimeData(out); assert.deepEqual([...out], [128, 128, 128, 128, 128, 128]);
audio.update(posted.analysis, true); assert.equal(audio.getState().playing, true, 'new analysis resumes playback');
port.onmessage({ data: { type: 'analysis-demand', enabled: false } });
frameBus.publish({ energy: 0.2 }, {}, 33, undefined, { analysis, vjEnergy: 0.6 });
assert.equal(posted.analysis, undefined, 'MilkDrop has no analysis traffic');
assert.equal(posted.vjEnergy, 0.6, 'Auto-VJ energy remains available without analysis');
assert.equal(frameBus.detachedStepsLooks(), false);
port.onmessage({ data: { type: 'auto-vj-looks', enabled: true } });
assert.equal(frameBus.detachedStepsLooks(), true, 'the Projector says when its Auto-VJ steps the shared Eviland look');
frameBus.lookChangedByHand();
assert.deepEqual(posted, { type: 'look-changed' }, 'a look changed by hand here is passed on');
frameBus.detachPort();
assert.equal(frameBus.needsDetachedAnalysis(), false);
assert.equal(frameBus.detachedStepsLooks(), false, 'a closed Projector steps nothing');

// Invoke the real picker onClick from its syntax tree: every selection applies
// live, with no close side effect. Dismissal remains a separate action.
const source = readFileSync('src/components/FullscreenVisualizer.tsx', 'utf8');
const sf = ts.createSourceFile('FullscreenVisualizer.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let pickerClick;
const visit = (node) => {
  if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'data-newamp-viz-preset-button')) {
    pickerClick = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'onClick')?.initializer?.expression;
  }
  ts.forEachChild(node, visit);
};
visit(sf); assert.ok(pickerClick);
const picks = []; let closes = 0;
for (const id of ['spectrum', 'aurora', 'eviland-live']) {
  const click = new Function('pickPreset', 'p', 'setOpenPanel', `return (${pickerClick.getText(sf)});`)((id) => picks.push(id), { id }, () => { closes++; });
  click();
}
assert.deepEqual(picks, ['spectrum', 'aurora', 'eviland-live']); assert.equal(closes, 0);
// Run the real Auto-VJ tick and look controls from the same syntax tree.
const declared = (name, within = () => true) => {
  let found;
  const find = (node) => {
    if (!found && (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(sf) === name && within(node)) found = node;
    ts.forEachChild(node, find);
  };
  find(sf); return found;
};
const js = (node) => ts.transpileModule(`(${ts.isFunctionDeclaration(node) ? `function ${node.getText(sf).slice(node.getText(sf).indexOf('('))}` : node.initializer.getText(sf)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.trim().replace(/;$/, '');
const clock = { now: 0 };
const fakeWindow = { performance: { now: () => clock.now } };
const ref = (current) => ({ current });
const skips = []; const randomized = [];
const store = { getState: () => ({ skipEvilandLook: () => skips.push(clock.now), previousEvilandLook() {}, vizPreset: 'eviland-live' }) };
const lastLookAtRef = ref(0); const lastPickRef = ref(null);
const handNotes = [];
const pickedByHand = (preset) => new Function('window', 'lastLookAtRef', 'activePreset', 'frameBus',
  `return ${js(declared('lookPickedByHand'))}`)(fakeWindow, lastLookAtRef, preset, { lookChangedByHand: () => handNotes.push(clock.now) });
const look = (name) => new Function('window', 'lastLookAtRef', 'lookPickedByHand', 'usePlayerStore', 'stepLookFor', 'activePreset', 'cyclePreset', 'randomizeEviland', 'pickPreset', 'pickRandomPreset', 'PRESETS',
  `return ${js(declared(name))}`)(fakeWindow, lastLookAtRef, pickedByHand('eviland-live'), store, (preset, direction, handlers) => handlers.skipEvilandLook(), 'eviland-live', () => {}, () => randomized.push(clock.now), () => {}, () => 'spectrum', []);
let detachedSteps = false;
const tickOf = () => new Function('autoVjIsPlayingRef', 'engine', 'freq', 'visualizerEnergy', 'vjElapsedMs', 'lastSwitchAt', 'lastPickRef', 'lastLookAtRef', 'vjSwitchDue', 'autoVjDwellRef', 'autoVjActivePresetRef', 'usePlayerStore', 'frameBus', 'pickAutoVjPreset', 'autoVjPerfTierRef', 'autoVjSetPresetRef', 'cancelTick', 'requestPacedFrame', 'window',
  `const tick = ${js(declared('tick', (node) => node.getText(sf).includes('autoVjIsPlayingRef')))}; return tick;`)(ref(true), { getFreqData() {}, getSampleRate: () => 48000, fftSize: 2048 }, new Uint8Array(4), () => 0.5, vjElapsedMs, 0, lastPickRef, lastLookAtRef, vjSwitchDue, ref(300), ref('eviland-live'), store, { detachedStepsLooks: () => detachedSteps }, pickAutoVjPreset, ref('balanced'), ref(() => {}), () => {}, () => () => {}, fakeWindow);
const tick = tickOf();
tick(295000); assert.deepEqual(skips, []);
clock.now = 295000; look('stepLook')(1);
assert.deepEqual(skips, [295000]);
tick(300500); assert.deepEqual(skips, [295000], 'a look stepped by hand is not replaced 5 s later');
tick(595000); assert.deepEqual(skips.length, 2, 'it gets the whole duration');
clock.now = 600000; look('randomizeLook')();
assert.deepEqual(randomized, [600000]);
tick(895000); assert.equal(skips.length, 2, 'a randomized look gets the whole duration too');
tick(900000); assert.equal(skips.length, 3);
detachedSteps = true;
tick(1200000); assert.equal(skips.length, 3, 'a Projector running Auto-VJ on Eviland is the one that steps the shared look');
detachedSteps = false;
tick(1499000); assert.equal(skips.length, 3, 'the main window counts its dwell from the turn it skipped');
tick(1500000); assert.equal(skips.length, 4);
// A pasted seed code is a look picked by hand as well.
let codeOk = true;
const paste = new Function('evilandPasteValue', 'applyEvilandCode', 'lookPickedByHand', 'setEvilandPasteValue', 'setEvilandPasteError', 'window',
  `return ${js(declared('submitEvilandPaste'))}`)('EV1-test', () => codeOk, pickedByHand('eviland-live'), () => {}, () => {}, { ...fakeWindow, setTimeout() {} });
codeOk = false; clock.now = 1795000; paste();
tick(1800000); assert.equal(skips.length, 5, 'a code that does not decode changes nothing');
codeOk = true; clock.now = 2095000; paste();
tick(2100000); assert.equal(skips.length, 5, 'a pasted look is not replaced 5 s later');
tick(2395000); assert.equal(skips.length, 6);
// A Projector stepping the same look on its own clock hears of each one; a
// preset stepped outside Eviland is not its look.
assert.deepEqual(handNotes, [295000, 600000, 2095000]);
pickedByHand('spectrum')(); assert.equal(handNotes.length, 3);
let popoverClick;
const findPopover = (node) => {
  if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'data-newamp-viz-eviland-randomize')) {
    popoverClick = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'onClick')?.initializer?.expression?.getText(sf);
  }
  ts.forEachChild(node, findPopover);
};
findPopover(sf); assert.equal(popoverClick, 'randomizeLook', 'the Eviland settings Randomize restarts the dwell as the menu one does');
// The Projector's menu writes palette and reactivity; an open fullscreen
// visualizer takes them up instead of drawing and cycling from stale values.
const sync = declared('sync', (node) => node.getText(sf).includes('VIZ_AUTO_VJ_KEY'));
const synced = [];
const onStorage = new Function('VIZ_AUTO_VJ_KEY', 'VIZ_PALETTE_KEY', 'VIZ_REACTIVITY_KEY', 'setAutoVjEnabled', 'readAutoVj', 'setPalette', 'loadVisualizerPalette', 'setReactivity', 'loadVisualizerReactivity',
  `return ${js(sync)}`)('newamp:viz:autoVj', 'newamp:viz:palette', 'newamp:viz:reactivity', (v) => synced.push(['autoVj', v]), () => true, (v) => synced.push(['palette', v]), () => 'ice', (v) => synced.push(['reactivity', v]), () => 'truth');
onStorage({ key: 'newamp:viz:palette' }); onStorage({ key: 'newamp:viz:reactivity' }); onStorage({ key: 'newamp:viz:quality' });
assert.deepEqual(synced, [['palette', 'ice'], ['reactivity', 'truth']]);
// The main window calls this pure dwell decision with the last manual pick.
assert.equal(vjElapsedMs(65000, 1000, 64000), 1000);
assert.equal(vjSwitchDue(vjElapsedMs(65000, 1000, 64000), 1, 30), false, 'manual selection receives a full dwell');
assert.equal(vjSwitchDue(vjElapsedMs(94000, 1000, 64000), 0, 30), true);
assert.equal(vjElapsedMs(95000, 94000, 64000), 1000, 'automatic switch starts the next dwell');

const projectorTitle = readFileSync('detached.html', 'utf8').match(/<title>(.*?)<\/title>/)[1];
assert.ok(readFileSync('electron/main.ts', 'utf8').includes(`title: '${projectorTitle}'`), 'native and document Projector titles agree');
const dwellTree = ts.createSourceFile('VjDwellControl.tsx', readFileSync('src/components/VjDwellControl.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const labels = [];
const controlsIn = (node) => {
  let count = 0;
  const walk = (n) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ['select', 'input'].includes(n.tagName.getText(dwellTree))) count++;
    ts.forEachChild(n, walk);
  };
  walk(node); return count;
};
const findLabels = (node) => {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(dwellTree) === 'label') labels.push(node);
  ts.forEachChild(node, findLabels);
};
findLabels(dwellTree);
assert.equal(labels.length, 2);
assert.deepEqual(labels.map(controlsIn), [1, 1], 'Seconds and the preset each label exactly one control');
const { PRESETS } = await bundle('./src/visualizer/modes');
assert.equal(PRESETS.length, 27);
const projector = readFileSync('src/detached/projector-menu.ts', 'utf8');
assert.match(projector, /import \{ PRESETS, PRESET_GROUPS \}/);
assert.doesNotMatch(projector, /from ['"]react|VisualizerMenu/);


// Exercise the actual plain-DOM menu against a small DOM stand-in. This covers
// selection/dismissal and keyboard routing, not browser layout or GPU output.
class MenuElement extends EventTarget {
  constructor(tag = 'div') { super(); this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.disabled = false; this.textContent = ''; this.parentElement = null; }
  get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
  append(...els) { for (const el of els) { el.parentElement = this; this.children.push(el); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((el) => el !== this); this.parentElement = null; }
  replaceChildren(...els) { for (const el of this.children) el.parentElement = null; this.children = []; this.append(...els); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  contains(el) { return el === this || this.children.some((child) => child.contains(el)); }
  focus() { document.activeElement = this; }
  getBoundingClientRect() { return { width: 320, height: 500 }; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const attr = /^\[data-([\w-]+)\]$/.exec(selector)?.[1]?.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const visit = (el) => { for (const child of el.children) { if (attr ? attr in child.dataset : selector.split(', ').some((part) => part === `${child.tagName}:not(:disabled)` && !child.disabled)) found.push(child); visit(child); } };
    visit(this); return found;
  }
  click() { if (!this.disabled) { this.focus(); this.dispatchEvent(new Event('click')); } }
}
globalThis.HTMLElement = MenuElement;
globalThis.HTMLButtonElement = class extends MenuElement { constructor() { super('button'); } };
globalThis.HTMLSelectElement = class extends MenuElement { constructor() { super('select'); } };
globalThis.HTMLInputElement = class extends MenuElement { constructor() { super('input'); } };
globalThis.document = {
  createElement: (tag) => tag === 'button' ? new HTMLButtonElement() : tag === 'select' ? new HTMLSelectElement() : tag === 'input' ? new HTMLInputElement() : new MenuElement(tag),
  activeElement: null,
};
document.body = new MenuElement('body');
window.innerWidth = 1280; window.innerHeight = 720;
const { createProjectorMenu } = await bundle('./src/detached/projector-menu');
let mode = 'eviland-live'; let auto = false; let director = true; let closed = 0;
const menu = createProjectorMenu({ mode: () => mode, select: (next) => { mode = next; }, command(cmd) { if (cmd === 'toggle-director') director = !director; }, director: () => director, autoVj: () => auto, toggleAutoVj: () => { auto = !auto; }, fullscreen() {}, close() {}, onClose() { closed++; } });
const buttonNamed = (text) => document.body.querySelectorAll('button:not(:disabled)').find((el) => el.textContent === text);
menu.open({ x: 1270, y: 710 });
assert.equal(menu.isOpen(), true);
const allControls = () => document.body.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled)');
const labeled = (label) => allControls().find((el) => el.getAttribute('aria-label') === label);
assert.equal(labeled('Render quality'), undefined, 'Projector cannot write main-window quality preferences');
const beforeQuality = [data.get('newamp:viz:performance'), data.get('newamp:viz:quality')];
const palette = labeled('Palette');
assert.deepEqual(palette.children.map((el) => el.textContent), ['Per look', 'Theme', 'Phosphor', 'Ice', 'Sunset', 'Cycle']);
palette.value = 'ice'; palette.dispatchEvent(new Event('change'));
assert.equal(data.get('newamp:viz:palette'), 'ice');
const react = labeled('Reactivity');
assert.deepEqual(react.children.map((el) => el.textContent), ['Truth', 'Punch', 'Wild']);
react.value = 'truth'; react.dispatchEvent(new Event('change'));
assert.equal(data.get('newamp:viz:reactivity'), 'truth');
assert.deepEqual([data.get('newamp:viz:performance'), data.get('newamp:viz:quality')], beforeQuality);
const key = (name, shift = false) => {
  const e = new Event('keydown', { cancelable: true });
  Object.defineProperties(e, { key: { value: name }, shiftKey: { value: shift } });
  window.dispatchEvent(e); return e;
};
let controls = allControls();
controls.at(-1).focus(); assert.equal(key('Tab').defaultPrevented, true); assert.equal(document.activeElement, controls[0]);
key('Tab', true); assert.equal(document.activeElement, controls.at(-1));
for (let i = 0; i < controls.length * 2; i++) { key('Tab'); assert.ok(allControls().includes(document.activeElement)); }
// Both windows use the same lock state machine, including Auto-VJ + Director.
for (const eviland of [false, true]) for (const autoBefore of [false, true]) for (const directorBefore of [false, true]) {
  mode = eviland ? 'eviland-live' : 'spectrum'; auto = autoBefore; director = directorBefore;
  menu.close(); menu.open();
  const { isLookLocked, toggleLookLock } = await bundle('./src/components/visualizer-input');
  const state = { eviland, autoVj: autoBefore, director: directorBefore };
  const expected = toggleLookLock(state);
  buttonNamed(isLookLocked(state) ? 'Unlock look' : 'Lock look').click();
  assert.deepEqual({ autoVj: auto, director }, expected);
}
buttonNamed('Mode / Browse all modes…').click();
assert.equal(document.body.querySelectorAll('[data-projector-mode]').length, PRESETS.length, 'Projector exposes every registered mode');
for (const id of ['spectrum', 'liquid-mercury', 'eviland', 'butterchurn', 'eviland-live', 'album-breathe']) {
  const cell = document.body.querySelectorAll('[data-projector-mode]').find((el) => el.dataset.projectorMode === id);
  cell.click(); assert.equal(mode, id); assert.equal(menu.isOpen(), true, 'preview stays open');
  assert.equal(cell.getAttribute('aria-pressed'), 'true');
}
const escape = new Event('keydown', { cancelable: true }); Object.defineProperty(escape, 'key', { value: 'Escape' });
const closedBefore = closed;
window.dispatchEvent(escape); assert.equal(closed, closedBefore + 1, 'Escape notifies host to rearm idle timer'); assert.equal(menu.isOpen(), false); assert.equal(escape.defaultPrevented, true, 'Escape closes the menu before fullscreen');
menu.open(); buttonNamed('Close menu ✕').click(); assert.equal(menu.isOpen(), false);
menu.open();
const layer = document.body.querySelector('[data-newamp-projector-menu]');
layer.dispatchEvent(new Event('pointerdown')); assert.equal(menu.isOpen(), false, 'outside click closes');
// Turning flash protection off takes two separate presses. Chromium activates
// a focused button on every Enter keydown nobody cancels, auto-repeats too.
let menuNow = 0;
const realNow = Object.getOwnPropertyDescriptor(performance, 'now');
Object.defineProperty(performance, 'now', { value: () => menuNow, configurable: true });
const enter = (repeat) => {
  const e = new Event('keydown', { cancelable: true });
  Object.defineProperties(e, { key: { value: 'Enter' }, repeat: { value: repeat }, target: { value: document.activeElement } });
  window.dispatchEvent(e);
  if (!e.defaultPrevented) document.activeElement?.click();
  return e;
};
assert.equal(flashGuardEnabled(), true);
menu.open();
buttonNamed('Flash protection: On — turn off…').focus();
enter(false);
assert.equal(document.activeElement.textContent, 'Turn off flash protection anyway?');
for (const at of [30, 500, 530, 560, 1500]) {
  menuNow = at;
  assert.equal(enter(true).defaultPrevented, true);
  assert.equal(flashGuardEnabled(), true, `a held Enter never confirms (${at} ms)`);
}
menuNow = 2000; enter(false);
assert.equal(flashGuardEnabled(), false, 'a fresh press confirms');
buttonNamed('Flash protection: Off — turn on').click();
assert.equal(flashGuardEnabled(), true);
if (realNow) Object.defineProperty(performance, 'now', realNow); else delete performance.now;
// Each arrow-key step in the duration field is a change, and so is a value
// committed as the focus leaves it. The menu updates in place, so the focus
// stays in the field, or lands on the control it was moving to.
const dwellField = () => allControls().find((el) => el.getAttribute('aria-label') === 'Custom Auto-VJ duration in seconds');
const field = dwellField();
for (const seconds of ['35', '40']) {
  field.focus();
  field.value = seconds; field.dispatchEvent(new Event('change'));
  assert.equal(readVjDwell(), Number(seconds));
  assert.equal(dwellField(), field, 'the field is not rebuilt');
  assert.equal(document.activeElement, field, 'focus stays in the duration field');
  assert.equal(labeled('Auto-VJ duration').value, seconds, 'the duration menu shows the new value');
}
const nextControl = labeled('Palette');
nextControl.focus(); field.value = '2'; field.dispatchEvent(new Event('change'));
assert.equal(readVjDwell(), 5);
assert.equal(document.activeElement, nextControl, 'a change committed on blur leaves the focus where it went');
assert.equal(labeled('Palette'), nextControl);
assert.equal(field.value, '5', 'the field shows the duration as stored');
const duration = labeled('Auto-VJ duration');
duration.value = '60'; duration.dispatchEvent(new Event('change'));
assert.equal(field.value, '60', 'a preset duration shows in the seconds field');
// Settings changed in another window reach the open menu the same way.
const stored = (key, value) => {
  data.set(key, value);
  const e = new Event('storage'); Object.defineProperty(e, 'key', { value: key }); window.dispatchEvent(e);
};
stored('newamp:viz:vj-dwell', '120');
assert.equal(labeled('Auto-VJ duration').value, '120');
assert.equal(field.value, '120');
stored('newamp:viz:palette', 'phosphor');
assert.equal(labeled('Palette'), nextControl, 'nothing is rebuilt');
assert.equal(nextControl.value, 'phosphor');
stored('newamp:viz:reactivity', 'wild');
assert.equal(labeled('Reactivity').value, 'wild');
stored('newamp:viz:flash-guard', 'off');
assert.ok(buttonNamed('Flash protection: Off — turn on'));
stored('newamp:viz:flash-guard', 'on');
buttonNamed('Flash protection: On — turn off…').click();
assert.ok(buttonNamed('Turn off flash protection anyway?'));
stored('newamp:viz:flash-guard', 'off');
assert.ok(buttonNamed('Turn off flash protection anyway?'), 'an armed confirm is left as it is');
assert.equal(document.body.querySelectorAll('[data-projector-flash]')[0].textContent, 'Flash protection: On — turn off…');
stored('newamp:viz:flash-guard', 'on');
menu.close();
const graph = await build({ entryPoints: ['src/detached/main.tsx'], bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' });
assert.deepEqual(Object.keys(graph.metafile.inputs).filter((path) => /node_modules\/react|src\/store\//.test(path)), [], 'Projector stays framework-free through its entire import graph');
console.log('[visualizer-preferences-test] PASS (timing, preferences, frame bridge, previews, Projector menu, framework-free bundle)');

await import('./projector-runtime-test.mjs');
