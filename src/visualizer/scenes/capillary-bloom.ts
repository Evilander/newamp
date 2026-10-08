// Capillary Bloom — a vascular bed like a retina: two arcades leave a glowing
// hilum and branch out across the frame, main vessels curving on while side
// branches break off thinner, down to capillaries. Each kick is a heartbeat:
// the hilum throbs and a wave of glowing cells runs out along every vessel
// from root to capillary, lighting the fine ends as it arrives. Blood cells
// stream outward all the time, faster with energy. Walls thicken with bass;
// vessel hues walk the palette with the band integrals, by branch depth.

import type { SceneDef } from './index';

export const capillaryBloom: SceneDef = {
  id: 'capillary-bloom',
  name: 'Capillary Bloom',
  mood: 'high',
  speed: (f, p) => 0.4 + f.energy * 1.0 + p.kick * 0.8,
  frag: `
const float CB_TAU = 6.28318530718;

float cbTri(float x) { return abs(fract(x) * 2.0 - 1.0); }

float cbSegment(vec2 p, vec2 a, vec2 dir, float len, out float t) {
  vec2 pa = p - a;
  t = clamp(dot(pa, dir) / len, 0.0, 1.0);
  return length(pa - dir * len * t);
}

// A vessel tree walked by descent: at each fork the pixel follows the child
// on its side of the fork's bisector, so a tree costs one segment (plus the
// sibling's first segment, so it is never clipped at the fork) per level.
// Monopodial like real vessels: one child carries on, curving with the
// arcade; the other breaks off wide, shorter and thinner. Returns x = distance
// to the nearest centreline, y = that vessel's radius, z = path length from
// the root, w = branch depth.
vec4 cbTree(vec2 p, vec2 root, float ang, float len, float rad, float curl, float seed) {
  vec2 a = root;
  float path = 0.0;
  float id = seed;
  float best = 1e3;
  vec4 hit = vec4(1e3, 0.0, 0.0, 0.0);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 dir = vec2(cos(ang), sin(ang));
    float t;
    float d = cbSegment(p, a, dir, len, t);
    float rr = rad * (1.0 - 0.18 * t);
    if (d - rr < best) { best = d - rr; hit = vec4(d, rr, path + t * len, fi); }

    vec2 b = a + dir * len;
    float side = hash11(id * 7.31) < 0.5 ? -1.0 : 1.0;
    float wide = 0.6 + 0.4 * hash11(id * 3.17 + 1.3);
    float bend = curl * (0.07 + 0.1 * hash11(id * 5.9 + 2.7));
    float angWide = ang + side * wide;
    float angOn = ang + bend - side * 0.08;
    float bis = 0.5 * (angWide + angOn);
    vec2 pb = p - b;
    bool takeWide = side * (cos(bis) * pb.y - sin(bis) * pb.x) > 0.0;

    // The sibling's first segment.
    float angS = takeWide ? angOn : angWide;
    float lenS = takeWide ? len * 0.88 : len * 0.62;
    float radS = takeWide ? rad * 0.84 : rad * 0.58;
    float tS;
    float dS = cbSegment(p, b, vec2(cos(angS), sin(angS)), lenS, tS);
    float rS = radS * (1.0 - 0.18 * tS);
    if (dS - rS < best) { best = dS - rS; hit = vec4(dS, rS, path + len + tS * lenS, fi + 1.0); }

    path += len;
    a = b;
    ang = takeWide ? angWide : angOn;
    len *= takeWide ? 0.62 : 0.88;
    rad *= takeWide ? 0.58 : 0.84;
    id = hash11(id * 13.7 + (takeWide ? 3.1 : 7.9) + fi);
  }
  return hit;
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = u_seed * 29.0;
  float life = clamp(u_energy * 1.3, 0.0, 1.0);
  // Seconds since the last kick onset, read back from the decaying pulse
  // (the runtime decays it with a 130 ms time constant): the heartbeat wave
  // leaves the hilum on the kick and runs out along the vessels.
  float since = log(1.0 / max(u_kickPulse, 0.002)) * 0.13;
  float front = since * 4.5;
  float beat = clamp(1.0 - since / 0.8, 0.0, 1.0);

  // Vessels meander: a gentle warp so no segment is ruler-straight.
  vec2 w = p + 0.035 * vec2(sin(p.y * 7.0 + seedOff + u_globalTime * 0.2), sin(p.x * 6.3 - seedOff))
             + 0.012 * vec2(sin(p.y * 23.0 + seedOff), sin(p.x * 19.0 + seedOff * 2.0));
  vec2 hilum = vec2(-1.3, 0.02) + (hash22(vec2(seedOff, 3.0)) - 0.5) * vec2(0.3, 0.4);
  float thick = 1.0 + u_bass * 0.35;
  vec4 v1 = cbTree(w, hilum, 0.5 + (hash11(seedOff) - 0.5) * 0.3, 0.58, 0.03 * thick, -1.0, seedOff + 1.0);
  vec4 v2 = cbTree(w, hilum, -0.5 + (hash11(seedOff + 5.0) - 0.5) * 0.3, 0.55, 0.028 * thick, 1.0, seedOff + 2.0);
  vec4 v = v1.x - v1.y < v2.x - v2.y ? v1 : v2;

  float d = v.x, rad = v.y, path = v.z, depth = v.w;
  float aa = 1.5 / min(u_res.x, u_res.y);
  // The heartbeat wave distends each vessel as it passes.
  float wave = beat * exp(-pow((path - front) / 0.16, 2.0));
  rad *= 1.0 + wave * 0.4;
  // Wall edges bright, lumen dim, a faint halo; capillaries thinner than a
  // couple of pixels collapse to one glowing thread.
  float wallW = max(rad * 0.28, aa);
  float wall = exp(-pow((d - rad) / wallW, 2.0));
  float lumen = smoothstep(rad + aa, max(rad - aa, 0.0), d);
  float thread = smoothstep(aa * 2.0, 0.0, d) * (1.0 - smoothstep(aa * 1.5, aa * 3.0, rad));
  float halo = exp(-max(d - rad, 0.0) / (0.012 + rad));

  // Blood cells streaming outward, spaced by the vessel's radius (so they
  // crawl through capillaries), with gaps in the train; the heartbeat wave
  // carries a bright bolus of them out to the capillary ends.
  float spacing = max(rad, aa) * 3.2;
  float cq = path / spacing - u_phase * 1.2 + depth * 0.37;
  float along = (fract(cq) - 0.5) * spacing;
  float cellR = max(rad, aa) * 0.6;
  float cells = exp(-(along * along + d * d) / (cellR * cellR)) * step(0.3, hash11(floor(cq) + depth * 17.0)) * lumen;
  float bloom = wave * smoothstep(3.0, 7.0, depth);

  int bi = int(mod(depth * 2.0 + seedOff, 24.0));
  float hueT = 0.35 + 0.45 * cbTri(depth * 0.11 + u_bandTime[bi] * 0.04 + path * 0.1);
  vec3 wallCol = paletteRamp(hueT);
  vec3 col = wallCol * (wall + thread) * (0.18 + 0.5 * life + wave * 1.3);
  col += paletteRamp(0.25) * lumen * (0.05 + 0.12 * life);
  col += mix(paletteRamp(0.9), u_light, 0.4) * cells * (0.04 + 0.4 * life + wave * 1.2);
  col += paletteRamp(0.6) * halo * (0.02 + 0.08 * life + wave * 0.3 + bloom * 0.6);
  col += u_light * (wall + thread) * bloom;

  // The hilum: a disc that throbs on the kick.
  float hr = length(p - hilum);
  float hR = 0.09 * (1.0 + u_kickPulse * 0.25 + u_bass * 0.1);
  col += paletteRamp(0.8) * exp(-pow((hr - hR) / 0.012, 2.0)) * (0.3 + 0.5 * life + u_kickPulse * 0.6);
  col += paletteRamp(0.55) * smoothstep(hR, hR * 0.3, hr) * (0.1 + 0.25 * life + u_kickPulse * 0.5);

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
