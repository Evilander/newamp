// Silky ribbons advected along a curl-noise flow field — 4 winding paths,
// width pumps with vocal, speed with energy, heads sparkle on snare/hat onsets.

import type { SceneDef } from './index';

export const ribbonFlow: SceneDef = {
  id: 'ribbon-flow',
  name: 'Ribbon Flow',
  mood: 'mid',
  frag: `
const float TAU_RIB = 6.28318530718;

// Curl-ish 2D velocity from rotated fbm gradients (cheap pseudo curl).
vec2 flowField(vec2 q, float t) {
  float e = 0.18;
  float n1 = fbm(q + vec2(t * 0.21, -t * 0.13));
  float n2 = fbm(q + vec2(-t * 0.17, t * 0.24) + 11.7);
  float dx = fbm(q + vec2(e, 0.0) + vec2(t * 0.21, -t * 0.13)) - n1;
  float dy = fbm(q + vec2(0.0, e) + vec2(-t * 0.17, t * 0.24) + 11.7) - n2;
  return vec2(dy, -dx) / e;
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float seedOff = u_seed * 71.0;
  float speed = 0.35 + u_energy * 1.2 + u_kickPulse * 0.8;

  // 4 ribbons. Each marches a fixed-step polyline along the flow field,
  // accumulating a smooth distance to p.
  for (int r = 0; r < 4; r++) {
    float fr = float(r);
    float rnd = hash11(fr * 23.7 + seedOff);
    float ang = rnd * TAU_RIB + u_globalTime * 0.07 * (rnd - 0.5);
    vec2 head = vec2(cos(ang), sin(ang)) * (0.4 + rnd * 0.4)
              + vec2(sin(u_globalTime * (0.13 + rnd * 0.09) + fr) * 0.2,
                     cos(u_globalTime * (0.11 + rnd * 0.08) + fr * 1.3) * 0.2);

    float widthBase = 0.022 + rnd * 0.018;
    float width = widthBase + u_vocal * 0.04 + u_vocalPulse * 0.05;
    float minD = 1e3;
    float headD = 1e3;
    float tailFade = 1.0;
    vec2 pos = head;
    float t0 = u_globalTime * speed * (0.6 + rnd * 0.4) + fr * 3.7;

    // 22 segments — constant bound, modest cost. Step length scales with width.
    for (int s = 0; s < 22; s++) {
      float fs = float(s);
      vec2 v = flowField(pos * 1.4 + fr * 5.1 + seedOff, t0);
      pos += normalize(v + vec2(1e-4)) * (0.06 + rnd * 0.02);
      float d = length(p - pos);
      // Taper toward tail so ribbons look like trailing silk.
      float taper = 1.0 - fs / 22.0;
      float locW = width * (0.35 + 0.65 * taper);
      float contrib = smoothstep(locW, 0.0, d);
      minD = min(minD, d / max(locW, 1e-3));
      if (fs < 1.5) headD = min(headD, d);
      col += paletteRamp(0.3 + rnd * 0.4 + u_centroid * 0.25 + fs * 0.01) * contrib * (0.12 + taper * 0.18);
      tailFade *= 0.97;
    }

    // Head glow — punched by snare/hat onsets.
    float headGlow = exp(-headD * headD * (90.0 - u_snarePulse * 30.0));
    col += paletteRamp(0.85) * headGlow * (0.25 + u_snarePulse * 0.7 + u_hatPulse * 0.5);
  }

  // Soft vignette so ribbons feel suspended in the field.
  float vig = smoothstep(1.5, 0.6, length(p));
  col *= 0.6 + vig * 0.4;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
