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
import { defaultConfig, applyWaveformOverride, lerpConfig, MORPH_KINDS, type OperatorConfig, type PaletteConfig } from '../src/visualizer/eviland-operators';
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

  // Under software GL every scene variant of every look outruns the test's
  // time limit, so render each look once there (its first composition). A
  // GPU still renders them all.
  const rendered = SOFTWARE_GL ? compositions.filter(({ name }) => !name.includes(' (')) : compositions;
  const captures = [];
  for (const { name, config } of rendered) {
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

// A colourful palette for the review sheets; the grey one above hides what
// the species and fronts do to colour.
const VIVID: PaletteConfig = { bg: [0.01, 0.005, 0.02], dark: [0.35, 0.02, 0.4], accent: [0.05, 0.75, 1], light: [1, 0.85, 0.35] };

/** Run a config (or a scripted sequence of configs) and capture at `times`. */
function captureSequence(
  configAt: (t: number) => OperatorConfig,
  times: number[],
  width: number,
  height: number,
  palette: PaletteConfig,
  paletteSource: 'preset' | 'host' = 'host',
  fps = 60,
) {
  const canvas = document.createElement('canvas');
  const renderer = createEvilandRenderer(canvas, { quality: 'high', smoke: true, seed: 'visual-regression' });
  if (!renderer) throw new Error('WebGL2 renderer unavailable');
  renderer.resize(width, height, 1);
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
      renderer.setConfig(configAt(t));
      renderer.render(syntheticFrame(t, i, fps), palette, 1000 / fps, paletteSource);
      if (times.some((time) => Math.round(time * fps) === i + 1)) {
        images.push(readPixels(gl, width, height));
        pngs.push(canvas.toDataURL());
      }
    }
  } finally {
    renderer.dispose();
  }
  return { images, pngs };
}

/**
 * Every morph species must visibly change how the same sources move, and
 * none may black out or blow out the frame.
 */
async function species() {
  const failures: string[] = [];
  const base = quietConfig();
  base.composition = { scene: null, terrain: false, spectrum: true, emitters: 'bands', density: 0.5, contrast: 1 };
  base.waveform = { mode: 'radial', intensity: { base: 0.8 }, thickness: 0.01, scale: 0.3 };
  base.decay = { base: 0.93 };
  base.hueCycle = { base: 0.004 };
  const times = [1, 3];
  const baseline = captureSequence(() => base, times, W, H, VIVID);
  const captures = [{ name: 'none', pngs: baseline.pngs }];
  const results = [];
  // Frame-rate independence: the same look at 30 and 120 fps must land on
  // (nearly) the same picture. The no-morph look sets how close "nearly" is.
  const fpsGap = (config: OperatorConfig): number => distance(
    shape(captureSequence(() => config, [3], W, H, VIVID, 'host', 30).images[0]!),
    shape(captureSequence(() => config, [3], W, H, VIVID, 'host', 120).images[0]!),
  );
  const baseGap = fpsGap(base);
  for (const kind of MORPH_KINDS) {
    if (kind === 'none') continue;
    const config: OperatorConfig = { ...structuredClone(base), morph: { kind, amount: { base: kind === 'droste' ? 0.12 : 0.45 }, scale: { base: 1 } } };
    const result = captureSequence(() => config, times, W, H, VIVID);
    const change = delta(result.images[1]!, baseline.images[1]!);
    const { mean, deviation } = gridStats(brightnessGrid(result.images[1]!));
    if (change < 3) failures.push(`${kind}: barely differs from no morph (mean |Δ| ${change.toFixed(2)})`);
    if (mean < 5) failures.push(`${kind}: nearly black (mean ${mean.toFixed(1)}/255)`);
    if (mean > 225) failures.push(`${kind}: blown out (mean ${mean.toFixed(1)}/255)`);
    if (deviation < 4) failures.push(`${kind}: no structure (deviation ${deviation.toFixed(1)})`);
    // Checked at a strong setting, where a frame-rate-dependent blend drifts
    // furthest from the linear one.
    const gap = fpsGap({ ...config, morph: { ...config.morph!, amount: { base: kind === 'droste' ? 0.2 : 0.8 } } });
    if (gap > baseGap + 0.12) failures.push(`${kind}: moves differently at 30 and 120 fps (${gap.toFixed(2)} vs ${baseGap.toFixed(2)} without a morph)`);
    results.push({ kind, change: Math.round(change * 100) / 100, mean: Math.round(mean), deviation: Math.round(deviation), fpsGap: Math.round(gap * 100) / 100 });
    captures.push({ name: kind, pngs: result.pngs });
  }
  return { failures, results, baseFpsGap: Math.round(baseGap * 100) / 100, caption: 'Same sources and audio, one morph species each. 1 s and 3 s.', captures };
}

/**
 * Review sheet for the transition fronts: look A runs, then a fade to look B
 * carrying both sides (as the Director stamps it), captured through the fade.
 */
async function transitions() {
  const failures: string[] = [];
  const from = generate('showcase-from', 'kaleidoscope').config;
  const to = generate('showcase-to', 'mitosis').config;
  const start = 2;
  const length = 2.5;
  const times = [1.9, 2.4, 2.9, 3.4, 3.9, 4.3, 5.2];
  const captures = [];
  const means: number[][] = [];
  for (let pattern = 0; pattern < 6; pattern++) {
    const configAt = (t: number): OperatorConfig => {
      if (t < start) return from;
      const p = Math.min(1, (t - start) / length);
      if (p >= 1) return to;
      const eased = p * p * (3 - 2 * p);
      return { ...lerpConfig(from, to, eased), _transition: eased, _from: from, _to: to, _pattern: pattern, _patternSeed: 1.7 };
    };
    const result = captureSequence(configAt, times, 320, 180, VIVID);
    const settled = gridStatsFor(result.images[6]!, 320, 180).mean;
    for (let i = 1; i < 6; i++) {
      const px = result.images[i]!;
      const lit = gridStatsFor(px, 320, 180).mean;
      if (lit < 4 || lit > 230) failures.push(`front ${pattern}: frame ${i} unreadable (mean ${lit.toFixed(1)})`);
      // The front may glow, but it must not wash the whole frame.
      if (lit > settled * 1.8 + 25) failures.push(`front ${pattern}: frame ${i} floods (mean ${lit.toFixed(1)} vs settled ${settled.toFixed(1)})`);
      means[pattern] = [...(means[pattern] ?? []), Math.round(lit)];
    }
    means[pattern] = [...(means[pattern] ?? []), Math.round(settled)];
    captures.push({ name: `front-${pattern}`, pngs: result.pngs });
  }
  return { failures, means, caption: 'Kaleidoscope → mitosis, one row per front. Before, 20/40/60/80/98% through, settled.', captures };
}

/** Review sheet: archetypes in their own generated palettes, larger than the gates use. */
async function showcase() {
  const captures = [];
  for (const archetype of ARCHETYPES) {
    const config = generate(`showcase::${archetype}`, archetype).config;
    const label = `${archetype}${config.morph ? `+${config.morph.kind}` : ''}`;
    const result = captureSequence(() => config, [2.5, 6], 320, 180, VIVID, 'preset');
    captures.push({ name: label, pngs: result.pngs });
  }
  return { failures: [], caption: 'Each archetype in its own palette, 2.5 s and 6 s.', captures };
}

/**
 * GPU cost per frame at 1080p for the heavier paths: a settled look, a look
 * mid-transition (both warps run), the coral morph, and the slime mould.
 * gl.finish() after each frame so the number is GPU time, not submission.
 */
async function perf() {
  const width = 1920;
  const height = 1080;
  const plain = generate('perf::plain', 'kaleidoscope').config;
  const coral = { ...generate('perf::coral', 'inkwell').config };
  const mould = generate('perf::mould', 'mycelium').config;
  const target = generate('perf::target', 'mitosis').config;
  const midFade = (): OperatorConfig => ({ ...lerpConfig(plain, target, 0.5), _transition: 0.5, _from: plain, _to: target, _pattern: 1, _patternSeed: 1 });
  const cases: Array<[string, () => OperatorConfig]> = [
    ['settled', () => plain], ['transition', midFade], ['coral', () => coral], ['physarum', () => mould],
  ];
  const results: Record<string, { median: number; p90: number }> = {};
  for (const [name, configAt] of cases) {
    const canvas = document.createElement('canvas');
    const renderer = createEvilandRenderer(canvas, { quality: 'high', smoke: true, seed: 'perf' });
    if (!renderer) throw new Error('WebGL2 renderer unavailable');
    renderer.resize(width, height, 1);
    const gl = canvas.getContext('webgl2')!;
    const pixel = new Uint8Array(4);
    // gl.finish() does not block under ANGLE/D3D11, so time batches of frames
    // closed by a readPixels, which has to wait for the GPU.
    const batches: number[] = [];
    try {
      let step = 0;
      const run = (frames: number): void => {
        for (let i = 0; i < frames; i++, step++) {
          renderer.setConfig(configAt());
          renderer.render(syntheticFrame(step / 60, step, 60), VIVID, 1000 / 60, 'preset');
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      };
      run(30);
      for (let b = 0; b < 5; b++) {
        const start = performance.now();
        run(24);
        batches.push((performance.now() - start) / 24);
      }
    } finally {
      renderer.dispose();
    }
    batches.sort((a, b) => a - b);
    results[name] = { median: Math.round(batches[2]! * 100) / 100, p90: Math.round(batches[4]! * 100) / 100 };
  }
  const debug = document.createElement('canvas').getContext('webgl2')!;
  const info = debug.getExtension('WEBGL_debug_renderer_info');
  return { failures: [], resolution: `${width}x${height}`, gpu: info ? debug.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown', msPerFrame: results };
}

function gridStatsFor(px: Uint8Array, width: number, height: number): { mean: number } {
  let sum = 0;
  for (let i = 0; i < width * height; i++) sum += Math.max(px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!);
  return { mean: sum / (width * height) };
}

(window as unknown as { __evilandVisualProbe: unknown }).__evilandVisualProbe = { controls, diversity, species, transitions, showcase, perf };
