// Eviland morph species — the organic kinds of motion a look can layer on top
// of its warp (cells, coral, marble, chroma, droste, mobius, tendril,
// peristalsis; indices follow MORPH_KINDS in eviland-operators.ts).
//
// Shared GLSL, so the Eviland feedback field and Eviland Live's pass over
// MilkDrop's feedback move a picture the same way. Most kinds are a small
// per-frame displacement: the caller blends its sample coordinate toward
// morphTarget() by the frame's strength. Two act on colour instead: droste
// jumps to a nested copy of the frame (drosteTap), and coral adds a
// difference of ring means (coralDelta).

// Ashima 2D simplex — lifted (public domain) and used as our potential field.
export const NOISE_GLSL = `
vec3 mod289_3(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289_2(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289_3(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));
  vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
  i=mod289_2(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
  m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0;
  vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g;
  g.x=a0.x*x0.x+h.x*x0.y;
  g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}
vec2 curl(vec2 p){
  float e=0.012;
  float n1=snoise(p+vec2(0.0,e));
  float n2=snoise(p-vec2(0.0,e));
  float n3=snoise(p+vec2(e,0.0));
  float n4=snoise(p-vec2(e,0.0));
  return vec2(n1-n2, -(n3-n4))/(2.0*e);
}
`;

// Needs NOISE_GLSL declared first. `aspect` is width / height of the image
// being moved and `texel` one of its texels in uv.
export const MORPH_GLSL = `
const float MORPH_TAU = 6.28318530718;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash1(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec2 hash2(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
vec2 turn(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c*p.x - s*p.y, s*p.x + c*p.y); }
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cdiv(vec2 a, vec2 b){ return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / max(dot(b, b), 1e-6); }

// Where a morph species wants this pixel to sample from after one reference
// frame (1/60 s). Every kind moves a small distance and the step is
// incremental, so callers move toward it by strength × elapsed reference
// frames (linearly, not exponentially, or the speed would depend on the
// frame rate). Distances are fractions of the frame, never texels, so a look
// moves the same in a mini deck as at 4K.
vec2 morphTarget(sampler2D img, vec2 src, int kind, float s, vec2 centre, float time, float aspect, vec2 texel){
  vec2 asp = vec2(aspect, 1.0);
  if (kind == 1) {
    // cells: find the nearest drifting nucleus, bloom out of it and turn.
    // The seams where neighbouring cells meet become membranes.
    vec2 g = src * asp * (4.0 * s);
    vec2 id = floor(g), f = fract(g);
    float best = 9.0; vec2 bestPos = vec2(0.5); vec2 bestId = id;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y));
        vec2 h = hash2(id + o);
        vec2 pos = o + 0.5 + 0.36 * sin(time * (0.2 + h * 0.35) + h * MORPH_TAU);
        vec2 d = pos - f;
        float dd = dot(d, d);
        if (dd < best) { best = dd; bestPos = pos; bestId = id + o; }
      }
    }
    vec2 nucleus = (id + bestPos) / (4.0 * s) / asp;
    vec2 q = (src - nucleus) * asp;
    q = turn(q, (hash1(bestId) - 0.5) * 0.09) * 0.93;
    return nucleus + q / asp;
  }
  if (kind == 3) {
    // marble: parallel bands shear against each other, their direction
    // turning slowly, so the picture is combed and folded like paper marbling.
    float ang = time * 0.03 + s * 2.0;
    vec2 along = vec2(cos(ang), sin(ang));
    float across = dot((src - 0.5) * asp, vec2(-along.y, along.x));
    float shear = sin(across * (10.0 / s) + time * 0.4);
    return src + along / asp * shear * 0.0024;
  }
  if (kind == 4) {
    // chroma: each colour flows in the direction of its own hue.
    vec3 c = textureLod(img, src, 0.0).rgb;
    vec2 iq = vec2(dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
    // Grey has no hue (and atan(0, 0) is undefined), so it stays put.
    float sat = smoothstep(0.01, 0.12, length(iq));
    if (sat <= 0.0) return src;
    float ang = atan(iq.y, iq.x) + time * 0.15;
    return src + vec2(cos(ang), sin(ang)) / asp * (0.0028 * s) * sat;
  }
  if (kind == 6) {
    // mobius: loxodromic flow streaming out of one wandering pole into another.
    vec2 z = (src - 0.5) * asp;
    float t = time * 0.05;
    vec2 a = vec2(cos(t), sin(t * 1.3)) * (0.32 * s);
    vec2 wv = cdiv(z - a, z + a);
    wv = cmul(wv, vec2(cos(0.03), sin(0.03)) * 0.975);
    vec2 z2 = cmul(a, cdiv(vec2(1.0, 0.0) + wv, vec2(1.0, 0.0) - wv));
    // Poles are fixed points; keep their neighbourhood from folding over.
    return src + clamp(z2 / asp + 0.5 - src, vec2(-0.02), vec2(0.02));
  }
  if (kind == 7) {
    // tendril: angular noise drags the picture out into curling arms.
    vec2 q = (src - centre) * asp;
    float r = length(q);
    float a = atan(q.y, q.x + 1e-6);
    float arms = floor(3.0 + s * 4.0);
    float n = snoise(vec2(cos(a), sin(a)) * arms * 0.35 + vec2(r * 3.0 - time * 0.4, time * 0.1));
    q = turn(q, n * 0.06) * (1.0 - 0.02 * (0.5 + 0.5 * n));
    return centre + q / asp;
  }
  if (kind == 8) {
    // peristalsis: bands of squeeze and release travelling outward.
    vec2 q = (src - centre) * asp;
    float wave = sin(length(q) * (14.0 * s) - time * 3.0);
    return centre + q * (1.0 - 0.025 * wave) / asp;
  }
  return src;
}

// coral: a Turing instability run on the feedback itself. Detail at one
// scale is reinforced (mean of a small ring) and at a larger scale suppressed
// (mean of a ring 2.6× wider); fed back every frame, that difference grows
// into labyrinths, spots and brain-fold coral. Measured on brightness, so a
// pattern keeps the colour it grew from. The ring turns every frame: a fixed
// ring of six taps grows stripes aligned to its own spokes. Radii follow the
// frame height (with a two-texel floor), so the coral is the same size at
// every resolution. Returns the brightness change, before strength.
float coralDelta(sampler2D img, vec2 src, float s, vec2 texel, float time, float aspect){
  float r1 = max(texel.y * 2.0, 0.0045 * (0.6 + s));
  float r2 = r1 * 2.6;
  vec2 asp = vec2(1.0 / aspect, 1.0);
  float near = 0.0;
  float far = 0.0;
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.0471976 + time * 7.3;
    vec2 d = vec2(cos(a), sin(a)) * asp;
    near += luma(textureLod(img, src + d * r1, 0.0).rgb);
    far += luma(textureLod(img, src + turn(d, 0.5236) * r2, 0.0).rgb);
  }
  return (near - far) / 6.0;
}

// Apply one coral step to \`c\` (sampled at \`src\`) with strength \`k\`. Growth
// runs out of room as the pixel's brightest channel rises, so patterns settle
// into structure instead of whiting out (limiting by luma let saturated blue
// climb to several times full scale), and only light that is already there
// can grow: coral textures what the look draws rather than flooding the
// black. Darkening is never limited.
vec3 coralApply(sampler2D img, vec3 c, vec2 src, float k, float s, vec2 texel, float time, float aspect){
  float peak = max(c.r, max(c.g, c.b));
  float d = coralDelta(img, src, s, texel, time, aspect) * (k * 0.35);
  if (d > 0.0) d *= (1.0 - smoothstep(0.4, 1.1, peak)) * smoothstep(0.02, 0.2, peak);
  return max(vec3(0.0), c + c / max(peak, 0.05) * d);
}

// droste: a smaller, turned copy of the whole frame. Blended in a little
// every frame it becomes an endless spiral of frames inside frames, a camera
// pointed at its own monitor. \`inside\` fades the copy out at its borders.
vec2 drosteTap(vec2 src, float s, vec2 centre, float time, float aspect, out float inside){
  vec2 asp = vec2(aspect, 1.0);
  vec2 q = turn((src - centre) * asp, 0.35 + 0.25 * sin(time * 0.07)) * (1.5 + s * 0.9);
  vec2 alt = centre + q / asp;
  vec2 edge = min(alt, 1.0 - alt);
  inside = smoothstep(0.0, 0.06, min(edge.x, edge.y));
  return alt;
}
`;
