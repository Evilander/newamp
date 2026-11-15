// Kaleidoscopic mandala — seeded sector count, crisp vector-ish petals plus
// ring filigree. Petals extend with vocal envelope, rotation locks to
// u_beatPhase, bloom expands hard on kick impulses.

import type { SceneDef } from './index';

export const kaleidoBloom: SceneDef = {
  id: 'kaleido-bloom',
  name: 'Kaleido Bloom',
  mood: 'mid',
  frag: `
const float TAU = 6.28318530718;

vec4 scene(vec2 uv, vec2 p) {
  float sectors = floor(6.0 + u_seed * 10.0);
  float beatRot = u_beatPhase * TAU * 0.08 + u_globalTime * 0.05;
  vec2 q = rot2(beatRot) * p;

  float r = length(q);
  float a = atan(q.y, q.x);
  float seg = TAU / sectors;
  float ang = mod(a + seg * 0.5, seg) - seg * 0.5;
  ang = abs(ang);

  vec2 fp = vec2(cos(ang), sin(ang)) * r;

  // Petal extension: vocal-driven radial reach.
  float petalLen = 0.55 + u_vocal * 0.45 + u_kickPulse * 0.35;
  float petal = (1.0 - smoothstep(petalLen - 0.18, petalLen, r)) *
                (1.0 - smoothstep(0.0, 0.06, ang * (0.6 + r)));
  float petalEdge = (1.0 - smoothstep(0.0, 0.012, abs(r - petalLen))) *
                    (1.0 - smoothstep(0.0, 0.12, ang));

  // FBM tracery inside the sector wedge.
  float n = fbm(fp * (4.2 + u_seed * 2.0) + vec2(u_globalTime * 0.3, u_globalTime * 0.21));
  float filigree = smoothstep(0.52, 0.62, n) * (1.0 - smoothstep(0.4, 0.85, r));

  // Concentric rings driven by mid bands.
  float ringBand = bandAvg(6, 14);
  float rings = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float rr = 0.18 + fi * 0.18 + sin(u_globalTime * (0.4 + fi * 0.2)) * 0.02;
    float w = 0.006 + ringBand * 0.012 + u_hatPulse * 0.01;
    rings += (1.0 - smoothstep(0.0, w, abs(r - rr))) * (0.4 + ringBand * 0.6);
  }

  float bloom = u_kickPulse * (1.0 - smoothstep(0.0, 0.95, r)) * 0.6;
  float core = (1.0 - smoothstep(0.0, 0.18, r)) * (0.25 + u_vocal * 0.5);

  vec3 petalCol = paletteRamp(0.35 + u_centroid * 0.3);
  vec3 ringCol = paletteRamp(0.78);
  vec3 fiCol = paletteRamp(0.62 + sin(u_globalTime * 0.4) * 0.1);

  vec3 col = petalCol * petal * (0.4 + u_vocal * 0.6);
  col += petalCol * petalEdge * (0.6 + u_vocalPulse * 0.7);
  col += fiCol * filigree * (0.25 + u_energy * 0.5);
  col += ringCol * rings * 0.5;
  col += paletteRamp(0.95) * core;
  col += u_light * bloom;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
