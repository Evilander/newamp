// Spiral Galaxy — a rotating log-spiral starfield seen face-on. Two arms of
// gaussian stars wind toward a hot core; arm brightness rides the low bands,
// the core flares on kicks, and the whole disc precesses slowly with a
// beat-locked wobble. Centroid tilts the color from dust-red to core-blue.

import type { SceneDef } from './index';

export const spiralGalaxy: SceneDef = {
  id: 'spiral-galaxy',
  name: 'Spiral Galaxy',
  mood: 'mid',
  frag: `
const float TAU = 6.28318530718;

// Signed distance-ish brightness of a log-spiral arm at polar (r, a).
float armGlow(float r, float a, float twist, float phase, float width) {
  // log-spiral: a = twist * log(r) + phase  →  wrapped angular distance
  float target = twist * log(max(r, 1e-4)) + phase;
  float d = a - target;
  d = mod(d + TAU * 0.5, TAU) - TAU * 0.5;
  return exp(-d * d / (width * width));
}

vec4 scene(vec2 uv, vec2 p) {
  float rot = u_globalTime * 0.06 + sin(u_beatPhase * TAU) * 0.012 * u_beatConf;
  vec2 q = rot2(rot) * p;
  float r = length(q);
  float a = atan(q.y, q.x);

  float bass = bandAvg(0, 5);
  float mids = bandAvg(6, 14);

  vec3 col = vec3(0.0);

  // Two arms, half a turn apart, widening with energy.
  float width = 0.34 + u_energy * 0.22;
  float twist = 2.6 + u_seed * 1.2;
  float arms = armGlow(r, a, twist, u_seed * TAU, width)
             + armGlow(r, a, twist, u_seed * TAU + TAU * 0.5, width);

  // Star grain along the arms — twinkles with hats.
  float grain = vnoise(q * 26.0 + vec2(u_globalTime * 0.15));
  grain = pow(grain, 3.0) * (0.6 + u_hatPulse * 1.4);

  float falloff = exp(-r * 1.9);
  vec3 armTint = paletteRamp(0.35 + u_centroid * 0.4);
  col += armTint * arms * falloff * (0.28 + bass * 0.9) * (0.55 + grain);

  // Dust lanes — dark fbm streaks rotated with the disc.
  float dust = fbm(q * 3.0 + vec2(u_seed * 31.0));
  col *= 0.72 + 0.28 * smoothstep(0.25, 0.6, dust);

  // Hot core: gaussian flare, kicked by the kick.
  float core = exp(-r * r * (34.0 - u_kickPulse * 18.0));
  col += mix(paletteRamp(0.85), vec3(1.0), 0.35) * core * (0.5 + u_kick * 0.8 + u_kickPulse * 1.3);

  // Faint halo so the disc sits in space, breathing with mids.
  col += paletteRamp(0.2) * exp(-r * 1.1) * 0.08 * (0.5 + mids);

  float alpha = clamp(dot(col, vec3(0.5)), 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
