// Behavioural tests for delayed compilation, crossfade continuity and ownership.
// The fake driver deliberately takes longer than a second to compile; no
// synchronous link/location query may escape onto that waiting render path.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
await mkdir('tmp/eviland-transition-resources', { recursive: true });
const outfile = resolve('tmp/eviland-transition-resources/resources-test.mjs');
await build({ stdin: { contents: `export { createSceneOverlay } from './src/visualizer/scene-overlay'; export { createLivePresetLoader } from './src/visualizer/eviland-live-presets'; export { SCENES } from './src/visualizer/scenes/index';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { createSceneOverlay, createLivePresetLoader, SCENES } = await import(pathToFileURL(outfile).href);
function driver() {
  let next = 0;
  const programs = [], shaders = [], draws = [];
  const gl = {
    programs, shaders, draws, linkQueries: 0, locationQueries: 0, autoReady: true,
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, COMPILE_STATUS: 4,
    createProgram() { const p = { id: ++next, ready: this.autoReady, linked: true, deleted: false, values: {}, attached: [] }; programs.push(p); return p; },
    createShader() { const s = { deleted: false }; shaders.push(s); return s; },
    createVertexArray() { return {}; },
    deleteVertexArray() {},
    shaderSource() {}, compileShader() {}, linkProgram() {},
    attachShader(p, s) { p.attached.push(s); },
    deleteShader(s) { if (s) s.deleted = true; },
    deleteProgram(p) { if (p) { assert.equal(p.deleted, false, 'program deleted twice'); p.deleted = true; } },
    getAttachedShaders(p) { return p.attached; },
    getExtension(name) { return name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: 5 } : null; },
    getProgramParameter(p, param) { if (param === 5) return p.ready; this.linkQueries++; assert.ok(p.ready, 'blocking link query'); return p.linked; },
    getUniformLocation(p, name) { this.locationQueries++; assert.ok(p.ready, 'blocking uniform query'); return { p, name }; },
    getAttribLocation(p) { this.locationQueries++; assert.ok(p.ready, 'blocking attribute query'); return 2; },
    getShaderParameter() { return true; }, getProgramInfoLog() { return 'intentional test failure'; },
    useProgram(p) { this.current = p; },
    uniform1f(loc, value) { if (loc) loc.p.values[loc.name] = value; },
    uniform1fv() {}, uniform2f() {}, uniform3f() {}, uniform4f() {},
    bindVertexArray() {}, bindFramebuffer() {}, viewport() {}, disable() {}, enable() {},
    blendEquation() {}, blendFunc() {}, clearColor() {}, clear() {}, isContextLost() { return false; },
    drawArrays() { draws.push({ program: this.current.id, ...this.current.values }); },
  };
  return gl;
}
const frame = { energy: 0.4, bass: 0.4, vocal: 0.3, snare: 0.2, hat: 0.2, kick: 0.3, centroid: 0.4, flatness: 0.3, crest: 0.3, beatPhase: 0, beatConfidence: 1, novelty: 0, pan: 0, width: 0.5, bands: new Float32Array(24).fill(0.3), onsets: [], sectionId: 0 };
const palette = { accent: [0.1, 0.8, 1], dark: [0.3, 0.1, 0.6], light: [1, 0.8, 0.4], bg: [0, 0, 0] };
{
  const gl = driver();
  const overlay = createSceneOverlay({ width: 320, height: 180 }, { gl, seedKey: 'old' });
  overlay.setScene('medusa-bloom');
  overlay.render(frame, palette, 16);
  const oldSeed = gl.draws.at(-1).u_seed;
  gl.autoReady = false;
  overlay.setSeedKey('new');
  overlay.setScene('chromatin-flow');
  const queries = gl.linkQueries;
  for (let i = 0; i < 100; i++) overlay.render(frame, palette, 16);
  assert.equal(gl.linkQueries, queries, 'slow compiler must never be forced after 45 frames');
  assert.equal(gl.draws.at(-1).u_seed, oldSeed, 'outgoing anatomy retains its seed');
  assert.equal(gl.draws.at(-1).u_fade, 1, 'outgoing image stays whole while waiting');
  for (const p of gl.programs) p.ready = true;
  gl.autoReady = true;
  for (let i = 0; i < 100; i++) overlay.render(frame, palette, 16);
  const beforeReseed = gl.draws.at(-1).u_seed;
  overlay.setSeedKey('another');
  const n = gl.draws.length;
  overlay.render(frame, palette, 0);
  assert.equal(gl.draws.length - n, 2, 'same-scene reseeding crossfades both instances');
  assert.equal(gl.draws[n].u_seed, beforeReseed);
  assert.equal(gl.draws[n].u_fade, 1);
  assert.equal(gl.draws[n + 1].u_fade, 0);
  for (let i = 0; i < 100; i++) overlay.render(frame, palette, 16);
  overlay.setScene('medusa-bloom');
  overlay.setScene('chromatin-flow');
  const rapidStart = gl.draws.length;
  overlay.render(frame, palette, 0);
  assert.equal(gl.draws.length - rapidStart, 1, 'A to B to A before paint cancels the fade');
  assert.equal(gl.draws.at(-1).u_fade, 1, 'rapid return never fades the visible image to black');
  for (const scene of SCENES) { overlay.setScene(scene.id); overlay.render(frame, palette, 16); }
  assert.ok(gl.programs.filter(p => !p.deleted).length <= 8, 'scene program residency is bounded');
  gl.autoReady = false;
  for (const scene of SCENES) overlay.prepareScene(scene.id);
  assert.ok(gl.programs.filter(p => !p.deleted).length <= 10, 'rapid changes cancel obsolete compiles');
  overlay.dispose();
  assert.ok(gl.programs.every(p => p.deleted));
  assert.ok(gl.shaders.every(s => s.deleted));
}
function shaderSlot(gl) {
  return {
    gl, shaderProgram: gl.createProgram(),
    createShader(text) {
      this.shaderProgram = this.gl.createProgram();
      const vs = this.gl.createShader(gl.VERTEX_SHADER), fs = this.gl.createShader(gl.FRAGMENT_SHADER);
      this.gl.shaderSource(vs, text); this.gl.shaderSource(fs, text);
      this.gl.compileShader(vs); this.gl.compileShader(fs);
      this.gl.attachShader(this.shaderProgram, vs); this.gl.attachShader(this.shaderProgram, fs);
      this.gl.linkProgram(this.shaderProgram);
      this.position = this.gl.getAttribLocation(this.shaderProgram, 'position');
      this.color = this.gl.getUniformLocation(this.shaderProgram, 'color');
      this.userTextures = [{ sampler: 'foo', textureLoc: this.gl.getUniformLocation(this.shaderProgram, 'foo') }];
    },
    updateShader(text) { this.createShader(text); },
  };
}
{
  const gl = driver();
  const host = { gl, warpShader: shaderSlot(gl), prevWarpShader: shaderSlot(gl), compShader: shaderSlot(gl), prevCompShader: shaderSlot(gl) };
  let loads = 0, failLoad = false, recovered = 0;
  const visualizer = { renderer: host, loadPreset(preset) {
    loads++;
    if (failLoad) throw new Error('broken preset equation');
    [host.warpShader, host.prevWarpShader] = [host.prevWarpShader, host.warpShader];
    [host.compShader, host.prevCompShader] = [host.prevCompShader, host.compShader];
    host.warpShader.updateShader(preset.warp); host.compShader.updateShader(preset.comp);
  } };
  const oldWarp = host.warpShader.shaderProgram;
  const oldUpdates = new Map([host.warpShader, host.prevWarpShader, host.compShader, host.prevCompShader].map(slot => [slot, slot.updateShader]));
  const loader = createLivePresetLoader(visualizer, () => {
    recovered++; failLoad = false;
    visualizer.loadPreset({ warp: 'fallback', comp: 'fallback' });
  });
  gl.autoReady = false;
  loader.request({ warp: 'a', comp: 'b' }, 'one', 4.5);
  for (let i = 0; i < 100; i++) assert.equal(loader.advance(), false);
  assert.equal(loads, 0); assert.equal(gl.linkQueries, 0); assert.equal(gl.locationQueries, 0);
  assert.equal(host.warpShader.shaderProgram, oldWarp);
  loader.request({ warp: 'c', comp: 'd' }, 'two', 4.5);
  assert.equal(gl.programs.filter(p => !p.deleted).length, 6, 'cancelled pair released; only current, previous, incoming remain');
  for (const p of gl.programs) p.ready = true;
  assert.equal(loader.advance(), true);
  assert.equal(loads, 1);
  assert.equal(host.warpShader.position, 2);
  assert.equal(host.warpShader.color.p, host.warpShader.shaderProgram);
  assert.equal(host.warpShader.userTextures[0].textureLoc.p, host.warpShader.shaderProgram);
  assert.equal(host.prevWarpShader.shaderProgram, oldWarp, 'previous shader kept for the MilkDrop blend');
  assert.equal(gl.programs.filter(p => !p.deleted).length, 4);
  const count = gl.programs.length;
  loader.request({ warp: 'c', comp: 'd' }, 'two', 4.5);
  assert.equal(gl.programs.length, count, 'repeated audio messages do not rebuild a look');
  loader.request({ warp: 'broken', comp: 'broken' }, 'broken', 4.5);
  for (const p of gl.programs.slice(-2)) { p.ready = true; p.linked = false; }
  const warn = console.warn;
  try { console.warn = () => {}; assert.equal(loader.advance(), false); }
  finally { console.warn = warn; }
  assert.equal(loads, 1, 'failed shaders leave the current preset running');
  assert.equal(gl.programs.filter(p => !p.deleted).length, 4, 'failed pair released');
  assert.equal(recovered, 0, 'a failed shader does not disturb the host');
  gl.autoReady = true;
  failLoad = true;
  loader.request({ warp: 'valid', comp: 'valid' }, 'broken-equation', 4.5);
  try { console.warn = () => {}; assert.equal(loader.advance(), false); }
  finally { console.warn = warn; }
  assert.equal(recovered, 1, 'equation failure invokes host recovery');
  assert.equal(host.warpShader.color.p, host.warpShader.shaderProgram);
  assert.equal(gl.programs.filter(p => !p.deleted).length, 4, 'recovery frees the unused prepared pair');
  loader.request({ warp: 'e', comp: 'f' }, 'three', 4.5);
  loader.dispose();
  loader.dispose();
  for (const [slot, update] of oldUpdates) assert.equal(slot.updateShader, update);
  assert.equal(gl.programs.filter(p => !p.deleted).length, 4, 'dispose releases only unadopted programs');
  assert.ok(gl.shaders.every(s => s.deleted));
}
console.log('[eviland-transition-resources] PASS: delayed shaders, seed continuity, bounded cache, cancellation, adoption and disposal');
