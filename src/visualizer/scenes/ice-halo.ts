// Ice Halo — a low sun in a sky full of diamond dust, for calm music. The
// 22-degree halo has the hard inner edge and soft outer fade the real one has,
// with the palette standing in for its red-to-white dispersion: the dark end
// of the ramp sits on the inside edge, the light end where it fades out. Two
// sundogs flank the sun on the parhelic circle with their tails pointing away
// from it, a light pillar stands up from the sun, a fainter 46-degree ring
// sits further out, and an upper tangent arc settles over the halo when the
// music changes. Ice crystals drift down through all of it and catch the light
// most where the halo is, since that is where the optics come from. Everything
// is light on the field; nothing is painted.

import type { SceneDef } from './index';

export const iceHalo: SceneDef = {
  id: 'ice-halo',
  name: 'Ice Halo',
  mood: 'calm',
  speed: f => 0.15 + f.energy * 0.4,
  occlusion: 0.25,
  frag: `
const float IH_TAU = 6.28318530718;

// A ring of radius r: sharp on the inside, fading out, as the 22-degree halo's
// hard red edge turns white.
float ihRing(float d, float r, float soft) {
  return smoothstep(r - 0.006, r + 0.004, d) * (1.0 - smoothstep(r, r + soft, d));
}

vec4 scene(vec2 uv, vec2 p) {
  // The sun sits low and the pan slides it; bass lifts it a little.
  vec2 sun = vec2(u_pan * 0.55, -0.25 + u_bass * 0.05);
  vec2 d = p - sun;
  float dist = length(d);
  float r = 0.5 + u_bass * 0.04;
  // A brighter sound fades the halo's outer edge further out.
  float soft = 0.12 + u_centroid * 0.14;
  float haze = 1.0 - u_flatness * 0.45;
  // The floor keeps a dim sun and a faint ring in silence.
  float lit = 0.12 + u_energy * 0.7 + u_kickPulse * 0.35;

  vec3 col = vec3(0.0);

  // Sun and glare: a small hot core inside a wide, faint bloom.
  float sunCore = exp(-dist * dist * 900.0);
  col += u_light * (sunCore * 1.1 + exp(-dist * 6.0) * 0.14 + exp(-dist * 22.0) * 0.1) * (0.45 + lit + u_kickPulse * 0.3);

  // 22-degree halo: dark edge inside running to light outside. The sharp edge
  // carries the most light and the fade thins as it goes out.
  float ring = ihRing(dist, r, soft);
  float tRing = clamp((dist - r) / soft, 0.0, 1.0);
  float edge = 0.25 + 0.75 * pow(1.0 - tRing, 1.1);
  col += paletteRamp(0.22 + sqrt(tRing) * 0.75) * ring * edge * lit * haze * 1.5;

  // 46-degree halo: much fainter and wider, there only when the music is.
  float r2 = r * 2.1;
  float ring2 = ihRing(dist, r2, soft);
  float t2 = clamp((dist - r2) / soft, 0.0, 1.0);
  col += paletteRamp2(0.3 + sqrt(t2) * 0.65) * ring2 * sq(1.0 - t2) * u_energy * 0.3 * haze;

  // Sundogs on the parhelic circle at the sun's height, flung further out and
  // brighter as the stereo image widens. Each is a bright core with a tail
  // pointing away from the sun, running from the dark end of the ramp at the
  // sun side to the light end at the tip.
  float sep = r * (1.0 + u_width * 0.35);
  for (int s = 0; s < 2; s++) {
    float sg = float(s) * 2.0 - 1.0;
    vec2 dog = sun + vec2(sg * sep, 0.0);
    vec2 dd = p - dog;
    float out_ = dd.x * sg;
    vec2 core = vec2(dd.x * 1.8, dd.y * 1.3);
    float body = exp(-dot(core, core) * 60.0);
    float tail = exp(-dd.y * dd.y * 900.0) * smoothstep(-0.02, 0.03, out_) * exp(-max(out_, 0.0) * 3.5);
    float t = clamp(out_ * 1.5 + 0.1, 0.0, 1.0);
    col += paletteRamp(0.45 + t * 0.5) * (body + tail * 0.7) * (0.3 + u_width * 0.9) * lit;
    col += u_light * exp(-dot(core, core) * 700.0) * 0.5 * lit;
  }

  // Parhelic circle: a faint line at the sun's height that breathes on the
  // beat and fades with distance from the sun.
  float beat = 0.5 + 0.5 * cos(u_beatPhase * IH_TAU);
  float circle = exp(-sq((p.y - sun.y) * 70.0)) * exp(-abs(d.x) * 0.7) * (0.04 + 0.08 * beat * u_beatConf);
  col += paletteRamp2(0.8) * circle * lit;

  // Light pillar: the voice lifts a column from the sun.
  float pillarTop = u_vocal * 1.4 + 0.1;
  float pillar = exp(-sq(d.x * 14.0)) * smoothstep(0.0, 0.1, d.y) * (1.0 - smoothstep(0.0, pillarTop, d.y));
  col += paletteRamp2(0.85) * pillar * (0.2 + u_vocal * 1.1) * lit;

  // Upper tangent arc when the music changes: the wings of a low sun's arc
  // sweep up and away from the top of the halo, with a dark gap beneath so it
  // reads as its own shape rather than a thickening of the ring.
  vec2 ta = vec2(d.x * 1.2, d.y - r - 0.035);
  float arc = exp(-sq(ta.y - ta.x * ta.x * 0.8) * 1400.0) * (1.0 - smoothstep(0.15, 0.6, abs(ta.x))) * smoothstep(0.25, 0.7, u_novelty);
  col += paletteRamp(0.6) * arc * lit * 1.2;

  // Diamond dust: crystals drift down on the hat clock, and each counted kick
  // picks a different set of them to flash on the hats. Near the halo they
  // catch more light.
  vec2 lat = vec2(p.x * 60.0, p.y * 60.0 + bandClock(18, 23) * 0.6 + u_phase * 0.8);
  vec2 cid = floor(lat);
  vec2 ch = hash22(cid + floor(u_seed * 77.0));
  // Presence has its own hash: gating on ch.x while also using it as the
  // offset put every crystal at the same spot in its cell and lined them up.
  float present = step(0.9, hash21(cid * 1.37 + 5.1 + floor(u_seed * 77.0)));
  vec2 cell = fract(lat) - 0.5 - (ch - 0.5) * 0.5;
  float cd = length(cell);
  float flash = step(0.93, hash21(cid + floor(u_kickCount))) * u_hatPulse;
  float nearHalo = ring + ring2 * 0.5 + sunCore;
  // The dot is sized in pixels so it holds at any window size and quality
  // tier, and its energy is kept level as it grows.
  float cellPx = u_res.y * 0.5 / 60.0;
  float rad = min(max(0.14, 1.6 / cellPx), 0.25);
  float glint = (1.0 - smoothstep(0.0, 0.34, min(abs(cell.x), abs(cell.y)) * 2.2 + cd * 0.4)) * flash;
  float crystal = (1.0 - smoothstep(0.0, rad, cd)) * (0.14 / rad) * present * (0.08 + u_energy * 0.3 + flash * 2.0 + nearHalo * 0.5);
  col += u_light * (crystal + glint * present * 0.5);

  // Haze veil: a noisier sound reads as a milkier sky.
  col += paletteRamp(0.3) * fbm(p * 1.5 + vec2(u_phase * 0.05, 0.0)) * u_flatness * 0.05;

  // Coverage follows the brightest channel and the colour is divided back out
  // of it, so the light on the field is col itself rather than col squared.
  float alpha = clamp(max(col.r, max(col.g, col.b)) * 1.1, 0.0, 0.75);
  return vec4(col / max(alpha, 0.001), alpha);
}
`,
};
