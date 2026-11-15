// Thin Film — a soap film hanging from a wire bar and filling the view. Light
// reflects off both faces of the film and the two reflections add or cancel
// according to its thickness, so the film shows bands of colour that follow
// its thickness contours. Gravity drains it: thin at the top, where it goes to
// the transparent "black film" that forms just before a bubble pops, and thick
// and pastel below, so the fringes stack closer and closer toward the bottom of
// the frame. Slow Marangoni swirls bend the contours as they sink, and a few
// black spots of film that has thinned early float up through it, each ringed
// by its own contour lines. Each colour of the palette plays one wavelength of
// the light, so the fringes run through the user's own colours, and a broad
// softbox reflection floats on the film.
// Calm music gives a few wide bands; bright music packs in more orders. A kick
// drops a ring of ripples on the film, a snare plucks it and sends a wave down
// the drain, and hats roughen it with fine wrinkles.
//
// The interference is evaluated, not simulated: three cosine reflectance curves
// at slightly different wavelengths, with the contrast between the bands fading
// as the film thickens, as coherence does in real films.
//
// Of the clock-driven motion only the wire's sway and the fringe drift survive
// the clock wrap unchanged; the spot lattice, the ragged top edge and the
// wrinkle scroll run at rates that are not binary fractions and hop once, for a
// single frame, every seven hours.

import type { SceneDef } from './index';

export const thinFilm: SceneDef = {
  id: 'thin-film',
  name: 'Thin Film',
  mood: 'calm',
  occlusion: 0.3,
  speed: f => 0.1 + f.energy * 0.3 + f.bass * 0.2,
  frag: `
const float TF_TAU = 6.28318530718;

// The wire: a hand-bent bar a little below the top edge, tilted, with a slow
// sway, that runs off both sides of the frame. The frequencies of the sway are
// binary fractions of the clock, so it carries on through the clock wrap.
float tfWireY(float x, float top) {
  return top + 0.03 * sin(x * 1.1 + u_seed * 6.0) + 0.01 * sin(x * 3.1 + u_seed * 17.0)
    + (u_seed - 0.5) * 0.06 * x + 0.012 * sin(u_phase * 0.0625) * x;
}

// Film thickness for a given depth below the wire, 0..~1.6. Thin at the top,
// thickening faster the further down it goes, so the fringes pack closer and
// closer toward the bottom of the frame.
float tfDrain(float depth) {
  float d = max(depth - 0.1, 0.0);
  return 0.62 * pow(d, 0.85) + 0.45 * d * d;
}

// Black spots: patches of film that thinned early and rise through the thicker
// film. One lattice cell holds at most one, kept clear of the cell's edge so
// only the cell under the pixel is read. It returns 0..1, how far the film is
// thinned there: the thickness falls to nothing at the core, and the contours
// between the core and the ring around it are the fringes that wrap a real spot.
float tfSpots(float x, float depth) {
  vec2 g = vec2(x * 0.62 + u_seed * 5.0, depth * 0.95 + u_phase * 0.05 + u_seed * 3.0);
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  vec2 h = hash22(cell + 11.0);
  float live = step(0.4, hash21(cell + 41.7)) * (1.0 - smoothstep(0.5, 1.3, depth));
  vec2 radii = vec2(0.2 + 0.1 * h.x, 0.14 + 0.07 * h.y);
  vec2 d = (f - (h - 0.5) * vec2(0.2, 0.3)) / radii;
  // Irregular edge: a spot is never an ellipse.
  float ang = atan(d.y, d.x);
  float e = length(d) * (1.0 + 0.18 * sin(3.0 * ang + h.x * 20.0) + 0.1 * sin(5.0 * ang + h.y * 20.0));
  return live * (1.0 - smoothstep(0.45, 1.3, e));
}

vec4 scene(vec2 uv, vec2 p) {
  float px = 2.0 / min(u_res.x, u_res.y);
  vec2 ext = u_res / min(u_res.x, u_res.y);
  float wy = tfWireY(p.x, ext.y - 0.16);
  float depth0 = wy - p.y;
  // Above the wire there is nothing to draw.
  if (depth0 < -0.05) return vec4(0.0);

  // The softbox hangs upper left of centre and drifts toward the side the
  // mix leans to; the vocal lifts it.
  vec2 hc = vec2(-0.45 * ext.x + u_pan * 0.25, 0.28 + u_vocal * 0.15);

  // The wire: a thin bright core in a darker body, brightest where it passes
  // the softbox, so it reads as metal and not a glowing line.
  float wd = abs(depth0);
  float glint = exp(-pow((p.x - hc.x) * 0.8, 2.0));
  float body = 1.0 - smoothstep(0.011 - px, 0.011 + px, wd);
  float core = 1.0 - smoothstep(0.0042 - px, 0.0042 + px, abs(depth0 - 0.003));
  vec3 col = paletteRamp(0.5) * body * (0.05 + u_energy * 0.1)
    + mix(paletteRamp(0.75), u_light, glint) * core * (0.1 + glint * 0.25 + u_energy * 0.45);

  // The film's top edge is ragged where the thin film meets the wire.
  float t1 = bandClock(0, 5) * 0.06 + u_phase * 0.04;
  float rag = vnoise(vec2(p.x * 1.2 + u_seed * 9.0, t1)) - 0.5;
  float depth = max(depth0 + rag * 0.3 * smoothstep(0.0, 0.25, depth0), 0.0);

  float spot = tfSpots(p.x, depth);
  float thBase = tfDrain(depth) * (1.0 - spot);

  vec2 flow = vec2(0.0);
  float th = 0.0;
  // Where the film is as thin as the black film nothing of it shows, whatever
  // the swirl does to it, so the work below is skipped there. The swirl, the
  // ripples and the sharpening can at most double a thickness.
  if (depth0 > 0.0 && thBase > 0.01) {
    // Marangoni swirl: flow warps the coordinates a noise is read in, and the
    // noise multiplies the thickness, which keeps the black film black.
    vec2 s = vec2(p.x * 0.7, depth * 1.2) + u_seed * 11.0;
    flow = vec2(vnoise(s + vec2(t1, -t1 * 0.7)), vnoise(s + vec2(7.3 - t1 * 0.6, 2.1 + t1))) - 0.5;
    float down = u_phase * 0.0625;
    float swirl = (vnoise(s * vec2(1.3, 2.1) + flow * 2.4 + vec2(0.0, -down))
      + 0.5 * vnoise(s * vec2(2.7, 4.3) + flow * 4.0 + vec2(3.1, -down * 1.7))) / 1.5;
    float wrinkle = vnoise(p * vec2(5.0, 15.0) + vec2(bandClock(14, 23) * 0.15, u_seed * 5.0 - u_phase * 0.2)) - 0.5;
    float disturb = (swirl - 0.5) * (0.22 + 0.3 * smoothstep(0.1, 1.3, depth)) + wrinkle * (0.01 + u_hat * 0.06);

    // A kick drops a pebble: a ring of ripples that spreads from a spot picked
    // by the kick count. Its radius follows how far the pulse has decayed, so
    // the ring is an envelope and not a clock.
    vec2 pebble = (hash22(vec2(floor(u_kickCount), 3.1 + u_seed * 17.0)) - 0.5) * vec2(ext.x * 1.4, 1.2);
    float rr = length(p - pebble);
    float ringW = (rr - (1.0 - u_kickPulse) * 1.6) * 6.0;
    disturb += sin(rr * 26.0) * exp(-ringW * ringW) * u_kickPulse * 0.14;
    // A snare plucks the film: a wave front that runs down it.
    float pluck = (depth - (1.0 - u_snarePulse) * 2.2) * 5.0;
    disturb += sin(depth * 34.0) * exp(-pluck * pluck) * u_snarePulse * 0.1;

    th = thBase * (1.0 + disturb) + u_bass * 0.05 * smoothstep(0.0, 0.5, thBase);

    // Brighter sound packs in more interference orders. The exponent stays low so
    // calm bands are broad washes and loud ones crisp without ever opening gaps.
    // The drift is outside the product with the orders, so a change in the
    // orders moves the bands by a bounded amount and the clock moves them on.
    // Its angular rates are binary fractions, so the fringes carry on through
    // the clock wrap, which needs the second and third wavelengths to be
    // 21/16 and 7/4 of the first instead of rounder numbers.
    float orders = 8.0 + u_centroid * 10.0;
    float sharp = 1.0 + u_centroid * 0.6 + u_kickPulse * 0.5;
    // Fringes finer than about four pixels would alias, so their contrast
    // eases to the mean as the rate approaches that. The rate is estimated
    // from the drain alone, which carries most of it.
    float rate = orders * (0.53 * pow(max(depth, 0.02), -0.15) + 0.9 * depth) * (1.0 + abs(disturb)) * px;
    float visAA = 1.0 - smoothstep(0.1, 0.26, rate);
    // Contrast between the bands fades as the film thickens, easing toward a
    // pale middle band. A real film always keeps a base reflectance, so even
    // where the bands part it stays silvery.
    float vis = mix(1.0, 0.3, smoothstep(0.35, 1.2, th)) * visAA;
    vec3 wave = vec3(1.0, 1.3125, 1.75);
    vec3 r = 0.5 - 0.5 * cos(TF_TAU * th * orders * wave - u_phase * 0.75 * wave + vec3(0.0, 0.7, 1.6));
    // The cosines can land a rounding error below zero, and pow of that is NaN.
    vec3 rs = pow(max(r, 0.0), vec3(sharp));
    r = mix(vec3(0.5), rs, vis);
    // The three wavelengths are the palette's two accents and its pale tint.
    // Which accent a band is made of follows which of the first two peaks
    // there, and the pale tint comes in where the third does. The blend between
    // the accents is kept narrow: a wide one would average two hues that sit
    // far apart on the wheel into grey. The dark role fills the troughs.
    float lum = dot(r, vec3(0.4, 0.35, 0.25));
    float ratio = r.y / (r.x + r.y + 0.001);
    vec3 hue = mix(paletteRamp(0.55), paletteRamp2(0.55), smoothstep(0.35, 0.65, ratio));
    // The pale tint is a tint of the light role, taken at full weight on the
    // crest of the third wavelength, so thin silvery ribbons run between the
    // two accent bands.
    hue = mix(hue, mix(u_light, vec3(1.0), 0.35), smoothstep(0.55, 0.95, r.z));
    // The troughs are not black except at the thin end: an old film keeps a
    // mid-tone between its bands, which is what stops it reading as stone.
    float thick = smoothstep(0.25, 0.9, th);
    vec3 trough = mix(paletteRamp(0.18), paletteRamp(0.45), thick) * mix(0.15, 0.45, thick);
    vec3 film = hue * (0.08 + 1.15 * lum) + trough;

    float black = smoothstep(0.02, 0.1, th);
    float gain = 0.02 + pow(u_energy, 0.7) + u_kickPulse * 0.08;
    col += film * 0.55 * gain * black;
  }

  // The softbox reflected in the film: a broad feathered glow with no edge to
  // speak of, bent by the flow and stronger where the film is thick enough to
  // mirror. A dimmer fill sits opposite it. Both are absent in silence.
  vec2 hq = (p - hc + flow * 0.4) / vec2(0.7, 1.0);
  float soft = exp(-dot(hq, hq) * 2.0);
  vec2 fq = (p - vec2(0.55 * ext.x, -0.45) + flow * 0.4) / vec2(0.9, 0.6);
  float fill = exp(-dot(fq, fq) * 2.4);
  float mirror = mix(0.25, 1.0, smoothstep(0.05, 0.5, th)) * step(0.0, depth0);
  col += mix(u_light, vec3(1.0), 0.35) * (soft * (u_vocal * 0.5 + u_energy * 0.2) + fill * u_energy * 0.08) * mirror;

  // Emit light: the colour is normalised and alpha carries the brightness, so a
  // dim fringe is not squared into nothing and a bright one keeps its hue.
  float m = max(col.r, max(col.g, col.b));
  float a = min(m, 0.7);
  return vec4(col / max(m, 0.001), a);
}
`,
};
