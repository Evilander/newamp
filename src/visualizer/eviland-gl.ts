// Small owned WebGL resources shared by Eviland's source modules.
export const SOURCE_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0, 1);
}`;

export function sourceProgram(gl: WebGL2RenderingContext, fragment: string): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  const shaders: WebGLShader[] = [];
  for (const [kind, code] of [[gl.VERTEX_SHADER, SOURCE_VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(kind);
    if (!shader) { gl.deleteProgram(program); for (const s of shaders) gl.deleteShader(s); return null; }
    shaders.push(shader);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[eviland] source shader:', gl.getShaderInfoLog(shader));
      for (const s of shaders) gl.deleteShader(s);
      gl.deleteProgram(program);
      return null;
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  for (const shader of shaders) gl.deleteShader(shader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
  return program;
}

export interface SourceTarget { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number }
export function sourceTarget(gl: WebGL2RenderingContext, width: number, height: number, float = false): SourceTarget | null {
  const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) { gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer); return null; }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8, width, height, 0, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer); return null;
  }
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { texture, framebuffer, width, height };
}
export function disposeSourceTarget(gl: WebGL2RenderingContext, target: SourceTarget | null): void {
  if (target) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
}

/**
 * GLSL that tells a NaN from a number by its encoding. A comparison with NaN
 * is unspecified in GLSL ES 3.00, and a compiler that assumes its inputs are
 * numbers may fold `x >= 0.0` or `!(x < 1.0)` away, which would let one bad
 * texel stay in a feedback loop. An integer test on the bits can't be folded:
 * a NaN of either sign has an all-ones exponent and a non-zero mantissa, so
 * its encoding without the sign sits above that of infinity.
 */
export const NAN_GLSL = `
bool notNumber(float x){
  highp uint bits = floatBitsToUint(x);
  return (bits & 0x7fffffffu) > 0x7f800000u;
}
`;

// ── Perceptual palette ramps ──────────────────────────────────────────────
// A palette's dark, accent and light roles are laid along a line in OKLCh:
// lightness and chroma move linearly and hue takes the short way round, as the
// Director's fades do on the CPU (eviland-operators.ts). The old sRGB mixes
// between two saturated colours dipped through grey in the middle, which is
// where every triadic and tetradic look lost its colour.
//
// The CPU lays the line out once per palette change as RAMP_STEPS samples per
// segment, already gamut-mapped (a colour outside sRGB loses chroma until it
// fits, keeping lightness and hue), and the shader interpolates between
// neighbouring samples in sRGB. Over most of the line that is within a level
// of the exact curve; where a channel runs into the edge of sRGB the exact
// curve has a corner and the table cuts it (scripts/eviland-v2-ramp-test.mjs
// measures both). The shader needs no cube roots, no gamut search and nothing
// that can produce a NaN: one uniform-array read and a mix per call.
export const RAMP_STEPS = 12;

export interface RampTable {
  /** `points` RGB triples, ready for gl.uniform3fv. */
  values: Float32Array;
  /** Number of samples (segments * steps + 1). */
  points: number;
  /** The colours the table was last built from, to skip a rebuild when they are unchanged. */
  readonly key: Float64Array;
  readonly stops: number;
}

/** A table through `stops` colours (2 or more), `steps` samples per segment. */
export function createRampTable(stops: number, steps = RAMP_STEPS): RampTable {
  const points = (stops - 1) * steps + 1;
  const key = new Float64Array(stops * 3);
  key.fill(NaN);
  return { values: new Float32Array(points * 3), points, key, stops };
}

const lchScratch = new Float64Array(3);
const linScratch = new Float64Array(3);

const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v: number): number => {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};

function toLch(rgb: ArrayLike<number>, at: number, out: Float64Array): void {
  const r = decode(rgb[at]!), g = decode(rgb[at + 1]!), b = decode(rgb[at + 2]!);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = Math.hypot(a, bb);
  out[2] = Math.atan2(bb, a);
}

function lchToLinear(L: number, C: number, h: number, out: Float64Array): void {
  const a = C * Math.cos(h), bb = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

const fits = (c: Float64Array): boolean =>
  c[0]! >= -0.002 && c[0]! <= 1.002 && c[1]! >= -0.002 && c[1]! <= 1.002 && c[2]! >= -0.002 && c[2]! <= 1.002;

const TAU = Math.PI * 2;

/**
 * One point on the OKLCh line between two colours given as (L, C, hue in
 * radians) triples at `a` and `b` of `lch`, written to `out` at `at` as sRGB.
 */
function rampPoint(lch: Float64Array, a: number, b: number, t: number, out: Float32Array, at: number): void {
  const L = lch[a]! + (lch[b]! - lch[a]!) * t;
  const C = lch[a + 1]! + (lch[b + 1]! - lch[a + 1]!) * t;
  // A near-grey colour has no hue of its own; it takes the other side's.
  let h: number;
  if (lch[a + 1]! < 1e-4) h = lch[b + 2]!;
  else if (lch[b + 1]! < 1e-4) h = lch[a + 2]!;
  else {
    let dh = lch[b + 2]! - lch[a + 2]!;
    if (dh > Math.PI) dh -= TAU;
    else if (dh < -Math.PI) dh += TAU;
    h = lch[a + 2]! + dh * t;
  }
  lchToLinear(L, C, h, linScratch);
  if (!fits(linScratch)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) * 0.5;
      lchToLinear(L, mid, h, linScratch);
      if (fits(linScratch)) lo = mid;
      else hi = mid;
    }
    lchToLinear(L, lo, h, linScratch);
  }
  out[at] = encode(linScratch[0]!);
  out[at + 1] = encode(linScratch[1]!);
  out[at + 2] = encode(linScratch[2]!);
}

const lchStops = new Float64Array(3 * 8);

/**
 * Rebuild `table` through `colours` (flat RGB triples, as many as the table
 * has stops) unless they are the ones it was built from. True if it changed.
 * Segment ends are the colours themselves, so a settled palette is untouched.
 */
export function updateRampTable(table: RampTable, colours: ArrayLike<number>): boolean {
  const n = table.stops * 3;
  let same = true;
  for (let i = 0; i < n; i++) {
    if (table.key[i] !== colours[i]) { same = false; break; }
  }
  if (same) return false;
  for (let i = 0; i < n; i++) table.key[i] = colours[i]!;
  const lch = n <= lchStops.length ? lchStops : new Float64Array(n);
  for (let s = 0; s < table.stops; s++) {
    toLch(colours, s * 3, lchScratch);
    lch[s * 3] = lchScratch[0]!;
    lch[s * 3 + 1] = lchScratch[1]!;
    lch[s * 3 + 2] = lchScratch[2]!;
  }
  const steps = (table.points - 1) / (table.stops - 1);
  for (let seg = 0; seg < table.stops - 1; seg++) {
    for (let k = 0; k < steps; k++) {
      const at = (seg * steps + k) * 3;
      if (k === 0) {
        for (let c = 0; c < 3; c++) table.values[at + c] = colours[seg * 3 + c]!;
      } else {
        rampPoint(lch, seg * 3, (seg + 1) * 3, k / steps, table.values, at);
      }
    }
  }
  const last = (table.points - 1) * 3;
  for (let c = 0; c < 3; c++) table.values[last + c] = colours[(table.stops - 1) * 3 + c]!;
  return true;
}

/** The exact OKLCh line the shader's table approximates, for tests and tools. */
export function oklchRampAt(colours: ArrayLike<number>, t: number): [number, number, number] {
  const stops = colours.length / 3;
  const x = Math.min(Math.max(t, 0), 1) * (stops - 1);
  const seg = Math.min(stops - 2, Math.floor(x));
  const lch = new Float64Array(stops * 3);
  for (let s = 0; s < stops; s++) {
    toLch(colours, s * 3, lchScratch);
    lch.set(lchScratch, s * 3);
  }
  const out = new Float32Array(3);
  const f = x - seg;
  if (f <= 0) return [colours[seg * 3]!, colours[seg * 3 + 1]!, colours[seg * 3 + 2]!];
  rampPoint(lch, seg * 3, (seg + 1) * 3, f, out, 0);
  return [out[0]!, out[1]!, out[2]!];
}

/**
 * GLSL for one ramp: `vec3 <name>(float t)` over the uniform array
 * `<uniform>[points]` that updateRampTable fills, t from 0 (first colour) to 1
 * (last). The index is clamped as an integer so a NaN t reads a valid texel
 * instead of past the array.
 */
export function rampGlsl(name: string, uniform: string, points: number): string {
  return `uniform vec3 ${uniform}[${points}];
vec3 ${name}(float t) {
  float x = clamp(t, 0.0, 1.0) * ${(points - 1).toFixed(1)};
  int i = clamp(int(x), 0, ${points - 2});
  return mix(${uniform}[i], ${uniform}[i + 1], clamp(x - float(i), 0.0, 1.0));
}
`;
}

/**
 * Triangular dither one 8-bit step wide from interleaved gradient noise: a pure
 * function of the pixel and the frame, so every route that uses it (GPU
 * passes, the flash guard's composite and its shown-taps measurement) agrees
 * on the value at a pixel. It reads as finer grain than a per-pixel hash at
 * the same amplitude and bands less. `frame` should stay below a few thousand
 * (callers wrap it) so the fract stays precise.
 */
export const DITHER_GLSL = `
float ignoise(vec2 p, float frame) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)) + frame * 0.618034));
}
float ditherTri(vec2 p, float frame) {
  return ignoise(p, frame) + ignoise(p + vec2(5.588238), frame) - 1.0;
}
`;

/** The CPU twin of ditherTri, for tests. */
export function ditherTriAt(x: number, y: number, frame: number): number {
  const ign = (px: number, py: number): number => {
    const a = (px * 0.06711056 + py * 0.00583715 + frame * 0.618034) % 1;
    return (52.9829189 * (a < 0 ? a + 1 : a)) % 1;
  };
  return ign(x, y) + ign(x + 5.588238, y + 5.588238) - 1;
}

/** Wrap a frame counter before it is handed to a shader that feeds it to ditherTri. */
export const DITHER_FRAME_WRAP = 4096;

/**
 * The hot end of a frame headed for an 8-bit target: the peak channel rolls
 * off toward full brightness and RGB scales together, so a pile-up keeps its
 * hue instead of clipping channel by channel; the very hottest pixels first
 * give up some colour toward the peak, for a white-hot centre rather than a
 * flat disc. Same curve as the engine's final pass.
 */
export const SHOULDER_GLSL = `
vec3 hotShoulder(vec3 c) {
  float peak = max(c.r, max(c.g, c.b));
  c = mix(c, vec3(peak), smoothstep(1.3, 4.0, peak) * 0.65);
  return c * ((1.0 - exp(-peak * 1.35)) / max(peak, 1e-4));
}
`;

export interface ContextLossHandlers {
  onLost?(): void;
  onRestored?(): void;
}

/**
 * Keep a canvas' WebGL context recoverable. A context lost to a GPU reset or
 * driver restart is only restored by the browser if the page cancels the lost
 * event, and nothing on it survives either way: every program, texture and
 * buffer made before the loss is gone, so `onRestored` has to rebuild them.
 * Returns the function that stops watching.
 */
export function watchContextLoss(canvas: HTMLCanvasElement | OffscreenCanvas, handlers: ContextLossHandlers): () => void {
  const lost = (event: Event): void => {
    event.preventDefault();
    handlers.onLost?.();
  };
  const restored = (): void => handlers.onRestored?.();
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}

export interface ContextHold<T> {
  /** The live object, or null while the context is gone (or could not be rebuilt). */
  current(): T | null;
  stop(): void;
}

// A context that was just restored can still be busy after a GPU reset, so the
// first build on it may fail where one a moment later works.
const REBUILD_TRIES = 3;
const REBUILD_RETRY_MS = 250;

/**
 * Hold something built on a canvas' context across a loss. The old object is
 * dropped the moment the context goes (what it owned is already gone with
 * it), and `build` makes a new one once the browser restores the context. A
 * build that fails is tried again a few times, spaced out, before `onFailed`;
 * the next loss starts the cycle over.
 */
export function holdThroughContextLoss<T extends { dispose(): void }>(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  first: T,
  build: () => T | null,
  hooks: { onLost?(): void; onRestored?(next: T): void; onFailed?(): void } = {},
): ContextHold<T> {
  let live: T | null = first;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const cancelRetry = (): void => {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };
  const attempt = (triesLeft: number): void => {
    retry = null;
    if (live) return;
    try {
      live = build();
    } catch (err) {
      console.error('[eviland] rebuild after context loss failed:', err);
      live = null;
    }
    if (live) hooks.onRestored?.(live);
    else if (triesLeft > 1) retry = setTimeout(() => attempt(triesLeft - 1), REBUILD_RETRY_MS);
    else hooks.onFailed?.();
  };
  const stopWatching = watchContextLoss(canvas, {
    onLost() {
      cancelRetry();
      const old = live;
      live = null;
      try { old?.dispose(); } catch { /* its context is already gone */ }
      hooks.onLost?.();
    },
    onRestored() {
      cancelRetry();
      attempt(REBUILD_TRIES);
    },
  });
  return {
    current: () => live,
    stop() {
      cancelRetry();
      stopWatching();
    },
  };
}
