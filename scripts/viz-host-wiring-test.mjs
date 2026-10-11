// The pieces the on-screen visualizer, the projector and the producer share:
// the wait before a lost GPU context sends a surface to the 2D fallback, the
// next-look and previous-look requests, the album-sleeve palette through a
// Director fade, the 2D picture itself, and what crosses to the projector
// (beat clock, accent). The component wiring that cannot run without Electron
// is pinned as source.
// Run: node scripts/viz-host-wiring-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp/viz-host-wiring-test');
mkdirSync(root, { recursive: true });
const bundle = async (name, contents) => {
  const outfile = resolve(root, `${name}.mjs`);
  await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
};
const source = (path) => readFileSync(resolve(path), 'utf8');

// ── Context loss: wait, then fall back ──────────────────────────────────────
{
  const { watchContextFallback, CONTEXT_RESTORE_GRACE_MS } = await bundle('context', `export * from './src/visualizer/context-fallback';`);
  assert.equal(CONTEXT_RESTORE_GRACE_MS, 3000);
  const clock = () => {
    let now = 0;
    let next = 1;
    const pending = new Map();
    return {
      timers: {
        set: (fn, ms) => { const id = next++; pending.set(id, { fn, at: now + ms }); return id; },
        clear: (id) => { pending.delete(id); },
      },
      advance(ms) {
        now += ms;
        for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.fn(); }
      },
      get waiting() { return pending.size; },
    };
  };
  const make = (graceMs) => {
    const time = clock();
    const calls = [];
    const watch = watchContextFallback(() => calls.push('fallback'), graceMs, time.timers);
    return { time, calls, watch };
  };

  let t = make();
  t.watch.onEvent('lost');
  t.time.advance(2999);
  assert.deepEqual(t.calls, [], 'nothing before the wait is over');
  t.time.advance(1);
  assert.deepEqual(t.calls, ['fallback'], 'the wait ends in the fallback');
  assert.equal(t.watch.fellBack, true);
  t.watch.onEvent('lost');
  t.watch.onEvent('failed');
  t.time.advance(10000);
  assert.deepEqual(t.calls, ['fallback'], 'and only once');

  t = make();
  t.watch.onEvent('lost');
  t.time.advance(2999);
  t.watch.onEvent('restored');
  t.time.advance(10000);
  assert.deepEqual(t.calls, [], 'a restore in time cancels the wait');
  assert.equal(t.time.waiting, 0);
  t.watch.onEvent('lost');
  t.time.advance(3000);
  assert.deepEqual(t.calls, ['fallback'], 'a later loss starts a new wait');

  t = make();
  t.watch.onEvent('lost');
  t.watch.onEvent('lost');
  assert.equal(t.time.waiting, 1, 'two losses in a row are one wait');
  t.watch.onEvent('failed');
  assert.deepEqual(t.calls, ['fallback'], 'a context that could not be rebuilt falls back at once');
  assert.equal(t.time.waiting, 0);

  t = make();
  t.watch.onEvent('lost');
  t.watch.dispose();
  t.time.advance(10000);
  t.watch.onEvent('failed');
  assert.deepEqual(t.calls, [], 'a disposed watch never calls back');

  t = make(500);
  t.watch.onEvent('lost');
  t.time.advance(500);
  assert.deepEqual(t.calls, ['fallback'], 'the wait is a parameter');
}

// ── Next look and previous look ─────────────────────────────────────────────
{
  const requests = await bundle('looks', `export * from './src/visualizer/look-requests';`);
  const director = () => {
    const calls = [];
    return { calls, skip: () => calls.push('skip'), previous: () => { calls.push('previous'); return true; } };
  };
  requests.requestLookSkip();
  const early = requests.createLookRequestCursor();
  const d = director();
  early.drain(d, true);
  assert.deepEqual(d.calls, [], 'a host that starts after a request never replays it');

  requests.requestLookSkip();
  requests.requestLookSkip();
  requests.requestLookSkip();
  early.drain(d, true);
  assert.deepEqual(d.calls, ['skip'], 'several skips in a frame are one fresh look');
  early.drain(d, true);
  assert.deepEqual(d.calls, ['skip'], 'and are taken once');

  requests.requestLookBack();
  requests.requestLookBack();
  early.drain(d, true);
  assert.deepEqual(d.calls, ['skip', 'previous', 'previous'], 'each press steps back one look');

  // Two hosts each get their own copy of a request.
  const a = requests.createLookRequestCursor();
  const b = requests.createLookRequestCursor();
  requests.requestLookSkip();
  const da = director();
  const db = director();
  a.drain(da, true);
  b.drain(db, true);
  assert.deepEqual([da.calls, db.calls], [['skip'], ['skip']]);

  // A Director that is not driving drops requests instead of keeping them.
  const off = requests.createLookRequestCursor();
  requests.requestLookSkip();
  requests.requestLookBack();
  const dOff = director();
  off.drain(dOff, false);
  off.drain(dOff, true);
  assert.deepEqual(dOff.calls, [], 'a skip pressed during a manual look does not fire when the Director comes back');

  // Back stops at the start of the history.
  const edge = requests.createLookRequestCursor();
  for (let i = 0; i < 6; i++) requests.requestLookBack();
  let left = 2;
  const history = { skip() {}, previous: () => left-- > 0 };
  edge.drain(history, true);
  assert.equal(left, -1, 'it asked until the history ran out, and no further');
}

// ── The sleeve through a Director fade ──────────────────────────────────────
{
  const appearance = await bundle('appearance', `
    export { resolveEvilandPalette, sleeveFor, blendThemeWithSleeve, rgbToOklch } from './src/visualizer/eviland-appearance';
    export { generate } from './src/visualizer/eviland-randomizer';
  `);
  const { resolveEvilandPalette, sleeveFor, generate } = appearance;
  const art = { vibrant: [0.9, 0.1, 0.12], secondary: [0.95, 0.7, 0.6], muted: [0.35, 0.08, 0.1] };
  const theme = { bg: [0.02, 0.02, 0.04], dark: [0.1, 0.3, 0.6], accent: [0.2, 0.5, 1], light: [0.8, 0.9, 1] };

  // Which looks follow the cover is a yes or no per look: find one of each.
  const follows = (config) => resolveEvilandPalette('look', config.palette, 0, 0, config.palette, { art, seed: config.seed }) !== config.palette;
  let follower = null;
  let free = null;
  for (let i = 1; i < 200 && !(follower && free); i++) {
    const config = generate(i * 7919 + 13).config;
    if (follows(config)) follower ??= config;
    else free ??= config;
  }
  assert.ok(follower && free, 'half the looks follow the cover');
  assert.equal(resolveEvilandPalette('look', free.palette, 0, 0, free.palette, { art: null, seed: free.seed }), free.palette, 'no cover, no change');

  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const lerpPalette = (a, b, t) => ({ bg: mix(a.bg, b.bg, t), dark: mix(a.dark, b.dark, t), accent: mix(a.accent, b.accent, t), light: mix(a.light, b.light, t) });
  const widest = (p, q) => Math.max(...['bg', 'dark', 'accent', 'light'].flatMap((role) => p[role].map((v, i) => Math.abs(v - q[role][i]))));
  const STEPS = 200;

  function walkFade(from, to, paletteFor) {
    let previous = null;
    let worst = 0;
    for (let k = 0; k <= STEPS; k++) {
      const t = k / STEPS;
      const live = {
        ...from, seed: t < 0.5 ? from.seed : to.seed, palette: lerpPalette(from.palette, to.palette, t),
        _from: from, _to: to, _transition: t,
      };
      const palette = paletteFor(live, t);
      if (previous) worst = Math.max(worst, widest(previous, palette));
      previous = palette;
    }
    return worst;
  }
  const sleeve = { art: null, seed: '' };
  for (const [from, to, label] of [[follower, free, 'follower to free'], [free, follower, 'free to follower']]) {
    const aware = walkFade(from, to, (live) => resolveEvilandPalette('look', live.palette, 0, 0, live.palette, sleeveFor(live, art, sleeve)));
    // What the unwired call did: the decision flips with the seed halfway through.
    const naive = walkFade(from, to, (live) => resolveEvilandPalette('look', live.palette, 0, 0, live.palette, { art, seed: live.seed }));
    assert.ok(naive > 0.12, `${label}: the seed flip should step the palette (worst step ${naive.toFixed(3)})`);
    assert.ok(aware < naive / 2, `${label}: the fade-aware sleeve steps ${aware.toFixed(3)}, the naive one ${naive.toFixed(3)}`);
    assert.ok(aware < 0.1, `${label}: worst step ${aware.toFixed(3)} per ${1 / STEPS} of the fade`);
  }

  // The ends of a fade are the looks themselves.
  const resting = (config) => resolveEvilandPalette('look', config.palette, 0, 0, config.palette, sleeveFor(config, art, sleeve));
  const startLive = { ...follower, _from: follower, _to: free, _transition: 0 };
  const endLive = { ...free, _from: follower, _to: free, _transition: 0.999999 };
  assert.ok(widest(resolveEvilandPalette('look', follower.palette, 0, 0, follower.palette, sleeveFor(startLive, art, sleeve)), resting(follower)) < 1e-9, 'a fade begins on the look it leaves');
  assert.ok(widest(resolveEvilandPalette('look', free.palette, 0, 0, free.palette, sleeveFor(endLive, art, sleeve)), resting(free)) < 1e-4, 'and ends on the look it reaches');
  // A fade that has finished (or no fade) reads the look's own seed.
  assert.equal(sleeveFor({ ...free, _transition: 1 }, art, sleeve).fade, null);
  assert.equal(sleeveFor(follower, art, sleeve).seed, follower.seed);

  // Theme mode takes the cover in whatever the look is doing.
  const themed = resolveEvilandPalette('theme', theme, 0, 0, null, sleeveFor(follower, art, sleeve));
  assert.deepEqual(themed, appearance.blendThemeWithSleeve(theme, art));
}

// ── The 2D picture ──────────────────────────────────────────────────────────
{
  const { drawFrameFallback } = await bundle('fallback', `export { drawFrameFallback } from './src/visualizer/frame-fallback';`);
  const calls = [];
  const gradient = { addColorStop: (...args) => calls.push(['stop', ...args]) };
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    beginPath: () => calls.push(['beginPath']),
    arc: (...args) => calls.push(['arc', ...args]),
    stroke: () => calls.push(['stroke']),
    createRadialGradient: (...args) => { calls.push(['gradient', ...args]); return gradient; },
  };
  const palette = { bg: [0.01, 0.01, 0.03], dark: [0.1, 0.1, 0.4], accent: [0.9, 0.2, 0.3], light: [1.4, 0.9, 0.9] };
  const frame = (over = {}) => ({ bands: new Float32Array(24).map((_, i) => (i % 5) / 5), energy: 0.6, kick: 0.7, bass: 0.5, ...over });
  drawFrameFallback(ctx, 1280, 720, frame(), palette, 1234);
  assert.ok(calls.filter((c) => c[0] === 'fillRect').length >= 26, 'background, glow and one bar per band');
  assert.ok(calls.some((c) => c[0] === 'arc'), 'the kick ring');
  calls.length = 0;
  drawFrameFallback(ctx, 1280, 720, frame({ energy: NaN, kick: Infinity, bass: undefined, bands: new Float32Array(24).fill(NaN) }), palette, NaN);
  for (const call of calls) {
    for (const arg of call.slice(1)) assert.ok(typeof arg !== 'number' || Number.isFinite(arg), `${call[0]} got ${arg}`);
  }
  assert.match(ctx.fillStyle, /^rgba?\(/, 'colours are written as rgb()');
  assert.doesNotMatch(String(ctx.fillStyle), /NaN|undefined/);
  drawFrameFallback(ctx, 1280, 720, frame({ bands: new Float32Array(0) }), palette, 0);
}

// ── What crosses to the projector ───────────────────────────────────────────
{
  const { frameBus } = await bundle('bus', `export { frameBus } from './src/visualizer/frame-bus';`);
  const { tuneEvilandFrame } = await bundle('tune', `export { tuneEvilandFrame } from './src/visualizer/eviland-appearance';`);
  const received = [];
  // Messages cross a port by structured clone, so the fake port clones.
  const port = { onmessage: null, onmessageerror: null, start() {}, close() {}, postMessage: (message) => received.push(structuredClone(message)) };
  frameBus.attachDetachedPort(port);
  const frame = {
    bands: new Float32Array(24).fill(0.4), onsets: [{ band: 1, group: 'kick', intensity: 0.8, sharpness: 0.6 }],
    kick: 0.5, bass: 0.4, snare: 0.2, hat: 0.2, vocal: 0.2, energy: 0.6, centroid: 0.5, flatness: 0.9, noisiness: 0.5, crest: 0.4, rolloff: 0.5, width: 0.3, pan: 0,
    beatPhase: 0.5, beatConfidence: 0.8, bpm: 120, beatClock: 37.5, novelty: 0, sectionId: 2, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
  };
  const palette = { bg: [0, 0, 0], dark: [0.1, 0.1, 0.1], accent: [1, 0, 0], light: [1, 1, 1] };
  const transport = { title: 'T', artist: 'A', album: 'B', currentTime: 12, duration: 200, isPlaying: true, volume: 0.8, accent: '#ff8800' };
  for (const reactivity of ['truth', 'punch', 'wild']) {
    received.length = 0;
    frameBus.publish(tuneEvilandFrame(frame, reactivity), palette, 33, undefined, { transport });
    assert.equal(received.length, 1);
    assert.equal(received[0].frame.beatClock, 37.5, `${reactivity}: the beat clock reaches the projector`);
    assert.equal(received[0].frame.noisiness, 0.5);
    assert.equal(received[0].transport.accent, '#ff8800', `${reactivity}: and so does the skin accent`);
  }
  received.length = 0;
  frameBus.publish(frame, palette, 33, undefined, { transport: null });
  assert.equal(received[0].transport, null, 'idle is still an explicit null');
  frameBus.detachPort();
}

// ── Wiring that needs Electron to run ───────────────────────────────────────
{
  const visualizer = source('src/components/Visualizer.tsx');
  assert.match(visualizer, /createEvilandRenderer\(canvas, \{ quality: evilandQuality, smoke, onContextEvent: contextWatch\.onEvent \}\)/, 'the on-screen renderer reports its context');
  assert.match(visualizer, /watchContextFallback\(\(\) => setFellBackFrom\(surfaceKey\)\)/);
  assert.match(visualizer, /key=\{`\$\{surfaceKey\}\$\{glFellBack \? '-2d' : ''\}`\}/, 'the fallback gets a canvas that never held WebGL (twice: both layouts)');
  assert.equal((visualizer.match(/glFellBack \? '-2d'/g) ?? []).length, 2);
  assert.doesNotMatch(visualizer, /blendPaletteWithArt/, 'the cover joins through the sleeve, not a pre-blended theme');
  assert.equal((visualizer.match(/sleeveFor\(/g) ?? []).length, 2, 'on-screen Eviland and Live both pass the sleeve');
  assert.match(visualizer, /createLookRequestCursor\(\)/);
  assert.match(visualizer, /lookRequests\.drain\(liveDirector, ui\.director\)/);
  assert.match(visualizer, /lookRequests\.drain\(director, true\)/);

  const producer = source('src/visualizer/eviland-producer.ts');
  assert.doesNotMatch(producer, /blendPaletteWithArt\(/);
  assert.match(producer, /config\.palette, sleeveFor\(config, artPalette, sleeve\)\)/);
  assert.match(producer, /lookRequests\?\.drain\(director, ui\.director\)/);
  assert.match(producer, /accent\?: string \| null;/, 'the transport type carries the accent');
  assert.match(source('src/visualizer/frame-bus.ts'), /accent\?: string \| null;/);

  const app = source('src/App.tsx');
  assert.match(app, /accent: currentSkinAccent\(\),/, 'the producer is handed the skin accent');
  assert.match(app, /now - skinAccent\.at >= ACCENT_READ_MS/, 'read a couple of times a second, not every tick');

  const detached = source('src/detached/main.tsx');
  assert.equal((detached.match(/onContextEvent: watchRendererContext\(\)/g) ?? []).length, 2, 'both ways the projector makes a renderer');
  assert.match(detached, /postBcConfig\(\{ sampleRate: lastSampleRate \}\)/);
  assert.match(detached, /postBcConfig\(\{ quality: next, dpr: dprCap\(\) \}\)/);
  assert.match(detached, /postBcConfig\(\{ dpr: dprCap\(\) \}\)/);
  assert.match(detached, /playing: payload\.transport \?/, 'MilkDrop is told whether a track is playing');
  assert.match(detached, /projectorKeyAction\(event, hostPlatform\)/, 'the projector reads chords the way the main window does (scripts/projector-keys-test.mjs runs the rules)');
  assert.match(source('src/detached/projector-keys.ts'), /resolvePlayerShortcut\(\{/);
  assert.match(detached, /action === 'volume-up' \|\| action === 'volume-down'/);
}

console.log(JSON.stringify({ ok: true }, null, 2));
