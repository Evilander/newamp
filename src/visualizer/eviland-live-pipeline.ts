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
import { createReactionDiffusion } from './eviland-reaction-diffusion';
import { createReactorOverlay } from './reactor-overlay';
import { createSceneOverlay } from './scene-overlay';
import { createFluidSim, createFluidForceSource, dyeDissipationFromFrame } from './eviland-fluid';
import { createDynamics, evalConfig, type OperatorConfig, type PaletteConfig, type WaveOverride } from './eviland-operators';
import { sourceProgram, sourceTarget, disposeSourceTarget, type SourceTarget } from './eviland-gl';
import { applyScoreCues } from './eviland-conductor';

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
export interface LiveCompositionFrame {
  frame: EvilandFrame;
  palette: PaletteConfig;
  config: OperatorConfig;
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
  dispose(): void;
}

// Pass A (dynamics): bends the feedback image along the simulated fluid and
// folds dye into it. Pass B (grade): palette + bloom on the preset's composite.
const COMPOSE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_image, u_velocity, u_dye;
uniform vec3 u_dark, u_accent, u_light, u_bg;
uniform float u_dt, u_fluid, u_dyeMix, u_grade, u_bloom, u_gain, u_saturation;
// Saturated pixels land between dark and accent, washed-out ones between
// accent and light; brightness is kept, so the preset's detail survives.
vec3 grade(vec3 c) {
  float peak = max(c.r, max(c.g, c.b));
  float position = clamp(dot(c, vec3(0.22, 0.55, 0.23)) / max(peak, 0.001), 0.0, 1.0);
  vec3 tint = position < 0.55 ? mix(u_dark, u_accent, position / 0.55)
    : mix(u_accent, u_light, (position - 0.55) / 0.45);
  tint /= max(0.001, max(tint.r, max(tint.g, tint.b)));
  return mix(u_bg * 0.08, tint * peak, smoothstep(0.0, 0.08, peak));
}
void main() {
  vec2 uv = clamp(v_uv - texture(u_velocity, v_uv).xy * u_dt * u_fluid, 0.001, 0.999);
  vec3 c = texture(u_image, uv).rgb;
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
  o = vec4(c, 1.0);
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
const SAMPLE_W = 48;
const SAMPLE_H = 27;

export function createEvilandLivePipeline(
  visualizer: unknown,
  quality: 'high' | 'medium' | 'low',
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
    'image', 'velocity', 'dye', 'dark', 'accent', 'light', 'bg', 'dt', 'fluid', 'dyeMix', 'grade', 'bloom', 'gain', 'saturation',
  ] as const);
  const stampUni = uniformsOf(stamp, ['src', 'gain', 'flipY', 'useAlpha'] as const);

  // 'low' keeps MilkDrop + reactor events + the grade and skips every
  // full-screen source, matching the old stack's weak-GPU floor.
  const scenes = quality === 'low' ? null : createSceneOverlay(gl.canvas as HTMLCanvasElement, { gl, quality });
  const fluid = quality === 'low'
    ? null
    : createFluidSim(gl, { width: 96, height: 64, pressureIterations: quality === 'high' ? 10 : 6 });
  const forceSource = createFluidForceSource();
  const dyn = createDynamics();
  let chemistry: ReturnType<typeof createReactionDiffusion> = null;

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

  /** Pass A: advect the feedback along the fluid and fold dye in. */
  function applyFluid(h: MilkdropFeedbackHost, dt: number): void {
    if (!fluid || (dyn.fluid <= 0.0005 && dyn.liquidMix <= 0.0005)) return;
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
    gl.uniform1f(composeUni.fluid, dyn.fluid);
    gl.uniform1f(composeUni.dyeMix, dyn.liquidMix);
    gl.uniform1f(composeUni.grade, 0);
    gl.uniform1f(composeUni.bloom, 0);
    gl.uniform1f(composeUni.gain, 1);
    gl.uniform1f(composeUni.saturation, 1);
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
    }
    reactor.render(frame, palette, dt * 1000);
    beginFullscreen(h.targetFrameBuffer, h.texsizeX, h.texsizeY);
    gl.useProgram(stamp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, reactorTexture);
    // Butterchurn only ever sets this to true right before its own title
    // upload, so pinning the default here can't disturb it.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, reactorCanvas);
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
    gl.uniform1f(composeUni.grade, Math.max(0, Math.min(1, current.grade ?? 1)));
    gl.uniform1f(composeUni.bloom, Math.max(0, dyn.bloom));
    gl.uniform1f(composeUni.gain, gain);
    gl.uniform1f(composeUni.saturation, saturation);
    for (const name of ['dark', 'accent', 'light', 'bg'] as const) gl.uniform3fv(composeUni[name], current.palette[name]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  host.renderToScreen = function (this: MilkdropFeedbackHost) {
    const current = state;
    if (disposed || !current || pendingDt <= 0) {
      originalScreen.call(this);
      return;
    }
    const dt = pendingDt;
    pendingDt = 0;
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

    const cues = current.frame.score;
    const frame: EvilandFrame = {
      ...current.frame,
      onsets,
      score: cues ? { ...cues, impactStart: impactStartPending } : undefined,
    };
    onsets = [];
    impactStartPending = false;
    evalConfig(current.config, frame, frame.sectionId, dyn, dt * 1000);
    // MilkDrop's own warp isn't ours to bend, so in Live the cues act through
    // what is: the fluid (inward pull, then the shockwave), how much of the
    // scene is laid in, the reactor events, and the final grade.
    const cueGain = applyScoreCues(dyn, frame.score);
    const outputGain = cueGain.output;
    const outputSaturation = cueGain.saturation;
    const sourceFade = frame.score ? (1 - 0.5 * frame.score.anticipation) * (1 - frame.score.blackout) : 1;

    gl.bindVertexArray(vao);
    fluid?.step(dt, forceSource.forces(frame, current.palette, dt), {
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
      });
    }
    if (composition?.simulation === 'reaction-diffusion') {
      if (!chemistry) chemistry = createReactionDiffusion(gl);
      // The chemistry nucleates on last frame's image, so bright geometry
      // grows patterns that then re-enter the feedback.
      chemistry?.render(frame, current.palette, dt * 1000, this.prevTexture, { ...target, opacity: composition.density });
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
    const output = this.outputShader;
    const outputDraw = output?.renderQuadTexture;
    if (output) output.renderQuadTexture = () => {};
    try {
      originalScreen.call(this);
    } finally {
      if (output && outputDraw) output.renderQuadTexture = outputDraw;
    }

    samplers.forEach((_, unit) => gl.bindSampler(unit, null));
    gradeToScreen(this, current, outputGain, outputSaturation);
    gl.bindVertexArray(savedVao);
    gl.activeTexture(gl.TEXTURE0);
    restoreSamplers();
  };

  return {
    update(next) {
      state = next;
      onsets.push(...next.frame.onsets);
      if (onsets.length > 64) onsets.splice(0, onsets.length - 64);
      if (next.frame.score?.impactStart) impactStartPending = true;
      wrapWaves();
    },

    advance(dtMs) {
      pendingDt = Math.max(0, Math.min(0.1, dtMs / 1000));
    },

    sample() {
      if (disposed) return 0;
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
      host.renderToScreen = originalScreen;
      host.outputFXAA = originalAA;
      for (const [wave, { key, original }] of wrapped) wave[key] = original;
      wrapped.clear();
      scenes?.dispose();
      fluid?.dispose();
      chemistry?.dispose();
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
