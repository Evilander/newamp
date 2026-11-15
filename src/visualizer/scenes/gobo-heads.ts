// Gobo Heads: four moving-head fixtures hung above the top edge, each throwing
// a haze-lit cone down to a flat, hard-edged disc of light on the back wall
// with a gobo pattern cut out of it (a spoke wheel, a halftone clover, a louvre
// grating, broken rings, spiral petals, a double star). Nothing is shaded like
// a sphere: a gobo is a stencil, so the disc is one flat level of light, a
// little soft at the rim from focus, and discs add where they cross. The beams
// wander on their own Lissajous paths and lean into the beat; the pattern
// wheels spin. A head reads one slice of the spectrum for its brightness and
// iris, a kick lifts all four toward the palette's highlight.
// The heads work as two pairs on a staggered schedule: a pair re-rolls its
// patterns on every fourth counted kick, the other pair two kicks later. Each
// pair draws from its own half of the six gobos and never repeats inside the
// pair, so the four heads always wear four different patterns. A hat hit
// splits a ghost copy off the pattern, the way a prism wheel does. Two heads
// burn in the first accent and two in the second. In silence the rig idles:
// one dim disc and its beam, the others parked dark.

import type { SceneDef } from './index';

export const goboHeads: SceneDef = {
  id: 'gobo-heads',
  name: 'Gobo Heads',
  mood: 'high',
  speed: f => 0.6 + f.energy * 0.9,
  occlusion: 0.1,
  frag: `
const float GH_TAU = 6.28318530718;

// How many pixels the edge of a pattern is smeared over; each head sets it
// from its own focus before it draws.
float ghBlur = 1.0;

// Coverage of a signed field, ramped over ghBlur pixels by its own
// screen-space slope, so an edge stays the same softness at any beam size.
float ghEdge(float f) {
  return clamp(f / max(fwidth(f) * ghBlur, 1e-5) + 0.5, 0.0, 1.0);
}

// The six gobos, in beam coordinates (the beam's edge is at length 1). Every
// angle is used as an integer multiple, so none has a seam at +/-pi. The id
// and the hat test in ghHead must stay functions of uniforms only: the fwidth
// inside each branch is undefined across a quad whose pixels take different
// branches, and the pattern edges would sparkle.
float ghGobo(int id, vec2 g) {
  float r = length(g);
  float a = atan(g.y, g.x);
  if (id == 0) {
    // Spoke wheel: eight tapering spokes, a hub dot, an outer ring.
    float spokes = ghEdge(min(cos(a * 8.0) - 0.2, r - 0.17));
    float hub = ghEdge(0.07 - r);
    float rim = ghEdge(0.05 - abs(r - 0.88));
    return max(max(spokes, hub), rim);
  } else if (id == 1) {
    // Halftone clover: a grid of dots whose size follows four leaves.
    float leaf = pow(abs(cos(a * 2.0)), 0.8) * (1.0 - 0.45 * r);
    float rad = 0.07 + 0.36 * leaf;
    return ghEdge(rad - length(fract(g * 4.0) - 0.5));
  } else if (id == 2) {
    // Louvres: a breakup stencil of straight bars. Each bar has its own width,
    // stops short of the aperture edge by its own amount and is cut into slats
    // at its own offset, so the pattern is ragged rather than a striped badge.
    float bx = g.x * 2.6;
    float bi = floor(bx);
    float hb = hash11(bi * 3.7 + 1.3);
    float hc = hash11(bi * 5.1 + 7.9);
    float bar = ghEdge(mix(0.07, 0.3, hb) - abs(fract(bx) - 0.5));
    float stop = ghEdge(mix(0.35, 1.1, hc) - abs(g.y));
    float slat = ghEdge(0.36 - abs(fract(g.y * 2.4 + hc * 3.0) - 0.5));
    return bar * stop * mix(1.0, slat, step(0.55, hb));
  } else if (id == 3) {
    // Broken rings: three rings whose gaps sit at different angles, and the
    // gaps of neighbouring rings drift in opposite directions.
    float rr = r * 3.0;
    float ri = floor(rr + 0.5);
    float ring = ghEdge(0.2 - abs(rr - ri) * 0.62);
    float par = mod(ri, 2.0);
    float gapA = sin(a * 6.0 + ri * 1.9 + u_phase * 0.5);
    float gapB = sin(a * 6.0 + ri * 1.9 - u_phase * 0.5);
    float gap = ghEdge(mix(gapA, gapB, par) + 0.15);
    return ring * mix(1.0, gap, step(0.5, ri)) * ghEdge(r - 0.12);
  } else if (id == 4) {
    // Spiral petals: five arms that wind outward.
    return ghEdge(min(cos(a * 5.0 + r * 7.0) - 0.05, r - 0.1));
  }
  // Double star: the outline of an eight-point star with a half-size copy
  // inside it.
  float rad = mix(0.3, 0.95, pow(abs(cos(a * 4.0)), 3.0));
  float outer = ghEdge(0.06 - abs(rad - r));
  float inner = ghEdge(0.05 - abs(rad * 0.5 - r));
  return max(outer, inner);
}

// The haze cone from a fixture at f down to the disc at c, which has radius R.
// It is narrow and bright at the lens and opens as a cone whose sides run
// tangent to the rim of the disc, so it lands on the wall instead of stopping
// short or spilling past it. It ends where those tangents touch the rim and the
// disc takes over, with drifting fog and the odd mote of dust caught inside.
float ghBeam(int j, vec2 p, vec2 f, vec2 c, float R) {
  vec2 ax = c - f;
  float len = max(length(ax), 1e-3);
  vec2 u = ax / len;
  vec2 nrm = vec2(-u.y, u.x);
  vec2 q = p - f;
  float t = dot(q, u) / len;
  float side = dot(q, nrm);
  float rl = min(R / len, 0.9);
  float tEnd = 1.0 - rl * rl;
  float hw = mix(0.04, R / sqrt(max(1.0 - rl * rl, 0.05)), clamp(t, 0.0, 1.0));
  float k = abs(side) / hw;
  if (k > 1.3 || t < -0.02 || t > tEnd) return 0.0;
  float cone = exp(-k * k * 2.2) * (1.0 - smoothstep(0.9, 1.3, k)) * smoothstep(-0.02, 0.03, t);
  // Brightest at the lens, fading as the cone spreads.
  float along = mix(1.0, 0.35, smoothstep(0.0, 1.0, t));
  float fj = float(j);
  vec2 fog = vec2(t * len * 3.2 - u_phase * 0.6, side / hw * 1.6 + fj * 5.0);
  float haze = 0.55 + 0.9 * (0.65 * vnoise(fog) + 0.35 * vnoise(fog * 2.3 + 9.0));
  // Dust: sparse bright specks drifting out of the lens along the cone.
  vec2 mc = vec2(t * len * 14.0 - u_phase * 1.6, side * 16.0 + fj * 13.0);
  vec2 id = floor(mc);
  vec2 off = (hash22(id) - 0.5) * 0.5;
  float mote = step(0.94, hash21(id)) * (1.0 - smoothstep(0.0, 0.2, length(fract(mc) - 0.5 - off)));
  return cone * along * (haze + 3.0 * mote * along);
}

// One head. c is the disc centre, f the fixture, (cs, sn) the cosine and sine
// of the pattern wheel's spin, lvl the head's spectrum slice, idle 1 when the
// rig is at rest. The disc is flat light: a faint aperture wash with the
// pattern cut out at full level, a rim softened by the head's own focus.
vec3 ghHead(int j, vec2 p, vec2 c, vec2 f, float cs, float sn, float lvl, float idle) {
  float fj = float(j);
  float R = 0.24 + lvl * 0.14 + u_bass * 0.06;
  // Each head sits at its own focus, drifting between nearly sharp and a few
  // pixels of blur, and a kick knocks it a touch out.
  ghBlur = 1.4 + 1.8 * (0.5 + 0.5 * sin(u_phase * 0.3 + fj * 2.1)) + 1.5 * u_kickPulse;
  vec2 g = (p - c) / R;
  float d = length(g);
  g = mat2(cs, -sn, sn, cs) * g;
  // The heads work as pairs (0, 1) and (2, 3). A pair re-rolls on every fourth
  // counted kick, the second pair two kicks later. Pair 0 draws from gobos
  // 0..2 and pair 1 from 3..5, and the second head of a pair steps one or two
  // places on from the first inside its half, so the four never repeat.
  float pr = floor(fj * 0.5);
  float n = floor((u_kickCount + 2.0 * pr) * 0.25);
  float h1 = hash11(n * 7.3 + pr * 3.1);
  float h2 = hash11(n * 5.9 + pr * 1.7 + 11.0);
  float first = min(floor(h1 * 3.0), 2.0);
  float second = mod(first + 1.0 + min(floor(h2 * 2.0), 1.0), 3.0);
  int gi = int(mod(fj, 2.0) < 0.5 ? first : second) + 3 * int(pr);
  float pat = ghGobo(gi, g);
  if (u_hatPulse > 0.02) {
    float ghost = ghGobo(gi, mat2(0.9394, -0.3429, 0.3429, 0.9394) * g * 1.12 + vec2(0.12, 0.0));
    pat = max(pat, u_hatPulse * 0.8 * ghost);
  }
  float disc = ghEdge(1.0 - d);
  // Two heads take each accent. The stops sit off the dark/accent midpoint,
  // where the ramp is least saturated.
  float stop = 0.5 + 0.05 * fj;
  vec3 tint = mod(fj, 2.0) < 0.5 ? paletteRamp(stop) : paletteRamp2(stop);
  // Raise the dark stops of a dark palette toward the others, but never dim a
  // bright one: a head has to be able to burn.
  tint *= max(1.0, 0.6 / max(max(tint.r, max(tint.g, tint.b)), 0.25));
  // Highlights lean toward the palette's light role rather than toward white,
  // and more so on a kick.
  vec3 hl = mix(u_light, vec3(1.0), 0.35);
  vec3 lit = mix(tint, hl, 0.18 + 0.4 * u_kickPulse);
  // Head 0 keeps a dim disc up in silence; the rest park dark.
  float lvlOn = 0.14 + lvl * 1.15 + u_kickPulse * 0.3;
  float level = lvlOn * (j == 0 ? mix(1.0, 1.6, idle) : 1.0 - 0.9 * idle);
  // A lit disc always has a visible cone behind it: the beam keeps a floor
  // however quiet the head's slice is, and the aperture wash is never dimmer
  // than the tail of that cone, so the two meet without a dark ring.
  float beamK = mix(0.35, 0.6, clamp(lvl * 2.0, 0.0, 1.0));
  vec3 wall = mix(tint * max(0.13, beamK * 0.4), lit, pat) * disc;
  vec3 beam = tint * beamK * ghBeam(j, p, f, c, R) * (1.0 - disc);
  return (wall + beam) * level;
}

// Emit light: straight colour is col / alpha, so the premultiplied result the
// runtime writes is col itself and a dim beam is not squared into nothing.
vec4 ghEmit(vec3 col, float cap) {
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, cap);
  return vec4(col / max(a, 0.001), a);
}

float ghSlice(int j) {
  float s = 0.0;
  for (int i = 0; i < 6; i++) s += u_bands[j * 6 + i];
  return s / 6.0;
}

// Where head j's disc lands: a Lissajous wander across the wall that widens
// with the loudness, plus a swing in time with the beat.
vec2 ghAim(float j, float fx, float fy, float ph, float ph2, float ar) {
  float sweep = 0.55 + 0.35 * u_energy;
  vec2 c = vec2(sin(u_phase * fx + ph) * 0.8 * ar * sweep, cos(u_phase * fy + ph2) * 0.5);
  c.x += u_pan * 0.4 + 0.07 * sin(GH_TAU * u_beatPhase + j * 1.3) * u_beatConf;
  c.y -= 0.03 * u_kickPulse;
  return c;
}

vec4 scene(vec2 uv, vec2 p) {
  float ar = u_res.x / min(u_res.x, u_res.y);
  float idle = 1.0 - smoothstep(0.0, 0.08, u_energy);
  // The fixtures hang just above the top edge. The x and y rates of the four
  // heads share no near ratio, and the phase offsets start them in four
  // different quadrants, so the layout keeps changing and a crossing is an
  // event rather than a permanent pile-up.
  float fy = 1.07;
  vec3 col = ghHead(0, p, ghAim(0.0, 0.25, 0.375, -1.0, 0.6, ar), vec2(-0.8 * ar, fy),
                    cos(u_phase * 0.25), sin(u_phase * 0.25), ghSlice(0), idle);
  col += ghHead(1, p, ghAim(1.0, 0.4375, 0.25, 1.0, 0.9, ar), vec2(-0.27 * ar, fy),
                cos(u_phase * -0.375), sin(u_phase * -0.375), ghSlice(1), idle);
  col += ghHead(2, p, ghAim(2.0, 0.5625, 0.4375, -2.2, 2.6, ar), vec2(0.27 * ar, fy),
                cos(u_phase * 0.5), sin(u_phase * 0.5), ghSlice(2), idle);
  col += ghHead(3, p, ghAim(3.0, 0.3125, 0.625, 2.2, 3.6, ar), vec2(0.8 * ar, fy),
                cos(u_phase * -0.625), sin(u_phase * -0.625), ghSlice(3), idle);
  return ghEmit(col, 0.8);
}
`,
};
