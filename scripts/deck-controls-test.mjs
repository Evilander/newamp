import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Deck controls test timed out'); process.exit(1); }, 30000);
deadline.unref();

// The decks render through a hand-rolled shallow renderer: function components
// are expanded in place, hooks keep their values for the one render, and the
// result is a plain tree of host elements whose handlers the test can call.
// Child components that need the player store or the audio engine are swapped
// for inert stand-ins at bundle time.
const STUBBED = /(^|\/)(Visualizer|VolumeSlider|BrandLogo|ScrubBar|DeckSkinPicker|player-wheel)$/;
const stubChildren = {
  name: 'stub-deck-children',
  setup(b) {
    b.onResolve({ filter: STUBBED }, (args) => (args.importer.includes('decks') ? { path: args.path.split('/').pop(), namespace: 'stub' } : null));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'player-wheel'
        ? 'export const handlePlayerWheel = () => {};'
        : `import { createElement } from 'react'; export const ${args.path} = (props) => createElement('stub-${args.path}', props);${args.path === 'VolumeSlider' ? ' export const volumeLabel = (value) => String(value);' : ''}`,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  },
};

const bundled = await build({
  stdin: {
    contents: `
      export * as React from 'react';
      export { ClassicBentoDeck } from './src/components/decks/ClassicBentoDeck';
      export { WinampClassicDeck, WinampIndustrialDeck } from './src/components/decks/WinampClassicDeck';
      export { RecordPlayerDeck } from './src/components/decks/RecordPlayerDeck';
      export { JukeboxDeck } from './src/components/decks/JukeboxDeck';
      export { CassetteDeck } from './src/components/decks/CassetteDeck';
      export { DiscmanDeck } from './src/components/decks/DiscmanDeck';
      export { RetroTvDeck } from './src/components/decks/RetroTvDeck';
      export { DECK_SKINS } from './src/components/decks/types';
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
const {
  React, DECK_SKINS, jukeboxSelection, channelKeyStep, ChannelGesture, ChannelWheel, tvScreenLabel,
  CHANNEL_DRAG_STEP_PX, CHANNEL_CLICK_SLOP_PX,
} = mod;

const decks = {
  bento: mod.ClassicBentoDeck,
  'winamp-classic': mod.WinampClassicDeck,
  'winamp-industrial': mod.WinampIndustrialDeck,
  'record-player': mod.RecordPlayerDeck,
  jukebox: mod.JukeboxDeck,
  cassette: mod.CassetteDeck,
  discman: mod.DiscmanDeck,
  'retro-tv': mod.RetroTvDeck,
};
assert.deepEqual(Object.keys(decks).sort(), DECK_SKINS.map((skin) => skin.id).sort(), 'every deck skin is covered by this test');

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
const render = (Deck, props) => ({ type: 'root', props: {}, children: expand(React.createElement(Deck, props)) });

function* walk(node) {
  if (typeof node === 'string') return;
  yield node;
  for (const child of node.children) yield* walk(child);
}
const all = (tree, test) => [...walk(tree)].filter(test);
const one = (tree, test, what) => {
  const found = all(tree, test);
  assert.equal(found.length, 1, `expected exactly one ${what}, found ${found.length}`);
  return found[0];
};
const hidden = (node) => node.props['aria-hidden'] === true || node.props['aria-hidden'] === 'true';
function contentText(node) {
  if (typeof node === 'string') return node;
  if (hidden(node)) return '';
  if (node.type === 'img') return node.props.alt ?? '';
  return node.children.map(contentText).join('');
}
const nameOf = (node) => node.props['aria-label'] || contentText(node).trim() || node.props.title || '';
const isControl = (node) => node.type === 'button' || node.props.role === 'button' || node.props.role === 'slider';
const byLabel = (tree, label) => all(tree, (n) => isControl(n) && nameOf(n) === label);

const track = { id: 7, title: 'Blue Train', artist: 'John Coltrane', album: 'Blue Train', trackNo: 3, year: 1958 };
function makeProps(overrides = {}) {
  const calls = {};
  const record = (name) => (...args) => { (calls[name] ??= []).push(args); };
  const props = {
    track, isPlaying: false, currentTime: 65, duration: 600, volume: 1, mode: 'normal', alwaysOnTop: false,
    artUrl: null, deckSkin: 'bento', vizExpanded: false, queueLength: 30, queueIndex: 14,
    ...Object.fromEntries(['onTogglePlay', 'onStop', 'onNext', 'onPrev', 'onSeek', 'onSelectQueueIndex', 'onSetVolume', 'onSetMode',
      'onSetAlwaysOnTop', 'onExitDeck', 'onMinimize', 'onClose', 'onPickSkin', 'onToggleVizExpanded', 'onOpenFullscreenViz'].map((name) => [name, record(name)])),
    ...overrides,
  };
  return { props, calls };
}
const event = (extra = {}) => {
  const e = { prevented: 0, stopped: 0, preventDefault() { e.prevented += 1; }, stopPropagation() { e.stopped += 1; }, ...extra };
  return e;
};
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

// --- Jukebox keys ------------------------------------------------------------

{
  const mid = jukeboxSelection(30, 14);
  assert.equal(mid.hasSelection, true);
  assert.equal(mid.label, 'B–03', 'entry 15 of the queue is key 3 on the second page');
  assert.deepEqual(mid.keys.map((k) => k.lit), Array.from({ length: 12 }, (_, i) => i === 2));
  assert.equal(mid.keys[0].queueIndex, 12);
  assert.ok(mid.keys.every((k) => k.enabled), 'a full page enables every key');

  const short = jukeboxSelection(4, 1);
  assert.equal(short.label, 'A–02');
  assert.deepEqual(short.keys.map((k) => k.enabled), Array.from({ length: 12 }, (_, i) => i < 4), 'keys past the queue end are disabled');

  const last = jukeboxSelection(30, 29);
  assert.equal(last.label, 'C–06');
  assert.deepEqual(last.keys.map((k) => k.enabled), Array.from({ length: 12 }, (_, i) => i < 6));

  for (const [length, index] of [[0, -1], [5, -1], [5, 9], [5, 5], [Number.NaN, 0], [5, Number.NaN]]) {
    const idle = jukeboxSelection(length, index);
    assert.equal(idle.hasSelection, false, `no selection for queue ${length}, index ${index}`);
    assert.equal(idle.label, 'A–01');
    assert.ok(idle.keys.every((k) => !k.lit), 'nothing is lit without a selection');
  }
  assert.equal(jukeboxSelection(5, -1).keys.filter((k) => k.enabled).length, 5, 'an idle deck can still start any queued entry');
  assert.equal(jukeboxSelection(400, 12 * 26).label, 'A–01', 'the page letter wraps after Z');
}

{
  const { props, calls } = makeProps({ queueLength: 30, queueIndex: 14, isPlaying: true });
  const tree = render(decks.jukebox, props);
  const group = one(tree, (n) => n.props.role === 'group' && n.props['aria-label'] === 'Song selection', 'song selection group');
  assert.ok(!hidden(group), 'the keys are exposed to assistive tech');
  const keys = group.children.filter((c) => typeof c !== 'string');
  assert.equal(keys.length, 12);
  assert.ok(keys.every((k) => k.type === 'button'), 'each key is a real button');
  assert.deepEqual(keys.map((k) => k.props.className.includes('is-lit')), Array.from({ length: 12 }, (_, i) => i === 2), 'the playing entry is the lit key');
  assert.equal(keys[2].props['aria-current'], 'true');
  assert.equal(keys[2].props['aria-label'], 'Play queue item 15');
  assert.equal(nameOf(keys[0]), 'Play queue item 13');
  keys[4].props.onClick();
  assert.deepEqual(calls.onSelectQueueIndex, [[16]], 'key 5 plays queue position 17 on the second page');

  // The lit key is the song that is on: it starts it over, and is not played
  // again through the queue, which would log a skip and reset the shuffle.
  keys[2].props.onClick();
  assert.deepEqual(calls.onSelectQueueIndex, [[16]], 'the lit key does not re-queue the playing entry');
  assert.deepEqual(calls.onSeek, [[0]], 'the lit key restarts the song');
  assert.equal(calls.onTogglePlay, undefined, 'and keeps playing');
  const paused = makeProps({ queueLength: 30, queueIndex: 14, isPlaying: false });
  const pausedGroup = one(render(decks.jukebox, paused.props), (n) => n.props.role === 'group' && n.props['aria-label'] === 'Song selection', 'song selection group');
  pausedGroup.children.filter((c) => typeof c !== 'string')[2].props.onClick();
  assert.deepEqual(paused.calls.onSeek, [[0]]);
  assert.equal(paused.calls.onTogglePlay?.length, 1, 'a paused song starts playing from the top');
  assert.equal(paused.calls.onSelectQueueIndex, undefined);
  assert.equal(one(tree, (n) => n.props.className === 'deck-jb-strip-sel', 'selection readout').children.join(''), 'B–03');
  assert.equal(all(tree, (n) => n.props.className === 'deck-jb-strip-demo').length, 0);
}

{
  const { props } = makeProps({ queueLength: 4, queueIndex: 1 });
  const tree = render(decks.jukebox, props);
  const keys = all(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('deck-jb-keycap'));
  assert.deepEqual(keys.map((k) => !k.props.disabled), Array.from({ length: 12 }, (_, i) => i < 4), 'a four-track queue enables four keys');
  assert.equal(keys[1].props.className.includes('is-lit'), true);
}

{
  const { props } = makeProps({ track: null, queueLength: 0, queueIndex: -1 });
  const tree = render(decks.jukebox, props);
  assert.equal(all(tree, (n) => n.props.className === 'deck-jb-strip-demo').length, 1, 'an idle jukebox reads as a demo');
  assert.ok(all(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('deck-jb-keycap')).every((k) => k.props.disabled));
}

// --- Retro TV channel knob ---------------------------------------------------

assert.deepEqual(['ArrowUp', 'ArrowRight', 'PageUp', 'Enter', ' '].map(channelKeyStep), [1, 1, 1, 1, 1]);
assert.deepEqual(['ArrowDown', 'ArrowLeft', 'PageDown'].map(channelKeyStep), [-1, -1, -1]);
assert.deepEqual(['a', 'Home', 'End', 'Tab', 'Escape'].map(channelKeyStep), [0, 0, 0, 0, 0], 'other keys are left to the page');

{
  const click = new ChannelGesture(100, 100);
  assert.equal(click.move(100 + CHANNEL_CLICK_SLOP_PX, 100), 0, 'a wobble inside the slop is not a drag');
  assert.equal(click.isClick, true);

  const up = new ChannelGesture(100, 100);
  assert.equal(up.move(100, 100 - CHANNEL_DRAG_STEP_PX + 1), 0, 'short of a detent');
  assert.equal(up.isClick, false, 'past the slop it is a drag, so release is not a click');
  assert.equal(up.move(100, 100 - CHANNEL_DRAG_STEP_PX), 1, 'up one detent');
  assert.equal(up.move(100, 100 - 3 * CHANNEL_DRAG_STEP_PX), 1, 'a jump over two detents turns one now');
  assert.equal(up.move(100, 100 - 3 * CHANNEL_DRAG_STEP_PX), 1, 'and the other on the next move');
  assert.equal(up.move(100, 100 - 3 * CHANNEL_DRAG_STEP_PX), 0, 'then it has caught up');
  assert.equal(up.move(100, 100 - CHANNEL_DRAG_STEP_PX), -1, 'dragging back un-turns them one at a time');
  assert.equal(up.move(100, 100 - CHANNEL_DRAG_STEP_PX), -1);
  assert.equal(up.move(100, 100 - CHANNEL_DRAG_STEP_PX), 0);

  const right = new ChannelGesture(0, 0);
  assert.equal(right.move(CHANNEL_DRAG_STEP_PX, 0), 1, 'right is forward');
  const left = new ChannelGesture(0, 0);
  assert.equal(left.move(-CHANNEL_DRAG_STEP_PX, 0), -1, 'left is back');
  const down = new ChannelGesture(0, 0);
  assert.equal(down.move(0, CHANNEL_DRAG_STEP_PX), -1, 'down is back');
}

{
  const wheel = new ChannelWheel();
  assert.equal(wheel.next({ deltaY: -100, deltaMode: 0 }, 1000), 1, 'one notch up is next');
  assert.equal(wheel.next({ deltaY: -100, deltaMode: 0 }, 1100), 0, 'the rest of a flick is ignored while the knob settles');
  assert.equal(wheel.next({ deltaY: 100, deltaMode: 0 }, 1500), -1, 'one notch down is previous once settled');

  // A trackpad or Magic Mouse flick keeps reporting for over a second as the
  // momentum dies away. It is one gesture and one track, however long it runs.
  const flick = (target, { start, decay, from, direction = -1, every = 16, until = 1500 }) => {
    const steps = [];
    let delta = start;
    for (let t = 0; t <= until; t += every) {
      const step = target.next({ deltaY: direction * delta, deltaMode: 0 }, from + t);
      if (step) steps.push({ at: t, step });
      delta *= decay;
    }
    return steps;
  };
  for (const [start, decay] of [[60, 0.95], [40, 0.96], [100, 0.97], [300, 0.9]]) {
    const momentum = new ChannelWheel();
    const first = flick(momentum, { start, decay, from: 10000 });
    assert.equal(first.length, 1, `a ${start}px flick decaying by ${decay} changes one track, not ${first.map((s) => s.at).join(', ')}`);
    assert.equal(first[0].step, 1);
    const sameGesture = flick(momentum, { start: 80, decay: 0.9, from: 10000 + 1500 + 200, until: 400 });
    assert.deepEqual(sameGesture, [], 'a burst that picks up within the gap is still the same gesture');
    const second = flick(momentum, { start, decay, from: 10000 + 1500 + 200 + 400 + 400, direction: 1 });
    assert.deepEqual(second.map((s) => s.step), [-1], 'a flick after a pause is a new gesture, one step the other way');
  }

  const clicks = new ChannelWheel();
  assert.deepEqual([0, 400, 800].map((at) => clicks.next({ deltaY: -100, deltaMode: 0 }, 20000 + at)), [1, 1, 1], 'notches with a pause between them each change track');
  const spun = new ChannelWheel();
  assert.deepEqual([0, 120, 240, 360].map((at) => spun.next({ deltaY: -100, deltaMode: 0 }, 30000 + at)), [1, 0, 0, 0], 'a notched wheel spun fast is one gesture too');

  const trackpad = new ChannelWheel();
  let steps = 0;
  for (let i = 0; i < 9; i += 1) steps += trackpad.next({ deltaY: -10, deltaMode: 0 }, 5000 + i * 16);
  assert.equal(steps, 0, 'a small trackpad nudge does not change track');
  steps += trackpad.next({ deltaY: -10, deltaMode: 0 }, 5000 + 9 * 16);
  assert.equal(steps, 1, 'enough travel does');
  assert.equal(new ChannelWheel().next({ deltaY: -3, deltaMode: 1 }, 0), 0, 'three lines is under a notch');
  assert.equal(new ChannelWheel().next({ deltaY: -7, deltaMode: 1 }, 0), 1, 'seven lines is a notch');
  assert.equal(new ChannelWheel().next({ deltaY: 0, deltaMode: 0 }, 0), 0);
  assert.equal(new ChannelWheel().next({ deltaY: Number.NaN, deltaMode: 0 }, 0), 0);
  const partial = new ChannelWheel();
  partial.next({ deltaY: -60, deltaMode: 0 }, 0);
  assert.equal(partial.next({ deltaY: -60, deltaMode: 0 }, 2000), 0, 'a half-turned notch is forgotten after a pause');
}

function pointer(extra = {}) {
  const target = { blurred: 0, captured: [], blur() { target.blurred += 1; }, setPointerCapture(id) { target.captured.push(id); } };
  return event({ button: 0, pointerId: 4, clientX: 100, clientY: 100, shiftKey: false, currentTarget: target, ...extra });
}

{
  const { props, calls } = makeProps();
  const knob = one(render(decks['retro-tv'], props), (n) => 'data-newamp-deck-channel-knob' in n.props, 'channel knob');
  assert.equal(knob.props.role, 'button');
  assert.equal(knob.props.tabIndex, 0, 'the channel knob is reachable with Tab');
  assert.ok(!hidden(knob), 'the channel knob is not hidden from assistive tech');
  assert.match(nameOf(knob), /channel/i);

  // keyboard
  for (const [key, handler] of [['ArrowUp', 'onNext'], ['ArrowRight', 'onNext'], ['Enter', 'onNext'], [' ', 'onNext'], ['ArrowDown', 'onPrev'], ['ArrowLeft', 'onPrev']]) {
    const before = (calls[handler] ?? []).length;
    const e = event({ key });
    knob.props.onKeyDown(e);
    assert.equal((calls[handler] ?? []).length, before + 1, `${key} calls ${handler}`);
    assert.equal(e.prevented, 1, `${key} does not also scroll or toggle playback`);
    assert.equal(e.stopped, 1);
  }
  const stray = event({ key: 'a' });
  const nextBefore = calls.onNext.length;
  const prevBefore = calls.onPrev.length;
  knob.props.onKeyDown(stray);
  assert.equal(calls.onNext.length + calls.onPrev.length, nextBefore + prevBefore);
  assert.equal(stray.prevented, 0, 'unrelated keys keep their normal behaviour');

  // chords are the global shortcuts' (Cmd+Up is volume on a Mac, Ctrl+Left is
  // previous), so the knob leaves them alone and does not hide them
  const chordBefore = calls.onNext.length + calls.onPrev.length;
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ']) {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      const chord = event({ key, [modifier]: true });
      knob.props.onKeyDown(chord);
      assert.equal(chord.prevented, 0, `${modifier}+${JSON.stringify(key)} is not taken by the knob`);
      assert.equal(chord.stopped, 0, `${modifier}+${JSON.stringify(key)} still reaches the global shortcuts`);
    }
  }
  assert.equal(calls.onNext.length + calls.onPrev.length, chordBefore, 'no chord changes track');

  // a held key is one turn, not one per OS key repeat, and still stays off the page
  for (const key of ['Enter', ' ', 'ArrowUp', 'ArrowDown']) {
    const held = event({ key, repeat: true });
    knob.props.onKeyDown(held);
    assert.equal(calls.onNext.length + calls.onPrev.length, nextBefore + prevBefore, `a repeating ${JSON.stringify(key)} does not change track again`);
    assert.equal(held.prevented, 1, `a repeating ${JSON.stringify(key)} still does not scroll or toggle playback`);
    assert.equal(held.stopped, 1);
  }

  // click: forward; shift+click: back
  const down = pointer();
  knob.props.onPointerDown(down);
  assert.deepEqual(down.currentTarget.captured, [4], 'the knob captures the pointer');
  assert.equal(down.prevented, 1);
  const n0 = calls.onNext.length;
  const release = pointer();
  knob.props.onPointerUp(release);
  assert.equal(calls.onNext.length, n0 + 1, 'a click goes to the next track');
  assert.equal(release.currentTarget.blurred, 1, 'a mouse press does not leave the knob holding the arrow keys');
  const p0 = calls.onPrev.length;
  knob.props.onPointerDown(pointer());
  knob.props.onPointerUp(pointer({ shiftKey: true }));
  assert.equal(calls.onPrev.length, p0 + 1, 'shift+click goes to the previous track');

  // drag: up two detents, then back one; the release is not also a click
  const n1 = calls.onNext.length;
  const p1 = calls.onPrev.length;
  knob.props.onPointerDown(pointer());
  knob.props.onPointerMove(pointer({ clientY: 100 - CHANNEL_DRAG_STEP_PX }));
  assert.equal(calls.onNext.length, n1 + 1, 'dragging up one detent goes to the next track');
  knob.props.onPointerMove(pointer({ clientY: 100 - 2 * CHANNEL_DRAG_STEP_PX }));
  assert.equal(calls.onNext.length, n1 + 2);
  knob.props.onPointerMove(pointer({ clientY: 100 - CHANNEL_DRAG_STEP_PX }));
  assert.equal(calls.onPrev.length, p1 + 1, 'dragging back goes to the previous track');
  knob.props.onPointerUp(pointer({ clientY: 100 - CHANNEL_DRAG_STEP_PX }));
  assert.equal(calls.onNext.length, n1 + 2, 'releasing after a drag is not a click');
  assert.equal(calls.onPrev.length, p1 + 1);

  // a fast drag across several detents is paced one track per pointer event
  const n5 = calls.onNext.length;
  knob.props.onPointerDown(pointer());
  knob.props.onPointerMove(pointer({ clientY: 100 - 3 * CHANNEL_DRAG_STEP_PX }));
  assert.equal(calls.onNext.length, n5 + 1, 'one pointer event across three detents changes one track');
  knob.props.onPointerMove(pointer({ clientY: 100 - 3 * CHANNEL_DRAG_STEP_PX }));
  knob.props.onPointerMove(pointer({ clientY: 100 - 3 * CHANNEL_DRAG_STEP_PX }));
  assert.equal(calls.onNext.length, n5 + 3, 'the detents it skipped over are taken on the moves that follow');
  knob.props.onPointerMove(pointer({ clientY: 100 - 3 * CHANNEL_DRAG_STEP_PX }));
  knob.props.onPointerUp(pointer({ clientY: 100 - 3 * CHANNEL_DRAG_STEP_PX }));
  assert.equal(calls.onNext.length, n5 + 3, 'three detents is three tracks, no more');

  // moves with no button down, a cancelled press and other buttons do nothing
  const n2 = calls.onNext.length;
  knob.props.onPointerMove(pointer({ clientY: 0 }));
  knob.props.onPointerDown(pointer());
  knob.props.onPointerCancel(pointer());
  knob.props.onPointerUp(pointer());
  const secondary = pointer({ button: 2 });
  knob.props.onPointerDown(secondary);
  assert.equal(secondary.currentTarget.captured.length, 0, 'only the primary button turns the knob');
  knob.props.onPointerUp(pointer());
  assert.equal(calls.onNext.length, n2, 'stray moves, cancelled presses and right-clicks leave the track alone');

  // a few pixels of wobble in a trackpad tap is still a click
  const n4 = calls.onNext.length;
  knob.props.onPointerDown(pointer());
  knob.props.onPointerMove(pointer({ clientX: 100 + CHANNEL_CLICK_SLOP_PX, clientY: 100 }));
  knob.props.onPointerUp(pointer());
  assert.equal(calls.onNext.length, n4 + 1, 'a press that stays inside the slop is a click');

  // wheel
  const wheel = (deltaY, timeStamp) => knob.props.onWheel({ deltaY, deltaMode: 0, timeStamp });
  const n3 = calls.onNext.length;
  const p3 = calls.onPrev.length;
  wheel(-100, 40000);
  assert.equal(calls.onNext.length, n3 + 1, 'scrolling up goes to the next track');
  wheel(-100, 40100);
  assert.equal(calls.onNext.length, n3 + 1, 'a burst of wheel events changes one track');
  wheel(100, 40800);
  assert.equal(calls.onNext.length, n3 + 1);
  assert.equal(calls.onPrev.length, p3 + 1, 'scrolling down after a pause goes to the previous track');

  // assistive technology activates the knob with a click that has no pointer or key events
  const n6 = calls.onNext.length;
  const p6 = calls.onPrev.length;
  knob.props.onClick(event({ detail: 0 }));
  assert.equal(calls.onNext.length, n6 + 1, 'a synthesized click turns the knob forward');
  knob.props.onClick(event({ detail: 0, shiftKey: true }));
  assert.equal(calls.onPrev.length, p6 + 1, 'and with shift, back');
  knob.props.onClick(event({ detail: 1 }));
  knob.props.onClick(event({ detail: 2 }));
  assert.equal(calls.onNext.length, n6 + 1, 'a mouse click was already handled on release and is not counted twice');
  assert.equal(calls.onPrev.length, p6 + 1);

  // a cancelled press lets go of the arrow keys too
  const cancel = pointer();
  knob.props.onPointerCancel(cancel);
  assert.equal(cancel.currentTarget.blurred, 1);
}

// --- Retro TV volume knob: keyboard and double-click ---------------------------

{
  const volumeKnob = (volume) => {
    const { props, calls } = makeProps({ volume });
    return { knob: one(render(decks['retro-tv'], props), (n) => 'data-newamp-deck-volume-knob' in n.props, 'volume knob'), calls };
  };
  const press = (volume, key) => {
    const { knob, calls } = volumeKnob(volume);
    const e = event({ key });
    knob.props.onKeyDown(e);
    return { e, set: calls.onSetVolume?.map(([v]) => v) ?? [] };
  };
  for (const [key, delta] of [['ArrowUp', 0.02], ['ArrowRight', 0.02], ['ArrowDown', -0.02], ['ArrowLeft', -0.02], ['PageUp', 0.1], ['PageDown', -0.1]]) {
    const { e, set } = press(1, key);
    assert.equal(set.length, 1, `${key} sets the volume once`);
    near(set[0], 1 + delta, key);
    assert.equal(e.prevented, 1);
    assert.equal(e.stopped, 1, `${key} stays off the global shortcuts`);
  }
  near(press(1, 'Home').set[0], 0, 'Home mutes');
  near(press(1, 'End').set[0], 2, 'End is full boost');
  near(press(1.99, 'ArrowUp').set[0], 2, 'the top of the range clamps');
  near(press(0.01, 'ArrowDown').set[0], 0, 'the bottom of the range clamps');
  const stray = press(1, 'a');
  assert.deepEqual(stray.set, [], 'unrelated keys do nothing');
  assert.equal(stray.e.prevented, 0);
  const reset = volumeKnob(1.5);
  reset.knob.props.onDoubleClick();
  assert.deepEqual(reset.calls.onSetVolume, [[1]], 'double-click resets the volume to 100%');
  assert.equal(reset.knob.props.role, 'slider');
  assert.equal(reset.knob.props['aria-valuenow'], 150);
}

// --- Retro TV screen name -----------------------------------------------------

{
  const label = tvScreenLabel(track);
  assert.equal(label, 'Blue Train, John Coltrane');
  assert.equal(tvScreenLabel(null), 'No signal');

  // The name holds still while the song plays; a name that ticks every second
  // is read out again each time. What a click does is the title.
  const { props } = makeProps();
  const later = makeProps({ currentTime: 66 }).props;
  assert.equal(
    one(render(decks['retro-tv'], later), (n) => 'data-newamp-tv-state' in n.props, 'screen button').props['aria-label'],
    label,
    'the screen button name does not change with the playback position',
  );
  const screen = one(render(decks['retro-tv'], props), (n) => 'data-newamp-tv-state' in n.props, 'screen button');
  assert.equal(screen.props['aria-label'], label, 'the screen button is named for what is on the tube');
  assert.match(screen.props.title, /double-click for fullscreen/, 'what a click does is its description');
  assert.equal(screen.props['data-newamp-tv-state'], 'tuned');
  const dark = one(render(decks['retro-tv'], makeProps({ track: null }).props), (n) => 'data-newamp-tv-state' in n.props, 'idle screen button');
  assert.equal(dark.props['aria-label'], 'No signal');
  assert.ok(hidden(one(render(decks['retro-tv'], props), (n) => n.props.className === 'deck-tv-readout', 'burnt-in readout')), 'the decorative readout stays hidden');
}

// --- Every deck: names and window controls ------------------------------------

const lettersIn = (text) => text.replace(/[^A-Za-z]/g, '').length;
for (const [skin, Deck] of Object.entries(decks)) {
  for (const isPlaying of [false, true]) {
    const { props } = makeProps({ isPlaying, deckSkin: skin });
    const tree = render(Deck, props);
    const controls = all(tree, isControl);
    assert.ok(controls.length >= 8, `${skin}: found its controls`);
    for (const control of controls) {
      const name = nameOf(control);
      assert.ok(lettersIn(name) >= 3, `${skin}: control named ${JSON.stringify(name)} is only a glyph (${control.props.className ?? control.type})`);
    }
    if (skin !== 'discman') {
      for (const label of ['Previous track', isPlaying ? 'Pause' : 'Play', 'Stop', 'Next track']) {
        assert.equal(byLabel(tree, label).length, 1, `${skin}: one "${label}" button`);
      }
    }
  }

  // The compact window is frameless and hides the macOS traffic lights, so
  // every skin carries its own pair on every platform.
  const { props, calls } = makeProps({ deckSkin: skin });
  const tree = render(Deck, props);
  for (const label of ['Minimize', 'Close', 'PIN', 'FULL']) {
    assert.equal(byLabel(tree, label).length, 1, `${skin}: one "${label}" button`);
  }
  byLabel(tree, 'Minimize')[0].props.onClick();
  byLabel(tree, 'Close')[0].props.onClick();
  assert.equal(calls.onMinimize?.length, 1, `${skin}: minimize reaches the window`);
  assert.equal(calls.onClose?.length, 1, `${skin}: close reaches the window`);
}

// --- Decorative hardware stays decorative ---------------------------------------

{
  const rp = render(decks['record-player'], makeProps().props);
  for (const cls of ['deck-rp-speed-bank', 'deck-rp-pitch']) {
    const bank = one(rp, (n) => n.props.className === cls, cls);
    assert.ok(hidden(bank), `${cls} is printed panel text`);
    assert.equal(all(bank, (n) => n !== bank && (isControl(n) || n.props.onClick || n.props.onPointerDown)).length, 0, `${cls} has nothing to press`);
  }
  const css = readFileSync('src/styles/decks/record-player.css', 'utf8');
  const block = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} rule exists`);
    return css.slice(start, css.indexOf('}', start));
  };
  for (const selector of ['.deck-rp-speed-bank > span:not(.deck-rp-speed-label)', '.deck-rp-speed-bank > span.is-selected', '.deck-rp-pitch-slit > i']) {
    assert.doesNotMatch(block(selector), /box-shadow|gradient|transform/, `${selector} does not look like a pressable key`);
  }

  const dm = render(decks.discman, makeProps().props);
  assert.equal(all(dm, (n) => String(n.props.className ?? '').includes('thumbwheel')).length, 0, 'the Discman has no second, dead volume wheel');
  const row = one(dm, (n) => n.props.className === 'deck-dm-volume-row', 'volume row');
  assert.equal(all(row, (n) => n.type === 'stub-VolumeSlider').length, 1, 'the slider is the only volume control');
  assert.ok(all(row, (n) => n.type === 'svg').every(hidden), 'the speaker mark is decorative');
}

// --- Window controls and wiring ---------------------------------------------------

{
  // The windowshade keeps the order it always had: minimize first, close last.
  const { props } = makeProps({ deckSkin: 'bento' });
  const strip = one(render(decks.bento, props), (n) => n.props.className === 'compact-window titlebar-nodrag', 'windowshade button strip');
  assert.deepEqual(all(strip, isControl).map(nameOf), ['Minimize', 'PIN', 'FULL', 'Close']);

  // The decks draw their own Minimize and Close on every platform because the
  // main process hides the macOS traffic lights while the window is a deck.
  // Nothing on the renderer side may take them away again.
  const main = readFileSync('electron/main.ts', 'utf8');
  const start = main.indexOf('async function setCompactMode(');
  assert.ok(start >= 0, 'main.ts still has setCompactMode');
  const end = main.indexOf('\nfunction ', start);
  const setCompactMode = main.slice(start, end > start ? end : undefined);
  const hide = setCompactMode.indexOf('setWindowButtonVisibility(false)');
  const show = setCompactMode.indexOf('setWindowButtonVisibility(true)');
  assert.ok(hide >= 0, 'entering the compact window hides the macOS traffic lights');
  assert.ok(show > hide, 'and leaving it brings them back');
  const compact = readFileSync('src/components/CompactPlayer.tsx', 'utf8');
  assert.doesNotMatch(compact, /native-controls/, 'CompactPlayer does not switch the deck buttons off');
  assert.doesNotMatch(readFileSync('src/styles/decks/core.css', 'utf8'), /native-controls/, 'no deck leaves room for traffic lights that are not drawn');
  assert.match(compact, /onSelectQueueIndex:[\s\S]{0,200}playQueue\(queue, index\)/, 'the jukebox keys play through the queue');
}

console.log('deck controls ok');
