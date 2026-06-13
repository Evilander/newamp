// Comet Trails — 7 lissajous comets, each with a 10-sample analytic trail of
// gaussian dots whose weight decays back along the path. Trails stretch with
// energy; vocal pulses flare the heads. Faint parallax star dust behind.

import type { SceneDef } from './index';

export const cometTrails: SceneDef = {
  id: 'comet-trails',
  name: 'Comet Trails',
  mood: 'mid',
  frag: `
const float TAU = 6.28318530718;
const int  TRAIL = 10;

vec2 lissajous(float t, float a, float b, float pa, float pb, vec2 amp) {
  return vec2(sin(t * a + pa) * amp.x, sin(t * b + pb) * amp.y);
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);

  float dust = vnoise(p * 14.0 + vec2(u_globalTime * 0.04, 0.0)) *
               vnoise(p * 4.0 - vec2(0.0, u_globalTime * 0.02));
  dust = pow(dust, 5.0);
  col += paletteRamp(0.55) * dust * (0.12 + u_energy * 0.25);

  float trailLen = 0.4 + u_energy * 1.4 + u_vocalPulse * 0.6;
  float flare = 1.0 + u_vocalPulse * 1.6;

  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 19.7 + floor(u_seed * 613.0));
    float rnd2 = hash11(fi * 31.3 + floor(u_seed * 211.0) + 7.0);

    float a = 1.0 + floor(rnd * 3.0);
    float b = 1.0 + floor(rnd2 * 3.0);
    if (abs(a - b) < 0.5) b += 1.0;
    float pa = rnd * TAU;
    float pb = rnd2 * TAU + u_seed;
    vec2 amp = vec2(0.85 + rnd * 0.25, 0.65 + rnd2 * 0.25);
    float speed = 0.35 + rnd * 0.45 + u_energy * 0.25;
    float t = u_globalTime * speed + fi * 1.7;

    int bandIdx = int(mod(fi * 3.0, 24.0));
    float level = 0.0;
    for (int bi = 0; bi < 24; bi++) { if (bi == bandIdx) level = u_bands[bi]; }

    vec3 tint = paletteRamp(0.25 + rnd * 0.5 + u_centroid * 0.2);

    for (int s = 0; s < TRAIL; s++) {
      float fs = float(s);
      float back = fs * 0.05 * trailLen;
      vec2 pos = lissajous(t - back, a, b, pa, pb, amp);
      float w = 1.0 - fs / float(TRAIL);
      float r2 = dot(p - pos, p - pos);
      float dot1 = exp(-r2 * (60.0 + fs * 40.0));
      float bright = w * w * (0.4 + level * 1.2);
      col += tint * dot1 * bright * ((s == 0) ? flare : 1.0);
    }
  }

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
