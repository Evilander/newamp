// Constellation — 20 seeded star points twinkle with their bands; nearby
// pairs draw thin edges that brighten on the beat. Occasional shooting star
// crosses the sky on snare pulses. Elegant, mostly dark, MilkDrop visible.

import type { SceneDef } from './index';

export const constellation: SceneDef = {
  id: 'constellation',
  name: 'Constellation',
  mood: 'calm',
  frag: `
const int N = 20;

vec2 starPos(int i, float t) {
  float fi = float(i);
  float rnd = hash11(fi * 11.1 + floor(u_seed * 877.0));
  float rnd2 = hash11(fi * 27.9 + floor(u_seed * 233.0) + 5.0);
  vec2 base = vec2(rnd, rnd2) * 2.0 - 1.0;
  base.x *= 1.25;
  base += vec2(sin(t * (0.07 + rnd * 0.05) + fi), cos(t * (0.06 + rnd2 * 0.05) + fi * 1.3)) * 0.05;
  return base;
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * h);
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float t = u_globalTime;

  float beatWin = 1.0 - smoothstep(0.0, 0.35, u_beatPhase);
  beatWin = mix(0.25, 1.0, beatWin) * (0.4 + u_beatConf * 0.6);

  vec2 pos[N];
  float bright[N];
  for (int i = 0; i < N; i++) {
    pos[i] = starPos(i, t);
    int bandIdx = int(mod(float(i) * 1.2, 24.0));
    float level = 0.0;
    for (int b = 0; b < 24; b++) { if (b == bandIdx) level = u_bands[b]; }
    float tw = 0.5 + 0.5 * sin(t * (1.7 + hash11(float(i) * 3.3) * 4.0) + float(i));
    bright[i] = 0.12 + level * 1.3 + tw * 0.15 + u_vocal * 0.1;
  }

  for (int i = 0; i < N; i++) {
    float d = length(p - pos[i]);
    float core = exp(-d * d * 700.0);
    float halo = exp(-d * d * 45.0) * 0.16;
    float hue = 0.45 + float(i) * 0.02 + u_centroid * 0.25;
    col += paletteRamp(hue) * (core * bright[i] + halo * bright[i] * 0.6);
  }

  for (int i = 0; i < N; i++) {
    for (int j = 0; j < N; j++) {
      if (j <= i) continue;
      vec2 a = pos[i];
      vec2 b = pos[j];
      float dAB = length(a - b);
      if (dAB > 0.55) continue;
      float dline = segDist(p, a, b);
      float line = smoothstep(0.0035, 0.0, dline);
      float w = (1.0 - dAB / 0.55);
      float lvl = (bright[i] + bright[j]) * 0.5;
      col += paletteRamp(0.6) * line * w * lvl * beatWin * 0.4;
    }
  }

  float shootRnd = hash11(floor(u_globalTime * 0.5) + floor(u_seed * 101.0));
  float shootProg = fract(u_globalTime * 0.5);
  vec2 shootStart = vec2(-1.2, mix(-0.4, 0.9, shootRnd));
  vec2 shootEnd = vec2(1.2, mix(-0.6, 0.7, hash11(shootRnd * 9.7)));
  vec2 shootPos = mix(shootStart, shootEnd, shootProg);
  vec2 shootDir = normalize(shootEnd - shootStart);
  vec2 sp = p - shootPos;
  float along = dot(sp, shootDir);
  float across = length(sp - shootDir * along);
  float tail = smoothstep(0.0, -0.25, along) * step(along, 0.0);
  float shootHead = exp(-dot(sp, sp) * 200.0);
  float shootGlow = (shootHead + tail * exp(-across * across * 1200.0) * 0.7) *
                    u_snarePulse * (0.6 + u_energy * 0.6);
  col += paletteRamp(0.95) * shootGlow;

  float alpha = clamp(dot(col, vec3(0.65)), 0.0, 0.7);
  return vec4(col, alpha);
}
`,
};
