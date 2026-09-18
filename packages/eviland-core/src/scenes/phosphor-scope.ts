// Vintage dual-trace oscilloscope — phosphor beams on a faint graticule.
// The traces are additive signals resynthesized from the 24-band spectrum
// (each partial's amplitude is its band slice), so the "waveform" genuinely
// follows the music's spectral shape. Stereo width splits the traces apart,
// pan tilts their balance, kicks flash the beam brighter, vocal presence
// warms the lower trace toward amber burn-in. Hardware-soul: the one piece
// of audio gear every studio rack owes its truth to.

import type { SceneDef } from './index';

export const phosphorScope: SceneDef = {
  id: 'phosphor-scope',
  name: 'Phosphor Scope',
  mood: 'any',
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  vec3 phosphor = mix(vec3(0.16, 1.0, 0.45), u_accent, 0.35);

  // Graticule: faint divisions + brighter center axes, waking with energy.
  vec2 g = abs(fract(p * 2.5 + 0.5) - 0.5);
  float grid = smoothstep(0.02, 0.0, min(g.x, g.y)) * (0.03 + u_energy * 0.05);
  float axes = (smoothstep(0.006, 0.0, abs(p.y)) + smoothstep(0.006, 0.0, abs(p.x)))
             * (0.04 + u_energy * 0.05);
  col += phosphor * (grid + axes);

  // Two traces resynthesized from the spectrum: six partials each, ascending
  // frequency, amplitude straight from that partial's band slice.
  float x = p.x * 3.14159;
  float yTop = 0.0;
  float yBot = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float amp = bandAvg(i * 4, i * 4 + 3);
    float freq = 2.0 + fi * fi * 1.6 + hash11(fi * 7.1 + u_seed * 91.0) * 1.3;
    float ph = u_globalTime * (2.4 + fi * 1.7) + hash11(fi * 3.3 + u_seed * 17.0) * 6.28;
    yTop += sin(x * freq + ph) * amp;
    yBot += sin(x * freq * 1.13 - ph * 1.07) * amp;
  }
  float gain = 0.15 + u_energy * 0.1 + u_kickPulse * 0.09;
  float sep = 0.36 + u_width * 0.12;
  float tA = p.y - (sep * 0.5 + u_pan * 0.08) - yTop * gain;
  float tB = p.y + (sep * 0.5 - u_pan * 0.08) - yBot * gain;

  // Beam: wide soft glow + hot core, brightness riding the music.
  float lit = 0.22 + u_energy * 0.85 + u_kickPulse * 0.5;
  float beam = smoothstep(0.055, 0.0, abs(tA)) + smoothstep(0.055, 0.0, abs(tB));
  float core = smoothstep(0.007, 0.0, abs(tA)) + smoothstep(0.007, 0.0, abs(tB));
  col += phosphor * beam * 0.16 * lit;
  col += (phosphor * 0.75 + u_light * 0.45) * core * 0.5 * lit;

  // Vocal presence burns the lower trace toward amber, snare hits strobe a
  // brief horizontal sweep-retrace ghost.
  col += vec3(1.0, 0.6, 0.2) * smoothstep(0.007, 0.0, abs(tB)) * u_vocal * 0.35;
  float retrace = u_snarePulse * smoothstep(0.5, 0.0, abs(fract(uv.x - u_globalTime * 1.7) - 0.5));
  col += phosphor * retrace * 0.08;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.62);
  return vec4(col, alpha);
}
`,
};
