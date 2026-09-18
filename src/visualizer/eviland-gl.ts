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
