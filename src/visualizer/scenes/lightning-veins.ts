// Branching electric bolts strike on snare/kick impulses; layered fbm-warped
// polylines with hot white cores and a cold theme-tinted glow.

import type { SceneDef } from './index';

export const lightningVeins: SceneDef = {
  id: 'lightning-veins',
  name: 'Lightning Veins',
  mood: 'high',
  frag: `
const float LV_TAU = 6.28318530718;

float voltCurve(vec2 q, float seed, float t, float jitter) {
  // Distance from p to a vertical-ish bolt whose x is warped by fbm.
  float warp = fbm(vec2(q.y * 1.7 + seed * 13.0, t * 0.6 + seed * 5.1));
  float branch = fbm(vec2(q.y * 4.3 + seed * 91.0, t * 1.4)) - 0.5;
  float ox = (warp - 0.5) * (0.55 + jitter) + branch * (0.25 + jitter * 0.8);
  return abs(q.x - ox);
}

vec4 scene(vec2 uv, vec2 p) {
  // Seed-driven bolt count (3..6) and base rotation.
  float boltsF = floor(3.0 + hash11(u_seed * 17.3) * 4.0);
  float rotA = (u_seed - 0.5) * 1.1 + u_beatPhase * 0.6;
  vec2 q = rot2(rotA) * p;

  // Strike envelope: snare/kick impulses pump brightness, decays with time.
  float strike = clamp(u_snarePulse * 1.2 + u_kickPulse * 0.9, 0.0, 1.6);
  float ambient = 0.18 + u_energy * 0.55;

  vec3 col = vec3(0.0);
  float coreSum = 0.0;

  for (int i = 0; i < 6; i++) {
    if (float(i) >= boltsF) break;
    float fi = float(i);
    float seed = u_seed * 311.0 + fi * 47.91;
    float xc = (hash11(seed) - 0.5) * 2.6;
    float t = u_globalTime * (0.7 + hash11(seed + 3.1) * 1.6);
    // Re-seed bolt path on strong impulses for "new bolt" feel.
    float jolt = step(0.55, u_snarePulse) * floor(u_globalTime * 4.0);
    float jitter = u_crest * 0.6 + jolt * 0.0;
    vec2 lq = q - vec2(xc, 0.0);
    float d = voltCurve(lq, seed + jolt * 13.0, t, jitter);

    float band = bandAvg(int(mod(fi * 3.0, 22.0)), int(mod(fi * 3.0 + 3.0, 23.0)));
    float thickness = 0.004 + band * 0.012 + strike * 0.018;
    float glow = exp(-d * (5.0 + 8.0 / (thickness + 0.01))) * (ambient + strike * 1.3);
    float core = smoothstep(thickness, 0.0, d) * (0.5 + strike * 1.4);

    float hueT = clamp(0.55 + u_centroid * 0.4 - fi * 0.05, 0.0, 1.0);
    vec3 boltTint = paletteRamp(hueT);
    col += boltTint * glow * 0.55;
    coreSum += core;
  }

  // Hot white cores burn over the cold tint.
  vec3 hotCore = mix(u_light, vec3(1.0), 0.6);
  col += hotCore * coreSum;

  // Ground/sky flash on snare strike — very brief full-frame brighten.
  float flash = u_snarePulse * u_snarePulse * 0.18;
  col += paletteRamp(0.95) * flash;

  // Subtle sparkle dust in the air.
  float sp = hash21(floor(uv * 220.0) + floor(u_globalTime * 30.0));
  col += vec3(1.0) * step(0.997, sp) * u_hatPulse * 0.5;

  float alpha = clamp(dot(col, vec3(0.55)) + coreSum * 0.4, 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
