// Engine behaviour that has to hold on a real machine but can be checked
// without a GPU: what the renderers allocate and free, how they come back
// from a lost context, that a resize keeps the picture, that the drawing
// buffer stays inside its budget, that no clock or accumulator grows without
// bound or stays NaN, and that dye can drain.
//
// The GL context here is a recording fake (scripts/lib/fake-gl.mjs); what the
// shaders do with their inputs is not tested here. The last section only pins
// shader source.
// Run: node scripts/eviland-engine-resilience-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FakeCanvas, installFakeDom } from './lib/fake-gl.mjs';

mkdirSync(resolve('tmp'), { recursive: true });
const bundle = resolve('tmp/eviland-engine-resilience-bundle.mjs');
await build({
  stdin: {
    contents: `
      export { createEvilandRenderer, fitDrawingBuffer, sectionSeedFor, SHADER_TIME_WRAP } from './src/visualizer/eviland';
      export { createParticleFlowRenderer } from './src/visualizer/particle-flow';
      export { createFluidSim, clampDyeDissipation, dyeDissipationFromFrame, MAX_DYE_DISSIPATION } from './src/visualizer/eviland-fluid';
      export { createReactionDiffusion } from './src/visualizer/eviland-reaction-diffusion';
      export { createPhysarum } from './src/visualizer/eviland-physarum';
      export { watchContextLoss, holdThroughContextLoss } from './src/visualizer/eviland-gl';
      export { attachFlashGuard, createGuarded2dSurface } from './src/visualizer/flash-guard-host';
      export { defaultConfig } from './src/visualizer/eviland-operators';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: bundle, logLevel: 'silent',
});
installFakeDom();
const engine = await import(pathToFileURL(bundle).href);

const frame = (over = {}) => ({
  bands: new Float32Array(24).fill(0.3), onsets: [],
  kick: 0.2, bass: 0.3, snare: 0.1, hat: 0.1, vocal: 0.2, energy: 0.4, centroid: 0.4, flatness: 0.3, crest: 0.3,
  rolloff: 0.5, width: 0.4, pan: 0, beatPhase: 0.2, beatConfidence: 0.3, bpm: 120, novelty: 0.1,
  sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
  ...over,
});
const palette = { accent: [0.1, 0.8, 1], dark: [0.3, 0.1, 0.6], light: [1, 0.8, 0.4], bg: [0.02, 0.02, 0.05] };
const FRAME_MS = 1000 / 60;
// A program that fails to link logs why; a test that makes one fail on purpose
// does not need the noise.
const quiet = (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = original; }
};
// Rebuilding after a lost context retries on a timer. The timer is stepped by
// hand here, so a test sees each try and the delay before it.
function withTimers(body) {
  const queue = [];
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let nextId = 1;
  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++;
    queue.push({ id, fn, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const at = queue.findIndex((timer) => timer.id === id);
    if (at >= 0) queue.splice(at, 1);
  };
  const timers = {
    get pending() { return queue.length; },
    delays: () => queue.map((timer) => timer.ms),
    runNext() {
      const timer = queue.shift();
      timer?.fn();
      return Boolean(timer);
    },
  };
  try {
    return body(timers);
  } finally {
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
  }
}

function renderer(options = {}, canvasOptions = {}) {
  const canvas = new FakeCanvas(canvasOptions);
  const events = [];
  const r = engine.createEvilandRenderer(canvas, { onContextEvent: (event) => events.push(event), ...options });
  assert.ok(r, 'renderer should build on the fake context');
  return { canvas, r, events, fake: canvas.fake };
}
const run = (r, frames, over = {}, dt = FRAME_MS) => {
  for (let i = 0; i < frames; i++) r.render(frame(over), palette, dt);
};
// The newest one: a program made before a context loss is never deleted, since
// the loss took its context with it, so it still counts as alive.
const fieldProgram = (fake) => fake.find('u_membrane').at(-1);
const sourceOf = (program) => program.shaders.map((s) => s.source ?? '').join('\n');
const flowFeatures = { bass: 0.3, mid: 0.2, treble: 0.1, rms: 0.3, beat: 0, kick: 0, beatEdge: false };

// -- disposing a renderer leaves the caller's context alone -------------------
{
  const { canvas, r, fake } = renderer();
  r.resize(480, 270, 1);
  run(r, 5);
  r.dispose();
  assert.equal(fake.log.loseContext, 0, 'dispose must not lose a context the caller owns');
  assert.equal(fake.log.doubleDelete, 0);
  assert.ok(fake.log.programs.every((p) => p.deleted), 'dispose frees every program it made');

  // A second renderer on the same canvas (a quality change) gets a live context.
  const again = engine.createEvilandRenderer(canvas, { quality: 'medium' });
  assert.ok(again, 'a renderer can be made again on the same canvas');
  again.resize(480, 270, 1);
  const before = fake.log.draws.length;
  again.render(frame(), palette, FRAME_MS);
  assert.ok(fake.log.draws.length > before, 'and it draws');
  again.dispose({ releaseContext: true });
  assert.equal(fake.log.loseContext, 1, 'releaseContext gives the context up once');
}

{
  // Particle flow follows the same rule.
  const canvas = new FakeCanvas();
  const flow = engine.createParticleFlowRenderer(canvas, { particles: 4096 });
  assert.ok(flow);
  flow.resize(320, 180, 1);
  flow.render(flowFeatures, [0.2, 0.8, 1], 1 / 60);
  flow.dispose();
  assert.equal(canvas.fake.log.loseContext, 0, 'particle flow dispose leaves the context alone');
  const next = engine.createParticleFlowRenderer(canvas, { particles: 4096 });
  assert.ok(next, 'particle flow can be made again on the same canvas');
  next.dispose({ releaseContext: true });
  assert.equal(canvas.fake.log.loseContext, 1);
}

// -- a lost context is cancelled, waited out and rebuilt ----------------------
withTimers(() => {
  const { canvas, r, events, fake } = renderer();
  r.resize(480, 270, 1);
  // A look that can be told from the default by what the compose pass is given.
  const config = engine.defaultConfig();
  config.echoAlpha = { base: 0.5 };
  r.setWaveform(Uint8Array.from({ length: 256 }, (_, i) => i));
  run(r, 10);
  const echo = () => fake.find('u_liquidMix').at(-1).uniforms.u_echoAlpha ?? 0;
  assert.equal(echo(), 0, 'the default look has no echo');
  r.setConfig(config);
  run(r, 10);
  assert.ok(echo() > 0, 'the look under test does');

  const event = fake.lose();
  assert.equal(event.defaultPrevented, true, 'the loss event must be cancelled or the browser never restores the context');
  assert.deepEqual(events, ['lost']);
  const drawsWhileLost = fake.log.draws.length;
  run(r, 5);
  assert.equal(fake.log.draws.length, drawsWhileLost, 'no frames are attempted while the context is gone');
  r.resize(400, 225, 1);
  r.setWaveform(new Uint8Array(256).fill(200));

  const programs = fake.log.programs.length;
  const uploads = fake.log.calls.texSubImage2D ?? 0;
  fake.restore();
  assert.deepEqual(events, ['lost', 'restored']);
  assert.ok(fake.log.programs.length > programs, 'programs are rebuilt on the restored context');
  assert.ok((fake.log.calls.texSubImage2D ?? 0) > uploads, 'the waveform is uploaded again');
  run(r, 10);
  assert.ok(fake.log.draws.length > drawsWhileLost, 'drawing resumes');
  assert.equal(fake.log.stale, 0, 'nothing made before the loss is used after it');
  assert.equal(r.getConfig(), config, 'the wrapper reports the look it was given');
  assert.ok(echo() > 0, 'and the rebuilt renderer was given it too');
  assert.equal(canvas.width, 400, 'the latest size is applied to the restored buffer');
  const field = fake.draws(fieldProgram(fake)).at(-1);
  assert.deepEqual([field.fbo.texture.width, field.fbo.texture.height], [400, 225], 'and the new targets are that size');
  assert.equal(fake.log.loseContext, 0);

  r.dispose();
  assert.equal(fake.log.stale, 0);
});

withTimers((timers) => {
  // A restored context that cannot be built on is tried again a few times,
  // spaced out, before it is reported; it costs no frames meanwhile, and a
  // later restore still works.
  let reject = false;
  const { r, events, fake } = renderer({}, { linkFails: () => reject });
  r.resize(480, 270, 1);
  run(r, 2);
  fake.lose();
  reject = true;
  quiet(() => fake.restore());
  assert.deepEqual(events, ['lost'], 'one failed build is not the end of it');
  assert.deepEqual(timers.delays(), [250]);
  const draws = fake.log.draws.length;
  assert.doesNotThrow(() => run(r, 3));
  assert.equal(fake.log.draws.length, draws, 'no frames while there is nothing to draw with');
  quiet(() => timers.runNext());
  assert.deepEqual(events, ['lost']);
  assert.deepEqual(timers.delays(), [250], 'the second try is followed by a third');
  quiet(() => timers.runNext());
  assert.deepEqual(events, ['lost', 'failed'], 'reported after the third');
  assert.equal(timers.pending, 0, 'and not tried again on its own');
  assert.equal(fake.log.draws.length, draws);

  fake.lose();
  reject = false;
  fake.restore();
  assert.deepEqual(events, ['lost', 'failed', 'lost', 'restored']);
  run(r, 2);
  assert.ok(fake.log.draws.length > draws);
  r.dispose();
});

withTimers((timers) => {
  // The GPU can still be busy right after a restore: a later try works.
  let reject = false;
  const { r, events, fake } = renderer({}, { linkFails: () => reject });
  r.resize(480, 270, 1);
  run(r, 2);
  fake.lose();
  reject = true;
  quiet(() => fake.restore());
  reject = false;
  timers.runNext();
  assert.deepEqual(events, ['lost', 'restored'], 'rebuilt on the retry, never reported as failed');
  assert.equal(timers.pending, 0);
  const draws = fake.log.draws.length;
  run(r, 3);
  assert.ok(fake.log.draws.length > draws);
  assert.equal(fake.log.stale, 0);

  // A pending try does not outlive a second loss or a dispose.
  fake.lose();
  reject = true;
  quiet(() => fake.restore());
  assert.equal(timers.pending, 1);
  fake.lose();
  assert.equal(timers.pending, 0, 'a new loss cancels the pending try');
  quiet(() => fake.restore());
  assert.equal(timers.pending, 1);
  r.dispose();
  assert.equal(timers.pending, 0, 'dispose cancels it too');
});

withTimers((timers) => {
  // The same spacing for anything held through a loss.
  const canvas = new FakeCanvas();
  const events = [];
  let builds = 0;
  let worksAt = Infinity;
  const hold = engine.holdThroughContextLoss(canvas, { dispose() {} }, () => (++builds >= worksAt ? { dispose() {} } : null), {
    onLost: () => events.push('lost'),
    onRestored: () => events.push('restored'),
    onFailed: () => events.push('failed'),
  });
  const lose = () => canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  const restore = () => canvas.dispatchEvent(new Event('webglcontextrestored'));
  lose();
  assert.equal(hold.current(), null);
  worksAt = 3;
  restore();
  timers.runNext();
  assert.equal(hold.current(), null);
  timers.runNext();
  assert.ok(hold.current(), 'the third try builds');
  assert.equal(builds, 3);
  assert.deepEqual(events, ['lost', 'restored']);

  lose();
  worksAt = Infinity;
  restore();
  timers.runNext();
  timers.runNext();
  assert.deepEqual(events, ['lost', 'restored', 'lost', 'failed']);
  assert.equal(builds, 6);
  hold.stop();
});

withTimers((timers) => {
  const canvas = new FakeCanvas();
  const flow = engine.createParticleFlowRenderer(canvas, { particles: 4096 });
  flow.resize(320, 180, 1);
  flow.render(flowFeatures, [0.2, 0.8, 1], 1 / 60);
  assert.equal(canvas.fake.lose().defaultPrevented, true);
  const draws = canvas.fake.log.draws.length;
  flow.render(flowFeatures, [0.2, 0.8, 1], 1 / 60);
  assert.equal(canvas.fake.log.draws.length, draws);
  canvas.fake.restore();
  flow.render(flowFeatures, [0.2, 0.8, 1], 1 / 60);
  assert.ok(canvas.fake.log.draws.length > draws, 'particle flow draws again after the restore');
  assert.equal(canvas.width, 320, 'at the size it had');
  assert.equal(canvas.fake.log.stale, 0);
  assert.equal(timers.pending, 0);
  flow.dispose();
});

withTimers((timers) => {
  // The flash guard is rebuilt on the restored context and never lets a frame
  // through that it could not guard.
  globalThis.screen = { width: 1920, height: 1080 };
  let reject = false;
  const canvas = new FakeCanvas({ linkFails: () => reject });
  const gl = canvas.getContext('webgl2');
  const surface = { clientWidth: 1920, clientHeight: 1080 };
  const guard = engine.attachFlashGuard(gl, surface);
  assert.ok(guard, 'the guard attaches to the fake context');
  const fake = canvas.fake;
  fake.log.draws.length = 0;
  guard.apply(16);
  const guarded = fake.log.draws.length;
  assert.ok(guarded > 0, 'the guard draws when it is on');

  assert.equal(fake.lose().defaultPrevented, true);
  guard.apply(16);
  const programs = fake.log.programs.length;
  fake.restore();
  assert.ok(fake.log.programs.length > programs, 'the guard is rebuilt on the restored context');
  fake.log.draws.length = 0;
  guard.apply(16);
  assert.equal(fake.log.draws.length, guarded, 'and guards again');
  assert.equal(fake.log.stale, 0);

  fake.lose();
  reject = true;
  quiet(() => fake.restore());
  const clears = fake.log.calls.clear ?? 0;
  guard.apply(16);
  assert.ok((fake.log.calls.clear ?? 0) > clears, 'a guard that cannot be rebuilt blanks the frame instead of passing it through');
  reject = false;
  timers.runNext();
  fake.log.draws.length = 0;
  guard.apply(16);
  assert.equal(fake.log.draws.length, guarded, 'and guards again once a retry builds it');
  guard.dispose();
});

withTimers((timers) => {
  // The Canvas 2D painters present through the same guard: it goes with the
  // context, nothing is shown while it is gone, and a new one takes over.
  globalThis.screen = { width: 1920, height: 1080 };
  let reject = false;
  const visible = new FakeCanvas({ linkFails: () => reject });
  visible.width = 1920;
  visible.height = 1080;
  const surface = engine.createGuarded2dSurface(visible, true, true);
  assert.notEqual(surface.paint, visible, 'the painter draws offscreen when it presents through the guard');
  const fake = visible.fake;
  fake.log.draws.length = 0;
  surface.show(16);
  const presented = fake.log.draws.length;
  assert.ok(presented > 0, 'a frame is presented');

  assert.equal(fake.lose().defaultPrevented, true);
  fake.log.draws.length = 0;
  assert.doesNotThrow(() => surface.show(16));
  assert.equal(fake.log.draws.length, 0, 'nothing is presented while the context is gone');
  const programs = fake.log.programs.length;
  fake.restore();
  assert.ok(fake.log.programs.length > programs, 'the guard is rebuilt on the restored context');
  surface.show(16);
  assert.equal(fake.log.draws.length, presented, 'and presents again');
  assert.equal(fake.log.stale, 0);

  fake.lose();
  reject = true;
  quiet(() => fake.restore());
  fake.log.draws.length = 0;
  surface.show(16);
  assert.equal(fake.log.draws.length, 0, 'a guard that cannot be rebuilt shows nothing rather than an unguarded frame');
  reject = false;
  timers.runNext();
  surface.show(16);
  assert.equal(fake.log.draws.length, presented, 'until a retry builds it');
  surface.dispose();
  assert.equal(timers.pending, 0);
});

withTimers(() => {
  // Disposed while the context is out: the later restore finds nobody to rebuild.
  const { r, events, fake } = renderer();
  r.resize(480, 270, 1);
  run(r, 2);
  fake.lose();
  r.dispose();
  const programs = fake.log.programs.length;
  fake.restore();
  assert.equal(fake.log.programs.length, programs);
  assert.deepEqual(events, ['lost']);
});

// -- a resize keeps what the picture has built up -----------------------------
{
  const { r, fake } = renderer();
  const copy = 'o = texture(u_src, v_uv);';
  r.resize(480, 270, 1);
  run(r, 30);
  const fieldDraws = fake.draws(fieldProgram(fake));
  const newest = fieldDraws[fieldDraws.length - 1].fbo.texture;
  const before = fake.log.draws.length;
  r.resize(400, 225, 1);
  const copies = fake.log.draws.slice(before).filter((d) => d.program.shaders.some((s) => s.source?.includes(copy)));
  // The field itself, and the fluid's velocity and dye grids.
  assert.equal(copies.length, 3, 'newest field, velocity and dye are stretched into the new targets');
  assert.ok(copies.some((d) => d.texture === newest), 'the field copy reads the newest field, not an older one');
  for (const draw of copies) {
    assert.equal(draw.texture.deleted, true, 'the old target is freed once copied');
    assert.equal(draw.fbo.texture.deleted, false, 'the copy lands in a live target');
  }
  const fieldCopy = copies.find((d) => d.texture === newest);
  assert.equal(fieldCopy.fbo.texture.width, 400);
  assert.equal(fieldCopy.fbo.texture.height, 225);
  run(r, 3);
  assert.equal(fake.log.stale, 0);
  r.dispose();
}

{
  // The echo carries over too.
  const { r, fake } = renderer();
  const config = engine.defaultConfig();
  config.echoAlpha = { base: 0.5 };
  r.setConfig(config);
  r.resize(480, 270, 1);
  run(r, 10);
  const copy = 'o = texture(u_src, v_uv);';
  const before = fake.log.draws.length;
  r.resize(400, 225, 1);
  const copies = fake.log.draws.slice(before).filter((d) => d.program.shaders.some((s) => s.source?.includes(copy)));
  assert.equal(copies.length, 4, 'field, echo, velocity and dye');
  r.dispose();
}

// -- the drawing buffer keeps to its pixel budget -----------------------------
{
  const area = (b) => b.width * b.height;
  const high = engine.fitDrawingBuffer(3840, 2160, 2, 2, 2_500_000, 16384);
  assert.ok(area(high) <= 2_500_000 && area(high) > 2_400_000, `high tier 4K fits 2.5 MP, got ${area(high)}`);
  assert.ok(Math.abs(high.width / high.height - 16 / 9) < 0.01, 'and keeps its shape');
  assert.deepEqual(engine.fitDrawingBuffer(640, 360, 1, 2, 2_500_000, 16384), { width: 640, height: 360 }, 'small windows are untouched');
  assert.equal(engine.fitDrawingBuffer(NaN, 360, 1, 2, 2_500_000, 16384), null);
  assert.ok(engine.fitDrawingBuffer(4000, 100, 1, 2, 2_500_000, 1024).width <= 1024, 'no side beyond what the GPU allows');

  for (const [quality, budget, dpr] of [['high', 2_500_000, 2], ['medium', 1_600_000, 1.5], ['low', 800_000, 1]]) {
    const { canvas, r } = renderer({ quality });
    r.resize(3840, 2160, 2);
    assert.ok(canvas.width * canvas.height <= budget, `${quality}: ${canvas.width}x${canvas.height} exceeds ${budget}`);
    assert.ok(canvas.width * canvas.height > budget * 0.95, `${quality}: uses the budget`);
    r.dispose();
  }
  const { canvas, r } = renderer({ maxPixels: 100_000 });
  r.resize(1920, 1080, 1);
  assert.ok(canvas.width * canvas.height <= 100_000, 'maxPixels overrides the tier default');
  r.dispose();
  const small = renderer({}, { maxTextureSize: 1024 });
  small.r.resize(4000, 4000, 1);
  assert.ok(Math.max(small.canvas.width, small.canvas.height) <= 1024, 'the GPU texture limit holds');
  small.r.dispose();
}

{
  // Targets the GPU cannot allocate: retry smaller, say so once, never go blank
  // for good, retry on a timer rather than on every resize, and grow back when
  // there is room.
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    let limit = 300_000;
    const { r, fake } = renderer({}, { maxFboPixels: () => limit });
    const fieldSize = () => {
      const draw = fake.draws(fieldProgram(fake)).at(-1);
      return [draw.fbo.texture.width, draw.fbo.texture.height];
    };
    r.resize(1280, 720, 1);
    run(r, 2);
    assert.deepEqual(fieldSize(), [640, 360], 'a smaller field is drawn instead of nothing');
    assert.equal(errors.length, 1, 'the failure is reported once');

    limit = 10;
    r.resize(1000, 600, 1);
    const draws = fake.log.draws.length;
    assert.doesNotThrow(() => run(r, 3));
    assert.equal(fake.log.draws.length, draws, 'with no targets there is nothing to draw, and no crash');

    // Hosts call resize() every frame. Three seconds of that, with the GPU
    // still refusing, is a few attempts, not one per call.
    const allocations = fake.log.calls.texImage2D ?? 0;
    for (let i = 0; i < 180; i++) {
      r.resize(1000, 600, 1);
      r.render(frame(), palette, FRAME_MS);
    }
    const attempted = (fake.log.calls.texImage2D ?? 0) - allocations;
    assert.ok(attempted > 0 && attempted <= 20, `about one attempt a second while it keeps failing, saw ${attempted} allocations`);

    limit = Infinity;
    for (let i = 0; i < 90 && fake.log.draws.length === draws; i++) {
      r.resize(1000, 600, 1);
      r.render(frame(), palette, FRAME_MS);
    }
    run(r, 2);
    assert.ok(fake.log.draws.length > draws, 'a later resize recovers once the GPU has room');
    assert.deepEqual(fieldSize(), [1000, 600], 'at the full size, not the shrunk one');
    assert.equal(errors.length, 1);
    r.dispose();

    // A picture running at a reduced size grows back on the next size change
    // the GPU can take, and stays reduced while it cannot.
    limit = 300_000;
    const second = renderer({}, { maxFboPixels: () => limit });
    const secondField = () => {
      const draw = second.fake.draws(fieldProgram(second.fake)).at(-1);
      return [draw.fbo.texture.width, draw.fbo.texture.height];
    };
    second.r.resize(1280, 720, 1);
    run(second.r, 2);
    assert.deepEqual(secondField(), [640, 360]);
    second.r.resize(1290, 730, 1);
    run(second.r, 2);
    assert.deepEqual(secondField(), [645, 365], 'still reduced while the GPU refuses more');
    limit = Infinity;
    second.r.resize(1281, 721, 1);
    run(second.r, 2);
    assert.deepEqual(secondField(), [1281, 721], 'full size once it fits');
    assert.equal(second.fake.log.stale, 0);
    second.r.dispose();
  } finally {
    console.error = original;
  }
}

// -- chemistry keeps its pace at 20 fps ---------------------------------------
{
  const chemistrySteps = (frames, dtMs) => {
    const canvas = new FakeCanvas();
    const gl = canvas.getContext('webgl2');
    const sim = engine.createReactionDiffusion(gl, 3);
    assert.ok(sim);
    const target = { framebuffer: gl.createFramebuffer(), width: 64, height: 36, opacity: 0.5 };
    const feedback = gl.createTexture();
    const step = canvas.fake.find('u_init')[0];
    sim.render(frame(), palette, 0, feedback, target);
    const start = canvas.fake.draws(step).length;
    for (let i = 0; i < frames; i++) sim.render(frame(), palette, dtMs, feedback, target);
    const steps = canvas.fake.draws(step).length - start;
    sim.dispose();
    return steps;
  };
  const at60 = chemistrySteps(60, 1000 / 60);
  const at20 = chemistrySteps(20, 50);
  assert.equal(at60, 240, 'four updates per 60 Hz tick');
  assert.equal(at20, at60, 'the same chemistry per second at 20 fps');
  assert.equal(chemistrySteps(10, 100), 10 * 3 * 4, 'a longer hitch is still capped');
}

// -- no clock grows without bound ---------------------------------------------
{
  const seen = { field: 0, spectrum: 0, wrapped: false };
  let last = 0;
  const { r, fake } = renderer({}, {
    onUniform(program, name, values) {
      if (name !== 'u_time') return;
      if (program.shaders.some((s) => s.source?.includes('u_membrane'))) {
        seen.field = Math.max(seen.field, values[0]);
        if (values[0] < last) seen.wrapped = true;
        last = values[0];
      } else if (program.shaders.some((s) => s.source?.includes('u_bands'))) {
        seen.spectrum = Math.max(seen.spectrum, values[0]);
      }
    },
  });
  r.resize(320, 180, 1);
  run(r, 130_000, {}, 100); // three and a half hours of shader time
  assert.ok(seen.wrapped, 'the field clock restarts');
  assert.ok(seen.field < engine.SHADER_TIME_WRAP, `field time stays under ${engine.SHADER_TIME_WRAP}, saw ${seen.field}`);
  assert.ok(seen.spectrum > 0 && seen.spectrum < engine.SHADER_TIME_WRAP, `the spectrum sun shares the wrap, saw ${seen.spectrum}`);
  assert.ok(fake.log.draws.length > 0);

  // The restart is invisible to anything that oscillates: every fixed rate in
  // the field, morph, terrain and spectrum shaders turns a whole number of
  // times over the wrap. Only the slow noise drifts (the warp's two) move.
  const text = fake.log.programs.map(sourceOf).join('\n');
  const rates = [
    ...[...text.matchAll(/\b(?:u_)?time\s*\*\s*(\d+\.\d+)/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/(\d+\.\d+)\s*\*\s*(?:u_)?time\b/g)].map((m) => Number(m[1])),
  ];
  assert.ok(rates.length >= 12, `expected the oscillator rates in the shaders, found ${rates.length}`);
  for (const wanted of [0.07, 0.15, 3, 7.3]) assert.ok(rates.includes(wanted), `rate ${wanted} is among them`);
  const noiseDrift = new Set([0.018, 0.014]);
  for (const rate of rates) {
    if (noiseDrift.has(rate)) continue;
    const turns = (rate * engine.SHADER_TIME_WRAP) / (Math.PI * 2);
    assert.ok(Math.abs(turns - Math.round(turns)) < 1e-6, `rate ${rate} rad/s is ${turns} turns over the wrap`);
  }
  assert.equal(text.match(/\btime\s*\*\s*\(/g)?.length, 1, 'one rate is computed per cell');
  assert.match(text, /time \* \(0\.2 \+ floor\(h \* 35\.0\) \* 0\.01\)/, 'and it is in whole hundredths too');
  r.dispose();

  let flowMax = 0;
  const canvas = new FakeCanvas({ onUniform: (_p, name, values) => { if (name === 'u_time') flowMax = Math.max(flowMax, values[0]); } });
  const flow = engine.createParticleFlowRenderer(canvas, { particles: 4096 });
  flow.resize(320, 180, 1);
  for (let i = 0; i < 24_000; i++) flow.render(flowFeatures, [0.2, 0.8, 1], 0.05);
  assert.ok(flowMax < 1024 && flowMax > 100, `particle time stays under the wrap, saw ${flowMax}`);
  flow.dispose();
}

// -- one bad value does not stay ----------------------------------------------
{
  const bad = [];
  let watching = false;
  const { r } = renderer({}, {
    onUniform(program, name, values) {
      if (watching && values.some((v) => !Number.isFinite(v))) bad.push(name);
    },
  });
  r.resize(320, 180, 1);
  run(r, 20);
  watching = true;
  r.render(frame(), palette, NaN);
  run(r, 10);
  assert.deepEqual([...new Set(bad)], [], 'a NaN frame time reaches no uniform');

  // A NaN loudness: what the renderer itself keeps (its envelopes and the
  // exposure target) must come back.
  const owned = new Set(['u_bloomIntensity', 'u_targetKey', 'u_time', 'u_steps', 'u_frame', 'u_sectionSeed', 'u_aberration']);
  const poisoned = [];
  const second = renderer({}, {
    onUniform(program, name, values) {
      if (watching && owned.has(name) && values.some((v) => !Number.isFinite(v))) poisoned.push(name);
    },
  });
  second.r.resize(320, 180, 1);
  run(second.r, 20);
  second.r.render(frame({ energy: NaN, crest: NaN, snare: NaN, hat: NaN }), palette, FRAME_MS);
  run(second.r, 10);
  assert.deepEqual([...new Set(poisoned)], [], 'envelopes and exposure target recover after a NaN frame');
  r.dispose();
  second.r.dispose();
}

{
  const bad = [];
  const canvas = new FakeCanvas({ onUniform: (_p, name, values) => { if (values.some((v) => !Number.isFinite(v))) bad.push(name); } });
  const gl = canvas.getContext('webgl2');
  const sim = engine.createFluidSim(gl, { width: 64, height: 36, pressureIterations: 4 });
  assert.ok(sim);
  const nanForce = { x: NaN, y: 0.5, dx: 1, dy: 1, radius: 0.1, color: [1, 1, 1], dye: 1 };
  sim.step(NaN, [nanForce], { vorticity: NaN, dissipation: NaN, dyeDissipation: NaN });
  sim.step(1 / 60, [{ x: 0.5, y: 0.5, dx: 1, dy: 1, radius: 0.1, color: [NaN, 1, 1], dye: 1 }], { vorticity: 5, dissipation: 0.985 });
  assert.deepEqual([...new Set(bad)], [], 'the solver never uploads a NaN');
  sim.dispose();
}

{
  // The small simulations pick up again after a NaN frame time.
  const canvas = new FakeCanvas();
  const gl = canvas.getContext('webgl2');
  const target = { framebuffer: gl.createFramebuffer(), width: 64, height: 36, opacity: 0.5 };
  const feedback = gl.createTexture();
  const chemistry = engine.createReactionDiffusion(gl, 1);
  const mould = engine.createPhysarum(gl, 1, 'low');
  assert.ok(chemistry && mould);
  const step = canvas.fake.find('u_init')[0];
  const move = canvas.fake.find('u_sprout')[0];
  for (const sim of [chemistry, mould]) {
    sim.render(frame(), palette, 16.7, feedback, target);
    sim.render(frame({ energy: NaN }), palette, NaN, feedback, target);
  }
  const chemistryBefore = canvas.fake.draws(step).length;
  const mouldBefore = canvas.fake.draws(move).length;
  for (let i = 0; i < 20; i++) {
    chemistry.render(frame(), palette, 1000 / 60, feedback, target);
    mould.render(frame(), palette, 1000 / 60, feedback, target);
  }
  assert.ok(canvas.fake.draws(step).length > chemistryBefore + 40, 'chemistry still steps');
  assert.ok(canvas.fake.draws(move).length > mouldBefore + 10, 'the mould still moves');
  chemistry.dispose();
  mould.dispose();
}

// -- dye drains instead of piling up ------------------------------------------
{
  const { clampDyeDissipation, dyeDissipationFromFrame, MAX_DYE_DISSIPATION } = engine;
  assert.ok(MAX_DYE_DISSIPATION < 1);
  assert.equal(clampDyeDissipation(1), MAX_DYE_DISSIPATION);
  assert.equal(clampDyeDissipation(1.05), MAX_DYE_DISSIPATION);
  assert.equal(clampDyeDissipation(0.2), 0.6);
  assert.equal(clampDyeDissipation(NaN), 0.6);
  assert.equal(clampDyeDissipation(0.95), 0.95);

  // Every energy and every bias a look can add (operators clamp it to
  // -0.4..0.06): the dye mass a steady splat builds is the same after ten
  // minutes as after one, within a factor of two.
  let worst = 0;
  for (let e = 0; e <= 1.0001; e += 0.05) {
    for (let bias = -0.4; bias <= 0.0601; bias += 0.02) {
      const d = clampDyeDissipation(dyeDissipationFromFrame(frame({ energy: e })) + bias);
      let mass = 0;
      let atMinute = 0;
      for (let step = 1; step <= 60 * 600; step++) {
        mass = mass * d + 1;
        if (step === 60 * 60) atMinute = mass;
      }
      worst = Math.max(worst, mass / atMinute);
    }
  }
  assert.ok(worst <= 2, `dye mass at 10 minutes is at most twice that at one, got ${worst.toFixed(3)}x`);
  // Left at 1 (the old clamp), it grows tenfold over the same span.
  let old = 0;
  let oldMinute = 0;
  for (let step = 1; step <= 60 * 600; step++) { old = old * 1 + 1; if (step === 3600) oldMinute = old; }
  assert.ok(old / oldMinute >= 9.9);

  // The solver applies the cap whatever its caller passes.
  const canvas = new FakeCanvas();
  const gl = canvas.getContext('webgl2');
  const sim = engine.createFluidSim(gl, { width: 64, height: 36, pressureIterations: 2 });
  sim.step(1 / 60, [], { vorticity: 1, dissipation: 0.985, dyeDissipation: 1 });
  const dyeAdvect = canvas.fake.find('texture(u_dye, coord)')[0];
  assert.ok(dyeAdvect.uniforms.u_dissipation <= MAX_DYE_DISSIPATION + 1e-9, `dye advect saw ${dyeAdvect.uniforms.u_dissipation}`);
  sim.dispose();
}

// -- section seeds are 0..1 ---------------------------------------------------
{
  const seeds = Array.from({ length: 31 }, (_, id) => engine.sectionSeedFor(id));
  assert.ok(seeds.every((s) => s >= 0 && s < 1), 'seed stays in [0, 1) for sections 0..30');
  assert.ok(new Set(seeds).size >= 28, 'and still tells sections apart');
  assert.equal(engine.sectionSeedFor(7), engine.sectionSeedFor(7));
  assert.ok(engine.sectionSeedFor(-3) >= 0 && engine.sectionSeedFor(NaN) >= 0);

  // Through the renderer: the base rotation a section adds no longer climbs.
  const config = engine.defaultConfig();
  config.rotate = { base: 0 };
  const { r, fake } = renderer();
  r.setConfig(config);
  r.resize(320, 180, 1);
  const field = fieldProgram(fake);
  let largest = 0;
  let warpMin = Infinity;
  let warpMax = 0;
  for (let id = 0; id <= 30; id++) {
    r.render(frame({ sectionId: id, sectionChanged: true }), palette, FRAME_MS);
    largest = Math.max(largest, Math.abs(field.uniforms['u_w[0].rotate']));
    warpMin = Math.min(warpMin, field.uniforms.u_sectionSeed);
    warpMax = Math.max(warpMax, field.uniforms.u_sectionSeed);
  }
  assert.ok(largest <= 0.0028 + 1e-9, `section rotation base stays within 0.0028 rad/frame, saw ${largest}`);
  assert.ok(warpMax - warpMin > 8, 'the field warp offset keeps its full spread');
  r.dispose();
}

// -- the hue rotation in the feedback holds its peak --------------------------
{
  // A port of rotateHue() in FIELD_FRAG, with and without the peak hold.
  const rotate = (c, angle, hold) => {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const i = 0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2];
    const q = 0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2];
    const i2 = cos * i - sin * q, q2 = sin * i + cos * q;
    let out = [y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2];
    if (!hold) return out;
    out = out.map((v) => Math.max(v, 0));
    const was = Math.max(0, ...c), now = Math.max(...out);
    return out.map((v) => v * (was / Math.max(now, 1e-4)));
  };
  const trail = (hold) => {
    let c = [1, 0, 0];
    let peak = 0, floor = 0;
    for (let step = 0; step < 100; step++) {
      c = rotate(c, 1.57 / 100, hold).map((v) => v * 0.99);
      peak = Math.max(peak, ...c);
      floor = Math.min(floor, ...c);
    }
    return { peak, floor };
  };
  const held = trail(true);
  assert.ok(held.peak <= 1 + 1e-9, `a red field rotated through 90 degrees never gains peak, got ${held.peak}`);
  assert.ok(held.floor >= 0, 'and leaves no negative lobes');
  const loose = trail(false);
  assert.ok(loose.floor < 0, 'without the hold the same trail goes negative');
}

// -- the dither follows elapsed time, not the number of renders ---------------
{
  const framesSeen = (fps, seconds) => {
    const seen = [];
    const { r } = renderer({}, { onUniform: (_p, name, values) => { if (name === 'u_frame') seen.push(values[0]); } });
    r.resize(320, 180, 1);
    run(r, Math.round(fps * seconds), {}, 1000 / fps);
    r.dispose();
    return seen;
  };
  const at60 = framesSeen(60, 1);
  assert.equal(new Set(at60).size, at60.length, 'the pattern changes on every frame at 60 fps');
  assert.equal(framesSeen(30, 2).at(-1), framesSeen(120, 2).at(-1), 'two seconds at 30 and at 120 fps end on the same pattern');
  const at240 = framesSeen(240, 1);
  assert.equal(at240.length, 240);
  assert.ok(new Set(at240).size <= 61, 'and past 60 fps it holds for several frames');
}

// -- Source pins --------------------------------------------------------------
// These match the shader text. A GPU decides what the shaders draw; the pins
// are there so a later edit cannot quietly undo what was decided, and they say
// nothing about the picture itself.
{
  const frames = [];
  const { r, fake } = renderer({}, {
    onUniform(program, name, values) {
      if (name === 'u_frame') frames.push(values[0]);
    },
  });
  r.resize(320, 180, 1);
  run(r, 4);
  const post = fake.find('u_bloomIntensity')[0];
  const compose = fake.find('u_liquidMix')[0];
  const field = fieldProgram(fake);
  const threshold = fake.find('u_threshold')[0];
  const expose = fake.find('u_targetKey')[0];
  const meter = fake.find('u_cell')[0];
  assert.ok(post && compose && field && threshold && expose && meter);
  const source = sourceOf;

  // Dither that moves, fades out only below two 8-bit levels, and a ground
  // added under the picture instead of multiplied into its dark end.
  assert.equal(new Set(frames).size, frames.length, `the dither pattern changes every frame, saw ${frames}`);
  assert.match(source(post), /uint\(u_frame\)/);
  assert.match(source(post), /smoothstep\(0\.0, 2\.0 \/ 255\.0, max\(colour\.r, max\(colour\.g, colour\.b\)\)\)/);
  assert.match(source(post), /colour \+= u_bg \* 0\.12 \* \(1\.0 - smoothstep\(0\.0, 0\.08, light\)\)/);
  assert.doesNotMatch(source(post), /mix\(u_bg \* 0\.12, colour/);

  // Nothing is uploaded that no shader reads.
  assert.doesNotMatch(source(post), /u_hueShift/);
  assert.doesNotMatch(source(compose), /u_accent|u_dark|u_light/);
  assert.equal(post.uniforms.u_hueShift, undefined);
  assert.equal(compose.uniforms.u_accent, undefined);

  // The bloom knee sits near the top of the exposed range, so a frame of
  // ordinary structure does not get a blurred copy of itself on top.
  assert.equal(threshold.uniforms.u_threshold, 0.6);
  assert.match(source(threshold), /smoothstep\(u_threshold, u_threshold \+ 0\.35, b\)/);
  const bloom = post.uniforms.u_bloomIntensity;
  assert.ok(bloom >= 0.18 && bloom < 0.6, `bloom intensity at moderate energy, saw ${bloom}`);

  // Only the hottest pixels move toward their peak, before the shoulder.
  const shoulder = source(post).indexOf('exp(-peak * 1.35)');
  const hot = source(post).indexOf('mix(colour, vec3(peak), smoothstep(1.3, 4.0, peak) * 0.65)');
  assert.ok(hot > 0 && shoulder > hot, 'hot pixels give up colour toward white ahead of the tone-map shoulder');

  // The transition front's direction comes from sampling it, not from
  // derivatives that hold one value per 2x2 quad; chroma flow is weighted by
  // relative chroma so a bright near-grey pixel does not pick a random hue.
  assert.doesNotMatch(source(field), /dFd[xy]\(/);
  assert.match(source(field), /length\(iq\) \/ max\(luma\(c\), 0\.05\)/);

  // What feeds back is scrubbed, and the exposure state cannot stay bad.
  assert.match(source(field), /o = vec4\(settle\(prev\), 1\.0\)/);
  assert.match(source(expose), /if \(notNumber\(prev\) \|\| prev <= 0\.0 \|\| prev >= 64\.0\)/);
  r.dispose();
}

{
  // A NaN is found by its bits. How a comparison with NaN behaves is left open
  // by GLSL ES 3.00, and a compiler may fold a test that depends on it away.
  const canvas = new FakeCanvas();
  const gl = canvas.getContext('webgl2');
  const { r, fake: rendererFake } = renderer();
  r.resize(320, 180, 1);
  run(r, 2);
  const target = { framebuffer: gl.createFramebuffer(), width: 64, height: 36, opacity: 0.5 };
  const sims = [
    engine.createFluidSim(gl, { width: 64, height: 36, pressureIterations: 2 }),
    engine.createReactionDiffusion(gl, 1),
    engine.createPhysarum(gl, 1, 'low'),
  ];
  const flowCanvas = new FakeCanvas();
  const flow = engine.createParticleFlowRenderer(flowCanvas, { particles: 4096 });
  flow.resize(320, 180, 1);
  const marked = [
    ...rendererFake.find('u_membrane'), ...rendererFake.find('u_liquidMix'), ...rendererFake.find('u_bloomIntensity'),
    ...rendererFake.find('u_targetKey'), ...rendererFake.find('u_cell'),
    ...canvas.fake.find('finite2('), ...canvas.fake.find('u_init'), ...canvas.fake.find('u_sprout'), ...canvas.fake.find('u_diffuse'),
    ...flowCanvas.fake.find('u_burst'),
  ];
  assert.ok(marked.length >= 10, `expected the scrubbing programs, found ${marked.length}`);
  for (const program of marked) {
    const text = sourceOf(program);
    assert.match(text, /floatBitsToUint\(x\)/, `${text.split('\n')[1] ?? 'program'} tests the bits`);
    assert.match(text, /notNumber\(/);
    assert.doesNotMatch(text, /x >= 0\.0 \? min\(x, /, 'no scrub left that relies on NaN comparing false');
  }
  r.dispose();
  flow.dispose();
  for (const sim of sims) sim?.dispose();
}

console.log('[eviland-engine-resilience-test] PASS');
