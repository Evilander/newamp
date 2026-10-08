// Radiolaria — plankton skeletons on a dark-field slide. Radiolarians are
// lattice spheres seen from the pole: pores sit in rings of equal latitude,
// so they foreshorten toward the glassy limb, with long radial spines beaded
// at the tips. A centric diatom sits among them: a flat disc of radial pore
// rows, ribs and a thick girdle. Every pore ring is wired to its own band and
// swells and glows with it; ring hues walk the palette as those bands
// accumulate. The skeletons turn slowly with energy; bass breathes the big
// one, hats run light up the spines and flare their tips.

import type { SceneDef } from './index';

export const radiolaria: SceneDef = {
  id: 'radiolaria',
  name: 'Radiolaria',
  mood: 'calm',
  speed: f => 0.1 + f.energy * 0.3,
  frag: `
const float RL_TAU = 6.28318530718;
const float RL_PI = 3.14159265359;

float rlTri(float x) { return abs(fract(x) * 2.0 - 1.0); }

// Pore lattice on a shell: rings of latitude on a sphere (or of radius on a
// flat disc) centred on one pole pore, each ring holding as many pores as its
// circumference fits. Returns x = distance to the nearest pore centre in ring
// units, y = ring index.
vec2 rlPores(float rr, float phi, bool planar, float rings) {
  float theta = planar ? rr : asin(min(rr, 1.0));
  float dTheta = planar ? 1.0 / rings : RL_PI * 0.5 / rings;
  float ri = floor(theta / dTheta + 0.5);
  float thetaC = ri * dTheta;
  float n = floor(RL_TAU * (planar ? thetaC : sin(thetaC)) / dTheta + 0.5);
  float cellA = RL_TAU / max(n, 1.0);
  float ph = phi + mod(ri, 2.0) * cellA * 0.5;
  float phC = (floor(ph / cellA) + 0.5) * cellA;
  float pd = ri < 0.5 ? theta / dTheta
           : length(vec2(theta - thetaC, (planar ? theta : sin(theta)) * (ph - phC))) / dTheta;
  return vec2(pd, ri);
}

// One skeleton centred on q's origin with shell radius R. kind 0 is a
// radiolarian (outer lattice sphere over a counter-rotating inner one), kind
// 1 a centric diatom.
vec3 rlOrganism(vec2 q, float R, float spin, float h, float kind, float life) {
  float rr = length(q) / R;
  float ang = atan(q.y, q.x);
  float phi = ang + spin;
  float aa = 2.0 / (min(u_res.x, u_res.y) * R);
  vec3 col = vec3(0.0);
  bool diatom = kind > 0.5;

  if (rr < 1.03) {
    vec2 pores = rlPores(rr, phi, diatom, diatom ? 9.0 : 7.0);
    float pd = pores.x;
    float ri = pores.y;
    int bi = int(mod(ri * 3.0 + h * 24.0, 24.0));
    float band = u_bands[bi];
    float rho = 0.27 + band * 0.14 * life;
    float hole = smoothstep(rho + 0.06, rho - 0.06, pd);
    float poreRim = exp(-pow((pd - rho) / 0.07, 2.0));
    float hueRing = 0.2 + 0.6 * rlTri(ri * 0.13 + u_bandTime[bi] * 0.04 + h);

    // Glass reads brightest where the line of sight crosses the most of it:
    // at the limb of a sphere, at pore rims, in the diatom's ribs and girdle.
    float z = sqrt(max(1.0 - rr * rr, 0.0));
    float limbL = diatom ? 0.25 : pow(1.0 - z, 1.5);
    float lattice = diatom ? smoothstep(0.88, 0.84, rr) * smoothstep(0.1, 0.18, rr) : smoothstep(1.0, 0.86, rr);
    float shell = smoothstep(1.0, 0.985, rr);
    vec3 glassCol = paletteRamp(0.72 + 0.28 * limbL);
    col += glassCol * ((1.0 - hole) * (0.07 + 0.3 * limbL) + poreRim * 0.35) * lattice * (0.45 + 0.55 * life);
    col += paletteRamp(hueRing) * hole * lattice * (0.03 + band * (0.15 + 0.85 * life));
    col += glassCol * shell * (1.0 - lattice) * (0.12 + 0.3 * life);

    if (diatom) {
      float ribD = abs(fract(phi * 16.0 / RL_TAU + 0.5) - 0.5) * RL_TAU / 16.0 * rr;
      col += glassCol * smoothstep(0.012 + aa, 0.012 - aa, ribD) * step(0.18, rr) * lattice * (0.2 + 0.35 * life);
      col += glassCol * exp(-pow((rr - 0.14) / 0.02, 2.0)) * (0.3 + 0.4 * life);
    } else {
      // The inner shell, turning the other way, seen only through the pores:
      // the two lattices slide past each other like a moire.
      float ri2 = rr / 0.55;
      vec2 inner = rlPores(min(ri2, 1.0), ang - spin * 1.7 + h * 3.0, false, 5.0);
      float innerRim = exp(-pow((inner.x - 0.3) / 0.09, 2.0)) * smoothstep(1.0, 0.9, ri2);
      col += paletteRamp(0.55 + 0.3 * hueRing) * innerRim * hole * lattice * (0.12 + 0.45 * life);
      // The central capsule glows through both.
      col += paletteRamp(0.5) * exp(-rr * rr * 7.0) * hole * lattice * (0.05 + 0.3 * life);
    }
    col += paletteRamp(0.95) * exp(-pow((rr - 1.0) / 0.022, 2.0)) * (0.25 + 0.5 * life);
  }

  // Spines: radial, tapered, noded along their length, of scattered lengths
  // so they read as pointing out of the sphere at different angles.
  float nSp = diatom ? 28.0 : 10.0 + floor(h * 8.0);
  float spA = RL_TAU / nSp;
  float sk = floor(phi / spA + 0.5);
  float sh = hash11(mod(sk, nSp) * 3.7 + h * 11.0);
  float L = diatom ? 1.08 + sh * 0.06 : 1.3 + sh * 0.95;
  float sd = rr * abs(phi - sk * spA);
  float t = clamp((rr - 0.95) / (L - 0.95), 0.0, 1.0);
  float nodes = pow(0.5 + 0.5 * cos(rr * RL_TAU * 5.0), 12.0) * (1.0 - t);
  float wS = mix(0.032, 0.004, t) * (1.0 + nodes * 0.8);
  float spine = smoothstep(wS + aa, max(wS - aa, 0.0), sd) * step(0.95, rr) * step(rr, L);
  float run = exp(-pow((fract(rr * 0.9 - u_phase * 1.2 + sh) - 0.5) * 7.0, 2.0));
  float tip = exp(-(pow(rr - L, 2.0) + sd * sd) * 1800.0);
  col += paletteRamp(0.85) * spine * (0.2 + 0.35 * life + run * (0.1 + u_hat * 0.8));
  col += paletteRamp(0.6) * exp(-sd / (wS * 3.0 + 0.01)) * step(0.95, rr) * step(rr, L) * (0.03 + 0.12 * life);
  col += u_light * tip * (0.1 + 0.3 * life + u_hatPulse * 1.2);
  return col;
}

vec4 scene(vec2 uv, vec2 p) {
  float life = clamp(u_energy * 1.3, 0.0, 1.0);
  float seedOff = u_seed * 53.0;
  vec3 col = vec3(0.0);

  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float h = hash11(fi * 13.7 + seedOff);
    // One big radiolarian, a diatom, two small ones.
    vec2 c = i == 0 ? vec2(-0.25, 0.05) : i == 1 ? vec2(1.05, -0.38) : i == 2 ? vec2(-1.28, -0.55) : vec2(0.95, 0.62);
    c += (hash22(vec2(fi, seedOff)) - 0.5) * 0.25;
    c += 0.06 * vec2(sin(u_globalTime * 0.07 + fi * 2.1), cos(u_globalTime * 0.05 + fi * 1.3));
    float R = i == 0 ? 0.48 * (1.0 + u_bass * 0.06 + u_kickPulse * 0.03) : i == 1 ? 0.27 : i == 2 ? 0.2 : 0.15;
    vec2 q = p - c;
    if (length(q) > R * 2.3) continue;
    float dir = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
    float spin = u_phase * dir * (0.3 + h * 0.3) + h * RL_TAU;
    col += rlOrganism(q, R, spin, h, i == 1 ? 1.0 : 0.0, life);
  }

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
