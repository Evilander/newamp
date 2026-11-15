// Marbling — ink floated on a bath of size, the way marbled endpapers are made.
// The bath starts as stripes of the palette's five inks with a comb drawn
// through them, which pulls the stripes into the chevrons of a gel-git
// pattern. Then every kick lets a drop of ink fall. A drop does not cover what
// is on the water: it pushes it aside, so a drop that lands inside an earlier
// one opens that one out into a ring, and a run of kicks on one spot leaves
// nested rings in the order they were played. The picture on screen is the
// last twenty kicks of the song, over the combed ground they pushed apart.
//
// Nothing is simulated or stored. A drop of radius r at c moves every point of
// the bath from distance d to sqrt(d*d + r*r), which has an exact inverse, and
// a comb shifts points along its tines by an amount that depends only on the
// distance across them, which also has one. The shader walks a pixel back
// through the drops, newest first, until it lands inside one; that drop's ink
// is the pixel's colour, and a pixel that lands in none is walked back through
// the combs to its stripe. Drop n is kick number floor(u_kickCount) - n and
// everything about it is hashed from that number, so it stays put when the
// count moves on. Only the newest drop is still spreading (u_kickAge), and the
// oldest closes up over the same time, which keeps the picture continuous when
// a kick arrives.
//
// Close to a fresh drop the older ink is squeezed into rings finer than a
// pixel. Every edge is softened by how fast its own coordinate is changing on
// screen there, so those rings blend to their mean instead of shimmering.

import type { SceneDef } from './index';

export const marbling: SceneDef = {
  id: 'marbling',
  name: 'Marbling',
  mood: 'mid',
  occlusion: 0.75,
  speed: f => 0.12 + f.energy * 0.5,
  frag: `
const int MB_DROPS = 20;
// A drop spreads, and the oldest closes, in this many seconds: under the gap
// between two counted kicks, so both have finished when the next one lands.
const float MB_EASE = 0.28;

// Five inks, taken in turn so that rings laid inside each other differ.
vec3 mbInk(float n) {
  float i = mod(n, 5.0);
  if (i < 0.5) return paletteRamp(0.5);
  if (i < 1.5) return paletteRamp(0.16);
  if (i < 2.5) return paletteRamp2(0.5);
  if (i < 3.5) return mix(u_light, vec3(1.0), 0.2) * 0.94;
  return paletteRamp2(0.28);
}

// The number a drop's place and size are hashed from. The hashes lose their
// spread on large inputs, so the kick number is folded into a range that
// divides by the run of four and the turn of five inks: each drop still has
// one number of its own for as long as it is on the bath.
float mbKey(float n) { return mod(n, 20480.0); }

// Where kick n lets its drop fall. Four kicks in a row share a spot, give or
// take a wobble of the hand, and then the hand moves on.
vec2 mbSite(float n, vec2 ext) {
  float key = mbKey(n);
  float run = floor(key / 4.0);
  vec2 site = (hash22(vec2(run * 1.7 + 3.0, u_seed * 91.0 + 5.0)) - 0.5) * ext * vec2(1.5, 1.3);
  return site + (hash22(vec2(key * 3.1 + 7.0, u_seed * 37.0 + 1.0)) - 0.5) * 0.2;
}

// How far a comb moves the bath at a signed distance across its tines. The
// tines sit one spacing apart and every other one is drawn the opposite way.
float mbComb(float across, float spacing, float reach) {
  float cell = across / spacing;
  float toward = abs(fract(cell + 0.5) - 0.5) * spacing;
  float away = abs(fract(cell) - 0.5) * spacing;
  return exp(-toward / reach) - exp(-away / reach);
}

vec4 scene(vec2 uv, vec2 p) {
  float px = 2.0 / min(u_res.x, u_res.y);
  vec2 ext = u_res / min(u_res.x, u_res.y);

  // The whole bath sways a little, as a tray of liquid does: two shears, each
  // along one axis by an amount that depends on the other, undone in turn.
  vec2 q = p;
  q.y -= 0.035 * sin(q.x * 1.9 + u_phase * 0.25 + u_seed * 6.2831853);
  q.x -= 0.045 * sin(q.y * 1.6 + u_phase * 0.1875 + u_seed * 2.4);
  vec2 bath = q;

  float newest = floor(u_kickCount + 0.5);
  float spread = smoothstep(0.0, MB_EASE, u_kickAge);
  vec3 col = vec3(0.0);
  float covered = 0.0;
  float lip = 0.0;
  vec2 fresh = vec2(0.0);
  for (int k = 0; k < MB_DROPS; k++) {
    float n = newest - float(k);
    vec2 c = mbSite(n, ext);
    float r = 0.17 + 0.17 * hash11(mbKey(n) * 5.3 + u_seed * 13.0 + 2.0);
    if (k == 0) { r *= sqrt(spread); fresh = c; }
    if (k == MB_DROPS - 1) r *= sqrt(1.0 - spread);
    vec2 v = q - c;
    float d = length(v);
    float soft = max(fwidth(d), px * 0.5) * 0.8;
    float there = step(0.0005, r);
    float inside = (1.0 - smoothstep(r - soft, r + soft, d)) * there;
    float take = (1.0 - covered) * inside;
    // The newest drop is still wet and catches the light for a moment.
    float wet = k == 0 ? 1.0 + 0.5 * exp(-u_kickAge * 5.0) : 1.0;
    col += take * mbInk(n) * wet;
    // Pigment gathers at the lip of a drop: a hairline a shade darker, gone
    // where the rings are too fine to carry one.
    float off = (d - r) / (soft * 1.6 + 0.0025);
    lip += (1.0 - covered) * exp(-off * off) * there * (1.0 - smoothstep(px * 1.5, px * 5.0, soft));
    covered += take;
    // Walk back through this drop to where the point was before it fell.
    q = c + v * sqrt(max(1.0 - r * r / max(d * d, 1e-6), 0.0));
  }

  // The ground: undo the combs, the finer one first as it was drawn last, and
  // read the stripe. A snare tugs the wide comb. It is worked out for every
  // pixel, covered or not: the stripe's softening reads how fast its
  // coordinate changes from one pixel to the next, and that is only defined
  // where neighbouring pixels all take the same path.
  float angle = (u_seed - 0.5) * 1.4;
  vec2 along = vec2(cos(angle), sin(angle));
  vec2 across = vec2(-along.y, along.x);
  float pullFine = 0.045 * (0.8 + 0.2 * sin(u_phase * 0.375 + 1.3));
  float pullWide = 0.22 * (0.8 + 0.2 * sin(u_phase * 0.5 + u_seed * 4.0)) + 0.02 * u_snarePulse;
  q -= across * pullFine * mbComb(dot(q, along) + u_seed * 3.0, 0.21, 0.06);
  q -= along * pullWide * mbComb(dot(q, across) + u_seed * 5.0, 0.52, 0.17);
  float s = dot(q, along) / 0.115;
  float w = fwidth(s);
  vec3 ground = mix(mbInk(floor(s)), mbInk(floor(s) + 1.0), smoothstep(1.0 - w, 1.0, fract(s)));
  // Stripes finer than a pixel are the five inks stirred together.
  vec3 stirred = (mbInk(0.0) + mbInk(1.0) + mbInk(2.0) + mbInk(3.0) + mbInk(4.0)) * 0.2;
  ground = mix(ground, stirred, smoothstep(0.6, 1.6, w));
  col += (1.0 - covered) * ground * 0.72;
  col *= 1.0 - 0.28 * min(lip, 1.0);
  // The tooth of the paper the print is lifted on.
  col *= 0.96 + 0.08 * vnoise(uv * u_res * 0.4);

  // The ripple a drop sends out across the bath as it lands, and the room's
  // light lying on the water.
  float ripple = (length(bath - fresh) - u_kickAge * 1.5) * 9.0;
  float ring = exp(-ripple * ripple) * exp(-u_kickAge * 4.5);
  vec2 lamp = (p - vec2(-0.45 * ext.x, 0.5)) / vec2(1.3, 0.8);
  float sheen = exp(-dot(lamp, lamp) * 1.4);

  float gain = min(0.05 + 1.15 * pow(u_energy, 0.6), 1.0);
  col = col * gain + mix(u_light, vec3(1.0), 0.35) * (ring * 0.2 + sheen * 0.07 * u_energy);
  return vec4(col, 0.84 * (0.3 + 0.7 * gain));
}
`,
};
