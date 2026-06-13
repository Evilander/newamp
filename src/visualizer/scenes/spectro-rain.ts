// Spectrum rain — 24 columns, one per mel band, with droplets that fall
// faster and glow brighter as their band gets louder; kicks flash a floor
// splash. The whole spectrum becomes weather over the MilkDrop field.

import type { SceneDef } from './index';

export const spectroRain: SceneDef = {
  id: 'spectro-rain',
  name: 'Spectro Rain',
  mood: 'mid',
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float colF = uv.x * 24.0;
  int band = int(clamp(floor(colF), 0.0, 23.0));
  float level = u_bands[band];
  float cx = fract(colF) - 0.5; // -0.5..0.5 within the column

  // Three staggered droplets per column.
  for (int d = 0; d < 3; d++) {
    float fd = float(d);
    float rnd = hash21(vec2(float(band) * 3.1 + fd * 17.7, floor(u_seed * 733.0)));
    float speed = 0.12 + level * 0.9 + u_energy * 0.25 + rnd * 0.2;
    float y = fract(rnd * 7.0 - u_globalTime * speed); // 1 → 0 falls down… uv.y up
    float dy = uv.y - (1.0 - y);
    float trail = smoothstep(0.0, 0.18 + level * 0.2, -dy) * step(dy, 0.0);
    float head = smoothstep(0.012 + level * 0.01, 0.0, abs(dy));
    float lateral = smoothstep(0.32, 0.0, abs(cx));
    float lit = (head * (0.4 + level * 0.9) + trail * exp(dy * 9.0) * (0.12 + level * 0.45)) * lateral;
    col += paletteRamp(0.25 + level * 0.55 + rnd * 0.15) * lit;
  }

  // Kick splash along the floor; snare flickers a faint sky sheet.
  float splash = u_kickPulse * smoothstep(0.16, 0.0, uv.y) * (0.4 + u_bass * 0.6);
  col += paletteRamp(0.9) * splash * 0.5;
  float sheet = u_snarePulse * smoothstep(0.75, 1.0, uv.y) * 0.12;
  col += u_light * sheet;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.7);
  return vec4(col, alpha);
}
`,
};
