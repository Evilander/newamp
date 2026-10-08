import type { SceneDef } from './index';

// Three suspended helices: opposite strands pass in front of one another,
// with nucleotide rungs and band-specific packets moving along the backbone.
export const chromatinFlow: SceneDef = {
  id: 'chromatin-flow', name: 'Chromatin Flow', mood: 'mid',
  speed: (f, p) => 0.3 + f.vocal * 0.65 + p.snare * 0.35,
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  p = rot2(0.22 * sin(u_globalTime * 0.06 + u_seed * 6.0)) * p;
  vec3 col = vec3(0);
  float life = 0.2 + u_energy;
  float aa = 2.0 / min(u_res.x, u_res.y);
  for (int i = 0; i < 3; i++) {
    float id = float(i), h = hash11(id + u_seed * 73.0);
    float axis = (id - 1.0) * 1.06 + 0.13 * sin(p.y * 1.8 + u_phase * 0.4 + h * 9.0);
    float twist = p.y * (5.0 + h * 1.5) + u_phase + h * 6.28318;
    float width = 0.29 + u_bass * 0.045;
    float x = p.x - axis;
    float beads = pow(0.5 + 0.5 * cos(p.y * 66.0 + h * 12.0 - u_phase * 2.0), 10.0);
    float rungY = (fract((p.y + u_phase * 0.035) * 9.0 + h) - 0.5) / 9.0;
    float rung = exp(-abs(rungY) / max(0.009, aa)) * (1.0 - smoothstep(abs(sin(twist)) * width, abs(sin(twist)) * width + 0.015, abs(x)));
    col += paletteRamp(0.4 + 0.2 * sin(p.y * 7.0 + h)) * rung * life * 0.38;
    for (int side = 0; side < 2; side++) {
      float s = float(side) * 2.0 - 1.0;
      float d = abs(x - s * sin(twist) * width);
      float depth = 0.5 + 0.5 * s * cos(twist);
      float tube = exp(-d / (0.012 + depth * 0.012 + aa));
      float sheath = exp(-d / 0.065) * 0.08;
      int band = i * 7 + side * 3;
      float packet = pow(0.5 + 0.5 * sin(p.y * 10.0 - u_bandTime[band] * 3.0 + h * 9.0), 18.0);
      col += paletteRamp(0.24 + float(side) * 0.48) * (tube + sheath) * (0.4 + depth * 0.6) * life;
      col += u_light * tube * (beads * 0.35 + packet * (u_bands[band] + u_snarePulse * 0.6)) * life;
    }
  }
  return vec4(col, clamp(max(col.r, max(col.g, col.b)) * 1.5, 0.0, 0.83));
}
`,
};
