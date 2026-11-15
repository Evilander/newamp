// Ferrofluid — a pool of black magnetic fluid over a magnet. Below a critical
// field the surface stays flat. Above it the surface breaks into a lattice of
// spikes, tallest over the magnet and shorter outward, their height growing as
// the square root of how far the field is past the critical one. The bass is
// the current in the magnet: quiet music leaves a low crown of spikes at the
// centre, loud music raises them and pushes the edge of the crown outward, and
// a kick sends a ring of taller spikes through it. The magnet drifts toward the
// side the mix leans to.
//
// The fluid itself is black. What shows is what it reflects: a strip of light
// in each accent to either side, which lays one coloured streak down each flank
// of every spike, and a key light that puts a hot line between them.
//
// The pool is seen at a slant. Each pixel's ray meets the ground at one point;
// the only spikes that can stand in front of that point are the few rows of the
// lattice nearer than it, so those are tested from the far one to the near one
// and the nearest that covers the pixel is the one drawn.

import type { SceneDef } from './index';

export const ferrofluid: SceneDef = {
  id: 'ferrofluid',
  name: 'Ferrofluid',
  mood: 'high',
  occlusion: 0.8,
  speed: f => 0.25 + f.energy * 0.6 + f.bass * 0.4,
  frag: `
const float FF_FOCAL = 1.6;     // the lens
const float FF_EYE = 0.95;      // how high the viewer is over the pool
const float FF_HORIZON = 0.7;   // where the pool's far edge sits on screen
const float FF_PITCH = 0.26;    // spike to spike
const float FF_ROW = 0.22517;   // row to row: pitch * sqrt(3) / 2
const int FF_ROWS = 14;         // rows nearer than a point that can hide it

// Field over a point of the pool, 0..~1.4: the magnet's pull falls off with
// distance from it, the bass drives it, and a kick rides out as a ring. The
// kick is only the ring: lifting the whole field on it would snap every spike
// up in one frame.
float ffField(vec2 ground, vec2 magnet) {
  float r = length(ground - magnet);
  float drive = 0.14 + 0.5 * u_energy + 0.75 * u_bass;
  float ring = (r - (1.0 - u_kickPulse) * 2.6) * 2.5;
  return drive / (1.0 + r * r * 0.75) + 0.3 * u_kickPulse * exp(-ring * ring);
}

vec4 scene(vec2 uv, vec2 p) {
  float px = 2.0 / min(u_res.x, u_res.y);
  vec3 hot = mix(u_light, vec3(1.0), 0.35);
  float gain = min(0.1 + 1.25 * pow(u_energy, 0.7) + 0.1 * u_kickPulse, 1.3);
  vec2 magnet = vec2(u_pan * 0.6 + 0.2 * sin(u_phase * 0.25 + u_seed * 6.2831853), 2.5 + 0.25 * cos(u_phase * 0.1875));

  float below = FF_HORIZON - p.y;
  // The pool runs out of sight before its far edge; above that is the room.
  if (below <= 0.0) return vec4(0.0);

  // Where this pixel's ray meets the pool.
  float depth = FF_FOCAL * FF_EYE / below;
  vec2 ground = vec2(p.x * depth / FF_FOCAL, depth);

  // The flat pool: a black mirror. It carries the wall's glow from the far
  // edge, a pale bloom over the magnet, and the rings a kick sends across it.
  float r0 = length(ground - magnet);
  float swell = sin(r0 * 9.0 - u_phase * 3.0) * exp(-r0 * 0.6) * (0.25 * u_bass + 0.5 * u_kickPulse);
  vec3 col = paletteRamp(0.36) * exp(-r0 * r0 * 0.4) * (0.2 + 0.4 * u_bass)
    + mix(paletteRamp(0.5), hot, 0.4) * max(swell, 0.0) * 0.6;
  col *= gain;
  // The far pool fades into the dark of the room instead of ending at a line.
  float alpha = 0.92 * smoothstep(0.0, 0.16, below);

  // Past this distance a spike is narrower than a pixel or two.
  float farFade = 1.0 - smoothstep(6.0, 9.5, depth);
  if (farFade > 0.0) {
    float row0 = floor(depth / FF_ROW);
    // Four bands and a whole rate: the mean of four clocks times nine carries
    // on unbroken when any one of them wraps.
    float bassClock = bandClock(0, 3) * 9.0;
    for (int k = 0; k < FF_ROWS; k++) {
      float row = row0 - float(k);
      if (row < 2.0) break;
      float z = row * FF_ROW;
      float shift = mod(row, 2.0) * 0.5;
      // The column of this row the pixel's ray passes over.
      float column = floor(p.x * z / (FF_FOCAL * FF_PITCH) - shift + 0.5);
      vec2 cell = vec2(column, row);
      vec2 wander = (hash22(cell + u_seed * 17.0) - 0.5) * 0.22;
      vec2 site = vec2((column + shift + wander.x) * FF_PITCH, z + wander.y * FF_ROW);
      float over = ffField(site, magnet) - 0.17;
      if (over <= 0.0) continue;
      float tall = hash11(column * 7.31 + row * 3.17 + u_seed * 29.0);
      // No two spikes stand quite alike, and each one breathes on the bass's
      // own clock, out of step with its neighbours.
      float breathe = 1.0 + 0.14 * sin(bassClock + tall * 6.2831853);
      float height = 0.78 * sqrt(over) * (0.84 + 0.32 * tall) * breathe * (1.0 - smoothstep(6.0, 9.5, site.y));
      float base = FF_PITCH * (0.4 + 0.14 * min(over, 1.0));
      // The spike on screen: its foot, how tall and how wide it stands there.
      float foot = FF_HORIZON - FF_FOCAL * FF_EYE / site.y;
      float rise = FF_FOCAL * height / site.y;
      float u = (p.y - foot) / max(rise, 1e-4);
      if (u < 0.0 || u > 1.0) continue;
      // A flared foot narrowing to a point.
      float waist = (1.0 - u);
      float halfWidth = FF_FOCAL * base / site.y * (0.4 * waist * waist + 0.6 * waist);
      float side = (p.x - FF_FOCAL * site.x / site.y) / max(halfWidth, 1e-5);
      float edge = px / max(halfWidth, 1e-5);
      float inside = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, abs(side));
      if (inside <= 0.0) continue;
      float nx = clamp(side, -1.0, 1.0);
      // One accent down the left flank, the other down the right, and the key
      // light's line just left of the ridge. All three thin toward the tip.
      float left = smoothstep(0.35, 0.95, -nx) * (1.0 - smoothstep(0.92, 1.0, -nx) * 0.5);
      float right = smoothstep(0.35, 0.95, nx) * (1.0 - smoothstep(0.92, 1.0, nx) * 0.5);
      float ridge = (nx + 0.18) / 0.13;
      float key = exp(-ridge * ridge);
      float up = 0.35 + 0.65 * u;
      vec3 spike = paletteRamp(0.07) * 0.25
        + paletteRamp(0.52) * left * 1.25 * up
        + paletteRamp2(0.52) * right * 1.05 * up
        + hot * key * (0.3 + 0.7 * u) * 1.15;
      // Far spikes stand in the haze of the room.
      float haze = exp(-max(site.y - 2.0, 0.0) * 0.14);
      col = mix(col, spike * gain * haze, inside * farFade);
    }
  }

  return vec4(col, alpha * (0.35 + 0.65 * min(gain, 1.0)));
}
`,
};
