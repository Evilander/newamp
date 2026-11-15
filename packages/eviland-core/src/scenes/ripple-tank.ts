// Stereo Ripple Tank — the classic two-source ripple tank, with the left and
// right channels as the two sources. Crest lines spread from two glowing
// points and, where they cross, interference draws the fan of nodal lines
// between them. Mono music pulls both sources onto the centre and leaves one
// set of rings; a wide mix pulls them apart and the fan opens. The left source
// is the palette's first accent and the right source its second, and the crest
// colour follows which of the two is stronger at that spot, so the stereo
// image is literal colour: the blend across the frame shows where the balance
// sits. The left source is
// paced by the low bands and the right by the high ones: their rates differ,
// so the nodal lines slide and beat. Everything is light; nothing covers the
// trail beneath it.
//
// What the picture is made of: f = Al*sin(k*rl - wl) + Ar*sin(k*rr - wr), with
// each amplitude falling off as 1/sqrt(1 + 3r) and f drawn relative to its
// largest possible value, so a crest is bright where the waves agree and the
// nodal lines are where they cancel. Nothing is stepped through time: the
// phases ride the band integrals.

import type { SceneDef } from './index';

// Phase of each source, in radians per unit of the band integral, summed over
// its bands. The runtime wraps every clock by 2*PI*4096 seconds; a phase moving
// at a multiple of 1/4096 radian per second turns a whole number of times over
// that wrap, so the ripples carry on through it instead of hopping. The rates
// are rounded to that grid here, once, and written into the shader.
const RATE_BASS_BANDS = 6;
const RATE_TREBLE_BANDS = 10;
const BASS_TURNS_PER_UNIT = 4.2;
const TREBLE_TURNS_PER_UNIT = 2.6;
const grid = (radiansPerUnit: number): string => (Math.round(radiansPerUnit * 4096) / 4096).toString();
const BASS_RATE = grid((2 * Math.PI * BASS_TURNS_PER_UNIT) / RATE_BASS_BANDS);
const TREBLE_RATE = grid((2 * Math.PI * TREBLE_TURNS_PER_UNIT) / RATE_TREBLE_BANDS);
// The shared drift from u_phase, on the same grid (1.5 is 6144/4096).
const DRIFT_RATE = '1.5';

const floatLiteral = (s: string): string => (s.includes('.') ? s : `${s}.0`);

export const rippleTank: SceneDef = {
  id: 'ripple-tank',
  name: 'Stereo Ripple Tank',
  mood: 'any',
  speed: f => 0.3 + f.energy * 0.3,
  occlusion: 0.2,
  frag: `
const float RT_TAU = 6.28318530718;
// Wavenumber: the same for both sources, so the nodal geometry holds still
// while the phases beat.
const float RT_K = 34.0;

// Sum of u_bandTime over a band range, not averaged: the caller multiplies by
// a rate that sits on the wrap grid.
float rtBandSum(int lo, int hi) {
  float s = 0.0;
  for (int i = 0; i < 24; i++) { if (i >= lo && i <= hi) s += u_bandTime[i]; }
  return s;
}

vec4 scene(vec2 uv, vec2 p) {
  // Source separation: the stereo image as geometry.
  float sx = 0.08 + u_width * 0.8;
  float rl = length(p - vec2(-sx, 0.0));
  float rr = length(p - vec2(sx, 0.0));

  // The louder side keeps its crests; the quieter one is never switched off,
  // so the fan survives a hard-panned track as a faint second set of rings.
  float aL = 0.25 + 0.75 * (0.5 - 0.5 * u_pan);
  float aR = 0.25 + 0.75 * (0.5 + 0.5 * u_pan);
  float wl = ${floatLiteral(BASS_RATE)} * rtBandSum(0, ${RATE_BASS_BANDS - 1}) + ${DRIFT_RATE} * u_phase;
  float wr = ${floatLiteral(TREBLE_RATE)} * rtBandSum(${24 - RATE_TREBLE_BANDS}, 23) + ${DRIFT_RATE} * u_phase;

  float Al = aL * inversesqrt(1.0 + 3.0 * rl);
  float Ar = aR * inversesqrt(1.0 + 3.0 * rr);
  float f = Al * sin(RT_K * rl - wl) + Ar * sin(RT_K * rr - wr);
  float total = Al + Ar;
  float nrm = f / total;

  // Crest lines. The cut sits below one wave's own crest (0.5) so single crests
  // survive as thin lines and the crossings, squared, stay the brightest points.
  float crest = smoothstep(0.48, 0.97, nrm);
  crest *= crest;
  // Where the two waves are close in strength they can cancel completely, and
  // the nodal line is a thread of its own; far from the balance point one
  // source drowns the other and there is no line to draw.
  float balance = 4.0 * Al * Ar / (total * total);
  float node = exp(-nrm * nrm * 40.0) * balance * balance;

  // The share is taken from geometry alone, not from the pan amplitudes: a
  // hard-panned track brightens one side but must not push the whole frame to
  // one end of the palette.
  float gL = inversesqrt(1.0 + 3.0 * rl);
  float gR = inversesqrt(1.0 + 3.0 * rr);
  float who = gR / (gL + gR);
  // The gradient is stretched around an even split so it reads across the frame.
  float lean = smoothstep(0.36, 0.64, who);

  // Energy gains the field and also sets how far the ripples travel: silence is
  // a few faint rings round the sources, loud reaches the frame edges. The pool
  // has an edge that closes a little as the music gets louder, so the waves
  // sit inside a lit tank instead of papering the frame.
  float gain = 0.05 + u_energy * 0.95;
  float reach = 0.35 + 1.6 * u_energy;
  float near = min(rl, rr);
  float amp = clamp(total * 0.9, 0.0, 1.0) * smoothstep(reach, reach * 0.45, near);
  float edge = smoothstep(2.1, 1.1, max(rl, rr) * (1.0 - 0.25 * u_energy));
  amp *= edge;

  // Each crest takes its colour from the wave that is actually cresting, not
  // from where the pixel sits: the two accents can be complementary, and a mix
  // of them in RGB is grey. The switch is steep so a pixel is nearly always one
  // accent or the other, which also makes the bass and treble clocks visible
  // as two sets of rings drifting against each other on a mono track. Only the
  // crossings, where both waves peak together, lean toward tinted light. A
  // palette with no second accent has the two ramps equal and the small lean
  // term keeps a gradient across the frame then.
  float waveL = Al * (0.5 + 0.5 * sin(RT_K * rl - wl));
  float waveR = Ar * (0.5 + 0.5 * sin(RT_K * rr - wr));
  float side = smoothstep(0.42, 0.58, waveR / max(waveL + waveR, 1e-4));
  float rise = 0.34 + 0.3 * crest + 0.12 * lean;
  vec3 tint = mix(paletteRamp(rise), paletteRamp2(rise), side);
  tint = mix(tint, mix(u_light, tint, 0.45), 4.0 * side * (1.0 - side) * crest);
  tint = mix(tint, mix(paletteRamp(0.92), paletteRamp2(0.92), side), crest * crest * 0.35);
  vec3 col = tint * (crest * 1.15 + 0.14 * (0.5 + 0.5 * nrm)) * amp * gain;
  // Thin lines hide the hard pick between the two accents.
  vec3 nodeTint = mix(paletteRamp(0.6 + 0.15 * lean), paletteRamp2(0.6 + 0.15 * lean), step(0.5, side));
  col += nodeTint * node * 0.45 * amp * gain * (0.6 + u_centroid * 0.4);

  // The sources: a core, a halo, and one ring thrown outward on each onset.
  // The ring's radius is a function of its own decaying pulse, not of time.
  float coreL = exp(-rl * rl * 900.0);
  float coreR = exp(-rr * rr * 900.0);
  float haloL = exp(-rl * rl * 60.0);
  float haloR = exp(-rr * rr * 60.0);
  float ringL = u_kickPulse * exp(-pow((rl - (1.0 - u_kickPulse) * 0.55) * 22.0, 2.0));
  float ringR = u_hatPulse * exp(-pow((rr - (1.0 - u_hatPulse) * 0.55) * 22.0, 2.0));
  // Each source is its own accent with a lens-hot core tinted toward the light.
  col += mix(u_accent, u_light, 0.35) * coreL * (0.25 + u_bass * 1.1)
       + u_accent * (haloL * (0.05 + u_bass * 0.25) + ringL * 0.45);
  col += mix(u_accent2, u_light, 0.35) * coreR * (0.25 + u_hat * 1.1)
       + u_accent2 * (haloR * (0.05 + u_hat * 0.25) + ringR * 0.45);

  // Emit light: straight colour is col / alpha, so the premultiplied result the
  // runtime writes is col itself and a dim ray is not squared into nothing.
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 0.8);
  return vec4(col / max(a, 0.001), a);
}
`,
};
