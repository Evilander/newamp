// Gray–Scott substrate: persistent concentrations, fixed simulation steps, and
// seeds from the shared feedback image. Geometry can nucleate the chemistry;
// the resulting contours re-enter that same feedback on the following frame.
import type { EvilandFrame } from './eviland-audio';
import type { PaletteConfig } from './eviland-operators';
import type { SceneTarget } from './scene-overlay';
import { sourceProgram, sourceTarget, disposeSourceTarget } from './eviland-gl';

const STEP = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_state, u_feedback;
uniform float u_feed, u_kill, u_seed, u_init;
vec2 sampleState(vec2 p) { return texture(u_state, p).rg; }
void main() {
  vec2 p = v_uv;
  if (u_init > 0.5) {
    vec2 cell = floor(p * 12.0);
    float random = fract(sin(dot(cell, vec2(127.1, 311.7)) + u_seed) * 43758.5453);
    float spot = step(0.76, random) * (1.0 - smoothstep(0.10, 0.23, length(fract(p * 12.0) - 0.5)));
    o = vec4(1.0 - spot * 0.5, spot * 0.65, 0, 1); return;
  }
  vec2 px = 1.0 / vec2(textureSize(u_state, 0));
  vec2 c = sampleState(p);
  vec2 lap = -c;
  lap += 0.2 * (sampleState(p + vec2(px.x, 0)) + sampleState(p - vec2(px.x, 0))
    + sampleState(p + vec2(0, px.y)) + sampleState(p - vec2(0, px.y)));
  lap += 0.05 * (sampleState(p + px) + sampleState(p - px)
    + sampleState(p + vec2(px.x, -px.y)) + sampleState(p + vec2(-px.x, px.y)));
  float reaction = c.x * c.y * c.y;
  vec3 image = texture(u_feedback, p).rgb;
  float source = smoothstep(0.4, 0.9, max(image.r, max(image.g, image.b))) * 0.002;
  vec2 delta = vec2(lap.x - reaction + u_feed * (1.0 - c.x),
    0.5 * lap.y + reaction - (u_kill + u_feed) * c.y + source);
  o = vec4(clamp(c + delta, 0.0, 1.0), 0, 1);
}`;
const DRAW = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_state;
uniform vec3 u_dark, u_accent, u_light;
uniform float u_opacity;
void main() {
  vec2 px = 1.0 / vec2(textureSize(u_state, 0));
  float b = texture(u_state, v_uv).g;
  float edge = abs(texture(u_state, v_uv + px).g - texture(u_state, v_uv - px).g);
  float contour = exp(-abs(b - 0.22) * 38.0);
  vec3 color = mix(u_dark, u_accent, smoothstep(0.08, 0.42, b));
  color = mix(color, u_light, min(0.6, edge * 3.0 + contour * 0.25));
  float alpha = smoothstep(0.03, 0.28, b) * u_opacity;
  o = vec4(color * alpha, alpha);
}`;

// Compiles and discards the simulation's two programs so the GPU process holds
// them in its program cache. The simulation itself is created lazily, on the
// first look that uses it; with the cache warm, that no longer compiles on the
// switch frame. Call where the other programs compile, at renderer start.
export function warmReactionDiffusion(gl: WebGL2RenderingContext): void {
  if (!gl.getExtension('EXT_color_buffer_float')) return;
  for (const fragment of [STEP, DRAW]) gl.deleteProgram(sourceProgram(gl, fragment));
}

export function createReactionDiffusion(gl: WebGL2RenderingContext, seed = 1) {
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  const step = sourceProgram(gl, STEP), draw = sourceProgram(gl, DRAW);
  const a = sourceTarget(gl, 128, 96, true), b = sourceTarget(gl, 128, 96, true);
  const vao = gl.createVertexArray();
  if (!step || !draw || !a || !b || !vao) {
    gl.deleteProgram(step); gl.deleteProgram(draw); gl.deleteVertexArray(vao);
    disposeSourceTarget(gl, a); disposeSourceTarget(gl, b); return null;
  }
  let read = a, write = b, initialized = false, pending = 0;
  let feed = 0.036, kill = 0.061;
  const s = Object.fromEntries(['state','feedback','feed','kill','seed','init'].map(n => [n, gl.getUniformLocation(step, `u_${n}`)]));
  const d = Object.fromEntries(['state','dark','accent','light','opacity'].map(n => [n, gl.getUniformLocation(draw, `u_${n}`)]));
  return {
    render(frame: EvilandFrame, palette: PaletteConfig, dtMs: number, feedback: WebGLTexture, target: SceneTarget) {
      const dt = Math.max(0, Math.min(100, dtMs));
      pending += dt;
      const k = 1 - Math.exp(-dt / 2400);
      feed += (0.026 + frame.energy * 0.02 - feed) * k;
      kill += (0.055 + frame.flatness * 0.012 - kill) * k;
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST);
      gl.useProgram(step);
      gl.viewport(0, 0, read.width, read.height);
      gl.uniform1i(s.state ?? null, 0); gl.uniform1i(s.feedback ?? null, 1);
      gl.uniform1f(s.feed ?? null, feed); gl.uniform1f(s.kill ?? null, kill); gl.uniform1f(s.seed ?? null, seed % 997);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, feedback);
      // Four stable chemical updates per 60 Hz tick, independent of render cadence.
      const ticks = Math.floor((pending + 1e-6) / (1000 / 60));
      pending -= ticks * (1000 / 60);
      const iterations = ticks * 4 + (initialized ? 0 : 1);
      for (let i = 0; i < iterations; i++) {
        gl.uniform1f(s.init ?? null, initialized ? 0 : 1);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, read.texture);
        gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [read, write] = [write, read]; initialized = true;
      }
      gl.useProgram(draw);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, read.texture);
      gl.uniform1i(d.state ?? null, 0);
      for (const name of ['dark','accent','light'] as const) gl.uniform3fv(d[name] ?? null, palette[name]);
      gl.uniform1f(d.opacity ?? null, 1 - Math.pow(1 - (target.opacity ?? 0.3), dt * 0.06));
      gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteProgram(step); gl.deleteProgram(draw); gl.deleteVertexArray(vao);
      disposeSourceTarget(gl, a); disposeSourceTarget(gl, b);
    },
  };
}
