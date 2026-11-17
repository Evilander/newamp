// Execute the actual Projector entry with DOM/timer and GPU boundary doubles.
// This tests routing and lifecycle, not browser layout or rendered pixels.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

class Target {
  listeners = new Map();
  addEventListener(type, fn, capture = false) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture }); this.listeners.set(type, list);
  }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l.fn !== fn)); }
  dispatchEvent(e) {
    for (const { fn } of [...(this.listeners.get(e.type) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
      fn(e); if (e.stopped) break;
    }
    return !e.defaultPrevented;
  }
}
function event(type, extra = {}) {
  return { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
}
function environment(initialMode = 'spectrum', autoVj = false) {
  const kit = { now: 0, renderers: [], guards: [], canvases: [], commands: [], tuningReads: 0, writes: [], failGpu: false, failGuard: false };
  const data = new Map([['newamp:projector:mode', initialMode], ['newamp:viz:autoVj', autoVj ? '1' : '0']]);
  class Element extends Target {
    constructor(tag = 'div') { super(); this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ''; } }; this.value = ''; this.textContent = ''; }
    append(...els) { for (const el of els) { el.parentElement = this; this.children.push(el); } }
    appendChild(el) { this.append(el); return el; }
    prepend(el) { el.parentElement = this; this.children.unshift(el); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); this.parentElement = null; }
    replaceChildren(...els) { for (const el of this.children) el.parentElement = null; this.children = []; this.append(...els); }
    replaceWith(el) { const p = this.parentElement; if (p) { const i = p.children.indexOf(this); this.remove(); p.children.splice(i, 0, el); el.parentElement = p; } }
    after(el) { const p = this.parentElement; p.children.splice(p.children.indexOf(this) + 1, 0, el); el.parentElement = p; }
    cloneNode() { const el = new Element(this.tagName); el.id = this.id; el.style = { ...this.style }; el.dataset = { ...this.dataset }; return el; }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    contains(el) { return this === el || this.children.some((c) => c.contains(el)); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { width: 320, height: 500 }; }
    getContext(type) { return kit.context ? kit.context(this, type) : {}; }
    setAttribute(k, v) { this.attributes[k] = v; if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; }
    getAttribute(k) { return this.attributes[k]; }
    removeAttribute(k) { delete this.attributes[k]; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      const attr = /^\[data-([\w-]+)\]$/.exec(selector)?.[1]?.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.children.flatMap((c) => [
        ...((attr ? attr in c.dataset : selector.split(', ').some((p) => p === `${c.tagName}:not(:disabled)` && !c.disabled)) ? [c] : []),
        ...c.querySelectorAll(selector),
      ]);
    }
    click() { this.focus(); this.dispatchEvent(event('click', { target: this })); }
  }
  class Button extends Element { constructor() { super('button'); } }
  class Input extends Element { constructor() { super('input'); } }
  class Select extends Element { constructor() { super('select'); } }
  const document = { createElement: (tag) => tag === 'button' ? new Button() : tag === 'input' ? new Input() : tag === 'select' ? new Select() : new Element(tag), activeElement: null };
  document.body = new Element('body'); document.documentElement = new Element('html');
  const canvas = new Element('canvas'); canvas.id = 'eviland-canvas';
  const iframe = new Element('iframe'); iframe.id = 'milkdrop-frame'; iframe.contentWindow = { postMessage() {} };
  document.body.append(canvas, iframe);
  document.getElementById = (id) => id === iframe.id ? iframe : document.body.children.find((c) => c.id === id);
  document.querySelector = (s) => document.body.querySelector(s);
  const timers = new Map(); let timerId = 0;
  const window = new Target();
  Object.assign(window, {
    location: { href: 'https://newamp.test/detached.html' }, innerWidth: 1280, innerHeight: 720,
    localStorage: { getItem: (key) => { if (key === 'newamp:viz:palette') kit.tuningReads++; return data.get(key) ?? null; }, setItem: (k, v) => { kit.writes.push([k, v]); data.set(k, v); } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, due: kit.now + ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, due: kit.now + ms, interval: ms }); return id; }, clearInterval(id) { timers.delete(id); },
    detachedViz: { transportCommand: async (...args) => { kit.commands.push(args); }, toggleFullscreen: async () => true, isFullscreen: async () => false, setFullscreen: async () => {}, close: async () => {}, rendererReady() {} },
  });
  const context = vm.createContext({ window, document, testKit: kit, HTMLElement: Element, HTMLButtonElement: Button, HTMLInputElement: Input, HTMLSelectElement: Select, navigator: { platform: 'MacIntel' }, performance: { now: () => kit.now }, URL, Uint8Array, Float32Array, Event, console: { ...console, error() {} }, requestAnimationFrame(fn) { kit.raf = fn; } });
  const advance = (ms) => {
    const end = kit.now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, t] = next; kit.now = t.due; timers.delete(id);
      if (t.interval) timers.set(id, { ...t, due: kit.now + t.interval });
      t.fn();
    }
    kit.now = end;
  };
  const port = { sent: [], start() {}, close() {}, postMessage(p) { this.sent.push(p); } };
  const attach = () => window.dispatchEvent(event('eviland:frame-port', { ports: [port] }));
  const send = (extra = {}) => port.onmessage({ data: { t: 1, frame: { energy: 0.1 }, palette: { accent: [1, 1, 1], dark: [0, 0, 0] }, dtMs: 33, transport: { isPlaying: true, currentTime: 30, duration: 100, volume: 0.75 }, ...extra } });
  const key = (key, extra = {}) => { const e = event('keydown', { key, code: key === ' ' ? 'Space' : key, target: document.activeElement, ...extra }); window.dispatchEvent(e); return e; };
  const button = (text) => document.body.querySelectorAll('button:not(:disabled)').find((b) => b.textContent === text || b.title === text);
  const menu = () => button('Visualizer modes and settings').click();
  const pick = (mode) => { menu(); button('Mode / Browse all modes…').click(); document.body.querySelectorAll('[data-projector-mode]').find((b) => b.dataset.projectorMode === mode).click(); key('Escape'); };
  const milkdrop = (...types) => { for (const type of types) window.dispatchEvent(event('message', { source: iframe.contentWindow, data: { type, error: 'simulated failure' } })); };
  return { context, kit, data, document, window, timers, advance, attach, send, key, button, menu, pick, iframe, milkdrop, port };
}
const stubs = {
  '/visualizer/eviland.ts': `export function createEvilandRenderer(canvas) { if(testKit.failGpu) return null; const r = { canvas, resize(){}, render(){}, setConfig(){}, setWaveform(){}, dispose(options){ this.disposed = options ?? {}; } }; testKit.renderers.push(r); return r; }`,
  '/visualizer/flash-guard-host.ts': `export function attachFlashGuard() { if(testKit.failGuard) return null; const g = { apply(){}, dispose(){ this.disposed = true; } }; testKit.guards.push(g); return g; }`,
  '/visualizer/context-fallback.ts': `export function watchContextFallback() { return { dispose(){}, onEvent(){} }; }`,
  '/visualizer/frame-fallback.ts': `export function createFrameFallbackPainter() { return { paint(){}, dispose(){} }; }`,
  '/visualizer/canvas-renderer.ts': `export function startCanvasVisualizer(options) { const c = { options }; testKit.canvases.push(c); return () => { c.stopped = true; }; }`,
  '/lib/pacedFrame.ts': `export function watchDisplayChange() { return () => {}; }`,
};
const plugin = (replacements) => ({ name: 'runtime-boundaries', setup(b) { b.onLoad({ filter: /\.tsx?$/ }, (args) => { const entry = Object.entries(replacements).find(([suffix]) => args.path.replaceAll('\\', '/').endsWith(suffix)); return entry ? { contents: entry[1], loader: 'ts' } : undefined; }); } });
const compiled = await build({ entryPoints: ['src/detached/main.tsx'], plugins: [plugin(stubs)], bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
const launch = (mode, auto, data = {}) => { const env = environment(mode, auto); for (const [k, v] of Object.entries(data)) env.data.set(k, v); vm.runInContext(compiled.outputFiles[0].text, env.context); env.attach(); return env; };

// Chromium leaves clicked buttons focused; Space always controls playback.
const e = launch('spectrum'); e.send();
for (const title of ['Next track', 'Play / pause', 'Toggle exclusive fullscreen']) {
  const control = e.button(title) ?? e.button('Enter exclusive fullscreen');
  assert.ok(control, `control exists: ${title}`);
  control.click();
  const before = e.kit.commands.length;
  assert.equal(e.key(' ').defaultPrevented, true);
  assert.deepEqual(e.kit.commands[before], ['togglePlay']);
  assert.equal(e.key(' ', { repeat: true }).defaultPrevented, true, 'held Space cannot activate the focused button');
  assert.equal(e.key('ArrowRight').defaultPrevented, true);
  assert.equal(e.key('ArrowUp').defaultPrevented, true);
}
// The scrub bar and the volume slider keep focus after a click or drag too.
for (const slider of e.document.body.querySelectorAll('input:not(:disabled)')) {
  slider.focus();
  let before = e.kit.commands.length;
  assert.equal(e.key(' ').defaultPrevented, true);
  assert.deepEqual(e.kit.commands.slice(before), [['togglePlay']], 'Space plays or pauses from a focused slider');
  before = e.kit.commands.length;
  assert.equal(e.key('ArrowRight').defaultPrevented, true, 'the arrow seeks instead of nudging the thumb');
  assert.deepEqual(e.kit.commands.slice(before), [['seek', 35]]);
  before = e.kit.commands.length;
  assert.equal(e.key('ArrowRight', { metaKey: true }).defaultPrevented, true);
  assert.equal(e.key('ArrowRight', { metaKey: true, repeat: true }).defaultPrevented, true, 'a held Cmd+Right skips once');
  assert.deepEqual(e.kit.commands.slice(before), [['next']]);
}
e.menu(); e.key('Escape');
assert.equal(e.document.activeElement.title, 'Visualizer modes and settings');
assert.equal(e.key(' ').defaultPrevented, true);
assert.deepEqual(e.kit.commands.at(-1), ['togglePlay']);
// Let the hide timer expire inside the menu, then close using Escape.
e.menu(); e.advance(2100); e.key('Escape');
assert.equal(e.document.body.style.cursor, 'default'); e.advance(2000);
assert.equal(e.document.body.style.cursor, 'none');
assert.equal(e.document.body.querySelector('[data-newamp-detached-controls]').style.opacity, '0');
// Payload bursts only read tuning every half second.
const reads = e.kit.tuningReads;
for (let i = 0; i < 100; i++) e.send();
assert.equal(e.kit.tuningReads, reads + 1); // time advanced since the last payload
for (let i = 0; i < 100; i++) e.send();
assert.equal(e.kit.tuningReads, reads + 1);
e.advance(501); e.send(); assert.equal(e.kit.tuningReads, reads + 2);
// A guarded GPU failure keeps chrome and switches to a saved 2D mode.
for (const failure of ['failGpu', 'failGuard']) {
  const f = launch('spectrum'); f.kit[failure] = true;
  f.pick('eviland');
  assert.equal(f.document.body.dataset.newampProjectorMode, 'spectrum');
  assert.equal(f.data.get('newamp:projector:mode'), 'spectrum');
  assert.ok(!f.kit.writes.some(([key, value]) => key === 'newamp:projector:mode' && value === 'eviland'), 'failed mode is never written, even transiently');
  assert.ok(f.document.body.querySelector('[data-newamp-detached-controls]'));
  assert.ok(f.button('Visualizer modes and settings'));
  assert.equal(f.iframe.src, 'about:blank');
  assert.ok(f.document.body.querySelector('[data-newamp-detached-status]').textContent.includes('GPU visualizer unavailable'));
  assert.equal(f.kit.canvases.at(-1).options.mode, 'spectrum');
  if (failure === 'failGuard') assert.equal(f.kit.renderers[0].disposed.releaseContext, true);
}
const boot = environment('eviland'); boot.kit.failGuard = true;
vm.runInContext(compiled.outputFiles[0].text, boot.context);
assert.equal(boot.data.get('newamp:projector:mode'), 'spectrum', 'a previously saved failed GPU mode recovers at boot');
const swap = launch('eviland'); swap.kit.failGuard = true;
swap.send({ config: { quality: 'low' } });
assert.equal(swap.data.get('newamp:projector:mode'), 'spectrum', 'quality rebuild failure recovers without losing chrome');
assert.equal(swap.kit.renderers[0].disposed.releaseContext, true);
const gl = launch('eviland');
const firstCanvas = gl.kit.renderers[0].canvas;
gl.pick('spectrum');
assert.equal(gl.kit.renderers[0].disposed.releaseContext, true);
assert.equal(gl.kit.guards[0].disposed, true);
gl.pick('eviland'); assert.notEqual(gl.kit.renderers[1].canvas, firstCanvas, 'revisit uses a fresh canvas after releasing GL');
gl.pick('butterchurn'); gl.milkdrop('ready', 'failed');
const fallback = gl.kit.renderers.at(-1);
assert.equal(gl.iframe.style.display, 'none');
gl.pick('spectrum'); assert.equal(fallback.disposed.releaseContext, true);
gl.pick('butterchurn'); gl.milkdrop('ready', 'failed');
assert.equal(gl.iframe.style.display, 'none', 'repeated MilkDrop failure cannot cover the fallback');
gl.pick('spectrum'); gl.pick('eviland-live');
assert.notEqual(gl.iframe.src, 'about:blank'); gl.pick('spectrum');
assert.equal(gl.iframe.src, 'about:blank', 'a mode switch cancels an in-flight navigation');
const demand = (env) => env.port.sent.filter((m) => m.type === 'analysis-demand').at(-1).enabled;
assert.equal(demand(gl), true, 'canvas requests analysis');
gl.pick('eviland-live'); assert.equal(demand(gl), false, 'MilkDrop opts out of analysis');
const failBoth = launch('eviland-live'); failBoth.kit.failGuard = true; failBoth.milkdrop('ready', 'failed');
assert.equal(failBoth.data.get('newamp:projector:mode'), 'spectrum');
// Persisted Auto-VJ, shared energy scale and pool, with no MilkDrop loads.
const vj = launch('spectrum', true);
vj.advance(15000); vj.send({ frame: { energy: 1 }, vjEnergy: 0.1 });
assert.equal(vj.document.body.dataset.newampProjectorMode, 'spectrum', 'reactor energy does not trigger the 0.42 threshold');
vj.send({ vjEnergy: 0.5 });
assert.equal(vj.document.body.dataset.newampProjectorMode, 'particle-flow');
for (let i = 0; i < 30; i++) { vj.advance(15000); vj.send({ vjEnergy: 0.8 }); assert.ok(!['butterchurn', 'eviland-live'].includes(vj.document.body.dataset.newampProjectorMode)); }
vj.menu(); vj.button('Auto-VJ: On').click();
assert.equal(vj.data.get('newamp:viz:autoVj'), '0');
vj.data.set('newamp:viz:autoVj', '1');
vj.window.dispatchEvent(event('storage', { key: 'newamp:viz:autoVj' }));
assert.ok(vj.button('Auto-VJ: On'), 'main-window storage change refreshes the open Projector menu');
// A look chosen by hand gets the whole duration before Auto-VJ moves on.
const looks = (env) => env.port.sent.filter((m) => m.type === 'look-command' && m.command === 'next-look').length;
const hand = launch('eviland-live', true, { 'newamp:viz:vj-dwell': '300' });
hand.advance(295000); hand.send();
assert.equal(looks(hand), 0);
hand.menu(); hand.button('Next look').click(); hand.key('Escape');
assert.equal(looks(hand), 1);
hand.advance(10000); hand.send();
assert.equal(looks(hand), 1, 'Auto-VJ does not replace a look picked 10 s ago');
hand.advance(291000); hand.send();
assert.equal(looks(hand), 2);
// So does one the main window changes by hand while this window steps it.
hand.advance(295000); hand.port.onmessage({ data: { type: 'look-changed' } });
hand.advance(10000); hand.send();
assert.equal(looks(hand), 2, 'a look changed by hand in the main window gets the whole duration');
hand.advance(291000); hand.send();
assert.equal(looks(hand), 3);
// While it runs Auto-VJ on an Eviland mode, the Projector steps the look the
// main window shares, and says so.
const steps = (env) => env.port.sent.filter((m) => m.type === 'auto-vj-looks').at(-1)?.enabled;
assert.equal(steps(hand), true);
hand.menu(); hand.button('Auto-VJ: On').click(); hand.key('Escape');
assert.equal(steps(hand), false);
hand.data.set('newamp:viz:autoVj', '1'); hand.window.dispatchEvent(event('storage', { key: 'newamp:viz:autoVj' }));
assert.equal(steps(hand), true);
hand.pick('spectrum'); assert.equal(steps(hand), false, 'canvas modes leave the shared look alone');
assert.equal(steps(launch('spectrum', false)), false);
// Auto-VJ stops choosing an Eviland renderer this machine could not start.
const noGpu = launch('oscilloscope', true); noGpu.kit.failGpu = true;
noGpu.advance(15000); noGpu.send({ vjEnergy: 0.5 });
assert.equal(noGpu.document.body.dataset.newampProjectorMode, 'spectrum', 'the GPU path failed once');
noGpu.pick('oscilloscope');
noGpu.advance(15000); noGpu.send({ vjEnergy: 0.5 });
assert.equal(noGpu.document.body.dataset.newampProjectorMode, 'particle-flow', 'the pool skips Eviland after it failed');
noGpu.pick('eviland');
assert.equal(noGpu.document.body.dataset.newampProjectorMode, 'spectrum', 'choosing it by hand still tries again');
noGpu.kit.failGpu = false; noGpu.pick('eviland');
assert.equal(noGpu.document.body.dataset.newampProjectorMode, 'eviland');
noGpu.pick('oscilloscope');
noGpu.advance(15000); noGpu.send({ vjEnergy: 0.5 });
assert.equal(noGpu.document.body.dataset.newampProjectorMode, 'eviland', 'once it starts, the pool includes it again');
// On a canvas mode a look changed in the main window is not this window's.
noGpu.pick('oscilloscope'); noGpu.advance(14000); noGpu.port.onmessage({ data: { type: 'look-changed' } });
noGpu.advance(1000); noGpu.send({ vjEnergy: 0.5 });
assert.equal(noGpu.document.body.dataset.newampProjectorMode, 'eviland');
// A mode switch replaces the MilkDrop document; what the old one posts while it
// unloads belongs to it, not to the new load.
const swapDoc = launch('eviland-live');
swapDoc.milkdrop('ready');
swapDoc.pick('butterchurn');
swapDoc.milkdrop('mounted', 'failed');
assert.equal(swapDoc.window.__newampDetachedStats.bcMounted, false);
assert.equal(swapDoc.window.__newampDetachedStats.bcFailed, false);
assert.equal(swapDoc.iframe.style.display, 'block', 'the new load is not hidden by the old one');
assert.equal(swapDoc.data.get('newamp:projector:mode'), 'eviland-live');
swapDoc.milkdrop('ready', 'mounted');
assert.equal(swapDoc.window.__newampDetachedStats.bcMounted, true);
assert.equal(swapDoc.data.get('newamp:projector:mode'), 'butterchurn');

// The real canvas renderers, with only the flash guard, the GPU and the frame
// loop doubled: every canvas mode the Projector draws is guarded, and the GL
// context of a mode it leaves is released after its canvas is gone.
const guardStubs = {
  ...stubs,
  '/visualizer/canvas-renderer.ts': undefined,
  '/visualizer/flash-guard-host.ts': `
    const guard = (kind, surface, extra) => { const g = { kind, surface, ...extra, apply(){}, show(){}, dispose(){ this.disposed = true; } }; testKit.guards.push(g); return g; };
    export const gpuFlashGuardSupported = () => testKit.gpu;
    export const attachFlashGuard = (gl, surface) => guard('gpu', surface);
    export const createGuarded2dSurface = (visible, mayMatter) => guard('2d', visible, { mayMatter, paint: visible });
    export const guardCanvas2d = (canvas) => guard('cpu', canvas);`,
  '/visualizer/particle-flow.ts': `export function createParticleFlowRenderer() { return { resize(){}, render(){}, dispose(){} }; }`,
  '/lib/pacedFrame.ts': `export const AMBIENT_FRAME_MS = 1000 / 30; export const PACED_FRAME_SLACK_MS = 6; export const displayRefreshMs = () => 1000 / 60;
    export function createCadenceGate() { return { due: () => false, commit() {}, msUntilDue: () => 0 }; }
    export function startPacedLoop() { return () => {}; } export function watchDisplayChange() { return () => {}; }`,
};
delete guardStubs['/visualizer/canvas-renderer.ts'];
const realModes = await build({ entryPoints: ['src/detached/main.tsx'], plugins: [plugin(guardStubs)], bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
const anything = new Proxy(function () {}, { get: (_, key) => key === Symbol.toPrimitive ? () => 1 : anything, apply: () => anything });
const gpuContext = (kit) => (canvas, type) => type === '2d' ? anything : new Proxy({}, {
  get: (_, key) => key === 'getExtension'
    ? () => ({ loseContext: () => kit.lost.push({ canvas, connected: canvas.isConnected }) })
    : typeof key === 'string' && /^[A-Z0-9_]+$/.test(key) ? 1 : () => ({}),
});
const { PRESETS } = await import(`data:text/javascript;base64,${Buffer.from((await build({ entryPoints: ['src/visualizer/modes.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })).outputFiles[0].text).toString('base64')}`);
const canvasModes = PRESETS.map((p) => p.id).filter((id) => !['eviland', 'eviland-live', 'butterchurn', 'album-breathe'].includes(id));
assert.ok(canvasModes.length >= 20);
for (const gpu of [true, false]) {
  const env = environment('spectrum'); env.kit.gpu = gpu; env.kit.lost = []; env.kit.context = gpuContext(env.kit);
  env.context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  vm.runInContext(realModes.outputFiles[0].text, env.context); env.attach(); env.send();
  let left = 'spectrum';
  for (const mode of [...canvasModes.filter((id) => id !== 'spectrum'), 'spectrum']) {
    const previous = env.document.body.children.find((c) => c.dataset.newampProjectorMode);
    const previousGuards = env.kit.guards.filter((g) => g.surface === previous);
    env.pick(mode);
    const surface = env.document.body.children.find((c) => c.dataset.newampProjectorMode === mode);
    assert.ok(surface, `${mode} paints on its own canvas`);
    const guards = env.kit.guards.filter((g) => g.surface === surface);
    assert.equal(guards.length, 1, `${mode} (gpu ${gpu}) is flash-guarded`);
    if (guards[0].kind === '2d') assert.equal(guards[0].mayMatter, true, `${mode}: a projector picture is always large enough to matter`);
    if (!gpu) assert.notEqual(guards[0].kind, 'gpu');
    assert.ok(previousGuards.length && previousGuards.every((g) => g.disposed), `leaving ${left} disposes its guard`);
    if (previousGuards[0].kind === 'gpu') {
      const released = env.kit.lost.filter((l) => l.canvas === previous);
      assert.ok(released.length && released.every((l) => !l.connected), `leaving ${left} releases its GL context on a removed canvas`);
    }
    left = mode;
  }
  if (gpu) assert.ok(env.kit.guards.some((g) => g.kind === 'gpu'));
}
// Particle Flow wakes the audio context only once it runs on the GPU; the 2D
// fallback leaves it as it was, as before the renderer moved.
{
  const env = environment(); env.kit.lost = []; env.kit.context = gpuContext(env.kit);
  env.context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  const renderer = await build({ stdin: { contents: `export { startCanvasVisualizer } from './src/visualizer/canvas-renderer';`, resolveDir: process.cwd(), loader: 'ts' }, plugins: [plugin(guardStubs)], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'rendererTest', target: 'es2022', logLevel: 'silent' });
  vm.runInContext(renderer.outputFiles[0].text, env.context);
  const audio = { frequencyBinCount: 1024, fftSize: 2048, getSampleRate: () => 48000, getFreqData() {}, getOnsetFreqData() {}, getTimeData() {}, getState: () => ({ playing: true }) };
  for (const gpu of [false, true]) {
    env.kit.gpu = gpu;
    let starts = 0;
    const canvas = env.document.createElement('canvas'); env.document.body.append(canvas);
    const stop = env.context.rendererTest.startCanvasVisualizer({ canvas, engine: audio, mode: 'particle-flow', performance: 'balanced', quality: 'auto', tuning: { current: { palette: 'look', reactivity: 'punch' } }, frameIntervalMs: 1000 / 30, dprCap: 1, maxPixels: 2_000_000, isFullscreen: false, mayFlashLarge: false, onGpuStart: () => { starts += 1; } });
    assert.equal(starts, gpu ? 1 : 0, gpu ? 'GPU Particle Flow starts the audio' : 'the 2D fallback does not');
    canvas.remove(); stop();
  }
}
console.log('[projector-runtime-test] PASS (keyboard, GPU recovery/disposal, navigation, Auto-VJ, tuning, idle timer)');

// Execute the producer tick too, so skipped waveform reads are tested at
// their source rather than inferred from a source-code pattern.
const producerStubs = {
  '/visualizer/eviland-audio.ts': `export function createEvilandReactor() { return { analyze(){ return { energy: 0.1, sectionId: 0 }; }, reset(){} }; }`,
  '/visualizer/eviland-director.ts': `export function createDirector() { return { update(){ return { palette: {}, seed: 'test' }; }, reset(){} }; }`,
  '/visualizer/eviland-score-feed.ts': `export function createEngineScoreFeed() { return { conduct(){}, dispose(){} }; }`,
  '/visualizer/eviland-appearance.ts': `export const liveGradeFor = () => 1; export const resolveEvilandPalette = () => ({}); export const sleeveFor = () => null; export const themePaletteFromAccent = () => ({}); export const tuneEvilandFrame = (f) => f;`,
  '/visualizer/eviland-operators.ts': `export const applyWaveformOverride = (c) => c; export const cloneConfig = (c) => c; export const stripTransitionMeta = (c) => c;`,
  '/visualizer/eviland-randomizer.ts': `export const generate = () => ({ config: {} }); export const decode = () => null;`,
  '/visualizer/eviland-memory-bridge.ts': `export const sceneSeedForTrack = () => null; export const createMemoryBridge = () => ({});`,
  '/visualizer/art-palette.ts': `export function watchArtPalette() {}`,
  '/visualizer/look-requests.ts': `export const createLookRequestCursor = () => ({ drain(){} });`,
  '/lib/api.ts': `export const api = { getArtUrl(){ return ''; } };`,
};
const producerBuild = await build({ stdin: { contents: `export { startEvilandProducer } from './src/visualizer/eviland-producer'; export { frameBus } from './src/visualizer/frame-bus'; export { visualizerEnergy } from './src/components/visualizer-energy';`, resolveDir: process.cwd(), loader: 'ts' }, plugins: [plugin(producerStubs)], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'producerTest', target: 'es2022', logLevel: 'silent' });
const p = environment();
p.context.getComputedStyle = () => ({ getPropertyValue: () => '' });
vm.runInContext(producerBuild.outputFiles[0].text, p.context);
const { startEvilandProducer, frameBus, visualizerEnergy } = p.context.producerTest;
let timeReads = 0;
const engine = {
  ctx: { state: 'running' }, frequencyBinCount: 1024, fftSize: 2048, getSampleRate: () => 48000,
  getFreqData: (out) => out.fill(150), getOnsetFreqData: (out) => out.fill(150),
  getLeftFreqData: (out) => out.fill(150), getRightFreqData: (out) => out.fill(150),
  getTimeData: (out) => { timeReads++; out.fill(128); }, getOnsetTimeData: (out) => out.fill(128),
};
let posted;
const producerPort = { postMessage(payload) { posted = structuredClone(payload); }, start() {}, close() {} };
frameBus.attachDetachedPort(producerPort);
const stop = startEvilandProducer(engine, () => ({ director: true, seed: null, nonce: 0, waveMode: 'auto', trackId: null, projectorQuality: 'medium' }));
p.advance(33);
assert.equal(timeReads, 0, 'MilkDrop default does not read a second waveform');
assert.equal(posted.analysis, undefined);
assert.equal(posted.vjEnergy, visualizerEnergy(new Uint8Array(1024).fill(150), 48000, 2048), 'producer uses main-window energy scale');
producerPort.onmessage({ data: { type: 'analysis-demand', enabled: true } });
p.advance(33);
assert.equal(timeReads, 1); assert.equal(posted.analysis.frequency.length, 1024); assert.equal(posted.analysis.waveform.length, 2048);
producerPort.onmessage({ data: { type: 'analysis-demand', enabled: false } });
p.advance(33);
assert.equal(timeReads, 1); assert.equal(posted.analysis, undefined, 'switching back removes analysis and its read');
stop(); frameBus.detachPort();
console.log('[projector-producer-test] PASS (analysis demand, waveform reads, shared energy scale)');
