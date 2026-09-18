// Raymarched 3D gyroid sculpture, with lighting and depth-dependent haze.
import type { SceneDef } from './index';
export const volumeGarden: SceneDef = {
  id: 'volume-garden', name: 'Volume Garden', mood: 'calm',
  speed: f => 0.12 + f.energy * 0.22,
  frag: `
float sculpture(vec3 p) {
  p.xz = rot2(u_phase * 0.37) * p.xz;
  p.yz = rot2(u_phase * 0.21 + u_seed) * p.yz;
  float shell = length(p) - 1.45;
  vec3 q = p * (3.0 + u_seed);
  float gyroid = dot(sin(q), cos(q.zxy));
  float lattice = (abs(gyroid) - 0.23 - u_bass * 0.12) / 5.8;
  return max(shell, lattice);
}
vec4 scene(vec2 uv, vec2 p) {
  vec3 origin = vec3(0, 0, 3.7);
  vec3 ray = normalize(vec3(p * 0.78, -2.1));
  float travel = 0.0;
  float glow = 0.0;
  vec3 hit = origin;
  bool surface = false;
  for (int i = 0; i < 56; i++) {
    hit = origin + ray * travel;
    float distance = sculpture(hit);
    glow += exp(-abs(distance) * 18.0) * 0.005;
    if (distance < 0.003) { surface = true; break; }
    travel += max(0.006, distance * 0.7);
    if (travel > 6.0) break;
  }
  vec3 color = u_accent * glow * (0.25 + u_energy * 0.5);
  float alpha = glow * 0.3;
  if (surface) {
    vec2 e = vec2(0.004, 0);
    vec3 normal = normalize(vec3(sculpture(hit + e.xyy) - sculpture(hit - e.xyy),
      sculpture(hit + e.yxy) - sculpture(hit - e.yxy), sculpture(hit + e.yyx) - sculpture(hit - e.yyx)));
    float diffuse = max(0.0, dot(normal, normalize(vec3(-1, 2, 3))));
    float rim = pow(1.0 - abs(dot(normal, -ray)), 2.0);
    float tint = 0.5 + 0.3 * sin(hit.y * 2.0 + hit.x + u_phase * 0.2);
    color += paletteRamp(tint) * (0.18 + diffuse * 0.85) + u_light * rim * 0.3;
    color *= exp(-max(0.0, travel - 2.0) * 0.25);
    alpha = 0.86;
  }
  return vec4(color, clamp(alpha, 0.0, 0.9));
}
`,
};
