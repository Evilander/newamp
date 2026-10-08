// Browser-side half of `npm run test:eviland-physarum` (see
// eviland-physarum-test.mjs). Drives the real simulation with synthetic audio
// and asserts on rendered pixels: it lights up without washing out, it draws a
// branching network rather than blobs, all three species show, it grows, it
// follows bright feedback, and silence leaves a dim network standing.
import { createPhysarum, warmPhysarum } from '../src/visualizer/eviland-physarum';
import { sourceProgram, sourceTarget, disposeSourceTarget } from '../src/visualizer/eviland-gl';
import type { EvilandFrame } from '../src/visualizer/eviland-audio';
import type { PaletteConfig } from '../src/visualizer/eviland-operators';

const W = 480;
const H = 270;
const FPS = 60;
const SEED = 0x5eed;
const LOUD_UNTIL = 4;
const BEAT = 60 / 128;
// Three well-separated hues, so species can be told apart by colour alone.
const PALETTE: PaletteConfig = { bg: [0, 0, 0], dark: [0.5, 0.04, 0.55], accent: [0.05, 0.85, 0.6], light: [1, 0.7, 0.15] };
// A bright patch in the feedback image (uv centre, radius in pixels) that the
// mold should find and crawl onto.
const BLOB = { x: 0.75, y: 0.7, r: 38 };

/** 128 BPM: kick on every beat, snare on 2 and 4, sixteenth hats, then silence. */
function syntheticFrame(t: number): EvilandFrame {
  const beat = Math.floor(t / BEAT);
  const onBeat = beat !== Math.floor((t - 1 / FPS) / BEAT) || t === 0;
  const since = t - beat * BEAT;
  const loud = t < LOUD_UNTIL;
  const kick = loud ? Math.exp(-since / 0.12) : 0;
  const onsets: EvilandFrame['onsets'] = loud && onBeat
    ? [{ band: 1, group: 'kick', intensity: 0.8, sharpness: 0.7 }, ...(beat % 2 ? [{ band: 8, group: 'snare' as const, intensity: 0.7, sharpness: 0.8 }] : [])]
    : [];
  return {
    bands: Float32Array.from({ length: 24 }, (_, i) => loud ? 0.25 + 0.2 * Math.abs(Math.sin(i * 0.7 + t * 1.3)) : 0),
    onsets,
    kick, bass: loud ? 0.45 + 0.3 * kick : 0, snare: loud && beat % 2 ? Math.exp(-since / 0.1) * 0.7 : 0,
    hat: loud ? 0.3 + 0.2 * Math.abs(Math.sin(t * Math.PI * 8)) : 0, vocal: loud ? 0.5 : 0, energy: loud ? 0.6 : 0,
    centroid: 0.5, flatness: 0.2, crest: 0.6, rolloff: 0.5, width: 0.3, pan: 0,
    beatPhase: since / BEAT, beatConfidence: loud ? 0.8 : 0, bpm: 128, novelty: 0,
    sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
  };
}

function feedbackTexture(gl: WebGL2RenderingContext, blob: boolean): WebGLTexture {
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - BLOB.x * W, y - BLOB.y * H);
      const v = blob ? 0.9 * (1 - Math.min(1, Math.max(0, (d - BLOB.r + 6) / 12))) : 0;
      data.set([v, v, v, 1], (y * W + x) * 4);
    }
  }
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function context(): { canvas: HTMLCanvasElement; gl: WebGL2RenderingContext } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('WebGL2 unavailable');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
  return { canvas, gl };
}

function readPixels(gl: WebGL2RenderingContext): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

function peak(px: Uint8Array): Float32Array {
  const v = new Float32Array(W * H);
  for (let i = 0; i < v.length; i++) v[i] = Math.max(px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!) / 255;
  return v;
}

function boxBlur(v: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(v.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          sum += v[yy * W + xx]!;
          n++;
        }
      }
      out[y * W + x] = sum / n;
    }
  }
  return out;
}

/** Mean |Laplacian| over lit pixels, relative to their mean brightness. */
function structure(v: Float32Array, lit: Uint8Array): number {
  let lap = 0;
  let sum = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!lit[i]) continue;
      lap += Math.abs(4 * v[i]! - v[i - 1]! - v[i + 1]! - v[i - W]! - v[i + W]!);
      sum += v[i]!;
    }
  }
  return sum > 0 ? lap / sum : 0;
}

/** Connected components of pixels where mask[i] === want; returns their sizes. */
function components(mask: Uint8Array, want: number, diagonal: boolean): number[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const sizes: number[] = [];
  const steps = diagonal ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || mask[start] !== want) continue;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const i = stack[--top]!;
      size++;
      const x = i % W;
      const y = (i / W) | 0;
      for (const [dx, dy] of steps) {
        const xx = x + dx!;
        const yy = y + dy!;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (seen[j] || mask[j] !== want) continue;
        seen[j] = 1;
        stack[top++] = j;
      }
    }
    sizes.push(size);
  }
  return sizes;
}

function speciesShares(px: Uint8Array, lit: Uint8Array, palette: PaletteConfig): number[] {
  const hues = [palette.dark, palette.accent, palette.light].map((c) => {
    const sum = c[0] + c[1] + c[2];
    return c.map((v) => v / sum);
  });
  const counts = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < lit.length; i++) {
    if (!lit[i]) continue;
    const r = px[i * 4]!;
    const g = px[i * 4 + 1]!;
    const b = px[i * 4 + 2]!;
    const sum = Math.max(1, r + g + b);
    let best = 0;
    let bestDistance = Infinity;
    hues.forEach((hue, s) => {
      const d = (r / sum - hue[0]!) ** 2 + (g / sum - hue[1]!) ** 2 + (b / sum - hue[2]!) ** 2;
      if (d < bestDistance) { bestDistance = d; best = s; }
    });
    counts[best]!++;
    total++;
  }
  return counts.map((c) => c / Math.max(1, total));
}

function analyse(px: Uint8Array, palette = PALETTE) {
  const v = peak(px);
  const lit = new Uint8Array(v.length);
  let litCount = 0;
  let white = 0;
  let mean = 0;
  let blobSum = 0;
  let blobCount = 0;
  for (let i = 0; i < v.length; i++) {
    mean += v[i]!;
    if (v[i]! > 0.1) { lit[i] = 1; litCount++; }
    if (Math.min(px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!) > 235) white++;
    const x = i % W;
    const y = (i / W) | 0;
    if (Math.hypot(x - BLOB.x * W, y - BLOB.y * H) < BLOB.r - 4) { blobSum += v[i]!; blobCount++; }
  }
  mean /= v.length;
  const sharp = structure(v, lit);
  const smeared = structure(boxBlur(v, 6), lit);
  const cells = components(lit, 0, false).filter((size) => size >= 12).length;
  // Extent, for growth: the share of 16x16 tiles holding any vein.
  let tiles = 0;
  let reached = 0;
  for (let ty = 0; ty < H; ty += 16) {
    for (let tx = 0; tx < W; tx += 16) {
      let n = 0;
      for (let y = ty; y < Math.min(H, ty + 16); y++) for (let x = tx; x < Math.min(W, tx + 16); x++) n += lit[y * W + x]!;
      tiles++;
      if (n >= 3) reached++;
    }
  }
  return {
    lit: litCount / v.length,
    white: white / v.length,
    mean,
    structure: sharp,
    structureRatio: sharp / Math.max(1e-6, smeared),
    // Light in connected runs of 300+ px: three rival species can never form
    // one component, but a network is never dust either.
    networked: litCount ? components(lit, 1, true).filter((size) => size >= 300).reduce((a, b) => a + b, 0) / litCount : 0,
    cells,
    reach: reached / tiles,
    species: speciesShares(px, lit, palette),
    blob: blobCount ? blobSum / blobCount / Math.max(1e-6, mean) : 0,
  };
}
type Metrics = ReturnType<typeof analyse>;

function run(quality: 'high' | 'medium' | 'low', seconds: number, captureAt: number[], blob = true) {
  const { canvas, gl } = context();
  warmPhysarum(gl);
  if (gl.getError() !== gl.NO_ERROR) throw new Error('GL error warming programs');
  const sim = createPhysarum(gl, SEED, quality);
  if (!sim) throw new Error(`createPhysarum(${quality}) returned null`);
  const feedback = feedbackTexture(gl, blob);
  const metrics: Record<string, Metrics> = {};
  const pngs: Record<string, string> = {};
  let renderMs = 0;
  try {
    const frames = Math.round(seconds * FPS);
    for (let i = 0; i < frames; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const started = performance.now();
      sim.render(syntheticFrame(i / FPS), PALETTE, 1000 / FPS, feedback, { framebuffer: null, width: W, height: H, opacity: 1 });
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      renderMs += performance.now() - started;
      const time = captureAt.find((c) => Math.round(c * FPS) === i + 1);
      if (time !== undefined) {
        const px = readPixels(gl);
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`GL error 0x${error.toString(16)} by ${time}s`);
        metrics[String(time)] = analyse(px);
        pngs[String(time)] = canvas.toDataURL();
      }
    }
    // The caller's fullscreen passes run on the default VAO with attributes.
    // Nothing of ours may be left enabled there, and unit 0 must be active.
    const state = {
      attrib0: gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean,
      activeUnit0: gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE0,
    };
    return { metrics, pngs, state, cpuMsPerFrame: renderMs / frames };
  } finally {
    sim.dispose();
    gl.deleteTexture(feedback);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// The live renderer's loop in miniature: last frame's field, decayed, is both
// the target the mold draws into and the image it smells on the next frame.
function closedLoop(seconds: number, captureAt: number[]) {
  const { canvas, gl } = context();
  const sim = createPhysarum(gl, SEED, 'high');
  const fade = sourceProgram(gl, `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D u_field; uniform float u_keep;
void main() { o = vec4(texture(u_field, v_uv).rgb * u_keep, 1); }`);
  let a = sourceTarget(gl, W, H, true);
  let b = sourceTarget(gl, W, H, true);
  if (!sim || !fade || !a || !b) throw new Error('closed-loop setup failed');
  const metrics: Record<string, Metrics> = {};
  const pngs: Record<string, string> = {};
  const vao = gl.createVertexArray();
  const pass = (from: WebGLTexture, to: WebGLFramebuffer | null, keep: number): void => {
    gl.useProgram(fade);
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to);
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from);
    gl.uniform1i(gl.getUniformLocation(fade, 'u_field'), 0);
    gl.uniform1f(gl.getUniformLocation(fade, 'u_keep'), keep);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  try {
    const frames = Math.round(seconds * FPS);
    for (let i = 0; i < frames; i++) {
      pass(a.texture, b.framebuffer, 0.92);
      sim.render(syntheticFrame(i / FPS), PALETTE, 1000 / FPS, a.texture, { framebuffer: b.framebuffer, width: W, height: H, opacity: 0.5 });
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      [a, b] = [b, a];
      const time = captureAt.find((c) => Math.round(c * FPS) === i + 1);
      if (time !== undefined) {
        pass(a.texture, null, 1);
        metrics[String(time)] = analyse(readPixels(gl));
        pngs[String(time)] = canvas.toDataURL();
      }
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error('GL error in closed loop');
    return { metrics, pngs };
  } finally {
    sim.dispose();
    gl.deleteProgram(fade);
    gl.deleteVertexArray(vao);
    disposeSourceTarget(gl, a);
    disposeSourceTarget(gl, b);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// Wall time per frame into a 1080p half-float target, one sim tick per frame.
// A one-texel read of the target before and after makes the queued GPU work
// count.
function bench(frames: number): { msPerFrame: number; gpu: string } {
  const { gl } = context();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const sim = createPhysarum(gl, SEED, 'high');
  const target = sourceTarget(gl, 1920, 1080, true);
  if (!sim || !target) throw new Error('bench setup failed');
  const feedback = feedbackTexture(gl, true);
  const texel = new Float32Array(4);
  const sync = (): void => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, texel);
  };
  const frame = syntheticFrame(1);
  const draw = (): void => {
    sim.render(frame, PALETTE, 1000 / FPS, feedback, { framebuffer: target.framebuffer, width: 1920, height: 1080, opacity: 0.5 });
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  };
  try {
    for (let i = 0; i < 30; i++) draw();
    sync();
    const started = performance.now();
    for (let i = 0; i < frames; i++) draw();
    sync();
    return { msPerFrame: (performance.now() - started) / frames, gpu };
  } finally {
    sim.dispose();
    disposeSourceTarget(gl, target);
    gl.deleteTexture(feedback);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

async function physarum() {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => { if (!ok) failures.push(message); };
  const fmt = (n: number): string => n.toFixed(3);

  const main = run('high', 6, [0.3, 0.5, 2, 3, 4, 6]);
  const m = main.metrics;
  for (const time of ['2', '4', '6']) {
    const x = m[time]!;
    check(x.lit > 0.04 && x.lit < 0.6, `${time}s: lit fraction ${fmt(x.lit)} outside 0.04..0.6`);
    check(x.white < 0.01, `${time}s: ${fmt(x.white)} of the frame is white`);
    check(x.structureRatio > 3, `${time}s: structure ratio ${fmt(x.structureRatio)} (a smeared blob measures ~1)`);
    check(x.cells >= 10, `${time}s: only ${x.cells} enclosed cells; a transport network has loops`);
    check(x.networked > 0.5, `${time}s: only ${fmt(x.networked)} of the light is in connected veins`);
    check(Math.min(...x.species) > 0.08, `${time}s: species shares ${x.species.map(fmt).join('/')}`);
  }
  check(m['3']!.lit > m['0.3']!.lit, `no growth: lit ${fmt(m['0.3']!.lit)} at 0.3s, ${fmt(m['3']!.lit)} at 3s`);
  check(m['3']!.reach > m['0.3']!.reach * 1.5, `no spread: reach ${fmt(m['0.3']!.reach)} at 0.3s, ${fmt(m['3']!.reach)} at 3s`);
  check(m['6']!.mean < m['4']!.mean * 0.8, `silence did not dim the network (${fmt(m['4']!.mean)} -> ${fmt(m['6']!.mean)})`);
  check(m['4']!.blob > 1.5, `the mold ignores bright feedback: blob patch at ${fmt(m['4']!.blob)}x the frame mean`);
  check(!main.state.attrib0 && main.state.activeUnit0, `GL state left behind: ${JSON.stringify(main.state)}`);

  // Without the bright patch, the same patch of field has no reason to be dense.
  const control = run('high', 4, [4], false);
  check(control.metrics['4']!.blob < m['4']!.blob, `blob control ${fmt(control.metrics['4']!.blob)} >= coupled ${fmt(m['4']!.blob)}`);

  const loop = closedLoop(6, [2, 6]);
  for (const [time, x] of Object.entries(loop.metrics)) {
    check(x.white < 0.02 && x.mean < 0.5, `closed loop ${time}s washes out: mean ${fmt(x.mean)}, white ${fmt(x.white)}`);
    check(x.lit > 0.04, `closed loop ${time}s is empty: lit ${fmt(x.lit)}`);
  }

  const tiers: Record<string, Metrics> = {};
  const tierPngs: Record<string, string> = {};
  for (const quality of ['medium', 'low'] as const) {
    const result = run(quality, 3, [3]);
    tiers[quality] = result.metrics['3']!;
    tierPngs[quality] = result.pngs['3']!;
    check(tiers[quality]!.lit > 0.04 && tiers[quality]!.lit < 0.6, `${quality}: lit ${fmt(tiers[quality]!.lit)}`);
    check(tiers[quality]!.structureRatio > 3, `${quality}: structure ratio ${fmt(tiers[quality]!.structureRatio)}`);
    check(tiers[quality]!.cells >= 5, `${quality}: only ${tiers[quality]!.cells} enclosed cells`);
  }

  const round = (x: Metrics) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? v.map((n) => +n.toFixed(3)) : +v.toFixed(3)]));
  return {
    failures,
    cpuMsPerFrame: +main.cpuMsPerFrame.toFixed(3),
    bench1080p: ((b) => ({ msPerFrame: +b.msPerFrame.toFixed(3), gpu: b.gpu }))(bench(240)),
    state: main.state,
    high: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)])),
    blobControl: +control.metrics['4']!.blob.toFixed(3),
    closedLoop: Object.fromEntries(Object.entries(loop.metrics).map(([k, v]) => [k, round(v)])),
    tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, round(v)])),
    captures: [
      ...['0.5', '2', '4', '6'].map((t) => ({ name: `high-${t}s`, png: main.pngs[t]! })),
      ...Object.entries(loop.pngs).map(([t, png]) => ({ name: `loop-${t}s`, png })),
      ...Object.entries(tierPngs).map(([q, png]) => ({ name: `${q}-3s`, png })),
    ],
  };
}

(window as unknown as { __physarumProbe: unknown }).__physarumProbe = physarum;
