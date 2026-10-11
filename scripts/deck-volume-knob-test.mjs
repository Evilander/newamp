import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// The Retro TV volume knob: its drag runs on the knob's own pointer handlers
// (nothing is left on window if the deck unmounts mid-drag), it names its value
// the way the volume slider does, and the deck snapshot chord reads Cmd on a Mac.

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Deck volume knob test timed out'); process.exit(1); }, 30000);
deadline.unref();

// Children that need the player store, the audio engine or a canvas are swapped
// for inert stand-ins; VolumeSlider stays real, because the knob's label has to
// come from its volumeLabel.
const STUBBED = /(^|\/)(Visualizer|BrandLogo|ScrubBar|DeckSkinPicker)$/;
const stubChildren = {
  name: 'stub-deck-children',
  setup(b) {
    b.onResolve({ filter: STUBBED }, (args) => (args.importer.includes('decks') ? { path: args.path.split('/').pop(), namespace: 'stub' } : null));
    b.onResolve({ filter: /(^|\/)player-wheel$/ }, () => ({ path: 'player-wheel', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'player-wheel'
        ? 'export const handlePlayerWheel = () => {};'
        : `import { createElement } from 'react'; export const ${args.path} = (props) => createElement('stub-${args.path}', props);`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

const bundled = await build({
  stdin: {
    contents: `
      export * as React from 'react';
      export { RetroTvDeck } from './src/components/decks/RetroTvDeck';
      export { volumeLabel } from './src/components/VolumeSlider';
      export * from './src/components/decks/deck-controls';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [stubChildren],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const { React, RetroTvDeck, volumeLabel, VolumeKnobGesture, VOLUME_DRAG_RANGE_PX, isSnapshotChord } = mod;

const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
function callComponent(component, props) {
  const slots = [];
  let cursor = 0;
  const slot = (init) => { const at = cursor++; if (!(at in slots)) slots[at] = init(); return at; };
  const dispatcher = {
    useState: (init) => { const at = slot(() => ({ value: typeof init === 'function' ? init() : init })); return [slots[at].value, (next) => { slots[at].value = typeof next === 'function' ? next(slots[at].value) : next; }]; },
    useRef: (init) => slots[slot(() => ({ current: init }))],
    useMemo: (factory) => slots[slot(() => ({ value: factory() }))].value,
    useCallback: (fn) => fn,
    useEffect: () => { slot(() => null); },
    useLayoutEffect: () => { slot(() => null); },
    useId: () => 'id',
  };
  const previous = internals.ReactCurrentDispatcher.current;
  internals.ReactCurrentDispatcher.current = dispatcher;
  try { return component(props); } finally { internals.ReactCurrentDispatcher.current = previous; }
}
function expand(element) {
  if (element == null || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap(expand);
  if (typeof element === 'string' || typeof element === 'number') return [String(element)];
  if (element.type === React.Fragment) return expand(element.props.children);
  if (typeof element.type === 'function') return expand(callComponent(element.type, element.props));
  return [{ type: element.type, props: element.props, children: expand(element.props.children) }];
}
const render = (props) => ({ type: 'root', props: {}, children: expand(React.createElement(RetroTvDeck, props)) });
function* walk(node) {
  if (typeof node === 'string') return;
  yield node;
  for (const child of node.children) yield* walk(child);
}
const find = (tree, test, what) => {
  const found = [...walk(tree)].filter(test);
  assert.equal(found.length, 1, `expected exactly one ${what}, found ${found.length}`);
  return found[0];
};

function deck(volume) {
  const calls = [];
  const noop = () => {};
  const props = {
    track: { id: 7, title: 'Blue Train', artist: 'John Coltrane', album: 'Blue Train', trackNo: 3 },
    isPlaying: false, currentTime: 65, duration: 600, volume, mode: 'normal', alwaysOnTop: false,
    artUrl: null, deckSkin: 'retro-tv', vizExpanded: false, queueLength: 30, queueIndex: 14,
    onTogglePlay: noop, onStop: noop, onNext: noop, onPrev: noop, onSeek: noop, onSelectQueueIndex: noop,
    onSetVolume: (v) => calls.push(v), onSetMode: noop, onSetAlwaysOnTop: noop, onExitDeck: noop,
    onMinimize: noop, onClose: noop, onPickSkin: noop, onToggleVizExpanded: noop, onOpenFullscreenViz: noop,
  };
  const tree = render(props);
  const knob = find(tree, (n) => n.props['data-newamp-deck-volume-knob'] !== undefined, 'volume knob');
  return { knob, calls };
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

// --- the gesture ---------------------------------------------------------------

{
  const gesture = new VolumeKnobGesture(100, 200, 0.5);
  near(gesture.volumeAt(100, 200), 0.5, 'no travel leaves the volume where it was');
  near(gesture.volumeAt(100, 200 - VOLUME_DRAG_RANGE_PX / 2), 1, 'half a range up adds half of 100%');
  near(gesture.volumeAt(100 + VOLUME_DRAG_RANGE_PX / 4, 200), 0.75, 'right is louder, like up');
  near(gesture.volumeAt(100 + 20, 200 - 30), 1, 'the two directions add');
  near(gesture.volumeAt(100, 200 + 500), 0, 'dragging far down stops at silence');
  near(gesture.volumeAt(100, 200 - 500), 2, 'dragging far up stops at the 200% ceiling');
  near(new VolumeKnobGesture(0, 0, 1).volumeAt(-10, 0), 0.9, 'left is quieter');
}

// --- the knob ------------------------------------------------------------------

for (const volume of [0, 0.5, 1, 1.2, 2]) {
  const { knob } = deck(volume);
  assert.equal(knob.props.role, 'slider');
  assert.equal(knob.props['aria-label'], 'Volume');
  assert.equal(knob.props['aria-valuetext'], volumeLabel(volume), `the knob names ${volume} the way the slider does`);
  assert.ok(knob.props.title.includes(volumeLabel(volume)), 'and so does its tooltip');
}
assert.equal(deck(1.2).knob.props['aria-valuetext'], '120% · +1.6 dB', 'a boosted volume carries its dB');

// The drag leaves nothing on window, whatever happens to the deck mid-drag.
{
  const windowCalls = [];
  globalThis.window = {
    addEventListener: (...args) => windowCalls.push(['add', args[0]]),
    removeEventListener: (...args) => windowCalls.push(['remove', args[0]]),
  };
  const { knob, calls } = deck(0.5);
  const captured = [];
  const target = { setPointerCapture: (id) => captured.push(id) };
  const pointer = (extra) => ({ button: 0, pointerId: 4, currentTarget: target, preventDefault() {}, ...extra });

  knob.props.onPointerDown(pointer({ clientX: 50, clientY: 300 }));
  assert.deepEqual(captured, [4], 'the knob holds the pointer');
  knob.props.onPointerMove(pointer({ clientX: 50, clientY: 250 }));
  knob.props.onPointerMove(pointer({ clientX: 50, clientY: 200 }));
  assert.equal(calls.length, 2);
  near(calls[0], 1, '50 px up from half volume');
  near(calls[1], 1.5, '100 px up');

  knob.props.onPointerUp(pointer({}));
  knob.props.onPointerMove(pointer({ clientX: 50, clientY: 100 }));
  assert.equal(calls.length, 2, 'moves after the release do nothing');

  // A drag the system interrupts (the window loses the pointer, the knob is
  // removed) ends the same way, and a new press starts from the volume then.
  knob.props.onPointerDown(pointer({ clientX: 0, clientY: 0 }));
  knob.props.onLostPointerCapture();
  knob.props.onPointerMove(pointer({ clientX: 0, clientY: -50 }));
  assert.equal(calls.length, 2, 'a lost pointer ends the drag');
  knob.props.onPointerDown(pointer({ clientX: 0, clientY: 0 }));
  knob.props.onPointerCancel();
  knob.props.onPointerMove(pointer({ clientX: 0, clientY: -50 }));
  assert.equal(calls.length, 2, 'a cancelled pointer ends the drag');

  knob.props.onPointerDown(pointer({ button: 2, clientX: 0, clientY: 0 }));
  knob.props.onPointerMove(pointer({ clientX: 0, clientY: -50 }));
  assert.equal(calls.length, 2, 'only the primary button turns the knob');

  assert.deepEqual(windowCalls, [], 'no listener is ever put on window');
  delete globalThis.window;
}

// --- the snapshot chord ----------------------------------------------------------

{
  const chord = (extra) => ({ key: 'S', code: 'KeyS', shiftKey: true, ...extra });
  assert.equal(isSnapshotChord(chord({ ctrlKey: true }), 'win32'), true, 'Ctrl+Shift+S');
  assert.equal(isSnapshotChord(chord({ ctrlKey: true }), 'linux'), true);
  assert.equal(isSnapshotChord(chord({ metaKey: true }), 'win32'), false, 'the Windows key is not Ctrl');
  assert.equal(isSnapshotChord(chord({ metaKey: true }), 'darwin'), true, 'Cmd+Shift+S on a Mac');
  assert.equal(isSnapshotChord(chord({ ctrlKey: true }), 'darwin'), true, 'Ctrl+Shift+S still works there');
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, metaKey: true }), 'darwin'), false, 'Ctrl and Cmd together are neither');
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, metaKey: true }), 'win32'), false);
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, altKey: true }), 'win32'), false, 'Alt makes it another chord');
  assert.equal(isSnapshotChord(chord({ metaKey: true, altKey: true }), 'darwin'), false);
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, shiftKey: false, key: 's' }), 'win32'), false, 'Ctrl+S is Save');
  assert.equal(isSnapshotChord(chord({ metaKey: true, shiftKey: false, key: 's' }), 'darwin'), false);
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, repeat: true }), 'win32'), false, 'a held key takes one snapshot');
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, key: 'x', code: 'KeyX' }), 'win32'), false);
  assert.equal(isSnapshotChord(chord({}), 'win32'), false, 'Shift+S alone is the skin surf');
  assert.equal(isSnapshotChord(chord({ ctrlKey: true }), undefined), true, 'no platform reads as Ctrl');

  // The letter decides, not the key position: Dvorak and Colemak put other
  // letters on the physical S key and S on other keys.
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, key: 'O', code: 'KeyS' }), 'win32'), false, 'Dvorak: the physical S key is O');
  assert.equal(isSnapshotChord(chord({ metaKey: true, key: 'O', code: 'KeyS' }), 'darwin'), false);
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, key: 'S', code: 'Semicolon' }), 'win32'), true, 'Dvorak: S sits on another key');
  assert.equal(isSnapshotChord(chord({ ctrlKey: true, key: 'ы', code: 'KeyS' }), 'win32'), true, 'a Cyrillic layout has no S, so the physical key stands in');
}

// --- wiring in CompactPlayer ------------------------------------------------------

{
  const compact = readFileSync(new URL('../src/components/CompactPlayer.tsx', import.meta.url), 'utf8');
  assert.match(compact, /isSnapshotChord\(event, api\.platform\)/, 'the key listener reads the chord for the host platform');
  assert.match(compact, /shortcutLabel\('Mod\+Shift\+S'\)/, 'the snapshot button shows the chord for the host platform');
}

console.log('deck-volume-knob-test ok');
