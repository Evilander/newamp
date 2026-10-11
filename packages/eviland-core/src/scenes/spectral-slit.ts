// Spectral Strata — a slit-scan. One thin strip at the right edge is stamped
// every frame, a cell per mel band, brighter where its band is louder. The
// Eviland field scrolls left under it with no zoom, spin or fold, so each
// passage of music is left behind as a horizontal stratum: time reads left to
// right, low bands sit at the bottom, a kick is a bright ridge and a change of
// section is a vertical seam. There is no centre. The scene is only the
// stamp; the picture is the field's memory of it.

import type { SceneDef } from './index';

export const spectralSlit: SceneDef = {
  id: 'spectral-slit',
  name: 'Spectral Strata',
  mood: 'mid',
  // The stamp lays down paint: the newest column replaces what it lands on.
  occlusion: 0.9,
  frag: `
vec4 scene(vec2 uv, vec2 p) {
  // Wide enough that two frames of scroll overlap it, so the history is one
  // continuous sheet rather than a row of dashes.
  float strip = smoothstep(0.014, 0.004, abs(uv.x - 0.83));

  float cell = uv.y * 24.0;
  int band = int(clamp(floor(cell), 0.0, 23.0));
  float level = u_bands[band];

  // A faint seam between the bands keeps the layers readable as strata.
  float edge = abs(fract(cell) - 0.5) * 2.0;
  float body = mix(0.55, 1.0, smoothstep(1.0, 0.8, edge));

  // Loud bands climb the palette toward the light; the brightness of the
  // whole sound tilts every cell a little the same way.
  float t = clamp(0.12 + level * 0.8 + u_centroid * 0.06 + (uv.y - 0.5) * 0.08, 0.0, 1.0);
  vec3 col = paletteRamp(t) * (0.12 + level * 0.95) * body;

  // The kick leaves a ridge across every band; a structural change leaves a
  // seam. Both ride the strip, so they scroll away with the rest.
  float ridge = u_kickPulse * 0.35;
  float seam = smoothstep(0.35, 0.75, u_novelty);
  col += u_light * ridge + paletteRamp(0.95) * seam * 0.6;

  // Silence still stamps, dark: a gap in the music is a dark band in the
  // landscape rather than the previous passage carrying on.
  float alpha = clamp(strip * (0.3 + level * 0.6 + ridge * 0.4 + seam * 0.4), 0.0, 0.88);
  return vec4(col, alpha);
}
`,
};
