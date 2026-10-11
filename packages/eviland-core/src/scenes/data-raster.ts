// Data Raster — a hard-edged, one-bit strip display. Eight horizontal strips of
// barcode: how many bars are lit comes from three bands of the spectrum, their
// widths are re-rolled on each counted kick, and a different strip flips to
// its negative on every kick. A thin scan line follows a waveform drawn from
// the spectrum across the middle. Ink is the light colour and everything else
// is painted dark, so the look is as monochrome as the palette it is given.
//
// The bar pattern is re-rolled only when the kick counter moves, and the
// counter never moves more than about three times a second, so the picture
// does not strobe: one strip in eight inverts per count, the rest of the
// pattern changes at the same pace. Band levels move the bar density
// smoothly between counts.

import type { SceneDef } from './index';

export const dataRaster: SceneDef = {
  id: 'data-raster',
  name: 'Data Raster',
  mood: 'high',
  // Bars are painted, lit or dark: nothing of the trail shows through them.
  occlusion: 1.0,
  speed: f => 0.4 + f.energy * 1.4,
  frag: `
const float DR_TAU = 6.28318530718;

vec4 scene(vec2 uv, vec2 p) {
  // The strips fill the middle 80% of the frame, 8 rows with a gap between.
  float y = (uv.y - 0.1) / 0.8;
  float inStack = step(0.0, y) * step(y, 1.0);
  float row = clamp(floor(y * 8.0), 0.0, 7.0);
  float within = fract(y * 8.0);
  float inRow = inStack * step(0.14, within) * step(within, 0.86);
  int strip = int(row);

  float kicks = floor(u_kickCount);
  float level = bandAvg(strip * 3, strip * 3 + 2);

  // Two run lengths XORed give bars of uneven width: a fine one set by the
  // strip and the kick, a coarse one that opens and closes whole stretches.
  float cells = 120.0;
  float x = uv.x * cells;
  float fine = 1.0 + floor(hash11(row * 7.3 + kicks * 1.91 + u_seed * 41.0) * 5.0);
  float coarse = 4.0 + floor(hash11(row * 3.1 + kicks * 0.73 + u_seed * 17.0) * 9.0);
  float density = 0.12 + level * 0.78;
  float bar = step(1.0 - density, hash11(floor(x / fine) * 1.13 + row * 17.0 + kicks * 5.7 + u_seed * 91.0));
  float gate = step(0.8, hash11(floor(x / coarse) * 2.31 + row * 29.0 + kicks * 3.3 + u_seed * 53.0));
  float bit = abs(bar - gate);

  // Strip s flips on kicks s, s + 8, s + 16, ...: it is negative after an odd
  // number of those.
  float flips = floor((kicks + 7.0 - row) / 8.0);
  bit = abs(bit - mod(flips, 2.0));

  // Scan line: the spectrum resynthesised as a few partials, one pixel row.
  float wave = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float amp = bandAvg(i * 6, i * 6 + 5);
    wave += sin(uv.x * (6.0 + fi * fi * 5.0) * 3.14159 + u_phase * (1.3 + fi) + hash11(fi * 9.1 + u_seed * 13.0) * DR_TAU) * amp;
  }
  float scan = step(abs(uv.y - (0.5 + wave * 0.12)), 0.004);

  float ink = max(bit * inRow, scan);
  float paint = max(inRow, scan);
  return vec4(u_light * ink, paint * 0.95);
}
`,
};
