import type { SceneDef } from './index';

// Translucent bells, radial canals and trailing oral arms. Phase is integrated
// by the runtime: the music changes swimming speed without moving the clock.
export const medusaBloom: SceneDef = {
  id: 'medusa-bloom', name: 'Medusa Bloom', mood: 'calm',
  speed: (f, p) => 0.24 + f.bass * 0.55 + p.kick * 0.45,
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0);
  float aa = 2.0 / min(u_res.x, u_res.y);
  float life = 0.22 + 0.95 * u_energy;
  for (int i = 0; i < 5; i++) {
    float id = float(i), h = hash11(id + u_seed * 97.0);
    float swim = u_phase * (0.7 + h * 0.4) + h * 6.28318;
    vec2 center = vec2((id - 2.0) * 0.65 + 0.12 * sin(swim * 0.53),
      0.34 * sin(h * 19.0 + swim * 0.31) + 0.2);
    float size = 0.24 + h * 0.15;
    vec2 q = rot2(0.16 * sin(swim * 0.4)) * (p - center) / size;
    float pump = 0.5 + 0.5 * sin(swim * 2.0);
    q.x /= 0.88 + 0.12 * pump + u_kickPulse * 0.055;
    q.y /= 0.85 + 0.15 * (1.0 - pump);
    float r = length(q * vec2(1, 1.25));
    float rim = exp(-abs(r - 0.9) * 40.0) * smoothstep(-0.13, 0.02, q.y);
    float bell = (1.0 - smoothstep(0.83, 0.94, r)) * smoothstep(-0.15, 0.04, q.y);
    float angle = atan(q.x, q.y + 0.001);
    float canals = pow(0.5 + 0.5 * cos(angle * 16.0 + 0.4 * sin(r * 9.0 - swim)), 14.0);
    float comb = pow(0.5 + 0.5 * cos(r * 65.0 - swim * 7.0), 12.0);
    float skirt = exp(-abs(q.y + 0.04 + 0.07 * cos(q.x * 14.0 + swim)) * 35.0)
      * (1.0 - smoothstep(0.75, 0.98, abs(q.x)));
    float arms = 0.0;
    for (int j = 0; j < 5; j++) {
      float strand = float(j) - 2.0;
      float down = max(0.0, -q.y);
      float x = strand * 0.24 + (0.1 + down * 0.07) * sin(down * 3.8 - swim * 2.0 + strand);
      float width = max(aa / size, 0.014) + 0.02 * exp(-down);
      arms += exp(-abs(q.x - x) / width) * smoothstep(0.0, 0.2, down)
        * (1.0 - smoothstep(1.0 + h, 2.4 + h, down));
    }
    vec3 tint = paletteRamp(0.25 + 0.5 * h);
    col += tint * bell * (0.05 + canals * 0.32 + comb * canals * u_hat * 0.8) * life;
    col += mix(tint, u_light, 0.5) * (rim + skirt * 0.6) * life;
    col += paletteRamp(0.65 + 0.25 * sin(swim + q.y)) * arms * life * (0.5 + u_vocal * 0.6);
    col += tint * exp(-r * r * 2.0) * 0.035 * life;
  }
  return vec4(col, clamp(max(col.r, max(col.g, col.b)) * 1.7, 0.0, 0.82));
}
`,
};
