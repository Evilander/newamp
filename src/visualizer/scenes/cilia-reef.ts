// Cilia Reef — a ciliated carpet seen from the side, five rows receding up
// the frame. Every cilium whips (fast power stroke, slow recovery, the bend
// lagging up the shaft) and the beat phase lags along the carpet, so the
// stroke travels across the field as a metachronal wave. Bass and energy
// widen the stroke and speed the beat; each kick sends a ripple outward from
// the pan position that knocks the cilia aside as it passes. Tips glow, flare on
// hat onsets, and hats run beads of light up the shafts.

import type { SceneDef } from './index';

export const ciliaReef: SceneDef = {
  id: 'cilia-reef',
  name: 'Cilia Reef',
  mood: 'mid',
  speed: f => 0.35 + f.bass * 1.2 + f.energy * 0.8,
  frag: `
const float CR_TAU = 6.28318530718;

float crTri(float x) { return abs(fract(x) * 2.0 - 1.0); }

// Beat phase of a cilium rooted at x, at fraction s up its shaft.
float crPhase(float x, float s, float row) {
  return u_phase * CR_TAU * 0.6 - x * 3.2 + row * 1.3 - s * 1.5;
}

// Kick ripple strength at x: a ring running outward from the stereo source.
float crRipple(float x, float front, float kick) {
  float dx = x - u_pan * 0.9;
  return kick * exp(-pow((abs(dx) - front) / 0.3, 2.0)) * dx / (abs(dx) + 0.15);
}

// Sideways displacement (in shaft lengths) of a cilium rooted at x, at
// fraction s up its shaft: an asymmetric whip, plus the kick ripple pushing
// outward from its source.
float crBend(float x, float s, float row, float amp, float front, float kick) {
  float ph = crPhase(x, s, row);
  float stroke = sin(ph + 0.8 * sin(ph));
  return (amp * stroke + crRipple(x, front, kick) * 0.45) * pow(s, 1.5);
}

vec4 scene(vec2 uv, vec2 p) {
  float seedOff = u_seed * 41.0;
  float life = clamp(u_energy * 1.3, 0.0, 1.0);
  float amp = 0.05 + 0.2 * clamp(u_bass * 1.2, 0.0, 1.0) + 0.06 * life;
  // Seconds since the last kick onset, read back from the decaying pulse
  // (the runtime decays it with a 130 ms time constant); the ripple front
  // runs outward from the pan position and fades over the next ~0.8 s.
  float since = log(1.0 / max(u_kickPulse, 0.002)) * 0.13;
  float front = since * 3.5;
  float kick = clamp(1.0 - since / 0.8, 0.0, 1.0);

  vec3 col = vec3(0.0);
  float cover = 0.0;
  for (int ri = 0; ri < 5; ri++) {
    float row = float(ri);
    float depth = row / 4.0;
    float base = mix(0.52, -1.02, depth);
    float len = mix(0.24, 0.74, depth);
    float spacing = mix(0.026, 0.07, depth);
    float wid = spacing * 0.17;
    float aa = 1.5 / min(u_res.x, u_res.y);
    float ground = base + 0.06 * sin(p.x * 1.6 + row * 2.1 + seedOff) + 0.03 * sin(p.x * 3.7 + row);
    float hgt = p.y - ground;
    if (hgt < -0.04 || hgt > len * 1.05) continue;

    // Which root did the shaft through this pixel grow from? Undo the bend
    // (two fixed-point steps, since the kick ripple bends sharply), then test
    // that root and its two neighbours.
    float s0 = clamp(hgt / len, 0.0, 1.0);
    float root = p.x - crBend(p.x, s0, row, amp, front, kick) * len;
    root = p.x - crBend(root, s0, row, amp, front, kick) * len;
    float k0 = floor(root / spacing + 0.5);
    vec3 rowCol = vec3(0.0);
    float rowCov = 0.0;
    for (int j = -1; j <= 1; j++) {
      float k = k0 + float(j);
      float hk = hash11(k * 1.37 + row * 17.0 + seedOff);
      float xr = (k + (hk - 0.5) * 0.5) * spacing;
      float lk = len * (0.72 + 0.28 * fract(hk * 7.1));
      float sk = hgt / lk;
      float xc = xr + crBend(xr, clamp(sk, 0.0, 1.0), row, amp, front, kick) * lk;
      float w = wid * (1.0 - 0.55 * clamp(sk, 0.0, 1.0));
      float core = smoothstep(w + aa, max(w - aa, 0.0), abs(p.x - xc)) * step(0.0, sk) * step(sk, 1.0);
      float xTip = xr + crBend(xr, 1.0, row, amp, front, kick) * lk;
      float tipD = length(vec2(p.x - xTip, hgt - lk));
      float tip = exp(-tipD * tipD / (wid * wid * 5.0));

      // Brighter through the power stroke, so the wave itself is visible.
      float stroke = 0.7 + 0.3 * sin(crPhase(xr, 1.0, row));
      float rip = abs(crRipple(xr, front, kick));
      int bi = int(mod(k + row * 5.0, 24.0));
      float hueT = 0.15 + 0.5 * clamp(sk, 0.0, 1.0) + 0.3 * crTri(u_bandTime[bi] * 0.04 + xr * 0.12 + row * 0.2);
      float beads = u_hatPulse * exp(-pow((fract(sk * 3.0 - u_phase * 1.5) - 0.5) * 8.0, 2.0)) * step(0.3, sk);

      vec3 c = paletteRamp(hueT) * core * (0.16 + 0.5 * life + rip * 1.1) * stroke;
      c += u_light * core * beads * 0.8;
      c += mix(paletteRamp(0.9), u_light, 0.4) * tip * (0.1 + 0.55 * life + u_hatPulse * 0.9 + rip * 1.0);
      rowCol += c;
      rowCov = max(rowCov, max(core, tip * 0.8));
    }
    // Rows further back sit in the haze; nearer rows cover them.
    rowCol *= mix(0.45, 1.0, depth);
    col = mix(col, rowCol / max(rowCov, 0.001), rowCov * 0.9);
    cover = max(cover, rowCov);
    // The epithelium the row grows from.
    col += paletteRamp(0.35) * exp(-hgt * hgt / 0.0006) * (0.05 + 0.12 * life) * mix(0.5, 1.0, depth);
  }

  float alpha = clamp(dot(col, vec3(0.55)) + cover * 0.1, 0.0, 0.82);
  return vec4(col, alpha);
}
`,
};
