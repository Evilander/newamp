// Cell Colony — a living tissue under the microscope. Voronoi cells with soft
// thick membranes and a bright inner rim, a nucleus in each, cytoplasm
// granules drifting inside. The colony breathes with bass; dividing cells
// pinch in two (a furrow, a new wall, a spindle between two nuclei) on a clock
// that kicks push forward, and each kick deepens the furrow. Hats shimmer
// around the membranes; each cell's colour cycles with its own band.

import type { SceneDef } from './index';

export const cellColony: SceneDef = {
  id: 'cell-colony',
  name: 'Cell Colony',
  mood: 'mid',
  speed: (f, p) => 0.3 + f.energy * 0.6 + p.kick * 1.5,
  frag: `
const float CC_TAU = 6.28318530718;
const float CC_SCALE = 2.6;
const float CC_SOFT = 14.0;

float ccTri(float x) { return abs(fract(x) * 2.0 - 1.0); }

// Mitosis progress 0..1. About a third of the cells divide, each on its own
// cycle of the kick-driven phase: a quick pinch in two, then a slow settle.
float ccDivision(float h) {
  float cyc = fract(u_phase * (0.05 + h * 0.04) + h * 7.31);
  float split = smoothstep(0.0, 0.1, cyc) * (1.0 - smoothstep(0.4, 1.0, cyc));
  return split * step(0.64, fract(h * 13.7));
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = floor(u_seed * 613.0);
  float life = clamp(u_energy * 1.3, 0.0, 1.0);
  float breath = 1.0 + u_bass * 0.08 + u_kickPulse * 0.03;
  vec2 q = p * CC_SCALE / breath + vec2(u_globalTime * 0.031, u_globalTime * 0.017) + seedOff;
  // Soft domain warp so membranes wobble instead of running straight.
  float wt = u_globalTime * 0.11;
  q += (vec2(vnoise(q * 0.8 + wt), vnoise(q * 0.8 - wt + 5.3)) - 0.5) * 0.5;

  vec2 ip = floor(q);
  vec2 fp = fract(q);
  float d1 = 1e3, d2 = 1e3, soft = 0.0;
  vec2 cC = vec2(0.0), cA = vec2(0.0), cB = vec2(0.0), cAxis = vec2(1.0, 0.0);
  float cH = 0.0, cDiv = 0.0, cSep = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 id = ip + g;
      vec2 r2 = hash22(id + 0.37);
      float h = hash21(id * 1.37 + 11.0);
      // Alternate rows shift half a cell: hex packing, rounder cells.
      vec2 c = g + vec2(0.25 + 0.5 * mod(id.y, 2.0), 0.5) + (r2 - 0.5) * 0.46
             + 0.08 * vec2(sin(u_globalTime * 0.23 + r2.x * CC_TAU), cos(u_globalTime * 0.19 + r2.y * CC_TAU));
      float div = ccDivision(h);
      float ang = r2.y * CC_TAU;
      vec2 axis = vec2(cos(ang), sin(ang));
      float sep = div * (0.17 + u_kickPulse * 0.04);
      vec2 a = c + axis * sep;
      vec2 b = c - axis * sep;
      // A cell is the nearer of its two daughters; a dividing cell also
      // gives ground along its division plane, so the membrane pinches in.
      float along = dot(fp - c, axis);
      float d = min(length(fp - a), length(fp - b)) + div * 0.13 * exp(-along * along * 90.0);
      soft += exp(-CC_SOFT * d);
      if (d < d1) { d2 = d1; d1 = d; cC = c; cA = a; cB = b; cAxis = axis; cH = h; cDiv = div; cSep = sep; }
      else if (d < d2) { d2 = d; }
    }
  }
  // Soft-min of the edge distance to every neighbour: equal to d2 - d1 along
  // an edge, smaller where three cells meet, which rounds the corners off.
  float edge = -log(max(soft - exp(-CC_SOFT * d1), 1e-30)) / CC_SOFT - d1;

  // Membrane profile across the edge metric: dark gap, soft thick body,
  // bright inner rim, then cytoplasm. The division wall joins the same
  // profile as it forms.
  float along = dot(fp - cC, cAxis);
  float wall = smoothstep(0.2, 0.7, cDiv);
  float e = min(edge, abs(along) * 2.0 + (1.0 - wall) * 0.6);
  float body = smoothstep(0.02, 0.07, e) * smoothstep(0.21, 0.1, e);
  float rim = exp(-pow((e - 0.165) / 0.024, 2.0));
  float cyto = smoothstep(0.15, 0.24, e);

  // Nucleus per daughter: condenses and brightens while the cell divides.
  float dn = min(length(fp - cA), length(fp - cB));
  float rn = 0.12 - 0.035 * cDiv;
  float nucFill = smoothstep(rn, rn * 0.55, dn);
  float nucRing = exp(-pow((dn - rn) / 0.018, 2.0));
  float nucleolus = exp(-dn * dn * 1400.0);
  float chromatin = vnoise(q * 22.0 + cH * 40.0);

  // Spindle fibres between the separating nuclei.
  vec2 rel = fp - cC;
  float perp = dot(rel, vec2(-cAxis.y, cAxis.x));
  float spindle = cDiv * smoothstep(cSep, cSep * 0.4, abs(along))
                * (0.5 + 0.5 * cos(perp * 110.0)) * exp(-perp * perp * 160.0);

  // Cytoplasm granules, streaming slowly with the phase.
  vec2 gq = q * 6.5 + vec2(u_phase * 0.11, -u_phase * 0.07);
  vec2 gi = floor(gq);
  vec2 gf = fract(gq) - 0.5 - (hash22(gi) - 0.5) * 0.6;
  float gran = exp(-dot(gf, gf) * 170.0) * step(0.55, hash21(gi + 3.7)) * cyto * (1.0 - nucFill);

  // Hats run a shimmer around each membrane.
  float ang = atan(rel.y, rel.x);
  float shimmer = (u_hat * 0.5 + u_hatPulse * 0.9)
                * (0.5 + 0.5 * sin(ang * 9.0 - u_globalTime * 7.0 + cH * CC_TAU));

  // Each cell's hue walks the palette as its own band accumulates, and a
  // slow wave driven by the energy integral rolls outward across the tissue.
  int k = int(cH * 23.99);
  float band = u_bands[k];
  float hueT = 0.2 + 0.6 * ccTri(u_bandTime[k] * 0.05 + cH * 0.9 + length(p) * 0.3 - u_energyTime * 0.12);
  vec3 bodyCol = paletteRamp(hueT * 0.7);
  vec3 rimCol = paletteRamp(0.7 + 0.3 * hueT);
  vec3 cytoCol = paletteRamp(hueT);
  vec3 nucCol = paletteRamp(1.0 - hueT * 0.6);

  vec3 col = bodyCol * body * (0.16 + 0.34 * life);
  col += rimCol * rim * (0.22 + 0.6 * life) * (1.0 + shimmer);
  col += cytoCol * cyto * (0.04 + 0.1 * life + band * 0.22 * life + cDiv * 0.12);
  col += nucCol * (nucRing * 0.6 + nucFill * (0.12 + chromatin * 0.25 + cDiv * 0.3)) * (0.3 + 0.7 * life);
  col += u_light * nucleolus * (0.2 + 0.5 * life) * (1.0 - cDiv);
  col += rimCol * spindle * (0.25 + 0.5 * life);
  col += u_light * gran * (0.12 + 0.45 * life + u_hatPulse * 0.4);

  float alpha = clamp(dot(col, vec3(0.5)) + body * 0.1, 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
