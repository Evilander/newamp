// The wheel-to-volume mapping: one notch of a mouse wheel is one small
// step, and a trackpad flick made of many small events adds up to about the
// same, instead of one step per event.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/lib/wheel-volume.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { wheelVolumeDelta, clampVolume } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

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

// One oversized event is capped at a notch.
near(wheelVolumeDelta({ deltaY: -1200, deltaMode: 0 }), 0.04, 'a huge single delta is capped');
// Line and page modes are converted before the cap.
near(wheelVolumeDelta({ deltaY: -3, deltaMode: 1 }), 0.0192, 'three lines');
near(wheelVolumeDelta({ deltaY: 1, deltaMode: 2 }), -0.04, 'one page is capped at a notch');
assert.equal(wheelVolumeDelta({ deltaY: Number.NaN, deltaMode: 0 }), 0, 'NaN moves nothing');
assert.equal(clampVolume(2.5), 2);
assert.equal(clampVolume(-1), 0);

console.log('PASS wheel volume: notches step, flicks nudge, oversized events are capped');
