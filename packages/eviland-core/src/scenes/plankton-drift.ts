import type { SceneDef } from './index';

// A bounded nine-neighbour field of swimming microorganisms. Rounded bodies,
// contractile vacuoles and flagella remain individually readable in the flow.
export const planktonDrift: SceneDef = {
  id: 'plankton-drift', name: 'Plankton Drift', mood: 'calm',
  speed: (f, p) => 0.15 + f.energy * 0.35 + p.hat * 0.22,
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  vec2 q = p * 2.1 + vec2(u_phase * 0.16, u_phase * 0.10);
  q += 0.12 * vec2(sin(q.y * 1.8 + u_phase * 0.3), cos(q.x * 1.7 - u_phase * 0.25));
  vec2 cell = floor(q), f = fract(q);
  vec3 col = vec3(0);
  float life = 0.16 + u_energy;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 key = cell + offset + floor(u_seed * 211.0);
      vec2 h = hash22(key);
      vec2 center = offset + 0.5 + 0.16 * vec2(sin(u_phase + h.x * 20.0), cos(u_phase * 0.8 + h.y * 20.0));
      vec2 v = rot2(h.x * 6.28318 + 0.22 * sin(u_phase * 0.6 + h.y * 9.0)) * (f - center);
      float r = length(v * vec2(1.0, 1.5));
      float size = 0.14 + h.y * 0.10 + u_bass * 0.012;
      float wall = exp(-abs(r - size) * 110.0);
      float body = 1.0 - smoothstep(size - 0.02, size, r);
      float nucleus = exp(-dot(v - vec2(0.025, 0), v - vec2(0.025, 0)) * 1900.0);
      float tailX = max(0.0, -v.x - size * 0.65);
      float tailY = v.y - sin(tailX * 24.0 - u_phase * 5.0 + h.x * 9.0) * tailX * 0.22;
      float tail = exp(-abs(tailY) * 160.0) * smoothstep(0.0, 0.04, tailX)
        * (1.0 - smoothstep(0.15, 0.42, tailX));
      float vacuole = exp(-abs(length(v + vec2(0.065, 0.005)) - 0.035) * 180.0) * body;
      int band = int(h.y * 23.99);
      float firing = u_bands[band] * (0.5 + 0.5 * sin(u_bandTime[band] * 2.0 + h.x * 6.0));
      vec3 tint = paletteRamp(0.2 + h.x * 0.5);
      col += tint * (wall * 0.75 + body * 0.11 + tail * 0.75) * life;
      col += mix(tint, u_light, 0.65) * (nucleus * (0.5 + firing) + vacuole * 0.4) * life;
    }
  }
  col *= 1.4;
  return vec4(col, clamp(max(col.r, max(col.g, col.b)) * 1.9, 0.0, 0.82));
}
`,
};
