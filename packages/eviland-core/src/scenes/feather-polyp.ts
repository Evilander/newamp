import type { SceneDef } from './index';

// A feather star crown. Polar folding evaluates one arm and its pinnules per
// pixel, so adding fine branching doesn't need particles or a ray marcher.
export const featherPolyp: SceneDef = {
  id: 'feather-polyp', name: 'Feather Polyp', mood: 'high',
  speed: (f, p) => 0.18 + f.vocal * 0.5 + p.kick * 0.38,
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0);
  float life = 0.18 + u_energy * 1.05;
  float aa = 2.0 / min(u_res.x, u_res.y);
  for (int i = 0; i < 3; i++) {
    float id = float(i), h = hash11(u_seed * 31.0 + id);
    vec2 center = i == 0 ? vec2(0, -0.15) : vec2((id * 2.0 - 3.0) * 1.02, 0.34);
    vec2 q = p - center;
    float size = i == 0 ? 1.0 : 0.64;
    q /= size;
    float r = length(q);
    float angle = atan(q.y, q.x + 0.00001);
    float arms = 9.0 + floor(h * 4.0);
    float turn = angle + 0.3 * sin(r * 3.0 - u_phase + h * 6.0) + r * 0.5;
    float sector = 6.28318 / arms;
    float folded = mod(turn + sector * 0.5, sector) - sector * 0.5;
    vec2 arm = vec2(cos(folded), sin(folded)) * r;
    float reach = 0.81 + 0.09 * sin(u_phase + h * 7.0) + u_bass * 0.09;
    float envelope = smoothstep(0.10, 0.22, r) * (1.0 - smoothstep(reach - 0.14, reach, r));
    float stem = exp(-abs(arm.y) / max(0.008, aa / size));
    float rib = (fract((arm.x - abs(arm.y) * 1.9) * 29.0) - 0.5) / 29.0;
    float taper = (0.024 + 0.065 * sin(clamp(arm.x / reach, 0.0, 1.0) * 3.14159));
    float feathers = exp(-abs(rib) / max(0.004, aa / size)) * exp(-abs(arm.y) / taper);
    float signal = pow(0.5 + 0.5 * sin(r * 19.0 - u_phase * 4.0 + angle * 2.0), 8.0);
    col += paletteRamp(0.25 + r * 0.55) * (stem + feathers * 0.62) * envelope * life;
    col += u_light * feathers * envelope * signal * (u_hat * 0.5 + u_snarePulse * 0.7);
    float mouth = exp(-abs(r - 0.12 - u_kickPulse * 0.012) * 90.0);
    col += paletteRamp(0.85) * mouth * life;
    col += paletteRamp(0.35) * exp(-r * r * 80.0) * life * 0.3;
  }
  return vec4(col, clamp(max(col.r, max(col.g, col.b)) * 1.5, 0.0, 0.84));
}
`,
};
