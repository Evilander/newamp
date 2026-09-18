// Central morphing superformula curve — exponents drift between seeded
// targets driven by novelty, scale pumps on bass, point count shimmers with
// spectral centroid. Reads as living sacred geometry.

import type { SceneDef } from './index';

export const supershapePulse: SceneDef = {
  id: 'supershape-pulse',
  name: 'Supershape Pulse',
  mood: 'any',
  frag: `
const float TAU = 6.28318530718;

float superR(float phi, float m, float n1, float n2, float n3) {
  float t1 = pow(abs(cos(m * phi * 0.25)), n2);
  float t2 = pow(abs(sin(m * phi * 0.25)), n3);
  return pow(max(t1 + t2, 1e-4), -1.0 / max(n1, 0.05));
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = floor(u_seed * 521.0);
  float driftA = hash11(seedOff + 1.0);
  float driftB = hash11(seedOff + 2.7);
  float driftC = hash11(seedOff + 5.3);

  // Two target parameter sets; novelty selects between them.
  float targetT = 0.5 + 0.5 * sin(u_globalTime * 0.07 + u_novelty * 6.0 + driftA * 10.0);
  float mA = floor(3.0 + driftA * 9.0);
  float mB = floor(3.0 + driftB * 9.0);
  float m = mix(mA, mB, targetT) + floor(u_centroid * 4.0);
  float n1 = mix(0.4 + driftA * 1.6, 0.4 + driftB * 1.6, targetT);
  float n2 = mix(0.5 + driftB * 4.0, 0.5 + driftC * 4.0, targetT);
  float n3 = mix(0.5 + driftC * 4.0, 0.5 + driftA * 4.0, targetT);

  vec2 q = rot2(u_globalTime * 0.18 + u_beatPhase * TAU * 0.05) * p;
  float r = length(q);
  float phi = atan(q.y, q.x);

  float pump = 0.45 + u_bass * 0.18 + u_kickPulse * 0.08;
  float rShape = superR(phi, m, n1, n2, n3) * pump;

  float d = r - rShape;
  float outline = smoothstep(0.012, 0.0, abs(d)) *
                  (0.7 + u_vocal * 0.5 + u_kickPulse * 0.6);
  float fill = smoothstep(0.0, -0.18, d) * (0.18 + u_energy * 0.45);

  // Echo rings — fainter copies of the shape pulsing outward.
  float echoes = 0.0;
  for (int i = 1; i < 4; i++) {
    float fi = float(i);
    float rOff = rShape * (1.0 + fi * 0.18 + u_bass * 0.08);
    float dE = abs(r - rOff);
    echoes += smoothstep(0.008 + fi * 0.004, 0.0, dE) * (0.35 / fi) *
              (0.4 + u_hat * 0.5);
  }

  // Inner filigree — fbm rosette spinning with beat phase.
  float spin = u_beatPhase * TAU;
  vec2 fp = rot2(spin) * q * (3.0 + u_seed * 2.0);
  float n = fbm(fp + vec2(u_globalTime * 0.2, -u_globalTime * 0.17));
  float filigree = smoothstep(0.5, 0.7, n) *
                   smoothstep(rShape * 0.92, 0.0, r) *
                   (0.18 + u_vocalPulse * 0.4);

  // Point shimmer along the curve — count rises with centroid.
  float pts = floor(24.0 + u_centroid * 64.0);
  float ptPhase = fract(phi / TAU * pts + u_globalTime * 0.3);
  float pt = smoothstep(0.92, 1.0, ptPhase) * smoothstep(0.018, 0.0, abs(d)) *
             (0.5 + u_hatPulse * 0.5);

  vec3 outlineCol = paletteRamp(0.85);
  vec3 fillCol = paletteRamp(0.28 + u_centroid * 0.35);
  vec3 echoCol = paletteRamp(0.55);
  vec3 ptCol = paletteRamp(0.98);

  vec3 col = outlineCol * outline;
  col += fillCol * fill;
  col += echoCol * echoes;
  col += fillCol * filigree;
  col += ptCol * pt;

  // Soft halo over the whole shape on kick.
  float halo = smoothstep(rShape * 1.6, 0.0, r) * u_kickPulse * 0.18;
  col += outlineCol * halo;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
