import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  combinePlaybackMode,
  isShuffleMode,
  repeatModeOf,
} from '../dist-electron/shared/types.js';
import { nextHandoffIndex } from '../dist-electron/shared/playback-handoff.js';
import { resolvePlaybackErrorAdvance } from '../dist-electron/shared/playback-error.js';

// combinePlaybackMode / isShuffleMode / repeatModeOf must round-trip for
// every mode, including the two new shuffle+repeat combos.
const ALL_MODES = ['normal', 'repeat-one', 'repeat-all', 'shuffle', 'shuffle-repeat-one', 'shuffle-repeat-all'];
for (const mode of ALL_MODES) {
  const roundTripped = combinePlaybackMode(isShuffleMode(mode), repeatModeOf(mode));
  assert.equal(roundTripped, mode, `combinePlaybackMode should round-trip ${mode}`);
}
assert.equal(isShuffleMode('shuffle-repeat-all'), true, 'shuffle-repeat-all should read as shuffle-on');
assert.equal(isShuffleMode('shuffle-repeat-one'), true, 'shuffle-repeat-one should read as shuffle-on');
assert.equal(isShuffleMode('repeat-all'), false, 'plain repeat-all should read as shuffle-off');
assert.equal(repeatModeOf('shuffle-repeat-all'), 'all', 'shuffle-repeat-all should read as repeat-all');
assert.equal(repeatModeOf('shuffle-repeat-one'), 'one', 'shuffle-repeat-one should read as repeat-one');
assert.equal(repeatModeOf('shuffle'), 'off', 'plain shuffle should read as repeat-off');

// Reproduce the reported bug scenario: toggling shuffle then cycling repeat
// (the two Transport buttons) must never clobber the other dimension.
// These mirror usePlayerStore.ts's toggleShuffle/cycleRepeat exactly.
function toggleShuffle(mode) {
  return combinePlaybackMode(!isShuffleMode(mode), repeatModeOf(mode));
}
function cycleRepeat(mode) {
  const repeat = repeatModeOf(mode);
  const nextRepeat = repeat === 'all' ? 'one' : repeat === 'one' ? 'off' : 'all';
  return combinePlaybackMode(isShuffleMode(mode), nextRepeat);
}

let mode = 'normal';
mode = cycleRepeat(mode);
assert.equal(mode, 'repeat-all', 'repeat cycle should start at repeat-all');
mode = toggleShuffle(mode);
assert.equal(
  mode,
  'shuffle-repeat-all',
  'turning shuffle on while repeat-all is active must keep repeat-all active (this is the reported bug: the old setMode ternary silently overwrote it with plain shuffle)',
);
mode = cycleRepeat(mode);
assert.equal(mode, 'shuffle-repeat-one', 'cycling repeat forward must preserve the shuffle flag');
mode = cycleRepeat(mode);
assert.equal(mode, 'shuffle', 'cycling repeat to off must preserve the shuffle flag, not just reset to normal');
mode = toggleShuffle(mode);
assert.equal(mode, 'normal', 'turning shuffle off with repeat already off should land on normal');

// The old buggy ternaries (kept here only to document the regression) really
// did clobber the other dimension — confirms this is a real behavior change,
// not a no-op refactor.
const oldShuffleToggle = (m) => (m === 'shuffle' ? 'normal' : 'shuffle');
assert.equal(oldShuffleToggle('repeat-all'), 'shuffle', 'documents the old bug: shuffle used to stomp repeat-all');

// nextHandoffIndex must keep treating every shuffle variant as
// "no deterministic next index" (same as plain shuffle today), and must
// still wrap a pure repeat-all queue to 0.
assert.equal(nextHandoffIndex({ queueLength: 4, index: 2, mode: 'shuffle-repeat-all' }), null, 'shuffle-repeat-all must not get a deterministic handoff index');
assert.equal(nextHandoffIndex({ queueLength: 4, index: 2, mode: 'shuffle-repeat-one' }), null, 'shuffle-repeat-one must not get a deterministic handoff index');
assert.equal(nextHandoffIndex({ queueLength: 4, index: 3, mode: 'repeat-all' }), 0, 'plain repeat-all should still wrap to 0');
assert.equal(nextHandoffIndex({ queueLength: 4, index: 3, mode: 'shuffle-repeat-all' }), null, 'shuffle-repeat-all at the tail should not deterministically wrap either');

// resolvePlaybackErrorAdvance must keep advancing past end-of-queue for the
// new combo modes, same as every non-normal mode.
assert.equal(
  resolvePlaybackErrorAdvance({
    error: 'boom',
    currentTrackId: 5,
    index: 2,
    queueLength: 3,
    mode: 'shuffle-repeat-all',
    lastErrorKey: null,
  }).shouldAdvance,
  true,
  'a shuffle+repeat-all combo should still advance past a playback error at the end of the queue',
);

// --- Source assertions: every UI surface that renders shuffle/repeat must
// route through the orthogonal helpers, not hand-rolled mode literals that
// silently drop the other dimension.
const [
  transportSource,
  storeSource,
  winampSource,
  bentoSource,
  discmanSource,
  typesSource,
  packageSource,
] = await Promise.all([
  readFile(new URL('../src/components/Transport.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/decks/WinampClassicDeck.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/decks/ClassicBentoDeck.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/decks/DiscmanDeck.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /'shuffle-repeat-one'/, 'PlaybackMode should carry a shuffle+repeat-one combo');
assert.match(typesSource, /'shuffle-repeat-all'/, 'PlaybackMode should carry a shuffle+repeat-all combo');
assert.match(storeSource, /toggleShuffle: \(\) => \{/, 'store should expose an orthogonal toggleShuffle action');
assert.match(storeSource, /cycleRepeat: \(\) => \{/, 'store should expose an orthogonal cycleRepeat action');

assert.match(transportSource, /onClick=\{toggleShuffle\}/, 'Transport shuffle button should call the orthogonal toggle, not a hand-rolled ternary');
assert.match(transportSource, /onClick=\{cycleRepeat\}/, 'Transport repeat button should call the orthogonal cycle, not a hand-rolled ternary');
assert.doesNotMatch(
  transportSource,
  /setMode\(mode === 'shuffle' \? 'normal' : 'shuffle'\)/,
  'Transport should no longer hand-roll the shuffle toggle (it clobbered repeat)',
);

for (const [name, source] of [['WinampClassicDeck', winampSource], ['ClassicBentoDeck', bentoSource], ['DiscmanDeck', discmanSource]]) {
  assert.match(source, /combinePlaybackMode\(/, `${name} should combine shuffle/repeat instead of hard-setting mode`);
  assert.doesNotMatch(
    source,
    /onSetMode\(mode === 'shuffle' \? 'normal' : 'shuffle'\)/,
    `${name} should no longer hand-roll the shuffle toggle (it clobbered repeat)`,
  );
}
assert.match(winampSource, /repeatModeOf\(mode\) === 'all' \? 'off' : 'all'/, 'WinampClassicDeck repeat toggle should preserve shuffle across its on/off cycle');

assert.match(packageSource, /"test:playback-mode"/, 'package.json should expose the playback mode independence test');

// The settings whitelist must accept every mode the transport can produce. It
// previously listed only the four original values, so turning on shuffle AND
// repeat persisted a mode it rejected on load — both toggles came back off.
const settingsSource = await readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8');
for (const mode of ['shuffle-repeat-one', 'shuffle-repeat-all']) {
  assert.match(settingsSource, new RegExp(`'${mode}'`), `electron/settings.ts must accept the persisted mode ${mode}`);
}

// Removing the LAST queued track is a removed-current case too, so it has to
// unload the engine; stop() alone leaves the removed track resumable.
// anchor on the implementation, not the interface declaration of the same name
const removeAction = storeSource.slice(storeSource.indexOf('removeQueuedTrack: async'));
const emptyQueueBranch = removeAction.slice(0, removeAction.indexOf('if (result.removedCurrent)'));
assert.doesNotMatch(emptyQueueBranch, /engine\.stop\(\)/, 'the empty-queue removal branch must not leave a stale src via stop()');
assert.match(emptyQueueBranch, /engine\.unload\(\)/, 'the empty-queue removal branch should unload the engine');

console.log(JSON.stringify({ ok: true }, null, 2));
