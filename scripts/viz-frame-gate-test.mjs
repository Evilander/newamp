// The visualizer frame gate and the paced loop built on it.
//
// Animation frames arrive on vsync, so a 22.2 ms (45 fps) target compared with
// the elapsed time rejects every 16.7 ms frame on a 60 Hz display and paints
// at 30 fps; a 33.3 ms target sits on the two-vsync boundary and judders. The
// gate books frames from a schedule and takes them up to half a refresh early.
// The loop around it sleeps on a timer instead of waking at every vsync.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let nonce = 0;
async function loadPacedFrame() {
  const out = await build({
    // A distinct export per load: an identical bundle is the same module to Node,
    // and the module keeps the display refresh it measured.
    stdin: { contents: `export * from './src/lib/pacedFrame'; export const instance = ${nonce++};`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const gateModule = await loadPacedFrame();
const { createCadenceGate, estimateRefreshMs, AMBIENT_FRAME_MS: GRID } = gateModule;

// ── Gate against a display ───────────────────────────────────────────────────
let seed = 3;
const jitterOf = (amount) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 4294967296 - 0.5) * 2 * amount; };

function runGate({ hz, interval, seconds = 20, jitter = 0.1 }) {
  const period = 1000 / hz;
  const gate = createCadenceGate(interval, { refreshMs: () => period });
  const paints = [];
  for (let i = 1; i * period < seconds * 1000; i += 1) {
    const now = i * period + jitterOf(jitter);
    if (gate.due(now)) { gate.commit(now); paints.push(now); }
  }
  const gaps = paints.slice(1).map((t, i) => t - paints[i]);
  const fps = (paints.length - 1) / ((paints.at(-1) - paints[0]) / 1000);
  return { fps, gaps, spread: Math.max(...gaps) - Math.min(...gaps) };
}

// What the gate used to do: reject while the time since the last paint is
// under the interval.
function runOldGate({ hz, interval, seconds = 20 }) {
  const period = 1000 / hz;
  let last = 0, count = 0;
  for (let i = 1; i * period < seconds * 1000; i += 1) {
    const now = i * period;
    if (now - last < interval) continue;
    last = now; count += 1;
  }
  return count / seconds;
}
assert.ok(Math.abs(runOldGate({ hz: 60, interval: 1000 / 45 }) - 30) < 0.5, 'the old gate paints 30 fps for a 45 fps target at 60 Hz');
assert.ok(runOldGate({ hz: 144, interval: 1000 / 45 }) < 37, 'and about 36 at 144 Hz');

for (const hz of [59.94, 60, 60.05, 120, 144, 165]) {
  for (const target of [45, 30]) {
    const r = runGate({ hz, interval: 1000 / target });
    assert.ok(Math.abs(r.fps - target) < 0.5, `${hz} Hz, ${target} fps target: painted ${r.fps.toFixed(2)} fps`);
  }
}
// A 30 fps target lands on whole vsyncs at 60 and 120 Hz: one gap, no 33/50 mix.
for (const hz of [59.94, 60, 60.05, 120]) {
  const r = runGate({ hz, interval: 1000 / 30 });
  assert.ok(r.spread < 1.5, `${hz} Hz, 30 fps: gaps vary by ${r.spread.toFixed(2)} ms`);
}
// 45 fps on 60 Hz alternates one and two vsyncs; never anything else.
{
  const r = runGate({ hz: 60, interval: 1000 / 45 });
  for (const gap of r.gaps) assert.ok(Math.abs(gap - 16.67) < 1 || Math.abs(gap - 33.33) < 1, `unexpected gap ${gap.toFixed(2)} ms`);
}
// A full-rate target is not slowed down.
assert.ok(Math.abs(runGate({ hz: 60, interval: 1000 / 60 }).fps - 60) < 0.7);

// The Auto-Pilot governor stretches the interval while the loop runs.
{
  const period = 1000 / 60;
  let interval = 1000 / 45;
  const gate = createCadenceGate(() => interval, { refreshMs: () => period });
  const painted = [];
  for (let i = 1; i * period < 20000; i += 1) {
    const now = i * period;
    if (i * period > 10000) interval = (1000 / 45) * 1.5;
    if (gate.due(now)) { gate.commit(now); painted.push(now); }
  }
  const rate = (from, to) => painted.filter((t) => t >= from && t < to).length / ((to - from) / 1000);
  assert.ok(Math.abs(rate(1000, 10000) - 45) < 1, `before the trim: ${rate(1000, 10000)}`);
  assert.ok(Math.abs(rate(11000, 20000) - 30) < 1, `after the trim: ${rate(11000, 20000)}`);
}

// A stall does not turn into a burst of catch-up frames.
{
  const period = 1000 / 60;
  const gate = createCadenceGate(1000 / 30, { refreshMs: () => period });
  const painted = [];
  for (let i = 1; i * period < 12000; i += 1) {
    const now = i * period;
    if (now > 5000 && now < 8000) continue; // hidden window: no frames
    if (gate.due(now)) { gate.commit(now); painted.push(now); }
  }
  const after = painted.filter((t) => t >= 8000);
  assert.ok(after[1] - after[0] >= 1000 / 30 - 1, `the frame after a stall followed too closely (${(after[1] - after[0]).toFixed(1)} ms)`);
}

// On the grid, a stall does not turn into a burst either, and a frame booked for
// a slot is taken at that slot.
{
  const period = 1000 / 120;
  const gate = createCadenceGate(1000 / 30, { refreshMs: () => period, slackMs: 6, gridMs: GRID });
  const painted = [];
  for (let i = 1; i * period < 12000; i += 1) {
    const now = i * period;
    if (now > 5000 && now < 8000) continue;
    if (gate.due(now)) { gate.commit(now); painted.push(now); }
  }
  const after = painted.filter((t) => t >= 8000);
  assert.ok(after[1] - after[0] >= GRID - 1, `the frame after a stall followed too closely (${(after[1] - after[0]).toFixed(1)} ms)`);
  const rate = painted.filter((t) => t > 1000 && t <= 5000).length / 4;
  assert.ok(Math.abs(rate - 30) < 0.5, `${rate} paints a second on the grid`);
}

// msUntilDue and due agree.
{
  const gate = createCadenceGate(1000 / 30, { refreshMs: () => 1000 / 60 });
  gate.commit(100);
  assert.equal(gate.due(100 + 16), false);
  assert.ok(gate.msUntilDue(100 + 16) > 0);
  assert.equal(gate.due(100 + gate.msUntilDue(100 + 16) + 16), true);
  assert.equal(gate.msUntilDue(100 + 40), 0);
}

// The refresh interval is read from the smallest plausible gap.
assert.ok(Math.abs(estimateRefreshMs(Array.from({ length: 30 }, (_, i) => i * 6.944)) - 6.944) < 0.001);
assert.equal(estimateRefreshMs([0, 16.7, 33.4]), null, 'too few samples to trust');
assert.ok(Math.abs(estimateRefreshMs([...Array.from({ length: 12 }, (_, i) => i * 16.7), 400, 416.7, 433.4]) - 16.7) < 0.01, 'a stall is not a refresh');

// ── A fake page: display, timers, visibility ────────────────────────────────
function createPage({ hz }) {
  const period = 1000 / hz;
  const page = {
    T: 0, hz, period, starved: false, hidden: false, stride: 1,
    queue: [], seq: 0, nextId: 1, rafCallbacks: 0,
    live: new Map(),
  };
  const push = (at, kind, fn, extra = {}) => {
    const id = page.nextId++;
    const event = { at, order: page.seq++, kind, fn, id, ...extra };
    page.queue.push(event);
    page.live.set(id, event);
    return id;
  };
  globalThis.performance = { now: () => page.T };
  globalThis.window = {
    setTimeout: (fn, ms) => push(page.T + Math.max(1, ms), 'timer', fn),
    clearTimeout: (id) => { page.live.delete(id); },
    setInterval: (fn, ms) => push(page.T + ms, 'interval', fn, { every: ms }),
    clearInterval: (id) => { page.live.delete(id); },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { get hidden() { return page.hidden; }, get visibilityState() { return page.hidden ? 'hidden' : 'visible'; } },
  });
  // The next vsync strictly after now; the epsilon keeps a timestamp that sits
  // on a vsync from rounding back onto it.
  // A busy main thread (stride 2) misses every other vsync.
  const nextVsync = () => (Math.floor(page.T / (period * page.stride) + 1e-9) + 1) * period * page.stride;
  globalThis.requestAnimationFrame = (fn) => {
    const at = nextVsync();
    // Starved or hidden: the request waits for a frame that does not come.
    return push(page.starved || page.hidden ? Infinity : at, 'raf', fn);
  };
  globalThis.cancelAnimationFrame = (id) => { page.live.delete(id); };
  page.run = (until) => {
    for (;;) {
      page.queue = page.queue.filter((e) => page.live.has(e.id));
      page.queue.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = page.queue.find((e) => e.at <= until);
      if (!next) break;
      page.T = next.at;
      if (next.kind === 'interval') next.at += next.every; // keeps its id
      else page.live.delete(next.id);
      if (next.kind === 'raf') { page.rafCallbacks += 1; next.fn(page.T); } else next.fn();
    }
    page.T = until;
  };
  // Frames resume: every request that was waiting is delivered at the next vsync.
  page.resume = () => {
    page.starved = false;
    for (const e of page.queue) if (e.kind === 'raf' && e.at === Infinity) e.at = nextVsync();
  };
  return page;
}

async function startLoop(page, { target = 45, rescue = false, render = () => {}, slackMs = 0, snapToGrid = false } = {}) {
  const mod = await loadPacedFrame();
  const interval = 1000 / target;
  const cadence = mod.createCadenceGate(interval, {
    refreshMs: () => page.period,
    slackMs,
    gridMs: snapToGrid ? mod.AMBIENT_FRAME_MS : undefined,
  });
  const renders = [];
  const gate = Object.assign(
    (now) => { if (!cadence.due(now)) return false; cadence.commit(now); return true; },
    { msUntilDue: (now) => cadence.msUntilDue(now) },
  );
  const stop = mod.startPacedLoop(gate, (now) => { renders.push(now); return render(now); }, { retryMs: interval, rescue, snapToGrid });
  return { renders, stop, mod };
}
const perSecond = (page, count, seconds) => count / seconds;

// ── The loop wakes about as often as it paints ──────────────────────────────
for (const hz of [60, 120, 144, 165]) {
  const page = createPage({ hz });
  const loop = await startLoop(page, { target: 45 });
  page.run(10_000);
  const paints = loop.renders.length / 10;
  assert.ok(Math.abs(paints - 45) < 1.5, `${hz} Hz: painted ${paints} fps`);
  const wakes = page.rafCallbacks / 10;
  // A bare rAF loop wakes at the display rate (144 or 165 per second).
  assert.ok(wakes < paints * 1.6, `${hz} Hz: ${wakes} animation frames a second for ${paints} paints`);
  loop.stop();
}

// ── A busy main thread while the display is measured ────────────────────────
assert.equal(
  estimateRefreshMs([0, 10, 43.3, 76.6, 109.9, 143.2, 176.5, 209.8, 243.1, 276.4]),
  null,
  'one short gap among long ones is a catch-up frame, not a refresh',
);
{
  // Every gap of the first probe is stretched to two refreshes.
  const page = createPage({ hz: 60 });
  const mod = await loadPacedFrame();
  page.stride = 2;
  mod.measureDisplayRefresh();
  page.run(2000);
  assert.ok(Math.abs(mod.displayRefreshMs() - 1000 / 60) < 0.01, `a slow probe alone is not believed (${mod.displayRefreshMs()})`);
  // The thread recovers; the probe is repeated soon, not after a minute.
  page.stride = 1;
  page.run(5000);
  mod.measureDisplayRefresh();
  page.run(7000);
  assert.ok(Math.abs(mod.displayRefreshMs() - 1000 / 60) < 0.01, `the repeat reads the real refresh (${mod.displayRefreshMs()})`);
}
{
  // The same slow reading twice is a slow display.
  const page = createPage({ hz: 60 });
  const mod = await loadPacedFrame();
  page.stride = 2;
  mod.measureDisplayRefresh();
  page.run(2000);
  page.run(5000);
  mod.measureDisplayRefresh();
  page.run(8000);
  assert.ok(Math.abs(mod.displayRefreshMs() - 1000 / 30) < 0.01, `two slow probes agree (${mod.displayRefreshMs()})`);
}
{
  // A window moved to another display is believed at once.
  const page = createPage({ hz: 144 });
  const mod = await loadPacedFrame();
  mod.measureDisplayRefresh();
  page.run(1000);
  assert.ok(Math.abs(mod.displayRefreshMs() - 1000 / 144) < 0.01, 'a faster display is taken on the first probe');
  const slower = createPage({ hz: 60 });
  slower.T = page.T;
  mod.measureDisplayRefresh(true);
  slower.run(page.T + 2000);
  assert.ok(Math.abs(mod.displayRefreshMs() - 1000 / 60) < 0.01, `a forced probe adopts the slower display (${mod.displayRefreshMs()})`);
}

// ── Loops on the shared 30 Hz grid ──────────────────────────────────────────
// The 2D painters and Resonance wake together on a 30 Hz grid. A loop that
// starts at any phase of the display must settle onto the grid with one
// animation frame per paint, at every refresh rate.
for (const hz of [60, 120, 144, 165]) {
  for (const startAt of [0, 2, 4, 6, 8, 10, 12, 14, 18, 22, 26, 30]) {
    const page = createPage({ hz });
    page.run(startAt);
    const loop = await startLoop(page, { target: 30, slackMs: gateModule.PACED_FRAME_SLACK_MS, snapToGrid: true });
    page.run(startAt + 2000);
    const paintedBefore = loop.renders.length;
    const wakesBefore = page.rafCallbacks;
    page.run(startAt + 12_000);
    const paints = loop.renders.length - paintedBefore;
    const wakes = page.rafCallbacks - wakesBefore;
    const label = `${hz} Hz, started ${startAt} ms into a frame`;
    assert.ok(Math.abs(paints / 10 - 30) < 0.6, `${label}: ${paints / 10} paints a second`);
    assert.ok(wakes <= paints * 1.2, `${label}: ${wakes} animation frames for ${paints} paints`);
    // Each paint is the first vsync after the wake-up, which leads its grid
    // slot by a few milliseconds.
    const lead = Math.min(6, Math.max(2, page.period * 0.35));
    for (const t of loop.renders.slice(-paints)) {
      const offset = ((t + GRID / 2) % GRID) - GRID / 2;
      assert.ok(offset > -lead - 0.5 && offset < page.period - lead + 0.5, `${label}: a paint ${offset.toFixed(2)} ms off the grid slot`);
    }
    loop.stop();
  }
}

// A throw in render does not end the loop.
{
  const page = createPage({ hz: 60 });
  let calls = 0;
  const loop = await startLoop(page, {
    target: 30,
    render: () => { calls += 1; if (calls === 3) throw new Error('boom'); },
  });
  const errors = [];
  // The throw surfaces from the animation frame; swallow it like the page would.
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => raf((t) => { try { fn(t); } catch (e) { errors.push(e); } });
  page.run(1000);
  loop.stop();
  assert.ok(calls > 10, `the loop stopped after the throw (${calls} calls)`);
  assert.equal(errors.length, 1);
  globalThis.requestAnimationFrame = raf;
}

// A render that asks to rest sleeps for that long.
{
  const page = createPage({ hz: 60 });
  const loop = await startLoop(page, { target: 30, render: () => 400 });
  page.run(4000);
  loop.stop();
  const rate = loop.renders.length / 4;
  assert.ok(rate > 2 && rate < 3, `a resting loop wakes every 400 ms (${rate}/s)`);
}

// ── Animation frames stop while the page is still visible ───────────────────
{
  const page = createPage({ hz: 60 });
  const loop = await startLoop(page, { target: 45, rescue: true });
  page.run(2000);
  const before = loop.renders.length;
  assert.ok(before > 80, `warm-up: ${before} paints in 2 s`);

  page.starved = true;
  // The animation frame the loop was waiting for never arrives.
  page.queue.forEach((e) => { if (e.kind === 'raf') e.at = Infinity; });
  page.run(8000);
  const starvedPaints = loop.renders.filter((t) => t > 3000 && t <= 8000).length;
  assert.ok(starvedPaints >= 10 && starvedPaints <= 25, `rescue should draw a few frames a second, got ${starvedPaints} in 5 s`);

  page.resume();
  page.run(12_000);
  const resumed = loop.renders.filter((t) => t > 10_000 && t <= 12_000).length;
  assert.ok(resumed > 80 && resumed < 100, `back on animation frames: ${resumed} paints in 2 s`);
  loop.stop();
}

// An animation frame's timestamp is when its frame began, earlier than the
// performance.now() the rescue timer passes; the loop's clock never steps back
// between the two.
{
  const page = createPage({ hz: 60 });
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => raf((t) => fn(t - 20));
  const mod = await loadPacedFrame();
  const always = Object.assign(() => true, { msUntilDue: () => 0 });
  const times = [];
  const stop = mod.startPacedLoop(always, (now) => { times.push(now); return 16; }, { retryMs: 16, rescue: true });
  page.run(1500);
  page.starved = true;
  page.queue.forEach((e) => { if (e.kind === 'raf') e.at = Infinity; });
  const mark = times.length;
  while (times.length === mark) page.run(page.T + 5);
  page.resume();
  page.run(page.T + 1000);
  stop();
  globalThis.requestAnimationFrame = raf;
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] >= times[i - 1], `the loop clock stepped back ${(times[i - 1] - times[i]).toFixed(1)} ms at render ${i}`);
}

// A hidden page is left alone: the rescue is for a window that is shown.
{
  const page = createPage({ hz: 60 });
  const loop = await startLoop(page, { target: 45, rescue: true });
  page.run(1500);
  page.hidden = true;
  page.queue.forEach((e) => { if (e.kind === 'raf') e.at = Infinity; });
  const mark = loop.renders.length;
  page.run(8000);
  assert.equal(loop.renders.length, mark, 'no frames are drawn for a hidden page');
  loop.stop();
}

// Without the rescue a starved loop simply stops, as a bare rAF loop does
// (this is the GPU path: submitting GL to a window the compositor is not
// presenting blocks the renderer).
{
  const page = createPage({ hz: 60 });
  const loop = await startLoop(page, { target: 45, rescue: false });
  page.run(1500);
  page.starved = true;
  page.queue.forEach((e) => { if (e.kind === 'raf') e.at = Infinity; });
  const mark = loop.renders.length;
  page.run(8000);
  assert.equal(loop.renders.length, mark);
  loop.stop();
}

// stop() leaves nothing booked.
{
  const page = createPage({ hz: 60 });
  const loop = await startLoop(page, { target: 45, rescue: true });
  page.run(500);
  loop.stop();
  const mark = loop.renders.length;
  page.run(3000);
  assert.equal(loop.renders.length, mark);
  assert.equal(page.live.size, 0, 'timers or frames left behind');
}

console.log('[viz-frame-gate-test] PASS');
