// Browser-side half of `npm run test:eviland-live` (see eviland-visual-test.mjs).
// Drives the REAL Butterchurn renderer with the Eviland Live pipeline attached
// and checks the claims the pipeline exists to make, on pixels:
//   - our sources land in MilkDrop's feedback texture, not just on screen
//   - they persist and keep moving after the source is removed (feedback)
//   - reactor events alone (no scene, no fluid) reach the feedback
//   - the selected palette owns the final image
//   - sample() sees the composed frame (the occluded-projector smoke path)
//   - a renderer resize leaves no GL error behind
// Every GL call is wrapped to throw on the first GL error, so shared-state
// leaks between Butterchurn and the pipeline fail loudly.
import butterchurn from 'butterchurn';
import { createEvilandLivePipeline, type MilkdropFeedbackHost } from '../src/visualizer/eviland-live-pipeline';
import { generate } from '../src/visualizer/eviland-randomizer';
import { resolveEvilandPalette } from '../src/visualizer/eviland-appearance';
import type { CompositionConfig } from '../src/visualizer/eviland-operators';
import { syntheticFrame } from './eviland-visual-probe';

const W = 240;
const H = 160;

interface ProbeVisualizer {
  renderer: MilkdropFeedbackHost;
  loadPreset(preset: unknown, blendSeconds: number): void;
  render(opts: unknown): void;
  setRendererSize(width: number, height: number): void;
}

function throwOnGlError(gl: WebGL2RenderingContext): void {
  const getError = gl.getError.bind(gl);
  const target = gl as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(WebGL2RenderingContext.prototype)) {
    if (name === 'constructor' || name === 'getError' || name === 'isContextLost') continue;
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = function (...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(gl, args);
      const error = getError();
      if (error) throw new Error(`GL ${name} error ${error} args=${args.map((value) => String(value)).join(',')}`);
      return result;
    };
  }
}

async function live() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const context = new OfflineAudioContext(1, 48000, 48000);
  const factory = ((butterchurn as unknown as { default?: unknown }).default ?? butterchurn) as {
    createVisualizer(ctx: BaseAudioContext, canvas: HTMLCanvasElement, opts: unknown): ProbeVisualizer;
  };
  const bc = factory.createVisualizer(context, canvas, { width: W, height: H, meshWidth: 12, meshHeight: 8 });
  const host = bc.renderer;
  const gl = host.gl;
  throwOnGlError(gl);

  const api = createEvilandLivePipeline(bc, 'high');
  if (!api) throw new Error('Live pipeline refused this Butterchurn build (private renderer shape changed?)');

  // A bare preset: slow zoom + rotation, no shapes or waves of its own, so
  // anything lit in the feedback came from an Eviland source.
  const bare = {
    baseVals: { decay: 0.97, wave_a: 0, zoom: 1.01, rot: 0.004 },
    shapes: [], waves: [], init_eqs_str: '', frame_eqs_str: '', pixel_eqs_str: '', warp: '', comp: '',
  };
  bc.loadPreset(bare, 0);

  const config = generate('live-probe', 'nebula').config;
  config.fluid = { base: 0.5 };
  config.liquidMix = { base: 0 };
  const palette = resolveEvilandPalette('ice', config.palette!);
  const wave = new Uint8Array(1024);
  for (let i = 0; i < wave.length; i++) wave[i] = 128 + Math.round(Math.sin(i * 0.1) * 65);

  let step = 0;
  const render = (frames: number): void => {
    for (let n = 0; n < frames; n++, step++) {
      api.update({ frame: syntheticFrame(step / 60, step, 60), palette, config, seed: 'live-probe', waveMode: 'off' });
      api.advance(1000 / 60);
      bc.render({ elapsedTime: 1 / 60, audioLevels: { timeByteArray: wave, timeByteArrayL: wave, timeByteArrayR: wave } });
    }
  };
  const read = (fbo: WebGLFramebuffer | null, w: number, h: number): Uint8Array => {
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const readFeedback = (): Uint8Array => read(host.targetFrameBuffer, host.texsizeX, host.texsizeY);
  const lit = (px: Uint8Array): number => {
    let count = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i]!, px[i + 1]!, px[i + 2]!) > 12) count++;
    return count / (px.length / 4);
  };
  const silent: CompositionConfig = { scene: null, terrain: false, spectrum: false, emitters: 'off', density: 0, contrast: 1 };

  // 1. Scene + fluid + events enter the feedback, and the screen shows them.
  render(24);
  const output = read(null, W, H);
  const field = readFeedback();
  const snapshot = canvas.toDataURL();
  const sampled = api.sample();
  if (lit(field) < 0.01) throw new Error('Sources were displayed without entering MilkDrop feedback');
  if (sampled < 0.01) throw new Error(`sample() reads an empty composition (${sampled}) while the screen is lit (${lit(output)})`);

  // 2. Remove every source: the preset's own feedback must keep a visible,
  // still-transforming history of what we drew.
  config.composition = silent;
  config.fluid = { base: 0 };
  render(6);
  const trails = readFeedback();
  if (lit(trails) < 0.005) throw new Error(`Custom source has no native feedback persistence: first=${lit(field)} trail=${lit(trails)}`);
  let changed = 0;
  for (let i = 0; i < field.length; i++) changed += Math.abs(field[i]! - trails[i]!);
  if (changed < 100) throw new Error('Feedback is frozen');

  // 3. The palette owns the final image (ice is blue-dominant).
  let red = 0;
  let blue = 0;
  for (let i = 0; i < output.length; i += 4) {
    red += output[i]!;
    blue += output[i + 2]!;
  }
  if (blue <= red * 1.4) throw new Error('Final composite bypasses the selected Ice palette');

  // 4. Reactor events alone reach the feedback. Let the field settle first:
  // an 8-bit feedback at decay 0.97 never reaches black (v * 0.97 rounds back
  // to v below ~17), so compare mean brightness against that settled floor
  // rather than counting lit pixels.
  const mean = (px: Uint8Array): number => {
    let total = 0;
    for (let i = 0; i < px.length; i += 4) total += Math.max(px[i]!, px[i + 1]!, px[i + 2]!);
    return total / (px.length / 4);
  };
  render(240);
  const settled = mean(readFeedback());
  config.composition = { ...silent, emitters: 'bands' };
  render(40);
  const events = mean(readFeedback());
  if (events < settled + 1) throw new Error(`Reactor events never reached the feedback: settled=${settled} events=${events}`);

  // 5. A renderer-size change must not leak a framebuffer/VAO into Butterchurn.
  bc.setRendererSize(200, 120);
  render(2);
  const resizeError = gl.getError();
  if (resizeError) throw new Error(`Shared GL state error after resize: ${resizeError}`);

  api.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    fieldLit: lit(field),
    trailsLit: lit(trails),
    outputLit: lit(output),
    sampledLit: sampled,
    settledMean: settled,
    eventsMean: events,
    blueRedRatio: blue / Math.max(1, red),
    resizeError,
    snapshot,
  };
}

(window as unknown as { __evilandLiveProbe: typeof live }).__evilandLiveProbe = live;
