// Orbit Swarm — 32 firefly motes ride seeded elliptical orbits around the
// center, one per band pair. Brightness tracks each firefly's band; the
// whole swarm scatters outward on snare pulses then recoheres.

import type { SceneDef } from './index';

export const orbitSwarm: SceneDef = {
  id: 'orbit-swarm',
  name: 'Orbit Swarm',
  mood: 'mid',
  frag: `
const float TAU = 6.28318530718;

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float scatter = u_snarePulse * 0.55 + u_kickPulse * 0.25;
  float precess = u_globalTime * (0.07 + u_energy * 0.12);
  vec2 center = vec2(u_pan * 0.25, sin(u_globalTime * 0.21) * 0.08);

  for (int i = 0; i < 32; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 17.31 + floor(u_seed * 991.0));
    float rnd2 = hash11(fi * 9.77 + floor(u_seed * 311.0) + 3.1);

    int bandIdx = int(mod(fi * 0.75, 24.0));
    float level = 0.0;
    for (int b = 0; b < 24; b++) { if (b == bandIdx) level = u_bands[b]; }

    float a = 0.32 + rnd * 0.55;
    float b = a * (0.55 + rnd2 * 0.4);
    float speed = 0.28 + rnd * 0.55 + u_energy * 0.3;
    float phase = rnd * TAU + u_globalTime * speed * ((rnd2 < 0.5) ? 1.0 : -1.0);
    float tilt = rnd2 * TAU + precess * (0.5 + rnd);

    vec2 orb = vec2(a * cos(phase), b * sin(phase));
    orb = rot2(tilt) * orb;
    orb *= 1.0 + scatter * (0.6 + rnd);
    orb += center;

    float d = length(p - orb);
    float core = exp(-d * d * 320.0);
    float halo = exp(-d * d * 22.0) * 0.18;
    float bright = 0.18 + level * 1.6 + u_vocal * 0.25;

    vec3 tint = paletteRamp(0.2 + rnd * 0.45 + level * 0.35 + u_centroid * 0.15);
    col += tint * (core * bright + halo * (0.4 + level));
  }

  float dust = (fbm(p * 3.5 + vec2(u_globalTime * 0.08, 0.0)) - 0.5) * 0.05 * u_energy;
  col += paletteRamp(0.5) * max(dust, 0.0);

  float centerGlow = exp(-dot(p - center, p - center) * 18.0) * (0.05 + u_bass * 0.18);
  col += paletteRamp(0.85) * centerGlow;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.75);
  return vec4(col, alpha);
}
`,
};
