// Rose Window — the round window over a cathedral door, seen from inside with
// daylight behind it. Twelve lancets radiate from a foiled hub, a roundel sits
// between each pair of their arched heads, and a ring of twenty-four small
// lights runs round the rim: one for each mel band, low bands at the top and
// running clockwise. The lancet under two of those lights is lit by the same
// two bands, the roundels by the kick and the bands either side of them, and
// the hub by the voice. The glass is the palette's two accents, leaded into
// pieces, with a pale light here and there as glaziers leave them.
//
// The music is the daylight. A band that is sounding lets the sun through its
// glass; a kick is a cloud passing off the sun, a ring of brightness that runs
// from the hub to the rim; and a patch of stronger light drifts slowly across
// the back of the window. Nothing moves except the light.
//
// Every opening is a distance: how far a point lies inside the lead that holds
// its glass. The lead and the stone tracery are wherever no opening claims the
// point, and the glass nearest a lead carries the painted border line that
// real windows have.

import type { SceneDef } from './index';

export const roseWindow: SceneDef = {
  id: 'rose-window',
  name: 'Rose Window',
  mood: 'calm',
  occlusion: 0.8,
  speed: f => 0.25 + f.energy * 0.6,
  frag: `
const float RW_TAU = 6.28318530718;
const float RW_LEAD = 0.011;    // half the width of a lead
const float RW_HUB = 0.2;       // the hub's stone ring
const float RW_ARCH = 0.52;     // where a lancet's sides give way to its arched head
const float RW_HEAD = 0.1236;   // the head's radius: RW_ARCH * sin(15 deg) - RW_LEAD
const float RW_ROUNDEL = 0.7;   // the ring the roundels sit on
const float RW_RIM = 0.865;     // the ring of twenty-four lights

vec4 scene(vec2 uv, vec2 p) {
  float px = 2.0 / min(u_res.x, u_res.y);
  float r = length(p);
  vec3 hot = mix(u_light, vec3(1.0), 0.35);
  float gain = 0.06 + 0.94 * pow(u_energy, 0.65);

  // Outside the stone there is only the light the window throws on the wall.
  if (r > 0.97) {
    vec3 spill = paletteRamp(0.45) * exp(-(r - 0.97) * 7.0) * 0.22 * gain * (1.0 + u_kickPulse);
    float sm = max(spill.r, max(spill.g, spill.b));
    return vec4(spill / max(sm, 0.001), min(sm, 0.5));
  }

  // Angle as turns, clockwise from straight up, so the bands read like a clock.
  float turn = fract(atan(p.x, p.y) / RW_TAU + 1.0);
  float within = -1.0;   // distance inside the lead of the opening that holds the point
  float level = 0.0;     // how much light its bands let through
  float piece = 0.0;     // which piece of glass, for its tone
  float scheme = 0.0;    // 0 lancet, 1 roundel, 2 rim light, 3 hub

  // The twelve lancets, each centred on a multiple of thirty degrees.
  float k = floor(turn * 12.0 + 0.5);
  float sa = (turn * 12.0 - k) * (RW_TAU / 12.0);
  vec2 q = r * vec2(cos(sa), sin(sa));
  float d = min(r * sin(RW_TAU / 24.0 - abs(sa)) - RW_LEAD, r - RW_HUB - RW_LEAD);
  if (q.x > RW_ARCH) d = min(d, RW_HEAD - length(q - vec2(RW_ARCH, 0.0)));
  if (d > 0.0) {
    // A spine and two cross leads cut a lancet into six pieces.
    float span = (r - RW_HUB) / (RW_ARCH + RW_HEAD - RW_HUB);
    float bar = min(abs(span - 0.36), abs(span - 0.7)) * (RW_ARCH + RW_HEAD - RW_HUB);
    d = min(d, min(abs(q.y), bar) - RW_LEAD * 0.45);
    float seg = span < 0.36 ? 0.0 : (span < 0.7 ? 1.0 : 2.0);
    within = d;
    int lo = int(mod(k, 12.0)) * 2;
    // The mel bands fall away toward the top of the range; the lights are
    // levelled so the high ones are let through as readily as the low.
    level = 0.5 * (u_bands[lo] + u_bands[lo + 1]) * (1.0 + 0.9 * float(lo) / 23.0);
    piece = k * 6.0 + seg * 2.0 + step(0.0, q.y);
    scheme = 0.0;
  }

  // The roundels, on the lines between the lancets.
  float kb = floor(turn * 12.0);
  float sb = (turn * 12.0 - kb - 0.5) * (RW_TAU / 12.0);
  vec2 qb = r * vec2(cos(sb), sin(sb)) - vec2(RW_ROUNDEL, 0.0);
  float db = 0.093 - length(qb);
  if (db > 0.0) {
    // Leaded in four round a small boss.
    float cross = min(abs(qb.x), abs(qb.y)) - RW_LEAD * 0.4;
    float boss = abs(length(qb) - 0.03) - RW_LEAD * 0.4;
    within = min(db, min(cross, boss));
    int near = int(mod(kb, 12.0)) * 2;
    level = 0.35 * (u_bands[near + 1] + u_bands[(near + 2) % 24]) + 0.55 * u_kickPulse + 0.2 * u_bass;
    piece = 100.0 + kb * 5.0 + (length(qb) < 0.03 ? 4.0 : step(0.0, qb.x) + 2.0 * step(0.0, qb.y));
    scheme = 1.0;
  }

  // The rim: twenty-four small lights, one a band.
  float kc = floor(turn * 24.0 + 0.5);
  float sc = (turn * 24.0 - kc) * (RW_TAU / 24.0);
  vec2 qc = r * vec2(cos(sc), sin(sc)) - vec2(RW_RIM, 0.0);
  float dc = 0.05 - length(qc);
  if (dc > 0.0) {
    within = dc;
    level = u_bands[int(mod(kc, 24.0))] * (1.0 + 0.9 * mod(kc, 24.0) / 23.0);
    piece = 200.0 + kc;
    scheme = 2.0;
  }

  // The hub: an eight-foiled light with a boss at its centre.
  if (r < RW_HUB - RW_LEAD) {
    float foil = 0.118 + 0.04 * cos(turn * RW_TAU * 8.0) - r;
    float eye = abs(r - 0.04) - RW_LEAD * 0.4;
    float dh = min(min(foil, RW_HUB - RW_LEAD - r), eye);
    if (foil > 0.0) {
      within = dh;
      level = 0.25 + 0.6 * u_vocal + 0.3 * u_energy;
      piece = 300.0 + (r < 0.04 ? 1.0 : 0.0);
      scheme = 3.0;
    }
  }

  // The sun behind the glass: a patch of stronger light that wanders, and the
  // ring a kick sends from the hub to the rim.
  vec2 sun = 0.42 * vec2(cos(u_phase * 0.25 + u_seed * 6.2831853), sin(u_phase * 0.1875));
  float sweep = (r - (1.0 - u_kickPulse) * 1.05) * 4.5;
  float daylight = 0.72 + 0.5 * exp(-dot(p - sun, p - sun) * 2.2) + 0.7 * u_kickPulse * exp(-sweep * sweep);

  // The stone and the lead: all but black, with a little of the window's light
  // on the dressed face of the stone.
  vec3 col = paletteRamp(0.1) * (0.14 + 0.22 * u_energy) * (0.75 + 0.5 * vnoise(p * 9.0 + u_seed * 40.0));

  if (within > -0.02) {
    float tone = hash11(piece * 1.73 + u_seed * 61.0);
    float flip = mod(floor(piece), 2.0);
    vec3 ink;
    if (scheme < 0.5) {
      // Lancets: the two accents turn about from piece to piece, and now and
      // then a piece is left pale.
      ink = flip < 0.5 ? paletteRamp(0.44 + 0.14 * tone) : paletteRamp2(0.44 + 0.16 * tone);
      if (tone > 0.84) ink = paletteRamp(0.8);
    } else if (scheme < 1.5) {
      ink = mod(piece, 5.0) > 3.5 ? paletteRamp(0.52) : mix(paletteRamp(0.76), paletteRamp2(0.7), tone);
    } else if (scheme < 2.5) {
      ink = flip < 0.5 ? paletteRamp(0.5 + 0.08 * tone) : paletteRamp2(0.5 + 0.08 * tone);
    } else {
      ink = mod(piece, 2.0) > 0.5 ? paletteRamp2(0.52) : paletteRamp(0.78);
    }
    // Hand-made glass is never even: mottled, and streaked the way it was spun.
    float seedy = 0.62 + 0.5 * vnoise(p * 26.0 + piece * 7.3) + 0.12 * (vnoise(vec2(dot(p, vec2(0.8, 0.6)) * 60.0, piece)) - 0.5);
    float through = (0.15 + 1.25 * pow(clamp(level, 0.0, 1.0), 0.8)) * daylight * seedy;
    vec3 glass = ink * through;
    // The painted line a glazier runs just inside the lead.
    float painted = (within - 0.017) / 0.0045;
    glass += ink * 0.3 * through * exp(-painted * painted);
    // Light caught on the edge of the lead beside a bright piece.
    col += ink * through * 0.3 * exp(-max(-within, 0.0) / 0.006) * (1.0 - smoothstep(0.0, px * 1.5, within));
    col = mix(col, glass, smoothstep(0.0, px * 1.5, within));
  }

  return vec4(col * gain, 0.9 * (0.3 + 0.7 * gain) * (1.0 - smoothstep(0.955, 0.97, r)));
}
`,
};
