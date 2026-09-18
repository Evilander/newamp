// Pixel Bloom — coarse 20-cell mosaic where seeded blossoms expand in rings
// from a handful of centers. Vocal + bass swells push new rings outward;
// each ring picks the next color step from paletteRamp. Soft pixel rounding.

import type { SceneDef } from './index';

export const pixelBloom: SceneDef = {
  id: 'pixel-bloom',
  name: 'Pixel Bloom',
  mood: 'calm',
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  float GRID = 20.0;
  vec2 cell = floor(uv * GRID);
  vec2 cuv = fract(uv * GRID) - 0.5;

  float maskCorner = 1.0 - smoothstep(0.42, 0.52, length(cuv));
  vec3 col = vec3(0.0);

  float swell = u_vocal * 0.7 + u_bass * 0.45 + u_vocalPulse * 0.5;
  float bloomRadius = 1.0 + swell * 9.0 + u_energy * 4.0;

  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 23.7 + floor(u_seed * 421.0));
    float rnd2 = hash11(fi * 5.9 + floor(u_seed * 137.0) + 2.3);
    vec2 origin = floor(vec2(rnd, rnd2) * GRID) + vec2(0.5);
    origin.x += floor(sin(u_globalTime * (0.3 + rnd * 0.4) + fi) * 1.5);
    origin.y += floor(cos(u_globalTime * (0.25 + rnd2 * 0.4) + fi * 1.3) * 1.5);

    int bandIdx = int(mod(fi * 4.0, 24.0));
    float level = 0.0;
    for (int b = 0; b < 24; b++) { if (b == bandIdx) level = u_bands[b]; }

    float ring = length(cell - origin);
    float bloom = bloomRadius * (0.5 + level * 1.2) + rnd * 1.5;
    float ringPos = ring;

    float alive = smoothstep(bloom + 0.7, bloom - 0.7, ringPos);
    float pulse = 0.5 + 0.5 * sin(ring * 1.4 - u_globalTime * (1.0 + level * 2.0) + rnd * 9.0);

    float t = fract(0.12 + ring * 0.07 + u_centroid * 0.25 + fi * 0.13);
    vec3 tint = paletteRamp(t);
    col += tint * alive * pulse * (0.35 + level * 1.1);
  }

  col *= maskCorner;

  float twinkle = hash21(cell + floor(u_globalTime * 4.0)) * u_hatPulse * 0.4;
  col += paletteRamp(0.95) * twinkle * maskCorner * 0.5;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.72);
  return vec4(col, alpha);
}
`,
};
