// Vertical flame columns rising from the bottom, each tied to a band group.
// Flame colour runs the palette by heat (dark at the tips, light at the core),
// so the fire takes whatever palette is active; sparks fly on hat impulses.

import type { SceneDef } from './index';

export const fireSpires: SceneDef = {
  id: 'fire-spires',
  name: 'Fire Spires',
  mood: 'high',
  speed: (f, p) => 0.9 + f.energy * 1.6 + f.bass * 0.8,
  frag: `
float spireMask(vec2 q, float cx, float width, float height) {
  // Soft column centered at cx, with flame body distorted by fbm.
  float dx = (q.x - cx);
  float bodyX = smoothstep(width, 0.0, abs(dx));
  float bodyY = smoothstep(height, -0.5, q.y);
  return bodyX * bodyY;
}

vec4 scene(vec2 uv, vec2 p) {
  // Number of spires: 8..12 seeded.
  float spiresF = floor(8.0 + hash11(u_seed * 5.1) * 5.0);
  vec3 col = vec3(0.0);

  // Vertical fbm advection — flames "flow" upward with time + bass push.
  float lift = u_phase;

  // Each spire owns a band slice (low bands = tall flames in center, hi bands shorter at edges).
  for (int i = 0; i < 12; i++) {
    if (float(i) >= spiresF) break;
    float fi = float(i);
    float t = (fi + 0.5) / spiresF;
    float cx = (t - 0.5) * 2.6;
    // Band group: spread 24 bands across spires, group of ~2.
    int bLo = int(t * 22.0);
    float band = bandAvg(bLo, bLo + 2);

    // Height + jitter from seed; sway with vocal envelope.
    float seed = u_seed * 97.0 + fi * 13.31;
    float jitter = (hash11(seed) - 0.5) * 0.15;
    float sway = sin(u_globalTime * (1.2 + hash11(seed + 1.0) * 2.0) + fi) * 0.08 * u_vocal;
    float colX = cx + jitter + sway;
    float baseH = 0.4 + band * 1.0 + u_kickPulse * 0.4;
    float width = 0.08 + band * 0.07;

    // Local coords relative to column base (bottom-center of screen).
    vec2 q = vec2(p.x - colX, p.y + 1.0);

    // Flame fbm: tall, advected upward.
    vec2 nuv = vec2(q.x * 4.0 + seed, q.y * 2.2 - lift * (0.6 + band * 0.6));
    float flame = fbm(nuv);
    // Carve the flame shape: tapered, height-limited.
    float taper = smoothstep(width * (1.5 + q.y * 0.4), 0.0, abs(q.x));
    float topMask = smoothstep(baseH * 2.0, 0.0, q.y);
    float intensity = flame * taper * topMask;
    intensity = pow(intensity, 1.6) * (0.7 + band * 1.4);

    // Heat ramp through the palette: hot and loud near the base, cooling
    // toward the tips.
    float heat = 0.8 - q.y * 0.4 + band * 0.25 + u_centroid * 0.1;
    col += paletteRamp(heat) * intensity;

    // Hot core near base.
    float core = smoothstep(width * 0.6, 0.0, abs(q.x)) * smoothstep(0.6, 0.0, q.y) * (0.5 + band * 0.8);
    col += u_light * core * 0.4;
  }

  // Sparks: hash points high up, only show when hatPulse fires.
  vec2 sg = uv * vec2(120.0, 200.0);
  float sparkH = hash21(floor(sg) + floor(u_globalTime * 24.0));
  float spark = step(0.992, sparkH) * smoothstep(0.0, 0.7, 1.0 - uv.y * 0.4) * u_hatPulse;
  col += u_light * spark * 0.7;

  // Smoke at top — slight haze that dims everything above mid-frame.
  float haze = smoothstep(0.4, 1.0, uv.y) * 0.12 * u_energy;
  col += paletteRamp(0.2) * haze;

  float alpha = clamp(dot(col, vec3(0.6)), 0.0, 0.8);
  return vec4(col, alpha);
}
`,
};
