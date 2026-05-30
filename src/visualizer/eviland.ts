// Eviland flagship visualizer — WebGL2 renderer.
//
// The renderer's job is to make the audio reactor's per-instrument event bus
// VISIBLE. Four pillars, each implemented as a distinct stage of the pass graph
// below — anyone watching should be able to point at the screen and say "that
// was the kick, that was the hi-hat" because each voice has its own colour,
// position, and shape, not because they're all pulsing on the same envelope.
//
// Pass graph (high quality, 60fps target at 1080p on a mid GPU):
//
//   prevField (RGBA16F) ──► [advect+decay+warp]   ─┐
//   onsets (CPU pool)  ──► [splat emitters]       ├─► nextField (RGBA16F)
//   bands[24]          ──► [terrain/ridge splat]  ─┘
//                                  │
//                       (ping-pong swap)
//                                  │
//                                  ▼
//                          [threshold → bright]
//                                  │ down/up Kawase pyramid (3 levels)
//                                  ▼
//                       [composite: field + bloom + post]
//                                  │ chromatic-aberration (snare+hat only)
//                                  │ ACES tone-map + vignette
//                                  ▼
//                              backbuffer
//
// Quality tiers (options.quality):
//   'high'   – 1.0× field, 3-level bloom, aberration on, ≤32 emitters
//   'medium' – 0.75× field, 2-level bloom, aberration on, ≤20 emitters
//   'low'    – 0.5×  field, no bloom,      no aberration, ≤10 emitters
//
// Caller responsibility: createEvilandRenderer returns null on missing WebGL2
// or EXT_color_buffer_float — fall back to butterchurn / canvas downstream.

import type { EvilandFrame } from './eviland-audio';

export interface EvilandPalette {
  accent: [number, number, number]; // each channel 0..1
  dark: [number, number, number];
  light: [number, number, number];
  bg: [number, number, number];
}

export interface EvilandRenderer {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void;
  dispose(): void;
}

export interface EvilandOptions {
  smoke?: boolean;
  quality?: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Shaders. Versioned (#version 300 es) per WebGL2; all sources compile/link
// guarded so a failure returns null instead of throwing.
// ---------------------------------------------------------------------------

const QUAD_VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Ashima 2D simplex — lifted (public domain) and used as our potential field.
const NOISE_GLSL = `
vec3 mod289_3(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289_2(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289_3(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));
  vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
  i=mod289_2(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
  m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0;
  vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g;
  g.x=a0.x*x0.x+h.x*x0.y;
  g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}
vec2 curl(vec2 p){
  float e=0.012;
  float n1=snoise(p+vec2(0.0,e));
  float n2=snoise(p-vec2(0.0,e));
  float n3=snoise(p+vec2(e,0.0));
  float n4=snoise(p-vec2(e,0.0));
  return vec2(n1-n2, -(n3-n4))/(2.0*e);
}
`;

// Pillar 2: feedback field — sample prev, apply curl-noise domain warp + decay
// + a small global drift driven by stereo pan, plus residual turbulence from
// section novelty so a "different feeling" passage looks different.
const FIELD_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_prev;
uniform float u_decay;
uniform float u_warpAmp;
uniform float u_warpScale;
uniform vec2  u_flow;
uniform float u_time;
uniform float u_novelty;
uniform float u_sectionSeed;
${NOISE_GLSL}
void main(){
  vec2 uv = v_uv;
  // Per-section noise offset gives returning choruses a recognisable signature.
  vec2 base = uv * u_warpScale + vec2(u_time * 0.018, -u_time * 0.014) + vec2(u_sectionSeed, -u_sectionSeed*0.7);
  vec2 w = curl(base) * u_warpAmp;
  // Octave 2: cheaper, smaller — turbulence rides on the main flow.
  w += curl(base * 2.1 + 11.7) * (u_warpAmp * 0.45 + u_novelty * 0.6);
  vec2 src = clamp(uv - u_flow + w, 0.001, 0.999);
  vec3 prev = texture(u_prev, src).rgb;
  prev *= u_decay;
  o = vec4(prev, 1.0);
}`;

// Pillar 1: causal emitters. One instanced quad per active emitter; the
// fragment paints a kind-specific SDF in the emitter's per-instance hue. All
// additive, all blended onto the feedback field.
//
// Kinds: 0 ring (kick) 1 burst (snare) 2 sparkle (hat) 3 blob (vocal) 4 core (kick punch)
const EMITTER_VERT = `#version 300 es
precision highp float;
in vec2 a_quad;
// Instance attributes (vec4 each — packed for fewer bindings):
in vec4 i_posSize;   // xy = centre in NDC, z = baseRadius, w = age01 (0 fresh .. 1 dead)
in vec4 i_color;     // rgb premultiplied by intensity, a = aspect (canvas h / canvas w)
in vec4 i_kindData;  // x = kind (0..4), y = jitterSeed, z = thickness, w = intensity
out vec2 v_local;
out vec4 v_color;
flat out int v_kind;
out float v_age;
out float v_thick;
out float v_intensity;
void main(){
  float radius = i_posSize.z * (1.0 + i_kindData.x * 0.0); // (radius scaling per kind in frag)
  vec2 offset = a_quad * radius;
  offset.x *= i_color.a;                                   // aspect correction (squareness in NDC)
  vec2 pos = i_posSize.xy + offset;
  v_local = a_quad;
  v_color = vec4(i_color.rgb, 1.0);
  v_kind = int(i_kindData.x + 0.5);
  v_age = i_posSize.w;
  v_thick = i_kindData.z;
  v_intensity = i_kindData.w;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const EMITTER_FRAG = `#version 300 es
precision highp float;
in vec2 v_local;
in vec4 v_color;
flat in int v_kind;
in float v_age;
in float v_thick;
in float v_intensity;
out vec4 o;
void main(){
  float r = length(v_local);
  // Common life envelope: fast-in 0..0.05, decay 0.05..1
  float life = (1.0 - v_age);
  if (life <= 0.0) discard;
  vec3 col = v_color.rgb;
  float alpha = 0.0;
  if (v_kind == 0) {
    // Ring (kick): expanding circle, thickness from instance, fade with age.
    float ring = exp(-pow((r - v_age) / max(0.004, v_thick), 2.0));
    alpha = ring * life * v_intensity * 0.95;
  } else if (v_kind == 1) {
    // Burst (snare): jagged radial gaussian — sharp centre, soft edge.
    float core = exp(-r*r * 14.0);
    float halo = exp(-r*r * 3.0) * 0.4;
    alpha = (core + halo) * life * v_intensity;
  } else if (v_kind == 2) {
    // Sparkle (hat): thin radial streaks plus a bright pinpoint.
    float pin = exp(-r*r * 60.0);
    float streak = exp(-r*8.0) * (0.5 + 0.5 * cos(atan(v_local.y, v_local.x) * 10.0));
    alpha = (pin + streak * 0.25) * life * v_intensity;
  } else if (v_kind == 3) {
    // Blob (vocal): soft, fat gaussian — the character the eye tracks.
    alpha = exp(-r*r * 5.0) * life * v_intensity * 0.85;
  } else {
    // Core (kick punch): solid disc with rim glow.
    float disc = smoothstep(0.85, 0.7, r);
    float rim = smoothstep(0.98, 0.92, r) * (1.0 - smoothstep(0.95, 0.85, r));
    alpha = (disc * 0.7 + rim * 0.6) * life * v_intensity;
  }
  if (alpha <= 0.003) discard;
  o = vec4(col * alpha, alpha);
}`;

// Pillar 1 (bass): a horizon strip whose height is a per-x band amplitude,
// displaced by curl noise. Drawn as a single fullscreen quad; fragment
// integrates the bass envelope + per-column noise to give a moving terrain.
const TERRAIN_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform float u_bass;
uniform float u_time;
uniform float u_pan;
uniform vec3  u_color;
${NOISE_GLSL}
void main(){
  vec2 uv = v_uv;
  // height field: bass amplitude, mountain-line shaped, drifting with stereo pan.
  float base = 0.08 + u_bass * 0.30;
  float disp = snoise(vec2(uv.x * 4.0 - u_time * 0.25 + u_pan * 0.6, u_time * 0.1)) * 0.12 * (0.3 + u_bass);
  float h = base + disp;
  float edge = smoothstep(h + 0.005, h - 0.015, uv.y);
  // Soft underglow.
  float glow = exp(-pow((uv.y - h) * 12.0, 2.0)) * (0.6 + u_bass * 0.8);
  float a = edge * 0.18 + glow * 0.55;
  o = vec4(u_color * a, a);
}`;

// Bloom — threshold pass extracts bright pixels.
const THRESHOLD_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform float u_threshold;
void main(){
  vec3 c = texture(u_src, v_uv).rgb;
  float b = max(c.r, max(c.g, c.b));
  float k = smoothstep(u_threshold, u_threshold + 0.4, b);
  o = vec4(c * k, 1.0);
}`;

// Dual-Kawase down: 4-tap diagonal sample at half-pixel offsets.
const KAWASE_DOWN_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texel;
void main(){
  vec3 s = texture(u_src, v_uv).rgb * 4.0;
  s += texture(u_src, v_uv + u_texel * vec2(-1.0,-1.0)).rgb;
  s += texture(u_src, v_uv + u_texel * vec2( 1.0,-1.0)).rgb;
  s += texture(u_src, v_uv + u_texel * vec2(-1.0, 1.0)).rgb;
  s += texture(u_src, v_uv + u_texel * vec2( 1.0, 1.0)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

// Dual-Kawase up: 8 cardinal+diagonal taps weighted.
const KAWASE_UP_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texel;
void main(){
  vec3 s = vec3(0.0);
  s += texture(u_src, v_uv + u_texel * vec2(-2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + u_texel * vec2( 2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + u_texel * vec2( 0.0,-2.0)).rgb;
  s += texture(u_src, v_uv + u_texel * vec2( 0.0, 2.0)).rgb;
  s += texture(u_src, v_uv + u_texel * vec2(-1.0,-1.0)).rgb * 2.0;
  s += texture(u_src, v_uv + u_texel * vec2( 1.0,-1.0)).rgb * 2.0;
  s += texture(u_src, v_uv + u_texel * vec2(-1.0, 1.0)).rgb * 2.0;
  s += texture(u_src, v_uv + u_texel * vec2( 1.0, 1.0)).rgb * 2.0;
  o = vec4(s / 12.0, 1.0);
}`;

// Final composite: field + bloom + chromatic aberration (driven by snare+hat,
// never bass — bass-driven aberration is the cheap cliché) + ACES tone-map +
// subtle vignette. bg colour bleeds in at low intensity for the "scene".
const POST_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_field;
uniform sampler2D u_bloom;
uniform float u_bloomIntensity;
uniform float u_aberration; // 0 off .. 1 strong
uniform float u_saturation; // 0..1 (1 = full, 0 = monochrome)
uniform vec3  u_bg;
uniform vec3  u_hueShift;   // RGB lookup tint for centroid → colour drift

vec3 aces(vec3 x){
  const float a=2.51; const float b=0.03; const float c=2.43;
  const float d=0.59; const float e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
void main(){
  vec2 uv = v_uv;
  vec2 dir = uv - 0.5;
  float r2 = dot(dir, dir);
  // Radial chromatic aberration — fast attack envelope on snare+hat upstream.
  float amt = u_aberration * (0.004 + r2 * 0.020);
  vec3 fieldC;
  fieldC.r = texture(u_field, uv + dir * amt * 1.4).r;
  fieldC.g = texture(u_field, uv).g;
  fieldC.b = texture(u_field, uv - dir * amt * 1.4).b;
  vec3 bloomC = texture(u_bloom, uv).rgb * u_bloomIntensity;
  vec3 colour = fieldC + bloomC;
  // Centroid-driven hue drift around the palette accent.
  colour *= u_hueShift;
  // Mix toward greyscale when flatness is high (saturation falls).
  float luma = dot(colour, vec3(0.299, 0.587, 0.114));
  colour = mix(vec3(luma), colour, u_saturation);
  // Background tint shows through dark zones (the field is mostly black).
  float darkness = 1.0 - smoothstep(0.0, 0.15, luma);
  colour += u_bg * darkness * 0.7;
  // Vignette + tone-map.
  float vig = smoothstep(1.0, 0.45, length(dir));
  colour *= 0.92 + vig * 0.16;
  colour = aces(colour);
  o = vec4(colour, 1.0);
}`;

// ---------------------------------------------------------------------------
// GL helpers — guarded so failures return null up the chain.
// ---------------------------------------------------------------------------

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[newamp] eviland shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[newamp] eviland program link failed:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

interface Fbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Emitter pool. CPU-side; one instance buffer per emitter slot, batched draw.
// ---------------------------------------------------------------------------

interface Emitter {
  // Render attributes (packed into 3 vec4s per emitter for the instanced quad).
  x: number;
  y: number; // NDC (-1..+1)
  baseRadius: number;
  age: number; // seconds
  lifespan: number; // seconds (0 disables)
  r: number;
  g: number;
  b: number;
  aspectAdjust: number; // squared-up: x scale factor so visual is circular at any aspect
  kind: number; // 0..4 — see EMITTER_FRAG
  jitter: number;
  thickness: number;
  intensity: number;
}

function makeEmitter(): Emitter {
  return { x: 0, y: 0, baseRadius: 0.2, age: 0, lifespan: 0, r: 1, g: 1, b: 1, aspectAdjust: 1, kind: 0, jitter: 0, thickness: 0.06, intensity: 1 };
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createEvilandRenderer(
  canvas: HTMLCanvasElement,
  options: EvilandOptions = {},
): EvilandRenderer | null {
  const ctx = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: Boolean(options.smoke),
    powerPreference: 'high-performance',
  });
  if (!ctx) return null;
  const gl: WebGL2RenderingContext = ctx;

  // Required for RGBA16F render targets. Without this, framebuffer status will
  // never be COMPLETE and the field stays black — fall back to butterchurn.
  const floatExt = gl.getExtension('EXT_color_buffer_float');
  if (!floatExt) {
    return null;
  }
  // Linear filtering on half-float is widely supported but optional; we use
  // NEAREST as the safe fallback. The field needs to *sample* itself with a
  // bilinear-ish lookup for warp smoothness — half-float linear is well
  // supported on the GPUs we target, but check anyway.
  const linearOk = !!gl.getExtension('OES_texture_float_linear');
  const filterMode = linearOk ? gl.LINEAR : gl.NEAREST;

  const quality: 'high' | 'medium' | 'low' = options.quality ?? 'high';
  const fieldScale = quality === 'high' ? 1.0 : quality === 'medium' ? 0.75 : 0.5;
  const bloomLevels = quality === 'high' ? 3 : quality === 'medium' ? 2 : 0;
  const aberrationOn = quality !== 'low';
  const maxEmitters = quality === 'high' ? 32 : quality === 'medium' ? 20 : 10;

  const quadProg = link(gl, QUAD_VERT, THRESHOLD_FRAG); // placeholder — replaced below per-program
  if (quadProg) gl.deleteProgram(quadProg);

  const fieldProg = link(gl, QUAD_VERT, FIELD_FRAG);
  const emitterProg = link(gl, EMITTER_VERT, EMITTER_FRAG);
  const terrainProg = link(gl, QUAD_VERT, TERRAIN_FRAG);
  const thresholdProg = link(gl, QUAD_VERT, THRESHOLD_FRAG);
  const downProg = link(gl, QUAD_VERT, KAWASE_DOWN_FRAG);
  const upProg = link(gl, QUAD_VERT, KAWASE_UP_FRAG);
  const postProg = link(gl, QUAD_VERT, POST_FRAG);

  if (!fieldProg || !emitterProg || !terrainProg || !thresholdProg || !downProg || !upProg || !postProg) {
    return null;
  }
  // Narrow once so the inner closures don't need null guards on every use.
  const FIELD: WebGLProgram = fieldProg;
  const EMITTER: WebGLProgram = emitterProg;
  const TERRAIN: WebGLProgram = terrainProg;
  const THRESHOLD: WebGLProgram = thresholdProg;
  const DOWN: WebGLProgram = downProg;
  const UP: WebGLProgram = upProg;
  const POST: WebGLProgram = postProg;

  // Fullscreen quad: shared across all fullscreen passes.
  const quadBuf = gl.createBuffer();
  if (!quadBuf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  // Instance buffer for emitters. Three vec4s per instance = 12 floats.
  // The emitter quad is the same 4-vertex strip as the fullscreen quad —
  // shared geometry.
  const instanceBuf = gl.createBuffer();
  if (!instanceBuf) return null;
  const instanceData = new Float32Array(maxEmitters * 12);

  // Field FBOs (ping-pong) sized at render-time.
  let fieldA: Fbo | null = null;
  let fieldB: Fbo | null = null;
  // Bloom ping-pongs: one per pyramid level (only used at level count > 0).
  const bloomDown: Fbo[] = [];
  const bloomUp: Fbo[] = [];

  let viewW = 1;
  let viewH = 1;
  let fieldW = 1;
  let fieldH = 1;

  function makeFbo(w: number, h: number): Fbo | null {
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      return null;
    }
    // Clear to opaque black so the first sample of prev isn't garbage.
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  function disposeFbo(f: Fbo | null): void {
    if (!f) return;
    gl.deleteTexture(f.tex);
    gl.deleteFramebuffer(f.fbo);
  }

  function rebuildTargets(): void {
    disposeFbo(fieldA);
    disposeFbo(fieldB);
    fieldA = makeFbo(fieldW, fieldH);
    fieldB = makeFbo(fieldW, fieldH);
    for (const f of bloomDown) disposeFbo(f);
    for (const f of bloomUp) disposeFbo(f);
    bloomDown.length = 0;
    bloomUp.length = 0;
    let bw = Math.max(8, Math.floor(viewW / 2));
    let bh = Math.max(8, Math.floor(viewH / 2));
    for (let i = 0; i < bloomLevels; i++) {
      const f = makeFbo(bw, bh);
      if (!f) break;
      bloomDown.push(f);
      bw = Math.max(4, Math.floor(bw / 2));
      bh = Math.max(4, Math.floor(bh / 2));
    }
    bw = Math.max(8, Math.floor(viewW / 2));
    bh = Math.max(8, Math.floor(viewH / 2));
    // Up pyramid mirrors the down pyramid in size: bloomUp[i] is the same
    // resolution as bloomDown[i] (index 0 = largest, viewW/2). The composite
    // loop walks i = N-1 → 0, so the LAST write lands in bloomUp[0] (largest)
    // and bloomSrc = bloomUp[0].tex below is the full-quality bloom result.
    for (let i = 0; i < bloomLevels; i++) {
      const f = makeFbo(bw, bh);
      if (!f) break;
      bloomUp.push(f);
      bw = Math.max(4, Math.floor(bw / 2));
      bh = Math.max(4, Math.floor(bh / 2));
    }
  }

  function bindFullscreenQuad(prog: WebGLProgram): void {
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf!);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  // ---- Cached uniform locations (avoid getUniformLocation per frame) ----
  const fieldUni = {
    prev: gl.getUniformLocation(fieldProg, 'u_prev'),
    decay: gl.getUniformLocation(fieldProg, 'u_decay'),
    warpAmp: gl.getUniformLocation(fieldProg, 'u_warpAmp'),
    warpScale: gl.getUniformLocation(fieldProg, 'u_warpScale'),
    flow: gl.getUniformLocation(fieldProg, 'u_flow'),
    time: gl.getUniformLocation(fieldProg, 'u_time'),
    novelty: gl.getUniformLocation(fieldProg, 'u_novelty'),
    sectionSeed: gl.getUniformLocation(fieldProg, 'u_sectionSeed'),
  };
  const terrainUni = {
    bass: gl.getUniformLocation(terrainProg, 'u_bass'),
    time: gl.getUniformLocation(terrainProg, 'u_time'),
    pan: gl.getUniformLocation(terrainProg, 'u_pan'),
    color: gl.getUniformLocation(terrainProg, 'u_color'),
  };
  const thresholdUni = {
    src: gl.getUniformLocation(thresholdProg, 'u_src'),
    threshold: gl.getUniformLocation(thresholdProg, 'u_threshold'),
  };
  const downUni = {
    src: gl.getUniformLocation(downProg, 'u_src'),
    texel: gl.getUniformLocation(downProg, 'u_texel'),
  };
  const upUni = {
    src: gl.getUniformLocation(upProg, 'u_src'),
    texel: gl.getUniformLocation(upProg, 'u_texel'),
  };
  const postUni = {
    field: gl.getUniformLocation(postProg, 'u_field'),
    bloom: gl.getUniformLocation(postProg, 'u_bloom'),
    bloomIntensity: gl.getUniformLocation(postProg, 'u_bloomIntensity'),
    aberration: gl.getUniformLocation(postProg, 'u_aberration'),
    saturation: gl.getUniformLocation(postProg, 'u_saturation'),
    bg: gl.getUniformLocation(postProg, 'u_bg'),
    hueShift: gl.getUniformLocation(postProg, 'u_hueShift'),
  };

  // ---------------------------------------------------------------------------
  // Emitter pool + slow envelopes (CPU side — Pillar 1 + 3 + 4 logic).
  // ---------------------------------------------------------------------------

  const emitters: Emitter[] = Array.from({ length: maxEmitters }, makeEmitter);
  function spawn(kind: number, x: number, y: number, radius: number, r: number, g: number, b: number, life: number, thickness: number, intensity: number): void {
    // Re-use the oldest dead slot (else the closest-to-dead slot).
    let best = -1;
    let bestAge = -1;
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i]!;
      if (e.lifespan === 0 || e.age >= e.lifespan) {
        best = i;
        break;
      }
      const fraction = e.age / Math.max(0.0001, e.lifespan);
      if (fraction > bestAge) {
        bestAge = fraction;
        best = i;
      }
    }
    if (best < 0) return;
    const e = emitters[best]!;
    e.x = x;
    e.y = y;
    e.baseRadius = radius;
    e.age = 0;
    e.lifespan = life;
    e.r = r;
    e.g = g;
    e.b = b;
    e.kind = kind;
    e.jitter = Math.random();
    e.thickness = thickness;
    e.intensity = intensity;
  }

  // Slow envelopes (CPU side) — bloom + aberration use lingering signals.
  let bloomEnv = 0;
  let aberrEnv = 0;
  let time = 0;
  let lastSectionId = -1;
  let sectionSeed = 0; // re-derived per section for the field warp
  const sectionSeeds: number[] = []; // store per sectionId so returns rhyme

  // ---------------------------------------------------------------------------
  // Public API.
  // ---------------------------------------------------------------------------

  function resize(cssWidth: number, cssHeight: number, dpr: number): void {
    // Cap internal render resolution sensibly: 2.5 MP at high tier, scaled
    // down per quality, and trim DPR so a 4K monitor doesn't murder the GPU.
    const dprClamp = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
    const eff = Math.min(dpr, dprClamp);
    const w = Math.max(2, Math.floor(cssWidth * eff));
    const h = Math.max(2, Math.floor(cssHeight * eff));
    // No-op unless the pixel dimensions actually changed. Rebuilding the
    // RGBA16F field + bloom FBOs every frame destroys the feedback persistence
    // (decay/curl/trails go dead) and churns GPU memory. Initial viewW=1 means
    // the first real call still triggers a build.
    if (w === viewW && h === viewH) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    viewW = w;
    viewH = h;
    fieldW = Math.max(2, Math.floor(w * fieldScale));
    fieldH = Math.max(2, Math.floor(h * fieldScale));
    rebuildTargets();
  }

  // Pillar 1 spawn router — translate one EvilandFrame.onsets[] into emitters.
  function routeOnsets(frame: EvilandFrame, palette: EvilandPalette): void {
    for (const on of frame.onsets) {
      // Frequency → vertical (low at bottom, high at top); add a small jitter
      // so successive same-band onsets don't perfectly overlay.
      const bandY = on.band / 23; // 0..1
      const y = -1 + bandY * 2;
      // Stereo pan → horizontal, with a per-onset jitter.
      const px = frame.pan * 0.6 + (Math.random() - 0.5) * (0.18 + on.sharpness * 0.18);
      const x = Math.max(-0.95, Math.min(0.95, px));
      const intensity = 0.55 + on.intensity * 0.55;
      switch (on.group) {
        case 'kick': {
          // Bright low shockwave from bottom-centre, palette.dark.
          spawn(0, frame.pan * 0.25, -0.85, 0.9, palette.dark[0], palette.dark[1], palette.dark[2], 0.9, 0.06 + on.sharpness * 0.10, intensity);
          // Core punch (compresses+rebounds — kind 4).
          spawn(4, frame.pan * 0.1, -0.15, 0.22 + frame.kick * 0.10, palette.dark[0], palette.dark[1] * 0.8, palette.dark[2] * 0.6, 0.32, 0, intensity);
          break;
        }
        case 'bass':
          // Wide low ring — rarer than kick, slower spread.
          spawn(0, x * 0.5, -0.6, 1.1, palette.dark[0] * 0.8, palette.dark[1] * 0.7, palette.dark[2] * 1.2, 1.1, 0.05, intensity * 0.85);
          break;
        case 'snare':
          // Off-centre white burst.
          spawn(1, x, 0.05 + Math.random() * 0.18 - 0.09, 0.30 + on.intensity * 0.10, palette.light[0], palette.light[1], palette.light[2], 0.35, 0, intensity);
          break;
        case 'hat':
          // Fine sparkle high.
          spawn(2, x + (Math.random() - 0.5) * 0.4, 0.55 + Math.random() * 0.30, 0.12 + on.intensity * 0.06, palette.accent[0], palette.accent[1], palette.accent[2], 0.28, 0, intensity * 0.9);
          break;
        case 'vocal': {
          // Coherent blob mid-screen — y tracks centroid, x tracks pan.
          const vy = (frame.centroid - 0.5) * 1.2;
          const vx = frame.pan * 0.6;
          spawn(3, vx, vy, 0.40 + frame.vocal * 0.10, palette.accent[0], palette.accent[1], palette.accent[2], 0.55, 0, intensity * 0.7);
          break;
        }
        default:
          // Generic: dim ring at the assigned position.
          spawn(0, x, y * 0.85, 0.55, palette.accent[0] * 0.7, palette.accent[1] * 0.7, palette.accent[2] * 0.7, 0.55, 0.04, intensity * 0.6);
      }
    }
    // Pillar 4 — Anticipation. When tempo confidence is decent, drop a faint
    // "windup" core that grows as beatPhase nears 1 so the kick resolves *on*
    // the beat instead of after. Cheap: just modulate the core kind via a
    // continuous emitter whose intensity rises with phase.
    if (frame.beatConfidence > 0.35 && frame.beatPhase > 0.78) {
      const lead = (frame.beatPhase - 0.78) / 0.22; // 0..1
      spawn(4, 0, -0.15, 0.10 + lead * 0.10, palette.dark[0], palette.dark[1] * 0.7, palette.dark[2] * 0.5, 0.18, 0, lead * 0.7 * frame.beatConfidence);
    }
  }

  function packEmitters(): number {
    let active = 0;
    const aspect = viewH / Math.max(1, viewW);
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i]!;
      if (e.lifespan === 0 || e.age >= e.lifespan) continue;
      const age01 = e.age / e.lifespan;
      const base = active * 12;
      // i_posSize
      instanceData[base + 0] = e.x;
      instanceData[base + 1] = e.y;
      instanceData[base + 2] = e.baseRadius;
      instanceData[base + 3] = age01;
      // i_color
      instanceData[base + 4] = e.r;
      instanceData[base + 5] = e.g;
      instanceData[base + 6] = e.b;
      instanceData[base + 7] = aspect; // shader reads this as aspect adjust
      // i_kindData
      instanceData[base + 8] = e.kind;
      instanceData[base + 9] = e.jitter;
      instanceData[base + 10] = e.thickness;
      instanceData[base + 11] = e.intensity;
      active++;
    }
    return active;
  }

  function advanceEmitters(dtSeconds: number): void {
    for (const e of emitters) {
      if (e.lifespan > 0) e.age += dtSeconds;
    }
  }

  function drawFullscreen(): void {
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Bind 3-vec4 instance attribs starting at attribute location offset.
  function bindEmitterAttribs(): void {
    const aPos = gl.getAttribLocation(EMITTER, 'a_quad');
    const iPosSize = gl.getAttribLocation(EMITTER, 'i_posSize');
    const iColor = gl.getAttribLocation(EMITTER, 'i_color');
    const iKindData = gl.getAttribLocation(EMITTER, 'i_kindData');
    // Per-vertex quad
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf!);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aPos, 0);
    // Per-instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf!);
    const stride = 12 * 4; // 12 floats * 4 bytes
    gl.enableVertexAttribArray(iPosSize);
    gl.vertexAttribPointer(iPosSize, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(iPosSize, 1);
    gl.enableVertexAttribArray(iColor);
    gl.vertexAttribPointer(iColor, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(iColor, 1);
    gl.enableVertexAttribArray(iKindData);
    gl.vertexAttribPointer(iKindData, 4, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(iKindData, 1);
  }

  function unbindEmitterDivisors(): void {
    // Reset divisors AND disable the per-instance attrib arrays so subsequent
    // fullscreen passes (drawArrays(TRIANGLE_STRIP,0,4)) don't read past
    // instanceBuf's `active*48`-byte payload when active < 4. Leaving them
    // enabled is undefined behaviour — INVALID_OPERATION on strict drivers,
    // black frames / context loss on some Intel stacks.
    const iPosSize = gl.getAttribLocation(EMITTER, 'i_posSize');
    const iColor = gl.getAttribLocation(EMITTER, 'i_color');
    const iKindData = gl.getAttribLocation(EMITTER, 'i_kindData');
    if (iPosSize >= 0) {
      gl.vertexAttribDivisor(iPosSize, 0);
      gl.disableVertexAttribArray(iPosSize);
    }
    if (iColor >= 0) {
      gl.vertexAttribDivisor(iColor, 0);
      gl.disableVertexAttribArray(iColor);
    }
    if (iKindData >= 0) {
      gl.vertexAttribDivisor(iKindData, 0);
      gl.disableVertexAttribArray(iKindData);
    }
  }

  function render(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void {
    if (!fieldA || !fieldB) {
      // Resize hasn't run yet — skip; caller will resize on first paint.
      return;
    }
    const dt = Math.max(0.0005, Math.min(0.1, dtMs / 1000));
    time += dt;

    // Pillar 3: structural memory. New section → record/replay a seed; this
    // makes the field's warp signature recognisable when the chorus returns.
    if (frame.sectionChanged) {
      if (frame.sectionReturn >= 0 && frame.sectionReturn < sectionSeeds.length) {
        sectionSeed = sectionSeeds[frame.sectionReturn]!;
      } else {
        // Stable but unique per-section pseudo-random seed.
        sectionSeed = ((frame.sectionId * 4099 + 17) % 997) / 100;
      }
      sectionSeeds[frame.sectionId] = sectionSeed;
      // Spawn a full-field flash by injecting a bright burst at centre.
      spawn(3, 0, 0, 1.4, palette.light[0], palette.light[1], palette.light[2], 0.45, 0, 0.9);
      lastSectionId = frame.sectionId;
    } else if (lastSectionId !== frame.sectionId && frame.sectionId < sectionSeeds.length) {
      sectionSeed = sectionSeeds[frame.sectionId]!;
      lastSectionId = frame.sectionId;
    }

    // Pillar 1: route onsets → emitter pool.
    routeOnsets(frame, palette);

    // CPU envelopes for bloom / aberration. Bloom lingers (slow release) on
    // energy+crest; aberration is gated to snare+hat only.
    const targetBloom = Math.min(1, frame.energy * 0.7 + frame.crest * 0.5);
    bloomEnv += (targetBloom - bloomEnv) * (targetBloom > bloomEnv ? 0.18 : 0.05);
    const targetAberr = Math.min(1, frame.snare * 0.8 + frame.hat * 0.5);
    aberrEnv += (targetAberr - aberrEnv) * (targetAberr > aberrEnv ? 0.35 : 0.06);

    // Upload instance data + advance ages.
    const active = packEmitters();
    advanceEmitters(dt);

    // ---- PASS 1: feedback field (advect prev → fieldB) ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, fieldB.fbo);
    gl.viewport(0, 0, fieldW, fieldH);
    gl.disable(gl.BLEND);
    gl.useProgram(FIELD);
    bindFullscreenQuad(FIELD);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldA.tex);
    gl.uniform1i(fieldUni.prev, 0);
    // Decay: slower decay during sustains, faster after onsets — but never
    // below 0.94 (the field needs persistence).
    const decay = 0.96 + 0.026 * (1 - frame.flatness) - 0.014 * frame.crest;
    gl.uniform1f(fieldUni.decay, Math.max(0.94, Math.min(0.995, decay)));
    gl.uniform1f(fieldUni.warpAmp, 0.0015 + frame.bass * 0.0075);
    gl.uniform1f(fieldUni.warpScale, 2.5 + frame.width * 1.8);
    gl.uniform2f(fieldUni.flow, frame.pan * 0.0008 + 0.00012, -0.00018);
    gl.uniform1f(fieldUni.time, time);
    gl.uniform1f(fieldUni.novelty, frame.novelty);
    gl.uniform1f(fieldUni.sectionSeed, sectionSeed);
    drawFullscreen();

    // ---- PASS 2: terrain (bass horizon) drawn into the field ----
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(TERRAIN);
    bindFullscreenQuad(TERRAIN);
    gl.uniform1f(terrainUni.bass, frame.bass);
    gl.uniform1f(terrainUni.time, time);
    gl.uniform1f(terrainUni.pan, frame.pan);
    gl.uniform3f(terrainUni.color, palette.dark[0] * 0.8 + palette.accent[0] * 0.2, palette.dark[1] * 0.7, palette.dark[2] * 0.9);
    drawFullscreen();

    // ---- PASS 3: emitter splats (additive) ----
    if (active > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instanceData.subarray(0, active * 12), gl.DYNAMIC_DRAW);
      gl.useProgram(EMITTER);
      bindEmitterAttribs();
      gl.blendFunc(gl.ONE, gl.ONE); // additive
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, active);
      unbindEmitterDivisors();
    }
    gl.disable(gl.BLEND);

    // Swap field ping-pong.
    const tmp = fieldA;
    fieldA = fieldB;
    fieldB = tmp;

    // ---- PASS 4: bloom pyramid (threshold → kawase down → kawase up) ----
    let bloomSrc: WebGLTexture | null = null;
    if (bloomLevels > 0 && bloomDown.length === bloomLevels && bloomUp.length === bloomLevels) {
      // Threshold from final field into bloomDown[0].
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomDown[0]!.fbo);
      gl.viewport(0, 0, bloomDown[0]!.w, bloomDown[0]!.h);
      gl.useProgram(THRESHOLD);
      bindFullscreenQuad(THRESHOLD);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fieldA.tex);
      gl.uniform1i(thresholdUni.src, 0);
      gl.uniform1f(thresholdUni.threshold, 0.18);
      drawFullscreen();
      // Down levels 1..N-1
      for (let i = 1; i < bloomLevels; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomDown[i]!.fbo);
        gl.viewport(0, 0, bloomDown[i]!.w, bloomDown[i]!.h);
        gl.useProgram(DOWN);
        bindFullscreenQuad(DOWN);
        gl.bindTexture(gl.TEXTURE_2D, bloomDown[i - 1]!.tex);
        gl.uniform1i(downUni.src, 0);
        gl.uniform2f(downUni.texel, 1 / bloomDown[i - 1]!.w, 1 / bloomDown[i - 1]!.h);
        drawFullscreen();
      }
      // Up levels 0..N-1 (smallest → largest) reading from bloomDown[N-1] up.
      let prevTex = bloomDown[bloomLevels - 1]!.tex;
      for (let i = bloomLevels - 1; i >= 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomUp[i]!.fbo);
        gl.viewport(0, 0, bloomUp[i]!.w, bloomUp[i]!.h);
        gl.useProgram(UP);
        bindFullscreenQuad(UP);
        gl.bindTexture(gl.TEXTURE_2D, prevTex);
        gl.uniform1i(upUni.src, 0);
        gl.uniform2f(upUni.texel, 1 / bloomUp[i]!.w, 1 / bloomUp[i]!.h);
        drawFullscreen();
        prevTex = bloomUp[i]!.tex;
      }
      bloomSrc = bloomUp[0]!.tex;
    }

    // ---- PASS 5: final composite to screen ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewW, viewH);
    gl.useProgram(POST);
    bindFullscreenQuad(POST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldA.tex);
    gl.uniform1i(postUni.field, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomSrc ?? fieldA.tex);
    gl.uniform1i(postUni.bloom, 1);
    gl.uniform1f(postUni.bloomIntensity, bloomSrc ? 0.45 + bloomEnv * 0.65 : 0);
    gl.uniform1f(postUni.aberration, aberrationOn ? aberrEnv * 0.9 : 0);
    gl.uniform1f(postUni.saturation, Math.max(0.25, 1 - frame.flatness * 0.65));
    gl.uniform3f(postUni.bg, palette.bg[0], palette.bg[1], palette.bg[2]);
    // Centroid → hue: tilt the colour toward the accent at high centroid,
    // toward the dark/warm at low centroid; stay close to neutral overall.
    const c = frame.centroid;
    gl.uniform3f(
      postUni.hueShift,
      0.85 + (palette.accent[0] * 0.4 + (1 - c) * 0.25),
      0.9 + (palette.accent[1] * 0.35 + c * 0.05),
      0.85 + (palette.accent[2] * 0.45 + c * 0.30),
    );
    drawFullscreen();
  }

  function dispose(): void {
    if (fieldProg) gl.deleteProgram(fieldProg);
    if (emitterProg) gl.deleteProgram(emitterProg);
    if (terrainProg) gl.deleteProgram(terrainProg);
    if (thresholdProg) gl.deleteProgram(thresholdProg);
    if (downProg) gl.deleteProgram(downProg);
    if (upProg) gl.deleteProgram(upProg);
    if (postProg) gl.deleteProgram(postProg);
    if (quadBuf) gl.deleteBuffer(quadBuf);
    if (instanceBuf) gl.deleteBuffer(instanceBuf);
    disposeFbo(fieldA);
    disposeFbo(fieldB);
    for (const f of bloomDown) disposeFbo(f);
    for (const f of bloomUp) disposeFbo(f);
    fieldA = null;
    fieldB = null;
    bloomDown.length = 0;
    bloomUp.length = 0;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  return { resize, render, dispose };
}
