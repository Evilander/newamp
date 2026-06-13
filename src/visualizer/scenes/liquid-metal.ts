// 2D metaballs with a hard iso-surface — 6 seeded moving blobs sum inverse-
// square fields, blob radius pumps with bass, merge speed with energy, chrome
// banding from a sinusoidal ramp on the gradient.

import type { SceneDef } from './index';

export const liquidMetal: SceneDef = {
  id: 'liquid-metal',
  name: 'Liquid Metal',
  mood: 'mid',
  frag: `
const float TAU_LM = 6.28318530718;

float metaField(vec2 q, float t, float radius, out vec2 grad) {
  float f = 0.0;
  vec2 g = vec2(0.0);
  float seedOff = u_seed * 41.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 11.7 + seedOff);
    float omg = 0.4 + rnd * 0.7;
    float orbit = 0.55 + rnd * 0.35;
    vec2 c = vec2(
      sin(t * omg + rnd * TAU_LM) * orbit,
      cos(t * omg * 1.13 + rnd * 7.3) * orbit * 0.9
    );
    vec2 d = q - c;
    float r2 = dot(d, d) + 0.005;
    float w = radius * radius / r2;
    f += w;
    // Gradient of (radius^2 / r^2) = -2 * radius^2 * d / r^4.
    g += -2.0 * radius * radius * d / (r2 * r2);
  }
  grad = g;
  return f;
}

vec4 scene(vec2 uv, vec2 p) {
  float speed = 0.45 + u_energy * 1.1 + u_novelty * 0.2;
  float t = u_globalTime * speed;
  float radius = 0.22 + u_bass * 0.22 + u_kickPulse * 0.18;

  vec2 grad;
  float f = metaField(p, t, radius, grad);
  float iso = 1.0;

  // Surface mask: just inside the iso-line.
  float surf = smoothstep(iso - 0.18, iso, f);
  float core = smoothstep(iso, iso + 1.2, f);

  // Chrome bands: sinusoid of the field magnitude steered by gradient angle.
  float gAng = atan(grad.y, grad.x);
  float band = 0.5 + 0.5 * sin(f * 8.0 + gAng * 2.0 + t * 0.6);
  float bandSharp = pow(band, 3.0);

  // Rim: thin shell at the iso.
  float rim = exp(-pow((f - iso) * 4.0, 2.0));

  // Specular hint via small offset trick — fake light from upper-left.
  vec2 lightDir = normalize(vec2(-0.7, 0.7));
  float spec = pow(max(0.0, dot(normalize(grad + vec2(1e-4)), lightDir)), 6.0) * core;

  vec3 chrome = mix(u_dark, u_light, bandSharp);
  chrome = mix(chrome, u_accent, 0.35 + u_centroid * 0.35);

  vec3 col = vec3(0.0);
  col += chrome * (surf * 0.55 + core * 0.85);
  col += u_light * spec * (0.5 + u_vocal * 0.5);
  col += paletteRamp(0.9) * rim * (0.4 + u_snarePulse * 0.6);

  // Halo: soft outer glow only when energy is high.
  float halo = smoothstep(0.4, 1.0, f) * (1.0 - core);
  col += paletteRamp(0.4) * halo * (0.08 + u_energy * 0.22);

  // Beat-locked subtle pulse on the whole body.
  float beatPump = 0.5 + 0.5 * cos(u_beatPhase * TAU_LM);
  col *= 0.85 + beatPump * u_beatConf * 0.2;

  float alpha = clamp(surf * 0.55 + core * 0.7 + rim * 0.25, 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
