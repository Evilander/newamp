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
