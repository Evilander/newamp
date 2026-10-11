// Projector control bar rules: arrow-key seeking and volume, and the slider
// accent taken from the skin. Plus the wiring in src/detached/main.tsx.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Projector controls test timed out'); process.exit(1); }, 20000);
deadline.unref();

const bundled = await build({
  stdin: { contents: "export * from './src/detached/projector-controls';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const {
  PROJECTOR_ACCENT_FALLBACK, PROJECTOR_SEEK_STEP, PROJECTOR_VOLUME_STEP,
  projectorAccent, projectorSeekTarget, projectorVolumeTarget,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// ---- seeking ----
assert.equal(PROJECTOR_SEEK_STEP, 5);
assert.equal(projectorSeekTarget({ currentTime: 30, duration: 200 }, 5), 35);
assert.equal(projectorSeekTarget({ currentTime: 30, duration: 200 }, -5), 25);
assert.equal(projectorSeekTarget({ currentTime: 3, duration: 200 }, -5), 0, 'never before the start');
assert.equal(projectorSeekTarget({ currentTime: 198, duration: 200 }, 5), 200, 'never past the end');
// A stream has no duration. The forward seek used to clamp to it and land on 0:00.
assert.equal(projectorSeekTarget({ currentTime: 42, duration: 0 }, 5), 47);
assert.equal(projectorSeekTarget({ currentTime: 42, duration: 0 }, -5), 37);
assert.equal(projectorSeekTarget({ currentTime: 2, duration: 0 }, -5), 0);
assert.equal(projectorSeekTarget({ currentTime: 42, duration: Number.NaN }, 5), 47, 'an unknown duration is not a limit');

// ---- volume ----
assert.equal(PROJECTOR_VOLUME_STEP, 0.05);
assert.equal(projectorVolumeTarget(0.75, 1), 0.8);
assert.equal(projectorVolumeTarget(0.75, -1), 0.7);
assert.equal(projectorVolumeTarget(1.98, 1), 2, 'clamps at 200%');
assert.equal(projectorVolumeTarget(0.02, -1), 0, 'clamps at silence');
assert.equal(projectorVolumeTarget(2, 1), 2);
assert.equal(projectorVolumeTarget(0, -1), 0);
assert.equal(projectorVolumeTarget(Number.NaN, 1), 0.05, 'an unreadable slider starts from silence');
// Ten key presses add up exactly, with no float drift.
let held = 0.5;
for (let press = 0; press < 10; press += 1) held = projectorVolumeTarget(held, 1);
assert.equal(held, 1);
for (let press = 0; press < 10; press += 1) held = projectorVolumeTarget(held, -1);
assert.equal(held, 0.5);

// ---- accent ----
assert.equal(PROJECTOR_ACCENT_FALLBACK, '#7aa8ff');
assert.equal(projectorAccent(null), PROJECTOR_ACCENT_FALLBACK);
assert.equal(projectorAccent(undefined), PROJECTOR_ACCENT_FALLBACK);
assert.equal(projectorAccent({}), PROJECTOR_ACCENT_FALLBACK, 'a main window that sends no accent leaves the default');
assert.equal(projectorAccent({ accent: null }), PROJECTOR_ACCENT_FALLBACK);
assert.equal(projectorAccent({ accent: '' }), PROJECTOR_ACCENT_FALLBACK);
assert.equal(projectorAccent({ accent: '#39ff14' }), '#39ff14');
assert.equal(projectorAccent({ accent: '  #39FF14 ' }), '#39FF14');
assert.equal(projectorAccent({ accent: '#abc' }), '#abc');
assert.equal(projectorAccent({ accent: '#abcd' }), '#abcd', 'a short hex with alpha is a colour');
assert.equal(projectorAccent({ accent: '#39ff1480' }), '#39ff1480', 'and so is a long one');
// A hex of 5 or 7 digits is not a colour: the browser would ignore it and the bar would
// then claim an accent that is not on screen.
for (const odd of ['#12345', '#1234567', '#12', '#123456789']) {
  assert.equal(projectorAccent({ accent: odd }), PROJECTOR_ACCENT_FALLBACK, `${odd} is not a valid hex colour`);
}
assert.equal(projectorAccent({ accent: 'rgb(255, 0, 128)' }), 'rgb(255, 0, 128)');
assert.equal(projectorAccent({ accent: 'hsl(120 100% 50% / 0.8)' }), 'hsl(120 100% 50% / 0.8)');
for (const hostile of ['red', 'url(javascript:alert(1))', 'rgb(0,0,0); background: red', '#fff; x', 'var(--accent)', 'expression(1)']) {
  assert.equal(projectorAccent({ accent: hostile }), PROJECTOR_ACCENT_FALLBACK, `${hostile} is not a plain colour value`);
}

// ---- wiring ----
const source = await readFile(new URL('../src/detached/main.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(source, /accentColor: '#7aa8ff'/, 'the sliders no longer hard-code the blue');
assert.equal((source.match(/accentColor: PROJECTOR_ACCENT_FALLBACK/g) ?? []).length, 2, 'scrub and volume both start from the fallback');
assert.match(source, /scrubEl\.style\.accentColor = accent;\s*volEl\.style\.accentColor = accent;/, 'and both follow the skin accent');
assert.match(source, /projectorSeekTarget\(lastTransport, action === 'seek-forward' \? PROJECTOR_SEEK_STEP : -PROJECTOR_SEEK_STEP\)/, 'forward seek no longer clamps to an unknown duration');
assert.match(source, /action === 'volume-up' \|\| action === 'volume-down'/, 'Up and Down are volume keys in the projector');
assert.match(source, /transportCommand\?\.\('setVolume', target\)/);
assert.match(source, /performance\.now\(\) >= volHoldUntil/, 'a stale mirrored volume does not undo a key press');

console.log(JSON.stringify({ ok: true }, null, 2));
