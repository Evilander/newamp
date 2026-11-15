// Browser-side half of scripts/eviland-live-highlight-test.mjs. The Live grade
// evens luminance across hues, which must not dim the brightest pixels: a
// preset that composites pure white, graded onto a white-light palette, has to
// come out near white, and the same white graded onto a deep blue palette has
// to stay at its full colour rather than being boosted past it. Also that a
// look's stereoSpread reaches the Live fluid, as it reaches the engine's.
import butterchurn from 'butterchurn';
import { createEvilandLivePipeline, type MilkdropFeedbackHost } from '../src/visualizer/eviland-live-pipeline';
import { generate } from '../src/visualizer/eviland-randomizer';
import type { CompositionConfig, PaletteConfig } from '../src/visualizer/eviland-operators';
import { syntheticFrame } from './eviland-visual-probe';

const W = 64;
const H = 48;
// The brightest channel a white-light palette may fall short of 255 by. The
// grade, gain and dither add a level or two; the flat cut this guards against
// held it at about 204.
const WHITE_PEAK_MIN = 246;

interface ProbeVisualizer {
  renderer: MilkdropFeedbackHost;
  loadPreset(preset: unknown, blendSeconds: number): void;
  render(opts: unknown): void;
}

// A preset whose composite is flat white: peak 1 everywhere, so the grade's
// highlight handling is the only thing between it and the screen.
const WHITE_PRESET = {
  baseVals: { decay: 0.9, wave_a: 0 },
  shapes: [], waves: [], init_eqs_str: '', frame_eqs_str: '', pixel_eqs_str: '', warp: '',
  comp: 'shader_body {\n  ret = vec3(1.0, 1.0, 1.0);\n}',
};

function brightest(gl: WebGL2RenderingContext): { peak: number; mean: number } {
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let peak = 0;
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const channel = Math.max(px[i]!, px[i + 1]!, px[i + 2]!);
    if (channel > peak) peak = channel;
    total += channel;
  }
  return { peak, mean: total / (px.length / 4) };
}

function gradeWhite(palette: PaletteConfig): { peak: number; mean: number } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const factory = ((butterchurn as unknown as { default?: unknown }).default ?? butterchurn) as {
    createVisualizer(ctx: BaseAudioContext, canvas: HTMLCanvasElement, opts: unknown): ProbeVisualizer;
  };
  const bc = factory.createVisualizer(new OfflineAudioContext(1, 48000, 48000), canvas, { width: W, height: H, meshWidth: 12, meshHeight: 8 });
  const api = createEvilandLivePipeline(bc, 'high');
  if (!api) throw new Error('Live pipeline refused this Butterchurn build (private renderer shape changed?)');
  bc.loadPreset(WHITE_PRESET, 0);
  const config = generate('live-highlight', 'nebula').config;
  const silent: CompositionConfig = { scene: null, terrain: false, spectrum: false, emitters: 'off', density: 0, contrast: 1 };
  config.composition = silent;
  config.fluid = { base: 0 };
  config.liquidMix = { base: 0 };
  const wave = new Uint8Array(1024).fill(128);
  for (let step = 0; step < 12; step++) {
    api.update({ frame: syntheticFrame(step / 60, step, 60), palette, config, seed: 'live-highlight', waveMode: 'off' });
    api.advance(1000 / 60);
    bc.render({ elapsedTime: 1 / 60, audioLevels: { timeByteArray: wave, timeByteArrayL: wave, timeByteArrayR: wave } });
  }
  const result = brightest(bc.renderer.gl);
  api.dispose();
  bc.renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
  return result;
}

// A preset that draws nothing of its own and shows its feedback as it is leaves
// the picture to the fluid: whatever the forces put on the field is all there
// is to see.
const FEEDBACK_PRESET = {
  baseVals: { decay: 0.9, wave_a: 0 },
  shapes: [], waves: [], init_eqs_str: '', frame_eqs_str: '', pixel_eqs_str: '', warp: '',
  comp: 'shader_body {\n  ret = tex2D(sampler_main, uv).xyz;\n}',
};

/** What the Live pipeline draws over a preset that shows its feedback with the fluid running, for a look with this stereoSpread. */
function fluidPicture(stereoSpread: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const factory = ((butterchurn as unknown as { default?: unknown }).default ?? butterchurn) as {
    createVisualizer(ctx: BaseAudioContext, canvas: HTMLCanvasElement, opts: unknown): ProbeVisualizer;
  };
  const bc = factory.createVisualizer(new OfflineAudioContext(1, 48000, 48000), canvas, { width: W, height: H, meshWidth: 12, meshHeight: 8 });
  const api = createEvilandLivePipeline(bc, 'high');
  if (!api) throw new Error('Live pipeline refused this Butterchurn build (private renderer shape changed?)');
  bc.loadPreset(FEEDBACK_PRESET, 0);
  const palette: PaletteConfig = { bg: [0, 0, 0], dark: [0.1, 0.1, 0.3], accent: [0.9, 0.5, 0.1], light: [1, 0.9, 0.7] };
  const config = generate('live-spread', 'nebula').config;
  config.composition = { scene: null, terrain: false, spectrum: false, emitters: 'off', density: 0, contrast: 1 };
  config.fluid = { base: 1 };
  config.liquidMix = { base: 1 };
  config.stereoSpread = { base: stereoSpread };
  const wave = new Uint8Array(1024).fill(128);
  for (let step = 0; step < 24; step++) {
    // A mix leaning hard right: where the fluid puts its forces depends on how much of that lean the look keeps.
    const frame = { ...syntheticFrame(step / 60, step, 60), pan: 0.9 };
    api.update({ frame, palette, config, seed: 'live-spread', waveMode: 'off' });
    api.advance(1000 / 60);
    bc.render({ elapsedTime: 1 / 60, audioLevels: { timeByteArray: wave, timeByteArrayL: wave, timeByteArrayR: wave } });
  }
  const gl = bc.renderer.gl;
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  api.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return px;
}

function meanDifference(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
  return total / ((a.length / 4) * 3);
}

/** The Live pipeline passes the look's stereoSpread on to the fluid, as the engine does. */
function spreadReachesFluid(): { failures: string[]; lit: number; repeat: number; narrowed: number } {
  const wide = fluidPicture(1);
  const again = fluidPicture(1);
  const narrow = fluidPicture(0);
  const lit = meanDifference(wide, new Uint8Array(wide.length));
  const repeat = meanDifference(wide, again);
  const narrowed = meanDifference(wide, narrow);
  const failures: string[] = [];
  // The fluid has to draw something, and the same look twice the same thing, or the comparison below says nothing.
  if (lit < 0.5) failures.push(`the Live fluid drew nothing over a preset that shows its feedback (${lit.toFixed(3)} levels)`);
  if (repeat > 0.05) failures.push(`the same look drew two different pictures (${repeat.toFixed(3)} levels apart)`);
  if (narrowed < 0.5) failures.push(`a look that closes the stereo image to nothing draws the same Live fluid as one that leaves it open (${narrowed.toFixed(3)} levels apart)`);
  return { failures, lit, repeat, narrowed };
}

async function highlights() {
  const white: PaletteConfig = { bg: [0, 0, 0], dark: [0.1, 0.1, 0.1], accent: [0.8, 0.8, 0.8], light: [1, 1, 1] };
  const yellow: PaletteConfig = { bg: [0, 0, 0], dark: [0.2, 0.15, 0], accent: [1, 0.85, 0.1], light: [1, 0.98, 0.7] };
  const blue: PaletteConfig = { bg: [0, 0, 0], dark: [0, 0, 0.1], accent: [0.1, 0.2, 1], light: [0.5, 0.65, 1] };
  const failures: string[] = [];
  const out: Record<string, { peak: number; mean: number }> = {};
  for (const [name, palette] of [['white', white], ['yellow', yellow], ['blue', blue]] as const) {
    out[name] = gradeWhite(palette);
  }
  if (out.white!.peak < WHITE_PEAK_MIN) failures.push(`white-light palette tops out at ${out.white!.peak}/255 (need >= ${WHITE_PEAK_MIN})`);
  if (out.yellow!.peak < WHITE_PEAK_MIN) failures.push(`yellow palette tops out at ${out.yellow!.peak}/255 (need >= ${WHITE_PEAK_MIN})`);
  if (out.blue!.peak < WHITE_PEAK_MIN) failures.push(`blue palette tops out at ${out.blue!.peak}/255 (need >= ${WHITE_PEAK_MIN})`);
  const spread = spreadReachesFluid();
  failures.push(...spread.failures);
  return { failures, ...out, spread: { lit: spread.lit, repeat: spread.repeat, narrowed: spread.narrowed } };
}

(window as unknown as { __evilandLiveHighlight: typeof highlights }).__evilandLiveHighlight = highlights;
