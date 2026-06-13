// Layered translucent silk sheets drifting across the screen — amplitude
// breathes with bass/mids, stereo pan tilts the drift. A calm scene that
// leaves most of the MilkDrop field visible through low alpha.

import type { SceneDef } from './index';

export const silkWaves: SceneDef = {
  id: 'silk-waves',
  name: 'Silk Waves',
  mood: 'calm',
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float drift = u_globalTime * (0.12 + u_energy * 0.25);

  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 13.7 + u_seed * 311.0);
    // Each sheet listens to its own slice of the spectrum.
    float band = bandAvg(int(fi) * 4, int(fi) * 4 + 4);
    float amp = 0.05 + band * 0.34 + u_bass * 0.08;
    float freq = 1.4 + rnd * 3.2;
    float phase = rnd * 31.0 + drift * (0.5 + rnd) + u_pan * 0.8;
    float yc = -0.75 + fi * 0.38 + sin(u_globalTime * (0.07 + rnd * 0.1) + rnd * 9.0) * 0.12;
    float wave = yc + sin(p.x * freq + phase) * amp
               + sin(p.x * freq * 2.7 + phase * 1.6) * amp * 0.35;
    float d = abs(p.y - wave);
    float sheet = smoothstep(0.16 + band * 0.1, 0.0, d);
    float ridge = smoothstep(0.018, 0.0, d) * (0.5 + band);
    vec3 tint = paletteRamp(0.18 + fi * 0.17 + u_centroid * 0.15);
    col += tint * (sheet * (0.045 + band * 0.16) + ridge * 0.22);
  }

  // Hat impulses sprinkle glints along the top sheet.
  float glint = u_hatPulse * smoothstep(0.6, 0.0, abs(p.y - 0.55)) *
                smoothstep(0.9, 0.0, abs(fract(p.x * 6.0 + u_globalTime * 0.6) - 0.5) * 2.0);
  col += u_light * glint * 0.35;

  float alpha = clamp(dot(col, vec3(0.6)), 0.0, 0.55);
  return vec4(col, alpha);
}
`,
};
