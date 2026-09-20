// Browser-side half of `npm run test:eviland-visual` and
// `npm run test:eviland-diversity` (see eviland-visual-test.mjs).
//
// Everything here asserts on RENDERED PIXELS from the real engine. Each
// capture builds a fresh canvas, renderer, simulation state and RNG, and is
// fed the same synthetic audio, so two runs of one config are pixel-identical
// and any difference between two configs is the config.
import { createEvilandRenderer, COMPOSE_FRAG } from '../src/visualizer/eviland';
import { createSceneOverlay } from '../src/visualizer/scene-overlay';
import { SCENES } from '../src/visualizer/scenes/index';
import { generate, ARCHETYPES } from '../src/visualizer/eviland-randomizer';
import { defaultConfig, applyWaveformOverride, type OperatorConfig, type PaletteConfig } from '../src/visualizer/eviland-operators';
import { sourceProgram } from '../src/visualizer/eviland-gl';
import { resolveEvilandPalette, tuneEvilandFrame } from '../src/visualizer/eviland-appearance';
import type { EvilandFrame, ScoreCues } from '../src/visualizer/eviland-audio';

// A phase that accumulates costs the same at any age, which is what the
// settle loop below measures. Sixty seconds of it per scene, across every
// scene, outruns the GPU command buffer's timeout under SwiftShader and takes
// the GPU process with it, so a machine without a GPU measures the same
// property over a shorter run. A machine with one still does the full sixty.
const SOFTWARE_GL = new URLSearchParams(globalThis.location?.search ?? '').has('software-gl');
const SETTLE_FRAMES = SOFTWARE_GL ? 110 : 590;
const W = 160;
const H = 112;
// Neutral on purpose: with one grey palette for every look, recolouring can
// never count as a difference.
const PALETTE: PaletteConfig = { bg: [0, 0, 0], dark: [0.13, 0.13, 0.13], accent: [0.6, 0.6, 0.6], light: [0.9, 0.9, 0.9] };

/** 120 BPM: kick + hat + snare onsets on every half second, steady mid energy. */
export function syntheticFrame(t: number, step: number, fps: number): EvilandFrame {
  const beat = Math.floor(t * 2);
  const previousBeat = Math.floor((t - 1 / fps + 1e-7) * 2);
  const onset = step === 0 || beat !== previousBeat;
  return {
    bands: Float32Array.from({ length: 24 }, (_, i) => 0.2 + 0.25 * Math.abs(Math.sin(i * 0.7 + t * 1.2))),
    onsets: onset
      ? [
          { band: 1, group: 'kick', intensity: 0.75, sharpness: 0.6 },
          { band: 21, group: 'hat', intensity: 0.45, sharpness: 0.5 },
          { band: 8, group: 'snare', intensity: 0.8, sharpness: 0.8 },
        ]
      : [],
    kick: 0.4, bass: 0.38, snare: 0.2, hat: 0.25, vocal: 0.3, energy: 0.38,
    centroid: 0.5, flatness: 0.2, crest: 0.6, rolloff: 0.5, width: 0.3, pan: 0.1,
    beatPhase: (t * 2) % 1, beatConfidence: 0.7, bpm: 120, novelty: 0,
    sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
  };
}

function readPixels(gl: WebGL2RenderingContext, width = W, height = H): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error reading capture');
  return px;
}

/** Mean absolute RGB difference, 0..255. */
function delta(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) total += Math.abs(a[i]! - b[i]!);
  return total / (a.length * 0.75);
}

/** Peak-channel brightness averaged over 4×4 px cells — colour-blind by construction. */
function brightnessGrid(px: Uint8Array): number[] {
  const grid: number[] = [];
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      let sum = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const i = ((y + dy) * W + x + dx) * 4;
          sum += Math.max(px[i]!, px[i + 1]!, px[i + 2]!);
        }
      }
      grid.push(sum / 16);
    }
  }
  return grid;
}

function gridStats(grid: number[]): { mean: number; deviation: number } {
  const mean = grid.reduce((a, b) => a + b, 0) / grid.length;
  const deviation = Math.sqrt(grid.reduce((a, b) => a + (b - mean) ** 2, 0) / grid.length);
  return { mean, deviation };
}

/** Zero-mean, unit-variance layout: compares WHERE the light is, not how much. */
function shape(px: Uint8Array): number[] {
  const grid = brightnessGrid(px);
  const { mean, deviation } = gridStats(grid);
  return grid.map((v) => (v - mean) / Math.max(1, deviation));
}

function distance(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]!) ** 2, 0) / a.length);
}

function capture(
  config: OperatorConfig,
  fps = 60,
  times = [0.5, 1.5, 3],
  palette = PALETTE,
  cuesAt?: (t: number) => ScoreCues | undefined,
) {
  const canvas = document.createElement('canvas');
  const renderer = createEvilandRenderer(canvas, { quality: 'high', smoke: true, seed: 'visual-regression' });
  if (!renderer) throw new Error('WebGL2 renderer unavailable');
  renderer.resize(W, H, 1);
  renderer.setConfig(structuredClone(config));
  const gl = canvas.getContext('webgl2')!;
  const images: Uint8Array[] = [];
  const pngs: string[] = [];
  const wave = new Uint8Array(256);
  try {
    const frames = Math.round(times[times.length - 1]! * fps);
    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      for (let j = 0; j < wave.length; j++) wave[j] = 128 + Math.round(70 * Math.sin(j * 0.12 + t * 2));
      renderer.setWaveform(wave);
      const frame = syntheticFrame(t, i, fps);
      frame.score = cuesAt?.(t);
      renderer.render(frame, palette, 1000 / fps, 'host');
      if (times.some((time) => Math.round(time * fps) === i + 1)) {
        images.push(readPixels(gl));
        pngs.push(canvas.toDataURL());
      }
    }
  } finally {
    renderer.dispose();
  }
  return { images, pngs };
}

/** Classic emitters only — every motion, fluid and waveform channel zeroed. */
function quietConfig(): OperatorConfig {
  const config = defaultConfig();
  config.composition = { scene: null, terrain: false, spectrum: false, emitters: 'bands', density: 0.4, contrast: 1 };
  config.waveform.mode = 'off';
  config.fluid = { base: 0 };
  config.liquidMix = { base: 0 };
  config.mirror = { base: 0 };
  config.mirrorSet = [];
  config.mirrorMix = { base: 0 };
  config.warpAmp = { base: 0 };
  config.zoom = { base: 0 };
  config.rotate = { base: 0 };
  config.swirl = { base: 0 };
  config.hueCycle = { base: 0 };
  config.flowX = { base: 0 };
  config.flowY = { base: 0 };
  config.spinFromSection = false;
  return config;
}

/**
 * The compose shader in isolation: identical bright dye over a black field and
 * over a white field. The old post pass masked dye by the FIELD's darkness, so
 * bright dye vanished wherever the unrelated feedback happened to be dark.
 */
function dyeProbe(): number {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const gl = canvas.getContext('webgl2')!;
  const program = sourceProgram(gl, COMPOSE_FRAG)!;
  gl.useProgram(program);
  const textures: WebGLTexture[] = [];
  const texture = (unit: number, rgb: number[]): void => {
    const tex = gl.createTexture()!;
    textures.push(tex);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...rgb, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  };
  texture(0, [0, 0, 0]);
  texture(1, [240, 80, 40]);
  gl.uniform1i(gl.getUniformLocation(program, 'u_field'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_dye'), 1);
  gl.uniform1f(gl.getUniformLocation(program, 'u_liquidMix'), 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const overDark = readPixels(gl, 4, 4);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textures[0]!);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const overBright = readPixels(gl, 4, 4);
  const result = delta(overDark, overBright);
  if (overDark[0]! < 100) throw new Error('Bright dye disappears over a dark feedback field');
  gl.deleteProgram(program);
  for (const tex of textures) gl.deleteTexture(tex);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return result;
}

async function controls() {
  const checks: Record<string, number> = {};
  const assert = (ok: boolean, message: string): void => {
    if (!ok) throw new Error(message);
  };

  checks.dyeIndependence = dyeProbe();
  assert(checks.dyeIndependence < 1, 'Dye visibility depends on feedback');

  // Each appearance control, min vs max, everything else fixed.
  for (const [name, min, max] of [['bloom', 0, 1.2], ['emitterScale', 0.25, 2.5], ['emitterGain', 0, 2.5]] as const) {
    const a = quietConfig();
    const b = quietConfig();
    if (name === 'bloom') {
      a.bloom = { base: min };
      b.bloom = { base: max };
    } else {
      a[name] = min;
      b[name] = max;
    }
    const low = capture(a, 60, [0.25, 0.65]);
    const high = capture(b, 60, [0.25, 0.65]);
    checks[name] = Math.max(...low.images.map((img, i) => delta(img, high.images[i]!)));
    assert(checks[name]! > 0.15, `${name} does not change rendered pixels: ${checks[name]}`);
  }

  // Waveform 'off' must remove a wave the preset asked for; 'auto' keeps it.
  const waved = quietConfig();
  waved.composition!.emitters = 'off';
  waved.waveform.mode = 'radial';
  const auto = capture(applyWaveformOverride(waved, 'auto'), 60, [0.5]);
  const off = capture(applyWaveformOverride(waved, 'off'), 60, [0.5]);
  checks.waveOff = delta(auto.images[0]!, off.images[0]!);
  assert(checks.waveOff > 1, 'Waveform Off did not suppress source');

  // A selected palette reaches the pixels.
  const active = quietConfig();
  const ice = capture(active, 60, [0.25], resolveEvilandPalette('ice', PALETTE));
  const sunset = capture(active, 60, [0.25], resolveEvilandPalette('sunset', PALETTE));
  checks.palette = delta(ice.images[0]!, sunset.images[0]!);
  assert(checks.palette > 1, 'Selected palette is ignored');

  const frame = syntheticFrame(0, 0, 60);
  assert(tuneEvilandFrame(frame, 'wild').bass > tuneEvilandFrame(frame, 'truth').bass, 'Reactivity is ignored');

  // Same two seconds at 30, 60 and 120 fps: zoom/rotate/swirl/hue motion…
  const moving = quietConfig();
  moving.composition!.emitters = 'off';
  moving.waveform.mode = 'line';
  moving.zoom = { base: 0.003 };
  moving.rotate = { base: 0.005 };
  moving.swirl = { base: 0.01 };
  moving.hueCycle = { base: 0.002 };
  moving.decay = { base: 0.97 };
  const motionRates = [30, 60, 120].map((fps) => capture(moving, fps, [2]));
  checks.motion30 = delta(motionRates[0]!.images[0]!, motionRates[1]!.images[0]!);
  checks.motion120 = delta(motionRates[2]!.images[0]!, motionRates[1]!.images[0]!);
  assert(checks.motion30 < 5 && checks.motion120 < 5, `Frame-rate-dependent motion: ${checks.motion30}, ${checks.motion120}`);

  // …and trail length. A continuous stationary wave isolates decay/injection
  // from discrete events.
  const cadence = quietConfig();
  cadence.composition!.emitters = 'off';
  cadence.waveform.mode = 'line';
  const rates = [30, 60, 120].map((fps) => capture(cadence, fps, [2]));
  checks.rate30 = delta(rates[0]!.images[0]!, rates[1]!.images[0]!);
  checks.rate120 = delta(rates[2]!.images[0]!, rates[1]!.images[0]!);
  assert(checks.rate30 < 3 && checks.rate120 < 3, `Frame-rate-dependent trails: ${checks.rate30}, ${checks.rate120}`);

  // Look-ahead cues reach the pixels: a build dims the picture, the held
  // silence blacks it out, and a landing flashes it — all against the same
  // look with no cues, at the same instant.
  const cued = generate('cue-probe', 'kaleidoscope').config;
  const quietCues: ScoreCues = {
    anticipation: 0, blackout: 0, impact: 0, impactStart: false,
    tier: 'lift', keyShift: 0, arc: 0.5, downbeat: false, toBoundary: 8,
  };
  const litAt = (cuesAt: (t: number) => ScoreCues): number =>
    gridStats(brightnessGrid(capture(cued, 60, [1.5], PALETTE, cuesAt).images[0]!)).mean;
  const baseline = litAt(() => quietCues);
  const building = litAt((t) => ({ ...quietCues, anticipation: t > 0.75 ? 0.85 : 0 }));
  const blackedOut = litAt((t) => ({ ...quietCues, anticipation: 0.85, blackout: t > 1.3 ? 1 : 0 }));
  const landing = litAt((t) => ({ ...quietCues, impact: t > 1.4 ? 0.85 : 0, impactStart: Math.abs(t - 1.4) < 0.009 }));
  checks.cueBuild = building / baseline;
  checks.cueBlackout = blackedOut / baseline;
  checks.cueImpact = landing / baseline;
  assert(checks.cueBuild < 0.85, `a build should dim the picture (now ${checks.cueBuild.toFixed(2)}× baseline)`);
  assert(checks.cueBlackout < 0.15, `the held silence should black the picture out (now ${checks.cueBlackout.toFixed(2)}× baseline)`);
  assert(checks.cueImpact > 1.15, `a landing should flash (now ${checks.cueImpact.toFixed(2)}× baseline)`);

  // Every scene: the same energy step (0.3 → 0.4 at dt = 0) one second in and
  // sixty seconds in. A clock written as time * speed(energy) turns that step
  // into a jump that grows with elapsed time — 6 s of animation at the 60 s
  // mark. With an accumulated phase the step costs the same at any age.
  const stable = { ...frame, bass: 0, energy: 0.3, vocal: 0, beatConfidence: 0, onsets: [] };
  let worstJump = 0;
  for (const def of SCENES) {
    const canvas = document.createElement('canvas');
    const scene = createSceneOverlay(canvas, { quality: 'high', syncCompile: true });
    if (!scene) throw new Error('scene overlay unavailable');
    scene.resize(W, H, 1);
    scene.setScene(def.id);
    const gl = canvas.getContext('webgl2')!;
    const stepCost = (): number => {
      scene.render(stable, PALETTE, 0);
      const before = readPixels(gl);
      scene.render({ ...stable, energy: 0.4 }, PALETTE, 0);
      return delta(before, readPixels(gl));
    };
    for (let i = 0; i < 10; i++) scene.render(stable, PALETTE, 100);
    const early = stepCost();
    for (let i = 0; i < SETTLE_FRAMES; i++) scene.render(stable, PALETTE, 100);
    const late = stepCost();
    worstJump = Math.max(worstJump, late - early);
    assert(late < early * 2 + 1.5, `${def.id}: an audio change teleports the animation after 60s (step costs ${early.toFixed(2)} at 1s, ${late.toFixed(2)} at 60s)`);
    scene.dispose();
  }
  checks.phaseContinuity = worstJump;

  return checks;
}

/** One config per (archetype, scene) — archetypes with a scene pool appear once per scene. */
function everyComposition(): Array<{ name: string; config: OperatorConfig }> {
  const out: Array<{ name: string; config: OperatorConfig }> = [];
  for (const archetype of ARCHETYPES) {
    const seen = new Set<string>();
    for (let k = 0; k < 24; k++) {
      const config = generate(`distinct::${archetype}::${k}`, archetype).config;
      const scene = config.composition?.scene ?? 'none';
      if (seen.has(scene)) continue;
      seen.add(scene);
      out.push({ name: seen.size === 1 ? archetype : `${archetype} (${scene})`, config });
    }
  }
  return out;
}

async function diversity() {
  const failures: string[] = [];
  const compositions = everyComposition();
  const reached = new Set(compositions.map((c) => c.config.composition?.scene));
  for (const def of SCENES) {
    if (!reached.has(def.id)) failures.push(`${def.id}: no archetype ever selects this scene`);
  }

  // Under an all-blue palette, how much of a look's light is NOT blue? A scene
  // that brings its own hues fights whatever palette the user picked.
  const BLUE: PaletteConfig = { bg: [0, 0, 0.02], dark: [0, 0.02, 0.3], accent: [0.05, 0.15, 1], light: [0.45, 0.6, 1] };
  const offPalette = (px: Uint8Array): number => {
    let stray = 0;
    let total = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i]!;
      const g = px[i + 1]!;
      const b = px[i + 2]!;
      total += r + g + b;
      stray += Math.max(0, r - b) + Math.max(0, g - b);
    }
    return stray / Math.max(1, total);
  };

  const captures = [];
  for (const { name, config } of compositions) {
    const result = capture(config);
    // Legibility on the settled (last) frame: a look nobody can see, a
    // blown-out frame, or a flat wash is a failure even if it is "distinct".
    const { mean, deviation } = gridStats(brightnessGrid(result.images[result.images.length - 1]!));
    if (mean < 5) failures.push(`${name}: nearly black (mean ${mean.toFixed(1)}/255)`);
    if (mean > 225) failures.push(`${name}: blown out (mean ${mean.toFixed(1)}/255)`);
    if (deviation < 4) failures.push(`${name}: no structure (deviation ${deviation.toFixed(1)})`);
    const stray = offPalette(capture(config, 30, [1.5], BLUE).images[0]!);
    if (stray > 0.08) failures.push(`${name}: ${(stray * 100).toFixed(0)}% of its light ignores the palette`);
    captures.push({ name, mean, deviation, stray, shapes: result.images.map(shape), pngs: result.pngs });
  }

  const pairs = [];
  for (let i = 0; i < captures.length; i++) {
    for (let j = i + 1; j < captures.length; j++) {
      const a = captures[i]!;
      const b = captures[j]!;
      const geometry = a.shapes.reduce((s, img, k) => s + distance(img, b.shapes[k]!), 0) / a.shapes.length;
      const motionA = a.shapes[2]!.map((v, k) => v - a.shapes[1]![k]!);
      const motionB = b.shapes[2]!.map((v, k) => v - b.shapes[1]![k]!);
      pairs.push({ a: a.name, b: b.name, geometry, motion: distance(motionA, motionB) });
    }
  }
  for (const pair of pairs) {
    if (pair.geometry < 0.2 && pair.motion < 0.2) failures.push(`${pair.a} and ${pair.b} are geometry + motion twins`);
  }

  // Negative control: the same look recoloured must measure as IDENTICAL. If
  // it doesn't, either renders aren't reproducible or the metric sees colour.
  const same = generate('negative-control', 'lattice').config;
  const first = capture(same, 60, [0.5]);
  same.palette = resolveEvilandPalette('sunset', PALETTE);
  const recolor = capture(same, 60, [0.5]);
  const negativeControl = distance(shape(first.images[0]!), shape(recolor.images[0]!));
  if (negativeControl > 1e-5) failures.push(`recolouring changed the geometry metric (${negativeControl})`);

  return {
    failures,
    negativeControl,
    closest: pairs.sort((a, b) => a.geometry - b.geometry).slice(0, 10),
    legibility: captures.map(({ name, mean, deviation, stray }) => ({
      name, mean: Math.round(mean), deviation: Math.round(deviation), offPalette: Math.round(stray * 1000) / 1000,
    })),
    caption: 'Fixed neutral palette and audio. Independent renderers. Timestamps: 0.5, 1.5, 3 seconds.',
    captures: captures.map(({ name, pngs }) => ({ name, pngs })),
  };
}

(window as unknown as { __evilandVisualProbe: unknown }).__evilandVisualProbe = { controls, diversity };
