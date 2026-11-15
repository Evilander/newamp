// Cymatic Plate — a metal plate seen from above, dusted with fine sand, driven
// by the music. Sand slides off whatever part of the plate is shaking and
// gathers on the nodal lines, the places that stay still, so the picture is a
// live Chladni figure. Six plate modes are superposed, one per slice of the
// spectrum: the low bands drive the coarse modes and the high bands the fine
// ones, and each mode swings on its own band clock, so the nodal lines wander
// as fast as those bands play and no faster. A bright mix draws a finer figure
// than a dark one. The plate is a square, a diamond or a disc, chosen by seed;
// the disc has spokes and rings instead of a grid.
//
// Sand is drawn as grains, not as a stroke: each pixel-sized cell either holds
// a grain or does not, with odds that fall off with the distance to the nearest
// nodal line, so a line is a dense ridge with loose grains straggling off it.
// The distance is measured in pixels, w / |grad w|, so the ridge profile does
// not depend on how steep w is there; its width then scales with the screen
// height, which keeps a line the same fraction of the plate at any resolution,
// crisp at 4K and clean at low resolution.
// Peaky sound pulls the sand into thin lines. A snare strikes the plate: the
// lines widen for a moment and grains are thrown loose across it. A counted kick
// bounces the sand a little and lights the rim; every twelfth kick re-tunes the
// plate to a neighbouring family of modes: the old figure slides into the new
// one over the kick's pulse, under the rim flare. Silence leaves a faint dusting
// banked into soft drifts.
//
// The mode numbers are spatial frequencies only. Nothing animates faster than
// a band integral: each band clock rate is a multiple of a quarter and each
// u_phase rate a multiple of an eighth, so the clock wrap leaves the figure
// where it was.

import type { SceneDef } from './index';

export const cymaticPlate: SceneDef = {
  id: 'cymatic-plate',
  name: 'Cymatic Plate',
  mood: 'any',
  // The plate is a dark solid with sand on it: the trail shows through the
  // sand gaps, but not clearly.
  occlusion: 0.7,
  speed: f => 0.2 + f.energy * 0.5,
  frag: `
const float CP_PI = 3.14159265359;

// Standing-wave amplitude of one mode at q, the plate's own coordinates.
// Square and diamond plates take the symmetric pair cos(n x)cos(m y) +
// s cos(m x)cos(n y), the classic Chladni family. A disc takes angular times
// radial terms instead: n spokes crossed with rings, plus a second term with
// the roles swapped. pol is (angle, radius) of q, computed once by the caller.
float cpMode(vec2 q, vec2 pol, float n, float m, float s, float disc) {
  if (disc > 0.5) {
    float k2 = floor(m * 0.5) + 1.0;
    return cos(n * pol.x) * cos(m * 1.3 * pol.y + 0.8)
         + s * cos(k2 * pol.x) * cos(n * 1.3 * pol.y + 0.8);
  }
  vec2 a = q * CP_PI * 0.5;
  return cos(n * a.x) * cos(m * a.y) + s * cos(m * a.x) * cos(n * a.y);
}

vec4 scene(vec2 uv, vec2 p) {
  // Plate shape from the seed: 0 square, 1 diamond, 2 disc.
  float shape = floor(fract(u_seed * 3.17) * 3.0);
  float disc = step(1.5, shape);
  float diamond = step(0.5, shape) - disc;
  vec2 pr = mix(p, rot2(0.7853982) * p, diamond);
  float plateD = mix(max(abs(pr.x), abs(pr.y)) - mix(0.92, 0.68, diamond), length(p) - 0.92, disc);
  float plate = smoothstep(0.012, -0.012, plateD);

  // The driver sits off centre by the pan, so the figure leans to the louder
  // side. The bolt that holds the plate stays at the middle.
  vec2 q = pr - vec2(u_pan * 0.08, 0.0);
  vec2 pol = vec2(atan(q.y, q.x), length(q));

  // Every ~12 counted kicks the tuning table shifts: the same bands excite a
  // neighbouring family of modes. On the kick that changes the family the old
  // figure is still drawn and fades out over the pulse, so the plate is struck
  // into the new mode instead of cutting to it.
  float family = floor(u_kickCount / 12.0);
  float shift = floor(hash11(family + u_seed * 71.0) * 3.0);
  float sgn = step(0.5, hash11(family * 1.7 + u_seed * 13.0)) * 2.0 - 1.0;
  float oldFamily = family - 1.0;
  float oldShift = floor(hash11(oldFamily + u_seed * 71.0) * 3.0);
  float oldSgn = step(0.5, hash11(oldFamily * 1.7 + u_seed * 13.0)) * 2.0 - 1.0;
  float fresh = step(11.5, u_kickCount) * step(fract(u_kickCount / 12.0), 0.01) * u_kickPulse;

  // Six modes, low bands to low mode numbers. The weight is the band level
  // raised a little so the strongest modes lead and the figure stays legible,
  // with a bright mix giving the fine modes more say.
  float wNew = 0.0;
  float wOld = 0.0;
  float level = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float n = 1.0 + fi + shift;
    float m = n + 1.0 + floor(fi * 0.5);
    float nOld = 1.0 + fi + oldShift;
    float mOld = nOld + 1.0 + floor(fi * 0.5);
    float amp = bandAvg(i * 4, i * 4 + 3);
    level += amp;
    float tilt = mix(1.0, 0.45 + fi * 0.3, u_centroid);
    float osc = cos(bandClock(i * 4, i * 4 + 3) * (1.5 + fi * 0.75)
                  + u_phase * (0.25 + fi * 0.125)
                  + hash11(fi * 5.3 + u_seed * 29.0) * 6.2831853);
    float weight = pow(amp, 1.5) * tilt * osc;
    wNew += weight * cpMode(q, pol, n, m, sgn, disc);
    wOld += weight * cpMode(q, pol, nOld, mOld, oldSgn, disc);
  }
  float w = mix(wNew, wOld, fresh);

  // Distance to the nearest nodal line in pixels: w over the size of its
  // gradient is the same on any screen. A figure needs some sound behind it;
  // below that the plate holds an even dusting.
  float dpx = abs(w) / max(fwidth(w), 1e-5);
  float figure = smoothstep(0.03, 0.3, level);
  float pxScale = u_res.y * 0.5;
  float lineW = mix(0.032, 0.011, u_crest) + u_snarePulse * 0.05 + u_kickPulse * 0.008;
  float sigma = max(lineW * pxScale, 1.2);
  float near = exp(-(dpx * dpx) / (sigma * sigma));
  // At rest the dust lies in soft banks with bare patches between, which the
  // first notes then pull into lines.
  float rest = 0.1 * (0.35 + 0.65 * vnoise(pr * 5.0 + u_seed * 7.0));
  float density = mix(rest, 0.02 + 0.98 * near, figure);

  // Grains are cells a pixel or two across: one is there when its own roll
  // falls under the local density. The snare re-rolls them a few times as it
  // dies away, which reads as sand bouncing.
  float gpx = max(1.0, floor(u_res.y / 540.0 + 0.5));
  vec2 cell = floor(uv * u_res / gpx);
  float bounce = floor(u_snarePulse * 4.0);
  float roll = hash21(cell + bounce * 17.0);
  float grain = step(roll, density);
  float glint = step(0.94, hash21(cell + 311.0));

  // Loose grains thrown by the snare dust the whole plate.
  grain = max(grain, u_snarePulse * step(0.93, hash21(cell * 1.7 + floor(u_kickCount) + bounce * 3.0)));

  // Sand brightness: dim when the plate is quiet, full when it is loud. Sand
  // thins out to nothing at the very edge, where it would fall off.
  float bright = mix(0.4, 1.0, smoothstep(0.0, 0.5, u_energy));
  float edge = smoothstep(-0.015, -0.05, plateD);

  // Dense ridge held in the first accent, with only the glints climbing to the
  // light, and straggling grains in the second accent. Keeping each on its own
  // ramp stops the blend between the two accents passing through a hue the
  // palette does not contain, and stopping the ridge short of the light end
  // stops a complementary second accent washing it to grey. The grain gain
  // tops out under the tone-map knee so the ridge keeps its hue.
  float ridge = near * figure;
  float rampT = 0.3 + ridge * 0.3 + u_centroid * 0.08 + glint * 0.25;
  float sand = grain * edge * bright * (0.55 + 0.2 * hash21(cell + 91.0) + glint * 0.15);
  vec3 sandCol = mix(paletteRamp2(0.5 + u_centroid * 0.1 + glint * 0.1), paletteRamp(rampT), ridge);

  // The plate itself: near black with a faint broad sheen, a bevelled rim lit
  // from the upper left, and the bolt at the centre. A kick flares the rim.
  float sheen = 0.5 + 0.5 * dot(normalize(p + 1e-4), vec2(-0.6, 0.8)) * length(p);
  // Fine brushing across the plate keeps the dark from reading as a flat fill.
  float brushed = 0.8 + 0.4 * vnoise(vec2(p.x * 3.0, p.y * 140.0));
  vec3 plateCol = paletteRamp(0.1) * (0.05 + 0.04 * sheen) * brushed;
  vec2 axis = abs(pr.x) > abs(pr.y) ? vec2(sign(pr.x), 0.0) : vec2(0.0, sign(pr.y));
  vec2 nrm = mix(axis, normalize(p + 1e-4), disc);
  nrm = mix(nrm, rot2(-0.7853982) * nrm, diamond);
  float lit = 0.5 + 0.5 * dot(nrm, normalize(vec2(-0.6, 0.8)));
  float bevel = smoothstep(-0.03, -0.012, plateD) * plate;
  float lip = smoothstep(0.012, 0.0, abs(plateD + 0.005));
  vec3 rimCol = paletteRamp(0.55 + 0.35 * lit) * (bevel * (0.12 + 0.3 * lit) + lip * 0.25)
              * (1.0 + u_kickPulse * 1.4);

  float boltD = length(p) - 0.045;
  float bolt = smoothstep(0.006, -0.006, boltD);
  float boltRim = smoothstep(0.012, 0.0, abs(boltD));
  vec3 boltCol = paletteRamp(0.45) * boltRim * 0.35;

  // A faint halo of light off the rim when a kick lands, outside the plate.
  float halo = exp(-max(plateD, 0.0) * 28.0) * (1.0 - plate) * u_kickPulse * 0.12;

  vec3 emit = (plateCol + rimCol + boltCol) * plate + sandCol * sand * (1.0 - bolt) * plate
            + paletteRamp(0.8) * halo;
  float a = plate * clamp(0.42 + sand * 0.43 + (bevel + lip) * 0.2, 0.0, 0.85) + halo;
  vec3 col = emit / max(a, 0.05);
  return vec4(col, clamp(a, 0.0, 0.85));
}
`,
};
