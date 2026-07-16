// A wall of warm-backlit analog VU meters — twelve dials, each needle wired
// to its own two-band slice of the spectrum, swinging on the envelope's own
// ballistics. Bass breathes the backlight, kicks flare it, and a needle
// pushed past ~0.78 lights its red peak zone. Pure hi-fi hardware soul; in
// silence the needles rest at the left pin over a dim standby glow.

import type { SceneDef } from './index';

export const vuCathedral: SceneDef = {
  id: 'vu-cathedral',
  name: 'VU Cathedral',
  mood: 'mid',
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  vec2 gridN = vec2(4.0, 3.0);
  vec2 cellUv = uv * gridN;
  vec2 cellId = floor(cellUv);
  // Meter pivot sits below the dial's center so the needle sweeps an arc
  // across the top of the cell, like the real thing.
  vec2 q = fract(cellUv) - vec2(0.5, 0.32);
  // Cells aren't square on screen — correct x so the dial arc stays circular.
  q.x *= (u_res.x * gridN.y) / (u_res.y * gridN.x);
  int idx = int(cellId.y) * 4 + int(cellId.x);
  float level = bandAvg(idx * 2, idx * 2 + 1);
  float drive = clamp(level * 1.7, 0.0, 1.0);

  // Needle: rest pin at -50deg, full scale at +50deg.
  float ang = mix(-0.87, 0.87, drive);
  vec2 dir = vec2(sin(ang), cos(ang));
  float along = clamp(dot(q, dir), 0.0, 0.4);
  float dN = length(q - dir * along);
  float needleGlow = smoothstep(0.014, 0.0, dN) * step(0.04, along);

  // Dial arc + tick marks along it.
  float r = length(q);
  float theta = atan(q.x, q.y);
  float onArc = step(abs(theta), 0.92);
  float arc = smoothstep(0.010, 0.0, abs(r - 0.40)) * onArc;
  float tick = smoothstep(0.16, 0.9, abs(fract(theta * 3.5 + 0.5) - 0.5) * 2.0);
  float ticks = smoothstep(0.028, 0.0, abs(r - 0.40)) * onArc * step(0.86, tick) * 0.8;

  // Warm backlight breathing with bass; red peak zone past ~0.78 drive.
  vec3 warm = mix(vec3(1.0, 0.7, 0.34), u_accent, 0.28);
  float back = smoothstep(0.62, 0.0, r) * (0.035 + u_bass * 0.11 + u_kickPulse * 0.07);
  float redZone = step(0.55, theta) * arc * (0.25 + step(0.78, drive) * 1.2);

  col += warm * back;
  col += warm * (arc * 0.22 + ticks * 0.3);
  col += vec3(1.0, 0.16, 0.1) * redZone * 0.35;
  col += (u_light * 0.7 + warm * 0.3) * needleGlow * (0.3 + drive * 0.7);

  // Faint cell frames so the wall reads as separate units.
  vec2 fr = abs(fract(cellUv) - 0.5);
  float frame = smoothstep(0.03, 0.0, 0.5 - max(fr.x, fr.y)) * (0.02 + u_energy * 0.04);
  col += warm * frame;

  float alpha = clamp(dot(col, vec3(0.6)), 0.0, 0.58);
  return vec4(col, alpha);
}
`,
};
