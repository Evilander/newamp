import type { SceneDef } from './index';

// Travelling contractions along striated fibres. A continuous material
// coordinate compresses the sarcomeres; there is no topology reset on a hit.
export const muscleFibres: SceneDef = {
  id: 'muscle-fibres', name: 'Muscle Fibres', mood: 'mid',
  speed: (f, p) => 0.2 + f.bass * 0.8 + p.kick * 0.6,
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  p = rot2(0.38 + 0.12 * sin(u_globalTime * 0.04 + u_seed * 6.0)) * p;
  vec2 q = p;
  q.y += 0.055 * sin(p.x * 3.0 + u_phase * 0.7) + 0.02 * sin(p.x * 7.0 - u_phase);
  float lane = floor(q.y * 6.0), local = fract(q.y * 6.0) - 0.5;
  float h = hash11(lane + floor(u_seed * 127.0));
  float contraction = 0.5 + 0.5 * sin(p.x * 4.0 - u_phase * 2.0 + h * 2.0);
  float width = 0.34 + contraction * (0.04 + u_bass * 0.045);
  float edge = abs(local);
  float body = 1.0 - smoothstep(width - 0.04, width, edge);
  float membrane = exp(-abs(edge - width) * 70.0);
  float material = p.x + 0.045 * sin(p.x * 4.0 - u_phase * 2.0 + h * 2.0);
  float unit = fract(material * (15.0 + h * 3.0) + h);
  float zdisc = exp(-abs(unit - 0.5) * 35.0);
  float filamentPhase = local * 100.0 + h * 6.0;
  float detail = 1.0 - smoothstep(0.9, 3.14, fwidth(filamentPhase));
  float filaments = mix(0.2256, pow(0.5 + 0.5 * cos(filamentPhase), 6.0), detail);
  float anisotropy = 0.5 + 0.5 * cos(unit * 6.28318);
  float packet = pow(0.5 + 0.5 * sin(p.x * 8.0 - u_phase * 4.0 + h * 9.0), 14.0);
  float life = 0.2 + u_energy;
  vec3 col = paletteRamp(0.18 + h * 0.4) * body * (0.14 + filaments * 0.2 + anisotropy * 0.16) * life;
  col += paletteRamp(0.72) * membrane * (0.45 + contraction * 0.35) * life;
  col += paletteRamp(0.5 + h * 0.4) * zdisc * body * (0.4 + u_kickPulse * 0.3) * life;
  col += u_light * filaments * body * packet * (u_snarePulse * 0.7 + u_hat * 0.35);
  vec2 nucleusOffset = vec2((fract(p.x * 1.7 + h) - 0.5) * 16.0, (abs(local) - width * 0.72) * 20.0);
  float nucleus = exp(-dot(nucleusOffset, nucleusOffset));
  col += paletteRamp(0.85) * nucleus * life * 0.7;
  return vec4(col, clamp(body * 0.48 + membrane * 0.32, 0.0, 0.84));
}
`,
};
