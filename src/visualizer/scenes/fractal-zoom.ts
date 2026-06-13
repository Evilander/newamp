// Fractal Zoom — Julia-set dive whose c parameter walks a seeded path
// modulated by centroid + vocal. Continuous exponential zoom, smooth
// iteration coloring through paletteRamp, iteration glow pulses on energy.

import type { SceneDef } from './index';

export const fractalZoom: SceneDef = {
  id: 'fractal-zoom',
  name: 'Fractal Zoom',
  mood: 'any',
  frag: `
const int MAX_ITER = 48;

vec4 scene(vec2 uv, vec2 p) {
  float seedAng = u_seed * 6.28318;
  float zoomT = u_globalTime * (0.07 + u_energy * 0.05);
  float zoom = 0.85 * exp(-mod(zoomT, 4.0) * 0.5);
  float rot = u_seed * 1.3 + u_globalTime * 0.04 + u_pan * 0.2;

  vec2 z = rot2(rot) * p * zoom;
  z += vec2(sin(u_seed * 13.1) * 0.12, cos(u_seed * 7.7) * 0.09);

  float cr = -0.72 + 0.28 * sin(u_globalTime * 0.13 + seedAng);
  float ci = 0.19 + 0.26 * cos(u_globalTime * 0.11 + seedAng * 1.7);
  cr += (u_centroid - 0.5) * 0.12 + u_vocal * 0.06;
  ci += (u_centroid - 0.5) * 0.08 + u_bass * 0.05;
  vec2 c = vec2(cr, ci);

  float iter = 0.0;
  float escape = 0.0;
  float trap = 1e9;
  for (int i = 0; i < MAX_ITER; i++) {
    float x2 = z.x * z.x;
    float y2 = z.y * z.y;
    if (x2 + y2 > 16.0) { escape = x2 + y2; break; }
    z = vec2(x2 - y2, 2.0 * z.x * z.y) + c;
    trap = min(trap, dot(z, z));
    iter += 1.0;
  }

  float t;
  if (escape > 0.0) {
    float smoothI = iter - log2(log2(escape)) + 4.0;
    t = fract(smoothI * 0.045 + u_globalTime * 0.08 + u_centroid * 0.3);
  } else {
    t = clamp(sqrt(trap) * 0.5, 0.0, 1.0);
  }

  vec3 col = paletteRamp(t);
  float interior = (escape > 0.0) ? 0.0 : 1.0;
  col *= mix(1.0, 0.25, interior);

  float pulse = (0.7 + u_energy * 1.4 + u_kickPulse * 1.2);
  col *= pulse * (0.45 + iter / float(MAX_ITER) * 0.9);

  float halo = exp(-length(p) * 1.4) * (0.05 + u_bass * 0.15);
  col += paletteRamp(0.9) * halo;

  float beatRing = smoothstep(0.02, 0.0, abs(fract(iter * 0.12 + u_beatPhase) - 0.5) - 0.45);
  col += paletteRamp(0.7) * beatRing * 0.15 * u_beatConf;

  float alpha = clamp(dot(col, vec3(0.5)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
