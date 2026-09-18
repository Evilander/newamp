// Hex grid pressure waves — kick impulses launch expanding rings of lit
// hexagons from center, per-hex brightness also samples bands by radius,
// and edge glow rides the hi-hat. Seed rotates/scales the lattice.

import type { SceneDef } from './index';

export const hexPulse: SceneDef = {
  id: 'hex-pulse',
  name: 'Hex Pulse',
  mood: 'high',
  frag: `
const float SQRT3 = 1.7320508;

// Returns vec4: xy = cell id, z = distance to nearest hex edge (0..0.5,
// higher = more interior), w = radial distance from origin in cell units.
vec4 hexCell(vec2 q) {
  vec2 r = vec2(1.0, SQRT3);
  vec2 h = r * 0.5;
  vec2 a = mod(q, r) - h;
  vec2 b = mod(q - h, r) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = q - gv;
  vec2 ag = abs(gv);
  // Distance to flat-top hex boundary (regular hexagon, radius 0.5).
  float edge = 0.5 - max(ag.x * 1.0 + ag.y * (1.0 / SQRT3),
                         ag.y * (2.0 / SQRT3));
  return vec4(id, edge, length(id));
}

vec4 scene(vec2 uv, vec2 p) {
  float scale = 6.0 + u_seed * 4.0;
  vec2 q = rot2(u_seed * 6.28 + u_globalTime * 0.02) * p * scale;
  vec4 hc = hexCell(q);
  vec2 id = hc.xy;
  float edge = hc.z;
  float ringR = hc.w;

  float cellHash = hash21(id * 0.71 + floor(u_seed * 311.0));
  int bandIdx = int(clamp(floor(ringR * 1.6), 0.0, 23.0));
  float band = u_bands[bandIdx];

  // Pressure wave: kicks launch lit rings that travel outward.
  float waveSpeed = 4.0 + u_energy * 6.0;
  float wavePhase = u_globalTime * waveSpeed - ringR;
  float wave = exp(-abs(fract(wavePhase * 0.15) - 0.5) * 9.0) *
               (0.4 + u_kick * 0.5 + u_kickPulse * 0.7);

  float twinkle = 0.5 + 0.5 * sin(u_globalTime * (3.0 + cellHash * 7.0) + cellHash * 31.0);
  float cellLit = (0.08 + band * 0.9) * twinkle + wave;

  float fill = smoothstep(0.0, 0.12, edge) * cellLit;
  float rim = smoothstep(0.04, 0.0, edge) * (0.45 + u_hat * 0.6 + u_hatPulse * 0.5);

  vec3 fillCol = paletteRamp(0.25 + cellHash * 0.35 + u_centroid * 0.3);
  vec3 rimCol = paletteRamp(0.88);

  vec3 col = fillCol * fill * 0.55;
  col += rimCol * rim;

  // Center bloom on kick.
  float core = smoothstep(0.45, 0.0, length(p)) * u_kickPulse * 0.5;
  col += u_light * core;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
