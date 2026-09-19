// Browser-side half of `npm run bench:eviland-switch` (eviland-switch-bench.mjs).
// Times the work that lands on the frame where Eviland changes look:
//   engine  first draw of each scene (shader compile + link) vs a cached draw
//   live    Butterchurn loadPreset for real presets, and the frames after it
// Each measurement ends with gl.finish() so GPU-side compile time counts.
import butterchurn from 'butterchurn';
import butterchurnPresets from 'butterchurn-presets';
import { createEvilandRenderer } from '../src/visualizer/eviland';
import { SCENES } from '../src/visualizer/scenes/index';
import { generate } from '../src/visualizer/eviland-randomizer';
import { resolveEvilandPalette } from '../src/visualizer/eviland-appearance';
import { syntheticFrame } from './eviland-visual-probe';

const W = 1280;
const H = 720;

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: values.length,
    median: +pick(0.5).toFixed(1),
    p90: +pick(0.9).toFixed(1),
    max: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
  };
}

async function engine() {
  const canvas = document.createElement('canvas');
  // smoke:true for a deterministic, readable canvas — but NOT its synchronous
  // compiles: this bench exists to measure the path the app actually runs.
  // Pass syncCompile to compare the two.
  const renderer = createEvilandRenderer(canvas, {
    quality: 'high',
    smoke: true,
    seed: 'switch-bench',
    syncCompile: new URLSearchParams(location.search).get('sync-compile') === '1',
  });
  if (!renderer) throw new Error('WebGL2 renderer unavailable');
  renderer.resize(W, H, 1);
  const gl = canvas.getContext('webgl2')!;
  const palette = resolveEvilandPalette('theme', generate('switch-bench', 'nebula').config.palette!);
  const wave = new Uint8Array(256).fill(128);
  renderer.setWaveform(wave);
  let step = 0;
  const frameMs = (): number => {
    const t0 = performance.now();
    renderer.render(syntheticFrame(step / 60, step, 60), palette, 1000 / 60, 'host');
    gl.finish();
    step += 1;
    return performance.now() - t0;
  };
  for (let i = 0; i < 10; i++) frameMs();
  // Worst frame in the 20 after switching to each scene for the first time
  // (compiles may finish a few frames after the switch), then the same
  // switch again once everything is compiled.
  // Paced like the real loop (45 fps): background compiles get the wall-clock
  // time between frames that they would have in the app.
  const worstAfter = async (): Promise<number> => {
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      worst = Math.max(worst, frameMs());
      await new Promise((r) => setTimeout(r, 22));
    }
    return worst;
  };
  const first: number[] = [];
  const cached: number[] = [];
  const perScene: Record<string, number> = {};
  const configs = SCENES.map((scene) => {
    const config = generate(`switch-bench-${scene.id}`, 'nebula').config;
    config.composition = { ...(config.composition ?? {}), scene: scene.id } as typeof config.composition;
    return { id: scene.id, config };
  });
  for (const { id, config } of configs) {
    renderer.setConfig(structuredClone(config));
    const ms = await worstAfter();
    first.push(ms);
    perScene[id] = +ms.toFixed(1);
  }
  for (const { config } of configs) {
    renderer.setConfig(structuredClone(config));
    cached.push(await worstAfter());
  }
  renderer.dispose();
  return { scenes: SCENES.length, firstUseWorstFrame: stats(first), cachedWorstFrame: stats(cached), perScene };
}

async function live() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const context = new OfflineAudioContext(1, 48000, 48000);
  const factory = ((butterchurn as unknown as { default?: unknown }).default ?? butterchurn) as {
    createVisualizer(ctx: BaseAudioContext, c: HTMLCanvasElement, opts: unknown): {
      loadPreset(preset: unknown, blend: number): void;
      render(opts?: unknown): void;
      renderer: { gl: WebGL2RenderingContext };
    };
  };
  const bc = factory.createVisualizer(context, canvas, { width: W, height: H });
  const gl = bc.renderer.gl;
  const presetsModule = (butterchurnPresets as unknown as { default?: unknown }).default ?? butterchurnPresets;
  const catalog = (presetsModule as { getPresets(): Record<string, unknown> }).getPresets();
  const entries = Object.entries(catalog);
  // Split loadPreset into GL compile/status time and equation compiling.
  const split = { gl: 0, fn: 0, total: 0 };
  const glTarget = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter', 'getUniformLocation', 'getAttribLocation']) {
    const original = glTarget[name]!.bind(gl);
    glTarget[name] = (...args: unknown[]) => {
      const t0 = performance.now();
      try { return original(...args); } finally { split.gl += performance.now() - t0; }
    };
  }
  const NativeFunction = window.Function;
  const TimedFunction = function (this: unknown, ...args: string[]) {
    const t0 = performance.now();
    try { return new NativeFunction(...args); } finally { split.fn += performance.now() - t0; }
  } as unknown as FunctionConstructor;
  const load: number[] = [];
  const afterLoad: number[] = [];
  const steady: number[] = [];
  const renderMs = (): number => {
    const t0 = performance.now();
    bc.render({ audioLevels: { timeByteArray: new Uint8Array(1024).fill(128), timeByteArrayL: new Uint8Array(1024).fill(128), timeByteArrayR: new Uint8Array(1024).fill(128) } });
    gl.finish();
    return performance.now() - t0;
  };
  // Every 7th preset in catalog order: a spread of light and heavy ones.
  const sample = entries.filter((_, i) => i % 7 === 0).slice(0, 40);
  bc.loadPreset(sample[0]![1], 0);
  for (let i = 0; i < 20; i++) renderMs();
  for (const [, preset] of sample) {
    for (let i = 0; i < 5; i++) steady.push(renderMs());
    const t0 = performance.now();
    (window as unknown as { Function: FunctionConstructor }).Function = TimedFunction;
    bc.loadPreset(preset, 2);
    gl.finish();
    (window as unknown as { Function: FunctionConstructor }).Function = NativeFunction;
    load.push(performance.now() - t0);
    split.total += performance.now() - t0;
    afterLoad.push(renderMs());
  }
  const share = (v: number) => `${((100 * v) / split.total).toFixed(0)}%`;
  return {
    presets: sample.length,
    loadPreset: stats(load),
    loadPresetSplit: { glCompileAndQueries: share(split.gl), equationFunctions: share(split.fn) },
    firstFrameAfter: stats(afterLoad),
    steadyFrame: stats(steady),
  };
}

(window as unknown as { __evilandSwitchBench: unknown }).__evilandSwitchBench = { engine, live };
