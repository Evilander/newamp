// Harmonic Strings — twelve strings stretched between two bridges, each held in
// one mode of the harmonic series: the bottom string swings as a single loop,
// the next as two, up to twelve loops on the top one, so the still points line
// up across the strings in the fan the series always makes. Each string is
// driven by its own pair of mel bands, low bands on the low strings, and a
// kick, snare or hat plucks the strings in its part of the range.
//
// A string moving faster than the eye is not a line but a lens of light, bright
// at its two edges where the string slows to turn round and faint in the middle
// where it passes fastest. That is drawn exactly: for a string swinging between
// -a and a, the share of its time spent below y is 1/2 + asin(y/a)/pi, and a
// pixel is as bright as the share spent inside it. At rest the whole share
// falls in one row and the lens closes to a hard line. A second, thin line is
// the string caught at one instant, moving inside its lens at a rate its band's
// integral sets. A band that sits to one side of the stereo image leans its
// string's loops toward that bridge.

import type { SceneDef } from './index';

export const harmonicStrings: SceneDef = {
  id: 'harmonic-strings',
  name: 'Harmonic Strings',
  mood: 'mid',
  occlusion: 0.25,
  frag: `
const int HS_STRINGS = 12;
const float HS_PI = 3.14159265359;

// The share of its time a string swinging between -1 and 1 spends below u.
float hsBelow(float u) { return 0.5 + asin(clamp(u, -1.0, 1.0)) / HS_PI; }

vec4 scene(vec2 uv, vec2 p) {
  float px = 2.0 / min(u_res.x, u_res.y);
  vec2 ext = u_res / min(u_res.x, u_res.y);
  float reach = ext.x * 0.88;
  float x = (p.x + reach) / (2.0 * reach);
  float pitch = 1.76 / float(HS_STRINGS);
  int row = int(floor((p.y + 0.88) / pitch));
  vec3 hot = mix(u_light, vec3(1.0), 0.35);
  vec3 col = vec3(0.0);

  if (x >= 0.0 && x <= 1.0) {
    // A loud string swings past its neighbours' rest lines, so the strings
    // either side of the pixel's own are drawn too.
    for (int o = -1; o <= 1; o++) {
      int i = row + o;
      if (i < 0 || i >= HS_STRINGS) continue;
      float fi = float(i);
      float t = fi / float(HS_STRINGS - 1);
      // The mel bands fall away toward the top of the range; the strings are
      // levelled so the high ones swing as visibly as the low.
      float level = min(0.5 * (u_bands[2 * i] + u_bands[2 * i + 1]) * (1.0 + 0.9 * t), 1.0);
      float pan = 0.5 * (u_bandPan[2 * i] + u_bandPan[2 * i + 1]);
      float clock = 0.5 * (u_bandTime[2 * i] + u_bandTime[2 * i + 1]);
      float low = 1.0 - smoothstep(0.0, 0.35, t);
      float mid = exp(-(t - 0.5) * (t - 0.5) * 16.0);
      float high = smoothstep(0.65, 1.0, t);
      float pluck = u_kickPulse * low + 0.7 * u_snarePulse * mid + 0.7 * u_hatPulse * high;
      float swing = pitch * 0.8 * min(pow(level, 0.7) * (1.0 + 0.6 * pluck) + 0.2 * pluck, 1.25);
      float lean = 1.0 + 0.6 * pan * (2.0 * x - 1.0);
      float shape = sin((fi + 1.0) * HS_PI * x);
      float y = p.y - (pitch * (fi + 0.5) - 0.88);

      // The lens. Half a line's width is the least a string can swing: at
      // rest all of its time falls inside the line.
      float line = px * 1.4;
      float a = max(swing * lean * abs(shape), line * 0.5);
      float dwell = hsBelow((y + line) / a) - hsBelow((y - line) / a);
      vec3 ink = mix(paletteRamp(0.45 + 0.1 * t), paletteRamp2(0.5 + 0.1 * t), smoothstep(0.2, 0.8, t));
      // The square root lifts the faint middle of a wide lens into view.
      float lens = sqrt(dwell) * (0.16 + 1.5 * level + 0.5 * pluck);
      col += mix(ink, hot, dwell * dwell * 0.6) * lens;

      // The string at one instant, and the glow of a loud string on the air.
      float now = swing * lean * shape * cos(clock * 9.0 + fi * 1.7);
      float cut = (y - now) / (px * 1.3);
      col += hot * exp(-cut * cut) * (0.1 + 0.8 * level) * smoothstep(0.0, 0.02, swing);
      col += ink * exp(-abs(y) / (pitch * 0.45)) * level * level * 0.14;
    }
  }

  // The bridges the strings are tied to, and a pin at each end of a string.
  float bridge = abs(abs(p.x) - reach - 0.014) / 0.005;
  float pinY = (fract((p.y + 0.88) / pitch) - 0.5) * pitch;
  float pinX = abs(p.x) - reach;
  float pin = exp(-(pinX * pinX + pinY * pinY) / (0.008 * 0.008));
  float span = step(abs(p.y), 0.88);
  col += paletteRamp(0.42) * exp(-bridge * bridge) * span * (0.08 + 0.3 * u_energy);
  col += mix(paletteRamp(0.6), hot, 0.5) * pin * span * (0.12 + 0.5 * u_energy);

  // Emit light: the colour is normalised and alpha carries the brightness, so
  // the faint middle of a lens is not squared into nothing.
  float m = max(col.r, max(col.g, col.b));
  return vec4(col / max(m, 0.001), min(m, 0.8));
}
`,
};
