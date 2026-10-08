// Neural Bloom — a patch of neural tissue. Five neurons, each a glowing soma
// with wandering dendrites that fork twice and taper to boutons, one arm
// stretched out long as the axon. Action potentials run outward along every
// branch as bright packets (faster and brighter with energy, hotter on kicks,
// and the somas fire on kicks). Snare and hat onsets flash the synapses at
// the branch tips; vocals roll a slow glow wave out through the network.

import type { SceneDef } from './index';

export const neuralBloom: SceneDef = {
  id: 'neural-bloom',
  name: 'Neural Bloom',
  mood: 'high',
  speed: (f, p) => 0.35 + f.energy * 1.3 + p.snare * 0.5,
  frag: `
const float NB_TAU = 6.28318530718;

float nbTri(float x) { return abs(fract(x) * 2.0 - 1.0); }

// One arm of a neuron in the soma's polar frame: r from the soma, la the
// angle off the arm's axis, h the arm's hash, reach its length scale. The arm
// wanders on its own wobble and forks twice (children diverge linearly from
// each fork); every twig ends in a bouton. Returns x = distance to the
// nearest branch, y = branch half-width there, z = distance to that twig's
// bouton, w = the twig's hash.
vec4 nbArm(float r, float la, float h, float reach) {
  la -= (sin(r * 5.0 + h * 40.0) * 0.16 + sin(r * 11.0 + h * 17.0) * 0.06) * smoothstep(0.05, 0.4, r);
  float r1 = (0.16 + h * 0.12) * reach;
  float la1 = abs(la) - (0.42 + fract(h * 7.3) * 0.25) * max(0.0, 1.0 - r1 / r);
  float h1 = hash11(h * 91.7 + sign(la) * 3.1);
  la1 -= sin(r * 9.0 + h1 * 30.0) * 0.07 * max(0.0, r - r1) / r;
  float r2 = r1 + (0.1 + h1 * 0.14) * reach;
  float s2 = (0.3 + fract(h1 * 5.1) * 0.3) * step(0.25, h1);
  float la2 = abs(la1) - s2 * max(0.0, 1.0 - r2 / r);
  float h2 = hash11(h1 * 57.3 + sign(la1) * 1.7);
  float rEnd = r2 + (0.1 + h2 * 0.28) * reach;
  float d = r * abs(la2);
  float w = mix(0.02, 0.004, clamp(r / rEnd, 0.0, 1.0)) * smoothstep(rEnd + 0.01, rEnd - 0.04, r);
  return vec4(d, w, length(vec2(r - rEnd, d)), h2);
}

vec3 nbDraw(vec4 arm, float r, float h, float aa, float life, float wave) {
  float core = smoothstep(arm.y + aa, max(arm.y - aa, 0.0), arm.x) * step(0.0005, arm.y);
  float halo = exp(-arm.x / (arm.y * 2.0 + 0.004)) * step(0.0005, arm.y);
  // Packets share the arm's clock, so a spike reaching a fork carries on
  // down both children at once.
  float pk = fract(r * 1.4 - u_phase * 0.45 + h * 0.7);
  float packet = exp(-pow((pk - 0.5) * 10.0, 2.0));
  float bouton = exp(-arm.z * arm.z * 3000.0);
  float fire = arm.w < 0.5 ? u_snarePulse : u_hatPulse;

  int bi = int(h * 23.99);
  float hueT = 0.3 + 0.45 * nbTri(u_bandTime[bi] * 0.05 + h + r * 0.25);
  vec3 lineCol = paletteRamp(hueT);
  vec3 col = lineCol * (core * (0.16 + 0.4 * life + wave * 0.6) + halo * (0.06 + 0.22 * life + wave * 0.4));
  col += mix(paletteRamp(0.9), u_light, 0.5) * (core * 1.2 + halo) * packet * (0.05 + 0.95 * life) * (0.5 + u_kickPulse * 0.5);
  col += u_light * bouton * (0.06 + 0.25 * life + fire * 1.3);
  return col;
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = u_seed * 97.0;
  float life = clamp(u_energy * 1.3, 0.0, 1.0);
  float wave = u_vocal * (0.5 + 0.5 * sin(length(p) * 3.5 - u_globalTime * 1.1));
  vec3 col = vec3(0.0);

  for (int n = 0; n < 5; n++) {
    float fn = float(n);
    float h = hash11(fn * 17.31 + seedOff);
    vec2 c = vec2(-1.45 + fn * 0.72 + (h - 0.5) * 0.3, (hash11(h * 31.0) - 0.5) * 1.1)
           + 0.05 * vec2(sin(u_globalTime * 0.13 + h * 9.0), cos(u_globalTime * 0.11 + h * 5.0));
    float sc = 0.8 + hash11(h * 7.7) * 0.5;
    vec2 q = (p - c) / sc;
    float r = max(length(q), 1e-4);
    float aa = 2.0 / (min(u_res.x, u_res.y) * sc);

    float arms = 5.0 + floor(hash11(h * 3.3) * 3.0);
    float sector = NB_TAU / arms;
    float ang = atan(q.y, q.x) + h * NB_TAU;
    float k = floor(ang / sector + 0.5);
    float la = ang - k * sector;
    // The arm this angle falls in and its neighbour across the sector edge,
    // so a wandering branch is never cut off at the boundary. Arm 0 is the
    // long axon.
    float kn = k + (la > 0.0 ? 1.0 : -1.0);
    float ia = mod(k, arms), ib = mod(kn, arms);
    float ha = hash11(ia * 7.13 + h * 53.0);
    float hb = hash11(ib * 7.13 + h * 53.0);
    col += nbDraw(nbArm(r, la, ha, ia < 0.5 ? 1.9 : 1.0), r, ha, aa, life, wave);
    col += nbDraw(nbArm(r, ang - kn * sector, hb, ib < 0.5 ? 1.9 : 1.0), r, hb, aa, life, wave);

    // Soma: a membrane-bright body with a nucleus; most somas fire on kicks.
    float rs = 0.075 * (1.0 + u_bass * 0.15 + u_kickPulse * 0.1);
    float fireN = u_kickPulse * step(0.35, fract(h * 11.0));
    float soma = smoothstep(rs, rs * 0.6, r);
    float somaRim = exp(-pow((r - rs) / 0.014, 2.0));
    float nucleus = exp(-r * r / (rs * rs * 0.1));
    col += paletteRamp(0.6) * soma * (0.16 + 0.3 * life + fireN * 0.4);
    col += paletteRamp(0.95) * somaRim * (0.25 + 0.45 * life + fireN * 0.35);
    col += u_light * nucleus * (0.12 + 0.25 * life + fireN * 0.35);
    col += paletteRamp(0.7) * exp(-r * 9.0) * (0.04 + 0.12 * life + fireN * 0.2);
  }

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.82);
  return vec4(col, alpha);
}
`,
};
