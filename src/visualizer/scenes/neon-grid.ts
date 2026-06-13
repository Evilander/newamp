// Synthwave perspective floor grid scrolling on the beat, with a low sun
// made of u_bands horizontal stripes and a horizon that flares on kicks.

import type { SceneDef } from './index';

export const neonGrid: SceneDef = {
  id: 'neon-grid',
  name: 'Neon Grid',
  mood: 'high',
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  // Horizon position varies per seed.
  float horizon = -0.12 + (u_seed - 0.5) * 0.25;
  // Sun horizontal position drifts a bit with stereo pan.
  float sunX = (u_seed - 0.5) * 0.7 + u_pan * 0.25;
  float sunY = horizon + 0.42;
  float sunR = 0.32 + u_bass * 0.05;

  vec3 col = vec3(0.0);

  // --- Sky gradient -------------------------------------------------------
  float skyMask = step(horizon, p.y);
  float skyT = clamp((p.y - horizon) / 1.2, 0.0, 1.0);
  vec3 sky = mix(paletteRamp(0.55), paletteRamp(0.05), skyT);
  col += sky * skyMask * 0.18;

  // --- Sun: vertical disk sliced into horizontal band stripes -------------
  vec2 sp = vec2(p.x - sunX, p.y - sunY);
  float sr = length(sp);
  float sunDisk = smoothstep(sunR, sunR - 0.005, sr);
  // Map y within sun to one of 24 stripes (top → band 23, bottom → band 0).
  float stripeT = clamp((sp.y / sunR) * 0.5 + 0.5, 0.0, 0.999);
  int bandIdx = int(stripeT * 24.0);
  float bandV = u_bands[bandIdx];
  // Stripe edges — alternate dark/bright slices for that retro look.
  float stripeBand = step(0.5, fract(stripeT * 12.0));
  vec3 sunHot = mix(paletteRamp(0.9), vec3(1.0, 0.92, 0.6), 0.55);
  col += sunHot * sunDisk * (0.5 + bandV * 1.2) * stripeBand;
  // Sun outer glow.
  float sunGlow = exp(-sr * 5.0) * (0.4 + u_bass * 0.5);
  col += paletteRamp(0.85) * sunGlow * skyMask;

  // --- Horizon flare on kicks --------------------------------------------
  float horizDist = abs(p.y - horizon);
  float flare = exp(-horizDist * (18.0 - u_kickPulse * 10.0)) * (0.25 + u_kickPulse * 1.4);
  col += paletteRamp(0.95) * flare;

  // --- Floor grid ---------------------------------------------------------
  float floorMask = 1.0 - skyMask;
  if (floorMask > 0.0) {
    // Project floor: depth z grows toward horizon, perspective scales coords.
    float z = (horizon - p.y);
    z = max(z, 0.001);
    // Scroll grid forward (toward camera) at beat speed.
    float scroll = u_globalTime * (1.0 + u_energy * 2.2 + u_kickPulse * 1.5);
    float worldY = 1.0 / z + scroll;
    float worldX = p.x / z;
    // Line thickness pulses with bass; thinner with depth for aliasing safety.
    float lineW = (0.04 + u_bass * 0.15) * z;
    float gx = abs(fract(worldX) - 0.5);
    float gy = abs(fract(worldY) - 0.5);
    float lx = smoothstep(lineW, 0.0, gx);
    float ly = smoothstep(lineW, 0.0, gy);
    float grid = max(lx, ly);
    // Fog: grid fades into horizon.
    float fog = smoothstep(0.0, 0.55, z * 1.8);
    vec3 gridTint = paletteRamp(0.7 + u_centroid * 0.25);
    col += gridTint * grid * (0.5 + u_bass * 0.8) * (1.0 - fog) * floorMask;
    // Floor base wash so grid sits on something.
    col += paletteRamp(0.18) * floorMask * 0.05 * (1.0 - fog);
  }

  // Star sparkle in sky on hats.
  float sp2 = hash21(floor(uv * vec2(180.0, 110.0)));
  col += vec3(1.0) * step(0.992, sp2) * skyMask * (0.3 + u_hatPulse * 0.7) * 0.4;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.78);
  return vec4(col, alpha);
}
`,
};
