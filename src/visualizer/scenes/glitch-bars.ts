// Horizontal datamosh slices that shear on snare hits with RGB channel split
// scaled by spectral crest and a hat-driven scanline shimmer.

import type { SceneDef } from './index';

export const glitchBars: SceneDef = {
  id: 'glitch-bars',
  name: 'Glitch Bars',
  mood: 'high',
  frag: `
float gbCell(float y, float bpmPhase, float seed) {
  return hash11(floor(y * 28.0) * 7.13 + bpmPhase + seed);
}

vec3 sliceColor(vec2 q, float seed) {
  float band = bandAvg(int(mod(floor(q.y * 10.0) * 3.0, 22.0)),
                       int(mod(floor(q.y * 10.0) * 3.0 + 3.0, 23.0)));
  float t = clamp(0.2 + band + u_centroid * 0.5, 0.0, 1.0);
  return paletteRamp(t) * (0.6 + band * 0.9 + seed * 0.2);
}

vec4 scene(vec2 uv, vec2 p) {
  // Re-randomize per pseudo-beat: floor of beatPhase wraps.
  float beatTick = floor(u_globalTime * 2.4) + floor(u_beatPhase * 4.0);
  float seedB = u_seed * 419.0 + beatTick * 0.137;

  // Quantize y into bars; each bar gets a hash-driven horizontal offset.
  float bars = 36.0 + floor(hash11(u_seed) * 28.0);
  float by = floor(uv.y * bars);
  float r1 = hash11(by * 1.7 + seedB);
  float r2 = hash11(by * 5.1 + seedB * 1.4);
  float strike = step(0.55, u_snarePulse);
  float shearAmt = (r1 - 0.5) * (0.04 + u_snarePulse * 0.45) * (0.4 + strike);
  float ox = shearAmt * (0.6 + u_energy);

  // RGB channel split scales with crest.
  float split = (u_crest * 0.03 + u_snarePulse * 0.04) * (0.5 + r2);
  vec2 quvR = vec2(uv.x + ox + split, uv.y);
  vec2 quvG = vec2(uv.x + ox,          uv.y);
  vec2 quvB = vec2(uv.x + ox - split,  uv.y);

  // Bar pattern is a vertical noise gradient sliced by floor(y*bars).
  float patR = vnoise(vec2(quvR.x * 6.0 + r1 * 9.0, by * 0.3 + seedB));
  float patG = vnoise(vec2(quvG.x * 6.0 + r1 * 9.0, by * 0.3 + seedB));
  float patB = vnoise(vec2(quvB.x * 6.0 + r1 * 9.0, by * 0.3 + seedB));

  // Only some bars are "lit" — chosen by a hash threshold modulated by energy.
  float lit = step(0.55 - u_energy * 0.45, r1);
  vec3 baseTint = sliceColor(uv, r2);

  vec3 ch = vec3(
    patR * baseTint.r,
    patG * baseTint.g,
    patB * baseTint.b
  );
  vec3 col = ch * lit * (0.4 + u_snarePulse * 1.1);

  // Scanline shimmer on hats — fine horizontal lines crawl.
  float scan = 0.5 + 0.5 * sin(uv.y * 720.0 + u_globalTime * 18.0);
  col += u_light * u_hatPulse * scan * 0.08;

  // White-flash blocks on strong snare hits (rare wide bars).
  float blockR = hash11(by * 0.27 + floor(u_globalTime * 6.0));
  float flash = step(0.985, blockR) * u_snarePulse;
  col += vec3(1.0) * flash * 0.45;

  // Edge of bar — bright stitching line per bar.
  float stitch = smoothstep(0.96, 1.0, fract(uv.y * bars)) * lit * 0.25;
  col += baseTint * stitch;

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.75);
  return vec4(col, alpha);
}
`,
};
