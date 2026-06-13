// Hyperspace starfield — warp streaks radiate from center, speed pumped by
// overall energy and kick impulses, hue steered by spectral brightness.
// Reference scene for the overlay contract: read scenes/index.ts before
// writing a new one.

import type { SceneDef } from './index';

export const starfieldWarp: SceneDef = {
  id: 'starfield-warp',
  name: 'Starfield Warp',
  mood: 'high',
  frag: `
const float TAU = 6.28318530718;

vec4 scene(vec2 uv, vec2 p) {
  float speed = 0.22 + u_energy * 1.1 + u_kickPulse * 1.5;
  float r = length(p);
  float a = atan(p.y, p.x);
  vec3 col = vec3(0.0);

  // Three depth layers of angular wedges, each wedge owning one streaking star.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float segs = 70.0 + fi * 48.0;
    float an = a / TAU + 0.5;
    float cell = floor(an * segs);
    float fa = fract(an * segs) - 0.5; // -0.5..0.5 across the wedge
    float rnd = hash21(vec2(cell, fi * 7.31 + floor(u_seed * 911.0)));
    float z = fract(rnd + u_time * speed * (0.35 + rnd * 0.65));
    float starR = mix(0.02, 1.8, z * z); // accelerates outward — warp feel
    float streak = (0.015 + u_energy * 0.08 + u_kickPulse * 0.16) * (0.3 + z);
    float dash = smoothstep(0.42, 0.0, abs(fa)) * smoothstep(streak, 0.0, abs(r - starR));
    float tw = 0.65 + 0.35 * sin(u_globalTime * (3.0 + rnd * 8.0) + rnd * 37.0);
    col += paletteRamp(0.3 + rnd * 0.45 + u_centroid * 0.25) * dash * tw * (0.2 + z);
  }

  // Soft core glow that breathes with the vocal envelope.
  float core = smoothstep(0.5, 0.0, r) * (0.06 + u_vocal * 0.22 + u_kickPulse * 0.18);
  col += paletteRamp(0.85) * core;

  float alpha = clamp(dot(col, vec3(0.45)), 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
