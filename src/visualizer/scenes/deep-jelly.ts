// Deep Jelly — a bioluminescent jellyfish drifting in the abyss. Its bell
// pulses with the bass envelope, tentacles trail as sine strands lit from
// within, and vocal phrases send glow rippling down them. Marine snow drifts
// past for depth. Built for the calm tier — the quiet scene that breathes.

import type { SceneDef } from './index';

export const deepJelly: SceneDef = {
  id: 'deep-jelly',
  name: 'Deep Jelly',
  mood: 'calm',
  frag: `
const float TAU = 6.28318530718;

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);

  // The jelly drifts in a slow lissajous around center.
  vec2 c = vec2(sin(u_globalTime * 0.11 + u_seed * TAU) * 0.25,
                cos(u_globalTime * 0.07 + u_seed * 9.0) * 0.18 + 0.15);
  vec2 q = p - c;

  // Bell: a dome whose radius breathes with bass; squash on the pulse so it
  // swims rather than inflates.
  float breath = 0.30 + u_bass * 0.10 + sin(u_globalTime * 0.9) * 0.02;
  vec2 squash = vec2(1.0, 1.0 - u_kickPulse * 0.18 - u_bass * 0.08);
  float rBell = length(q * squash / breath);
  float bellMask = smoothstep(1.0, 0.72, rBell) * step(q.y, 0.35);

  // Internal glow: hot at the crown, translucent at the rim.
  vec3 glow = paletteRamp(0.55 + u_centroid * 0.25);
  col += glow * bellMask * (0.20 + u_energy * 0.30) * (1.2 - rBell);
  // Rim light so the bell reads against the dark.
  float rim = smoothstep(0.82, 1.0, rBell) * smoothstep(1.08, 0.98, rBell);
  col += paletteRamp(0.8) * rim * (0.25 + u_vocal * 0.5) * step(q.y, 0.3);

  // Tentacles: 7 sine strands falling from the bell, phase-offset, glowing
  // brighter where a vocal ripple travels down them.
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 23.1 + floor(u_seed * 311.0));
    float x0 = (fi / 6.0 - 0.5) * 0.42 * breath * 2.0;
    float sway = sin(q.y * (3.0 + rnd * 2.0) + u_globalTime * (0.8 + rnd * 0.6) + rnd * TAU) * 0.10;
    float d = abs(q.x - x0 - sway * (0.2 - q.y));
    float below = smoothstep(0.05, -0.02, q.y) * smoothstep(-1.35, -0.6, q.y);
    float strand = exp(-d * d * 2600.0) * below;
    // Ripple: a bright packet moving down the strand on vocal pulses.
    float packet = exp(-pow(mod(-q.y * 1.4 - u_globalTime * 0.9 + rnd * 3.0, 3.0) - 0.4, 2.0) * 22.0);
    col += paletteRamp(0.4 + rnd * 0.3) * strand * (0.10 + packet * (0.15 + u_vocalPulse * 0.8));
  }

  // Marine snow: sparse drifting motes, parallax two layers.
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    vec2 g = p * (5.0 + fl * 4.0) + vec2(0.0, u_globalTime * (0.05 + fl * 0.04));
    vec2 cellId = floor(g);
    vec2 f = fract(g) - 0.5 - (hash22(cellId) - 0.5) * 0.6;
    float mote = exp(-dot(f, f) * 240.0) * step(0.82, hash21(cellId + fl * 17.0));
    col += vec3(0.5, 0.62, 0.7) * mote * (0.05 + u_energy * 0.05);
  }

  // Abyss gradient — barely-there blue so the black has depth.
  col += paletteRamp(0.1) * (1.0 - uv.y) * 0.03;

  float alpha = clamp(dot(col, vec3(0.6)), 0.0, 0.7);
  return vec4(col, alpha);
}
`,
};
