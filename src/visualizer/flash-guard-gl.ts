// Flash guard on the GPU — flash-guard.ts as a few small WebGL2 passes that
// run after a renderer has drawn its frame, in the renderer's own context.
//
//   backbuffer ─copy─► src ──taps──► tap trackers, levels (ping-pong) + this frame's tap values
//                                        │ sum per tile, then per block
//   state (9 texels per block, ping-pong) ◄── control ◄── last frame's shown block stats
//   field (32x18, two targets) ◄── strictest plan of the blocks around each tile
//   src + field + taps ──shown taps──► displayed tap trackers + values ──► shown block stats (next frame)
//   src + field + taps ──composite──► backbuffer
//
// Nothing is read back to the CPU, so the guard adds no pipeline stall and
// no latency: the frame a flash starts on is the frame it is limited on. The
// composite is an exact copy wherever nothing is limited, which is everywhere
// on calm content. captureStream(), capturePage and the compositor all see the
// guarded backbuffer, so recordings and replays carry the same limit.
//
// State lives in RGBA32F (EXT_color_buffer_float). Without it the guard is
// unavailable and callers fall back to a route that has one (see
// flash-guard-2d.ts), never to an unguarded output.

import {
  AREA_FRACTION,
  AREA_TAU_S,
  BAND_HALF,
  DARK_LIMIT,
  EMPTY_AGE,
  FLASH_GUARD_COLS,
  FLASH_GUARD_ROWS,
  FLOOR_TAU_S,
  GENERAL_DELTA,
  HAZARD_AREA,
  HOLD_GENERAL,
  HOLD_RED,
  LEVEL_TAU_S,
  MAX_BOOST,
  MAX_TAPS_PER_TILE,
  MAX_TRANSITIONS,
  OVER_RATE,
  RATE_TAU_S,
  RECENT_S,
  RECOVER_GENERAL_PER_S,
  RECOVER_RED_PER_S,
  RED_DELTA,
  RED_RATIO,
  RELEASE_PER_S,
  blockShape,
  tapGrid,
} from './flash-guard';

export interface FlashGuardGL {
  /**
   * Guard what the host just drew into the default framebuffer, in place.
   * Call right after the renderer's last draw of the frame. `screenFraction`
   * is the share of the screen the canvas covers (see screenFractionOf);
   * below HAZARD_AREA nothing on it can be a hazard and the call is free.
   */
  apply(dtMs: number, screenFraction: number): void;
  /**
   * Draw `source` (a 2D canvas the host painted) to this context's canvas,
   * guarded. The canvas is sized to the source. Pass screenFraction 0 to
   * draw it unguarded.
   */
  present(source: HTMLCanvasElement | OffscreenCanvas, dtMs: number, screenFraction: number): void;
  /** Forget all history (e.g. after the user turns protection back on). */
  reset(): void;
  dispose(): void;
}

const COLS = FLASH_GUARD_COLS;
const ROWS = FLASH_GUARD_ROWS;
const STATE_TEXELS = 9;
const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float redSat(vec3 c) {
  float sum = c.r + c.g + c.b;
  return sum > 0.0 && c.r >= ${f(RED_RATIO)} * sum ? max(0.0, c.r - c.g - c.b) : 0.0;
}
// The spec's track(): a peak/valley tracker packed as phase * (extremum + 1).
// Returns +1 for a completed rise, -1 for a completed fall, else 0.
float track(inout float enc, float v, float delta, float darkLimit) {
  float phase = enc < 0.0 ? -1.0 : 1.0;
  float ext = abs(enc) - 1.0;
  float dir = 0.0;
  if (phase < 0.0) {
    if (v < ext) {
      ext = v;
    } else if (v - ext >= delta && ext < darkLimit) {
      phase = 1.0;
      ext = v;
      dir = 1.0;
    }
  } else if (v > ext) {
    ext = v;
  } else if (ext - v >= delta && v < darkLimit) {
    phase = -1.0;
    ext = v;
    dir = -1.0;
  }
  enc = phase * (ext + 1.0);
  return dir;
}`;

// The pixel a tap samples: the spec's tapX/tapY, a fixed spot in its cell
// from the same integer hash, in integers so both pick the same pixel.
const TAP_PIXEL = `
uniform vec2 u_srcSize;
uniform vec2 u_taps;
uint tapHash(ivec2 tap) {
  uint h = uint(tap.x) * 0x8da6b343u ^ uint(tap.y) * 0xd8163841u;
  h ^= h >> 13;
  h *= 0x5bd1e995u;
  return h ^ (h >> 15);
}
ivec2 tapPixel(ivec2 tap) {
  uint h = tapHash(tap);
  uvec2 size = uvec2(u_srcSize);
  uvec2 p = ((uvec2(tap) * 256u + uvec2(h & 255u, (h >> 8) & 255u)) * size) / (uvec2(u_taps) * 256u);
  return ivec2(min(p, size - 1u));
}`;

// The spec's guardTap() and applyGuard(): what one pixel shows. Shared by the
// shown-taps pass and the composite, so what is measured is exactly what is
// drawn. The encoded source colour comes back untouched where nothing applies.
const SHOWN = `
uniform sampler2D u_fieldA;
uniform sampler2D u_fieldB;
uniform sampler2D u_tapIn;
uniform sampler2D u_tapOut;
vec3 shownPixel(vec3 src, ivec2 p) {
  vec2 uv = (vec2(p) + 0.5) / u_srcSize;
  vec4 field = texture(u_fieldA, uv);
  float holdQ = texture(u_fieldB, uv).x;
  float compress = field.z;
  float holdL = field.w;
  if (field.x >= 0.9999 && field.y >= 0.9999 && compress <= 1e-4 && holdL <= 1e-4 && holdQ <= 1e-4) return src;
  vec2 u = clamp((vec2(p) + 0.5) * u_taps / u_srcSize - 0.5, vec2(0.0), u_taps - 1.0);
  ivec2 c0 = ivec2(floor(u));
  ivec2 c1 = min(c0 + 1, ivec2(u_taps) - 1);
  vec2 w = u - vec2(c0);
  ivec2 cell[4] = ivec2[4](c0, ivec2(c1.x, c0.y), ivec2(c0.x, c1.y), c1);
  vec3 c = toLinear(src);
  float x = dot(c, LUMA);
  float q = redSat(c);
  float y = x;
  if (compress > 1e-4) {
    vec4 a = texelFetch(u_tapIn, cell[0], 0);
    vec4 b = texelFetch(u_tapIn, cell[1], 0);
    vec4 d = texelFetch(u_tapIn, cell[2], 0);
    vec4 e = texelFetch(u_tapIn, cell[3], 0);
    vec2 lf = mix(mix(a.zw, b.zw, w.x), mix(d.zw, e.zw, w.x), w.y);
    float top = min(lf.x + ${f(BAND_HALF)}, lf.y * ${f(MAX_BOOST)} + ${f(2 * BAND_HALF)});
    float banded = min(max(x, top - ${f(2 * BAND_HALF)}), min(top, x * ${f(MAX_BOOST)}));
    y = x + (banded - x) * compress;
  }
  float capL = 1e9;
  float capQ = 1e9;
  if (holdL > 1e-4 || holdQ > 1e-4) {
    for (int k = 0; k < 4; k++) {
      vec2 enc = texelFetch(u_tapOut, cell[k], 0).xy;
      vec2 ext = abs(enc) - 1.0;
      if (enc.x < 0.0 && ext.x < ${f(DARK_LIMIT)}) capL = min(capL, ext.x + ${f(HOLD_GENERAL)});
      if (enc.y < 0.0) capQ = min(capQ, ext.y + ${f(HOLD_RED)});
    }
  }
  if (holdL > 1e-4 && y > capL) y -= (y - capL) * holdL;
  y = min(y, x * field.x);
  float gain = x > 1e-6 ? y / x : 1.0;
  float desat = field.y;
  if (holdQ > 1e-4 && q > 1e-6) {
    float scaled = q * gain * desat;
    if (scaled > capQ) desat *= 1.0 - (1.0 - capQ / scaled) * holdQ;
  }
  if (abs(gain - 1.0) < 1e-4 && desat >= 0.9999) return src;
  // Pull toward the grey of equal luminance (which is what takes saturated
  // red down), then scale, which keeps the colour. A lift stops where the
  // brightest channel would clip, so it never shifts a hue.
  vec3 grey = vec3(x) + (c - vec3(x)) * desat;
  float peak = max(grey.r, max(grey.g, grey.b));
  return toSrgb(grey * (peak * gain > 1.0 ? 1.0 / peak : gain));
}`;

// Pass 1: this frame's input at every tap, its trackers, level and floor.
const TAP_IN = `${HEADER}
uniform sampler2D u_src;
uniform sampler2D u_state;
uniform float u_dt;
uniform int u_seed;
${TAP_PIXEL}
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_tap;
void main() {
  ivec2 tap = ivec2(gl_FragCoord.xy);
  vec3 c = toLinear(texelFetch(u_src, tapPixel(tap), 0).rgb);
  float x = dot(c, LUMA);
  float q = redSat(c);
  vec4 s = texelFetch(u_state, tap, 0);
  float encL = s.x;
  float encQ = s.y;
  float level = u_seed == 1 ? x : s.z;
  float lowest = u_seed == 1 ? x : s.w;
  float dirL = track(encL, x, ${f(GENERAL_DELTA)}, ${f(DARK_LIMIT)});
  float dirQ = track(encQ, q, ${f(RED_DELTA)}, 1e9);
  level += (x - level) * (1.0 - exp(-u_dt / ${f(LEVEL_TAU_S)}));
  lowest = min(x, lowest + (level - lowest) * (1.0 - exp(-u_dt / ${f(FLOOR_TAU_S)})));
  o_state = vec4(encL, encQ, level, lowest);
  o_tap = vec4(x, q, dirL, dirQ);
}`;

// Pass 2: what the composite will show at every tap (8-bit, as an analyser
// reads it), and the displayed trackers.
const TAP_OUT = `${HEADER}
uniform sampler2D u_src;
uniform int u_seed;
${TAP_PIXEL}
${SHOWN}
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_tap;
void main() {
  ivec2 tap = ivec2(gl_FragCoord.xy);
  ivec2 p = tapPixel(tap);
  vec3 shown = floor(shownPixel(texelFetch(u_src, p, 0).rgb, p) * 255.0 + 0.5) / 255.0;
  vec3 c = toLinear(shown);
  float x = dot(c, LUMA);
  float q = redSat(c);
  // Displayed trackers start at a trough of 0 with the first frame shown
  // through this tap grid.
  vec2 enc = u_seed == 1 ? vec2(-1.0) : texelFetch(u_tapOut, tap, 0).xy;
  float dirL = track(enc.x, x, ${f(GENERAL_DELTA)}, ${f(DARK_LIMIT)});
  float dirQ = track(enc.y, q, ${f(RED_DELTA)}, 1e9);
  o_state = vec4(enc, 0.0, 0.0);
  o_tap = vec4(x, q, dirL, dirQ);
}`;

// Pass 3: per tile, sums over its taps (the spec's tileOfTap ranges).
const TILE = `${HEADER}
uniform sampler2D u_taps;
uniform ivec2 u_count;
layout(location = 0) out vec4 o_a;
layout(location = 1) out vec4 o_b;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 grid = ivec2(${COLS}, ${ROWS});
  ivec2 lo = (t * u_count + grid - 1) / grid;
  ivec2 hi = ((t + 1) * u_count + grid - 1) / grid;
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  for (int j = 0; j < ${MAX_TAPS_PER_TILE}; j++) {
    if (lo.y + j >= hi.y) break;
    for (int i = 0; i < ${MAX_TAPS_PER_TILE}; i++) {
      if (lo.x + i >= hi.x) break;
      vec4 v = texelFetch(u_taps, lo + ivec2(i, j), 0);
      a += vec4(v.x, v.y, v.z > 0.5 ? 1.0 : 0.0, v.z < -0.5 ? 1.0 : 0.0);
      b += vec4(v.w > 0.5 ? 1.0 : 0.0, v.w < -0.5 ? 1.0 : 0.0, 1.0, 0.0);
    }
  }
  o_a = a;
  o_b = b;
}`;

// First tile of the block around tile i, kept whole inside the grid (the
// spec's blockOrigin).
const ORIGIN = `
int origin(int i, int size, int count) {
  return clamp(i - size / 2, 0, count - size);
}`;

// Pass 4: per block, its means and the share of its taps that rose or fell.
const BOX = `${HEADER}
uniform sampler2D u_tileA;
uniform sampler2D u_tileB;
uniform ivec2 u_block;
${ORIGIN}
layout(location = 0) out vec4 o_a;
layout(location = 1) out vec4 o_b;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int x0 = origin(t.x, u_block.x, ${COLS});
  int y0 = origin(t.y, u_block.y, ${ROWS});
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  for (int y = y0; y < y0 + u_block.y; y++) {
    for (int x = x0; x < x0 + u_block.x; x++) {
      a += texelFetch(u_tileA, ivec2(x, y), 0);
      b += texelFetch(u_tileB, ivec2(x, y), 0);
    }
  }
  float count = max(1.0, b.z);
  o_a = a / count;
  o_b = vec4(b.xy / count, 0.0, 0.0);
}`;

// Pass 5: one fragment per state texel; each recomputes its block (576
// blocks, so the redundancy is noise) and keeps its own slot:
//   0: mean trackers: input luminance, input red, shown luminance, shown red
//   1: last transition directions: input luminance, input red, shown luminance, shown red
//   2: input tap transitions adding up (rise L, fall L, rise Q, fall Q)
//   3: shown tap transitions adding up
//   4: transition ages 0-3
//   5: ages 4-5, slot of the luminance and red trackers' latest transition
//   6: input rates (luminance, red), compression, tap hold
//   7: red hold, mean caps (luminance, red; 1e9 when free)
//   8: this frame's plan: ceiling, desaturation
const CONTROL = `${HEADER}
uniform sampler2D u_state;
uniform sampler2D u_inA;
uniform sampler2D u_inB;
uniform sampler2D u_shownA;
uniform sampler2D u_shownB;
uniform float u_dt;
uniform float u_hasShown;
out vec4 o;

float blockTransition(inout float dir, inout vec2 area, float mean, float rise, float fall, float keep) {
  area = area * keep + vec2(rise, fall);
  bool rising = mean > 0.5 || area.x >= ${f(AREA_FRACTION)};
  bool falling = mean < -0.5 || area.y >= ${f(AREA_FRACTION)};
  float seen = 0.0;
  if (dir < 0.0 ? rising : falling) {
    dir = -dir;
    seen = 1.0;
  } else if (dir < 0.0 ? falling : rising) {
    seen = -1.0;
  }
  if (seen != 0.0) {
    if (dir > 0.0) area.x = 0.0;
    else area.y = 0.0;
  }
  return seen;
}

float record(inout float ages[${MAX_TRANSITIONS}], float seen, float last, float age) {
  if (seen > 0.5) {
    int oldest = 0;
    for (int k = 1; k < ${MAX_TRANSITIONS}; k++) if (ages[k] > ages[oldest]) oldest = k;
    ages[oldest] = age;
    return float(oldest);
  }
  if (seen < -0.5 && last >= 0.0) ages[int(last)] = age;
  return last;
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  int slot = cell.x % ${STATE_TEXELS};
  ivec2 b = ivec2(cell.x / ${STATE_TEXELS}, cell.y);
  int at = b.x * ${STATE_TEXELS};
  vec4 means = texelFetch(u_state, ivec2(at, b.y), 0);
  vec4 dirs = texelFetch(u_state, ivec2(at + 1, b.y), 0);
  vec4 areaIn = texelFetch(u_state, ivec2(at + 2, b.y), 0);
  vec4 areaOut = texelFetch(u_state, ivec2(at + 3, b.y), 0);
  vec4 s4 = texelFetch(u_state, ivec2(at + 4, b.y), 0);
  vec4 s5 = texelFetch(u_state, ivec2(at + 5, b.y), 0);
  vec4 s6 = texelFetch(u_state, ivec2(at + 6, b.y), 0);
  vec4 s7 = texelFetch(u_state, ivec2(at + 7, b.y), 0);
  float ages[${MAX_TRANSITIONS}];
  ages[0] = s4.x; ages[1] = s4.y; ages[2] = s4.z; ages[3] = s4.w; ages[4] = s5.x; ages[5] = s5.y;
  float lastL = s5.z;
  float lastQ = s5.w;
  float rateL = s6.x;
  float rateQ = s6.y;
  float compress = s6.z;
  float holdL = s6.w;
  float holdQ = s7.x;
  float capL = s7.y;
  float capQ = s7.z;
  float dt = u_dt;
  float keep = exp(-dt / ${f(AREA_TAU_S)});
  for (int k = 0; k < ${MAX_TRANSITIONS}; k++) ages[k] = min(${f(EMPTY_AGE)}, ages[k] + dt);

  // What the viewer saw last frame, shown dt ago.
  if (u_hasShown > 0.5) {
    vec4 sa = texelFetch(u_shownA, b, 0);
    vec4 sb = texelFetch(u_shownB, b, 0);
    vec2 area = areaOut.xy;
    float seen = blockTransition(dirs.z, area, track(means.z, sa.x, ${f(GENERAL_DELTA)}, ${f(DARK_LIMIT)}), sa.z, sa.w, keep);
    areaOut.xy = area;
    lastL = record(ages, seen, lastL, dt);
    area = areaOut.zw;
    seen = blockTransition(dirs.w, area, track(means.w, sa.y, ${f(RED_DELTA)}, 1e9), sb.x, sb.y, keep);
    areaOut.zw = area;
    lastQ = record(ages, seen, lastQ, dt);
  }

  vec4 ia = texelFetch(u_inA, b, 0);
  vec4 ib = texelFetch(u_inB, b, 0);
  float decay = exp(-dt / ${f(RATE_TAU_S)});
  vec2 area = areaIn.xy;
  rateL = rateL * decay + max(0.0, blockTransition(dirs.x, area, track(means.x, ia.x, ${f(GENERAL_DELTA)}, ${f(DARK_LIMIT)}), ia.z, ia.w, keep));
  areaIn.xy = area;
  area = areaIn.zw;
  rateQ = rateQ * decay + max(0.0, blockTransition(dirs.y, area, track(means.y, ia.y, ${f(RED_DELTA)}, 1e9), ib.x, ib.y, keep));
  areaIn.zw = area;

  int recent = 0;
  for (int k = 0; k < ${MAX_TRANSITIONS}; k++) if (ages[k] < ${f(RECENT_S)}) recent++;
  bool overL = rateL > ${f(OVER_RATE)};
  bool overQ = rateQ > ${f(OVER_RATE)};
  // A rise needs room for its own fall and the other tracker's owed one.
  bool roomL = recent + (dirs.w > 0.0 ? 1 : 0) <= ${MAX_TRANSITIONS - 2};
  bool roomQ = recent + (dirs.z > 0.0 ? 1 : 0) <= ${MAX_TRANSITIONS - 2};
  float release = ${f(RELEASE_PER_S)} * dt;
  compress = overL ? 1.0 : max(0.0, compress - release);
  holdL = roomL ? max(0.0, holdL - release) : 1.0;
  holdQ = roomQ && !overQ ? max(0.0, holdQ - release) : 1.0;

  float meanOutL = abs(means.z) - 1.0;
  if (!roomL && means.z < 0.0 && meanOutL < ${f(DARK_LIMIT)}) {
    capL = meanOutL + ${f(HOLD_GENERAL)};
  } else if (capL < 1e8) {
    capL += ${f(RECOVER_GENERAL_PER_S)} * dt;
    if (capL >= 1.0) capL = 1e9;
  }
  if ((!roomQ || overQ) && means.w < 0.0) {
    capQ = abs(means.w) - 1.0 + ${f(HOLD_RED)};
  } else if (capQ < 1e8) {
    capQ += ${f(RECOVER_RED_PER_S)} * dt;
    if (capQ >= 1.0) capQ = 1e9;
  }

  float ceiling = ${f(MAX_BOOST)};
  if (capL < 1e8 && ia.x > 1e-6) ceiling = min(ceiling, capL / ia.x);
  // Gain scales red saturation too, so a block holding red takes no more
  // gain than keeps its red under the cap.
  float desat = 1.0;
  if (capQ < 1e8 && ia.y > 1e-6) {
    desat = ia.y > capQ ? capQ / ia.y : 1.0;
    ceiling = min(ceiling, capQ / (ia.y * desat));
  }

  if (slot == 0) o = means;
  else if (slot == 1) o = dirs;
  else if (slot == 2) o = areaIn;
  else if (slot == 3) o = areaOut;
  else if (slot == 4) o = vec4(ages[0], ages[1], ages[2], ages[3]);
  else if (slot == 5) o = vec4(ages[4], ages[5], lastL, lastQ);
  else if (slot == 6) o = vec4(rateL, rateQ, compress, holdL);
  else if (slot == 7) o = vec4(holdQ, capL, capQ, 0.0);
  else o = vec4(ceiling, desat, 0.0, 0.0);
}`;

// Pass 6: each tile takes the strictest plan of every block covering it or a
// neighbour: the composite samples this bilinearly between tile centres, and
// the neighbour margin keeps every pixel of a block under that block's plan.
const FIELD = `${HEADER}
uniform sampler2D u_state;
uniform ivec2 u_block;
${ORIGIN}
layout(location = 0) out vec4 o_a;
layout(location = 1) out vec4 o_b;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  float ceiling = ${f(MAX_BOOST)};
  float desat = 1.0;
  float compress = 0.0;
  float holdL = 0.0;
  float holdQ = 0.0;
  for (int by = max(0, t.y - u_block.y - 1); by <= min(${ROWS - 1}, t.y + u_block.y + 1); by++) {
    int y0 = origin(by, u_block.y, ${ROWS});
    if (y0 > t.y + 1 || y0 + u_block.y - 1 < t.y - 1) continue;
    for (int bx = max(0, t.x - u_block.x - 1); bx <= min(${COLS - 1}, t.x + u_block.x + 1); bx++) {
      int x0 = origin(bx, u_block.x, ${COLS});
      if (x0 > t.x + 1 || x0 + u_block.x - 1 < t.x - 1) continue;
      int at = bx * ${STATE_TEXELS};
      vec4 s6 = texelFetch(u_state, ivec2(at + 6, by), 0);
      vec4 plan = texelFetch(u_state, ivec2(at + 8, by), 0);
      ceiling = min(ceiling, plan.x);
      desat = min(desat, plan.y);
      compress = max(compress, s6.z);
      holdL = max(holdL, s6.w);
      holdQ = max(holdQ, texelFetch(u_state, ivec2(at + 7, by), 0).x);
    }
  }
  o_a = vec4(ceiling, desat, compress, holdL);
  o_b = vec4(holdQ, 0.0, 0.0, 1.0);
}`;

const COMPOSITE = `${HEADER}
uniform sampler2D u_src;
uniform int u_passthrough;
${TAP_PIXEL}
${SHOWN}
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  // An exact copy where nothing is limited, so calm content is bit-identical.
  o = vec4(u_passthrough == 1 ? c.rgb : shownPixel(c.rgb, p), c.a);
}`;

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram | null {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.shaderSource(vs, VERT);
  gl.compileShader(vs);
  gl.shaderSource(fs, fragment);
  gl.compileShader(fs);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[flash-guard] shader failed to link:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

interface Target {
  textures: WebGLTexture[];
  framebuffer: WebGLFramebuffer;
}

/**
 * The share of the screen an element covers, 0..1, in CSS pixels. It sizes
 * the guard's blocks: a small panel needs most of itself flashing together
 * to reach HAZARD_AREA, a fullscreen stage a few tiles.
 */
export function screenFractionOf(el: Element | null | undefined): number {
  if (!el || typeof screen === 'undefined') return 0;
  const screenArea = Math.max(1, (screen.width || 1) * (screen.height || 1));
  return Math.max(0, Math.min(1, (el.clientWidth * el.clientHeight) / screenArea));
}

export function createFlashGuardGL(gl: WebGL2RenderingContext): FlashGuardGL | null {
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  const sources = { tapIn: TAP_IN, tapOut: TAP_OUT, tile: TILE, box: BOX, control: CONTROL, field: FIELD, composite: COMPOSITE };
  const compiled = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, compile(gl, source)])) as Record<keyof typeof sources, WebGLProgram | null>;
  const programs = Object.values(compiled);
  const vao = gl.createVertexArray();
  if (programs.some((p) => !p) || !vao) {
    for (const p of programs) gl.deleteProgram(p);
    gl.deleteVertexArray(vao);
    return null;
  }
  const P = compiled as Record<keyof typeof sources, WebGLProgram>;
  // Each program reads its textures from fixed units, set once here: per
  // frame only what is bound to those units changes.
  const samplers: Record<keyof typeof sources, string[]> = {
    tapIn: ['u_src', 'u_state'],
    tapOut: ['u_src', 'u_fieldA', 'u_fieldB', 'u_tapIn', 'u_tapOut'],
    tile: ['u_taps'],
    box: ['u_tileA', 'u_tileB'],
    control: ['u_state', 'u_inA', 'u_inB', 'u_shownA', 'u_shownB'],
    field: ['u_state'],
    composite: ['u_src', 'u_fieldA', 'u_fieldB', 'u_tapIn', 'u_tapOut'],
  };
  const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  for (const name of Object.keys(samplers) as Array<keyof typeof sources>) {
    gl.useProgram(P[name]);
    samplers[name].forEach((uniform, unit) => gl.uniform1i(gl.getUniformLocation(P[name], uniform), unit));
  }
  gl.useProgram(savedProgram);
  const uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  const loc = (program: WebGLProgram, name: string): WebGLUniformLocation | null => {
    let table = uniforms.get(program);
    if (!table) uniforms.set(program, (table = new Map()));
    if (!table.has(name)) table.set(name, gl.getUniformLocation(program, name));
    return table.get(name)!;
  };

  const deleteTarget = (t: Target | null): void => {
    if (!t) return;
    for (const texture of t.textures) gl.deleteTexture(texture);
    gl.deleteFramebuffer(t.framebuffer);
  };
  // A framebuffer over `count` same-sized textures (multiple render targets).
  const makeTarget = (width: number, height: number, internal: number, filter: number, count = 1): Target | null => {
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const textures: WebGLTexture[] = [];
    const attachments: number[] = [];
    for (let k = 0; k < count; k++) {
      const texture = gl.createTexture();
      if (!texture) break;
      textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, texture, 0);
      attachments.push(gl.COLOR_ATTACHMENT0 + k);
    }
    const target = { textures, framebuffer };
    if (textures.length !== count) {
      deleteTarget(target);
      return null;
    }
    gl.drawBuffers(attachments);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      deleteTarget(target);
      return null;
    }
    return target;
  };

  // Creation touches bindings; hand them back like every frame does.
  const savedFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const savedUnit = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const savedTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const grid = (): Target | null => makeTarget(COLS, ROWS, gl.RGBA32F, gl.NEAREST, 2);
  const tileIn = grid();
  const blockIn = grid();
  const tileOut = grid();
  const blockOut = grid();
  const states = [
    makeTarget(COLS * STATE_TEXELS, ROWS, gl.RGBA32F, gl.NEAREST),
    makeTarget(COLS * STATE_TEXELS, ROWS, gl.RGBA32F, gl.NEAREST),
  ];
  // Half float so the passes can sample it bilinearly (core in WebGL2).
  const field = makeTarget(COLS, ROWS, gl.RGBA16F, gl.LINEAR, 2);
  const src = gl.createTexture();
  gl.bindFramebuffer(gl.FRAMEBUFFER, savedFb);
  gl.bindTexture(gl.TEXTURE_2D, savedTex);
  gl.activeTexture(savedUnit);
  const fixed = [tileIn, blockIn, tileOut, blockOut, ...states, field];
  if (fixed.some((t) => !t) || !src) {
    for (const t of fixed) deleteTarget(t);
    gl.deleteTexture(src);
    for (const p of programs) gl.deleteProgram(p);
    gl.deleteVertexArray(vao);
    return null;
  }
  const T = {
    tileIn: tileIn!,
    blockIn: blockIn!,
    tileOut: tileOut!,
    blockOut: blockOut!,
    states: states as Target[],
    field: field!,
  };
  // Per-tap targets, sized to the tap grid of the current image: input
  // trackers and levels (ping-pong) with this frame's tap values beside them,
  // and the displayed trackers the same way.
  let taps: { x: number; y: number } = { x: 0, y: 0 };
  let tapIn: Target[] = [];
  let tapOut: Target[] = [];

  // Every block tracker starts at a trough of 0 (phase -1): a new surface
  // appears over black, so its first bright frame is a rise.
  const initialState = new Float32Array(COLS * STATE_TEXELS * ROWS * 4);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const base = (y * COLS * STATE_TEXELS + x * STATE_TEXELS) * 4;
      initialState.set([-1, -1, -1, -1], base);
      initialState.set([-1, -1, -1, -1], base + 4);
      initialState.set([EMPTY_AGE, EMPTY_AGE, EMPTY_AGE, EMPTY_AGE], base + 16);
      initialState.set([EMPTY_AGE, EMPTY_AGE, -1, -1], base + 20);
      initialState.set([0, 1e9, 1e9, 0], base + 28);
      initialState.set([MAX_BOOST, 1, 0, 0], base + 32);
    }
  }
  const initialField = new Float32Array(COLS * ROWS * 4);
  for (let k = 0; k < COLS * ROWS; k++) initialField.set([MAX_BOOST, 1, 0, 0], k * 4);
  const fieldB = new Float32Array(COLS * ROWS * 4);
  for (let k = 0; k < COLS * ROWS; k++) fieldB[k * 4 + 3] = 1;

  let srcW = 0;
  let srcH = 0;
  let srcFormat = 0;
  let ping = 0;
  let fresh = true;
  let seedIn = true;
  let seedOut = true;
  let hasShown = false;
  let disposed = false;
  const alpha = gl.getContextAttributes()?.alpha ?? false;

  // Everything the passes touch, so the host renderer finds its context the
  // way it left it. MilkDrop in particular keeps mipmapped sampler objects on
  // units 0-4, which would also make our single-level textures read black.
  const units = [0, 1, 2, 3, 4];
  const saved = {
    drawFb: null as WebGLFramebuffer | null,
    readFb: null as WebGLFramebuffer | null,
    viewport: null as Int32Array | null,
    program: null as WebGLProgram | null,
    vao: null as WebGLVertexArrayObject | null,
    active: 0,
    textures: units.map(() => null) as Array<WebGLTexture | null>,
    samplers: units.map(() => null) as Array<WebGLSampler | null>,
    caps: [false, false, false, false, false],
    colorMask: [true, true, true, true] as boolean[],
    flipY: false,
  };
  const CAPS = [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.CULL_FACE];

  function save(): void {
    saved.drawFb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    saved.readFb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    saved.viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    saved.program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    saved.vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    saved.active = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    for (const unit of units) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      saved.textures[unit] = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      saved.samplers[unit] = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null;
      gl.bindSampler(unit, null);
    }
    CAPS.forEach((cap, i) => {
      saved.caps[i] = gl.isEnabled(cap);
      gl.disable(cap);
    });
    // A write mask left off would let the unguarded frame through untouched.
    saved.colorMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
    gl.colorMask(true, true, true, true);
    saved.flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    gl.bindVertexArray(vao);
  }

  function restore(): void {
    gl.bindVertexArray(saved.vao);
    CAPS.forEach((cap, i) => {
      if (saved.caps[i]) gl.enable(cap);
    });
    for (const unit of units) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, saved.textures[unit] ?? null);
      gl.bindSampler(unit, saved.samplers[unit] ?? null);
    }
    gl.activeTexture(saved.active);
    gl.useProgram(saved.program);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.drawFb);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.readFb);
    if (saved.viewport) gl.viewport(saved.viewport[0]!, saved.viewport[1]!, saved.viewport[2]!, saved.viewport[3]!);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, saved.flipY);
    gl.colorMask(saved.colorMask[0]!, saved.colorMask[1]!, saved.colorMask[2]!, saved.colorMask[3]!);
  }

  function bind(unit: number, texture: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  function draw(program: WebGLProgram, t: Target | null, width: number, height: number): void {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t ? t.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
  }

  function upload(texture: WebGLTexture, width: number, height: number, data: Float32Array): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  }

  /** (Re)build the tap targets for an image w x h; false if the context can't. */
  function sizeTaps(w: number, h: number): boolean {
    const next = tapGrid(w, h);
    if (next.x === taps.x && next.y === taps.y && tapIn.length) return true;
    for (const t of [...tapIn, ...tapOut]) deleteTarget(t);
    taps = next;
    const make = (): Target | null => makeTarget(taps.x, taps.y, gl.RGBA32F, gl.NEAREST, 2);
    const built = [make(), make(), make(), make()];
    if (built.some((t) => !t)) {
      for (const t of built) deleteTarget(t);
      tapIn = [];
      tapOut = [];
      return false;
    }
    tapIn = [built[0]!, built[1]!];
    tapOut = [built[2]!, built[3]!];
    // A new tap grid starts over (the spec's resetFlashGuardTaps): input
    // trackers at a trough of 0, levels from the first frame, and displayed
    // trackers capping nothing until something has been shown through them.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const n = taps.x * taps.y;
    const inState = new Float32Array(n * 4);
    const outState = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      inState.set([-1, -1, 0, 0], k * 4);
      outState.set([2, 2, 0, 0], k * 4);
    }
    for (const t of tapIn) upload(t.textures[0]!, taps.x, taps.y, inState);
    for (const t of tapOut) upload(t.textures[0]!, taps.x, taps.y, outState);
    seedIn = true;
    seedOut = true;
    return true;
  }

  function initialise(): void {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    for (const s of T.states) upload(s.textures[0]!, COLS * STATE_TEXELS, ROWS, initialState);
    upload(T.field.textures[0]!, COLS, ROWS, initialField);
    upload(T.field.textures[1]!, COLS, ROWS, fieldB);
    taps = { x: 0, y: 0 };
    fresh = false;
    hasShown = false;
  }

  // Per tile then per block: sums of a tap pass's values and transitions.
  function reduce(tapValues: WebGLTexture, tile: Target, block: Target, shape: { w: number; h: number }): void {
    draw(P.tile, tile, COLS, ROWS);
    bind(0, tapValues);
    gl.uniform2i(loc(P.tile, 'u_count'), taps.x, taps.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    draw(P.box, block, COLS, ROWS);
    bind(0, tile.textures[0]!);
    bind(1, tile.textures[1]!);
    gl.uniform2i(loc(P.box, 'u_block'), shape.w, shape.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // The uniforms the SHOWN chunk reads, for the shown-taps pass and the composite.
  function bindShown(program: WebGLProgram, inNow: Target, outBefore: Target): void {
    bind(1, T.field.textures[0]!);
    bind(2, T.field.textures[1]!);
    bind(3, inNow.textures[0]!);
    bind(4, outBefore.textures[0]!);
    gl.uniform2f(loc(program, 'u_srcSize'), srcW, srcH);
    gl.uniform2f(loc(program, 'u_taps'), taps.x, taps.y);
  }

  /** The passes; `src` holds this frame at srcW x srcH. False if they couldn't run. */
  function guard(dtMs: number, screenFraction: number, outW: number, outH: number): boolean {
    if (fresh) initialise();
    if (!sizeTaps(srcW, srcH)) return false;
    // A NaN or infinite frame time would poison every decay for good.
    const seconds = dtMs / 1000;
    const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(10, seconds)) : 0;
    const shape = blockShape(screenFraction / (COLS * ROWS));
    const prev = T.states[ping]!;
    const next = T.states[1 - ping]!;
    const inBefore = tapIn[ping]!;
    const inNow = tapIn[1 - ping]!;
    const outBefore = tapOut[ping]!;
    const outNow = tapOut[1 - ping]!;

    // 1. This frame at every tap, then per tile and block.
    draw(P.tapIn, inNow, taps.x, taps.y);
    bind(0, src!);
    bind(1, inBefore.textures[0]!);
    gl.uniform2f(loc(P.tapIn, 'u_srcSize'), srcW, srcH);
    gl.uniform2f(loc(P.tapIn, 'u_taps'), taps.x, taps.y);
    gl.uniform1f(loc(P.tapIn, 'u_dt'), dt);
    gl.uniform1i(loc(P.tapIn, 'u_seed'), seedIn ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    reduce(inNow.textures[1]!, T.tileIn, T.blockIn, shape);

    // 2. Trackers, budget and this frame's plan per block, against what the
    // last frame showed.
    draw(P.control, next, COLS * STATE_TEXELS, ROWS);
    bind(0, prev.textures[0]!);
    bind(1, T.blockIn.textures[0]!);
    bind(2, T.blockIn.textures[1]!);
    bind(3, T.blockOut.textures[0]!);
    bind(4, T.blockOut.textures[1]!);
    gl.uniform1f(loc(P.control, 'u_dt'), dt);
    gl.uniform1f(loc(P.control, 'u_hasShown'), hasShown ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. Per tile, the strictest plan of the blocks around it.
    draw(P.field, T.field, COLS, ROWS);
    bind(0, next.textures[0]!);
    gl.uniform2i(loc(P.field, 'u_block'), shape.w, shape.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 4. What this frame will show at every tap, measured the way the input
    // was, for the next frame's plan.
    draw(P.tapOut, outNow, taps.x, taps.y);
    bind(0, src!);
    bindShown(P.tapOut, inNow, outBefore);
    gl.uniform1i(loc(P.tapOut, 'u_seed'), seedOut ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    reduce(outNow.textures[1]!, T.tileOut, T.blockOut, shape);

    // 5. Out to the backbuffer.
    drawComposite(false, outW, outH, inNow, outBefore);

    ping = 1 - ping;
    seedIn = false;
    seedOut = false;
    hasShown = true;
    return true;
  }

  // Out of memory for the tap targets: show nothing rather than an unguarded
  // frame. (Clear colour is the host's; save it.)
  function blank(w: number, h: number): void {
    const colour = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(colour[0]!, colour[1]!, colour[2]!, colour[3]!);
  }

  function drawComposite(passthrough: boolean, outW: number, outH: number, inNow?: Target, outBefore?: Target): void {
    draw(P.composite, null, outW, outH);
    bind(0, src!);
    if (inNow && outBefore) bindShown(P.composite, inNow, outBefore);
    gl.uniform1i(loc(P.composite, 'u_passthrough'), passthrough ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    apply(dtMs, screenFraction) {
      if (disposed || gl.isContextLost()) return;
      if (screenFraction < HAZARD_AREA) {
        // History would be stale by the time this surface matters again.
        fresh = true;
        return;
      }
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (w < 1 || h < 1) return;
      save();
      // With alpha: false the backbuffer has no alpha channel, and a copy
      // into a format with one is an error.
      const format = alpha ? gl.RGBA8 : gl.RGB8;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      if (w !== srcW || h !== srcH || format !== srcFormat) {
        gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, alpha ? gl.RGBA : gl.RGB, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        srcW = w;
        srcH = h;
        srcFormat = format;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
      if (!guard(dtMs, screenFraction, w, h)) blank(w, h);
      restore();
    },

    present(source, dtMs, screenFraction) {
      if (disposed || gl.isContextLost()) return;
      const w = source.width;
      const h = source.height;
      if (w < 1 || h < 1) return;
      const canvas = gl.canvas;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      save();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      // 2D canvases upload top row first; flip so every pass sees GL order.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (w !== srcW || h !== srcH || srcFormat !== gl.RGBA8) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        srcW = w;
        srcH = h;
        srcFormat = gl.RGBA8;
      }
      if (screenFraction < HAZARD_AREA) {
        fresh = true;
        drawComposite(true, w, h);
      } else if (!guard(dtMs, screenFraction, w, h)) {
        blank(w, h);
      }
      restore();
    },

    reset() {
      fresh = true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of [...fixed, ...tapIn, ...tapOut]) deleteTarget(t);
      gl.deleteTexture(src);
      for (const p of programs) gl.deleteProgram(p);
      gl.deleteVertexArray(vao);
    },
  };
}
