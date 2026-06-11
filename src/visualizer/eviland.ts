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
import { evalConfig, createDynamics, defaultConfig, type OperatorConfig } from './eviland-operators';
import { createFluidSim, fluidForcesFromFrame, dyeDissipationFromFrame, type FluidSim } from './eviland-fluid';

export interface EvilandPalette {
  accent: [number, number, number]; // each channel 0..1
  dark: [number, number, number];
  light: [number, number, number];
  bg: [number, number, number];
}

export interface EvilandRenderer {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void;
  /** Swap the active operator config (the "look"). Default reproduces classic Eviland. */
  setConfig(config: OperatorConfig): void;
  /** Read the active operator config. */
  getConfig(): OperatorConfig;
  /** Upload time-domain samples (Uint8, 128 = silence) for the waveform layer. */
  setWaveform(samples: Uint8Array): void;
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

// Pillar 2: feedback field — MilkDrop-style per-frame transform of the previous
// frame. Each frame we (optionally) FOLD the sampling coord into N-fold mirror
// symmetry, ZOOM in around centre (tunnel rush), ROTATE+SWIRL around centre,
// add curl-noise organic detail, then sample the prev field and HUE-CYCLE the
// colour. The mirror fold is the single most "MilkDrop" trick — kaleidoscope.
const FIELD_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_prev;
uniform vec3  u_decay;       // plan §2.3 per-channel RGB decay
uniform float u_warpAmp;
uniform float u_warpScale;
uniform vec2  u_flow;
uniform float u_time;
uniform float u_novelty;
uniform float u_sectionSeed;
uniform float u_zoom;        // 0 = static, positive = zoom IN (tunnel toward centre)
uniform float u_rotate;      // radians per frame of central rotation
uniform float u_hueCycle;    // radians to rotate the sampled colour's hue (0..~0.1)
uniform float u_swirl;       // swirl strength (rotation falls off with radius)
uniform float u_mirror;      // segment count (0 = off; 2..8 active)
uniform float u_mirrorMix;   // 0..1 blend between unfolded and folded sample
uniform sampler2D u_velocity; // stable-fluids sim velocity (RG16F, UV/s)
uniform float u_fluid;       // sim influence, premultiplied by dt CPU-side (0 = off)
// Plan §2.2 radial warp profile gains (multiply radius² for per-pixel character).
uniform float u_zoomRadGain;
uniform float u_rotateRadGain;
uniform float u_swirlRadGain;
uniform float u_decayRadGain;
// Plan §2.4 centre offset (default vec2(0.5)). Clamped CPU-side to [0.2,0.8].
uniform vec2  u_centre;
${NOISE_GLSL}

const float TAU = 6.28318530718;

// YIQ-based hue rotation matrix — compact and stable; rotates around the
// luminance axis so brightness is preserved. Cheaper than rgb→hsv→rgb.
vec3 rotateHue(vec3 col, float ang){
  float c = cos(ang); float s = sin(ang);
  // RGB → YIQ
  float y = dot(col, vec3(0.299, 0.587, 0.114));
  float i = dot(col, vec3(0.596,-0.274,-0.322));
  float q = dot(col, vec3(0.211,-0.523, 0.312));
  // Rotate I/Q (chroma) plane
  float i2 = c*i - s*q;
  float q2 = s*i + c*q;
  // YIQ → RGB
  return vec3(
    y + 0.956*i2 + 0.621*q2,
    y - 0.272*i2 - 0.647*q2,
    y - 1.106*i2 + 1.703*q2
  );
}

// Fold polar angle into 1/N of the circle then mirror — classic kaleidoscope.
// Returns a Cartesian offset from centre (caller adds centre back).
vec2 kaleidoFold(vec2 p, float segments){
  float r = length(p);
  float a = atan(p.y, p.x);
  float seg = TAU / segments;
  float folded = abs(mod(a + seg * 0.5, seg) - seg * 0.5);
  return vec2(cos(folded), sin(folded)) * r;
}

void main(){
  vec2 uv = v_uv;
  // Plan §2.4: centre is now a moving uniform. Defaults to vec2(0.5) so the
  // fold/zoom axis matches the pre-2.4 behaviour exactly.
  vec2 centre = u_centre;
  vec2 p = uv - centre;

  // MilkDrop motion: rotate around the centre, with stronger spin near the
  // edge (swirl) so the image rolls instead of rigidly rotating.
  float radius = length(p);
  float r2 = radius * radius;
  // Plan §2.2: each transform gets a radius² gain so the channel's strength
  // varies with distance from centre. Gains default to 0 → bit-identical to
  // pre-2.2 (the additive term vanishes everywhere).
  float zoomEff = u_zoom + u_zoomRadGain * r2;
  float rotEff = u_rotate + u_rotateRadGain * r2;
  float swirlEff = u_swirl + u_swirlRadGain * r2;
  float ang = rotEff + swirlEff * radius;
  float ca = cos(ang); float sa = sin(ang);
  p = mat2(ca, -sa, sa, ca) * p;

  // Zoom: multiply by inverse zoom so positive u_zoom pulls UV inward
  // (trails appear to march OUT from the centre as a tunnel rush).
  float invZ = 1.0 / (1.0 + zoomEff);
  p *= invZ;

  // Kaleidoscope fold — optional. When u_mirror >= 2 we blend in a folded
  // copy of the same sample coord; u_mirrorMix=1 = full kaleidoscope,
  // u_mirrorMix=0 = off. Cheap (a single atan/cos/sin).
  vec2 pFinal = p;
  if (u_mirror >= 1.5 && u_mirrorMix > 0.001) {
    vec2 folded = kaleidoFold(p, u_mirror);
    pFinal = mix(p, folded, clamp(u_mirrorMix, 0.0, 1.0));
  }

  // Re-centre + organic curl detail (small) modulated by treble/novelty.
  vec2 src = pFinal + centre;
  vec2 base = src * u_warpScale + vec2(u_time * 0.018, -u_time * 0.014)
            + vec2(u_sectionSeed, -u_sectionSeed*0.7);
  vec2 w = curl(base) * u_warpAmp;
  w += curl(base * 2.1 + 11.7) * (u_warpAmp * 0.45 + u_novelty * 0.6);

  // Simulated fluid displacement: velocity is UV/s and u_fluid carries
  // channel * scale * dt, so this composes with the procedural warp. When
  // u_fluid = 0 the subtraction is a zero vector — bit-identical to before.
  vec2 simFlow = texture(u_velocity, src).xy * u_fluid;
  src = clamp(src - u_flow + w - simFlow, 0.001, 0.999);
  vec3 prev = texture(u_prev, src).rgb;

  // Hue cycle: shift colour every frame so trails drift across the palette.
  prev = rotateHue(prev, u_hueCycle);
  // Plan §2.3: per-RGB decay. u_decay is a vec3; default = (d,d,d) reproduces
  // the scalar decay exactly. Plan §2.2 radial decay bias adds r²-scaled gain
  // before clamp so the trail length can change with distance from centre.
  vec3 decayRGB = clamp(u_decay + vec3(u_decayRadGain * r2), vec3(0.65), vec3(0.99));
  prev *= decayRGB;
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
  float life = (1.0 - v_age);
  if (life <= 0.0) discard;
  vec3 col = v_color.rgb;
  float alpha = 0.0;
  if (v_kind == 0) {
    // Ring (kick): thin bright annulus that expands with age. Crisp falloff
    // (40 instead of 2 in the gaussian) so the ring reads as a structured
    // line being drawn into the feedback field, not a soft puff.
    float band = max(0.003, v_thick * 0.6);
    float ring = exp(-pow((r - v_age) / band, 2.0) * 40.0);
    alpha = ring * life * v_intensity * 0.85;
  } else if (v_kind == 1) {
    // Burst (snare): a sharp star — radial spikes plus a hot core. Reads as
    // a distinct hit rather than a haze.
    float core = exp(-r*r * 40.0);
    float angle = atan(v_local.y, v_local.x);
    float spike = pow(max(0.0, abs(cos(angle * 3.0))), 12.0) * exp(-r*r * 6.0);
    alpha = (core + spike * 0.6) * life * v_intensity * 0.7;
  } else if (v_kind == 2) {
    // Sparkle (hat): crisp pinpoint + thin cross-streaks (cardinal directions).
    float pin = exp(-r*r * 140.0);
    float ang = atan(v_local.y, v_local.x);
    float cross = pow(abs(cos(ang * 2.0)), 32.0) * exp(-r * 22.0);
    alpha = (pin + cross * 0.5) * life * v_intensity * 0.75;
  } else if (v_kind == 3) {
    // Blob (vocal): tighter + dimmer so it stops piling up into a central
    // white blob (it spawns mid-screen on every vocal onset and additively
    // over-accumulates). A defined orb, not a soft puff.
    alpha = exp(-r*r * 14.0) * life * v_intensity * 0.38;
  } else {
    // Core (kick punch): solid disc with a hard rim.
    float disc = smoothstep(0.78, 0.62, r);
    float rim  = smoothstep(0.95, 0.86, r) - smoothstep(0.86, 0.78, r);
    alpha = (disc * 0.55 + max(0.0, rim) * 0.85) * life * v_intensity * 0.7;
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

// Pillar 1 (spectrum): the bright structural overlay MilkDrop draws every
// frame, which then gets sucked into the feedback flow next frame so the lines
// leave swirling trails. We draw a centred radial "sun" of 24 rays, one per
// mel band; ray length = band magnitude. Cheap, crisp, additively composited
// into the field BEFORE ping-pong swap so the feedback advect captures it.
const SPECTRUM_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_bands;   // 24x1 R32F texture; r = band magnitude 0..1
uniform vec3  u_color;
uniform float u_intensity;
uniform float u_time;
uniform float u_aspect;      // viewH / viewW for ray length normalisation

const float TAU2 = 6.28318530718;
const float SEGMENTS = 24.0;

void main(){
  vec2 p = v_uv - vec2(0.5);
  p.x /= max(0.0001, u_aspect); // square the radial space
  float r = length(p) * 2.0;       // 0 at centre .. ~1 at edge
  float a = atan(p.y, p.x);        // -PI..PI
  // Band index from angle. Slowly rotate over time so the spectrum sweeps.
  float t = (a + TAU2 + u_time * 0.07) / TAU2;
  float idx = fract(t) * SEGMENTS;
  float i0 = floor(idx);
  float frac = idx - i0;
  // Sample two neighbouring bands and linearly interpolate so the rays
  // blend smoothly between segments instead of stepping.
  float u0 = (i0 + 0.5) / SEGMENTS;
  float u1 = (mod(i0 + 1.0, SEGMENTS) + 0.5) / SEGMENTS;
  float b0 = texture(u_bands, vec2(u0, 0.5)).r;
  float b1 = texture(u_bands, vec2(u1, 0.5)).r;
  float band = mix(b0, b1, frac);
  // Ray reaches to ~0.08 + band*0.55 (inside the screen).
  float rayLen = 0.08 + band * 0.55;
  // Crisp ray edge along the radius — rises near the centre, falls past tip.
  float radial = smoothstep(0.05, 0.10, r) * (1.0 - smoothstep(rayLen, rayLen + 0.025, r));
  // Sharp angular cut so rays read as distinct lines, not a soft sun.
  float seg = TAU2 / SEGMENTS;
  float folded = abs(mod(a + seg * 0.5, seg) - seg * 0.5);
  float angular = pow(1.0 - clamp(folded / (seg * 0.45), 0.0, 1.0), 6.0);
  float ray = radial * angular;
  // A small bright centre so the sun has a hot core — kept modest so the middle
  // is a clean "eye", not a permanent blown-out white blob.
  float core = exp(-r * r * 60.0) * 0.22;
  float a_out = clamp((ray + core) * u_intensity, 0.0, 1.0);
  o = vec4(u_color * a_out, a_out);
}`;

// Pillar 1 (waveform): the signature MilkDrop oscilloscope. A bright continuous
// line drawn from the live time-domain samples (256x1 R8 texture, 0.5=silence),
// composited additively into the field BEFORE the ping-pong swap so the warp
// advects it into trails. Modes: 1 line, 2 radial ring, 4 spectrum bars
// (3 lissajous falls back to line). Anti-aliased via smoothstep on the signed
// distance to the waveform curve.
const WAVE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_wave;   // 256x1 R8, .r in 0..1, 0.5 = silence
uniform float u_mode;       // 1 line, 2 radial, 3 lissajous, 4 bars
uniform vec3  u_color;
uniform float u_intensity;
uniform float u_thickness;
uniform float u_scale;
uniform float u_aspect;     // viewH / viewW
const float TAU = 6.28318530718;
float samp(float t){ return texture(u_wave, vec2(clamp(t, 0.0, 1.0), 0.5)).r - 0.5; }
void main(){
  vec2 uv = v_uv;
  float th = max(0.0025, u_thickness);
  int mode = int(u_mode + 0.5);
  float a = 0.0;
  if (mode == 2) {
    // Radial ring: angle → sample index, displaced radius.
    vec2 p = uv - 0.5; p.x /= max(0.0001, u_aspect);
    float r = length(p);
    float ang = atan(p.y, p.x);
    float t = (ang + 3.14159265) / TAU;
    float w = samp(t) * u_scale;
    float r0 = 0.28 + w;
    a = smoothstep(th, 0.0, abs(r - r0));
  } else if (mode == 4) {
    // Spectrum bars: vertical bars whose height tracks |sample|.
    float bars = 64.0;
    float bx = (floor(uv.x * bars) + 0.5) / bars;
    float w = abs(samp(bx)) * 2.0 * u_scale;
    float inBar = step(0.5 - w, uv.y) * step(uv.y, 0.5 + w);
    float gap = smoothstep(0.0, 0.07, abs(fract(uv.x * bars) - 0.5));
    a = inBar * gap;
  } else {
    // Horizontal line (default + lissajous fallback): bright core + soft body.
    float w = samp(uv.x) * u_scale;
    float d = abs(uv.y - (0.5 + w));
    a = smoothstep(th, 0.0, d) + 0.35 * smoothstep(th * 3.0, 0.0, d);
  }
  a *= u_intensity;
  if (a <= 0.004) discard;
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

// Plan §2.6 identity blit — copies a texture into the bound FBO with no math.
// Used to capture the field snapshot at the start of a crossfade. Cheap one-
// off; allocates no per-frame work when no transition is in flight.
const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
void main(){ o = texture(u_src, v_uv); }`;

// Plan §2.5 video-echo pass. Reads the previous frame's field, samples it at a
// zoom/rotation/flip offset, and writes that into a separate echo target. The
// composite then blends echo on top of the live field with `u_echoAlpha`. The
// echo's prev-frame state is kept in the echo target itself so it feeds back
// from frame to frame (the "video echo" repeat). When alpha=0 we skip the
// entire pass and the FBO is never allocated, so default behaviour matches
// today byte-for-byte.
const ECHO_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_field;    // current live field (post-swap)
uniform sampler2D u_prevEcho; // last frame's echo target (feedback)
uniform float u_zoom;
uniform float u_rot;
uniform float u_flipX;        // 0 or 1
uniform float u_flipY;        // 0 or 1
uniform float u_feedback;     // how much of last echo bleeds in (≈0.55)
uniform vec2  u_centre;
void main(){
  vec2 uv = v_uv;
  vec2 p = uv - u_centre;
  // Optional flip — mirrors the echo through the centre axis.
  if (u_flipX > 0.5) p.x = -p.x;
  if (u_flipY > 0.5) p.y = -p.y;
  float ca = cos(u_rot);
  float sa = sin(u_rot);
  p = mat2(ca, -sa, sa, ca) * p;
  float invZ = 1.0 / (1.0 + u_zoom);
  p *= invZ;
  vec2 src = clamp(p + u_centre, 0.001, 0.999);
  vec3 fieldC = texture(u_field, uv).rgb;
  vec3 echoC = texture(u_prevEcho, src).rgb * u_feedback;
  // Echo target keeps the bright field + decayed feedback so the repeat is
  // visible as ghost trails fading over multiple frames.
  vec3 outC = fieldC * 0.92 + echoC;
  o = vec4(outC, 1.0);
}`;

// Final composite: map the field through a palette ramp (bg → accent → light)
// so the image has REAL COLOUR not a brightness-to-white ramp; mix bloom in at
// reduced weight; chromatic aberration on snare+hat only; ACES tone-map +
// vignette. This is the difference between "white cloud" and "vivid scene".
const POST_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_field;
uniform sampler2D u_bloom;
uniform sampler2D u_dye;     // simulated-fluid dye (RGBA16F)
uniform sampler2D u_echo;    // video-echo target (plan §2.5)
uniform sampler2D u_snapshot;// pre-fade field snapshot (plan §2.6)
uniform float u_bloomIntensity;
uniform float u_aberration; // 0 off .. 1 strong
uniform float u_saturation; // 0..1 (1 = full, 0 = monochrome)
uniform float u_liquidMix;   // 0 dye invisible (legacy look) .. 1 dye-dominant
uniform float u_echoAlpha;   // 0 = echo pass off (plan §2.5)
uniform float u_snapshotMix; // 0 = no crossfade in flight; 1 = full from-snapshot
uniform vec3  u_bg;
uniform vec3  u_accent;
uniform vec3  u_dark;
uniform vec3  u_light;
uniform vec3  u_hueShift;   // mild centroid tint

vec3 aces(vec3 x){
  const float a=2.51; const float b=0.03; const float c=2.43;
  const float d=0.59; const float e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}

// Three-stop palette ramp by intensity: dark grounds the image, accent fills
// the body, light caps the highlights. The field's own hue (from the cycled
// feedback) tints the ramp so each instrument's colour still reads through.
vec3 paletteRamp(float t, vec3 fieldTint){
  vec3 lo = mix(u_dark, u_accent, smoothstep(0.0, 0.55, t));
  // Highlights only lean PART-WAY to the warm "light" stop (full reach was the
  // root of the cream blow-out — every bright region became cream). Mostly they
  // brighten along the accent, so loud events read as the instrument colour.
  vec3 hi = mix(u_accent, u_light, smoothstep(0.45, 1.0, t) * 0.5);
  vec3 ramp = mix(lo, hi, smoothstep(0.40, 0.65, t));
  // Tint HARD by the field's own hue so per-instrument colour dominates the
  // palette, not the other way round (was 0.55 → palette won → monochrome).
  return mix(ramp, ramp * (0.45 + fieldTint * 1.7), 0.7);
}

void main(){
  vec2 uv = v_uv;
  vec2 dir = uv - 0.5;
  float r2 = dot(dir, dir);
  // Aberration: sample R/B with opposing radial offsets, G centred.
  float amt = u_aberration * (0.003 + r2 * 0.018);
  vec3 fieldC;
  fieldC.r = texture(u_field, uv + dir * amt * 1.3).r;
  fieldC.g = texture(u_field, uv).g;
  fieldC.b = texture(u_field, uv - dir * amt * 1.3).b;

  // Plan §2.6 field-buffer crossfade. When the Director starts a fade the
  // renderer snapshots the field into u_snapshot; this mix smoothly walks
  // from the FROM look's frozen field over to the TO look's live one,
  // killing the mid-fade tear caused by discrete-channel snapping (mirrorSet,
  // waveMode). When no fade is in flight u_snapshotMix=0 → no-op.
  if (u_snapshotMix > 0.0) {
    vec3 snap = texture(u_snapshot, uv).rgb;
    fieldC = mix(fieldC, snap, clamp(u_snapshotMix, 0.0, 1.0));
  }

  // Plan §2.5 video-echo composite. Default alpha=0 = no echo, no FBO touch.
  // The echo target keeps a self-feeding decayed copy so trails repeat
  // visibly. Blended on top of the field BEFORE palette ramp + bloom so the
  // echo participates in tone-mapping like a real feedback layer would.
  if (u_echoAlpha > 0.0) {
    vec3 echoC = texture(u_echo, uv).rgb;
    fieldC = mix(fieldC, echoC, clamp(u_echoAlpha, 0.0, 0.9));
  }

  // Intensity drives the palette ramp; chroma from the field tints it so the
  // hue-cycled feedback shows through as colour drift instead of being lost.
  float intensity = clamp(dot(fieldC, vec3(0.34, 0.42, 0.24)), 0.0, 1.4);
  vec3 chroma = (fieldC + 1e-4) / (max(max(fieldC.r, fieldC.g), fieldC.b) + 0.05);
  vec3 colour = paletteRamp(intensity, chroma);

  // Eviland Liquid: the simulated dye is the picture. At u_liquidMix = 0 the
  // entire dye block below is gated out by the shader (the if(u_liquidMix>0)
  // branch never executes), so the dye contribution is strictly zero and the
  // composite is byte-identical to the pre-dye look — every existing
  // archetype keeps its exact output, matching the README's backward-compat
  // claim. At u_liquidMix = 1 the palette ramp is fully replaced by the dye
  // color (with a gentle floor mixed back in for unlit regions so empty zones
  // aren't pitch black). Sampling happens BEFORE bloom/aberration so bloom
  // still glows on the brightest dye streaks.
  if (u_liquidMix > 0.0) {
    vec3 dye = texture(u_dye, uv).rgb;
    // Saturate via tanh-ish: dye stays bright but never blows past ~1 without
    // tone-mapping help. Keeps the silence floor visible (low values pass
    // through almost linearly).
    vec3 dyeSat = dye / (1.0 + 0.35 * dye);
    // Floor: at high liquidMix we still want a faint palette wash in quiet
    // regions instead of dead black, so the empty parts read as a tinted
    // canvas, not a void. Weight by ramp's accent so the archetype palette
    // is the substrate even at liquidMix=1.
    vec3 floorCol = u_accent * 0.08;
    vec3 dyeFull = max(dyeSat, floorCol);
    colour = mix(colour, dyeFull, clamp(u_liquidMix, 0.0, 1.0));
  }

  // Soft additive bloom on top — at HALF the previous weight so highlights
  // glow rather than clip the whole frame white.
  vec3 bloomC = texture(u_bloom, uv).rgb * u_bloomIntensity * 0.5;
  colour += bloomC;

  // KILL the cream/white blow-out. Where the feedback over-accumulates, every
  // channel clips high → a desaturated cream/white blob (the whole "gold/cream
  // smoke" complaint). A white pixel has no hue left to preserve, so we detect
  // bright-AND-desaturated regions and pull them back toward the accent hue at
  // the same brightness. Already-coloured areas (pink rings, cyan bursts) have
  // high saturation → untouched.
  float cmax = max(max(colour.r, colour.g), colour.b);
  float cmin = min(min(colour.r, colour.g), colour.b);
  float csat = (cmax - cmin) / max(cmax, 1e-3);
  float washed = smoothstep(0.62, 1.05, cmax) * (1.0 - smoothstep(0.10, 0.36, csat));
  // Pull washed-out highlights back toward accent, but gently (was 0.75 — that
  // strongly repainted every bright region in the accent hue, reinforcing the
  // monochrome look). 0.40 still kills cream blow-out without flattening colour.
  colour = mix(colour, u_accent * (cmax * 0.92 + 0.08), washed * 0.40);

  // Centroid hue tilt — gentle (the field already drifts; this is a static bias).
  colour *= u_hueShift;

  // Saturation falls in noisy/percussive passages.
  float luma = dot(colour, vec3(0.299, 0.587, 0.114));
  colour = mix(vec3(luma), colour, u_saturation);

  // Dark-ground: bg shows everywhere the field is quiet, but DIMLY — the
  // whole frame should read as a near-black scene with coloured events in it,
  // not a flat bg-coloured wash. Multiply bg down so empty zones are nearly
  // black (a tiny bg tint at most).
  float darkness = 1.0 - smoothstep(0.0, 0.18, intensity);
  colour = mix(colour, u_bg * 0.12, darkness);

  float vig = smoothstep(1.0, 0.45, length(dir));
  colour *= 0.88 + vig * 0.18;
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

/**
 * Per-channel decay clamp (plan §2.3). The base scalar is already clamped to
 * [0.78, 0.97] by evalConfig; per-channel biases are at most ±0.08 each, so
 * the sum can fall into [0.70, 1.05]. Re-clamp here to [0.70, 0.99] so the
 * shader's outer guard stays untriggered and channel imbalance can't blow up.
 */
function clampDecayChannel(v: number): number {
  return v < 0.70 ? 0.70 : v > 0.99 ? 0.99 : v;
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
  // Stable-fluids sim: grid as a fraction of the field resolution (0 = no sim
  // on the low tier) + Jacobi pressure iterations per step.
  const fluidGrid = quality === 'high' ? 0.5 : quality === 'medium' ? 0.375 : 0;
  const fluidIterations = quality === 'high' ? 20 : 12;
  // Velocity is UV/s; the dye displacement premultiplies channel * scale * dt
  // CPU-side so the shader's u_fluid is a plain magnitude.
  const FLUID_ADVECT_SCALE = 0.9;

  const fieldProg = link(gl, QUAD_VERT, FIELD_FRAG);
  const emitterProg = link(gl, EMITTER_VERT, EMITTER_FRAG);
  const terrainProg = link(gl, QUAD_VERT, TERRAIN_FRAG);
  const spectrumProg = link(gl, QUAD_VERT, SPECTRUM_FRAG);
  const waveProg = link(gl, QUAD_VERT, WAVE_FRAG);
  const thresholdProg = link(gl, QUAD_VERT, THRESHOLD_FRAG);
  const downProg = link(gl, QUAD_VERT, KAWASE_DOWN_FRAG);
  const upProg = link(gl, QUAD_VERT, KAWASE_UP_FRAG);
  const postProg = link(gl, QUAD_VERT, POST_FRAG);
  const echoProg = link(gl, QUAD_VERT, ECHO_FRAG);
  const blitProg = link(gl, QUAD_VERT, BLIT_FRAG);

  if (!fieldProg || !emitterProg || !terrainProg || !spectrumProg || !waveProg || !thresholdProg || !downProg || !upProg || !postProg || !echoProg || !blitProg) {
    return null;
  }
  // Narrow once so the inner closures don't need null guards on every use.
  const FIELD: WebGLProgram = fieldProg;
  const EMITTER: WebGLProgram = emitterProg;
  const TERRAIN: WebGLProgram = terrainProg;
  const SPECTRUM: WebGLProgram = spectrumProg;
  const WAVE: WebGLProgram = waveProg;
  const THRESHOLD: WebGLProgram = thresholdProg;
  const DOWN: WebGLProgram = downProg;
  const UP: WebGLProgram = upProg;
  const POST: WebGLProgram = postProg;
  const ECHO: WebGLProgram = echoProg;
  const BLIT: WebGLProgram = blitProg;
  const blitUni = { src: gl.getUniformLocation(blitProg, 'u_src') };

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

  // Spectrum bands texture: 24x1 R32F so the spectrum shader can look up band
  // magnitudes by angle without packing into a uniform array. R32F renderable
  // is gated by EXT_color_buffer_float (already checked above); SAMPLING R32F
  // is a separate concern — we use NEAREST filter so OES_texture_float_linear
  // isn't needed for this texture.
  const bandsTex = gl.createTexture();
  if (!bandsTex) return null;
  gl.bindTexture(gl.TEXTURE_2D, bandsTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 24, 1, 0, gl.RED, gl.FLOAT, new Float32Array(24));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Scratch buffer for per-frame band uploads (avoid per-frame allocations).
  const bandsScratch = new Float32Array(24);

  // Waveform sample texture (256x1 R8) for the reactive oscilloscope layer.
  const WAVE_SAMPLES = 256;
  const waveScratch = new Uint8Array(WAVE_SAMPLES).fill(128);
  const waveTex = gl.createTexture();
  if (!waveTex) return null;
  gl.bindTexture(gl.TEXTURE_2D, waveTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, WAVE_SAMPLES, 1, 0, gl.RED, gl.UNSIGNED_BYTE, waveScratch);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let haveWave = false;

  // Field FBOs (ping-pong) sized at render-time.
  let fieldA: Fbo | null = null;
  let fieldB: Fbo | null = null;
  // Bloom ping-pongs: one per pyramid level (only used at level count > 0).
  const bloomDown: Fbo[] = [];
  const bloomUp: Fbo[] = [];
  // Plan §2.5 video-echo. Ping-pong because echo self-feeds (each frame writes
  // into echoB after reading echoA). Allocated LAZILY on first nonzero alpha —
  // an archetype that never sets echo never pays the ~16MB cost. Force-off on
  // the `low` quality tier (per plan launch gate).
  const echoEnabled = quality !== 'low';
  let echoA: Fbo | null = null;
  let echoB: Fbo | null = null;
  // Free-side hysteresis: don't drop the echo FBOs the instant alpha dips
  // below threshold. A pulse-curve binding on snare/kick in a quiet passage
  // can oscillate across the gate, and an immediate free + realloc on every
  // crossing thrashes two ~16MB RGBA16F buffers. We require N consecutive
  // sub-threshold frames before freeing; any one frame above the threshold
  // resets the counter. The alloc path (below) stays IMMEDIATE so the first
  // echo frame is never delayed.
  const ECHO_FREE_FRAMES = 30; // ~0.5s @60fps — quieter than typical hysteresis intervals on the pulse curve
  let echoIdleFrames = 0;
  // Plan §2.6 field-buffer snapshot. Allocated on the FIRST frame of a fade,
  // freed when the fade settles. Off on `low` too — the projector running on
  // a weak GPU should not double its peak RGBA16F footprint mid-fade.
  const snapshotEnabled = quality !== 'low';
  let fieldSnapshot: Fbo | null = null;
  let snapshotActive = false; // we've captured a snapshot this transition

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

  // Stable-fluids velocity sim (tiered off entirely on 'low'; null when the
  // GPU can't do RG16F targets — both cases render exactly as before because
  // u_fluid is forced to 0). Sized as a fraction of the field; resize() below
  // keeps it in step via rebuildTargets.
  let fluid: FluidSim | null = fluidGrid > 0
    ? createFluidSim(gl, {
        width: Math.max(64, Math.round(fieldW * fluidGrid)),
        height: Math.max(64, Math.round(fieldH * fluidGrid)),
        pressureIterations: fluidIterations,
      })
    : null;

  function rebuildTargets(): void {
    disposeFbo(fieldA);
    disposeFbo(fieldB);
    fieldA = makeFbo(fieldW, fieldH);
    fieldB = makeFbo(fieldW, fieldH);
    fluid?.resize(Math.max(64, Math.round(fieldW * fluidGrid)), Math.max(64, Math.round(fieldH * fluidGrid)));
    for (const f of bloomDown) disposeFbo(f);
    for (const f of bloomUp) disposeFbo(f);
    bloomDown.length = 0;
    bloomUp.length = 0;
    // Plan §2.5/§2.6: if echo/snapshot FBOs exist, rebuild them at the new
    // field resolution. Allocation stays lazy on first use; resize never
    // creates them speculatively.
    if (echoA) { disposeFbo(echoA); echoA = makeFbo(fieldW, fieldH); }
    if (echoB) { disposeFbo(echoB); echoB = makeFbo(fieldW, fieldH); }
    if (fieldSnapshot) { disposeFbo(fieldSnapshot); fieldSnapshot = makeFbo(fieldW, fieldH); snapshotActive = false; }
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

  // ---- Cached attribute locations (avoid getAttribLocation per frame) ----
  // bindFullscreenQuad runs ~10×/frame, bindEmitterAttribs runs 3× per frame,
  // and each getAttribLocation forces a string→GLint lookup in the driver. The
  // cache resolves on first use and remembers per (program, attribute name).
  const attribCache = new Map<WebGLProgram, Map<string, number>>();
  function attribLoc(prog: WebGLProgram, name: string): number {
    let perProg = attribCache.get(prog);
    if (!perProg) { perProg = new Map(); attribCache.set(prog, perProg); }
    let loc = perProg.get(name);
    if (loc === undefined) {
      loc = gl.getAttribLocation(prog, name);
      perProg.set(name, loc);
    }
    return loc;
  }

  function bindFullscreenQuad(prog: WebGLProgram): void {
    const loc = attribLoc(prog, 'a_pos');
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
    zoom: gl.getUniformLocation(fieldProg, 'u_zoom'),
    rotate: gl.getUniformLocation(fieldProg, 'u_rotate'),
    hueCycle: gl.getUniformLocation(fieldProg, 'u_hueCycle'),
    swirl: gl.getUniformLocation(fieldProg, 'u_swirl'),
    mirror: gl.getUniformLocation(fieldProg, 'u_mirror'),
    mirrorMix: gl.getUniformLocation(fieldProg, 'u_mirrorMix'),
    velocity: gl.getUniformLocation(fieldProg, 'u_velocity'),
    fluid: gl.getUniformLocation(fieldProg, 'u_fluid'),
    zoomRadGain: gl.getUniformLocation(fieldProg, 'u_zoomRadGain'),
    rotateRadGain: gl.getUniformLocation(fieldProg, 'u_rotateRadGain'),
    swirlRadGain: gl.getUniformLocation(fieldProg, 'u_swirlRadGain'),
    decayRadGain: gl.getUniformLocation(fieldProg, 'u_decayRadGain'),
    centre: gl.getUniformLocation(fieldProg, 'u_centre'),
  };
  const echoUni = {
    field: gl.getUniformLocation(echoProg, 'u_field'),
    prevEcho: gl.getUniformLocation(echoProg, 'u_prevEcho'),
    zoom: gl.getUniformLocation(echoProg, 'u_zoom'),
    rot: gl.getUniformLocation(echoProg, 'u_rot'),
    flipX: gl.getUniformLocation(echoProg, 'u_flipX'),
    flipY: gl.getUniformLocation(echoProg, 'u_flipY'),
    feedback: gl.getUniformLocation(echoProg, 'u_feedback'),
    centre: gl.getUniformLocation(echoProg, 'u_centre'),
  };
  const spectrumUni = {
    bands: gl.getUniformLocation(spectrumProg, 'u_bands'),
    color: gl.getUniformLocation(spectrumProg, 'u_color'),
    intensity: gl.getUniformLocation(spectrumProg, 'u_intensity'),
    time: gl.getUniformLocation(spectrumProg, 'u_time'),
    aspect: gl.getUniformLocation(spectrumProg, 'u_aspect'),
  };
  const waveUni = {
    wave: gl.getUniformLocation(waveProg, 'u_wave'),
    mode: gl.getUniformLocation(waveProg, 'u_mode'),
    color: gl.getUniformLocation(waveProg, 'u_color'),
    intensity: gl.getUniformLocation(waveProg, 'u_intensity'),
    thickness: gl.getUniformLocation(waveProg, 'u_thickness'),
    scale: gl.getUniformLocation(waveProg, 'u_scale'),
    aspect: gl.getUniformLocation(waveProg, 'u_aspect'),
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
    dye: gl.getUniformLocation(postProg, 'u_dye'),
    echo: gl.getUniformLocation(postProg, 'u_echo'),
    snapshot: gl.getUniformLocation(postProg, 'u_snapshot'),
    bloomIntensity: gl.getUniformLocation(postProg, 'u_bloomIntensity'),
    aberration: gl.getUniformLocation(postProg, 'u_aberration'),
    saturation: gl.getUniformLocation(postProg, 'u_saturation'),
    liquidMix: gl.getUniformLocation(postProg, 'u_liquidMix'),
    echoAlpha: gl.getUniformLocation(postProg, 'u_echoAlpha'),
    snapshotMix: gl.getUniformLocation(postProg, 'u_snapshotMix'),
    bg: gl.getUniformLocation(postProg, 'u_bg'),
    accent: gl.getUniformLocation(postProg, 'u_accent'),
    dark: gl.getUniformLocation(postProg, 'u_dark'),
    light: gl.getUniformLocation(postProg, 'u_light'),
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

  // Active operator config (the "look") + a reusable dynamics scratch object.
  // The default config re-expresses the original hardcoded warp formulas, so
  // until setConfig() swaps it the visualizer is byte-identical to before.
  let currentConfig: OperatorConfig = defaultConfig();
  const dyn = createDynamics();

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
    const aPos = attribLoc(EMITTER, 'a_quad');
    const iPosSize = attribLoc(EMITTER, 'i_posSize');
    const iColor = attribLoc(EMITTER, 'i_color');
    const iKindData = attribLoc(EMITTER, 'i_kindData');
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
    const iPosSize = attribLoc(EMITTER, 'i_posSize');
    const iColor = attribLoc(EMITTER, 'i_color');
    const iKindData = attribLoc(EMITTER, 'i_kindData');
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

    // Use the active config's generated palette (the randomizer/Director mints a
    // real multi-hue HSV palette per look) instead of the single-hue CSS theme
    // accent. Falling back to the host palette only when the config has none
    // (the "Classic" default). This is what stops every bright pixel collapsing
    // onto the theme accent — the root of the "everything is pink" complaint.
    if (currentConfig.palette) palette = currentConfig.palette;

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
      // Central core: a SMALL accent-coloured orb that pulses with bass/energy,
      // not a screen-filling cream cloud (radius 1.4 + light colour was THE
      // persistent "cream blob" — it dominated every frame regardless of audio).
      spawn(3, 0, 0, 0.30 + frame.bass * 0.30, palette.accent[0], palette.accent[1], palette.accent[2], 0.45, 0, 0.20 + frame.energy * 0.38);
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

    // Data-driven warp params: evaluate the active OperatorConfig against this
    // audio frame. The default config reproduces the original hardcoded formulas
    // (zoom/rotate/swirl/hue/decay/warp/kaleidoscope); the randomizer + Director
    // mint and morph configs to change the look. evalConfig clamps every output
    // to a GPU-safe range so no config can crash or white-out the field.
    // Runs BEFORE the fluid step because the sim needs dyn.vorticity/dyn.fluid.
    evalConfig(currentConfig, frame, sectionSeed, dyn);

    // ---- PASS 0: stable-fluids velocity + dye step. The sim binds its own
    // FBOs/programs, so it runs before the field pass establishes its state;
    // the renderer's dt is passed as-is (the sim clamps internally). Dye
    // dissipation is silence-gated (dyeDissipationFromFrame) plus the active
    // config's bias so an archetype can let dye linger longer or drain it.
    if (fluid) {
      const baseDyeDiss = dyeDissipationFromFrame(frame) + dyn.dyeDissipation;
      const dyeDiss = baseDyeDiss < 0.6 ? 0.6 : baseDyeDiss > 1 ? 1 : baseDyeDiss;
      fluid.step(dt, fluidForcesFromFrame(frame), {
        vorticity: dyn.vorticity,
        dissipation: 0.985,
        dyeDissipation: dyeDiss,
      });
    }

    // ---- PASS 1: feedback field (advect prev → fieldB) ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, fieldB.fbo);
    gl.viewport(0, 0, fieldW, fieldH);
    gl.disable(gl.BLEND);
    gl.useProgram(FIELD);
    bindFullscreenQuad(FIELD);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldA.tex);
    gl.uniform1i(fieldUni.prev, 0);
    // Simulated fluid velocity on unit 1 (u_prev owns unit 0; no other texture
    // is bound in this pass). When the sim is off (low tier / unsupported GPU)
    // bind the prev field instead — any valid texture works because the sample
    // is multiplied by u_fluid = 0, reproducing the previous math exactly.
    const velTex = fluid ? fluid.velocityTexture() : null;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, velTex ?? fieldA.tex);
    gl.uniform1i(fieldUni.velocity, 1);
    gl.uniform1f(fieldUni.fluid, velTex ? dyn.fluid * FLUID_ADVECT_SCALE * dt : 0);
    gl.activeTexture(gl.TEXTURE0);
    // Plan §2.3: per-RGB decay. dyn.decay + dyn.decayR/G/B biases. Clamped
    // CPU-side to the GPU-safe envelope so a runaway audio gain can't push
    // past the shader's outer clamp band.
    const dr = clampDecayChannel(dyn.decay + dyn.decayR);
    const dg = clampDecayChannel(dyn.decay + dyn.decayG);
    const db = clampDecayChannel(dyn.decay + dyn.decayB);
    gl.uniform3f(fieldUni.decay, dr, dg, db);
    gl.uniform1f(fieldUni.warpAmp, dyn.warpAmp);
    gl.uniform1f(fieldUni.warpScale, dyn.warpScale);
    gl.uniform2f(fieldUni.flow, dyn.flowX, dyn.flowY);
    gl.uniform1f(fieldUni.time, time);
    gl.uniform1f(fieldUni.novelty, frame.novelty);
    gl.uniform1f(fieldUni.sectionSeed, sectionSeed);
    gl.uniform1f(fieldUni.zoom, dyn.zoom);
    gl.uniform1f(fieldUni.rotate, dyn.rotate);
    gl.uniform1f(fieldUni.hueCycle, dyn.hueCycle);
    gl.uniform1f(fieldUni.swirl, dyn.swirl);
    gl.uniform1f(fieldUni.mirror, dyn.mirror);
    gl.uniform1f(fieldUni.mirrorMix, dyn.mirrorMix);
    // Plan §2.2/§2.4: radial gains + centre offset. Defaults are 0 / (0.5,0.5)
    // → bit-identical to pre-§2.2 (the additive radial term vanishes and the
    // centre uniform matches the hardcoded vec2(0.5)).
    gl.uniform1f(fieldUni.zoomRadGain, dyn.radialZoom);
    gl.uniform1f(fieldUni.rotateRadGain, dyn.radialRotate);
    gl.uniform1f(fieldUni.swirlRadGain, dyn.radialSwirl);
    gl.uniform1f(fieldUni.decayRadGain, dyn.radialDecay);
    gl.uniform2f(fieldUni.centre, dyn.centreX, dyn.centreY);
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

    // ---- PASS 3b: radial spectrum overlay (the crisp structure MilkDrop
    // draws each frame). Upload the 24 bands → R32F texture, draw the "sun".
    // Still inside fieldB + additive blend so the feedback advect captures it
    // next frame and the rays leave swirling trails.
    {
      const bands = frame.bands;
      const n = Math.min(24, bands.length);
      for (let i = 0; i < n; i++) bandsScratch[i] = bands[i]!;
      for (let i = n; i < 24; i++) bandsScratch[i] = 0;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bandsTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 24, 1, gl.RED, gl.FLOAT, bandsScratch);
      gl.useProgram(SPECTRUM);
      bindFullscreenQuad(SPECTRUM);
      gl.uniform1i(spectrumUni.bands, 0);
      // Spectrum hue rotates the accent through the palette over time so the
      // bright "sun" itself drifts colour — feeds into the field's hue cycle.
      const hueT = (time * 0.25) % 1;
      const r = palette.accent[0] * (0.6 + 0.4 * Math.cos(hueT * 6.283));
      const g = palette.accent[1] * (0.6 + 0.4 * Math.cos((hueT + 0.33) * 6.283));
      const b = palette.accent[2] * (0.6 + 0.4 * Math.cos((hueT + 0.66) * 6.283));
      gl.uniform3f(
        spectrumUni.color,
        Math.max(0.2, r),
        Math.max(0.2, g),
        Math.max(0.2, b),
      );
      // Bright crisp rays = the structural overlay. Push them well above the
      // field so the spectrum "sun" reads as drawn geometry, not haze.
      // Dialed down from 1.1 + energy*1.3 (cap 2.8): the spectrum "sun" was the
      // dominant always-bright centred object. Lower base + cap lets the warp
      // field and the now-default oscilloscope carry the look instead of a
      // screen-centre glow that read as "one pulsing thing".
      const intensity = 0.5 + frame.energy * 0.8 + frame.beatPhase * 0.1;
      gl.uniform1f(spectrumUni.intensity, Math.min(1.8, intensity));
      gl.uniform1f(spectrumUni.time, time);
      gl.uniform1f(spectrumUni.aspect, fieldH / Math.max(1, fieldW));
      drawFullscreen();
    }

    // ---- PASS 3c: reactive waveform (the signature MilkDrop oscilloscope) ----
    // Additive, into fieldB BEFORE the swap, so the line is advected by next
    // frame's warp and leaves trails. Off unless the active config enables it.
    if (haveWave && dyn.waveMode > 0 && dyn.waveIntensity > 0.001) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(WAVE);
      bindFullscreenQuad(WAVE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.uniform1i(waveUni.wave, 0);
      gl.uniform1f(waveUni.mode, dyn.waveMode);
      gl.uniform3f(waveUni.color, palette.accent[0], palette.accent[1], palette.accent[2]);
      gl.uniform1f(waveUni.intensity, dyn.waveIntensity);
      gl.uniform1f(waveUni.thickness, dyn.waveThickness);
      gl.uniform1f(waveUni.scale, dyn.waveScale);
      gl.uniform1f(waveUni.aspect, fieldH / Math.max(1, fieldW));
      drawFullscreen();
    }
    gl.disable(gl.BLEND);

    // Swap field ping-pong.
    const tmp = fieldA;
    fieldA = fieldB;
    fieldB = tmp;

    // ---- PASS 3d: video-echo (plan §2.5). Ping-pong self-feeding pass that
    // samples the live field through a zoom/rotate/flip transform and blends
    // it with last frame's echo. Lazily allocated on first nonzero alpha;
    // never present on `low` quality. Per plan: ~16MB at 1080p.
    if (echoEnabled && dyn.echoAlpha > 0.001) {
      // Any frame above threshold resets the idle counter so a single audible
      // hit re-arms the full hysteresis window.
      echoIdleFrames = 0;
      if (!echoA || !echoB) {
        echoA = makeFbo(fieldW, fieldH);
        echoB = makeFbo(fieldW, fieldH);
      }
      if (echoA && echoB) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, echoB.fbo);
        gl.viewport(0, 0, fieldW, fieldH);
        gl.disable(gl.BLEND);
        gl.useProgram(ECHO);
        bindFullscreenQuad(ECHO);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fieldA.tex);
        gl.uniform1i(echoUni.field, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, echoA.tex);
        gl.uniform1i(echoUni.prevEcho, 1);
        gl.uniform1f(echoUni.zoom, dyn.echoZoom);
        gl.uniform1f(echoUni.rot, dyn.echoRotate);
        gl.uniform1f(echoUni.flipX, dyn.echoFlipX);
        gl.uniform1f(echoUni.flipY, dyn.echoFlipY);
        gl.uniform1f(echoUni.feedback, 0.55);
        gl.uniform2f(echoUni.centre, dyn.centreX, dyn.centreY);
        drawFullscreen();
        // Swap echo ping-pong so next frame reads the result we just wrote.
        const et = echoA;
        echoA = echoB;
        echoB = et;
        gl.activeTexture(gl.TEXTURE0); // reset before bloom pass binds u_src
      }
    } else if (echoA || echoB) {
      // Alpha is below threshold this frame. Don't free immediately — a
      // pulse-curve binding can flicker across the gate at audio rate, and
      // immediate free + realloc thrashes two ~16MB FBOs per crossing. Only
      // release after the alpha has stayed sub-threshold for ECHO_FREE_FRAMES
      // consecutive rendered frames. A one-shot echo still pays only ~0.5s of
      // residency past its last audible frame.
      echoIdleFrames++;
      if (echoIdleFrames >= ECHO_FREE_FRAMES) {
        disposeFbo(echoA); disposeFbo(echoB);
        echoA = null; echoB = null;
        echoIdleFrames = 0;
      }
    }

    // ---- PASS 3e: snapshot capture (plan §2.6). When a transition starts
    // (dyn.transition < 1 and we haven't captured yet), blit the live fieldA
    // into fieldSnapshot. The composite then crossfades against this frozen
    // FROM look so mid-fade discrete-channel snaps (mirrorSet, waveMode) don't
    // tear the picture. When transition settles back to 1 the snapshot is
    // freed. Off on `low` quality per plan launch gate.
    if (snapshotEnabled && dyn.transition < 0.999) {
      if (!fieldSnapshot) fieldSnapshot = makeFbo(fieldW, fieldH);
      if (fieldSnapshot && !snapshotActive) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fieldSnapshot.fbo);
        gl.viewport(0, 0, fieldW, fieldH);
        gl.disable(gl.BLEND);
        gl.useProgram(BLIT);
        bindFullscreenQuad(BLIT);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fieldA.tex);
        gl.uniform1i(blitUni.src, 0);
        drawFullscreen();
        snapshotActive = true;
      }
    } else if (fieldSnapshot && snapshotActive && dyn.transition >= 0.999) {
      // Transition settled. Free the snapshot FBO so it doesn't hold ~16MB
      // between fades. Sub-second re-allocation is fine — fades are rare.
      disposeFbo(fieldSnapshot);
      fieldSnapshot = null;
      snapshotActive = false;
    }

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
    // Dye field on unit 2 — when the sim is unavailable (low tier / GPU
    // doesn't support RGBA16F render targets) bind fieldA as a placeholder
    // and force liquidMix to 0 below so the shader's `if (u_liquidMix > 0)`
    // branch skips the sample entirely.
    const dyeTex = fluid ? fluid.dyeTexture() : null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, dyeTex ?? fieldA.tex);
    gl.uniform1i(postUni.dye, 2);
    // Plan §2.5 echo source — when alpha=0 the shader skips the texture
    // entirely, so binding fieldA as a placeholder is safe (any valid
    // texture is fine; the sample is gated by `u_echoAlpha > 0`).
    const echoSrcTex = echoA ? echoA.tex : fieldA.tex;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, echoSrcTex);
    gl.uniform1i(postUni.echo, 3);
    // Plan §2.6 snapshot source — same trick: fall back to the live field
    // when there's no snapshot, and gate the sample shader-side with
    // `u_snapshotMix > 0`. snapshotMix = 1 - transition, so a freshly
    // started fade (transition≈0) gives mix≈1 (full from-snapshot), then
    // marches to 0 as transition→1.
    const snapTex = fieldSnapshot ? fieldSnapshot.tex : fieldA.tex;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, snapTex);
    gl.uniform1i(postUni.snapshot, 4);
    // Pull bloom intensity DOWN (the post shader already halves it again);
    // bloom now glows around bright parts instead of dominating the whole frame.
    gl.uniform1f(postUni.bloomIntensity, bloomSrc ? 0.30 + bloomEnv * 0.45 : 0);
    gl.uniform1f(postUni.aberration, aberrationOn ? aberrEnv * 0.9 : 0);
    gl.uniform1f(postUni.saturation, Math.max(0.35, 1 - frame.flatness * 0.55));
    gl.uniform1f(postUni.liquidMix, dyeTex ? dyn.liquidMix : 0);
    gl.uniform1f(postUni.echoAlpha, echoA ? dyn.echoAlpha : 0);
    gl.uniform1f(postUni.snapshotMix, snapshotActive && fieldSnapshot ? Math.max(0, 1 - dyn.transition) : 0);
    gl.uniform3f(postUni.bg, palette.bg[0], palette.bg[1], palette.bg[2]);
    gl.uniform3f(postUni.accent, palette.accent[0], palette.accent[1], palette.accent[2]);
    gl.uniform3f(postUni.dark, palette.dark[0], palette.dark[1], palette.dark[2]);
    gl.uniform3f(postUni.light, palette.light[0], palette.light[1], palette.light[2]);
    // Gentle centroid tilt — most of the colour now comes from the palette
    // ramp + field tint, so this stays a quiet bias (≈±10%).
    const c = frame.centroid;
    gl.uniform3f(
      postUni.hueShift,
      0.95 + (1 - c) * 0.12,
      0.96 + c * 0.04,
      0.95 + c * 0.12,
    );
    drawFullscreen();
  }

  function dispose(): void {
    if (fieldProg) gl.deleteProgram(fieldProg);
    if (emitterProg) gl.deleteProgram(emitterProg);
    if (terrainProg) gl.deleteProgram(terrainProg);
    if (spectrumProg) gl.deleteProgram(spectrumProg);
    if (thresholdProg) gl.deleteProgram(thresholdProg);
    if (downProg) gl.deleteProgram(downProg);
    if (upProg) gl.deleteProgram(upProg);
    if (postProg) gl.deleteProgram(postProg);
    if (waveProg) gl.deleteProgram(waveProg);
    if (echoProg) gl.deleteProgram(echoProg);
    if (blitProg) gl.deleteProgram(blitProg);
    if (quadBuf) gl.deleteBuffer(quadBuf);
    if (instanceBuf) gl.deleteBuffer(instanceBuf);
    if (bandsTex) gl.deleteTexture(bandsTex);
    if (waveTex) gl.deleteTexture(waveTex);
    disposeFbo(fieldA);
    disposeFbo(fieldB);
    disposeFbo(echoA);
    disposeFbo(echoB);
    disposeFbo(fieldSnapshot);
    for (const f of bloomDown) disposeFbo(f);
    for (const f of bloomUp) disposeFbo(f);
    fieldA = null;
    fieldB = null;
    echoA = null;
    echoB = null;
    fieldSnapshot = null;
    snapshotActive = false;
    bloomDown.length = 0;
    bloomUp.length = 0;
    fluid?.dispose();
    fluid = null;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  function setConfig(config: OperatorConfig): void {
    currentConfig = config;
  }
  function getConfig(): OperatorConfig {
    return currentConfig;
  }
  function setWaveform(samples: Uint8Array): void {
    const n = Math.min(WAVE_SAMPLES, samples.length);
    for (let i = 0; i < n; i++) waveScratch[i] = samples[i]!;
    for (let i = n; i < WAVE_SAMPLES; i++) waveScratch[i] = 128;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, waveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_SAMPLES, 1, gl.RED, gl.UNSIGNED_BYTE, waveScratch);
    haveWave = true;
  }

  return { resize, render, dispose, setConfig, getConfig, setWaveform };
}
