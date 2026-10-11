// Bokeh Field — an out-of-focus view for calm music. Three planes of
// hexagonal-aperture discs at different depths: a far plane of many small, dim,
// nearly sharp discs, a middle plane, and a near plane of a few large soft
// ones. Discs gather around the thirds of the frame and leave the rest empty;
// each plane drifts on its own small orbit, so the planes slide against each
// other. Every disc is wired to a mel band and glows with it. A kick pulls
// focus: the near plane swells and blurs. Nothing is opaque; the discs are
// light, not paint.

import type { SceneDef } from './index';
import { Rng } from '../eviland-rng';

// Discs per plane: far, middle, near.
const PLANES = [40, 14, 6];
const PLANE_START = PLANES.map((_, i) => PLANES.slice(0, i).reduce((a, b) => a + b, 0));
const PER_LAYOUT = PLANES.reduce((a, b) => a + b, 0);
// Where the discs sit is drawn here, once, and baked into the shader as tables.
// Hashing every disc at every pixel was the scene's whole cost. u_seed picks one
// of the layouts and flips each plane on its own axes, so a seed still gets an
// arrangement of its own.
const LAYOUTS = 4;

function layoutTables(): { pos: string; phase: string } {
  const pos: string[] = [];
  const phase: string[] = [];
  const f = (v: number): string => v.toFixed(4);
  for (let layout = 0; layout < LAYOUTS; layout++) {
    const rng = new Rng(`bokeh-field::layout::${layout}`);
    for (const count of PLANES) {
      for (let i = 0; i < count; i++) {
        const ha = [rng.next(), rng.next()];
        const hb = [rng.next(), rng.next()];
        const hc = [rng.next(), rng.next()];
        // Thirds bias: most discs gather around the crossing of a vertical and a
        // horizontal third, the rest land anywhere. Positions are in units of
        // the frame's half-extent, so they follow its aspect ratio.
        const focus = [ha[0]! < 0.5 ? -0.34 : 0.34, hb[0]! < 0.5 ? -0.34 : 0.34];
        const gathered = hc[0]! <= 0.62;
        const x = gathered ? focus[0]! + (hb[0]! - 0.5) * 0.55 : ha[0]! * 2 - 1;
        const y = gathered ? focus[1]! + (hb[1]! - 0.5) * 0.55 : ha[1]! * 2 - 1;
        pos.push(`vec4(${f(x)},${f(y)},${f(0.7 + 0.6 * hb[1]!)},${f(hb[1]!)})`);
        phase.push(`vec2(${f(hc[1]!)},${f(ha[1]!)})`);
      }
    }
  }
  return { pos: pos.join(','), phase: phase.join(',') };
}

const TABLES = layoutTables();
const DISCS = LAYOUTS * PER_LAYOUT;

export const bokehField: SceneDef = {
  id: 'bokeh-field',
  name: 'Bokeh Field',
  mood: 'calm',
  speed: f => 0.35 + f.energy * 0.5,
  frag: `
const float BK_TAU = 6.28318530718;

// Per disc: x, y (half-extent units), size factor, a 0..1 hash for tint and band.
const vec4 BK_POS[${DISCS}] = vec4[${DISCS}](${TABLES.pos});
// Per disc: orbit phase, and a second hash for the other orbit axis and the hat flash.
const vec2 BK_PHASE[${DISCS}] = vec2[${DISCS}](${TABLES.phase});

// Distance to a regular hexagon of apothem a, flat top and bottom.
float bkHex(vec2 q, float a) {
  q = abs(q);
  return max(dot(q, vec2(0.8660254, 0.5)), q.y) - a;
}

// One plane of discs, from its slice of the table. A disc stays where it was
// put; only its small orbit moves it. Almost every disc is far from a given
// pixel, so each is tested at its rest position (widened by the orbit) before
// anything else is worked out for it.
vec3 bkPlane(vec2 p, vec2 ext, float plane, int start, int count, float radius, float soft,
             float orbit, float rate, float tint, float gain, float turn) {
  vec3 col = vec3(0.0);
  vec2 flip = vec2(fract(u_seed * 7.31 + plane * 0.37) < 0.5 ? -1.0 : 1.0,
                   fract(u_seed * 13.7 + plane * 0.61) < 0.5 ? -1.0 : 1.0);
  for (int k = 0; k < 40; k++) {
    if (k >= count) break;
    int i = start + k;
    vec4 disc = BK_POS[i];
    vec2 c = disc.xy * flip * ext;
    float r = radius * disc.z;
    float reach = r + soft * 3.0;
    vec2 d = p - c;
    float wide = reach + orbit * 1.5;
    if (dot(d, d) > wide * wide * 1.6) continue;

    vec2 ph = BK_PHASE[i];
    c += orbit * vec2(sin(u_phase * rate + ph.x * BK_TAU), cos(u_phase * rate * 0.83 + ph.y * BK_TAU));
    d = p - c;
    if (dot(d, d) > reach * reach * 1.6) continue;

    float dist = bkHex(rot2(turn) * d, r);
    float fill = smoothstep(soft, -soft, dist);
    // Glass is brighter at its edge than in its middle.
    float rim = smoothstep(soft * 2.0 + 0.004, 0.0, abs(dist));
    float shape = fill * 0.45 + rim * 0.55;

    int bi = int(mod(floor(disc.w * 24.0) + plane * 5.0 + float(k) * 7.0, 24.0));
    float lit = (0.1 + u_bands[bi] * 0.9) * (0.6 + 0.4 * ph.x) + u_hatPulse * step(0.82, ph.y) * 0.35 * (1.0 - plane * 0.4);
    col += paletteRamp(clamp(tint + disc.w * 0.28 + u_centroid * 0.1, 0.0, 1.0)) * shape * lit * gain;
  }
  return col;
}

vec4 scene(vec2 uv, vec2 p) {
  vec2 ext = u_res / min(u_res.x, u_res.y);
  float turn = u_seed * 1.0471976;
  float pull = u_kickPulse;
  int table = int(min(floor(u_seed * ${LAYOUTS}.0), ${LAYOUTS - 1}.0)) * ${PER_LAYOUT};

  // Far: many, small, dim, close to sharp. Near: few, large, soft, and the
  // plane the kick pulls out of focus.
  vec3 col = bkPlane(p, ext, 0.0, table + ${PLANE_START[0]}, ${PLANES[0]}, 0.05, 0.012, 0.02, 0.25, 0.12, 0.55, turn);
  col += bkPlane(p, ext, 1.0, table + ${PLANE_START[1]}, ${PLANES[1]}, 0.13, 0.026, 0.05, 0.4, 0.38, 0.75, turn);
  col += bkPlane(p, ext, 2.0, table + ${PLANE_START[2]}, ${PLANES[2]}, 0.3 * (1.0 + 0.1 * pull), 0.07 + 0.07 * pull, 0.1, 0.6, 0.62, 0.9, turn);

  float alpha = clamp(dot(col, vec3(0.55)), 0.0, 0.35);
  return vec4(col, alpha);
}
`,
};
