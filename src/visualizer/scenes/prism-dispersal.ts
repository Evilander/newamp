// Prism Dispersal — a double-terminated quartz crystal turning slowly in the
// middle of the frame, lit by two beams, one for each stereo channel. The left
// channel's beam comes in from the upper left and the right channel's from the
// upper right; the pan tilts the pair about the crystal and a wide stereo image
// opens them apart. Each beam leaves the crystal as a fan of 24 rays, one per
// mel band, and the fans sweep across the frame because the crystal is turning:
// the angle a hexagonal crystal bends light by repeats every sixty degrees of
// turn, so the sweep repeats as each facet comes round. Where the fans reach the
// floor they pool into a soft spectrum, the bed of colour a real prism throws
// on a table.
//
// The crystal is drawn as a solid, not a sketch: for every pixel the front face
// of a six-sided column with pointed ends is found by intersecting the view ray
// with the six facet planes, and each facet is lit by the two beams with its
// real normal. A facet is tied to four of the 24 bands (facet 0 to bands 0-3 and
// so on round the crystal), so the spectrum is written on the faces as they
// pass. A tonal sound is a set of separate rays, a noisy one melts into a smooth
// smear (u_flatness blends the two), a kick thickens the beams and warms the
// glass, a hat glints on the facet corners and the two tips.

import type { SceneDef } from './index';

export const prismDispersal: SceneDef = {
  id: 'prism-dispersal',
  name: 'Prism Dispersal',
  mood: 'mid',
  // The crystal turns on the clock and the loudness changes how fast, never
  // where it is; the fans ride the same angle, so they stay locked to it.
  speed: f => 0.28 + f.energy * 0.5,
  // Light, not paint: the trail shows through the beams, the fans and the glass.
  occlusion: 0.1,
  frag: `
const float PD_TAU = 6.28318530718;
const float PD_APO = 0.2;  // apothem of the column
const float PD_HALF = 0.53; // half the crystal's height, tip to centre
const float PD_GIRDLE = 0.2; // where the column ends and the points begin
const float PD_FLOOR = -0.82; // the plane the fans pool on

// Emitted light as straight colour: the runtime premultiplies by alpha, so
// handing it col / alpha writes col itself. Alpha rises to its cap over the
// first fifth of a unit of light and stays there, which keeps the brightness in
// the colour: the runtime's contrast curve and highlight shoulder act on the
// straight colour, so they reach this scene's haze and floors as they do every
// other scene's. The shoulder, not a cap here, rolls off an overdriven ray.
vec4 emit(vec3 col, float cap) {
  float m = max(col.r, max(col.g, col.b));
  float a = cap * clamp(m * 5.0, 0.0, 1.0);
  return vec4(col / max(a, 0.001), a);
}

// Gaussian glow around the infinite line through o along dir (unit length).
float lineGlow(vec2 q, vec2 o, vec2 dir, float w) {
  vec2 rel = q - o;
  float across = rel.x * dir.y - rel.y * dir.x;
  return exp(-across * across / (w * w));
}

// Half the crystal's width at height y, as a fraction of the column's: 1 on
// the column, falling to 0 at the tips.
float pdTaper(float y) {
  return clamp((PD_HALF - abs(y)) / (PD_HALF - PD_GIRDLE), 0.0, 1.0);
}

// A four-point glint: a round core with a thin cross.
float pdGlint(vec2 d) {
  float core = exp(-dot(d, d) * 2600.0);
  float cross = exp(-d.x * d.x * 60000.0 - d.y * d.y * 260.0) + exp(-d.y * d.y * 60000.0 - d.x * d.x * 260.0);
  return core + 0.45 * cross;
}

// The colour of ray bf (0..24) in a fan. side is 0 for the left channel's fan
// and 1 for the right's: the left runs on the palette ramp and the right leans
// on the second accent, so the two channels are told apart by hue as well as by
// where they sit (the two ramps are one on a palette without a second accent).
// The ramp stops before the near-white light end so every ray keeps a hue and
// the band level is carried by brightness.
vec3 pdRayColor(float bf, float side) {
  float bt = clamp(bf / 24.0, 0.0, 1.0);
  float pos = 0.2 + 0.52 * bt;
  return mix(paletteRamp(pos), paletteRamp2(pos), clamp(side * 0.45 + smoothstep(0.3, 1.0, bt) * 0.55, 0.0, 1.0));
}

// The smooth reading of the bands at bf: interpolated between band centres.
float pdLevel(float bf) {
  float b2 = bf - 0.5;
  int b0 = int(clamp(floor(b2), 0.0, 23.0));
  int b1 = min(b0 + 1, 23);
  return mix(u_bands[b0], u_bands[b1], clamp(fract(b2), 0.0, 1.0));
}

// The band coordinate of a direction: the angle about the fan's mean direction
// is spread over the 24 bands, low on the left of the fan and high on the
// right. The angle is measured in the fan's own frame, so atan's seam sits
// behind the origin and never crosses the fan whichever way it points. One atan
// and a few reads however many rays there are.
float pdBand(vec2 d, float aMean, float spread) {
  vec2 ax = vec2(cos(aMean), sin(aMean));
  return (atan(dot(d, vec2(-ax.y, ax.x)), dot(d, ax)) / spread + 0.5) * 24.0;
}

// The fan from origin O leaving along aMean: light at p.
vec3 pdFan(vec2 p, vec2 O, float aMean, float spread, float side) {
  vec2 rel = p - O;
  float rl = length(rel);
  float bf = pdBand(rel, aMean, spread);
  vec2 axis = vec2(cos(aMean), sin(aMean));
  float inFan = smoothstep(0.0, 0.08, dot(rel, axis)) * smoothstep(-0.4, 0.4, bf) * (1.0 - smoothstep(23.6, 24.4, bf));
  // Smooth reading: interpolate between band centres. Spiky reading: the
  // band's own level, narrowed to a ray with a dark gap to its neighbours.
  float lvStep = u_bands[int(clamp(floor(bf), 0.0, 23.0))] * (1.0 - smoothstep(0.2, 0.5, abs(fract(bf) - 0.5)));
  float lvSmooth = pdLevel(bf);
  // Close to the crystal the rays are narrower than a pixel and would alias
  // into moire; there they merge into the smooth reading, which is also how the
  // light looks as it leaves the glass.
  float resolved = 1.0 - smoothstep(0.12, 0.5, fwidth(bf));
  float lv = mix(lvSmooth, mix(lvStep, lvSmooth, 0.25 + 0.6 * u_flatness), resolved);
  float fall = 1.0 / (1.0 + rl * 0.55);
  // Every ray starts pale at the glass and takes its colour as it travels, the
  // way dispersion separates.
  vec3 ray = mix(pdRayColor(bf, side), u_light, exp(-rl * 12.0) * 0.35);
  return ray * (0.01 + 0.03 * u_energy + pow(lv, 0.8) * 0.8) * fall * inFan;
}

// Where the fan pools on the floor, seen from a low angle: the same spectrum the
// fan carries, read along the floor line and smeared sideways over three taps
// so it sits as a soft bed of colour. A broad haze of the spectrum lies on the
// floor above the line, a thin bright edge marks the line itself, and the light
// spreads and fades below it into the reflection.
vec3 pdPool(vec2 p, vec2 O, float aMean, float spread, float side) {
  float dy = p.y - PD_FLOOR;
  float below = max(-dy, 0.0);
  // The ray reaching this column of the floor; taps at three offsets along it.
  vec3 acc = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    vec2 onFloor = vec2(p.x + float(k) * 0.13, PD_FLOOR);
    vec2 rel = onFloor - O;
    float bf = pdBand(rel, aMean, spread);
    float inside = smoothstep(-0.5, 0.8, bf) * (1.0 - smoothstep(23.2, 24.5, bf));
    acc += pdRayColor(bf, side) * (0.02 * (0.3 + u_energy) + pow(pdLevel(bf), 0.9) * 0.9) * inside * (k == 0 ? 0.5 : 0.25);
  }
  // A light spreads over more floor the farther it travelled, so the pool
  // thins with distance rather than staying a line of fixed strength.
  float travel = length(vec2(p.x, PD_FLOOR) - O);
  float line = exp(-dy * dy / 0.00018);
  // The reflection reaches as far down as the fan is wide where it lands.
  float spill = exp(-below / (0.04 + 0.1 * travel * spread)) * step(dy, 0.0);
  // The pool is a patch of floor seen at a grazing angle, so most of it lies
  // above the line as a soft ellipse of colour the fans land in.
  float haze = exp(-dy * dy / 0.02) * step(0.0, dy);
  return acc * (line * 0.5 + spill * 1.3 + haze * 1.6) / (1.0 + travel * 0.45);
}

vec4 scene(vec2 uv, vec2 p) {
  float px = 2.0 / min(u_res.x, u_res.y);
  vec2 c = vec2(0.0, 0.12);

  // The crystal's turn, in radians. The facet pattern repeats every sixty
  // degrees, so everything that follows the turn uses sin(6 * rot) and repeats
  // with it.
  float rot = u_phase * 0.55;
  float tilt = u_pan * 0.12 + 0.04 * sin(u_phase * 0.12);

  // --- the two beams ---------------------------------------------------------
  // Each comes in from off-screen at an elevation that opens with the stereo
  // width, and the pan tilts the pair about the crystal. Direction of travel
  // dL / dR points at the crystal.
  float base = 0.8 - 0.55 * u_width;
  float pt = u_pan * 0.3;
  float phiL = max(base - pt, 0.12);
  float phiR = max(base + pt, 0.12);
  vec2 dL = vec2(cos(phiL), -sin(phiL));
  vec2 dR = vec2(-cos(phiR), -sin(phiR));
  vec2 sL = c - dL * 2.4;
  vec2 sR = c - dR * 2.4;
  // The louder channel's beam is the stronger one.
  float gL = clamp(0.62 - 0.4 * u_pan, 0.2, 1.0);
  float gR = clamp(0.62 + 0.4 * u_pan, 0.2, 1.0);
  float drive = 0.16 + u_energy * 0.55 + u_kickPulse * 0.3;

  // --- the crystal -----------------------------------------------------------
  // View ray through (x, y) along z (toward the viewer). Every facet is a plane
  // n.(x, z) = a(y); the front surface is the nearest plane the ray leaves
  // through, the back surface the farthest it enters through, and the pixel is
  // inside where the front is in front of the back. The second-nearest front
  // plane gives the distance to the edge between two facets.
  vec2 q = rot2(tilt) * (p - c);
  float ap = PD_APO * pdTaper(q.y);
  float zf = 1e3, zf2 = 1e3, zb = -1e3;
  int fid = 0;
  for (int i = 0; i < 6; i++) {
    float th = rot + float(i) * (PD_TAU / 6.0);
    float s = sin(th), co = cos(th);
    float z = (ap - q.x * s) / co;
    if (co > 1e-4) {
      if (z < zf) { zf2 = zf; zf = z; fid = i; }
      else if (z < zf2) { zf2 = z; }
    } else if (co < -1e-4) {
      zb = max(zb, z);
    }
  }
  float thick = zf - zb;
  float aa = fwidth(thick) + 1e-4;
  float inside = smoothstep(0.0, aa * 1.5, thick) * step(abs(q.y), PD_HALF);

  vec3 col = vec3(0.0);

  // The front facet's normal. On the column it is horizontal; on a point it
  // leans toward the nearer tip by the slope of the point.
  float thF = rot + float(fid) * (PD_TAU / 6.0);
  float slope = PD_APO / (PD_HALF - PD_GIRDLE);
  float onPoint = step(PD_GIRDLE, abs(q.y));
  vec3 nf = normalize(vec3(sin(thF), sign(q.y) * slope * onPoint, cos(thF)));
  // Back to the screen frame so the normal turns with the tilt.
  nf.xy = rot2(-tilt) * nf.xy;

  // Facet tint and band level: facet i carries four of the bands.
  int b4 = fid * 4;
  float facetLv = 0.25 * (u_bands[b4] + u_bands[b4 + 1] + u_bands[b4 + 2] + u_bands[b4 + 3]);
  float ft = 0.25 + 0.4 * float(fid) / 5.0;
  ft += q.y * 0.35;
  // Lit by both beams: a broad diffuse lobe, and a tight highlight from the
  // half vector with the viewer. Light comes from the side the beam started on.
  vec3 lL = normalize(vec3(-dL, 0.5));
  vec3 lR = normalize(vec3(-dR, 0.5));
  vec3 hL = normalize(lL + vec3(0.0, 0.0, 1.0));
  vec3 hR = normalize(lR + vec3(0.0, 0.0, 1.0));
  float difL = max(dot(nf, lL), 0.0);
  float difR = max(dot(nf, lR), 0.0);
  float spL = pow(max(dot(nf, hL), 0.0), 18.0);
  float spR = pow(max(dot(nf, hR), 0.0), 18.0);
  float rim = sq(1.0 - clamp(nf.z, 0.0, 1.0));
  // A facet takes the hue of the beam that lights it: faces turned to the left
  // channel's beam lean on the ramp, those turned to the right's on the second
  // accent, and the colour slides along the facet from its base to its point.
  float lean = difR / (difL + difR + 0.001);
  vec3 facetTint = mix(paletteRamp(ft), paletteRamp2(ft), lean);
  vec3 glassBody = facetTint * (0.07 + facetLv * 0.16 + u_bass * 0.1 + u_kickPulse * 0.05)
                 + facetTint * (difL * gL + difR * gR) * (0.08 + u_energy * 0.12);
  // The highlights are the beams themselves bouncing off the facet, so they
  // take the beam's own tint rather than the facet's.
  vec3 tintL = mix(u_light, u_accent, 0.25);
  vec3 tintR = mix(u_light, u_accent2, 0.25);
  vec3 glassSpec = tintL * spL * gL + tintR * spR * gR;
  col += inside * (glassBody + glassSpec * (0.12 + u_energy * 0.55 + u_kickPulse * 0.25) + mix(u_light, facetTint, 0.5) * rim * (0.05 + u_energy * 0.1));

  // Facet edges: each is the line where the two nearest planes meet, measured in
  // pixels so it stays a hairline at any size. Brighter where the highlights are.
  float de = (zf2 - zf) / (fwidth(zf2 - zf) + 1e-4);
  float edge = exp(-de * de * 0.35) * inside;
  col += mix(u_light, facetTint, 0.35) * edge * (0.09 + u_energy * 0.2 + (spL + spR) * 0.3);
  // The girdle, where the column turns into the points.
  float gd = (abs(q.y) - PD_GIRDLE) / max(px, 0.0015);
  col += mix(u_light, u_accent, 0.3) * exp(-gd * gd * 0.5) * inside * (0.06 + u_energy * 0.16);
  // The six vertical edges again as the far side of the glass shows them, dimmer
  // than the near ones and drawn through the body. They run to the tips
  // along the taper.
  float rr = (PD_APO / 0.8660254) * pdTaper(q.y);
  float back = 0.0;
  for (int i = 0; i < 6; i++) {
    float th = rot + (float(i) + 0.5) * (PD_TAU / 6.0);
    float ex = rr * sin(th);
    float dx = (q.x - ex) / max(px, 0.0015);
    back += exp(-dx * dx * 0.4) * step(cos(th), 0.0);
  }
  col += mix(paletteRamp(0.3), u_light, 0.25) * back * inside * (0.025 + u_energy * 0.06 + u_bass * 0.05);

  // --- the beams ------------------------------------------------------------
  // Each beam runs from off-screen and stops at the glass, then shows through
  // the crystal as a fainter shaft to the centre. It narrows a little as it
  // closes on the crystal, as if focused.
  float wbase = 0.008 + u_energy * 0.007 + u_kickPulse * 0.01;
  float alongL = dot(p - sL, dL);
  float alongR = dot(p - sR, dR);
  float focusL = 0.7 + 0.3 * (1.0 - clamp(alongL / 2.4, 0.0, 1.0));
  float focusR = 0.7 + 0.3 * (1.0 - clamp(alongR / 2.4, 0.0, 1.0));
  float runL = smoothstep(0.0, 0.3, alongL) * (1.0 - smoothstep(2.1, 2.4, alongL));
  float runR = smoothstep(0.0, 0.3, alongR) * (1.0 - smoothstep(2.1, 2.4, alongR));
  float outsideGlass = 1.0 - inside;
  vec3 beamL = tintL * (lineGlow(p, sL, dL, wbase * focusL) + 0.18 * lineGlow(p, sL, dL, wbase * focusL * 5.0)) * runL;
  vec3 beamR = tintR * (lineGlow(p, sR, dR, wbase * focusR) + 0.18 * lineGlow(p, sR, dR, wbase * focusR * 5.0)) * runR;
  col += (beamL * gL + beamR * gR) * drive * (outsideGlass + inside * 0.35);

  // --- the fans -------------------------------------------------------------
  // The fan leaves the crystal turned from the way the beam was heading by the
  // deviation, which swings once per facet as the crystal turns. The left
  // beam's fan bends down and to the right, the right beam's down and to the
  // left, so they cross under the crystal as they sweep.
  float swL = 0.5 + 0.5 * sin(6.0 * rot);
  float swR = 0.5 + 0.5 * sin(6.0 * rot + 2.1);
  float aL = -phiL - (0.3 + 0.8 * swL);
  float aR = (phiR - 3.14159265) + (0.3 + 0.8 * swR);
  float spread = 0.5 + u_width * 0.4;
  vec2 oL = c + vec2(cos(aL), sin(aL)) * 0.08;
  vec2 oR = c + vec2(cos(aR), sin(aR)) * 0.08;
  float fanFloor = smoothstep(PD_FLOOR - 0.02, PD_FLOOR + 0.04, p.y);
  float vis = 1.0 - inside * 0.55;
  col += (pdFan(p, oL, aL, spread, 0.0) * gL + pdFan(p, oR, aR, spread, 1.0) * gR) * 1.3 * fanFloor * vis;

  // The pooled spectrum on the floor.
  // The pool is nothing above the floor's reach, so the rest of the frame skips it.
  if (p.y < PD_FLOOR + 0.4) {
    col += (pdPool(p, oL, aL, spread, 0.0) * gL + pdPool(p, oR, aR, spread, 1.0) * gR) * (0.7 + u_energy * 0.6);
  }

  // The crystal's centre glows with the whole sound, where both beams meet.
  col += u_light * exp(-dot(q, q) * 160.0) * inside * (0.03 + u_energy * 0.22 + u_kickPulse * 0.1);

  // --- glints ---------------------------------------------------------------
  // Hats glint on the facet corners at the girdle and on both tips. A corner
  // on the far side of the crystal is hidden by the glass.
  float gl = pdGlint(q - vec2(0.0, PD_HALF)) + pdGlint(q + vec2(0.0, PD_HALF));
  for (int i = 0; i < 6; i++) {
    float th = rot + (float(i) + 0.5) * (PD_TAU / 6.0);
    float cx = (PD_APO / 0.8660254) * sin(th);
    float front = step(0.0, cos(th));
    gl += front * 0.7 * (pdGlint(q - vec2(cx, PD_GIRDLE)) + pdGlint(q - vec2(cx, -PD_GIRDLE)));
  }
  col += mix(u_light, vec3(1.0), 0.35) * gl * (0.04 + u_hatPulse * 0.8);

  return emit(col, 0.8);
}
`,
};
