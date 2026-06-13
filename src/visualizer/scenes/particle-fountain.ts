// Particle Fountain — analytic ballistic jets shot from the bottom on kicks
// and from screen edges on hats. Each particle is a gaussian glow whose
// brightness rides its emitter's onset envelope; gravity pulls them down.

import type { SceneDef } from './index';

export const particleFountain: SceneDef = {
  id: 'particle-fountain',
  name: 'Particle Fountain',
  mood: 'high',
  frag: `
const float TAU = 6.28318530718;

float dot2(vec2 v) { return dot(v, v); }

vec3 jetParticle(vec2 p, vec2 src, vec2 v0, float gravity, float life, float t, float rnd, float glow) {
  float age = fract(t + rnd);
  vec2 pos = src + v0 * age * life + vec2(0.0, -gravity) * age * age * life * life;
  float d2 = dot2(p - pos);
  float fall = (1.0 - age);
  float radius = 0.0009 + glow * 0.0085;
  float g = exp(-d2 / radius) * fall * fall;
  float hue = 0.15 + rnd * 0.55 + u_centroid * 0.3;
  return paletteRamp(hue) * g * (0.4 + glow * 1.4);
}

vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float gravity = 1.6 + u_bass * 0.6;
  float seedRot = u_seed * TAU;

  float kickStrength = 0.25 + u_kick * 0.8 + u_kickPulse * 1.1;
  vec2 srcK = vec2(u_pan * 0.55, -1.05);
  for (int i = 0; i < 22; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 13.31 + floor(u_seed * 511.0));
    float ang = mix(0.85, 2.29, rnd) + sin(u_globalTime * 0.4 + fi) * 0.08;
    float speed = 1.1 + rnd * 1.1 + u_bass * 0.8;
    vec2 v0 = vec2(cos(ang), sin(ang)) * speed;
    float life = 0.85 + rnd * 0.4;
    float tt = u_globalTime * (0.45 + rnd * 0.35);
    col += jetParticle(p, srcK, v0, gravity, life, tt, rnd * 7.13, kickStrength);
  }

  float hatStrength = 0.18 + u_hat * 0.6 + u_hatPulse * 1.0;
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 27.7 + floor(u_seed * 197.0) + 4.7);
    float side = (rnd < 0.5) ? -1.0 : 1.0;
    float h = mix(-0.4, 0.95, hash11(fi * 9.11 + u_seed * 3.0));
    vec2 src = vec2(side * 1.35, h);
    float baseAng = (side < 0.0) ? 0.25 : 2.89;
    float ang = baseAng + (rnd - 0.5) * 0.9 + sin(u_globalTime * 0.7 + fi * 1.3) * 0.12;
    float speed = 0.9 + rnd * 0.9 + u_hat * 0.7;
    vec2 v0 = vec2(cos(ang), sin(ang)) * speed;
    float life = 0.7 + rnd * 0.4;
    float tt = u_globalTime * (0.55 + rnd * 0.4) + seedRot * 0.1;
    col += jetParticle(p, src, v0, gravity * 0.65, life, tt, rnd * 11.7, hatStrength);
  }

  float snareSwirl = u_snarePulse * 0.9;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    float rnd = hash11(fi * 41.7 + floor(u_seed * 71.0) + 9.3);
    float ang = rnd * TAU + u_globalTime * (0.6 + rnd * 0.4);
    float r = 0.4 + 0.35 * sin(u_globalTime * 0.9 + fi);
    vec2 src = vec2(cos(ang), sin(ang)) * r * (0.7 + snareSwirl);
    vec2 v0 = vec2(-sin(ang), cos(ang)) * (0.6 + rnd * 0.5);
    float life = 0.6 + rnd * 0.3;
    float tt = u_globalTime * (0.7 + rnd * 0.5);
    col += jetParticle(p, src, v0, gravity * 0.3, life, tt, rnd * 5.7, 0.2 + u_snare * 0.6 + snareSwirl);
  }

  float floorMist = u_energy * smoothstep(-1.0, -1.4, p.y) * 0.12;
  col += paletteRamp(0.7) * floorMist;

  float alpha = clamp(dot(col, vec3(0.5)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
