// Pendulum Wave — the lecture-hall demonstration: a row of pendulums hung from
// one bar, each a little shorter than the last, so that in the time the longest
// makes 30 swings the next makes 31, the next 32, and so on. Set going together
// they drift out of step into a travelling wave, then two interleaved waves,
// then what looks like disorder, and every so often fall back into one line.
// There are 24, one for each mel band, low bands on the long pendulums. A band
// lights its bob; the row swings wider as the music gets louder and the clock
// that carries it through its cycle runs on the music's energy.
//
// The row is seen from near one end, the way the demonstration is usually
// filmed: the long pendulums are nearest and largest, the bar runs away across
// the frame, and the bobs swing across the bar, so the wave is the snake the
// row of them draws. Each bob's angle is
// a sine of its own whole number of turns of one shared clock, which is all the
// demonstration is; the lengths follow from the rates as they do for a real
// pendulum, as one over the square. Half the seeds see the row from the other
// side.

import type { SceneDef } from './index';

export const pendulumWave: SceneDef = {
  id: 'pendulum-wave',
  name: 'Pendulum Wave',
  mood: 'calm',
  occlusion: 0.45,
  speed: f => 0.3 + f.energy * 0.8,
  frag: `
const int PW_BOBS = 24;
const float PW_TAU = 6.28318530718;
const float PW_LENS = 2.4;
// The first pivot, and the step from one pivot to the next: the bar runs away
// from the eye and across it. The bobs swing square to the bar.
const vec3 PW_FIRST = vec3(1.0, 0.85, 2.2);
const vec3 PW_STEP = vec3(-0.11, 0.0, 0.14);
const vec3 PW_SWING = vec3(0.786, 0.0, 0.618);
const float PW_FLOOR = -0.82;

float pwSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

vec4 scene(vec2 uv, vec2 p) {
  float px = 2.0 / min(u_res.x, u_res.y);
  if (u_seed < 0.5) p.x = -p.x;
  float widest = 0.2 + 0.32 * min(u_energy * 1.3, 1.0);
  // Pendulum n turns through (30 + n) / 8 radians a second of the scene's
  // clock, so the row comes back into line every 16 pi seconds of it. The
  // whole turns are dropped before the clock is multiplied by a rate, which
  // keeps the angle's precision hours into a session, and an eighth is a rate
  // the clock's wrap does not disturb.
  float swung = mod(u_phase * 0.125, PW_TAU);
  vec3 hot = mix(u_light, vec3(1.0), 0.35);
  vec3 lamp = normalize(vec3(-0.45, 0.65, 0.6));

  // The bar, running away from the eye.
  vec3 nearEnd = PW_FIRST - 1.5 * PW_STEP;
  vec3 farEnd = PW_FIRST + (float(PW_BOBS) + 0.5) * PW_STEP;
  float rod = pwSegment(p, nearEnd.xy * (PW_LENS / nearEnd.z), farEnd.xy * (PW_LENS / farEnd.z));
  vec3 col = mix(paletteRamp(0.4), hot, 0.25) * (1.0 - smoothstep(0.006, 0.006 + px * 1.5, rod)) * (0.1 + 0.3 * u_energy);

  // Far to near, so a nearer bob is drawn over the ones behind it.
  for (int j = 0; j < PW_BOBS; j++) {
    int i = PW_BOBS - 1 - j;
    float fi = float(i);
    float t = fi / float(PW_BOBS - 1);
    float rate = 30.0 + fi;
    float len = 1.52 * (30.0 / rate) * (30.0 / rate);
    float theta = widest * sin(rate * swung + u_seed * 6.2831853);
    vec3 hung = PW_FIRST + fi * PW_STEP;
    vec3 bob = hung + len * sin(theta) * PW_SWING - vec3(0.0, len * cos(theta), 0.0);
    float scale = PW_LENS / bob.z;
    vec2 pivot = hung.xy * (PW_LENS / hung.z);
    vec2 c = bob.xy * scale;
    float r = 0.12 * scale;
    // Nothing of this pendulum comes near the pixel: its string, its bob and
    // the bob's glow and pool of light all lie inside this box.
    float reach = 0.66 * scale;
    if (abs(p.x - 0.5 * (pivot.x + c.x)) > 0.5 * abs(pivot.x - c.x) + reach
      || p.y > max(pivot.y, c.y + reach) || p.y < min(c.y - reach, (PW_FLOOR - 0.13) * scale)) continue;
    float level = u_bands[i];
    float lit = 0.22 + 1.2 * level + 0.35 * u_kickPulse * (1.0 - smoothstep(0.0, 0.3, t)) + 0.3 * u_hatPulse * smoothstep(0.7, 1.0, t);
    // Long pendulums in the first accent, short ones in the second; the change
    // is kept to a few bobs so the two hues are not averaged across the row.
    vec3 ink = mix(paletteRamp(0.44 + 0.2 * t), paletteRamp2(0.5 + 0.16 * (t - 0.5)), smoothstep(0.42, 0.58, t));

    // The string, the light the bob throws on the air, and its pool of light
    // on the floor below.
    float sd = pwSegment(p, pivot, c);
    col += mix(ink, hot, 0.3) * (1.0 - smoothstep(px * 0.5, px * 0.5 + 0.004 * scale + px, sd)) * (0.08 + 0.3 * level);
    vec2 q = p - c;
    float d = length(q);
    col += ink * exp(-max(d - r, 0.0) / (r * 0.8)) * level * level * 0.4;
    vec2 pool = (p - vec2(bob.x, PW_FLOOR) * scale) / (vec2(0.3, 0.05) * scale);
    col += ink * exp(-dot(pool, pool)) * (0.03 + 0.3 * level);

    float inside = 1.0 - smoothstep(r - px, r + px, d);
    if (inside > 0.0) {
      vec3 n = vec3(q / r, sqrt(max(1.0 - d * d / (r * r), 0.0)));
      float diffuse = max(dot(n, lamp), 0.0);
      float glint = pow(max(dot(reflect(-lamp, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
      float rim = (1.0 - n.z) * (1.0 - n.z);
      vec3 lacquer = ink * (0.1 + 0.8 * diffuse) * lit + ink * rim * 0.4 * (0.2 + level) + hot * glint * (0.3 + 0.7 * level);
      // The bob stands in front of everything drawn so far.
      col = mix(col, lacquer, inside);
    }
  }

  float m = max(col.r, max(col.g, col.b));
  return vec4(col / max(m, 0.001), min(m, 0.85));
}
`,
};
