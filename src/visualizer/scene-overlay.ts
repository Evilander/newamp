// Eviland scene overlay — the "25 visuals MilkDrop can't have" layer.
//
// A transparent WebGL2 canvas stacked between the butterchurn (MilkDrop)
// iframe and the reactor-overlay event canvas in 'eviland-live' mode. Each
// scene is a self-contained fragment shader implementing
//
//   vec4 scene(vec2 uv, vec2 p)   // uv: 0..1, p: centered, aspect-corrected
//
// against a standard audio-feature uniform contract (see PRELUDE). The
// runtime owns the quad, compilation, caching, scene rotation, and a beat-
// aware crossfade between scenes. Output is premultiplied alpha so the
// MilkDrop field below shows through wherever a scene leaves alpha low.
//
// On the 'high' quality tier a second, independent ACCENT scene runs on top
// of the base scene, its opacity played live by the drums (kick/snare/vocal
// onset envelopes) — two full presets composited per-instrument, which a
// single MilkDrop preset structurally cannot do.
//
// "Could never be replicated": scene choice is a seeded walk keyed on
// (seedKey × sectionId) — seedKey carries the track + the user's evolved
// visual-memory lineage, so the same song on two machines (or two play
// histories) picks different scenes at different sections, on top of
// MilkDrop's own randomized preset rotation and the lineage-evolved operator
// look. The combination is effectively unique per user per listen history.
//
// Failure posture: ANY GL failure (context, compile, link) disables only this
// layer — MilkDrop + reactor events keep running. A scene that fails to
// compile is blacklisted for the session and the rotation moves on.

import type { EvilandFrame } from './eviland-audio';
import type { EvilandPalette } from './eviland';
import { SCENES, type SceneDef } from './scenes/index';

export interface SceneOverlay {
  resize(cssW: number, cssH: number, dpr: number): void;
  render(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void;
  /** Force a specific scene (null returns to the seeded auto-rotation). */
  setScene(id: string | null): void;
  /** Re-seed the rotation walk (track change / lineage update). */
  setSeedKey(key: string): void;
  currentSceneId(): string;
  dispose(): void;
}

export interface SceneOverlayOptions {
  quality?: 'high' | 'medium' | 'low';
  seedKey?: string;
}

// Shared GLSL prelude: every scene compiles against these uniforms + helpers.
// Scenes must ONLY add functions and implement scene(); the runtime appends
// main(). Keep this contract stable — 25 scene files depend on it.
const PRELUDE = `#version 300 es
precision highp float;

uniform vec2  u_res;        // framebuffer pixels
uniform float u_time;       // scene-local seconds (resets on scene switch)
uniform float u_globalTime; // seconds since overlay start (never resets)
uniform float u_dt;         // last frame delta, seconds
uniform float u_seed;       // 0..1 stable per scene instance
uniform float u_fade;       // 0..1 crossfade envelope (apply to output alpha)

uniform float u_energy;     // overall loudness 0..1
uniform float u_kick;       // voice envelopes 0..1 (asymmetric attack/release)
uniform float u_bass;
uniform float u_snare;
uniform float u_hat;
uniform float u_vocal;
uniform float u_kickPulse;  // decaying onset impulses 0..1 (punchier than envelopes)
uniform float u_snarePulse;
uniform float u_hatPulse;
uniform float u_vocalPulse;
uniform float u_centroid;   // brightness 0..1
uniform float u_flatness;   // 0 tonal .. 1 noisy
uniform float u_crest;      // peakiness 0..1
uniform float u_beatPhase;  // 0..1, 0 = on the beat
uniform float u_beatConf;   // 0..1
uniform float u_novelty;    // structural novelty 0..1
uniform float u_pan;        // -1..1
uniform float u_width;      // stereo width 0..1
uniform float u_bands[24];  // smoothed mel bands 0..1

uniform vec3 u_accent;      // theme palette
uniform vec3 u_light;
uniform vec3 u_dark;
uniform vec3 u_bg;

out vec4 fragColor;

// --- shared helpers ---------------------------------------------------------
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
// Theme-aware glow color: t 0 → dark accent, 1 → light. Keeps scenes on-palette.
vec3 paletteRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(u_dark, u_accent, t * 2.0) : mix(u_accent, u_light, t * 2.0 - 1.0);
}
// Average of a band range (inclusive indices 0..23).
float bandAvg(int lo, int hi) {
  float s = 0.0;
  for (int i = 0; i < 24; i++) { if (i >= lo && i <= hi) s += u_bands[i]; }
  return s / float(max(1, hi - lo + 1));
}
`;

const MAIN = `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
  vec4 c = scene(uv, p);
  c = clamp(c, 0.0, 1.0);
  // Premultiply + fade so crossfades and MilkDrop show-through compose cleanly.
  fragColor = vec4(c.rgb * c.a * u_fade, c.a * u_fade);
}
`;

const VERT = `#version 300 es
void main() {
  // Fullscreen triangle from gl_VertexID — no buffers needed.
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const UNIFORM_NAMES = [
  'u_res', 'u_time', 'u_globalTime', 'u_dt', 'u_seed', 'u_fade',
  'u_energy', 'u_kick', 'u_bass', 'u_snare', 'u_hat', 'u_vocal',
  'u_kickPulse', 'u_snarePulse', 'u_hatPulse', 'u_vocalPulse',
  'u_centroid', 'u_flatness', 'u_crest', 'u_beatPhase', 'u_beatConf',
  'u_novelty', 'u_pan', 'u_width', 'u_bands',
  'u_accent', 'u_light', 'u_dark', 'u_bg',
] as const;

type UniformMap = Partial<Record<(typeof UNIFORM_NAMES)[number], WebGLUniformLocation>>;

interface CompiledScene {
  program: WebGLProgram;
  uniforms: UniformMap;
}

const CROSSFADE_MS = 1400;
// Scene dwell: rotate on section change after MIN, force-rotate after MAX.
const MIN_DWELL_MS = 24_000;
const MAX_DWELL_MS = 70_000;

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSceneOverlay(
  canvas: HTMLCanvasElement,
  options: SceneOverlayOptions = {},
): SceneOverlay | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  let quality = options.quality ?? 'high';
  let seedKey = options.seedKey ?? 'eviland';
  let disposed = false;

  const compiled = new Map<string, CompiledScene>();
  const blacklisted = new Set<string>();

  function compileScene(def: SceneDef): CompiledScene | null {
    if (disposed) return null;
    const cached = compiled.get(def.id);
    if (cached) return cached;
    if (blacklisted.has(def.id)) return null;
    const fragSrc = PRELUDE + def.frag + MAIN;
    const vs = gl!.createShader(gl!.VERTEX_SHADER);
    const fs = gl!.createShader(gl!.FRAGMENT_SHADER);
    const program = gl!.createProgram();
    if (!vs || !fs || !program) return null;
    gl!.shaderSource(vs, VERT);
    gl!.compileShader(vs);
    gl!.shaderSource(fs, fragSrc);
    gl!.compileShader(fs);
    if (!gl!.getShaderParameter(fs, gl!.COMPILE_STATUS)) {
      console.error(`[scene-overlay] scene '${def.id}' failed to compile:`, gl!.getShaderInfoLog(fs));
      blacklisted.add(def.id);
      gl!.deleteShader(vs);
      gl!.deleteShader(fs);
      gl!.deleteProgram(program);
      return null;
    }
    gl!.attachShader(program, vs);
    gl!.attachShader(program, fs);
    gl!.linkProgram(program);
    gl!.deleteShader(vs);
    gl!.deleteShader(fs);
    if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) {
      console.error(`[scene-overlay] scene '${def.id}' failed to link:`, gl!.getProgramInfoLog(program));
      blacklisted.add(def.id);
      gl!.deleteProgram(program);
      return null;
    }
    const uniforms: UniformMap = {};
    for (const name of UNIFORM_NAMES) {
      const loc = gl!.getUniformLocation(program, name);
      if (loc) uniforms[name] = loc;
    }
    const result = { program, uniforms };
    compiled.set(def.id, result);
    return result;
  }

  // --- scene rotation state -------------------------------------------------
  let forcedSceneId: string | null = null;
  let activeIndex = 0;
  let outgoingIndex = -1; // -1 = no crossfade in progress
  let fadeMs = CROSSFADE_MS; // start fully faded in
  let sceneTimeMs = 0;
  let globalTimeMs = 0;
  let dwellMs = 0;
  let lastSectionId = -1;
  let walk = mulberry32(hashString(seedKey));
  let rotation: number[] = [];

  function availableScenes(): SceneDef[] {
    return SCENES.filter((s) => !blacklisted.has(s.id));
  }

  // --- accent layer (a second simultaneous scene, played by the drums) ------
  // MilkDrop composites exactly one preset at a time; Eviland runs a second,
  // independent scene whose visibility is a per-instrument envelope: it
  // materializes on kick/snare hits and evaporates in quiet passages, riding
  // ON TOP of the base scene. Structurally impossible in a single MilkDrop
  // preset. High quality tier only (it's a second full-screen pass), and
  // suppressed while a scene is forced so smokes/user picks stay pure.
  const accentEnabled = quality === 'high';
  let accentIndex = -1;
  let accentDwellMs = 0;
  let accentTimeMs = 0;
  let accentLevel = 0;

  // --- drop finale ----------------------------------------------------------
  // When a section boundary lands WITH a real energy jump (the drop), the
  // whole layer choreographs it: the scene fast-cuts instead of lazily
  // crossfading, a bloom flash blows through and decays over ~¼s, and the
  // accent layer surges to full. Cooldown keeps it an event, not a strobe.
  const DROP_COOLDOWN_MS = 8000;
  const DROP_FADE_MS = 240;
  let fadeDurMs = CROSSFADE_MS;
  let flashLevel = 0;
  let energyEma = 0.2;
  let lastDropAtMs = -1e9;

  let flashProgram: WebGLProgram | null = null;
  let flashColorLoc: WebGLUniformLocation | null = null;
  let flashFailed = false;
  function ensureFlashProgram(): boolean {
    if (flashProgram) return true;
    if (flashFailed || disposed) return false;
    const frag = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }
`;
    const vs = gl!.createShader(gl!.VERTEX_SHADER);
    const fs = gl!.createShader(gl!.FRAGMENT_SHADER);
    const program = gl!.createProgram();
    if (!vs || !fs || !program) {
      flashFailed = true;
      return false;
    }
    gl!.shaderSource(vs, VERT);
    gl!.compileShader(vs);
    gl!.shaderSource(fs, frag);
    gl!.compileShader(fs);
    gl!.attachShader(program, vs);
    gl!.attachShader(program, fs);
    gl!.linkProgram(program);
    gl!.deleteShader(vs);
    gl!.deleteShader(fs);
    if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) {
      gl!.deleteProgram(program);
      flashFailed = true;
      return false;
    }
    flashProgram = program;
    flashColorLoc = gl!.getUniformLocation(program, 'u_color');
    return true;
  }

  function pickAccentScene(): void {
    if (!accentEnabled) {
      accentIndex = -1;
      return;
    }
    const pool: number[] = [];
    for (const idx of rotation) {
      const def = SCENES[idx];
      if (!def || blacklisted.has(def.id) || idx === activeIndex || idx === outgoingIndex) continue;
      // Punchy tiers only — the accent layer exists to hit, not to wash.
      if (def.mood === 'high' || def.mood === 'any') pool.push(idx);
    }
    if (!pool.length) {
      accentIndex = -1;
      return;
    }
    accentIndex = pool[Math.floor(walk() * pool.length)]!;
    accentDwellMs = 0;
    accentTimeMs = 0;
  }

  function rebuildRotation(): void {
    // Seeded shuffle of scene indices — the per-user, per-track walk order.
    walk = mulberry32(hashString(seedKey));
    rotation = SCENES.map((_, i) => i);
    for (let i = rotation.length - 1; i > 0; i--) {
      const j = Math.floor(walk() * (i + 1));
      const tmp = rotation[i]!;
      rotation[i] = rotation[j]!;
      rotation[j] = tmp;
    }
    activeIndex = rotation[0] ?? 0;
    pickAccentScene();
  }
  rebuildRotation();

  function pickNextScene(frame: EvilandFrame): void {
    const avail = availableScenes();
    if (avail.length <= 1) return;
    // Energy-affine pick: prefer scenes whose mood matches the moment, but a
    // seeded 25% wildcard keeps it surprising.
    const tier = frame.energy > 0.55 ? 'high' : frame.energy > 0.22 ? 'mid' : 'calm';
    const want = walk() < 0.25 ? null : tier;
    const candidates: number[] = [];
    for (const idx of rotation) {
      const def = SCENES[idx];
      if (!def || blacklisted.has(def.id) || idx === activeIndex) continue;
      if (want === null || def.mood === 'any' || def.mood === want) candidates.push(idx);
    }
    const pool = candidates.length ? candidates : rotation.filter((i) => i !== activeIndex);
    if (!pool.length) return;
    const next = pool[Math.floor(walk() * pool.length)]!;
    outgoingIndex = activeIndex;
    activeIndex = next;
    fadeMs = 0;
    sceneTimeMs = 0;
    dwellMs = 0;
    // The accent scene must never duplicate the base scene it garnishes.
    if (accentIndex === activeIndex || accentIndex === outgoingIndex) pickAccentScene();
  }

  function bindAndDraw(def: SceneDef, frame: EvilandFrame, palette: EvilandPalette, dtSec: number, fade: number, seed: number, timeMs: number): boolean {
    const scene = compileScene(def);
    if (!scene) return false;
    gl!.useProgram(scene.program);
    const u = scene.uniforms;
    if (u.u_res) gl!.uniform2f(u.u_res, canvas.width, canvas.height);
    if (u.u_time) gl!.uniform1f(u.u_time, timeMs / 1000);
    if (u.u_globalTime) gl!.uniform1f(u.u_globalTime, globalTimeMs / 1000);
    if (u.u_dt) gl!.uniform1f(u.u_dt, dtSec);
    if (u.u_seed) gl!.uniform1f(u.u_seed, seed);
    if (u.u_fade) gl!.uniform1f(u.u_fade, fade);
    if (u.u_energy) gl!.uniform1f(u.u_energy, frame.energy);
    if (u.u_kick) gl!.uniform1f(u.u_kick, frame.kick);
    if (u.u_bass) gl!.uniform1f(u.u_bass, frame.bass);
    if (u.u_snare) gl!.uniform1f(u.u_snare, frame.snare);
    if (u.u_hat) gl!.uniform1f(u.u_hat, frame.hat);
    if (u.u_vocal) gl!.uniform1f(u.u_vocal, frame.vocal);
    if (u.u_kickPulse) gl!.uniform1f(u.u_kickPulse, pulses.kick);
    if (u.u_snarePulse) gl!.uniform1f(u.u_snarePulse, pulses.snare);
    if (u.u_hatPulse) gl!.uniform1f(u.u_hatPulse, pulses.hat);
    if (u.u_vocalPulse) gl!.uniform1f(u.u_vocalPulse, pulses.vocal);
    if (u.u_centroid) gl!.uniform1f(u.u_centroid, frame.centroid);
    if (u.u_flatness) gl!.uniform1f(u.u_flatness, frame.flatness);
    if (u.u_crest) gl!.uniform1f(u.u_crest, frame.crest);
    if (u.u_beatPhase) gl!.uniform1f(u.u_beatPhase, frame.beatPhase);
    if (u.u_beatConf) gl!.uniform1f(u.u_beatConf, frame.beatConfidence);
    if (u.u_novelty) gl!.uniform1f(u.u_novelty, frame.novelty);
    if (u.u_pan) gl!.uniform1f(u.u_pan, frame.pan);
    if (u.u_width) gl!.uniform1f(u.u_width, frame.width);
    if (u.u_bands) {
      const n = Math.min(24, frame.bands.length);
      for (let i = 0; i < n; i++) bandScratch[i] = frame.bands[i]!;
      for (let i = n; i < 24; i++) bandScratch[i] = 0;
      gl!.uniform1fv(u.u_bands, bandScratch);
    }
    if (u.u_accent) gl!.uniform3f(u.u_accent, palette.accent[0], palette.accent[1], palette.accent[2]);
    if (u.u_light) gl!.uniform3f(u.u_light, palette.light[0], palette.light[1], palette.light[2]);
    if (u.u_dark) gl!.uniform3f(u.u_dark, palette.dark[0], palette.dark[1], palette.dark[2]);
    if (u.u_bg) gl!.uniform3f(u.u_bg, palette.bg[0], palette.bg[1], palette.bg[2]);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    return true;
  }

  const bandScratch = new Float32Array(24);
  // Decaying onset impulses — JS-side so every scene gets punchy transients
  // without re-deriving them from envelopes.
  const pulses = { kick: 0, snare: 0, hat: 0, vocal: 0 };

  function updatePulses(frame: EvilandFrame, dtMs: number): void {
    const decay = Math.exp(-dtMs / 130);
    pulses.kick *= decay;
    pulses.snare *= decay;
    pulses.hat *= decay;
    pulses.vocal *= decay;
    for (const onset of frame.onsets) {
      const v = Math.min(1, 0.5 + onset.intensity * 0.6);
      if (onset.group === 'kick' || onset.group === 'bass') pulses.kick = Math.max(pulses.kick, v);
      else if (onset.group === 'snare') pulses.snare = Math.max(pulses.snare, v);
      else if (onset.group === 'hat' || onset.group === 'other') pulses.hat = Math.max(pulses.hat, v);
      else if (onset.group === 'vocal') pulses.vocal = Math.max(pulses.vocal, v);
    }
  }

  function resolveSceneIndex(): number {
    if (forcedSceneId) {
      const idx = SCENES.findIndex((s) => s.id === forcedSceneId);
      if (idx >= 0 && !blacklisted.has(SCENES[idx]!.id)) return idx;
    }
    return activeIndex;
  }

  return {
    resize(cssW, cssH, dpr) {
      // Scene shaders are full-screen per-pixel work; cap the internal
      // resolution by quality so weak GPUs keep their frame budget.
      const scale = quality === 'high' ? 1 : quality === 'medium' ? 0.75 : 0.5;
      const effectiveDpr = Math.max(0.5, dpr * scale);
      canvas.width = Math.max(2, Math.round(cssW * effectiveDpr));
      canvas.height = Math.max(2, Math.round(cssH * effectiveDpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },

    render(frame, palette, dtMs) {
      if (disposed) return;
      const dt = Math.min(100, Math.max(0, dtMs));
      sceneTimeMs += dt;
      globalTimeMs += dt;
      dwellMs += dt;
      accentTimeMs += dt;
      accentDwellMs += dt;
      if (outgoingIndex >= 0) fadeMs = Math.min(fadeDurMs, fadeMs + dt);
      updatePulses(frame, dt);

      // Slow energy baseline for drop detection (τ ≈ 4s) + flash decay.
      energyEma += (frame.energy - energyEma) * (1 - Math.exp(-dt / 4000));
      flashLevel *= Math.exp(-dt / 150);

      // Accent-layer envelope: fast attack on transients, slow release — the
      // second scene breathes with the drums instead of sitting at a fixed
      // opacity.
      const accentTarget = Math.min(1, pulses.kick * 0.9 + pulses.snare * 0.75 + pulses.vocal * 0.35);
      const accentK = accentTarget > accentLevel ? 1 - Math.exp(-dt / 40) : 1 - Math.exp(-dt / 320);
      accentLevel += (accentTarget - accentLevel) * accentK;

      // Rotation: switch scenes on a section boundary once we've dwelled long
      // enough, or force a switch when a scene has overstayed. A section
      // boundary that lands with a real energy jump is a DROP — it overrides
      // the dwell gate, fast-cuts the scene, fires the flash, and surges the
      // accent layer.
      if (!forcedSceneId) {
        const sectionChanged = frame.sectionId !== lastSectionId;
        lastSectionId = frame.sectionId;
        const isDrop =
          sectionChanged &&
          globalTimeMs - lastDropAtMs > DROP_COOLDOWN_MS &&
          globalTimeMs > 6000 && // never on boot — the EMA hasn't settled yet
          frame.beatConfidence > 0.35 &&
          frame.energy > Math.max(0.5, energyEma * 1.35);
        if (isDrop) {
          lastDropAtMs = globalTimeMs;
          pickNextScene(frame);
          fadeDurMs = DROP_FADE_MS;
          fadeMs = 0;
          flashLevel = 1;
          if (accentEnabled) accentLevel = 1;
        } else if ((sectionChanged && dwellMs > MIN_DWELL_MS) || dwellMs > MAX_DWELL_MS) {
          pickNextScene(frame);
          fadeDurMs = CROSSFADE_MS;
        } else if (accentEnabled && accentDwellMs > MAX_DWELL_MS * 0.6) {
          // The accent layer rotates on its own faster cadence so the pair
          // (base × accent) keeps recombining.
          pickAccentScene();
        }
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      // Premultiplied-alpha source-over: scenes self-composite; the page
      // compositor then blends the canvas over the MilkDrop iframe.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const idx = resolveSceneIndex();
      const def = SCENES[idx];
      if (!def) return;
      const fadeT = outgoingIndex >= 0 ? fadeMs / fadeDurMs : 1;

      if (outgoingIndex >= 0 && outgoingIndex !== idx) {
        const out = SCENES[outgoingIndex];
        if (out) {
          const outSeed = hash01(seedKey, out.id);
          bindAndDraw(out, frame, palette, dt / 1000, 1 - fadeT, outSeed, globalTimeMs);
        }
        if (fadeT >= 1) outgoingIndex = -1;
      }

      const seed = hash01(seedKey, def.id);
      const drew = bindAndDraw(def, frame, palette, dt / 1000, fadeT, seed, sceneTimeMs);
      if (!drew) {
        // Compile failed mid-flight: hop to the next scene immediately.
        pickNextScene(frame);
      }

      // Accent layer, over the base scene. Skipped when a scene is forced
      // (smokes and user picks assert on a single scene's output), when its
      // envelope is effectively silent (also saves the pass in quiet parts),
      // and when it would duplicate the scene already on screen. Alpha is
      // capped so the base scene stays primary; a failed compile only drops
      // the garnish — never the base.
      if (
        accentEnabled &&
        !forcedSceneId &&
        accentIndex >= 0 &&
        accentIndex !== idx &&
        accentLevel > 0.035
      ) {
        const acc = SCENES[accentIndex];
        if (acc) {
          const accSeed = hash01(seedKey, `accent::${acc.id}`);
          const accAlpha = Math.min(0.55, accentLevel * 0.55) * fadeT;
          const accDrew = bindAndDraw(acc, frame, palette, dt / 1000, accAlpha, accSeed, accentTimeMs);
          if (!accDrew) pickAccentScene();
        }
      }

      // Drop flash: one decaying accent-white wash over the whole stack.
      // Suppressed in forced-scene mode (smokes assert per-scene output).
      if (flashLevel > 0.02 && !forcedSceneId && ensureFlashProgram() && flashProgram) {
        const a = Math.min(0.42, flashLevel * 0.42);
        const r = palette.accent[0] + (1 - palette.accent[0]) * 0.6;
        const g = palette.accent[1] + (1 - palette.accent[1]) * 0.6;
        const b = palette.accent[2] + (1 - palette.accent[2]) * 0.6;
        gl.useProgram(flashProgram);
        if (flashColorLoc) gl.uniform4f(flashColorLoc, r * a, g * a, b * a, a);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    },

    setScene(id) {
      forcedSceneId = id;
      sceneTimeMs = 0;
    },

    setSeedKey(key) {
      if (key === seedKey) return;
      seedKey = key;
      rebuildRotation();
      outgoingIndex = -1;
      fadeDurMs = CROSSFADE_MS;
      fadeMs = fadeDurMs;
      sceneTimeMs = 0;
      dwellMs = 0;
      accentLevel = 0;
      flashLevel = 0;
    },

    currentSceneId() {
      return SCENES[resolveSceneIndex()]?.id ?? 'none';
    },

    dispose() {
      disposed = true;
      for (const { program } of compiled.values()) {
        try {
          gl.deleteProgram(program);
        } catch {
          /* context lost */
        }
      }
      compiled.clear();
      if (flashProgram) {
        try {
          gl.deleteProgram(flashProgram);
        } catch {
          /* context lost */
        }
        flashProgram = null;
      }
    },
  };

  function hash01(key: string, sceneId: string): number {
    return hashString(`${key}::${sceneId}`) / 4294967296;
  }
}
