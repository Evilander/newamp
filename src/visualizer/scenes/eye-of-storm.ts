// Rotating vortex: fbm cloud spiral arms orbit a calm dark eye; lightning
// flickers inside the clouds on snares, the eye contracts on kicks.

import type { SceneDef } from './index';

export const eyeOfStorm: SceneDef = {
  id: 'eye-of-storm',
  name: 'Eye of the Storm',
  mood: 'high',
  speed: f => 0.25 + f.energy * 1.2,
  frag: `
const float ES_TAU = 6.28318530718;
// Streak cells round one turn: about 6 per radian, as a whole number so the
// noise below can repeat exactly.
const float ES_STREAKS = 38.0;

// Value noise whose lattice repeats every ES_STREAKS cells along x.
float esWrapNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, ES_STREAKS), x1 = mod(i.x + 1.0, ES_STREAKS);
  return mix(mix(hash21(vec2(x0, i.y)), hash21(vec2(x1, i.y)), u.x),
             mix(hash21(vec2(x0, i.y + 1.0)), hash21(vec2(x1, i.y + 1.0)), u.x), u.y);
}

vec4 scene(vec2 uv, vec2 p) {
  // 3..7 arms, seed-driven.
  float armsF = floor(3.0 + hash11(u_seed * 7.7) * 5.0);
  // The spin rate rides energy (the speed hook integrates it into u_phase);
  // the beat adds a bounded wobble instead of a rate.
  float spin = u_phase + 0.12 * sin(u_beatPhase * ES_TAU);

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
  // The angle jumps by a full turn at the negative x axis, so the noise along
  // it has to repeat after one turn (ES_STREAKS cells) or it leaves a seam.
  float streak = esWrapNoise(vec2(spiral / ES_TAU * ES_STREAKS, r * 12.0 - spin * 2.0));
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
  col += mix(u_light, vec3(1.0), 0.35) * lightning * 0.6 * radialMask;

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
  col += mix(u_light, vec3(1.0), 0.35) * step(0.995, sg) * radialMask * u_hatPulse * 0.5;

  float alpha = clamp(dot(col, vec3(0.55)) + rim * 0.4 + lightning * 0.5, 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
