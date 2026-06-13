// Two line lattices at slightly different angles/frequencies create a
// living moiré veil — angle delta breathes with centroid, frequency with mids,
// beat-locked subtle rotation. Low alpha; reads as a sheer interference cloth.

import type { SceneDef } from './index';

export const moireWeave: SceneDef = {
  id: 'moire-weave',
  name: 'Moiré Weave',
  mood: 'calm',
  frag: `
const float TAU_MW = 6.28318530718;

float lattice(vec2 q, float freq, float thickness) {
  vec2 g = fract(q * freq) - 0.5;
  float lx = smoothstep(thickness, 0.0, abs(g.x));
  float ly = smoothstep(thickness, 0.0, abs(g.y));
  return max(lx, ly);
}

vec4 scene(vec2 uv, vec2 p) {
  float mids = bandAvg(4, 12);
  float baseFreq = 5.5 + mids * 9.0 + u_energy * 2.5;
  float baseAng = u_seed * TAU_MW * 0.5
                + u_globalTime * 0.04
                + cos(u_beatPhase * TAU_MW) * u_beatConf * 0.08;
  float delta = 0.05 + u_centroid * 0.35 + u_vocal * 0.07
              + sin(u_globalTime * 0.27 + u_seed * 11.0) * 0.05;

  float thickness = 0.07 + u_hat * 0.05;

  vec2 a = rot2(baseAng) * p;
  vec2 b = rot2(baseAng + delta) * p * (1.0 + 0.04 * sin(u_globalTime * 0.31));

  // Slight aspect skew on the second lattice deepens the moiré beat.
  b *= vec2(1.0, 1.0 + 0.06 * cos(u_globalTime * 0.21 + u_seed * 7.0));

  float L1 = lattice(a, baseFreq, thickness);
  float L2 = lattice(b, baseFreq * (1.0 + 0.045 + u_vocalPulse * 0.04), thickness);

  // Interference: product highlights crossings, sum gives weave density.
  float weave = L1 * L2;
  float density = (L1 + L2) * 0.5;

  // Slow-rolling tint phase across the screen for that holographic shimmer.
  float tintPhase = fbm(p * 0.7 + u_globalTime * 0.05);
  vec3 tint = paletteRamp(0.3 + tintPhase * 0.5 + u_centroid * 0.2);
  vec3 hot = paletteRamp(0.92);

  vec3 col = vec3(0.0);
  col += tint * density * 0.18;
  col += hot * weave * (0.45 + u_snarePulse * 0.4);

  // Faint iridescent flicker on the bright crossings.
  float irid = sin(weave * 18.0 + u_globalTime * 1.2 + p.x * 6.0) * 0.5 + 0.5;
  col += hsv2rgb(vec3(fract(u_centroid + tintPhase * 0.3), 0.4, 1.0)) * irid * weave * 0.18;

  // Soft radial fade so the veil drifts off at edges instead of slamming hard.
  float vig = smoothstep(1.55, 0.4, length(p));
  col *= 0.65 + vig * 0.35;

  // Cap alpha low — this is a veil over MilkDrop.
  float alpha = clamp(density * 0.22 + weave * 0.55, 0.0, 0.4);
  return vec4(col, alpha);
}
`,
};
