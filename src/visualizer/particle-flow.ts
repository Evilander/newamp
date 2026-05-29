// GPU particle flow-field visualizer (WebGL2 transform feedback).
//
// Hundreds of thousands of particles are simulated entirely on the GPU: each
// frame a "sim" program advects every particle through a curl-noise flow field
// whose strength and turbulence are driven by live audio (bass pushes the
// field, treble adds jitter, a beat fires a radial burst), writing the new
// position/velocity/age back to a vertex buffer via transform feedback. A
// second "render" program draws the particles as additive glowing points over a
// faded previous frame, giving motion trails. No float render target or WebGPU
// required — just WebGL2 transform feedback, which is hardware-accelerated
// across ANGLE/Metal/D3D/GL.
//
// createParticleFlowRenderer returns null when WebGL2 (or transform feedback)
// is unavailable so the caller can fall back to a canvas-2D path.

export interface ParticleFlowFeatures {
  bass: number;
  mid: number;
  treble: number;
  rms: number;
  beat: number;
  kick: number;
  beatEdge: boolean;
}

export interface ParticleFlowRenderer {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(features: ParticleFlowFeatures, accentRgb: [number, number, number], dtSeconds: number): void;
  dispose(): void;
  readonly particleCount: number;
}

export interface ParticleFlowOptions {
  /** Target particle count. Clamped to [4096, 1_000_000]. Default 96_000. */
  particles?: number;
  /** Enable preserveDrawingBuffer for pixel readback (smoke tests). */
  smoke?: boolean;
}

const SIM_VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec2 a_vel;
in vec2 a_age;   // x = age, y = per-particle seed

uniform float u_dt;
uniform float u_time;
uniform float u_aspect;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_burst;   // radial impulse on a beat edge

out vec2 v_pos;
out vec2 v_vel;
out vec2 v_age;

// --- Ashima 2D simplex noise (public domain) ---
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));
  vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
  i=mod289(i);
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
float rand(float n){return fract(sin(n*12.9898)*43758.5453);}

vec2 curl(vec2 p){
  float e=0.12;
  float n1=snoise(p+vec2(0.0,e));
  float n2=snoise(p-vec2(0.0,e));
  float n3=snoise(p+vec2(e,0.0));
  float n4=snoise(p-vec2(e,0.0));
  return vec2(n1-n2, n4-n3)/(2.0*e);
}

void main(){
  float age=a_age.x;
  float seed=a_age.y;
  vec2 vel=a_vel;
  vec2 pos=a_pos;

  // Flow field: scale + warp speed with bass; treble adds high-frequency drift.
  float fieldScale=1.3+u_treble*1.6;
  vec2 f=curl(pos*fieldScale + vec2(u_time*0.05, -u_time*0.04));
  float push=0.35+u_bass*1.5;
  vel += f*push*u_dt;

  // Treble jitter.
  float j=u_treble*0.6;
  vel += (vec2(rand(seed+u_time), rand(seed*1.7+u_time*1.3))-0.5)*j*u_dt;

  // Beat burst — radial impulse from center.
  if(u_burst>0.001){
    vec2 dir=pos/max(length(pos),0.0001);
    vel += dir*u_burst*(0.5+0.5*rand(seed))*1.4;
  }

  vel *= (0.965 - u_treble*0.05);
  pos += vel*u_dt*(0.9+u_mid*0.6);
  age += u_dt;

  float lifespan=2.2+seed*3.0;
  bool dead = age>lifespan || abs(pos.x)>1.25 || abs(pos.y)>1.25;
  if(dead){
    // Respawn near center on a seeded ring so the field keeps feeding.
    float ang=rand(seed+floor(u_time))*6.2831853;
    float rad=0.04+rand(seed*2.3+floor(u_time))*0.5;
    pos=vec2(cos(ang)*rad/u_aspect, sin(ang)*rad);
    vel=vec2(0.0);
    age=0.0;
  }

  v_pos=pos; v_vel=vel; v_age=vec2(age,seed);
  gl_Position=vec4(pos,0.0,1.0);
}`;

const SIM_FRAG = `#version 300 es
precision highp float;
out vec4 o;
void main(){o=vec4(0.0);}`;

const RENDER_VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec2 a_vel;
in vec2 a_age;
uniform float u_pointScale;
uniform float u_treble;
uniform float u_bass;
uniform vec3 u_accent;
out vec3 v_color;
out float v_alpha;
void main(){
  float speed=length(a_vel);
  float life=2.2+a_age.y*3.0;
  float t=clamp(a_age.x/life,0.0,1.0);
  // Fade in then out over the particle's life.
  float fade=smoothstep(0.0,0.12,t)*(1.0-smoothstep(0.7,1.0,t));
  v_alpha=fade*(0.35+u_bass*0.5);
  // Hot core when fast: shift accent toward white/warm with speed + treble.
  vec3 hot=mix(u_accent, vec3(1.0,0.95,0.8), clamp(speed*9.0+u_treble*0.6,0.0,1.0));
  v_color=hot;
  gl_PointSize=clamp(u_pointScale*(0.7+speed*16.0+u_bass*0.8),1.0,9.0);
  gl_Position=vec4(a_pos,0.0,1.0);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 o;
void main(){
  vec2 d=gl_PointCoord-0.5;
  float r=dot(d,d);
  if(r>0.25) discard;
  float g=exp(-r*7.0);
  o=vec4(v_color*g*v_alpha, 1.0);
}`;

const FADE_VERT = `#version 300 es
precision highp float;
in vec2 a_quad;
void main(){gl_Position=vec4(a_quad,0.0,1.0);}`;

const FADE_FRAG = `#version 300 es
precision highp float;
uniform vec3 u_bg;
uniform float u_fade;
out vec4 o;
void main(){o=vec4(u_bg,u_fade);}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[newamp] particle-flow shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  feedbackVaryings?: string[],
): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  if (feedbackVaryings) gl.transformFeedbackVaryings(prog, feedbackVaryings, gl.SEPARATE_ATTRIBS);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[newamp] particle-flow program link failed:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

export function createParticleFlowRenderer(
  canvas: HTMLCanvasElement,
  options: ParticleFlowOptions = {},
): ParticleFlowRenderer | null {
  const ctx = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: Boolean(options.smoke),
    powerPreference: 'high-performance',
  });
  if (!ctx) return null;
  // Non-nullable binding so the render/resize/dispose closures don't trip
  // TS's "possibly null" on a closed-over context.
  const gl: WebGL2RenderingContext = ctx;
  if (typeof gl.createTransformFeedback !== 'function') return null;

  const count = Math.max(4096, Math.min(1_000_000, Math.floor(options.particles ?? 96_000)));

  const simProg = link(gl, SIM_VERT, SIM_FRAG, ['v_pos', 'v_vel', 'v_age']);
  const renderProg = link(gl, RENDER_VERT, RENDER_FRAG);
  const fadeProg = link(gl, FADE_VERT, FADE_FRAG);
  if (!simProg || !renderProg || !fadeProg) {
    return null;
  }

  // Seed particle state.
  const pos = new Float32Array(count * 2);
  const vel = new Float32Array(count * 2);
  const age = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random());
    pos[i * 2] = Math.cos(ang) * rad;
    pos[i * 2 + 1] = Math.sin(ang) * rad;
    vel[i * 2] = (Math.random() - 0.5) * 0.02;
    vel[i * 2 + 1] = (Math.random() - 0.5) * 0.02;
    age[i * 2] = Math.random() * 4;
    age[i * 2 + 1] = Math.random();
  }

  const mkBuf = (data: Float32Array): WebGLBuffer => {
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
    return b;
  };
  // Ping-pong: two full state sets.
  let cur = { pos: mkBuf(pos), vel: mkBuf(vel), age: mkBuf(age) };
  let nxt = { pos: mkBuf(pos), vel: mkBuf(vel), age: mkBuf(age) };

  const quadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const tf = gl.createTransformFeedback()!;

  const simLoc = {
    pos: gl.getAttribLocation(simProg, 'a_pos'),
    vel: gl.getAttribLocation(simProg, 'a_vel'),
    age: gl.getAttribLocation(simProg, 'a_age'),
    dt: gl.getUniformLocation(simProg, 'u_dt'),
    time: gl.getUniformLocation(simProg, 'u_time'),
    aspect: gl.getUniformLocation(simProg, 'u_aspect'),
    bass: gl.getUniformLocation(simProg, 'u_bass'),
    mid: gl.getUniformLocation(simProg, 'u_mid'),
    treble: gl.getUniformLocation(simProg, 'u_treble'),
    burst: gl.getUniformLocation(simProg, 'u_burst'),
  };
  const rndLoc = {
    pos: gl.getAttribLocation(renderProg, 'a_pos'),
    vel: gl.getAttribLocation(renderProg, 'a_vel'),
    age: gl.getAttribLocation(renderProg, 'a_age'),
    pointScale: gl.getUniformLocation(renderProg, 'u_pointScale'),
    treble: gl.getUniformLocation(renderProg, 'u_treble'),
    bass: gl.getUniformLocation(renderProg, 'u_bass'),
    accent: gl.getUniformLocation(renderProg, 'u_accent'),
  };
  const fadeLoc = {
    quad: gl.getAttribLocation(fadeProg, 'a_quad'),
    bg: gl.getUniformLocation(fadeProg, 'u_bg'),
    fade: gl.getUniformLocation(fadeProg, 'u_fade'),
  };

  let time = 0;
  let dpr = 1;

  function bindAttrib(loc: number, buf: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  function resize(cssWidth: number, cssHeight: number, nextDpr: number): void {
    dpr = nextDpr;
    const w = Math.max(2, Math.floor(cssWidth * dpr));
    const h = Math.max(2, Math.floor(cssHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function render(features: ParticleFlowFeatures, accentRgb: [number, number, number], dt: number): void {
    const step = Math.min(0.05, Math.max(0.001, dt));
    time += step;
    const aspect = Math.max(0.0001, canvas.width / Math.max(1, canvas.height));

    // 1) Simulation step via transform feedback (rasterization off).
    gl.useProgram(simProg);
    gl.uniform1f(simLoc.dt, step * 60); // normalize to ~per-60fps-frame units
    gl.uniform1f(simLoc.time, time);
    gl.uniform1f(simLoc.aspect, aspect);
    gl.uniform1f(simLoc.bass, features.bass);
    gl.uniform1f(simLoc.mid, features.mid);
    gl.uniform1f(simLoc.treble, features.treble);
    gl.uniform1f(simLoc.burst, features.beatEdge ? 0.4 + features.kick * 0.8 : 0);

    bindAttrib(simLoc.pos, cur.pos);
    bindAttrib(simLoc.vel, cur.vel);
    bindAttrib(simLoc.age, cur.age);

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, nxt.pos);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, nxt.vel);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 2, nxt.age);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 2, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

    const tmp = cur;
    cur = nxt;
    nxt = tmp;

    // 2) Fade previous frame toward background (motion trails).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(fadeProg);
    gl.uniform3f(fadeLoc.bg, 0.02, 0.02, 0.035);
    gl.uniform1f(fadeLoc.fade, 0.16 - features.rms * 0.06);
    bindAttrib(fadeLoc.quad, quadBuf);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3) Additive particles.
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(renderProg);
    gl.uniform1f(rndLoc.pointScale, 2.0 * dpr);
    gl.uniform1f(rndLoc.treble, features.treble);
    gl.uniform1f(rndLoc.bass, features.bass);
    gl.uniform3f(rndLoc.accent, accentRgb[0], accentRgb[1], accentRgb[2]);
    bindAttrib(rndLoc.pos, cur.pos);
    bindAttrib(rndLoc.vel, cur.vel);
    bindAttrib(rndLoc.age, cur.age);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.BLEND);
  }

  function dispose(): void {
    gl.deleteProgram(simProg);
    gl.deleteProgram(renderProg);
    gl.deleteProgram(fadeProg);
    gl.deleteBuffer(cur.pos);
    gl.deleteBuffer(cur.vel);
    gl.deleteBuffer(cur.age);
    gl.deleteBuffer(nxt.pos);
    gl.deleteBuffer(nxt.vel);
    gl.deleteBuffer(nxt.age);
    gl.deleteBuffer(quadBuf);
    gl.deleteTransformFeedback(tf);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  return { resize, render, dispose, particleCount: count };
}
