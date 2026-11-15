// A radio station and a library track must never play at once. Starting a
// station pauses the library, and library playback starting from anywhere
// (Transport, Space, a media key, a detached remote) ends the station, or the
// connect still under way, whether or not the Radio view is on screen.
// Runs the real RadioView against stand-ins for the audio element and the
// player store (scripts/lib/radio-view-rig.mjs).
// Run with: npm run test:radio-library-exclusivity

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRadioRig, directoryStation } from './lib/radio-view-rig.mjs';

const stations = [directoryStation('a'), directoryStation('b')];

async function rigWithResults() {
  const rig = await createRadioRig({ stations });
  await rig.search('jazz');
  return rig;
}

async function goLive(rig, index = 0) {
  rig.click(rig.rowButton(index));
  await rig.flush();
  rig.audio.answer(rig.audio.plays.length - 1);
  await rig.flush();
  assert.equal(rig.isLive(), true);
}

// Starting a station pauses the library.
{
  const rig = await rigWithResults();
  rig.player({ isPlaying: true });
  rig.click(rig.rowButton(0));
  await rig.flush();
  assert.equal(rig.store.pauses, 1, 'starting a station pauses library playback');
  assert.equal(rig.store.state.isPlaying, false);
  assert.equal(rig.isConnecting(), true, 'and the station is not ended by the pause it caused');
  rig.audio.answer(0);
  await rig.flush();
  assert.equal(rig.isLive(), true);
  rig.dispose();
}

// Library playback starting while a station is live ends it, the same as the Stop button.
{
  const rig = await rigWithResults();
  await goLive(rig);
  rig.player({ isPlaying: true });
  await rig.flush();
  assert.equal(rig.isLive(), false, 'the LIVE bar goes away');
  assert.equal(rig.audio.paused, true, 'the stream is paused');
  assert.equal(rig.audio.src, '', 'and released, not just paused');
  rig.dispose();
}

// The view does not have to be on screen.
{
  const rig = await rigWithResults();
  await goLive(rig);
  rig.view.unmount();
  rig.player({ isPlaying: true });
  assert.equal(rig.audio.paused, true, 'a station left playing under another view ends when the library starts');
  assert.equal(rig.audio.src, '');
  rig.dispose();
}

// Nor does the station have to be on air yet: a connect still under way is ended
// too, so it cannot come up over the library when it finishes.
for (const abortOnLoad of [true, false]) {
  const rig = await rigWithResults();
  rig.audio.abortOnLoad = abortOnLoad;
  rig.click(rig.rowButton(0));
  await rig.flush();
  assert.equal(rig.isConnecting(), true);
  rig.view.unmount();

  rig.player({ isPlaying: true });
  assert.equal(rig.audio.src, '', 'the connect is cancelled when the library starts');
  assert.equal(rig.audio.paused, true);

  // The connection finishes anyway, as one already in flight does.
  rig.audio.answer(0);
  await rig.settle();
  assert.equal(rig.audio.src, '');
  assert.equal(rig.audio.listenerCount('error'), 0, 'no stream watch is attached to a cancelled connect');
  assert.deepEqual(rig.clicks, [], 'a station that never went on air is not reported');
  assert.deepEqual(rig.toasts, [], 'and the cancelled connect says nothing');

  // Back on the Radio view, nothing claims to be playing or connecting.
  rig.remount();
  assert.equal(rig.isLive(), false);
  assert.equal(rig.isConnecting(), false);
  rig.dispose();
}

// A view that mounts while a connect is under way shows it, and follows it to the end.
{
  const rig = await rigWithResults();
  rig.click(rig.rowButton(0));
  await rig.flush();
  rig.remount();
  assert.equal(rig.isConnecting(), true, 'the connect in progress is shown');
  rig.audio.answer(0);
  await rig.flush();
  assert.equal(rig.isLive(), true, 'and so is the station once it is on air');
  rig.dispose();
}

// Only the library starting ends the station; other changes to the player leave it on air.
{
  const rig = await rigWithResults();
  await goLive(rig);
  assert.equal(rig.audio.paused, false);
  rig.player({ volume: 0.3 });
  rig.player({ isPlaying: false });
  assert.equal(rig.isLive(), true, 'only the library starting ends the station, not other store changes');
  rig.dispose();
}

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"test:radio-library-exclusivity"/, 'package.json should expose the radio/library exclusivity test');

console.log(JSON.stringify({ ok: true }, null, 2));
