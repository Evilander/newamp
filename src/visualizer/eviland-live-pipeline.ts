// Eviland Live pipeline — one image instead of stacked canvases.
//
// Eviland Live used to be three transparent layers: the MilkDrop iframe, a
// scene canvas and a reactor-event canvas. Each had its own colours, and
// nothing we drew could enter MilkDrop's feedback, so our geometry sat on top
// of the preset like a sticker. This adapter hooks Butterchurn 2.6's renderer
// so every Eviland source is drawn INTO its feedback texture instead:
//
//   MilkDrop warp + shapes + waves ──► targetTexture (this frame's feedback)
//        │
//        ├─ fluid advection + dye        (medium/high)
//        ├─ morph species (cells, growth, marble, droste…) bending the
//        │  preset's own feedback, so a MilkDrop preset moves organically
//        ├─ procedural scene             (medium/high)
//        ├─ reaction–diffusion chemistry (looks that ask for it)
//        └─ reactor events: kick rings, snare spikes, hat sparkles, vocal blobs
//        │
//        ▼
//   preset composite shader ──► compTexture ──► palette grade + bloom ──► screen
//
// Whatever we add is warped, blurred, echoed and decayed by the preset on the
// following frames, exactly like the preset's own shapes. The final grade runs
// after the preset's composite shader, so a custom comp shader cannot bypass
// the palette the user picked.
//
// This reaches into Butterchurn's private renderer, which is why package.json
// pins butterchurn to an exact version. createEvilandLivePipeline returns null
// when the fields it needs are missing; the iframe then runs plain MilkDrop.

import type { EvilandFrame } from './eviland-audio';
import { createReactionDiffusion, prepareReactionDiffusion } from './eviland-reaction-diffusion';
import { createPhysarum, preparePhysarum } from './eviland-physarum';
import { hashSeed } from './eviland-rng';
import { createReactorOverlay } from './reactor-overlay';
import { createSceneOverlay } from './scene-overlay';
import { createFluidSim, createFluidForceSource, dyeDissipationFromFrame } from './eviland-fluid';
import { createDynamics, evalConfig, sectionSeedFor, type OperatorConfig, type PaletteConfig, type WaveOverride } from './eviland-operators';
import {
  sourceProgram, sourceTarget, disposeSourceTarget, watchContextLoss, createRampTable, updateRampTable, oklchRampAt,
  rampGlsl, DITHER_GLSL, DITHER_FRAME_WRAP, SHOULDER_GLSL, RAMP_STEPS, type SourceTarget,
} from './eviland-gl';
import { applyScoreCues } from './eviland-conductor';
import { NOISE_GLSL, MORPH_GLSL } from './eviland-morph';

type WaveDraw = (...args: unknown[]) => void;
interface WaveRenderer {
  drawBasicWaveform?: WaveDraw;
  drawCustomWaveform?: WaveDraw;
}

/** The slice of Butterchurn's private renderer this adapter depends on. */
export interface MilkdropFeedbackHost {
  gl: WebGL2RenderingContext;
  targetFrameBuffer: WebGLFramebuffer;
  targetTexture: WebGLTexture;
  prevTexture: WebGLTexture;
  compTexture: WebGLTexture;
  texsizeX: number;
  texsizeY: number;
  width: number;
  height: number;
  outputFXAA: boolean;
  outputShader?: { renderQuadTexture: (texture: WebGLTexture) => void };
  renderToScreen(): void;
  basicWaveform: WaveRenderer;
  customWaveforms: WaveRenderer[];
  prevCustomWaveforms: WaveRenderer[];
}

/** Everything the parent decides for one frame of the Live composition. */
/**
 * What Live needs of the look a fade is heading to: enough to seed its
 * simulation, compile its scene and start its preset blend. Posters send this
 * instead of the fade's two full looks, which keeps every frame's message small.
 */
export type LiveLookAhead = Pick<OperatorConfig, 'seed' | 'archetype' | 'composition'>;

export interface LiveCompositionFrame {
  frame: EvilandFrame;
  palette: PaletteConfig;
  config: OperatorConfig;
  /**
   * During a Director fade, the look it is heading to: prepared as the fade
   * begins, not at the midpoint where the composition switches.
   */
  next?: LiveLookAhead;
  seed: string;
  waveMode: WaveOverride;
  /**
   * 0..1 — how firmly the final image is pulled onto `palette`. Omitted means
   * a strong grade; lower values let more of the preset's own hues through.
   */
  grade?: number;
}

export interface EvilandLivePipeline {
  update(next: LiveCompositionFrame): void;
  /** Call once before each visualizer.render() with the real elapsed time. */
  advance(dtMs: number): void;
  /** Lit fraction of the last composed frame (smoke/diagnostics; reads back). */
  sample(): number;
  /**
   * True from a WebGL context loss until the pipeline is rebuilt. Everything
   * it holds (programs, targets, fluid, chemistry) died with the context, so
   * the parent builds a new pipeline once the context is restored.
   */
  contextLost(): boolean;
  dispose(): void;
}

export interface LivePipelineHooks {
  /** The GL context was lost: stop painting and tell the parent. */
  onContextLost?(): void;
  /** The context is back; the pipeline cannot revive itself, so rebuild it. */
  onContextRestored?(): void;
}

// Samples per segment of the grade's closed colour wheel (four segments).
const WHEEL_STEPS = 8;

// Pass A (dynamics): bends the feedback image along the simulated fluid and
// the look's morph species, and folds dye into it. Pass B (grade): palette +
// bloom on the preset's composite.
const COMPOSE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_image, u_velocity, u_dye;
uniform vec3 u_bg;
uniform float u_dt, u_fluid, u_dyeMix, u_grade, u_bloom, u_gain, u_saturation;
uniform float u_morph, u_morphAmt, u_morphScale, u_time, u_aspect;
uniform float u_frame, u_dither;
${NOISE_GLSL}
${MORPH_GLSL}
${DITHER_GLSL}
${SHOULDER_GLSL}
// The palette laid out in OKLCh (see eviland-gl.ts): u_ramp runs dark -> accent
// -> light, u_wheel runs dark -> accent -> light -> (accent2 or the midpoint of
// light and dark) -> dark. Mixing the roles in sRGB went through grey between
// any two saturated colours.
${rampGlsl('rampValue', 'u_ramp', 2 * RAMP_STEPS + 1)}
${rampGlsl('rampWheel', 'u_wheel', 4 * WHEEL_STEPS + 1)}
vec3 unit(vec3 c) { return c / max(0.001, max(c.r, max(c.g, c.b))); }
// Brightness here is the peak channel, which is not what the eye reads: a pure
// blue and a pure yellow at the same peak differ about thirteenfold in
// luminance, so a palette whose hue travels would swing in brightness with
// the hue. Pull the unit-peak tint's luminance part of the way toward a common
// level (down for yellows, up for blues), and never past the peak's headroom.
// A cut fades out as the peak nears full: the brightest pixels of every
// palette still reach their full colour, where a flat 0.8 would hold any
// bright tint (white, yellow, cyan) at about 204/255 however hard it is driven.
vec3 evenLuminance(vec3 tint, float peak) {
  float lum = dot(tint, vec3(0.2126, 0.7152, 0.0722));
  float scale = clamp(sqrt(0.45 / max(lum, 0.05)), 0.8, 1.5);
  if (scale < 1.0) scale = mix(scale, 1.0, smoothstep(0.6, 1.0, peak));
  return tint * min(scale, max(1.0, 1.0 / max(peak, 0.001)));
}
// Two readings of the preset's colour, both brightness-preserving:
//  - by saturation: saturated pixels land between dark and accent, washed-out
//    ones between accent and light (greys have no hue to go by);
//  - by hue: the colour wheel is laid round the palette (dark → accent →
//    light → dark), so a preset's differently coloured parts stay different
//    colours of the palette instead of collapsing onto one ramp.
// Saturated pixels take the hue reading. Every preset used to come out as
// the same three-colour gradient; now each keeps its own colour layout.
vec3 grade(vec3 c) {
  float peak = max(c.r, max(c.g, c.b));
  float sat = (peak - min(c.r, min(c.g, c.b))) / max(peak, 0.001);
  float position = clamp(dot(c, vec3(0.22, 0.55, 0.23)) / max(peak, 0.001), 0.0, 1.0);
  vec3 byValue = rampValue(position < 0.55 ? position / 0.55 * 0.5 : 0.5 + (position - 0.55) / 0.45 * 0.5);
  // atan(0, 0) is undefined; greys carry no hue and take the value reading.
  vec2 iq = vec2(dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
  float hue = dot(iq, iq) > 1e-10 ? fract(atan(iq.y, iq.x) / 6.28318530718) : 0.0;
  // Thirds of the hue circle: dark -> accent, accent -> light, light -> back to dark.
  vec3 byHue = rampWheel(hue < 0.6667 ? hue * 0.75 : 0.5 + (hue - 0.6667) * 1.5);
  vec3 tint = evenLuminance(mix(unit(byValue), unit(byHue), smoothstep(0.2, 0.55, sat)), peak);
  return mix(u_bg * 0.08, tint * peak, smoothstep(0.0, 0.08, peak));
}
void main() {
  vec2 uv = clamp(v_uv - texture(u_velocity, v_uv).xy * u_dt * u_fluid, 0.001, 0.999);
  int kind = int(u_morph + 0.5);
  // Same split as the Eviland field: droste compounds, the rest scale
  // linearly with elapsed reference frames.
  float k = kind > 0 ? min(3.0, u_morphAmt * u_dt * 60.0) : 0.0;
  vec2 texel = 1.0 / vec2(textureSize(u_image, 0));
  vec2 alt = uv;
  float altMix = 0.0;
  if (kind == 5) {
    float inside;
    alt = drosteTap(uv, u_morphScale, vec2(0.5), u_time, u_aspect, inside);
    altMix = (1.0 - pow(1.0 - u_morphAmt, u_dt * 60.0)) * inside;
  } else if (kind > 0 && kind != 2) {
    uv = clamp(uv + (morphTarget(u_image, uv, kind, u_morphScale, vec2(0.5), u_time, u_aspect, texel) - uv) * k, 0.001, 0.999);
  }
  vec3 c = texture(u_image, uv).rgb;
  if (altMix > 0.0) c = mix(c, textureLod(u_image, clamp(alt, 0.001, 0.999), 0.0).rgb, altMix);
  if (kind == 2 && k > 0.0) c = coralApply(u_image, c, uv, k, u_morphScale, texel, u_time, u_aspect);
  vec3 dye = texture(u_dye, v_uv).rgb;
  c = mix(c, c * 0.55 + dye / (1.0 + max(dye.r, max(dye.g, dye.b))), u_dyeMix);
  if (u_bloom > 0.0) {
    vec2 px = 2.0 / vec2(textureSize(u_image, 0));
    vec3 glow = texture(u_image, uv + px).rgb + texture(u_image, uv - px).rgb
      + texture(u_image, uv + vec2(px.x, -px.y)).rgb + texture(u_image, uv + vec2(-px.x, px.y)).rgb;
    c += glow * (u_bloom * 0.06);
  }
  c = mix(c, grade(c), u_grade);
  // Score cues: grey and dim into a build, black for the held beat, flash on
  // the drop. RGB scales together, so a flash brightens without bleaching.
  c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, u_saturation) * u_gain;
  // A gain past 1 (the drop flash goes to 2.5) would clip per channel and
  // drift toward yellow or white. The engine's shoulder takes over as the gain
  // rises, so the flash keeps its colour; at gain 1 the pass is untouched.
  c = mix(c, hotShoulder(c), smoothstep(1.0, 1.3, u_gain));
  // The preset's feedback is 8-bit and this pass writes 8-bit again. One step
  // of triangular grain, faded out toward black so black stays still, keeps a
  // slow gradient from landing on a few levels. Only on the final write: the
  // dynamics pass feeds the feedback loop and must not add noise to it.
  float amount = u_dither * smoothstep(0.0, 2.0 / 255.0, max(c.r, max(c.g, c.b)));
  o = vec4(c + ditherTri(gl_FragCoord.xy, u_frame) * amount / 255.0, 1.0);
}`;

// Straight-alpha 2D canvas → premultiplied contribution. 2D canvases upload
// top-row-first, so v is flipped here; u_useAlpha = 0 turns the same program
// into a plain blit for sample().
const STAMP = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform float u_gain, u_flipY, u_useAlpha;
void main() {
  vec4 s = texture(u_src, vec2(v_uv.x, mix(v_uv.y, 1.0 - v_uv.y, u_flipY)));
  o = vec4(s.rgb * mix(1.0, s.a, u_useAlpha) * u_gain, 1.0);
}`;

const REACTOR_MAX_WIDTH = 960;
const LIVE_MORPH_SHARE = 0.6;
const SAMPLE_W = 48;
const SAMPLE_H = 27;

export function createEvilandLivePipeline(
  visualizer: unknown,
  quality: 'high' | 'medium' | 'low',
  hooks: LivePipelineHooks = {},
): EvilandLivePipeline | null {
  const found = (visualizer as { renderer?: MilkdropFeedbackHost } | null)?.renderer;
  if (
    !found?.gl || !found.targetFrameBuffer || !found.targetTexture || !found.compTexture
    || typeof found.renderToScreen !== 'function'
  ) {
    return null;
  }
  const host: MilkdropFeedbackHost = found;
  const gl = host.gl;
  const compose = sourceProgram(gl, COMPOSE);
  const stamp = sourceProgram(gl, STAMP);
  const vao = gl.createVertexArray();
  if (!compose || !stamp || !vao) {
    gl.deleteProgram(compose);
    gl.deleteProgram(stamp);
    gl.deleteVertexArray(vao);
    return null;
  }

  const uniformsOf = <N extends string>(program: WebGLProgram, names: readonly N[]): Record<N, WebGLUniformLocation | null> =>
    Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, `u_${name}`)])) as Record<N, WebGLUniformLocation | null>;
  const composeUni = uniformsOf(compose, [
    'image', 'velocity', 'dye', 'ramp', 'wheel', 'bg', 'dt', 'fluid', 'dyeMix', 'grade', 'bloom', 'gain', 'saturation',
    'morph', 'morphAmt', 'morphScale', 'time', 'aspect', 'frame', 'dither',
  ] as const);
  const stampUni = uniformsOf(stamp, ['src', 'gain', 'flipY', 'useAlpha'] as const);

  // The palette as OKLCh lines for the grade, rebuilt only when its colours
  // change: dark -> accent -> light, and the closed wheel through a fourth
  // stop (the second accent, or the middle of light and dark without one).
  const valueRamp = createRampTable(3);
  const wheelRamp = createRampTable(5, WHEEL_STEPS);
  const rampStops = new Float64Array(9);
  const wheelStops = new Float64Array(15);
  // The middle of light and dark is a full OKLCh conversion, so it is looked
  // up only when one of those six numbers moves, not once per frame.
  const midKey = new Float64Array(6).fill(NaN);
  const midStop = new Float64Array(3);
  function lightDarkMiddle(palette: PaletteConfig): Float64Array {
    let same = true;
    for (let i = 0; i < 3; i++) {
      if (midKey[i] !== palette.light[i] || midKey[i + 3] !== palette.dark[i]) { same = false; break; }
    }
    if (!same) {
      midKey.set(palette.light, 0);
      midKey.set(palette.dark, 3);
      midStop.set(oklchRampAt(midKey, 0.5));
    }
    return midStop;
  }
  function updateGradeRamps(palette: PaletteConfig): void {
    rampStops.set(palette.dark, 0);
    rampStops.set(palette.accent, 3);
    rampStops.set(palette.light, 6);
    updateRampTable(valueRamp, rampStops);
    wheelStops.set(rampStops, 0);
    wheelStops.set(palette.accent2 ?? lightDarkMiddle(palette), 9);
    wheelStops.set(palette.dark, 12);
    updateRampTable(wheelRamp, wheelStops);
  }
  let frameCount = 0;

  // 'low' keeps MilkDrop + reactor events + the grade and skips every
  // full-screen source, matching the old stack's weak-GPU floor.
  const scenes = quality === 'low' ? null : createSceneOverlay(gl.canvas as HTMLCanvasElement, { gl, quality });
  let chemistryPrograms = quality === 'low' ? null : prepareReactionDiffusion(gl);
  let mouldPrograms = quality === 'low' ? null : preparePhysarum(gl);
  const fluid = quality === 'low'
    ? null
    : createFluidSim(gl, { width: 96, height: 64, pressureIterations: quality === 'high' ? 10 : 6 });
  const forceSource = createFluidForceSource();
  const dyn = createDynamics();
  let chemistry: ReturnType<typeof createReactionDiffusion> = null;
  let mould: ReturnType<typeof createPhysarum> = null;
  // A simulation that failed to build stays off instead of retrying per frame.
  let chemistryFailed = false;
  let mouldFailed = false;
  let clock = 0;

  // Reactor events are drawn with the 2D API (cheap, and already tuned) on a
  // capped-size canvas, then stamped into the feedback additively.
  const reactorCanvas = document.createElement('canvas');
  const reactor = createReactorOverlay(reactorCanvas);
  const reactorTexture = reactor ? gl.createTexture() : null;
  let reactorW = 0;
  let reactorH = 0;
  if (reactorTexture) {
    gl.bindTexture(gl.TEXTURE_2D, reactorTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  let scratch: SourceTarget | null = null;
  let sampleTarget: SourceTarget | null = null;
  let state: LiveCompositionFrame | null = null;
  let pendingDt = 0;
  let disposed = false;
  // Onsets are one-shot events, but the parent may post more than once between
  // two paints (or paint slower than it posts). Queue them so none is dropped.
  let onsets: EvilandFrame['onsets'] = [];
  // Same for the score's one-shot: the frame that carries impactStart may be
  // painted twice, or replaced by a newer frame before it is painted at all.
  let impactStartPending = false;

  const originalScreen = host.renderToScreen;
  const originalAA = host.outputFXAA;
  // Route the preset's composite into compTexture instead of the backbuffer;
  // the grade pass below is what reaches the screen.
  host.outputFXAA = true;

  // ---- Waveform override ---------------------------------------------------
  // 'auto' leaves the preset's waves alone. 'off' drops them. An explicit mode
  // forces the basic waveform into that shape and mutes custom waves so the
  // choice is unambiguous.
  const wrapped = new Map<WaveRenderer, { key: 'drawBasicWaveform' | 'drawCustomWaveform'; original: WaveDraw }>();
  function wrapWaves(): void {
    for (const wave of [host.basicWaveform, ...(host.customWaveforms ?? []), ...(host.prevCustomWaveforms ?? [])]) {
      if (!wave || wrapped.has(wave)) continue;
      const key = wave.drawBasicWaveform ? 'drawBasicWaveform' : 'drawCustomWaveform';
      const original = wave[key];
      if (!original) continue;
      wrapped.set(wave, { key, original });
      wave[key] = function (this: unknown, ...args: unknown[]) {
        const mode = state?.waveMode ?? 'auto';
        if (mode === 'off') return;
        if (mode !== 'auto') {
          if (key === 'drawCustomWaveform') return;
          const values = args[4] as Record<string, number>;
          const nativeMode = mode === 'radial' ? 0 : mode === 'bars' ? 7 : 6;
          args[0] = false; // not blending: draw the forced mode only
          args[4] = { ...values, wave_mode: nativeMode, old_wave_mode: nativeMode, wave_a: Math.max(0.6, values.wave_a ?? 0) };
        }
        original.apply(this, args);
      };
    }
  }

  function bindComposeInputs(image: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, image);
    gl.uniform1i(composeUni.image, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fluid?.velocityTexture() ?? image);
    gl.uniform1i(composeUni.velocity, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fluid?.dyeTexture() ?? image);
    gl.uniform1i(composeUni.dye, 2);
  }

  function beginFullscreen(framebuffer: WebGLFramebuffer | null, width: number, height: number): void {
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Pass A: advect the feedback along the fluid and morph, and fold dye in. */
  function applyFluid(h: MilkdropFeedbackHost, dt: number): void {
    // 'low' skips the morph with every other full-screen pass.
    const morphOn = quality !== 'low' && dyn.morph > 0 && dyn.morphAmount > 0.0005;
    const fluidOn = !!fluid && (dyn.fluid > 0.0005 || dyn.liquidMix > 0.0005);
    if (!morphOn && !fluidOn) return;
    if (!scratch || scratch.width !== h.texsizeX || scratch.height !== h.texsizeY) {
      disposeSourceTarget(gl, scratch);
      scratch = sourceTarget(gl, h.texsizeX, h.texsizeY);
    }
    if (!scratch) return;
    // A framebuffer can't sample its own attachment: copy, then write back.
    beginFullscreen(h.targetFrameBuffer, h.texsizeX, h.texsizeY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scratch.texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, h.texsizeX, h.texsizeY);
    gl.useProgram(compose);
    gl.disable(gl.BLEND);
    bindComposeInputs(scratch.texture);
    gl.uniform1f(composeUni.dt, dt);
    // Without a sim the velocity/dye inputs are the image itself, so both
    // must read as off.
    gl.uniform1f(composeUni.fluid, fluidOn ? dyn.fluid : 0);
    gl.uniform1f(composeUni.dyeMix, fluidOn ? dyn.liquidMix : 0);
    gl.uniform1f(composeUni.morph, morphOn ? dyn.morph : 0);
    // The preset keeps its own warp; the morph rides on top at a lower
    // strength than in Eviland, so the preset stays recognisable.
    gl.uniform1f(composeUni.morphAmt, dyn.morphAmount * LIVE_MORPH_SHARE);
    gl.uniform1f(composeUni.morphScale, dyn.morphScale);
    gl.uniform1f(composeUni.time, clock);
    gl.uniform1f(composeUni.aspect, h.texsizeX / Math.max(1, h.texsizeY));
    gl.uniform1f(composeUni.grade, 0);
    gl.uniform1f(composeUni.bloom, 0);
    gl.uniform1f(composeUni.gain, 1);
    gl.uniform1f(composeUni.saturation, 1);
    gl.uniform1f(composeUni.dither, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Reactor events → feedback. Additive, scaled by dt so trails match at any fps. */
  function stampReactor(h: MilkdropFeedbackHost, frame: EvilandFrame, palette: PaletteConfig, dt: number): void {
    if (!reactor || !reactorTexture) return;
    const w = Math.max(64, Math.min(REACTOR_MAX_WIDTH, h.texsizeX));
    const height = Math.max(36, Math.round(w * (h.texsizeY / Math.max(1, h.texsizeX))));
    if (w !== reactorW || height !== reactorH) {
      reactorW = w;
      reactorH = height;
      reactor.resize(w, height, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, reactorTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    reactor.render(frame, palette, dt * 1000, dyn.stereoSpread);
    beginFullscreen(h.targetFrameBuffer, h.texsizeX, h.texsizeY);
    gl.useProgram(stamp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, reactorTexture);
    // Butterchurn only ever sets this to true right before its own title
    // upload, so pinning the default here can't disturb it.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, reactorCanvas);
    gl.uniform1i(stampUni.src, 0);
    gl.uniform1f(stampUni.flipY, 1);
    gl.uniform1f(stampUni.useAlpha, 1);
    gl.uniform1f(stampUni.gain, Math.min(1.5, 0.55 * dt * 60 * Math.max(0.2, dyn.emitterGain)));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Pass B: the preset's composite → palette grade + bloom → backbuffer. */
  function gradeToScreen(h: MilkdropFeedbackHost, current: LiveCompositionFrame, gain: number, saturation: number): void {
    beginFullscreen(null, h.width, h.height);
    gl.useProgram(compose);
    gl.disable(gl.BLEND);
    bindComposeInputs(h.compTexture);
    gl.uniform1f(composeUni.dt, 0);
    gl.uniform1f(composeUni.fluid, 0);
    gl.uniform1f(composeUni.dyeMix, 0);
    gl.uniform1f(composeUni.morph, 0);
    gl.uniform1f(composeUni.grade, Math.max(0, Math.min(1, current.grade ?? 1)));
    gl.uniform1f(composeUni.bloom, Math.max(0, dyn.bloom));
    gl.uniform1f(composeUni.gain, gain);
    gl.uniform1f(composeUni.saturation, saturation);
    updateGradeRamps(current.palette);
    gl.uniform3fv(composeUni.ramp, valueRamp.values);
    gl.uniform3fv(composeUni.wheel, wheelRamp.values);
    gl.uniform3fv(composeUni.bg, current.palette.bg);
    gl.uniform1f(composeUni.dither, 1);
    gl.uniform1f(composeUni.frame, frameCount++ % DITHER_FRAME_WRAP);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // A lost context takes every handle this pipeline owns with it, and
  // Butterchurn's renderer too. Nothing is drawn until the parent builds a new
  // pipeline on the restored context; the flash guard's own hold is what makes
  // the browser restore the context at all, this only has to notice.
  let lost = false;
  let reportedFailure = false;
  const stopWatching = watchContextLoss(gl.canvas as HTMLCanvasElement, {
    onLost() {
      lost = true;
      hooks.onContextLost?.();
    },
    onRestored() {
      hooks.onContextRestored?.();
    },
  });

  host.renderToScreen = function (this: MilkdropFeedbackHost) {
    if (lost || gl.isContextLost()) return;
    const current = state;
    if (disposed || !current || pendingDt <= 0) {
      originalScreen.call(this);
      return;
    }
    const dt = pendingDt;
    pendingDt = 0;
    clock += dt;
    // MilkDrop leaves mipmapped sampler objects bound. Our single-level
    // textures sample black through them, so unbind for our passes and hand
    // them back before Butterchurn draws again.
    const samplers = [0, 1, 2].map((unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      const sampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null;
      gl.bindSampler(unit, null);
      return sampler;
    });
    const restoreSamplers = (): void => samplers.forEach((sampler, unit) => gl.bindSampler(unit, sampler));
    const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;

    // Any pass can throw (a dead handle, a driver error). Butterchurn's render
    // loop swallows the exception, so without this the samplers and the
    // vertex array would stay as this pass left them and every following frame
    // would come out garbled or black with nothing logged. State is always
    // handed back; the first failure is logged, and the frame falls back to the
    // preset as MilkDrop draws it rather than going black.
    let output: MilkdropFeedbackHost['outputShader'];
    let outputDraw: ((texture: WebGLTexture) => void) | undefined;
    let compDrawn = false;
    let graded = false;
    try {
      const cues = current.frame.score;
      const frame: EvilandFrame = {
        ...current.frame,
        onsets,
        score: cues ? { ...cues, impactStart: impactStartPending } : undefined,
      };
      onsets = [];
      impactStartPending = false;
      evalConfig(current.config, frame, sectionSeedFor(frame.sectionId), dyn, dt * 1000);
      // MilkDrop's own warp isn't ours to bend, so in Live the cues act through
      // what is: the fluid (inward pull, then the shockwave), how much of the
      // scene is laid in, the reactor events, and the final grade.
      const cueGain = applyScoreCues(dyn, frame.score);
      const outputGain = cueGain.output;
      const outputSaturation = cueGain.saturation;
      const sourceFade = frame.score ? (1 - 0.5 * frame.score.anticipation) * (1 - frame.score.blackout) : 1;

      const upcoming = current.next ?? current.config._to ?? current.config;
      const simulation = upcoming.composition?.simulation;
      if (quality !== 'low' && (simulation === 'reaction-diffusion' || current.config.composition?.simulation === 'reaction-diffusion')) {
        if (!chemistry && !chemistryFailed) {
          chemistry = createReactionDiffusion(gl, hashSeed(upcoming.seed ?? current.seed), chemistryPrograms);
          chemistryPrograms = null;
          chemistryFailed = !chemistry;
        }
      }
      if (quality !== 'low' && (simulation === 'physarum' || current.config.composition?.simulation === 'physarum')) {
        if (!mould && !mouldFailed) {
          mould = createPhysarum(gl, hashSeed(upcoming.seed ?? current.seed), quality, mouldPrograms);
          mouldPrograms = null;
          mouldFailed = !mould;
        }
      }

      gl.bindVertexArray(vao);
      fluid?.step(dt, forceSource.forces(frame, current.palette, dt, dyn.stereoSpread), {
        vorticity: dyn.vorticity,
        dissipation: 0.985,
        dyeDissipation: Math.max(0.6, Math.min(1, dyeDissipationFromFrame(frame) + dyn.dyeDissipation)),
      });
      applyFluid(this, dt);

      const composition = current.config.composition;
      const target = { framebuffer: this.targetFrameBuffer, width: this.texsizeX, height: this.texsizeY };
      if (composition?.scene && scenes) {
        scenes.setSeedKey(current.seed);
        scenes.setScene(composition.scene);
        scenes.render(frame, current.palette, dt * 1000, {
          ...target,
          // Per-frame coverage that converges on `density` at any frame rate.
          opacity: (1 - Math.pow(1 - Math.max(0, Math.min(0.9, composition.density)), dt * 60)) * sourceFade,
          contrast: composition.contrast,
          stereoSpread: dyn.stereoSpread,
        });
      }
      if (composition?.simulation === 'reaction-diffusion' && quality !== 'low') {
        // The chemistry nucleates on last frame's image, so bright geometry
        // grows patterns that then re-enter the feedback.
        chemistry?.render(frame, current.palette, dt * 1000, this.prevTexture, { ...target, opacity: composition.density });
      }
      if (composition?.simulation === 'physarum' && quality !== 'low') {
        // The mould senses last frame's image, so it crawls along the preset.
        mould?.render(frame, current.palette, dt * 1000, this.prevTexture, { ...target, opacity: composition.density * sourceFade });
      }
      if (composition?.emitters !== 'off') stampReactor(this, frame, current.palette, dt);

      // The preset's composite samples the feedback with mipmapped samplers.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.targetTexture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindVertexArray(savedVao);
      restoreSamplers();

      // The grade pass owns the backbuffer, so skip Butterchurn's own
      // compTexture → screen blit for this call.
      output = this.outputShader;
      outputDraw = output?.renderQuadTexture;
      if (output) output.renderQuadTexture = () => {};
      try {
        originalScreen.call(this);
        compDrawn = true;
      } finally {
        if (output && outputDraw) output.renderQuadTexture = outputDraw;
      }

      samplers.forEach((_, unit) => gl.bindSampler(unit, null));
      gradeToScreen(this, current, outputGain, outputSaturation);
      graded = true;
    } catch (err) {
      if (!reportedFailure) {
        reportedFailure = true;
        console.error('[eviland-live] a pass failed; showing the preset ungraded:', err);
      }
    } finally {
      try {
        gl.bindVertexArray(savedVao);
        gl.activeTexture(gl.TEXTURE0);
        restoreSamplers();
      } catch { /* context lost: nothing left to restore */ }
    }
    if (!graded && !gl.isContextLost()) {
      try {
        if (!compDrawn) originalScreen.call(this);
        else outputDraw?.call(output, this.compTexture);
      } catch { /* already reported */ }
    }
  };

  return {
    update(next) {
      state = next;
      scenes?.prepareScene((next.next ?? next.config._to ?? next.config).composition?.scene ?? null);
      onsets.push(...next.frame.onsets);
      if (onsets.length > 64) onsets.splice(0, onsets.length - 64);
      if (next.frame.score?.impactStart) impactStartPending = true;
      wrapWaves();
    },

    advance(dtMs) {
      pendingDt = Math.max(0, Math.min(0.1, dtMs / 1000));
    },

    contextLost: () => lost || gl.isContextLost(),

    sample() {
      if (disposed || lost) return 0;
      if (!sampleTarget) sampleTarget = sourceTarget(gl, SAMPLE_W, SAMPLE_H);
      if (!sampleTarget) return 0;
      const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
      gl.activeTexture(gl.TEXTURE0);
      const savedSampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null;
      gl.bindSampler(0, null);
      beginFullscreen(sampleTarget.framebuffer, SAMPLE_W, SAMPLE_H);
      gl.useProgram(stamp);
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, host.compTexture);
      gl.uniform1i(stampUni.src, 0);
      gl.uniform1f(stampUni.flipY, 0);
      gl.uniform1f(stampUni.useAlpha, 0);
      gl.uniform1f(stampUni.gain, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(SAMPLE_W * SAMPLE_H * 4);
      gl.readPixels(0, 0, SAMPLE_W, SAMPLE_H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindSampler(0, savedSampler);
      gl.bindVertexArray(savedVao);
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i]! + px[i + 1]! + px[i + 2]! > 36) lit += 1;
      }
      return lit / (SAMPLE_W * SAMPLE_H);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      host.renderToScreen = originalScreen;
      host.outputFXAA = originalAA;
      for (const [wave, { key, original }] of wrapped) wave[key] = original;
      wrapped.clear();
      scenes?.dispose();
      fluid?.dispose();
      chemistry?.dispose();
      mould?.dispose();
      for (const program of [...(chemistryPrograms ?? []), ...(mouldPrograms ?? [])]) gl.deleteProgram(program);
      chemistryPrograms = null; mouldPrograms = null;
      reactor?.dispose();
      gl.deleteTexture(reactorTexture);
      disposeSourceTarget(gl, scratch);
      disposeSourceTarget(gl, sampleTarget);
      gl.deleteProgram(compose);
      gl.deleteProgram(stamp);
      gl.deleteVertexArray(vao);
    },
  };
}
