// Concentric solid rings racing toward the camera in 1/r perspective; a new
// ring spawns on each kick, ring thickness from bass, rotation locked to beat.

import type { SceneDef } from './index';

export const tunnelRings: SceneDef = {
  id: 'tunnel-rings',
  name: 'Tunnel Rings',
  mood: 'high',
  frag: `
const float TR_TAU = 6.28318530718;

vec4 scene(vec2 uv, vec2 p) {
  // Rotate the whole tunnel slowly with beat phase + seed offset.
  float ang = u_beatPhase * TR_TAU * 0.25 + u_seed * TR_TAU + u_globalTime * 0.08;
  vec2 q = rot2(ang) * p;
  float r = length(q);
  float th = atan(q.y, q.x);

  // Perspective: z = 1/r maps near=center bright to far=edge faint.
  // Ring "depth" coordinate; rings march outward (toward viewer) over time.
  float speed = 0.5 + u_energy * 1.4 + u_kickPulse * 1.2;
  float kickStamp = floor(u_globalTime * (1.0 + u_energy * 2.0)) + step(0.5, u_kickPulse) * 999.0;
  float depth = log(max(r, 0.02)) * 1.6 + u_globalTime * speed;
  float ring = fract(depth);
  float idx = floor(depth);

  // Per-ring randomness — seeded, with a kick stamp so new rings differ.
  float rnd = hash11(idx * 3.71 + u_seed * 117.0 + kickStamp * 0.013);
  float bandLo = mod(rnd * 18.0, 18.0);
  float band = bandAvg(int(bandLo), int(bandLo) + 4);

  // Ring thickness pulses with bass; some rings are doubled (bright + dim).
  float thick = 0.18 + u_bass * 0.4 + rnd * 0.1;
  float profile = smoothstep(thick, 0.0, abs(ring - 0.5) * 2.0);

  // Angular detail — striations rotate per ring, snap on kicks.
  float stripes = 6.0 + floor(rnd * 18.0);
  float stripe = 0.5 + 0.5 * cos(th * stripes + idx * 1.7 + u_kickPulse * 3.0);
  profile *= mix(0.5, 1.0, stripe);

  // Depth fog: faint at far (large depth offset), bright when near (small r).
  float fog = exp(-r * 1.1);
  float nearBoost = smoothstep(0.0, 0.6, 1.0 - r);

  float hueT = clamp(0.25 + rnd * 0.5 + u_centroid * 0.3 + band * 0.2, 0.0, 1.0);
  vec3 tint = paletteRamp(hueT);

  vec3 col = tint * profile * (0.35 + band * 0.7 + u_kickPulse * 0.5) * fog;

  // Central "approaching object" — kicks spawn a bright ring near the eye.
  float spawn = u_kickPulse * smoothstep(0.55, 0.0, r) * 0.6;
  col += paletteRamp(0.95) * spawn;

  // Subtle rim light around very nearest ring.
  col += u_light * nearBoost * 0.08 * profile;

  // Vignette darkens the corners so rings read as a tunnel.
  float vig = smoothstep(1.6, 0.4, r);

  float alpha = clamp(dot(col, vec3(0.6)) * vig + spawn * 0.4, 0.0, 0.78);
  return vec4(col * vig, alpha);
}
`,
};
