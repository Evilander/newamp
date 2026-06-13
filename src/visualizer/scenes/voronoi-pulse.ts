// Living cellular tessellation — worley/voronoi cells whose walls glow and
// whose interiors flash on per-cell band hits. Field breathes with bass,
// drifts slowly; seed re-arranges the cell jitter.

import type { SceneDef } from './index';

export const voronoiPulse: SceneDef = {
  id: 'voronoi-pulse',
  name: 'Voronoi Pulse',
  mood: 'mid',
  frag: `
const float SCALE = 4.2;

vec3 worley(vec2 q, float seedOff, float jitterAmp) {
  vec2 ip = floor(q);
  vec2 fp = fract(q);
  float d1 = 1e3, d2 = 1e3;
  vec2 best = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 cell = ip + g;
      vec2 jitter = hash22(cell + seedOff) - 0.5;
      jitter += 0.18 * vec2(
        sin(u_globalTime * 0.35 + cell.x * 1.7),
        cos(u_globalTime * 0.31 + cell.y * 1.9));
      vec2 pos = g + 0.5 + jitter * jitterAmp;
      float d = length(pos - fp);
      if (d < d1) { d2 = d1; d1 = d; best = cell; }
      else if (d < d2) { d2 = d; }
    }
  }
  return vec3(d1, d2 - d1, hash21(best * 1.31 + seedOff));
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = floor(u_seed * 977.0);
  float breath = 1.0 + u_bass * 0.18 + u_kickPulse * 0.12;
  vec2 drift = vec2(
    u_globalTime * (0.06 + u_pan * 0.04),
    u_globalTime * 0.045 + u_width * 0.1);
  float rot = u_seed * 6.28 + u_globalTime * 0.02;
  vec2 q = (rot2(rot) * p) * (SCALE / breath) + drift;

  vec3 w = worley(q, seedOff, 0.95);
  float d1 = w.x;
  float edge = w.y;
  float cellHash = w.z;

  int bandIdx = int(floor(cellHash * 24.0));
  float band = u_bands[bandIdx];
  float flash = pow(band, 1.6) * (0.5 + u_kick * 0.6);

  float wall = smoothstep(0.085, 0.0, edge);
  float halo = smoothstep(0.35, 0.0, edge) * 0.18;
  float core = smoothstep(0.55, 0.0, d1) * (0.18 + flash * 1.1);

  vec3 wallCol = paletteRamp(0.85 + u_centroid * 0.1);
  vec3 cellCol = paletteRamp(0.18 + cellHash * 0.5 + u_centroid * 0.2);

  vec3 col = wallCol * wall * (0.55 + u_hat * 0.4 + u_hatPulse * 0.5);
  col += wallCol * halo * (0.4 + u_energy * 0.6);
  col += cellCol * core;

  float spark = step(0.94, hash21(vec2(cellHash * 53.0, floor(u_globalTime * 4.0)))) *
                smoothstep(0.4, 0.0, d1) * u_snarePulse * 0.6;
  col += u_light * spark;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
