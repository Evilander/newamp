// Truss Chase — a lighting rig seen from the house. Three trusses hang one above
// the other, each a row of 24 par cans throwing a cone of haze-lit light
// straight down. The top row is far away: wide, soft cones that melt into a
// curtain. The middle row is a medium row, offset half a lamp, and is a literal
// spectrum: lamp i is mel band i, and the louder its band the further its beam
// carries. The bottom row is near: tight, hard beams that land on the stage
// floor as small pools.
//
// A four-step chase runs along every row locked to the beat, one lamp group
// lighting a quarter of a beat after the last. Every four counted kicks the
// pattern slides along by a lamp, and the middle row runs the other way. The
// bar is a call and a response: the first half of the beat the top row answers
// the bass, the second half the bottom row answers the hats, crossfading
// between them as a cosine. The outer rows are the palette's second accent and
// the spectrum row between them its first, so the rows alternate in colour. As the beat tracker loses confidence the windows
// open and the chase stops, so a room with no beat is a still rig.
//
// Nothing is stored. Each pixel finds the lamps nearest to it in each row and
// works out their level from the audio uniforms alone, so the picture is a pure
// function of the frame. The chase rides u_beatPhase and the haze drifts on
// u_phase. Nothing is opaque: the rig is light, and the trail shows through.

import type { SceneDef } from './index';

export const trussChase: SceneDef = {
  id: 'truss-chase',
  name: 'Truss Chase',
  mood: 'high',
  speed: f => 0.4 + f.energy * 0.6,
  occlusion: 0,
  frag: `
const int TC_LAMPS = 24;
// Lamp pitch. 24 lamps at this pitch span +-1.72, the width of a 16:9 frame.
const float TC_PITCH = 0.15;

// Light from a lamp head at o: a gaussian in x whose width grows linearly with
// the distance below the lamp, scaled by w0 / w so a spreading cone gets
// dimmer. Energy is only partly conserved (the exponent is 0.6, not 1): a
// narrow beam at full conservation would vanish within a few lamp widths of its
// head. It fades along its length
// at len, and the lamp head fades it in so it does not start on a hard line.
float tcCone(vec2 p, vec2 o, float w0, float rate, float len) {
  float dy = o.y - p.y;
  float dx = p.x - o.x;
  float w = w0 + max(dy, 0.0) * rate;
  return exp(-(dx * dx) / (w * w)) * pow(w0 / w, 0.6) * exp(-max(dy, 0.0) / len) * smoothstep(0.0, 0.03, dy);
}

// How bright lamp i of a row is: a pure function of the audio uniforms. The
// group is what the chase steps through; it slides by a lamp per four kicks.
// bar and win are the same for every lamp, so the caller works them out once.
// win is 1 on the beat and 0 half a beat later, a cosine so it is continuous
// across the wrap and the two outer rows see-saw instead of strobing.
float tcLamp(int row, int i, float bar, float win) {
  float fi = float(i);
  float g = mod((row == 1 ? -fi : fi) + bar * float(row + 1), 4.0);
  float chase = exp(-fract(u_beatPhase - g * 0.25) * 7.0);
  // An untrusted beat gives a static rig, and opens both windows.
  float call = mix(1.0, win, u_beatConf);
  float resp = mix(1.0, 1.0 - win, u_beatConf);
  float v;
  if (row == 0) {
    v = mix(0.35, 1.0, call) * (0.03 + u_bass * 0.9) * mix(1.0, 0.15 + 0.85 * chase, u_beatConf);
  } else if (row == 2) {
    v = mix(0.35, 1.0, resp) * (0.02 + u_hat * 0.8 + u_hatPulse * 0.7) * mix(1.0, 0.12 + 0.88 * chase, u_beatConf);
  } else {
    v = (0.02 + u_bands[i] * 0.95) * mix(1.0, 0.5 + 0.5 * chase, u_beatConf);
  }
  return v;
}

// One truss: the cones and heads of its lamps. reach is how many lamps either
// side of the nearest one still matter at this cone width; the nearest lamp
// changes where the neighbours are equally far, so the sum stays continuous
// across it. Everything that depends only on the row and p.y is worked out
// before the lamp loop. second picks the second accent for the row's colour, so
// the rows alternate between the two accents and do not read as one tint.
vec3 tcRow(vec2 p, int row, float y, float off, float w0, float rate, float len,
           float lenGain, float gain, int reach, float tone, float spread, bool second,
           float haze, float bar, float win) {
  if (p.y > y + 0.04) return vec3(0.0);
  float dy = y - p.y;
  float dyc = max(dy, 0.0);
  float w = w0 + dyc * rate;
  // Partial energy conservation, the cone's fade-in under the lens, and how far
  // the lens-hot colour carries down the beam.
  float spreadLoss = pow(w0 / w, 0.6) * smoothstep(0.0, 0.03, dy);
  float lens = 0.4 * exp(-dyc * 5.0);
  vec3 col = vec3(0.0);
  int base = int(floor(p.x / TC_PITCH + 11.5 - off + 0.5));
  for (int k = -2; k <= 2; k++) {
    if (abs(k) > reach) continue;
    int i = base + k;
    if (i < 0 || i >= TC_LAMPS) continue;
    vec2 o = vec2((float(i) - 11.5 + off) * TC_PITCH, y);
    float lv = tcLamp(row, i, bar, win);
    // The rig leans through the palette from one end to the other, so a row is
    // a gradient and not a single tint.
    float t = clamp(tone + (float(i) / 23.0 - 0.5) * spread, 0.0, 1.0);
    vec3 tint = second ? paletteRamp2(t) : paletteRamp(t);
    vec3 head = mix(tint, u_light, 0.3);
    // The cone cools from the lens down: hot at the head, the row's own tint further out.
    vec3 beam = mix(tint, u_light, lens);
    float dx = p.x - o.x;
    float reachLen = max(len * (1.0 + lenGain * (lv - 0.4)), 0.12);
    col += beam * (exp(-(dx * dx) / (w * w)) * spreadLoss * exp(-dyc / reachLen)) * lv * gain * haze;
    // The head: a disc with a short halo.
    vec2 d = p - o;
    float r2 = dot(d, d);
    col += head * (smoothstep(0.022, 0.006, sqrt(r2)) * (0.05 + lv) + exp(-r2 / 0.0012) * lv * 0.35);
  }
  return col;
}

// The truss itself: two chords with a zigzag of bracing between them, dim,
// lifted a little by the room's loudness as the light spills onto it. px is the
// size of a pixel in p, so the bars never get thinner than a pixel and a small
// window still shows a truss.
float tcBar(vec2 p, float y, float px) {
  float cw = max(0.0045, 1.2 * px);
  float bw = max(0.004, 1.2 * px);
  float cy = y + 0.032;
  float chords = smoothstep(cw, 0.0, abs(p.y - (cy + 0.025))) + smoothstep(cw, 0.0, abs(p.y - (cy - 0.025)));
  float t = abs(fract(p.x / (TC_PITCH * 0.5)) * 2.0 - 1.0);
  float brace = smoothstep(bw, 0.0, abs(p.y - (cy - 0.025 + 0.05 * t))) * step(abs(p.y - cy), 0.027);
  return chords + brace * 0.7;
}

vec4 scene(vec2 uv, vec2 p) {
  // Haze: a slow drift of thick and thin air that the beams pass through.
  float haze = 0.78 + 0.44 * vnoise(vec2(p.x * 2.6 + u_phase * 0.04, p.y * 1.9 - u_phase * 0.07));
  float bar = floor(u_kickCount * 0.25);
  float win = 0.5 + 0.5 * cos(6.2832 * u_beatPhase);

  // Far to near, cool to hot: the far row is a short glow band in the second
  // accent behind the middle truss, the middle row the first accent, the near
  // row (the response) the second accent again, and only the near row's lens
  // runs toward the light colour.
  vec3 col = tcRow(p, 0, 0.80, 0.0, 0.04, 0.16, 0.9, 0.2, 1.1, 2, 0.12 + u_centroid * 0.05, 0.12, true, haze, bar, win);
  col += tcRow(p, 1, 0.40, 0.5, 0.022, 0.10, 1.2, 1.4, 1.6, 2, 0.55 + u_centroid * 0.08, 0.3, false, haze, bar, win);
  col += tcRow(p, 2, 0.02, 0.0, 0.012, 0.05, 1.3, 0.3, 1.9, 1, 0.68, 0.3, true, haze, bar, win);

  // The bottom beams land on the floor as small pools.
  if (p.y < -0.65) {
    int base = int(floor(p.x / TC_PITCH + 11.5 + 0.5));
    for (int k = -1; k <= 1; k++) {
      int i = base + k;
      if (i < 0 || i >= TC_LAMPS) continue;
      float cx = (float(i) - 11.5) * TC_PITCH;
      vec2 d = vec2(p.x - cx, (p.y + 0.86) * 3.0);
      col += paletteRamp2(0.68) * exp(-dot(d, d) / 0.0035) * tcLamp(2, i, bar, win) * 0.45;
    }
  }

  // The bars, dim, with the row's tint; and the faintest breath of haze so
  // silence is a rig in a dark room.
  float px = fwidth(p.y);
  col += paletteRamp(0.12) * (tcBar(p, 0.80, px) + tcBar(p, 0.40, px) + tcBar(p, 0.02, px)) * (0.12 + u_energy * 0.14);
  col += paletteRamp(0.2) * haze * 0.006;

  // The colour is already light, so alpha follows its brightest channel: a dim
  // beam stays its own colour at low coverage instead of being squared down.
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 0.8);
  return vec4(col / max(a, 0.001), a);
}
`,
};
