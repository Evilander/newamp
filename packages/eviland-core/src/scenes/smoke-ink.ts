// Ink billowing in water — domain-warped fbm clouds bloom upward on bass,
// fine filaments from a higher-frequency fbm pass, and kicks inject radial
// ink drops at seeded positions. Monochrome dark palette with accent edges.

import type { SceneDef } from './index';

export const smokeInk: SceneDef = {
  id: 'smoke-ink',
  name: 'Smoke & Ink',
  mood: 'calm',
  frag: `
float warpField(vec2 q, float t) {
  vec2 w1 = vec2(fbm(q + vec2(t * 0.13, -t * 0.07)),
                 fbm(q + vec2(-t * 0.09, t * 0.11) + 5.2));
  vec2 w2 = vec2(fbm(q * 1.7 + w1 * 1.5 + t * 0.05),
                 fbm(q * 1.7 + w1.yx * 1.5 - t * 0.04 + 9.1));
  return fbm(q + w2 * 1.8);
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = u_seed * 91.0;
  float t = u_globalTime;

  // Upward drift: shift sample y down over time so ink rises.
  float rise = 0.12 + u_bass * 0.45 + u_kick * 0.25;
  vec2 q = vec2(p.x * 1.3, p.y - t * rise * 0.18) + seedOff * 0.07;

  // Main billow.
  float billow = warpField(q * 1.1, t);

  // Bass swells push the cloud body brighter and taller.
  float swell = pow(billow, 1.8 - u_bass * 0.6) * (0.5 + u_bass * 0.9);

  // Fine filaments via higher-freq pass.
  float filam = fbm(q * 5.4 + vec2(t * 0.2, 0.0));
  float fineEdge = smoothstep(0.42, 0.62, filam) * smoothstep(0.5, 0.85, billow) * 0.35;

  // Bottom bias — ink originates from below.
  float bottom = smoothstep(0.95, -0.1, p.y);
  float body = swell * bottom;

  // Kick-injected radial puffs: a few seeded positions pulse outward.
  float drops = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 17.3 + seedOff);
    vec2 c = vec2((rnd - 0.5) * 1.6, -0.6 + hash11(rnd * 9.1) * 0.4);
    // Age: each drop resets on kick impulses, weighted by per-drop phase.
    float age = fract(u_globalTime * 0.18 + rnd);
    float radius = 0.06 + age * (0.7 + u_kickPulse * 0.4);
    float d = length(p - c);
    float ring = exp(-pow((d - radius) / (0.18 + age * 0.12), 2.0));
    drops += ring * (1.0 - age) * (0.4 + u_kickPulse * 0.8);
  }

  // Compose.
  vec3 dark = u_dark * 0.6;
  vec3 ink = mix(dark, u_dark, 0.5);
  vec3 col = ink * body * 0.85;
  col += u_accent * fineEdge * (0.4 + u_centroid * 0.5);
  col += paletteRamp(0.7) * drops * 0.45;

  // Vocal envelope brightens curling tendrils — accent edge along the wave.
  float wavy = smoothstep(0.55, 0.7, billow) - smoothstep(0.7, 0.85, billow);
  col += u_accent * wavy * (0.15 + u_vocal * 0.5);

  // Slight horizontal drift wobble so the column doesn't feel static.
  float wob = sin(p.y * 4.0 + t * 0.6 + seedOff) * 0.02;
  col *= 0.9 + wob;

  float alpha = clamp(body * 0.65 + fineEdge * 0.8 + drops * 0.6, 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
