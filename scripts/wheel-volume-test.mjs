// The wheel-to-volume mapping: one notch of a mouse wheel is one small
// step, and a trackpad flick made of many small events adds up to about the
// same, instead of one step per event.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/lib/wheel-volume.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { wheelVolumeDelta, clampVolume, WheelVolumeAccumulator } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

// A notched mouse: Chromium reports one click as 100 px.
near(wheelVolumeDelta({ deltaY: 100, deltaMode: 0 }), -0.04, 'one notch down');
near(wheelVolumeDelta({ deltaY: -100, deltaMode: 0 }), 0.04, 'one notch up');
near(wheelVolumeDelta({ deltaY: -100, deltaMode: 0, shiftKey: true }), 0.12, 'shift triples a notch');

// A trackpad flick: 25 events of 6 px each (150 px in all) is well under one
// notch per event, so the whole flick is a nudge, not a jump.
let flick = 0;
for (let i = 0; i < 25; i++) flick += wheelVolumeDelta({ deltaY: -6, deltaMode: 0 });
near(flick, 0.06, 'a trackpad flick adds up by distance');
assert.ok(flick < 0.1, `a flick must not jump the volume, got ${flick}`);

// A busy renderer makes Chromium merge queued wheel events into one with the
// summed distance, so a merged flick must still count in full...
near(wheelVolumeDelta({ deltaY: -600, deltaMode: 0 }), 0.24, 'a merged flick keeps its distance');
// ...and only an absurd delta is capped.
near(wheelVolumeDelta({ deltaY: -12000, deltaMode: 0 }), 0.4, 'an absurd single delta is capped');
// Line and page modes are converted before the cap.
near(wheelVolumeDelta({ deltaY: -3, deltaMode: 1 }), 0.0192, 'three lines');
near(wheelVolumeDelta({ deltaY: 1, deltaMode: 2 }), -0.32, 'one page');
assert.equal(wheelVolumeDelta({ deltaY: Number.NaN, deltaMode: 0 }), 0, 'NaN moves nothing');
// macOS swaps Shift+wheel onto the horizontal axis before the page sees it.
near(wheelVolumeDelta({ deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true }), 0.12, 'Shift+wheel up on a Mac');
// A sideways swipe over the slider: right is louder.
near(wheelVolumeDelta({ deltaY: 0, deltaX: 100, deltaMode: 0 }), 0.04, 'a swipe to the right');
near(wheelVolumeDelta({ deltaY: -100, deltaX: 30, deltaMode: 0 }), 0.04, 'a diagonal swipe follows the vertical part');
assert.equal(clampVolume(2.5), 2);
assert.equal(clampVolume(-1), 0);

// The accumulator: events that land before React paints build on the value
// the wheel last sent, not on the stale rendered one.
{
  const acc = new WheelVolumeAccumulator();
  acc.observe(0.5);
  near(acc.next(0.5, 0.01, 1000), 0.51, 'first event adds to the rendered value');
  near(acc.next(0.5, 0.01, 1010), 0.52, 'second event before a paint adds to the first');
  near(acc.next(0.5, 0.01, 1020), 0.53, 'and so does the third');
  acc.observe(0.53);
  near(acc.next(0.53, 0.01, 1030), 0.54, 'after the paint catches up the rendered value is the base');
  // Something else (a key, a drag) moved the volume after a wheel: once the
  // window passes the rendered value wins again.
  acc.next(0.54, 0.01, 2000);
  near(acc.next(0.9, 0.01, 2400), 0.91, 'a pending value expires');
  near(acc.next(2, 0.01, 3000), 2, 'the top is clamped');
}

console.log('PASS wheel volume: notches step, flicks nudge, merged events count, bursts accumulate');
