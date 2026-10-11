// The renderer side of the waveform seek bar: the path builder, the wheel-to-seek
// math, the waveform fetch/cache/prefetch layer, and the bar itself rendered to
// markup (hooks run against the real React; the store and the IPC bridge are stubs).
// The last section mounts the bar in a real browser (Chrome, Chromium or Edge,
// found on the machine, or named by NEWAMP_TEST_BROWSER) to run what markup
// can't: effects, the wheel listener and the settings switch.
// Run: node scripts/waveform-ui-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const deadline = setTimeout(() => { console.error('waveform ui test timed out'); process.exit(1); }, 90000);
deadline.unref();

const stubs = {
  '../store/usePlayerStore': 'export function usePlayerStore(selector) { return selector(globalThis.__store); }',
  '../lib/api': 'export const api = { getTrackWaveform: (...args) => globalThis.__api.getTrackWaveform(...args) };',
};
const bundled = await build({
  stdin: {
    contents: `
      export * from './src/lib/waveform-path';
      export * from './src/lib/wheel-seek';
      export * from './src/hooks/useWaveform';
      export { ScrubBar } from './src/components/ScrubBar';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^(\.\.\/store\/usePlayerStore|\.\.\/lib\/api)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
    },
  }],
  logLevel: 'silent',
});
const mod = { exports: {} };
vm.compileFunction(bundled.outputFiles[0].text, ['module', 'exports', 'require', 'globalThis'])(mod, mod.exports, require, globalThis);
const lib = mod.exports;
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const BUCKETS = 2048;
function waveform(peakAt, rmsAt = (b) => peakAt(b) * 0.6) {
  const peak = new Uint8Array(BUCKETS);
  const rms = new Uint8Array(BUCKETS);
  for (let b = 0; b < BUCKETS; b++) {
    peak[b] = peakAt(b);
    rms[b] = Math.round(rmsAt(b));
  }
  return { buckets: BUCKETS, duration: 200, peak, rms };
}
const tokens = (d) => d.split(' ');

// --- Path builder -----------------------------------------------------------------
{
  const data = waveform((b) => (b < 1024 ? 200 : 0));
  const { peak, rms } = lib.buildWaveformPaths(data);
  for (const d of [peak, rms]) {
    assert.match(d, /^M0 [\d.]+ L/, 'starts at the left edge');
    assert.match(d, / Z$/, 'is closed');
    assert.equal(d.split('L').length - 1, BUCKETS * 2 + 3, 'a point per bucket on each side plus the two edge corners');
    assert.doesNotMatch(d, /NaN|Infinity|undefined/);
  }
  // Mirrored around the middle: where it is loud the top is above 50 and the bottom below.
  const top = (b) => Number(/L1500\.5 ([\d.]+)/.exec(peak)?.[1]);
  const loudTop = Number(new RegExp(`L500\\.5 ([\\d.]+)`).exec(peak)[1]);
  assert.ok(loudTop < 45, `a loud bucket reaches above the middle (y ${loudTop})`);
  assert.equal(top(1500), 50, 'a silent bucket sits on the middle line');
  // The bottom edge of bucket 500 is the mirror of its top edge.
  const bottomMatches = [...peak.matchAll(/L500\.5 ([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(bottomMatches.length, 2, 'each bucket appears once on the top edge and once on the bottom');
  assert.ok(Math.abs(bottomMatches[0] + bottomMatches[1] - 100) < 0.21, 'and the two are mirror images');
  // The body (RMS) is inside the outline.
  const rmsTop = Number(/L500\.5 ([\d.]+)/.exec(rms)[1]);
  assert.ok(rmsTop > loudTop, 'the RMS body is smaller than the peak outline');
  assert.equal(lib.waveformPaths(data), lib.waveformPaths(data), 'built once per waveform');
}

// A quiet master is scaled up, a loud one is not, and one click does not decide the scale.
{
  const quiet = new Uint8Array(BUCKETS).fill(30);
  assert.ok(lib.waveformGain(quiet) > 6 && lib.waveformGain(quiet) < 8, `a quiet track is boosted to the cap (${lib.waveformGain(quiet)})`);
  const medium = new Uint8Array(BUCKETS).fill(100);
  assert.ok(Math.abs(medium[0] / 255 * lib.waveformGain(medium) - 0.94) < 0.01, 'a medium track fills 94% of the height');
  const loud = new Uint8Array(BUCKETS).fill(255);
  assert.ok(Math.abs(lib.waveformGain(loud) - 0.94) < 0.001, 'a loud track keeps its scale');
  const clicked = new Uint8Array(BUCKETS).fill(100);
  clicked[700] = 255;
  assert.equal(lib.waveformGain(clicked), lib.waveformGain(medium), 'a lone peak does not set the scale');
  assert.ok(Number.isFinite(lib.waveformGain(new Uint8Array(BUCKETS))), 'silence still has a finite scale');
}

{
  const ok = waveform(() => 10);
  assert.ok(lib.isWaveformData(ok));
  assert.ok(!lib.isWaveformData(null));
  assert.ok(!lib.isWaveformData({ ...ok, peak: Array.from(ok.peak) }), 'plain arrays are refused');
  assert.ok(!lib.isWaveformData({ ...ok, rms: ok.rms.subarray(1) }), 'mismatched lengths are refused');
  assert.ok(!lib.isWaveformData({ ...ok, duration: 0 }));
  assert.equal(lib.seekClock(0), '0:00');
  assert.equal(lib.seekClock(134.9), '2:14');
  assert.equal(lib.seekClock(3725), '1:02:05');
  assert.equal(lib.seekClock(-4), '0:00');
  assert.equal(lib.seekClock(NaN), '0:00');
}

// How wide a waveform is drawn against the bar: edge to edge unless the lengths disagree.
{
  assert.equal(lib.waveformScale(200, 200), 1);
  assert.equal(lib.waveformScale(203, 200), 1, 'a percent or two is within tolerance');
  assert.equal(lib.waveformScale(30.041, 30), 1, 'a VBR file a few ms long is not worth correcting');
  assert.equal(lib.waveformScale(100, 200), 0.5, 'a shorter decode ends partway along the bar');
  assert.equal(lib.waveformScale(240, 200), 1.2, 'a longer one runs past the end');
  assert.equal(lib.waveformScale(200, 1), 1, 'a bar length of 1 is the placeholder for unknown');
  assert.equal(lib.waveformScale(5, 200), 1, 'a ratio that far out is a bad length, not a bad waveform');
  assert.equal(lib.waveformScale(0, 200), 1);
  assert.equal(lib.waveformScale(200, 0), 1);
  assert.equal(lib.waveformScale(NaN, 200), 1);
}

// --- Wheel to seek -----------------------------------------------------------------------
{
  const notch = (deltaY, extra = {}) => ({ deltaY, deltaX: 0, deltaMode: 0, ...extra });
  // One click of a notched wheel is 5 seconds, up is forward.
  let seek = lib.createWheelSeek();
  assert.deepEqual(seek.handle(notch(-100), 1000, 60, 200), { consumed: true, target: 65 });
  seek = lib.createWheelSeek();
  assert.deepEqual(seek.handle(notch(100), 1000, 60, 200), { consumed: true, target: 55 });

  // Steps in one gesture build on where the last one aimed, not on the lagging playhead.
  seek = lib.createWheelSeek();
  assert.equal(seek.handle(notch(-100), 1000, 60, 200).target, 65);
  assert.equal(seek.handle(notch(-100), 1050, 60.1, 200).target, 70, 'the player has not caught up; the aim has');
  assert.equal(seek.handle(notch(-100), 1100, 60.2, 200).target, 75);
  // A pause ends the gesture and the next one starts from the live position.
  assert.equal(seek.handle(notch(-100), 2000, 90, 200).target, 95);

  // Reversing mid-gesture turns around without a leftover from the other direction.
  seek = lib.createWheelSeek();
  seek.handle(notch(-100), 1000, 60, 200);
  assert.equal(seek.handle(notch(100), 1040, 60, 200).target, 60);

  // A trackpad flick: many small events add up to whole steps.
  seek = lib.createWheelSeek();
  let position = 60;
  for (let i = 0; i < 10; i++) {
    const result = seek.handle(notch(-30), 1000 + i * 16, position, 200);
    assert.equal(result.consumed, true);
    if (result.target != null) position = result.target;
  }
  assert.equal(position, 75, `ten small events of 30px are 300px, 3 steps and the first event's step: ${position}`);

  // The first event of a gesture always moves, even if the device reports a few pixels.
  seek = lib.createWheelSeek();
  assert.equal(seek.handle(notch(-3), 1000, 60, 200).target, 65);
  assert.equal(seek.handle(notch(-3), 1016, 65, 200).target, null, 'but the tail of it adds nothing until it reaches a notch');

  // Momentum cannot carry the playhead across the song.
  seek = lib.createWheelSeek();
  position = 10;
  for (let i = 0; i < 60; i++) {
    const result = seek.handle(notch(-100), 1000 + i * 8, position, 3000);
    if (result.target != null) position = result.target;
  }
  assert.ok(position - 10 <= 5 * (lib.GESTURE_BUDGET_NOTCHES + 1 + lib.GESTURE_BUDGET_PER_S * 0.5), `a half-second flick moved ${position - 10} s`);
  assert.ok(position - 10 >= 5 * lib.GESTURE_BUDGET_NOTCHES, 'but a burst still moves its budget');
  // A long deliberate roll is not stuck: the allowance grows with time.
  seek = lib.createWheelSeek();
  position = 10;
  for (let i = 0; i < 40; i++) {
    const result = seek.handle(notch(-100), 1000 + i * 100, position, 3000);
    if (result.target != null) position = result.target;
  }
  const rolled = position - 10;
  assert.ok(rolled >= 5 * 18 && rolled <= 5 * (lib.GESTURE_BUDGET_NOTCHES + 1 + lib.GESTURE_BUDGET_PER_S * 4), `a four second roll moved ${rolled} s`);

  // Bounds: never before the start, and never onto the very end (that would skip the track).
  seek = lib.createWheelSeek();
  assert.equal(seek.handle(notch(100), 1000, 2, 200).target, 0);
  assert.equal(seek.handle(notch(100), 1040, 0, 200).target, null, 'already at the start');
  seek = lib.createWheelSeek();
  assert.equal(seek.handle(notch(-100), 1000, 198, 200).target, 199);
  assert.equal(seek.handle(notch(-100), 1040, 199, 200).target, null, 'already at the end');

  // What it leaves alone: pinch zoom, sideways swipes, nothing playing, no movement.
  seek = lib.createWheelSeek();
  assert.deepEqual(seek.handle(notch(-100, { ctrlKey: true }), 1000, 60, 200), { consumed: false, target: null });
  assert.deepEqual(seek.handle(notch(-10, { deltaX: 80 }), 1000, 60, 200), { consumed: false, target: null });
  assert.deepEqual(seek.handle(notch(-100), 1000, 0, 0), { consumed: false, target: null }, 'no duration, no seeking');
  assert.deepEqual(seek.handle(notch(0), 1000, 60, 200), { consumed: false, target: null });
  assert.deepEqual(seek.handle(notch(NaN), 1000, 60, 200), { consumed: false, target: null });
  // Lines and pages scale to pixels.
  seek = lib.createWheelSeek();
  assert.equal(seek.handle({ deltaY: -7, deltaX: 0, deltaMode: 1 }, 1000, 60, 200).target, 65, 'a few lines is a step');
}

// --- Fetching, remembering and warming ----------------------------------------------------
const track = (id, over = {}) => ({ id, path: `/music/${id}.flac`, size: 1000 + id, mtime: 5000, cueStart: null, cueEnd: null, ...over });
{
  assert.equal(lib.waveformKey(null), null);
  assert.equal(lib.waveformKey(track(0)), null, 'id 0 is not a library track');
  assert.equal(lib.waveformKey(track(-4)), null, 'podcast episodes have negative ids');
  assert.equal(lib.waveformKey(track(3, { path: 'https://example.com/a.mp3' })), null, 'streams have no waveform');
  assert.equal(lib.waveformKey(track(3, { path: 'subsonic://box/9' })), null, 'neither do server tracks');
  assert.ok(lib.waveformKey(track(3, { path: 'C:\\Music\\a.flac' })), 'a Windows drive path is a file');
  assert.equal(lib.waveformKey(track(3)), lib.waveformKey(track(3, { title: 'renamed' })), 'the key ignores tags');
  assert.notEqual(lib.waveformKey(track(3)), lib.waveformKey(track(3, { mtime: 6000 })), 'a changed file is a new key');
  assert.notEqual(lib.waveformKey(track(3)), lib.waveformKey(track(3, { cueStart: 30 })), 'a cue slice is a new key');

  const calls = [];
  let reply = () => waveform(() => 90);
  globalThis.__api = { getTrackWaveform: async (id, options) => { calls.push({ id, options }); await Promise.resolve(); return reply(id); } };

  // Two asks for one track are one round trip, and the answer is kept.
  const [one, two] = await Promise.all([lib.loadWaveform(track(1)), lib.loadWaveform(track(1))]);
  assert.ok(one && one === two);
  assert.equal(calls.length, 1, 'concurrent asks share a request');
  assert.equal(calls[0].options, undefined, 'a track needed now is not marked as a prefetch');
  assert.equal(await lib.loadWaveform(track(1)), one);
  assert.equal(calls.length, 1, 'remembered');
  assert.equal(lib.peekWaveform(lib.waveformKey(track(1))), one);

  // A miss is not remembered: the main process may have dropped it for a newer request.
  reply = () => null;
  assert.equal(await lib.loadWaveform(track(2)), null);
  assert.equal(await lib.loadWaveform(track(2)), null);
  assert.equal(calls.length, 3, 'a null is asked for again');
  reply = () => ({ buckets: 3 });
  assert.equal(await lib.loadWaveform(track(5)), null, 'a malformed answer is a miss');
  reply = () => { throw new Error('no handler'); };
  assert.equal(await lib.loadWaveform(track(6)), null, 'a rejected request is a miss');
  reply = () => waveform(() => 90);
  calls.length = 0;
  assert.equal(await lib.loadWaveform(track(7, { path: 'https://example.com/live' })), null);
  assert.equal(calls.length, 0, 'a stream never reaches the main process');

  // Prefetch asks with the flag, once, and not for what is already here.
  lib.prefetchWaveform(track(10));
  lib.prefetchWaveform(track(10));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { id: 10, options: { prefetch: true } });
  await Promise.resolve();
  await new Promise((done) => setTimeout(done, 5));
  lib.prefetchWaveform(track(10));
  lib.prefetchWaveform(track(1));
  assert.equal(calls.length, 1, 'remembered tracks are not prefetched');
  // Asking for it now while a prefetch is out sends a second, urgent, request.
  lib.prefetchWaveform(track(11));
  const needed = lib.loadWaveform(track(11));
  assert.deepEqual(calls.slice(-2).map((c) => c.options), [{ prefetch: true }, undefined]);
  await needed;

  // Only the most recent few are kept.
  for (let id = 100; id < 120; id++) await lib.loadWaveform(track(id));
  assert.equal(lib.peekWaveform(lib.waveformKey(track(100))), null, 'old ones are let go');
  assert.ok(lib.peekWaveform(lib.waveformKey(track(119))), 'recent ones are kept');
}

{
  const q = [track(1), track(2), track(3)];
  assert.equal(lib.nextQueuedTrack(q, 0, 'normal').id, 2);
  assert.equal(lib.nextQueuedTrack(q, 2, 'normal'), null, 'the last track has no next');
  assert.equal(lib.nextQueuedTrack(q, 2, 'repeat-all').id, 1, 'repeat all wraps');
  assert.equal(lib.nextQueuedTrack(q, 1, 'repeat-one').id, 2, 'repeat one stays');
  assert.equal(lib.nextQueuedTrack(q, 0, 'shuffle'), null, 'a shuffle picks at the handoff');
  assert.equal(lib.nextQueuedTrack(q, 0, 'shuffle-repeat-all'), null);
  assert.equal(lib.nextQueuedTrack(q, -1, 'normal'), null, 'nothing playing');
  assert.equal(lib.nextQueuedTrack([], 0, 'normal'), null);
}

// --- The bar -------------------------------------------------------------------------------------
{
  const current = track(42);
  const store = (over = {}) => ({
    settings: { waveformSeekBar: true },
    current,
    queue: [current, track(43)],
    index: 0,
    mode: 'normal',
    ...over,
  });
  const bar = (props = {}) => renderToStaticMarkup(createElement(lib.ScrubBar, { value: 50, max: 200, onSeek() {}, className: 'nslider block w-full', ...props }));
  globalThis.__store = store();
  globalThis.__api = { getTrackWaveform: async () => null };

  // Plain by default: decks and the fullscreen bar keep their slider.
  let html = bar();
  assert.match(html, /^<input type="range" class="nslider block w-full"/, 'a bar that did not ask for the waveform is the plain slider');
  assert.doesNotMatch(html, /wfs/);

  // The transport's bar is the one tagged data-newamp-scrub and gets the waveform without asking.
  html = bar({ 'data-newamp-scrub': true });
  assert.match(html, /<div class="wfs wfs-bar" data-state="loading"/, 'drawn as a flat line until the waveform arrives');
  assert.match(html, /<input type="range"[^>]*data-newamp-scrub="true"/, 'the slider keeps the smoke hook and is inside the frame');
  assert.match(html, /<stop class="wfs-stop-played" offset="0.25"/, 'the played part ends at a quarter');
  assert.match(html, /<stop class="wfs-stop-rest" offset="0.25"/);
  assert.match(html, /class="wfs-playhead"[^>]*style="left:25%"/, 'the playhead is a quarter in');
  assert.match(html, /--wfs-progress:0.25/);
  assert.doesNotMatch(html, /<path/, 'no waveform, no shape');
  assert.doesNotMatch(html, /wfs-tip/, 'no readout until the pointer is over the bar');

  // Opting in, in the Now Playing shape.
  html = bar({ waveform: true, waveformSize: 'overview', 'data-newamp-waveform-seek': true });
  assert.match(html, /class="wfs wfs-overview"[^>]*data-newamp-waveform-seek="true"/);
  assert.doesNotMatch(bar({ waveform: true }), /data-newamp-waveform-seek/);

  // Once the waveform is here: the shape is drawn.
  globalThis.__api = { getTrackWaveform: async () => waveform((b) => (b < 1024 ? 200 : 20)) };
  await lib.loadWaveform(current);
  html = bar({ 'data-newamp-scrub': true });
  assert.match(html, /data-state="ready"/);
  assert.match(html, /<path class="wfs-peak" d="M0 [\d.]+ L/);
  assert.match(html, /<path class="wfs-core" d="M0 [\d.]+ L/);
  assert.match(html, /fill="url\(#wfs-played-\d+\)"/, 'both shapes are filled by the played/unplayed gradient');
  const gradient = /<linearGradient id="(wfs-played-\d+)"/.exec(html)[1];
  const second = /<linearGradient id="(wfs-played-\d+)"/.exec(bar({ 'data-newamp-scrub': true }))[1];
  assert.notEqual(gradient, second, 'two bars on screen do not share a gradient');

  // The drawing keeps its place in time when the bar's length disagrees with the decode's (waveform() is 200 s).
  html = bar({ 'data-newamp-scrub': true, max: 400 });
  assert.match(html, /<g transform="scale\(0\.5 1\)"><path class="wfs-peak"/, 'a 200 s decode on a 400 s bar covers the first half');
  assert.match(html, /<stop class="wfs-stop-played" offset="0.25"/, 'and the played part is a quarter of the bar, a half of the drawing');
  assert.doesNotMatch(bar({ 'data-newamp-scrub': true }), /transform=/, 'matching lengths are drawn as they are');

  // A stream stays a flat line and says so.
  globalThis.__store = store({ current: track(44, { path: 'https://radio.example/stream' }) });
  assert.match(bar({ 'data-newamp-scrub': true }), /data-state="none"/);
  assert.doesNotMatch(bar({ 'data-newamp-scrub': true }), /<path/);

  // Settings: off gives back the plain slider and never asks for a waveform. The
  // slider sits in a layout-neutral wrapper so it is the same element either way.
  let asked = 0;
  globalThis.__api = { getTrackWaveform: async () => { asked += 1; return null; } };
  globalThis.__store = store({ settings: { waveformSeekBar: false }, current: track(45) });
  html = bar({ 'data-newamp-scrub': true });
  assert.match(html, /^<div class="wfs-off"><input type="range" class="nslider block w-full"[^>]*data-newamp-scrub="true"[^>]*><\/div>$/, 'the plain slider, untouched');
  assert.doesNotMatch(html, /class="wfs |<svg|wfs-playhead|wfs-baseline/);
  assert.equal(asked, 0);
  // A setting that was never written (older settings.json) means on.
  globalThis.__store = store({ settings: {} });
  assert.match(bar({ 'data-newamp-scrub': true }), /class="wfs wfs-bar"/);
  globalThis.__store = store({ settings: null });
  assert.match(bar({ 'data-newamp-scrub': true }), /class="wfs wfs-bar"/, 'before settings load the bar is already the waveform bar');
}

// --- In a real browser -----------------------------------------------------------------------
// ScrubBar and WaveformSeek bundled for the browser with the real React (development
// build, so its warnings show), a real zustand store and a stub IPC bridge, driven over
// the DevTools protocol.

function findBrowser() {
  const named = process.env.NEWAMP_TEST_BROWSER;
  if (named) return existsSync(named) ? named : null;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function bundleForBrowser() {
  const stubs = {
    '../store/usePlayerStore': `
      import { create } from 'zustand';
      export const usePlayerStore = create(() => ({
        settings: null,
        current: { id: 1, path: '/music/1.flac', size: 1001, mtime: 5000, cueStart: null, cueEnd: null },
        queue: [],
        index: 0,
        mode: 'normal',
      }));
      window.__store = usePlayerStore;`,
    '../lib/api': `
      window.__calls = [];
      window.__waveformReply = () => null;
      export const api = {
        getTrackWaveform: (id, options) => {
          window.__calls.push({ id, prefetch: options?.prefetch === true });
          return Promise.resolve(window.__waveformReply(id));
        },
      };`,
  };
  const result = await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ScrubBar } from './src/components/ScrubBar';
        const root = createRoot(document.getElementById('root'));
        window.__seeks = [];
        window.__render = (props = {}) => root.render(createElement(ScrubBar, {
          value: 50, max: 200, className: 'nslider block w-full', 'data-newamp-scrub': true,
          onSeek: (seconds) => window.__seeks.push(seconds), ...props,
        }));
        window.__render();
      `,
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^(\.\.\/store\/usePlayerStore|\.\.\/lib\/api)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: repoRoot }));
      },
    }],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Starts the browser headless and returns a way to run script in a blank page.
 * On Windows chrome.exe hands the work to a detached process and exits at once,
 * so the browser is found by the port it writes into its profile folder, and
 * stopped over the protocol rather than through the process that was spawned.
 */
async function openBrowserPage(executable) {
  const profile = await mkdtemp(join(tmpdir(), 'newamp-waveform-ui-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const child = spawn(executable, args, { stdio: 'ignore' });
  let startError = null;
  child.once('error', (err) => { startError = err; });
  child.once('exit', (code) => { if (code) startError = new Error(`the browser exited with code ${code}`); });

  let port = null;
  let endpoint = null;
  for (let waited = 0; !endpoint && !startError && waited < 25000; waited += 100) {
    try {
      const [first, second] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      if (first && second) {
        port = first;
        endpoint = `ws://127.0.0.1:${first}${second}`;
      }
    } catch {
      await wait(100);
    }
  }
  if (!endpoint) {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    throw startError ?? new Error('the browser did not report a DevTools port');
  }

  const socket = new WebSocket(endpoint);
  let lastId = 0;
  const pending = new Map();
  const logged = [];
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
    const id = ++lastId;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  // The browser may not answer Browser.close before it goes.
  const closeBrowser = async () => {
    const closed = new Promise((done) => { socket.onclose = done; });
    try { socket.send(JSON.stringify({ id: ++lastId, method: 'Browser.close' })); } catch { /* not connected */ }
    await Promise.race([closed, wait(5000)]);
    for (let waited = 0; waited < 10000; waited += 250) {
      const up = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
      if (!up) break;
      await wait(250);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
  };
  try {
    await new Promise((done, fail) => {
      socket.onopen = done;
      socket.onerror = () => fail(new Error('could not connect to the browser'));
    });
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id == null) {
        if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
          logged.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
        } else if (message.method === 'Runtime.exceptionThrown') {
          logged.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
        }
        return;
      }
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.fail(new Error(message.error.message));
      else waiting?.done(message.result);
    };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    return {
      logged,
      async evaluate(expression) {
        const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
        return reply.result.value;
      },
      close: closeBrowser,
    };
  } catch (err) {
    await closeBrowser();
    throw err;
  }
}

// Runs inside the page; returns what it saw.
async function driveBar() {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const store = window.__store;
  const input = () => document.querySelector('input[type="range"]');
  const sliders = () => document.querySelectorAll('input[type="range"]').length;
  const seeks = window.__seeks;
  const track = (id) => ({ id, path: `/music/${id}.flac`, size: 1000 + id, mtime: 5000, cueStart: null, cueEnd: null });
  // One notch up; the wait is longer than a gesture, so each call is a fresh one.
  const wheel = async () => {
    const before = seeks.length;
    const notCancelled = input().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    await sleep(300);
    return { moved: seeks.length - before, last: seeks[seeks.length - 1], defaultPrevented: !notCancelled };
  };
  const report = {};
  await frame();

  // Settings have not arrived yet, so the bar is drawn as the waveform bar; then they say off, then on again.
  const first = input();
  report.waveformFrame = Boolean(document.querySelector('.wfs'));
  report.before = await wheel();
  first.focus();
  store.setState({ settings: { waveformSeekBar: false } });
  await frame();
  report.off = {
    sameSlider: input() === first,
    sliders: sliders(),
    frames: document.querySelectorAll('.wfs').length,
    wrapperDisplay: getComputedStyle(document.querySelector('.wfs-off')).display,
    focusKept: document.activeElement === first,
    ...(await wheel()),
  };
  store.setState({ settings: { waveformSeekBar: true } });
  await frame();
  report.on = {
    sameSlider: input() === first,
    sliders: sliders(),
    frames: document.querySelectorAll('.wfs').length,
    focusKept: document.activeElement === first,
    ...(await wheel()),
  };

  // Resonance: the playhead's own shadow stays put; the glow beyond it is a pseudo-element's opacity.
  document.documentElement.dataset.ampReactive = 'on';
  document.documentElement.style.setProperty('--accent-glow', 'rgba(0, 255, 102, 0.5)');
  const playhead = document.querySelector('.wfs-playhead');
  const scrubWrap = document.getElementById('root');
  scrubWrap.style.setProperty('--amp-energy', '0');
  const quiet = { shadow: getComputedStyle(playhead).boxShadow, glow: getComputedStyle(playhead, '::after').opacity };
  scrubWrap.style.setProperty('--amp-energy', '0.6');
  const loud = { shadow: getComputedStyle(playhead).boxShadow, glow: getComputedStyle(playhead, '::after').opacity, glowShadow: getComputedStyle(playhead, '::after').boxShadow };
  report.resonance = { shadowSteady: quiet.shadow === loud.shadow, playheadShadow: loud.shadow, quietGlow: quiet.glow, loudGlow: loud.glow, glowShadow: loud.glowShadow };
  delete document.documentElement.dataset.ampReactive;

  // The next track is warmed ahead of time, except on the lite tier.
  window.__calls.length = 0;
  store.setState({ settings: { waveformSeekBar: true, performanceTier: 'auto' }, current: track(21), queue: [track(21), track(22)], index: 0 });
  await sleep(150);
  report.warmed = window.__calls.map((call) => `${call.id}${call.prefetch ? ' prefetch' : ''}`);
  window.__calls.length = 0;
  store.setState({ settings: { waveformSeekBar: true, performanceTier: 'lite' }, current: track(31), queue: [track(31), track(32)], index: 0 });
  await sleep(150);
  report.lite = window.__calls.map((call) => `${call.id}${call.prefetch ? ' prefetch' : ''}`);

  // A waveform that covers half the bar's length is drawn over half of it, and the played part follows.
  const bytes = (level) => new Uint8Array(2048).fill(level);
  window.__waveformReply = (id) => (id === 41 ? { buckets: 2048, duration: 100, peak: bytes(120), rms: bytes(70) } : id === 42 ? { buckets: 2048, duration: 200, peak: bytes(120), rms: bytes(70) } : null);
  const drawn = async (id) => {
    store.setState({ settings: { waveformSeekBar: true }, current: track(id), queue: [track(id)], index: 0 });
    await sleep(150);
    await frame();
    const svg = document.querySelector('.wfs-svg').getBoundingClientRect();
    const path = document.querySelector('.wfs-peak').getBoundingClientRect();
    return {
      state: document.querySelector('.wfs').dataset.state,
      width: Number((path.width / svg.width).toFixed(2)),
      left: Number(((path.left - svg.left) / svg.width).toFixed(2)),
      played: document.querySelector('.wfs-stop-played').getAttribute('offset'),
    };
  };
  report.half = await drawn(41);
  report.whole = await drawn(42);
  return report;
}

const browserPath = findBrowser();
if (!browserPath) {
  console.log('waveform-ui-test: no Chrome, Chromium or Edge found (NEWAMP_TEST_BROWSER names one); skipped the in-browser checks');
} else if (typeof WebSocket !== 'function') {
  console.log('waveform-ui-test: this Node has no WebSocket; skipped the in-browser checks');
} else {
  const script = await bundleForBrowser();
  const stylesheet = await readFile(join(repoRoot, 'src', 'styles', 'components', 'scrub.css'), 'utf8');
  const page = await openBrowserPage(browserPath);
  try {
    await page.evaluate(`
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(stylesheet)};
      document.head.append(style);
      const root = document.createElement('div');
      root.id = 'root';
      root.style.width = '400px';
      document.body.append(root);
      0`);
    await page.evaluate(script);
    const seen = await page.evaluate(`(${driveBar.toString()})()`);

    assert.equal(seen.waveformFrame, true, 'before settings load the bar is the waveform frame');
    assert.deepEqual(seen.before, { moved: 1, last: 55, defaultPrevented: true }, 'one notch of the wheel seeks 5 s and keeps the page from scrolling');

    assert.equal(seen.off.sameSlider, true, 'switching the waveform off keeps the slider element');
    assert.equal(seen.off.sliders, 1);
    assert.equal(seen.off.frames, 0, 'and drops the frame');
    assert.equal(seen.off.wrapperDisplay, 'contents', 'the wrapper that stays does not take part in layout');
    assert.equal(seen.off.focusKept, true, 'a focused slider stays focused');
    assert.deepEqual({ moved: seen.off.moved, last: seen.off.last, defaultPrevented: seen.off.defaultPrevented }, { moved: 1, last: 55, defaultPrevented: true }, 'the wheel still seeks on the plain slider');

    assert.equal(seen.on.sameSlider, true, 'switching it back on keeps the slider element too');
    assert.equal(seen.on.sliders, 1);
    assert.equal(seen.on.frames, 1);
    assert.equal(seen.on.focusKept, true);
    assert.deepEqual({ moved: seen.on.moved, last: seen.on.last, defaultPrevented: seen.on.defaultPrevented }, { moved: 1, last: 55, defaultPrevented: true }, 'and the wheel seeks again');

    assert.equal(seen.resonance.shadowSteady, true, 'the playhead shadow does not change with the music');
    assert.equal(seen.resonance.quietGlow, '0');
    assert.equal(seen.resonance.loudGlow, '0.6', 'the glow beyond it follows the energy as opacity');
    assert.match(seen.resonance.glowShadow, /12px/, 'and is a fixed shadow');
  assert.match(seen.resonance.playheadShadow, /4px/, 'the playhead keeps its own small glow');

    assert.deepEqual(seen.warmed, ['21', '22 prefetch'], 'the track on screen, then the next one');
    assert.deepEqual(seen.lite, ['31'], 'the lite tier builds only the track on screen');

    assert.equal(seen.half.state, 'ready');
    assert.ok(Math.abs(seen.half.width - 0.5) <= 0.02 && seen.half.left <= 0.01, `a 100 s waveform on a 200 s bar covers the first half (${JSON.stringify(seen.half)})`);
    assert.ok(Math.abs(Number(seen.half.played) - 0.5) <= 0.001, `a quarter of the bar is half of that drawing (${seen.half.played})`);
    assert.ok(seen.whole.width >= 0.98, `a waveform as long as the bar fills it (${JSON.stringify(seen.whole)})`);
    assert.equal(seen.whole.played, '0.25');

    assert.deepEqual(page.logged, [], 'React and the page logged no errors or warnings');
  } finally {
    await page.close();
  }
}

console.log('waveform-ui-test: ok');
