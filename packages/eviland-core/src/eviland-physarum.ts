// Physarum transport networks, after Jones (2010): agents sense a diffusing
// chemoattractant ahead of them, turn toward the strongest reading, step, and
// deposit more of it. Three species share the trail map, one channel each;
// each follows its own channel and shies from the other two, so rival networks
// grow, meet and hold borders. Agents also smell the previous visible frame,
// so the mold crawls along whatever the visualizer is already showing.
import type { EvilandFrame } from './eviland-audio';
import type { PaletteConfig, RGB } from './eviland-operators';
import type { SceneTarget } from './scene-overlay';
import { sourceProgram, sourceTarget, disposeSourceTarget, type SourceTarget } from './eviland-gl';
import { mulberry32 } from './eviland-rng';

const STEP = `#version 300 es
precision highp float;
precision highp int;
out vec4 o;
uniform highp sampler2D u_agents;
uniform sampler2D u_trail, u_feedback;
uniform float u_speed, u_reach, u_angle, u_turn, u_jitter, u_repel;
uniform vec2 u_appetite; // feedback brightness: multiplies the smell (x), adds to it (y)
uniform vec4 u_sprout; // x, y, radius, share of agents re-seeded there this tick
uniform uint u_tick, u_seed;
// Trail level an agent is happiest in. Crowding past it stands in for Jones'
// one-agent-per-cell exclusion: without that, every species collapses into a
// few fat loops, and a response that plateaus lets them settle into sheets.
const float CAP = 0.5;
// Small per-species differences in sensor angle, reach and pace. Wider spreads
// pushed the outliers into sheets that never resolved into veins.
const vec3 ANGLE = vec3(1.0, 1.1, 0.95);
const vec3 REACH = vec3(1.15, 1.0, 1.05);
const vec3 PACE = vec3(0.9, 1.0, 1.1);
uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float random(inout uint state) { state = hash(state); return float(state >> 8) / 16777216.0; }
float smell(vec2 p, int species) {
  vec3 t = textureLod(u_trail, p, 0.0).rgb / CAP;
  float own = t[species], others = t.r + t.g + t.b - own;
  // Explicit LOD: neighbouring agents sit at unrelated positions, so an
  // implicit derivative picks a coarse mip. MilkDrop's feedback in Eviland
  // Live is mipmapped, and there the mould smelled a blur, not the preset.
  vec3 seen = textureLod(u_feedback, fract(p), 0.0).rgb;
  float bright = min(1.5, max(seen.r, max(seen.g, seen.b)));
  float crowd = own - 2.0 * pow(max(0.0, own - 1.0), 2.0);
  return crowd * (1.0 + u_appetite.x * bright) + u_appetite.y * bright - u_repel * min(others, 2.0);
}
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec4 agent = texelFetch(u_agents, cell, 0);
  int species = int(agent.w);
  uint state = hash(uint(cell.x) | uint(cell.y) << 12u) ^ hash(u_tick * 0x9e3779b9u + u_seed);
  vec2 size = vec2(textureSize(u_trail, 0));
  if (random(state) < u_sprout.w) {
    float a = random(state) * 6.2831853, r = u_sprout.z * sqrt(random(state));
    o = vec4(fract(u_sprout.xy + vec2(cos(a) * size.y / size.x, sin(a)) * r), random(state) * 6.2831853, agent.w);
    return;
  }
  vec2 reach = u_reach * REACH[species] / size;
  float angle = u_angle * ANGLE[species], h = agent.z;
  float f = smell(agent.xy + vec2(cos(h), sin(h)) * reach, species);
  float l = smell(agent.xy + vec2(cos(h + angle), sin(h + angle)) * reach, species);
  float r = smell(agent.xy + vec2(cos(h - angle), sin(h - angle)) * reach, species);
  float turn = u_turn * (0.5 + random(state));
  if (f > l && f > r) {}
  else if (f < l && f < r) h += random(state) < 0.5 ? turn : -turn;
  else if (l > r) h += turn;
  else if (r > l) h -= turn;
  h += (random(state) - 0.5) * u_jitter;
  float pace = u_speed * PACE[species] * (0.8 + 0.4 * fract(agent.w));
  vec2 p = fract(agent.xy + vec2(cos(h), sin(h)) * pace / size);
  o = vec4(p, mod(h, 6.2831853), agent.w);
}`;
// One point per agent, fetched by gl_VertexID; no attributes.
const DEPOSIT_VERTEX = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_agents;
uniform float u_deposit;
out vec3 v_amount;
void main() {
  int width = textureSize(u_agents, 0).x;
  vec4 agent = texelFetch(u_agents, ivec2(gl_VertexID % width, gl_VertexID / width), 0);
  v_amount = vec3(equal(ivec3(int(agent.w)), ivec3(0, 1, 2))) * u_deposit;
  gl_Position = vec4(agent.xy * 2.0 - 1.0, 0, 1);
  gl_PointSize = 1.0;
}`;
const DEPOSIT = `#version 300 es
precision highp float;
in vec3 v_amount;
out vec4 o;
void main() { o = vec4(v_amount, 0); }`;
// Four bilinear taps at half-texel offsets are a 3x3 [1 2 1] tent blur.
const DIFFUSE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_trail;
uniform float u_decay, u_diffuse;
void main() {
  vec2 h = 0.5 / vec2(textureSize(u_trail, 0));
  vec3 c = texture(u_trail, v_uv).rgb;
  vec3 blur = 0.25 * (texture(u_trail, v_uv + h).rgb + texture(u_trail, v_uv - h).rgb
    + texture(u_trail, v_uv + vec2(h.x, -h.y)).rgb + texture(u_trail, v_uv + vec2(-h.x, h.y)).rgb);
  o = vec4(min(mix(c, blur, u_diffuse) * u_decay, vec3(64)), 1);
}`;
const DRAW = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_trail;
uniform vec3 u_colors[3];
uniform float u_low, u_gain, u_flash, u_opacity;
// Trail level along the middle of a busy vein (about twice the agents' CAP).
const float VEIN = 0.95;
const vec2 RING[6] = vec2[6](vec2(1, 0), vec2(0.5, 0.866), vec2(-0.5, 0.866),
  vec2(-1, 0), vec2(-0.5, -0.866), vec2(0.5, -0.866));
void main() {
  vec2 px = 1.0 / vec2(textureSize(u_trail, 0));
  // A tent-filtered core sample: single-texel deposits read as grain once
  // the field is magnified to the screen.
  vec3 t = 0.25 * (texture(u_trail, v_uv + px * 0.5).rgb + texture(u_trail, v_uv - px * 0.5).rgb
    + texture(u_trail, v_uv + px * vec2(0.5, -0.5)).rgb + texture(u_trail, v_uv + px * vec2(-0.5, 0.5)).rgb) / VEIN;
  vec3 halo = vec3(0);
  for (int i = 0; i < 6; i++) halo += texture(u_trail, v_uv + RING[i] * px * 2.5).rgb;
  halo /= 6.0 * VEIN;
  // Bright cores that fall off softly across each vein, over a faint halo; an
  // empty trail stays transparent. The busiest trunks run white-hot.
  vec3 core = smoothstep(u_low, 1.0, t);
  vec3 w = max(core * core, smoothstep(0.1, 0.8, halo) * 0.3) * u_gain;
  float alpha = min(1.0, 1.0 - (1.0 - w.r) * (1.0 - w.g) * (1.0 - w.b));
  vec3 color = u_colors[0] * w.r + u_colors[1] * w.g + u_colors[2] * w.b;
  color += alpha * (0.35 * smoothstep(0.9, 1.6, max(t.r, max(t.g, t.b))) + 0.25 * u_flash);
  o = vec4(min(color, vec3(alpha * 1.3)), alpha) * u_opacity;
}`;

type Quality = 'high' | 'medium' | 'low';
// Agent texture and trail map sizes, 0.4-0.5 agents per trail texel on every
// tier. Reach and speed are in texels, so a lower tier grows the same network
// drawn coarser; scaling them to keep screen size shifts the per-texel decay
// balance and the colonies stall as sheets.
const SIZES: Record<Quality, [number, number, number, number]> = {
  high: [256, 256, 480, 270], medium: [256, 128, 384, 216], low: [128, 128, 256, 144],
};
const TICK = 1000 / 60;
const MAX_TICKS = 4;

function pointProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  const shaders: WebGLShader[] = [];
  for (const [kind, code] of [[gl.VERTEX_SHADER, DEPOSIT_VERTEX], [gl.FRAGMENT_SHADER, DEPOSIT]] as const) {
    const shader = gl.createShader(kind);
    if (!shader) break;
    shaders.push(shader);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error('[eviland] physarum shader:', gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  if (shaders.length === 2) gl.linkProgram(program);
  for (const shader of shaders) gl.deleteShader(shader);
  if (shaders.length < 2 || !gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
  return program;
}

// 32-bit float state: half floats cannot hold a sub-texel step at x near 1.
// Unfilterable without an extension, so NEAREST and texelFetch only.
function agentTarget(gl: WebGL2RenderingContext, width: number, height: number, data: Float32Array | null): SourceTarget | null {
  const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) { gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer); return null; }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer); return null;
  }
  return { texture, framebuffer, width, height };
}

// Six to eight colonies around the middle of the field, one species each,
// heading outward, so the network visibly grows in the first seconds. Discs
// only: a ring colony lays a circular trail, a stable racetrack that never
// resolves into a network. Agent = (x, y, heading, species + per-agent random).
function seedAgents(count: number, aspect: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  const colonyCount = 6 + Math.floor(random() * 3), turn = random() * Math.PI * 2;
  const colonies = Array.from({ length: colonyCount }, (_, i) => {
    const angle = turn + (i + random() * 0.5) * Math.PI * 2 / colonyCount, distance = 0.14 + random() * 0.22;
    return { x: 0.5 + Math.cos(angle) * distance, y: 0.5 + Math.sin(angle) * distance * 1.2, radius: 0.06 + random() * 0.05 };
  });
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const species = i % 3;
    const colony = colonies[species + 3 * Math.floor(random() * Math.ceil((colonyCount - species) / 3))]!;
    const angle = random() * Math.PI * 2;
    const r = colony.radius * Math.sqrt(random());
    data[i * 4] = (colony.x + Math.cos(angle) * r / aspect + 1) % 1;
    data[i * 4 + 1] = (colony.y + Math.sin(angle) * r + 1) % 1;
    data[i * 4 + 2] = angle + (random() - 0.5) * 0.8;
    data[i * 4 + 3] = species + random() * 0.999;
  }
  return data;
}

// Palette dark is dark by design, and a dark species would be invisible veins,
// so each colour is lifted to a working brightness with its hue kept.
function lift(rgb: RGB, level: number, out: Float32Array, offset: number): void {
  const peak = Math.max(rgb[0], rgb[1], rgb[2], 0.02);
  for (let i = 0; i < 3; i++) out[offset + i] = rgb[i]! / peak * level;
}

// Retained until first use, then owned by the simulation.
export function preparePhysarum(gl: WebGL2RenderingContext) {
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  return [sourceProgram(gl, STEP), pointProgram(gl), sourceProgram(gl, DIFFUSE), sourceProgram(gl, DRAW)] as const;
}

/** Warm the driver cache without transferring resource ownership (legacy API). */
export function warmPhysarum(gl: WebGL2RenderingContext): void {
  for (const program of preparePhysarum(gl) ?? []) gl.deleteProgram(program);
}

export function createPhysarum(gl: WebGL2RenderingContext, seed = 1, quality: Quality = 'high', prepared?: readonly [WebGLProgram | null, WebGLProgram | null, WebGLProgram | null, WebGLProgram | null] | null) {
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  const [agentW, agentH, trailW, trailH] = SIZES[quality];
  const count = agentW * agentH;
  const [step, deposit, diffuse, draw] = prepared ?? [sourceProgram(gl, STEP), pointProgram(gl), sourceProgram(gl, DIFFUSE), sourceProgram(gl, DRAW)];
  const agentA = agentTarget(gl, agentW, agentH, seedAgents(count, trailW / trailH, seed >>> 0));
  const agentB = agentTarget(gl, agentW, agentH, null);
  const trailA = sourceTarget(gl, trailW, trailH, true), trailB = sourceTarget(gl, trailW, trailH, true);
  const vao = gl.createVertexArray();
  if (!step || !deposit || !diffuse || !draw || !agentA || !agentB || !trailA || !trailB || !vao) {
    for (const program of [step, deposit, diffuse, draw]) gl.deleteProgram(program);
    for (const target of [agentA, agentB, trailA, trailB]) disposeSourceTarget(gl, target);
    gl.deleteVertexArray(vao); return null;
  }
  // The field is a torus: agents wrap, and so do the blur and the sensing.
  for (const trail of [trailA, trailB]) {
    gl.bindTexture(gl.TEXTURE_2D, trail.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }
  let agents = agentA, nextAgents = agentB, trail = trailA, nextTrail = trailB;
  let pending = 0, tick = 0;
  let energy = 0, bass = 0, hat = 0, vocal = 0, kickSlow = 0, snareSlow = 0, flinch = 0, flash = 0;
  // New colonies: a section change, or failing that a slow clock, re-seeds a
  // share of the agents at a fresh spot, so the network keeps branching
  // instead of coarsening into a few long lanes.
  const random = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  let sproutIn = 9000 + random() * 6000, sprout = 0;
  const colors = new Float32Array(9);
  const s = Object.fromEntries(['agents','trail','feedback','speed','reach','angle','turn','jitter','repel','appetite','sprout','tick','seed'].map(n => [n, gl.getUniformLocation(step, `u_${n}`)]));
  const p = Object.fromEntries(['agents','deposit'].map(n => [n, gl.getUniformLocation(deposit, `u_${n}`)]));
  const f = Object.fromEntries(['trail','decay','diffuse'].map(n => [n, gl.getUniformLocation(diffuse, `u_${n}`)]));
  const d = Object.fromEntries(['trail','colors','low','gain','flash','opacity'].map(n => [n, gl.getUniformLocation(draw, `u_${n}`)]));
  return {
    render(frame: EvilandFrame, palette: PaletteConfig, dtMs: number, feedback: WebGLTexture, target: SceneTarget) {
      const dt = Math.max(0, Math.min(100, dtMs));
      pending += dt;
      const k = 1 - Math.exp(-dt / 180), slow = 1 - Math.exp(-dt / 600);
      energy += (frame.energy - energy) * k; bass += (frame.bass - bass) * k;
      hat += (frame.hat - hat) * k; vocal += (frame.vocal - vocal) * k;
      // Hits land as impulses: detected onsets, or an envelope jumping above
      // its own slow average. A steady envelope is not a hit.
      kickSlow += (frame.kick - kickSlow) * slow; snareSlow += (frame.snare - snareSlow) * slow;
      flinch = Math.max(flinch, (frame.kick - kickSlow) * 2); flash = Math.max(flash, (frame.snare - snareSlow) * 2);
      for (const onset of frame.onsets) {
        if (onset.group === 'kick') flinch = Math.max(flinch, 0.4 + onset.intensity * 0.6);
        else if (onset.group === 'snare') flash = Math.max(flash, 0.4 + onset.intensity * 0.6);
      }
      flinch = Math.min(1, flinch); flash = Math.min(1, flash);
      sproutIn -= dt;
      if (frame.sectionChanged) sprout = Math.max(sprout, 0.15);
      else if (sproutIn <= 0) sprout = Math.max(sprout, 0.06);
      if (sprout > 0) sproutIn = 9000 + random() * 6000;

      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST);
      gl.useProgram(step);
      gl.uniform1i(s.agents ?? null, 0); gl.uniform1i(s.trail ?? null, 1); gl.uniform1i(s.feedback ?? null, 2);
      gl.uniform1f(s.reach ?? null, 7);
      gl.uniform1f(s.turn ?? null, 0.5);
      gl.uniform1f(s.jitter ?? null, 0.06 + hat * 0.8);
      gl.uniform1f(s.repel ?? null, 0.6);
      gl.uniform2f(s.appetite ?? null, 0.8 + vocal * 1.5, 0.05 + vocal * 0.3);
      gl.uniform1ui(s.seed ?? null, seed >>> 0);
      gl.useProgram(deposit);
      gl.uniform1i(p.agents ?? null, 0);
      gl.uniform1f(p.deposit ?? null, 0.035 * (0.6 + bass));
      gl.useProgram(diffuse);
      gl.uniform1i(f.trail ?? null, 0);
      gl.uniform1f(f.diffuse ?? null, 0.25);
      // Fixed 60 Hz ticks, independent of render cadence. A hitch longer than
      // MAX_TICKS drops the excess instead of spiralling into catch-up.
      let ticks = Math.floor((pending + 1e-6) / TICK);
      pending -= ticks * TICK;
      ticks = Math.min(ticks, MAX_TICKS);
      for (let i = 0; i < ticks; i++, tick++) {
        // Move: every agent senses left, ahead and right, turns, and steps. A
        // kick speeds the network up and widens its sensors, so it flinches
        // and re-routes.
        gl.useProgram(step);
        gl.bindFramebuffer(gl.FRAMEBUFFER, nextAgents.framebuffer);
        gl.viewport(0, 0, agentW, agentH);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, agents.texture);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, trail.texture);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, feedback);
        gl.uniform1f(s.speed ?? null, (0.45 + energy * 1.1) * (1 + flinch * 1.4));
        gl.uniform1f(s.angle ?? null, 0.55 * (1 + flinch * 1.2));
        gl.uniform1ui(s.tick ?? null, tick >>> 0);
        gl.uniform4f(s.sprout ?? null, 0.15 + random() * 0.7, 0.15 + random() * 0.7, 0.08, sprout);
        sprout = 0;
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [agents, nextAgents] = [nextAgents, agents];
        // Deposit: one additive point per agent, into its species' channel;
        // bass lays more, so veins thicken. Half-float blending only: 32-bit
        // float blending would need EXT_float_blend.
        gl.useProgram(deposit);
        gl.bindFramebuffer(gl.FRAMEBUFFER, trail.framebuffer);
        gl.viewport(0, 0, trailW, trailH);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, agents.texture);
        gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.disable(gl.BLEND);
        // Diffuse and decay; a snare drops the decay so trails flash and clear.
        gl.useProgram(diffuse);
        gl.bindFramebuffer(gl.FRAMEBUFFER, nextTrail.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, trail.texture);
        gl.uniform1f(f.decay ?? null, 0.93 - flash * 0.08);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [trail, nextTrail] = [nextTrail, trail];
        flinch *= Math.exp(-TICK / 150); flash *= Math.exp(-TICK / 220);
      }

      gl.useProgram(draw);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trail.texture);
      gl.uniform1i(d.trail ?? null, 0);
      lift(palette.dark, 0.85, colors, 0); lift(palette.accent, 0.95, colors, 3); lift(palette.light, 1, colors, 6);
      gl.uniform3fv(d.colors ?? null, colors);
      gl.uniform1f(d.low ?? null, 0.4 - bass * 0.15);
      gl.uniform1f(d.gain ?? null, (0.6 + energy * 0.4) * (1 + flash * 0.3));
      gl.uniform1f(d.flash ?? null, flash);
      gl.uniform1f(d.opacity ?? null, 1 - Math.pow(1 - Math.min(0.95, Math.max(0, target.opacity ?? 0.3)), dt * 0.06));
      gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // The feedback texture is the caller's next render target; leave no
      // unit pointing at it.
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    },
    dispose() {
      for (const program of [step, deposit, diffuse, draw]) gl.deleteProgram(program);
      for (const target of [agentA, agentB, trailA, trailB]) disposeSourceTarget(gl, target);
      gl.deleteVertexArray(vao);
    },
  };
}
