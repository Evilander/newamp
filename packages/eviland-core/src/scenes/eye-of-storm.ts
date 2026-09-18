// Rotating vortex: fbm cloud spiral arms orbit a calm dark eye; lightning
// flickers inside the clouds on snares, the eye contracts on kicks.

import type { SceneDef } from './index';

export const eyeOfStorm: SceneDef = {
  id: 'eye-of-storm',
  name: 'Eye of the Storm',
  mood: 'high',
  frag: `
const float ES_TAU = 6.28318530718;

vec4 scene(vec2 uv, vec2 p) {
  // 3..7 arms, seed-driven.
  float armsF = floor(3.0 + hash11(u_seed * 7.7) * 5.0);
  // Angular velocity rides energy + small beat-locked term.
  float omega = 0.25 + u_energy * 1.2 + u_beatPhase * 0.4;
  float spin = u_globalTime * omega;

  float r = length(p);
  float th = atan(p.y, p.x);

  // Eye radius — contracts on kick.
  float eyeR = 0.30 - u_kickPulse * 0.12;
  eyeR = max(eyeR, 0.08);

  // Spiral coordinate: theta + log(r) gives logarithmic spiral arms.
  float spiral = th + log(max(r, 0.02)) * 1.6 + spin;
  float armPhase = cos(spiral * armsF) * 0.5 + 0.5;

  // Cloud body via fbm in rotating frame.
  vec2 q = rot2(spin * 0.3) * p;
  float cloud = fbm(q * 2.5 + vec2(u_globalTime * 0.2, 0.0));
  cloud = pow(cloud, 1.4);

  // Combine cloud with arm modulation; weaker beyond eye, fades at outer rim.
  float radialMask = smoothstep(eyeR, eyeR + 0.05, r) * smoothstep(1.7, 0.7, r);
  float clouds = cloud * (0.4 + armPhase * 0.9) * radialMask;

  // Debris streaks — tangential fbm following spiral lines.
  float streakCoord = spiral * 6.0;
  float streak = vnoise(vec2(streakCoord, r * 12.0 - spin * 2.0));
  streak = smoothstep(0.55, 1.0, streak) * radialMask;
  clouds += streak * (0.4 + u_bass * 0.6);

  // Theme tint for clouds; centroid steers the hue along the ramp.
  vec3 cloudTint = paletteRamp(0.35 + u_centroid * 0.4);
  vec3 col = cloudTint * clouds * (0.55 + u_energy * 0.6);

  // Lightning flicker inside the storm body on snare pulses.
  float lightning = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float seed = u_seed * 41.0 + fi * 19.3 + floor(u_globalTime * 8.0);
    float lx = (hash11(seed) - 0.5) * 1.8;
    float ly = (hash11(seed + 1.7) - 0.5) * 1.6;
    float ld = length(p - vec2(lx, ly));
    lightning += exp(-ld * 14.0) * step(0.55, u_snarePulse) * hash11(seed + 3.3);
  }
  col += vec3(1.0) * lightning * 0.6 * radialMask;

  // The eye itself — calm dark, slight rim halo.
  float inEye = smoothstep(eyeR + 0.02, eyeR - 0.02, r);
  // Dim wash inside the eye.
  col = mix(col, u_dark * 0.4, inEye * 0.85);
  // Eye rim halo: bright on kicks.
  float rim = smoothstep(0.03, 0.0, abs(r - eyeR)) * (0.3 + u_kickPulse * 1.2);
  col += paletteRamp(0.9) * rim;

  // Outer vignette.
  float vig = smoothstep(1.8, 0.5, r);
  col *= vig;

  // Hat sparkles in the cloud body.
  float sg = hash21(floor(uv * 200.0) + floor(u_globalTime * 30.0));
  col += vec3(1.0) * step(0.995, sg) * radialMask * u_hatPulse * 0.5;

  float alpha = clamp(dot(col, vec3(0.55)) + rim * 0.4 + lightning * 0.5, 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
