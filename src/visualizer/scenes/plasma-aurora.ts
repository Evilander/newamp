// Aurora borealis curtains — vertical fbm-warped light sheets sweeping the
// upper sky, brightness on mids, hue drifting through the theme, hat-pulse
// sparkle stars sprinkled high.

import type { SceneDef } from './index';

export const plasmaAurora: SceneDef = {
  id: 'plasma-aurora',
  name: 'Plasma Aurora',
  mood: 'calm',
  frag: `
const float TAU_AUR = 6.28318530718;

float curtainShape(vec2 q, float warp) {
  float n = fbm(q * vec2(0.55, 0.18) + vec2(warp, q.y * 0.4));
  return n;
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);

  // Sky bias — favor the top third.
  float sky = smoothstep(-0.95, 0.6, p.y);
  float topMask = smoothstep(-0.2, 0.95, p.y);

  float mids = bandAvg(8, 16);
  float lows = bandAvg(2, 7);
  float drift = u_globalTime * (0.05 + u_energy * 0.18);
  float seedOff = u_seed * 53.0;

  // Three to five curtains; sway slowly, warp horizontally via fbm.
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 9.31 + seedOff);
    float baseX = -1.4 + fi * 0.7 + (rnd - 0.5) * 0.8;
    float sway = sin(u_globalTime * (0.11 + rnd * 0.07) + rnd * TAU_AUR) * 0.28;
    float xc = baseX + sway;

    // Horizontal displacement of the curtain axis using fbm vs height.
    float warp = drift * (0.6 + rnd * 0.4) + fi * 1.7;
    float warpAmt = 0.18 + mids * 0.35 + u_vocal * 0.12;
    float disp = (fbm(vec2(p.y * 1.6 + warp, fi * 3.1 + seedOff)) - 0.5) * warpAmt;

    float dx = p.x - (xc + disp);
    float thickness = 0.045 + rnd * 0.06 + mids * 0.05;
    float core = exp(-dx * dx / (thickness * thickness));

    // Vertical falloff: curtains hang from the top, taper down.
    float vfade = smoothstep(-0.4, 0.95, p.y) * smoothstep(1.2, -0.1, p.y);

    // Filament detail along the curtain edge.
    float filam = fbm(vec2(dx * 22.0, p.y * 9.0 + warp * 2.0));
    float edge = smoothstep(0.42, 0.78, filam) * (1.0 - smoothstep(0.0, thickness * 1.8, abs(dx))) * 0.55;

    float bright = (0.18 + lows * 0.45 + mids * 0.95 + u_vocalPulse * 0.4) * (0.55 + rnd * 0.6);
    float lit = (core * 0.9 + edge) * vfade * bright;

    float hue = 0.18 + fi * 0.13 + u_centroid * 0.4 + rnd * 0.15;
    vec3 tint = paletteRamp(hue);
    col += tint * lit;
  }

  // Beat-locked subtle global pulse — auroras intensify on phrase boundaries.
  float phasePulse = 0.5 + 0.5 * cos(u_beatPhase * TAU_AUR);
  col *= 0.85 + phasePulse * u_beatConf * 0.25;

  // High starfield sparkles, kicked by hat impulses.
  vec2 sg = floor(uv * vec2(120.0, 70.0) + vec2(seedOff, 0.0));
  float starRnd = hash21(sg);
  float starTwk = 0.5 + 0.5 * sin(u_globalTime * (2.0 + starRnd * 6.0) + starRnd * 17.0);
  float starGate = step(0.985 - u_hatPulse * 0.05, starRnd);
  float starLit = starGate * starTwk * topMask * (0.35 + u_hatPulse * 0.9);
  col += u_light * starLit * 0.6;

  // Faint horizon glow tied to bass — anchors the curtains.
  float horizon = smoothstep(0.35, -0.7, p.y) * (0.04 + lows * 0.18);
  col += paletteRamp(0.55) * horizon;

  col *= sky * 0.6 + 0.4;

  float alpha = clamp(dot(col, vec3(0.5)), 0.0, 0.72);
  return vec4(col, alpha);
}
`,
};
