// City Pulse — a night skyline that IS the equalizer: 24 buildings, one per
// mel band, rising and falling with their band's level. Lit windows twinkle
// with hi-hats, a kick thumps a warm glow up from the street, and the sky
// carries a slow aurora wash. The city your music builds.

import type { SceneDef } from './index';

export const cityPulse: SceneDef = {
  id: 'city-pulse',
  name: 'City Pulse',
  mood: 'high',
  frag: `
float bandLevel(int idx) {
  float level = 0.0;
  for (int i = 0; i < 24; i++) { if (i == idx) level = u_bands[i]; }
  return level;
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);

  // Sky: slow aurora wash keyed to the palette, brighter toward the horizon.
  float sky = fbm(vec2(uv.x * 3.0, uv.y * 2.0 - u_globalTime * 0.03));
  col += paletteRamp(0.15 + sky * 0.25) * (0.05 + 0.10 * (1.0 - uv.y)) * (0.6 + u_energy * 0.5);

  // Buildings: 24 columns across the width, heights from the bands with a
  // per-building static offset so the skyline reads as a city, not a chart.
  float fx = uv.x * 24.0;
  int idx = int(clamp(floor(fx), 0.0, 23.0));
  float cell = fract(fx);
  float rnd = hash11(floor(fx) * 7.31 + floor(u_seed * 419.0));
  float level = bandLevel(idx);
  float height = 0.12 + rnd * 0.22 + level * 0.5;

  // Building mass with a thin gap between towers.
  float inBuilding = step(uv.y, height) * step(0.06, cell) * step(cell, 0.94);
  vec3 wall = mix(vec3(0.015, 0.02, 0.035), paletteRamp(0.3) * 0.14, level);
  col = mix(col, wall, inBuilding);

  // Windows: grid of lit cells; probability rises with the band level and
  // hats make random windows flicker on.
  vec2 win = vec2(fract(fx * 4.0), fract(uv.y * 40.0));
  float winMask = step(0.25, win.x) * step(win.x, 0.75) * step(0.25, win.y) * step(win.y, 0.75);
  float lit = hash21(vec2(floor(fx * 4.0), floor(uv.y * 40.0)) + floor(u_seed * 97.0));
  float litNow = step(1.0 - (0.18 + level * 0.4 + u_hatPulse * 0.25), lit);
  col += paletteRamp(0.62 + lit * 0.3) * winMask * litNow * inBuilding * (0.5 + level);

  // Rooftop beacons on the tallest towers, blinking with the beat.
  float roof = smoothstep(height - 0.006, height, uv.y) * step(uv.y, height + 0.004) * step(0.55, height);
  float blink = 0.5 + 0.5 * sin(u_beatPhase * 6.28318 + rnd * 6.28318);
  col += vec3(1.0, 0.25, 0.2) * roof * blink * u_beatConf * step(0.45, cell) * step(cell, 0.55);

  // Street glow: kick thumps warm light up from the bottom edge.
  float street = exp(-uv.y * 9.0);
  col += paletteRamp(0.8) * street * (0.12 + u_kickPulse * 0.9 + u_bass * 0.25);

  // Light haze above the skyline so towers bloom into the sky.
  float above = smoothstep(height, height + 0.25, uv.y) * (1.0 - inBuilding);
  col += paletteRamp(0.45) * above * exp(-(uv.y - height) * 6.0) * level * 0.35;

  float alpha = clamp(dot(col, vec3(0.6)), 0.0, 0.82);
  return vec4(col, alpha);
}
`,
};
