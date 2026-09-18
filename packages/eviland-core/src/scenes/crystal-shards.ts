// Angular shard field — folded polygonal slabs that tumble, each lit by its
// own band. Snare impulses shatter the field with a decaying angular jitter,
// and the palette is offset between facets for a faux-refraction shimmer.

import type { SceneDef } from './index';

export const crystalShards: SceneDef = {
  id: 'crystal-shards',
  name: 'Crystal Shards',
  mood: 'mid',
  frag: `
float shardSdf(vec2 q, float sides, float radius) {
  float a = atan(q.y, q.x);
  float r = length(q);
  float seg = 6.28318530718 / sides;
  float ang = mod(a + seg * 0.5, seg) - seg * 0.5;
  return r * cos(ang) - radius;
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float shatter = u_snarePulse * 0.6;

  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 7.13 + u_seed * 401.0);
    int bandIdx = int(floor(rnd * 24.0));
    float band = u_bands[bandIdx];

    vec2 ctr = (hash22(vec2(fi * 3.7, u_seed * 91.0)) - 0.5) * 2.1;
    ctr += 0.1 * vec2(sin(u_globalTime * (0.2 + rnd * 0.3)),
                      cos(u_globalTime * (0.18 + rnd * 0.27)));

    float tumble = u_globalTime * (0.12 + rnd * 0.45) + rnd * 6.28;
    tumble += shatter * (rnd - 0.5) * 4.0;
    vec2 q = rot2(tumble) * (p - ctr);

    float sides = floor(3.0 + rnd * 5.0);
    float baseR = 0.22 + rnd * 0.32 + band * 0.18 + u_bass * 0.05;
    float d = shardSdf(q, sides, baseR);

    float refract = 0.025 + band * 0.04;
    float dR = shardSdf(q + vec2(refract, 0.0), sides, baseR);
    float dG = d;
    float dB = shardSdf(q - vec2(refract, 0.0), sides, baseR);

    float fill = smoothstep(0.02, -0.04, d) * (0.18 + band * 0.7);
    float edge = smoothstep(0.012, 0.0, abs(d));
    float facet = smoothstep(0.08, 0.0, abs(dR - dB));

    vec3 base = paletteRamp(0.25 + rnd * 0.5 + u_centroid * 0.2);
    vec3 trim = paletteRamp(0.92);

    col += base * fill;
    col += trim * edge * (0.6 + band * 0.8 + u_hatPulse * 0.5);
    col += base * facet * 0.18;

    // Per-shard hue split mimicking refraction along the edges.
    float chr = smoothstep(0.04, 0.0, abs(d));
    col.r += chr * 0.15 * paletteRamp(0.1).r;
    col.b += chr * 0.15 * paletteRamp(0.8).b;
  }

  // Whole-field flash on shatter.
  col += u_light * shatter * 0.18;

  float alpha = clamp(dot(col, vec3(0.5)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
