// Eviland fluid simulation — GPU stable-fluids solver + pure audio→force seam.
//
// Eviland's feedback field advects dye through a *procedural* velocity (curl
// noise + zoom/rotate/swirl). That reads as warp, not fluid: there is no
// simulated velocity state, so a kick can recolor the scene but never *push*
// it — no momentum, no force memory, no incompressibility. This module adds a
// real solver in the Stam "Stable Fluids" family (the same math as the
// well-known WebGL fluid implementations / GPU Gems ch. 38): a coarse RG16F
// velocity grid that self-advects (semi-Lagrangian), receives audio impulses
// as Gaussian splats, gets its small-scale swirl restored by vorticity
// confinement, and is made (approximately) divergence-free each step by a
// Jacobi pressure projection. The renderer samples `velocityTexture()` in the
// dye pass so simulated momentum composes with the procedural warp.
//
// Two exports:
//   - fluidForcesFromFrame — pure, Node-testable mapping from an EvilandFrame
//     to a bounded list of impulses (kick=shockwave, snare=jet, hats=top
//     turbulence, bass/pan=shear+bias, pre-beat inhale).
//   - createFluidSim — the GL solver. Self-contained like particle-flow.ts
//     (local compile/link helpers); returns null when float render targets are
//     unsupported so callers fall back to the procedural-only path.

import type { EvilandFrame } from './eviland-audio';

// ---------------------------------------------------------------------------
// Pure audio → impulse seam (no GL; unit-tested by scripts/eviland-fluid-test).
// ---------------------------------------------------------------------------

export interface FluidForce {
  x: number; y: number;      // splat center, UV space
  dx: number; dy: number;    // impulse (UV/s, pre-clamped)
  radius: number;            // splat radius, UV space
}

export const MAX_FLUID_FORCES = 16;

const KICK_SPOKES = 6;
const KICK_STRENGTH = 0.55;
const SNARE_STRENGTH = 0.7;
const HAT_STRENGTH = 0.12;
const BASS_SHEAR = 0.05;
const PAN_BIAS = 0.04;
const INHALE_STRENGTH = 0.10;
const INHALE_SPOKES = 4;

let snareSide = 1; // alternates per snare onset so jets trade sides

export function fluidForcesFromFrame(frame: EvilandFrame): FluidForce[] {
  const out: FluidForce[] = [];
  const push = (f: FluidForce) => { if (out.length < MAX_FLUID_FORCES) out.push(f); };

  // Baseline: bass shear along the bottom + pan bias (spatial truth).
  if (frame.bass > 0.05) {
    push({ x: 0.5, y: 0.15, dx: BASS_SHEAR * frame.bass * (frame.pan >= 0 ? 1 : -1), dy: 0, radius: 0.35 });
  }
  if (Math.abs(frame.pan) > 0.05) {
    push({ x: 0.5, y: 0.5, dx: PAN_BIAS * frame.pan, dy: 0, radius: 0.45 });
  }

  for (const onset of frame.onsets) {
    if (onset.group === 'kick') {
      // Radial shockwave: KICK_SPOKES outward impulses around a low-center anchor.
      const ax = 0.5 + frame.pan * 0.2;
      const ay = 0.3;
      const s = KICK_STRENGTH * onset.intensity;
      for (let i = 0; i < KICK_SPOKES; i++) {
        const a = (i / KICK_SPOKES) * Math.PI * 2;
        push({ x: ax + Math.cos(a) * 0.04, y: ay + Math.sin(a) * 0.04, dx: Math.cos(a) * s, dy: Math.sin(a) * s, radius: 0.12 });
      }
    } else if (onset.group === 'snare') {
      // One sharp angled jet, alternating sides.
      snareSide = -snareSide;
      const jx = 0.5 + snareSide * 0.22;
      const s = SNARE_STRENGTH * onset.intensity;
      push({ x: jx, y: 0.55, dx: -snareSide * s * 0.8, dy: s * 0.5, radius: 0.06 });
    } else if (onset.group === 'hat') {
      // Top-edge micro-turbulence: two small lateral jitters (deterministic from band).
      const s = HAT_STRENGTH * onset.intensity;
      const seedX = 0.2 + ((onset.band * 37) % 13) / 20;
      push({ x: seedX, y: 0.85, dx: s, dy: -s * 0.3, radius: 0.03 });
      push({ x: 1 - seedX, y: 0.88, dx: -s, dy: -s * 0.2, radius: 0.03 });
    }
    // vocal/bass-group onsets: covered by the envelope baselines; no extra splat.
  }

  // Anticipation: just before a confident beat, the scene inhales (inward pull).
  if (frame.bpm > 1 && frame.beatConfidence > 0.6 && frame.beatPhase > 0.85) {
    for (let i = 0; i < INHALE_SPOKES; i++) {
      const a = (i / INHALE_SPOKES) * Math.PI * 2 + 0.4;
      const px = 0.5 + Math.cos(a) * 0.3;
      const py = 0.5 + Math.sin(a) * 0.3;
      push({ x: px, y: py, dx: -Math.cos(a) * INHALE_STRENGTH, dy: -Math.sin(a) * INHALE_STRENGTH, radius: 0.18 });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// GL solver.
// ---------------------------------------------------------------------------

export interface FluidSimOptions {
  width: number;              // sim grid width (fraction of field res, chosen by caller)
  height: number;             // sim grid height
  pressureIterations: number; // Jacobi iterations per step
}

export interface FluidSim {
  step(dt: number, forces: FluidForce[], params: { vorticity: number; dissipation: number }): void;
  /** Current velocity texture (RG16F, UV-space units per second). */
  velocityTexture(): WebGLTexture;
  resize(width: number, height: number): void;
  dispose(): void;
}

// Velocity is stored in UV/s so the consumer (the dye pass) can displace its
// sampling coordinate by `velocity * dt` with no unit conversion. The finite
// difference shaders (curl/divergence/pressure/gradient) work in per-texel
// units via u_texelSize — the standard convention of the WebGL fluid family;
// CLAMP_TO_EDGE sampling provides the (approximate, free-slip-ish) boundary.

const QUAD_VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Pass 1 — semi-Lagrangian self-advection (Stam). Velocity is in UV/s, so the
// backtrace offset is simply v*dt (no texel conversion). Dissipation is the
// per-step decay that keeps total energy bounded.
const ADVECT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_velocity;
uniform float u_dt;
uniform float u_dissipation;
void main(){
  vec2 coord = v_uv - texture(u_velocity, v_uv).xy * u_dt;
  o = vec4(texture(u_velocity, coord).xy * u_dissipation, 0.0, 1.0);
}`;

// Pass 2 — force splat. Additive Gaussian impulse: base + force·exp(−|p|²/r²).
// Blending stays OFF; the "additive" comes from reading the previous ping.
// p is kept in raw UV (no aspect correction) so the seam's UV-space radii and
// directions mean exactly what fluidForcesFromFrame says they mean.
const SPLAT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_velocity;
uniform vec2 u_point;   // splat center, UV
uniform vec2 u_force;   // impulse, UV/s
uniform float u_radius; // splat radius, UV
void main(){
  vec2 p = v_uv - u_point;
  vec2 v = texture(u_velocity, v_uv).xy + u_force * exp(-dot(p, p) / (u_radius * u_radius));
  o = vec4(v, 0.0, 1.0);
}`;

// Pass 3 — scalar curl of velocity: ω = ∂v/∂x − ∂u/∂y, central differences
// with half-rdx = 0.5 at grid spacing h = 1 texel.
const CURL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_velocity;
uniform vec2 u_texelSize;
void main(){
  float L = texture(u_velocity, v_uv - vec2(u_texelSize.x, 0.0)).y;
  float R = texture(u_velocity, v_uv + vec2(u_texelSize.x, 0.0)).y;
  float B = texture(u_velocity, v_uv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_velocity, v_uv + vec2(0.0, u_texelSize.y)).x;
  o = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`;

// Pass 4 — vorticity confinement (Fedkiw et al.): f = ε(N × ω) with
// N = ∇|ω| / |∇|ω||. It re-injects the small-scale swirl that the
// semi-Lagrangian advection's numerical dissipation smears away. In 2D the
// vorticity is ω ẑ, so N × ωẑ = ω · (N.y, −N.x). ε is u_vorticity (the
// per-look channel) and the force integrates over u_dt like any acceleration.
// The 1e-5 guard keeps N finite where |∇|ω|| ≈ 0 (flat curl ⇒ no confinement).
const VORTICITY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_velocity;
uniform sampler2D u_curl;
uniform vec2 u_texelSize;
uniform float u_vorticity;
uniform float u_dt;
void main(){
  float L = texture(u_curl, v_uv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_curl, v_uv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_curl, v_uv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_curl, v_uv + vec2(0.0, u_texelSize.y)).x;
  float c = texture(u_curl, v_uv).x;
  vec2 grad = 0.5 * vec2(abs(R) - abs(L), abs(T) - abs(B)); // ∇|ω|
  vec2 N = grad / (length(grad) + 1e-5);
  vec2 force = u_vorticity * c * vec2(N.y, -N.x);           // ε(N × ω)
  o = vec4(texture(u_velocity, v_uv).xy + force * u_dt, 0.0, 1.0);
}`;

// Pass 5 — divergence of velocity: ∇·u with half-rdx = 0.5, h = 1 texel.
const DIVERGENCE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_velocity;
uniform vec2 u_texelSize;
void main(){
  float L = texture(u_velocity, v_uv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_velocity, v_uv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_velocity, v_uv - vec2(0.0, u_texelSize.y)).y;
  float T = texture(u_velocity, v_uv + vec2(0.0, u_texelSize.y)).y;
  o = vec4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
}`;

// Pass 6 — Jacobi iteration for the pressure Poisson equation ∇²p = ∇·u.
// 5-point Laplacian at grid spacing h = 1 texel gives (GPU Gems ch. 38):
//   p' = (pL + pR + pB + pT + α·div) · rβ,  α = −h² = −1,  rβ = 1/4
// i.e. p' = (pL + pR + pB + pT − div) / 4. Run N times from a zero guess.
const PRESSURE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
uniform vec2 u_texelSize;
void main(){
  float L = texture(u_pressure, v_uv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_pressure, v_uv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_pressure, v_uv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_pressure, v_uv + vec2(0.0, u_texelSize.y)).x;
  float div = texture(u_divergence, v_uv).x;
  o = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;

// Pass 7 — projection: u' = u − ∇p with the same half-rdx = 0.5 stencil as
// the divergence pass (consistent operators ⇒ div(u') ≈ 0). This is what
// makes the motion read as liquid: momentum has to go *around*, not vanish.
const GRADIENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_pressure;
uniform sampler2D u_velocity;
uniform vec2 u_texelSize;
void main(){
  float L = texture(u_pressure, v_uv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_pressure, v_uv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_pressure, v_uv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_pressure, v_uv + vec2(0.0, u_texelSize.y)).x;
  vec2 v = texture(u_velocity, v_uv).xy - 0.5 * vec2(R - L, T - B);
  o = vec4(v, 0.0, 1.0);
}`;

// ---- GL helpers (small local copies; module is self-contained like particle-flow.ts) ----

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[newamp] eviland-fluid shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[newamp] eviland-fluid program link failed:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

export function createFluidSim(gl: WebGL2RenderingContext, opts: FluidSimOptions): FluidSim | null {
  // Float color attachments are required for the velocity/pressure targets.
  const floatExt = gl.getExtension('EXT_color_buffer_float');
  if (!floatExt) return null;
  // Half-float LINEAR sampling is core WebGL2 on paper, but mirror eviland's
  // conservative gate: LINEAR only when OES_texture_float_linear is present.
  const linearOk = !!gl.getExtension('OES_texture_float_linear');
  const filterMode = linearOk ? gl.LINEAR : gl.NEAREST;

  function makeTarget(w: number, h: number, internalFormat: number, format: number): Target | null {
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) {
      if (tex) gl.deleteTexture(tex);
      if (fbo) gl.deleteFramebuffer(fbo);
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      return null;
    }
    // Start from rest (zero velocity / pressure), not garbage.
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  function disposeTarget(t: Target | null): void {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  // Probe once: some drivers expose EXT_color_buffer_float yet still fail
  // completeness on two-channel half-float attachments. A throwaway 4×4 RG16F
  // target answers definitively before we build the real grids.
  const probe = makeTarget(4, 4, gl.RG16F, gl.RG);
  if (!probe) return null;
  disposeTarget(probe);

  const advectProg = link(gl, QUAD_VERT, ADVECT_FRAG);
  const splatProg = link(gl, QUAD_VERT, SPLAT_FRAG);
  const curlProg = link(gl, QUAD_VERT, CURL_FRAG);
  const vorticityProg = link(gl, QUAD_VERT, VORTICITY_FRAG);
  const divergenceProg = link(gl, QUAD_VERT, DIVERGENCE_FRAG);
  const pressureProg = link(gl, QUAD_VERT, PRESSURE_FRAG);
  const gradientProg = link(gl, QUAD_VERT, GRADIENT_FRAG);
  const allProgs = [advectProg, splatProg, curlProg, vorticityProg, divergenceProg, pressureProg, gradientProg];
  if (!advectProg || !splatProg || !curlProg || !vorticityProg || !divergenceProg || !pressureProg || !gradientProg) {
    for (const p of allProgs) if (p) gl.deleteProgram(p);
    return null;
  }

  // Shared fullscreen quad (same 4-vertex strip as eviland's passes).
  const quadBuf = gl.createBuffer();
  if (!quadBuf) {
    for (const p of allProgs) gl.deleteProgram(p);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  // ---- Cached attribute/uniform locations (no per-frame getUniformLocation) ----
  const advectUni = {
    aPos: gl.getAttribLocation(advectProg, 'a_pos'),
    velocity: gl.getUniformLocation(advectProg, 'u_velocity'),
    dt: gl.getUniformLocation(advectProg, 'u_dt'),
    dissipation: gl.getUniformLocation(advectProg, 'u_dissipation'),
  };
  const splatUni = {
    aPos: gl.getAttribLocation(splatProg, 'a_pos'),
    velocity: gl.getUniformLocation(splatProg, 'u_velocity'),
    point: gl.getUniformLocation(splatProg, 'u_point'),
    force: gl.getUniformLocation(splatProg, 'u_force'),
    radius: gl.getUniformLocation(splatProg, 'u_radius'),
  };
  const curlUni = {
    aPos: gl.getAttribLocation(curlProg, 'a_pos'),
    velocity: gl.getUniformLocation(curlProg, 'u_velocity'),
    texelSize: gl.getUniformLocation(curlProg, 'u_texelSize'),
  };
  const vorticityUni = {
    aPos: gl.getAttribLocation(vorticityProg, 'a_pos'),
    velocity: gl.getUniformLocation(vorticityProg, 'u_velocity'),
    curl: gl.getUniformLocation(vorticityProg, 'u_curl'),
    texelSize: gl.getUniformLocation(vorticityProg, 'u_texelSize'),
    vorticity: gl.getUniformLocation(vorticityProg, 'u_vorticity'),
    dt: gl.getUniformLocation(vorticityProg, 'u_dt'),
  };
  const divergenceUni = {
    aPos: gl.getAttribLocation(divergenceProg, 'a_pos'),
    velocity: gl.getUniformLocation(divergenceProg, 'u_velocity'),
    texelSize: gl.getUniformLocation(divergenceProg, 'u_texelSize'),
  };
  const pressureUni = {
    aPos: gl.getAttribLocation(pressureProg, 'a_pos'),
    pressure: gl.getUniformLocation(pressureProg, 'u_pressure'),
    divergence: gl.getUniformLocation(pressureProg, 'u_divergence'),
    texelSize: gl.getUniformLocation(pressureProg, 'u_texelSize'),
  };
  const gradientUni = {
    aPos: gl.getAttribLocation(gradientProg, 'a_pos'),
    pressure: gl.getUniformLocation(gradientProg, 'u_pressure'),
    velocity: gl.getUniformLocation(gradientProg, 'u_velocity'),
    texelSize: gl.getUniformLocation(gradientProg, 'u_texelSize'),
  };

  // Sampler→unit assignments are static; set them once.
  gl.useProgram(advectProg); gl.uniform1i(advectUni.velocity, 0);
  gl.useProgram(splatProg); gl.uniform1i(splatUni.velocity, 0);
  gl.useProgram(curlProg); gl.uniform1i(curlUni.velocity, 0);
  gl.useProgram(vorticityProg); gl.uniform1i(vorticityUni.velocity, 0); gl.uniform1i(vorticityUni.curl, 1);
  gl.useProgram(divergenceProg); gl.uniform1i(divergenceUni.velocity, 0);
  gl.useProgram(pressureProg); gl.uniform1i(pressureUni.pressure, 0); gl.uniform1i(pressureUni.divergence, 1);
  gl.useProgram(gradientProg); gl.uniform1i(gradientUni.pressure, 0); gl.uniform1i(gradientUni.velocity, 1);

  // ---- Render targets ----
  let width = Math.max(2, Math.floor(opts.width));
  let height = Math.max(2, Math.floor(opts.height));
  const pressureIterations = Math.max(1, Math.floor(opts.pressureIterations));

  interface Targets {
    velA: Target; velB: Target;       // velocity ping-pong, RG16F
    curl: Target;                     // R16F
    divergence: Target;               // R16F
    pressA: Target; pressB: Target;   // pressure ping-pong, R16F
  }

  function createTargets(w: number, h: number): Targets | null {
    const velA = makeTarget(w, h, gl.RG16F, gl.RG);
    const velB = makeTarget(w, h, gl.RG16F, gl.RG);
    const curl = makeTarget(w, h, gl.R16F, gl.RED);
    const divergence = makeTarget(w, h, gl.R16F, gl.RED);
    const pressA = makeTarget(w, h, gl.R16F, gl.RED);
    const pressB = makeTarget(w, h, gl.R16F, gl.RED);
    if (!velA || !velB || !curl || !divergence || !pressA || !pressB) {
      disposeTarget(velA); disposeTarget(velB); disposeTarget(curl);
      disposeTarget(divergence); disposeTarget(pressA); disposeTarget(pressB);
      return null;
    }
    return { velA, velB, curl, divergence, pressA, pressB };
  }

  function disposeTargets(t: Targets): void {
    disposeTarget(t.velA); disposeTarget(t.velB); disposeTarget(t.curl);
    disposeTarget(t.divergence); disposeTarget(t.pressA); disposeTarget(t.pressB);
  }

  let targets = createTargets(width, height);
  if (!targets) {
    for (const p of allProgs) if (p) gl.deleteProgram(p);
    gl.deleteBuffer(quadBuf);
    return null;
  }
  // Velocity ping-pong: read from velRead, write to velWrite, then swap.
  let velRead = targets.velA;
  let velWrite = targets.velB;

  // ---- Per-pass plumbing ----

  function bindQuad(aPos: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  }

  function bindTex(unit: number, tex: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function drawTo(target: Target): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function swapVel(): void {
    const tmp = velRead;
    velRead = velWrite;
    velWrite = tmp;
  }

  function step(
    dt: number,
    forces: FluidForce[],
    params: { vorticity: number; dissipation: number },
  ): void {
    if (!targets) return;
    // Clamp dt so tab-switch hitches can't fling the field and high-Hz
    // displays can't starve the advection.
    const stepDt = Math.min(1 / 30, Math.max(1 / 240, dt));
    const tx = 1 / width;
    const ty = 1 / height;

    // The solver owns blend/viewport/framebuffer state for its passes; the
    // renderer re-establishes its own viewport per pass as eviland already does.
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, width, height);

    // 1) Self-advection + dissipation.
    gl.useProgram(advectProg);
    bindQuad(advectUni.aPos);
    gl.uniform1f(advectUni.dt, stepDt);
    gl.uniform1f(advectUni.dissipation, params.dissipation);
    bindTex(0, velRead.tex);
    drawTo(velWrite);
    swapVel();

    // 2) Force splats — one fullscreen draw per impulse, ping-ponging so each
    // splat reads the previous result (additive without blending).
    const forceCount = Math.min(forces.length, MAX_FLUID_FORCES);
    if (forceCount > 0) {
      gl.useProgram(splatProg);
      bindQuad(splatUni.aPos);
      for (let i = 0; i < forceCount; i++) {
        const f = forces[i];
        gl.uniform2f(splatUni.point, f.x, f.y);
        gl.uniform2f(splatUni.force, f.dx, f.dy);
        gl.uniform1f(splatUni.radius, Math.max(1e-4, f.radius));
        bindTex(0, velRead.tex);
        drawTo(velWrite);
        swapVel();
      }
    }

    // 3) Curl of the velocity field.
    gl.useProgram(curlProg);
    bindQuad(curlUni.aPos);
    gl.uniform2f(curlUni.texelSize, tx, ty);
    bindTex(0, velRead.tex);
    drawTo(targets.curl);

    // 4) Vorticity confinement.
    gl.useProgram(vorticityProg);
    bindQuad(vorticityUni.aPos);
    gl.uniform2f(vorticityUni.texelSize, tx, ty);
    gl.uniform1f(vorticityUni.vorticity, params.vorticity);
    gl.uniform1f(vorticityUni.dt, stepDt);
    bindTex(0, velRead.tex);
    bindTex(1, targets.curl.tex);
    drawTo(velWrite);
    swapVel();

    // 5) Divergence of the (forced, confined) velocity.
    gl.useProgram(divergenceProg);
    bindQuad(divergenceUni.aPos);
    gl.uniform2f(divergenceUni.texelSize, tx, ty);
    bindTex(0, velRead.tex);
    drawTo(targets.divergence);

    // 6) Jacobi pressure solve from a zero initial guess.
    let pressRead = targets.pressA;
    let pressWrite = targets.pressB;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pressRead.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pressureProg);
    bindQuad(pressureUni.aPos);
    gl.uniform2f(pressureUni.texelSize, tx, ty);
    bindTex(1, targets.divergence.tex);
    for (let i = 0; i < pressureIterations; i++) {
      bindTex(0, pressRead.tex);
      drawTo(pressWrite);
      const tmp = pressRead;
      pressRead = pressWrite;
      pressWrite = tmp;
    }

    // 7) Subtract ∇p → divergence-free velocity.
    gl.useProgram(gradientProg);
    bindQuad(gradientUni.aPos);
    gl.uniform2f(gradientUni.texelSize, tx, ty);
    bindTex(0, pressRead.tex);
    bindTex(1, velRead.tex);
    drawTo(velWrite);
    swapVel();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  function velocityTexture(): WebGLTexture {
    return velRead.tex;
  }

  function resize(w: number, h: number): void {
    const nw = Math.max(2, Math.floor(w));
    const nh = Math.max(2, Math.floor(h));
    if (nw === width && nh === height) return;
    // Build the new grids first so a (very unlikely) allocation failure keeps
    // the old, still-valid targets instead of leaving the sim dead.
    const next = createTargets(nw, nh);
    if (!next) {
      console.error('[newamp] eviland-fluid resize failed; keeping previous grid');
      return;
    }
    if (targets) disposeTargets(targets);
    targets = next;
    velRead = targets.velA;
    velWrite = targets.velB;
    width = nw;
    height = nh;
  }

  function dispose(): void {
    if (targets) {
      disposeTargets(targets);
      targets = null;
    }
    for (const p of allProgs) if (p) gl.deleteProgram(p);
    gl.deleteBuffer(quadBuf);
  }

  return { step, velocityTexture, resize, dispose };
}
