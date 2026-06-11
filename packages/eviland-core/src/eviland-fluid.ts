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
// Three exports:
//   - createFluidForceSource — pooled audio→impulse factory. Owns a
//     preallocated FluidForce pool + the snare alternator, so the per-frame
//     audio path stays allocation-free on the hot path. Returned arrays are
//     reused across calls (see contract on the function); tests that need
//     cross-call comparisons must snapshot or build separate factories.
//   - fluidForcesFromFrame — back-compat singleton wrapper around the default
//     factory, used by the in-app call site which consumes the impulses
//     synchronously within the same frame.
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
  // OPTIONAL dye splat (RGBA16F advected field). Omit for backward compat:
  // velocity-only forces (no color/dye) keep the historical behavior intact.
  color?: [number, number, number]; // dye RGB 0..1, premultiplied by `dye`
  dye?: number;                     // dye intensity (additive amount, ~0..1.5)
}

export const MAX_FLUID_FORCES = 32;

const KICK_SPOKES = 6;
const KICK_STRENGTH = 0.55;
const SNARE_STRENGTH = 0.7;
const HAT_STRENGTH = 0.12;
const BASS_SHEAR = 0.05;
const PAN_BIAS = 0.04;
const INHALE_STRENGTH = 0.10;
const INHALE_SPOKES = 4;

// Per-voice dye amounts. Tuned so a busy mix reads bright without ever clipping
// every channel to white (that produced the cream-blob complaint in eviland.ts).
const DYE_KICK = 0.95;
const DYE_SNARE = 0.85;
const DYE_HAT = 0.35;
const DYE_VOCAL = 0.55;
const DYE_OTHER = 0.45;

// Deterministic HSV→RGB used by the seam to derive dye colors from band index.
// Local, pure, allocation-free (writes into a caller-owned 3-tuple). Mirrors
// the HSV math in eviland-randomizer.ts; duplicated here so eviland-fluid stays
// dependency-free for the Node test bundle.
function hsvToRgbInto(out: [number, number, number], h: number, s: number, v: number): void {
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: out[0] = v; out[1] = t; out[2] = p; return;
    case 1: out[0] = q; out[1] = v; out[2] = p; return;
    case 2: out[0] = p; out[1] = v; out[2] = t; return;
    case 3: out[0] = p; out[1] = q; out[2] = v; return;
    case 4: out[0] = t; out[1] = p; out[2] = v; return;
    case 5: out[0] = v; out[1] = p; out[2] = q; return;
    default: out[0] = v; out[1] = v; out[2] = v; return;
  }
}

// Map a band index (0..23) to a hue around the palette circle. The constant
// offset + golden-ratio step gives perceptually distinct neighbors and a
// stable, reproducible mapping the tests can lock onto.
function hueForBand(band: number): number {
  // golden-ratio conjugate keeps adjacent bands visually separated even with
  // a small palette range.
  const phi = 0.61803398875;
  return ((band * phi) + 0.07) % 1;
}

/**
 * Pooled audio→impulse source. Owns its own snareSide alternator and a
 * preallocated FluidForce pool so the per-frame audio path stays
 * allocation-free on the hot path: the previous implementation allocated a
 * fresh `out` array + one literal per onset + a per-emit `color` tuple every
 * frame (~25 small objects). Each `forces(frame)` call:
 *
 *   - writes into the next-available pool slot (slots are reused across calls)
 *   - returns the same backing array, sliced to .length=count
 *
 * Contract: **the returned array and its FluidForce entries are valid ONLY
 * until the next forces() call on the same factory.** The single in-app
 * consumer (eviland.ts `fluid.step(dt, fluidForcesFromFrame(frame), ...)`)
 * consumes them synchronously within the same frame and never holds a
 * reference past the call, so pooling is safe there. Tests that need to
 * compare results across calls must either snapshot the values or use
 * separate factories per call.
 */
export interface FluidForceSource {
  forces(frame: EvilandFrame): FluidForce[];
  /** Reset internal state (snare alternator). Useful for deterministic tests. */
  reset(): void;
}

export function createFluidForceSource(): FluidForceSource {
  // Pool: MAX_FLUID_FORCES preallocated slots, each with its own color tuple.
  // Slots are mutated in place; entries that don't carry dye have color/dye
  // cleared to undefined so consumers (and tests) can use the same
  // `f.color && f.dye > 0` discrimination as before.
  const pool: FluidForce[] = new Array(MAX_FLUID_FORCES);
  for (let i = 0; i < MAX_FLUID_FORCES; i++) {
    pool[i] = { x: 0, y: 0, dx: 0, dy: 0, radius: 0, color: [0, 0, 0], dye: 0 };
  }
  // The returned array IS reused across calls — its .length is reset to the
  // active count each call so consumers iterating [0..length) see only this
  // frame's forces. Same pool object identity per slot index across calls.
  const out: FluidForce[] = [];
  // Reused HSV→RGB scratch tuple (no per-onset alloc).
  const tmp: [number, number, number] = [0, 0, 0];
  let snareSide = 1; // alternates per snare onset so jets trade sides

  function writeVel(x: number, y: number, dx: number, dy: number, radius: number): void {
    const i = out.length;
    if (i >= MAX_FLUID_FORCES) return;
    const slot = pool[i]!;
    slot.x = x; slot.y = y; slot.dx = dx; slot.dy = dy; slot.radius = radius;
    // Velocity-only slot: clear dye so the dye-splat loop in createFluidSim
    // skips it (the same backward-compat path the pre-pool seam relied on).
    slot.color = undefined;
    slot.dye = undefined;
    out.push(slot);
  }

  function writeDyed(
    x: number, y: number, dx: number, dy: number, radius: number,
    r: number, g: number, b: number, dye: number,
  ): void {
    const i = out.length;
    if (i >= MAX_FLUID_FORCES) return;
    const slot = pool[i]!;
    slot.x = x; slot.y = y; slot.dx = dx; slot.dy = dy; slot.radius = radius;
    // Reuse the slot's pre-allocated color tuple — no per-emit `[r,g,b]`
    // literal. Length is fixed at 3 by construction so this is always safe.
    let col = slot.color;
    if (!col) {
      col = [0, 0, 0];
      slot.color = col;
    }
    col[0] = r; col[1] = g; col[2] = b;
    slot.dye = dye;
    out.push(slot);
  }

  function forces(frame: EvilandFrame): FluidForce[] {
    out.length = 0;

    // Baseline: bass shear along the bottom + pan bias (spatial truth).
    if (frame.bass > 0.05) {
      writeVel(0.5, 0.15, BASS_SHEAR * frame.bass * (frame.pan >= 0 ? 1 : -1), 0, 0.35);
    }
    if (Math.abs(frame.pan) > 0.05) {
      // Persistent lateral current biased by stereo position; doubles as a faint
      // ambient dye drift so quiet wide passages still show a slow color slide.
      hsvToRgbInto(tmp, 0.55 + frame.pan * 0.15, 0.5, 0.45);
      writeDyed(
        0.5, 0.5, PAN_BIAS * frame.pan, 0, 0.45,
        tmp[0], tmp[1], tmp[2],
        0.06 * Math.abs(frame.pan) * (0.4 + frame.width * 0.6),
      );
    }

    for (const onset of frame.onsets) {
      if (onset.group === 'kick') {
        // Radial shockwave: KICK_SPOKES outward impulses around a low-center anchor.
        // Each spoke carries kick-band dye so the slam reads as a colored shock,
        // not an invisible push. Hue drifts with pan so left/right kicks differ.
        const ax = 0.5 + frame.pan * 0.2;
        const ay = 0.3;
        const s = KICK_STRENGTH * onset.intensity;
        hsvToRgbInto(tmp, hueForBand(onset.band) + frame.pan * 0.08, 0.85, 1);
        const kr = tmp[0], kg = tmp[1], kb = tmp[2];
        // Bottom-center dye splat (large radius, sustained by frame.bass so a
        // sustained kick-and-bass passage stays warm and the field doesn't go
        // gray between hits). dx=dy=0 so velocity is unchanged.
        writeDyed(
          ax, ay, 0, 0, 0.22 + frame.bass * 0.06,
          kr, kg, kb, DYE_KICK * (0.6 + frame.bass * 0.6) * onset.intensity,
        );
        for (let i = 0; i < KICK_SPOKES; i++) {
          const a = (i / KICK_SPOKES) * Math.PI * 2;
          writeDyed(
            ax + Math.cos(a) * 0.04, ay + Math.sin(a) * 0.04,
            Math.cos(a) * s, Math.sin(a) * s, 0.12,
            kr, kg, kb, DYE_KICK * 0.4 * onset.intensity,
          );
        }
      } else if (onset.group === 'snare') {
        // One sharp angled jet, alternating sides. Bright, near-white dye so the
        // snare reads as a flash even against a colored backdrop.
        snareSide = -snareSide;
        const jx = 0.5 + snareSide * 0.22;
        const s = SNARE_STRENGTH * onset.intensity;
        hsvToRgbInto(tmp, hueForBand(onset.band) + 0.5, 0.25, 1);
        writeDyed(
          jx, 0.55, -snareSide * s * 0.8, s * 0.5, 0.06,
          tmp[0], tmp[1], tmp[2], DYE_SNARE * onset.intensity,
        );
      } else if (onset.group === 'hat') {
        // Top-edge micro-turbulence: two small lateral jitters (deterministic from band).
        // Sparkle dye on each — small radius keeps it hat-shaped, not curtained.
        const s = HAT_STRENGTH * onset.intensity;
        const seedX = 0.2 + ((onset.band * 37) % 13) / 20;
        hsvToRgbInto(tmp, hueForBand(onset.band), 0.55, 1);
        const hr = tmp[0], hg = tmp[1], hb = tmp[2];
        writeDyed(seedX, 0.85, s, -s * 0.3, 0.03, hr, hg, hb, DYE_HAT * onset.intensity);
        writeDyed(1 - seedX, 0.88, -s, -s * 0.2, 0.03, hr, hg, hb, DYE_HAT * onset.intensity);
      } else {
        // vocal / bass / other groups: dye-only splat at a deterministic emitter
        // position. dx=dy=0 keeps velocity untouched (the envelope baselines
        // above already cover the spatial truth for these voices), so the snare
        // test's "exactly one off-center jet" guarantee is preserved.
        // band index → vertical slot (matches eviland's emitter convention);
        // stereo pan biases x. Hue from band → busy mix reads as a song-aware
        // palette, not a mush.
        const py = onset.band / 23;
        const px = 0.5 + frame.pan * 0.25 + ((onset.band * 19) % 11 - 5) / 110;
        const amt = onset.group === 'vocal' ? DYE_VOCAL : DYE_OTHER;
        hsvToRgbInto(tmp, hueForBand(onset.band), 0.7, 0.95);
        writeDyed(
          px, py, 0, 0, 0.07 + onset.intensity * 0.05,
          tmp[0], tmp[1], tmp[2], amt * onset.intensity,
        );
      }
    }

    // Anticipation: just before a confident beat, the scene inhales (inward pull).
    if (frame.bpm > 1 && frame.beatConfidence > 0.6 && frame.beatPhase > 0.85) {
      for (let i = 0; i < INHALE_SPOKES; i++) {
        const a = (i / INHALE_SPOKES) * Math.PI * 2 + 0.4;
        const px = 0.5 + Math.cos(a) * 0.3;
        const py = 0.5 + Math.sin(a) * 0.3;
        writeVel(px, py, -Math.cos(a) * INHALE_STRENGTH, -Math.sin(a) * INHALE_STRENGTH, 0.18);
      }
    }

    return out;
  }

  function reset(): void {
    snareSide = 1;
    out.length = 0;
  }

  return { forces, reset };
}

// Default singleton — what eviland.ts imports. Single-consumer + immediate
// consumption pattern (see contract on createFluidForceSource).
const defaultSource = createFluidForceSource();
export function fluidForcesFromFrame(frame: EvilandFrame): FluidForce[] {
  return defaultSource.forces(frame);
}

/**
 * Silence-gated dye dissipation. When the frame is quiet, the dye field decays
 * fast so the surface settles to near-black (hits read as hits). When loud,
 * dissipation rises toward 1 (no decay) so motion lingers. Pure, deterministic,
 * Node-testable — the renderer feeds the returned value to FluidSim.step.
 */
export function dyeDissipationFromFrame(frame: EvilandFrame): number {
  // Curve: at energy 0 we hold ~0.94 (heavy decay), at energy 1 ~0.995 (almost
  // none). Tuned so a sustained loud passage keeps dye coherent for a few
  // seconds but never piles up to white.
  const e = frame.energy < 0 ? 0 : frame.energy > 1 ? 1 : frame.energy;
  return 0.94 + e * 0.055;
}

// ---------------------------------------------------------------------------
// GL solver.
// ---------------------------------------------------------------------------

export interface FluidSimOptions {
  width: number;              // sim grid width (fraction of field res, chosen by caller)
  height: number;             // sim grid height
  pressureIterations: number; // Jacobi iterations per step
}

export interface FluidStepParams {
  vorticity: number;
  /** Velocity dissipation per step (existing). */
  dissipation: number;
  /** Dye dissipation per step. >=1 = no decay, ~0.93 = heavy. Default 0.985. */
  dyeDissipation?: number;
}

export interface FluidSim {
  step(dt: number, forces: FluidForce[], params: FluidStepParams): void;
  /** Current velocity texture (RG16F, UV-space units per second); null after dispose(). */
  velocityTexture(): WebGLTexture | null;
  /** Current dye texture (RGBA16F, premultiplied color); null after dispose() or if dye disabled. */
  dyeTexture(): WebGLTexture | null;
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

// Dye advection — semi-Lagrangian like velocity, but the sampled value is the
// RGBA dye field and the *velocity* texture drives the backtrace. Dissipation
// is multiplicative per step so the silence gate (driven from the audio frame)
// can shorten or lengthen dye memory smoothly.
const DYE_ADVECT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_velocity;
uniform sampler2D u_dye;
uniform float u_dt;
uniform float u_dissipation;
void main(){
  vec2 coord = v_uv - texture(u_velocity, v_uv).xy * u_dt;
  vec4 d = texture(u_dye, coord) * u_dissipation;
  o = d;
}`;

// Dye splat — same Gaussian profile as the velocity splat, with the impulse
// being premultiplied RGB. Alpha is set from the dye amount so consumers can
// compose-over without re-reading the brightness.
const DYE_SPLAT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_dye;
uniform vec2 u_point;
uniform vec3 u_color;   // dye RGB, pre-multiplied by amount
uniform float u_amount; // dye scalar (additive scale)
uniform float u_radius;
void main(){
  vec2 p = v_uv - u_point;
  float g = exp(-dot(p, p) / (u_radius * u_radius));
  vec4 prev = texture(u_dye, v_uv);
  o = vec4(prev.rgb + u_color * u_amount * g, max(prev.a, u_amount * g));
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
  // Dye programs: advection and splat. The dye field is a coupled, advected
  // RGBA carrying the per-voice colors mapped in fluidForcesFromFrame; the
  // renderer composites it into the visible output via a `liquidMix` channel.
  const dyeAdvectProg = link(gl, QUAD_VERT, DYE_ADVECT_FRAG);
  const dyeSplatProg = link(gl, QUAD_VERT, DYE_SPLAT_FRAG);
  const allProgs = [advectProg, splatProg, curlProg, vorticityProg, divergenceProg, pressureProg, gradientProg, dyeAdvectProg, dyeSplatProg];
  if (!advectProg || !splatProg || !curlProg || !vorticityProg || !divergenceProg || !pressureProg || !gradientProg || !dyeAdvectProg || !dyeSplatProg) {
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
  const dyeAdvectUni = {
    aPos: gl.getAttribLocation(dyeAdvectProg, 'a_pos'),
    velocity: gl.getUniformLocation(dyeAdvectProg, 'u_velocity'),
    dye: gl.getUniformLocation(dyeAdvectProg, 'u_dye'),
    dt: gl.getUniformLocation(dyeAdvectProg, 'u_dt'),
    dissipation: gl.getUniformLocation(dyeAdvectProg, 'u_dissipation'),
  };
  const dyeSplatUni = {
    aPos: gl.getAttribLocation(dyeSplatProg, 'a_pos'),
    dye: gl.getUniformLocation(dyeSplatProg, 'u_dye'),
    point: gl.getUniformLocation(dyeSplatProg, 'u_point'),
    color: gl.getUniformLocation(dyeSplatProg, 'u_color'),
    amount: gl.getUniformLocation(dyeSplatProg, 'u_amount'),
    radius: gl.getUniformLocation(dyeSplatProg, 'u_radius'),
  };

  // Sampler→unit assignments are static; set them once.
  gl.useProgram(advectProg); gl.uniform1i(advectUni.velocity, 0);
  gl.useProgram(splatProg); gl.uniform1i(splatUni.velocity, 0);
  gl.useProgram(curlProg); gl.uniform1i(curlUni.velocity, 0);
  gl.useProgram(vorticityProg); gl.uniform1i(vorticityUni.velocity, 0); gl.uniform1i(vorticityUni.curl, 1);
  gl.useProgram(divergenceProg); gl.uniform1i(divergenceUni.velocity, 0);
  gl.useProgram(pressureProg); gl.uniform1i(pressureUni.pressure, 0); gl.uniform1i(pressureUni.divergence, 1);
  gl.useProgram(gradientProg); gl.uniform1i(gradientUni.pressure, 0); gl.uniform1i(gradientUni.velocity, 1);
  gl.useProgram(dyeAdvectProg); gl.uniform1i(dyeAdvectUni.velocity, 0); gl.uniform1i(dyeAdvectUni.dye, 1);
  gl.useProgram(dyeSplatProg); gl.uniform1i(dyeSplatUni.dye, 0);

  // ---- Render targets ----
  let width = Math.max(2, Math.floor(opts.width));
  let height = Math.max(2, Math.floor(opts.height));
  const pressureIterations = Math.max(1, Math.floor(opts.pressureIterations));

  interface Targets {
    velA: Target; velB: Target;       // velocity ping-pong, RG16F
    curl: Target;                     // R16F
    divergence: Target;               // R16F
    pressA: Target; pressB: Target;   // pressure ping-pong, R16F
    dyeA: Target; dyeB: Target;       // dye ping-pong, RGBA16F
  }

  function createTargets(w: number, h: number): Targets | null {
    const velA = makeTarget(w, h, gl.RG16F, gl.RG);
    const velB = makeTarget(w, h, gl.RG16F, gl.RG);
    const curl = makeTarget(w, h, gl.R16F, gl.RED);
    const divergence = makeTarget(w, h, gl.R16F, gl.RED);
    const pressA = makeTarget(w, h, gl.R16F, gl.RED);
    const pressB = makeTarget(w, h, gl.R16F, gl.RED);
    // Dye is RGBA16F — float so it composes with the existing RGBA16F field
    // pipeline without quantization seams. Same EXT_color_buffer_float gate as
    // velocity above; if RGBA16F fails creation we abort and fall back.
    const dyeA = makeTarget(w, h, gl.RGBA16F, gl.RGBA);
    const dyeB = makeTarget(w, h, gl.RGBA16F, gl.RGBA);
    if (!velA || !velB || !curl || !divergence || !pressA || !pressB || !dyeA || !dyeB) {
      disposeTarget(velA); disposeTarget(velB); disposeTarget(curl);
      disposeTarget(divergence); disposeTarget(pressA); disposeTarget(pressB);
      disposeTarget(dyeA); disposeTarget(dyeB);
      return null;
    }
    return { velA, velB, curl, divergence, pressA, pressB, dyeA, dyeB };
  }

  function disposeTargets(t: Targets): void {
    disposeTarget(t.velA); disposeTarget(t.velB); disposeTarget(t.curl);
    disposeTarget(t.divergence); disposeTarget(t.pressA); disposeTarget(t.pressB);
    disposeTarget(t.dyeA); disposeTarget(t.dyeB);
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
  // Dye ping-pong follows the same pattern.
  let dyeRead = targets.dyeA;
  let dyeWrite = targets.dyeB;

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
  function swapDye(): void {
    const tmp = dyeRead;
    dyeRead = dyeWrite;
    dyeWrite = tmp;
  }

  function step(
    dt: number,
    forces: FluidForce[],
    params: FluidStepParams,
  ): void {
    if (!targets) return;
    // Clamp dt so tab-switch hitches can't fling the field and high-Hz
    // displays can't starve the advection.
    const stepDt = Math.min(1 / 30, Math.max(1 / 240, dt));
    const tx = 1 / width;
    const ty = 1 / height;
    // Default dye dissipation is just under 1 — most callers (the renderer)
    // override this from dyeDissipationFromFrame so silence drains the field.
    const dyeDiss = params.dyeDissipation ?? 0.985;

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
    // splat reads the previous result (additive without blending). Velocity
    // and dye are coupled: velocity uses (dx, dy); dye splats are emitted in
    // a separate loop below so each pass can stay bound to a single program.
    const forceCount = Math.min(forces.length, MAX_FLUID_FORCES);
    if (forceCount > 0) {
      gl.useProgram(splatProg);
      bindQuad(splatUni.aPos);
      for (let i = 0; i < forceCount; i++) {
        const f = forces[i];
        // Skip dye-only entries (dx=dy=0): they don't move the fluid, only
        // tint it. Saves a no-op fullscreen draw on every busy frame.
        if (f.dx === 0 && f.dy === 0) continue;
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

    // 8) Dye advection by the (now divergence-free) velocity. Runs AFTER the
    // pressure projection so the dye is carried by the same field the renderer
    // samples — color and momentum stay visually coupled.
    gl.useProgram(dyeAdvectProg);
    bindQuad(dyeAdvectUni.aPos);
    gl.uniform1f(dyeAdvectUni.dt, stepDt);
    gl.uniform1f(dyeAdvectUni.dissipation, dyeDiss);
    bindTex(0, velRead.tex);
    bindTex(1, dyeRead.tex);
    drawTo(dyeWrite);
    swapDye();

    // 9) Dye splats — one fullscreen draw per force that carries color. We
    // ping-pong reads/writes additively (color is summed in the fragment) so
    // no GL blend state is needed. Forces without a color field are velocity-
    // only and skipped here (backward compat with the pre-dye seam).
    if (forceCount > 0) {
      gl.useProgram(dyeSplatProg);
      bindQuad(dyeSplatUni.aPos);
      for (let i = 0; i < forceCount; i++) {
        const f = forces[i];
        const color = f.color;
        const amt = f.dye;
        if (!color || !amt || amt <= 0) continue;
        gl.uniform2f(dyeSplatUni.point, f.x, f.y);
        gl.uniform3f(dyeSplatUni.color, color[0], color[1], color[2]);
        gl.uniform1f(dyeSplatUni.amount, amt);
        gl.uniform1f(dyeSplatUni.radius, Math.max(1e-4, f.radius));
        bindTex(0, dyeRead.tex);
        drawTo(dyeWrite);
        swapDye();
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  function velocityTexture(): WebGLTexture | null {
    if (!targets) return null; // disposed — never hand back a deleted texture
    return velRead.tex;
  }
  function dyeTexture(): WebGLTexture | null {
    if (!targets) return null;
    return dyeRead.tex;
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
    dyeRead = targets.dyeA;
    dyeWrite = targets.dyeB;
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

  return { step, velocityTexture, dyeTexture, resize, dispose };
}
