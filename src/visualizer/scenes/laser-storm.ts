// Laser Storm — a rig of rotating laser beams cutting through volumetric fog.
// Beams sweep with the music's energy, strobe-flash on snares, and the fog
// they illuminate churns with the bass. Stereo pan leans the whole rig left
// and right like a lighting operator riding the mix.

import type { SceneDef } from './index';

export const laserStorm: SceneDef = {
  id: 'laser-storm',
  name: 'Laser Storm',
  mood: 'high',
  frag: `
const float TAU = 6.28318530718;

// Brightness of a beam through point p, from origin o at angle a.
float beam(vec2 p, vec2 o, float a, float sharp) {
  vec2 dir = vec2(cos(a), sin(a));
  vec2 rel = p - o;
  float along = dot(rel, dir);
  if (along < 0.0) return 0.0;
  float across = abs(rel.x * dir.y - rel.y * dir.x);
  return exp(-across * across * sharp) * exp(-along * 0.55);
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);

  // The rig hangs above the frame; stereo pan slides it sideways.
  vec2 rig = vec2(u_pan * 0.35, 1.15);

  // Fog field the beams will reveal — churned by bass.
  float fog = fbm(p * 2.2 + vec2(u_globalTime * 0.10, -u_globalTime * 0.05));
  fog = 0.35 + 0.65 * fog * (0.7 + u_bass * 0.6);

  float sweep = u_globalTime * (0.5 + u_energy * 0.9);
  float strobe = 1.0 + u_snarePulse * 2.4;

  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 13.7 + floor(u_seed * 733.0));
    // Each beam sweeps its own arc; snare pulses snap them wider.
    float arc = 0.55 + rnd * 0.5 + u_snarePulse * 0.2;
    float ang = -TAU * 0.25 + sin(sweep * (0.6 + rnd * 0.7) + rnd * TAU) * arc;
    float sharp = 2200.0 - u_energy * 1200.0;
    float b = beam(p, rig + vec2((rnd - 0.5) * 0.8, 0.0), ang, sharp);
    vec3 tint = paletteRamp(0.2 + rnd * 0.65);
    col += tint * b * (0.5 + u_energy * 0.8) * strobe * fog;
  }

  // Beam hits on the floor: bright pools where beams land, kicked by kicks.
  float floorLine = smoothstep(-0.98, -0.9, p.y) * step(p.y, -0.82);
  col += paletteRamp(0.7) * floorLine * (0.12 + u_kickPulse * 0.5) * fog;

  // Ambient fog glow so silence still reads as a hazy room.
  col += paletteRamp(0.3) * fog * 0.035;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
