// Caustic Floor — the bed of a sunlit pool seen from above. Light gathers into
// a bright, restless web of hairline filaments over a dim sand bed; a second,
// finer web slides across it at another depth. Where the near web is brightest
// the filament splits into three offset lines, dark / accent / light, the way
// white light fans out through water. A column of light stands in the water at
// the pan position when a voice is present. A counted kick sheds a ring of
// ripples from a spot on the floor, which bends the web as it passes.
//
// The web is worley F2 - F1 inverted: it is 0 on a cell boundary and grows
// inside, so 1 - edge is bright exactly where two feature points are equally
// near. No cell is ever filled. Each feature point swims on a small loop, and
// bass widens the loop, so a swell makes the whole web writhe. Peaky sound
// (high crest) sharpens the filaments to hairlines; compressed sound leaves a
// soft wide glow; noisy sound clouds the water and dims the web.

import type { SceneDef } from './index';

export const causticFloor: SceneDef = {
  id: 'caustic-floor',
  name: 'Caustic Floor',
  mood: 'mid',
  speed: f => 0.3 + f.energy * 0.8 + f.bass * 0.4,
  occlusion: 0.3,
  frag: `
const float CF_TAU = 6.28318530718;

// Nearest-two-feature worley edge measure: x is 0 on a cell boundary and grows
// inside; y is a 0..1 key hashed from the two features that meet at the wall, so
// each wall has a brightness of its own. The key is symmetric in the two features
// (their sum), so both sides of a wall agree and it stays one line. Each feature
// point swims on a loop whose radius is the swell; the jitter plus the swell stay
// within half a cell, which keeps the true nearest two inside the 3x3 search.
vec2 cfEdge(vec2 q, float swell, float seedOff) {
  vec2 ip = floor(q), fp = fract(q);
  float d1 = 1e3, d2 = 1e3;
  vec2 h1 = vec2(0.0), h2 = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 h = hash22(ip + g + seedOff);
      // One sin call gives both loop axes: cos is sin a quarter turn on.
      vec2 loop = sin(vec2(u_phase * 0.9, u_phase * 0.7) + h * CF_TAU + vec2(0.0, 1.5707963));
      vec2 pos = g + 0.5 + (h - 0.5) * 0.7 + swell * loop;
      vec2 d = pos - fp;
      float s = dot(d, d);
      if (s < d1) { d2 = d1; h2 = h1; d1 = s; h1 = h; }
      else if (s < d2) { d2 = s; h2 = h; }
    }
  }
  return vec2(sqrt(d2) - sqrt(d1), hash21(h1 + h2));
}

// A caustic net: light gathered where the surface focuses it. Real caustics are
// not uniform walls: light piles up along some folds and almost leaves others,
// so each wall is scaled by its own key and by a slow patchy swell along it. The
// swell along the wall is the same for the three dispersion samples, so the
// caller computes it once.
float cfNet(vec2 q, float swell, float sharp, float seedOff, float along) {
  vec2 e = cfEdge(q, swell, seedOff);
  // A hairline core inside a wider soft glow: the glow is what the eye reads at
  // low resolution, where the core alone would alias away.
  float line = pow(clamp(1.0 - e.x * sharp, 0.0, 1.0), 6.0)
             + (0.04 + 0.3 * u_energy) * pow(clamp(1.0 - e.x * sharp * 0.45, 0.0, 1.0), 3.0);
  // Every wall carries some light, so the web closes into a net; the keyed
  // walls stand out of it as the folds where the light has piled up.
  return line * (0.02 + 0.3 * u_energy + 1.45 * smoothstep(0.15, 0.9, e.y) * (0.45 + along));
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = floor(u_seed * 613.0);

  // A ring of ripples from the last counted kick: it moves the floor sideways,
  // so the web bends where the ring is and settles once it has passed. The spot
  // changes on the kick count, which never ticks faster than about 3 a second.
  vec2 spot = (hash22(vec2(floor(u_kickCount), seedOff + 5.3)) - 0.5) * 1.5;
  vec2 rv = p - spot;
  float rr = max(length(rv), 0.001);
  float age = (1.0 - u_kickPulse) * 1.6;
  float band = (rr - age) * 5.0;
  float ring = exp(-band * band) * u_kickPulse;
  vec2 bent = p + rv / rr * 0.09 * sin(rr * 24.0) * ring;

  // The sun's direction: the pan's integral slides the net without a jump.
  vec2 sun = vec2(u_panTime * 0.15, 0.0);
  float swell = 0.05 + u_bass * 0.1;
  // Noise softens the filaments as well as dimming them.
  float sharp = (2.6 + u_crest * 3.0) * (1.0 - u_flatness * 0.35);

  // A slow bend of the floor curves the whole lattice, and a second bend at the
  // scale of a single wall bows each wall inside its span, so the folds read as
  // refracted light and not as the straight edges of cells.
  vec2 warp = 0.28 * vec2(sin(bent.y * 1.0 + u_phase * 0.3), sin(bent.x * 0.85 - u_phase * 0.25 + 1.3));
  vec2 w1 = bent + warp;
  vec2 q1 = w1 * 2.6 + sun + vec2(0.0, bandClock(0, 4) * 0.05);
  vec2 bow = vec2(vnoise(w1 * 3.1 + vec2(u_phase * 0.07, 0.0)) - 0.5,
                  vnoise(w1 * 3.1 + vec2(7.3, -u_phase * 0.06)) - 0.5)
           + 0.4 * vec2(vnoise(w1 * 7.3 + vec2(-u_phase * 0.09, 2.1)) - 0.5,
                        vnoise(w1 * 7.3 + vec2(4.4, u_phase * 0.08)) - 0.5);
  q1 += 0.7 * bow;
  vec2 qf = w1 * 5.4 - sun * 0.6 + vec2(bandClock(16, 23) * 0.04, u_phase * 0.03) + 1.4 * bow;

  float alongNear = vnoise(q1 * 0.55 + vec2(u_phase * 0.05, 3.7));
  float alongFine = vnoise(qf * 0.55 + vec2(u_phase * 0.05, 3.7));

  // The near net is sampled three times for dispersion; the split widens with
  // the stereo width but stays narrow, because real dispersion only shows where
  // the light is gathered most.
  vec2 split = vec2(0.012 + u_width * 0.03) * vec2(0.8, 0.6);
  float nD = cfNet(q1 - split, swell, sharp, seedOff, alongNear);
  float nA = cfNet(q1,         swell, sharp, seedOff, alongNear);
  float nL = cfNet(q1 + split, swell, sharp, seedOff, alongNear);
  // The deeper, finer net: smaller ripples riding the hat clock.
  float fine = cfNet(qf, swell * 0.5, sharp * 0.8, seedOff + 31.0, alongFine);

  // Sun breaking through cloud: kicks and loudness lift the whole web, but only
  // by a bounded amount, so a kick is a swell of light and not a full-frame flash.
  // Silence leaves a faint net on a dim bed.
  float flash = 0.06 + u_energy * 0.9 + u_kickPulse * 0.4;
  // A wall is one filament in the accent; only the brightest knots fan out into
  // the light and shade samples on either side.
  float knot = smoothstep(0.45, 1.0, nA);
  vec3 col = u_accent * nA
           + knot * (mix(u_light, u_accent, 0.35) * nL * 0.8 + mix(paletteRamp(0.3), u_accent2, 0.5) * nD * 0.5);
  col *= flash * 0.75;
  col += mix(paletteRamp(0.7), u_accent2, 0.5) * fine * flash * (0.03 + u_energy * 0.22) * 0.75;
  // The crest of a kick ring catches the light, so a kick shows as a bright arc
  // of filaments sweeping outward from the spot.
  col += u_light * ring * nA * 0.35;

  // A column of light stands where the voice is, at the pan position, flickering
  // with the water above it. It runs through the second accent so the voice
  // stands apart from the web, which is the first.
  float shaft = exp(-sq((p.x - u_pan * 0.7) * 1.8)) * smoothstep(-1.2, 0.8, p.y) * u_vocal * 0.25;
  col += paletteRamp2(0.6) * shaft * (0.6 + fbm(p * 2.0 + vec2(0.0, u_phase * 0.2)) * 0.8);

  // A noisy sound clouds the water and dims the net.
  col *= 1.0 - u_flatness * 0.5;
  // Sand bed, barely there: silence is a dim floor, not a black frame.
  col += paletteRamp(0.2) * (0.02 + u_energy * 0.03) * (0.4 + vnoise(p * 6.0 + sun));

  // The colour is already light, so alpha follows its brightest channel: a dim
  // filament stays its own colour at low coverage instead of being squared down.
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 0.75);
  return vec4(col / max(a, 0.001), a);
}
`,
};
