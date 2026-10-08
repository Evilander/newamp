// Flash guard render gate: bundles the real output routes (the production
// shader painters from Visualizer.tsx, the Eviland renderer, Butterchurn with
// and without the Eviland Live pipeline, the 2D presenter and the CPU guard)
// with esbuild, runs them in an Electron window with a real WebGL2 context on
// a fixed 60 Hz clock, and counts the flashes in what each one displays,
// protection off and on (see flash-guard-probe.ts).
//
// Fails if: Burning Cloud with Punch on dense music doesn't reproduce the
// hazard unguarded; any guarded run shows more than three flashes in any
// second, counted as confirmed whole-field pairs, frame-mean pairs or pairs
// in any 1%-of-the-screen region; content with nothing flashing past two a
// second changes by more than half a level; a synthetic strobe gets through
// the presenter or CPU guard; flicker whose pixels flash out of step (stripes,
// dots, reversing checkerboards, every other column of a large canvas) leaves
// any pixel flashing more than three times a second; or the GPU guard drifts
// from the TypeScript spec, on a
// uniform strobe or pixel by pixel on Burning Cloud. Also reports the guard's
// GPU cost per frame at 1080p and 4K.
//
// Under software GL (CI=1 or NEWAMP_SOFTWARE_GL=1: SwiftShader through ANGLE,
// the way CI asks for it) the full sweep takes far too long, so a reduced one
// runs instead: which guard each route gets there, Burning Cloud on dense
// music, calm looks, one Eviland, MilkDrop and Live run, the strobes and the
// out-of-step flicker, spec parity and the guard's cost at the low tier's
// size, against the same limits.
// NEWAMP_SOFTWARE_GL=app runs it under the app's own software-rendering
// switches instead (the ones electron/main.ts applies after a GPU crash or
// with hardware acceleration turned off). FLASH_GUARD_REDUCED=1 picks the
// reduced sweep on a GPU.
//
// Run with: npm run test:flash-guard-render
// Results land in tmp/flash-guard-render/result.json.

import { build } from 'esbuild';
import { butterchurnMegabufEsbuildPlugin } from './butterchurn-megabuf.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outRoot = resolve('tmp', 'flash-guard-render');
const appSoftware = process.env.NEWAMP_SOFTWARE_GL === 'app';
const softwareGl = Boolean(process.env.CI) || process.env.NEWAMP_SOFTWARE_GL === '1';
const reduced = softwareGl || appSoftware || process.env.FLASH_GUARD_REDUCED === '1';
const hardTimeout = setTimeout(() => fail(new Error('flash guard render test timed out')), reduced ? 1200000 : 900000);

const { app } = await import('electron');
app.commandLine.appendSwitch('no-sandbox');
if (appSoftware) {
  // Mirrors applySoftwareRenderingSwitches('normal') in electron/main.ts.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-rasterization');
  app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,UseSkiaRenderer,VizDisplayCompositor');
  app.commandLine.appendSwitch('in-process-gpu');
} else if (softwareGl) {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
// Closing the probe window must not quit before finish() has run.
app.on('window-all-closed', () => {});
// No top-level await on ready: Electron holds `ready` until this module
// finishes evaluating, so awaiting it here deadlocks the process.
void app.whenReady().then(runElectron).then(finish).catch(fail);

// Visualizer.tsx pulls in the player store (which builds the audio engine and
// talks to the main process) and the IPC API. The probe hands the painters
// their own engine, so both are stood in for.
const STORE_STUB = `
const state = { engine: null, evilandDirector: false, evilandSeed: null, evilandConfigNonce: 0,
  evilandWaveMode: 'auto', current: null, fullscreenViz: false };
export const usePlayerStore = Object.assign((select) => select(state), { getState: () => state });
export const engine = null;`;
const API_STUB = `export const api = new Proxy({}, { get: () => () => Promise.resolve(null) });`;

const stubs = {
  name: 'flash-guard-stubs',
  setup(b) {
    b.onResolve({ filter: /(^|\/)store\/usePlayerStore$/ }, () => ({ path: 'store', namespace: 'stub' }));
    b.onResolve({ filter: /(^|\/)lib\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: args.path === 'store' ? STORE_STUB : API_STUB, loader: 'js' }));
  },
};

async function bundleProbe() {
  await mkdir(outRoot, { recursive: true });
  await build({
    entryPoints: [resolve('scripts', 'flash-guard-probe.ts')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(outRoot, 'probe.js'),
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [stubs, butterchurnMegabufEsbuildPlugin()],
  });
  const htmlPath = join(outRoot, 'probe.html');
  await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><title>flash guard probe</title><body style="margin:0"><script src="./probe.js"></script></body>', 'utf8');
  return pathToFileURL(htmlPath).toString();
}

async function runElectron() {
  const { BrowserWindow } = await import('electron');
  const url = await bundleProbe();
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false, sandbox: false } });
  try {
    await win.loadURL(url);
    // FLASH_GUARD_LOOK=<shader look>: that look alone, with its worst 1%
    // region's series, for diagnosis.
    const debugMode = process.env.FLASH_GUARD_LOOK;
    const entry = debugMode
      ? `window.__flashGuardDebug(${JSON.stringify(debugMode)})`
      : reduced ? 'window.__flashGuardReduced()' : 'window.__flashGuardProbe()';
    return await win.webContents.executeJavaScript(entry, true);
  } finally {
    win.destroy();
  }
}

async function finish(result) {
  if (result.mode) {
    await writeFile(join(outRoot, `debug-${result.mode}.json`), JSON.stringify(result), 'utf8');
    console.log(`[flash-guard-render] debug ${result.mode}: ${JSON.stringify({ before: result.before.maxRegionalPerSecond, after: result.after.maxRegionalPerSecond, region: result.after.worstRegion.index })}`);
    clearTimeout(hardTimeout);
    app.exit(0);
    return;
  }
  await writeFile(join(outRoot, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  const bc = result.burningCloudDense;
  console.log(`[flash-guard-render] GPU: ${result.gpu}`);
  console.log(`[flash-guard-render] Burning Cloud + Punch, dense: confirmed flashes/s ${bc.before.maxConfirmedPerSecond} → ${bc.after.maxConfirmedPerSecond}, whole-field ${bc.before.maxFieldPairsPerSecond} → ${bc.after.maxFieldPairsPerSecond}, 1% region ${bc.before.maxRegionalPerSecond} → ${bc.after.maxRegionalPerSecond}, pixels with ≥4 pairs/s ${bc.before.pixelsWith4PairsPerSecond}% → ${bc.after.pixelsWith4PairsPerSecond}%, mean luminance ${bc.before.meanLuminance} → ${bc.after.meanLuminance}`);
  console.log(`[flash-guard-render] before: ${bc.before.firstConfirmed.join(', ')}`);
  if (result.sweep === 'reduced') {
    console.log(`[flash-guard-render] routes: ${JSON.stringify(result.routes)}`);
    for (const [name, run] of Object.entries({ ...result.calm, ...result.routesRun })) {
      console.log(`[flash-guard-render] ${name}: 1% region ${run.before.maxRegionalPerSecond} → ${run.after.maxRegionalPerSecond}, whole-field ${run.before.maxFieldPairsPerSecond} → ${run.after.maxFieldPairsPerSecond}, changed ${run.after.meanAbsDiff} / 255, mean luminance ${run.before.meanLuminance} → ${run.after.meanLuminance}`);
    }
    for (const [name, run] of Object.entries(result.synthetic)) {
      console.log(`[flash-guard-render] strobe ${name}: whole-field ${run.before?.maxFieldPairsPerSecond ?? '-'} → presenter ${run.presenter.maxFieldPairsPerSecond}, CPU ${run.canvas2d.maxFieldPairsPerSecond}; red at a pixel presenter ${run.presenter.peakRedPairsAtAnyPixel}, CPU ${run.canvas2d.peakRedPairsAtAnyPixel}; presenter changed ${run.presenter.meanAbsDiff ?? '-'} / 255`);
    }
    console.log(`[flash-guard-render] timings (ms): ${JSON.stringify(result.timingsMs)}`);
  }
  for (const [name, run] of Object.entries(result.dispersed ?? {})) {
    console.log(`[flash-guard-render] ${name}: most flashes/s at a pixel ${run.before.peakPairsAtAnyPixel} → presenter ${run.presenter.peakPairsAtAnyPixel}, CPU ${run.canvas2d.peakPairsAtAnyPixel}; pixels with ≥4 pairs/s ${run.before.pixelsWith4PairsPerSecond}% → ${run.presenter.pixelsWith4PairsPerSecond}%, CPU ${run.canvas2d.pixelsWith4PairsPerSecond}%; GPU vs spec ${JSON.stringify(run.parity)}`);
  }
  if (result.lattice) console.log(`[flash-guard-render] every even column strobing at 1024x576: most flashes/s at a pixel ${result.lattice.before.peakPairsAtAnyPixel} → ${result.lattice.after.peakPairsAtAnyPixel}, pixels with ≥4 pairs/s ${result.lattice.before.pixelsWith4PairsPerSecond}% → ${result.lattice.after.pixelsWith4PairsPerSecond}%; GPU vs spec at 640x360 ${JSON.stringify(result.lattice.parity)}`);
  console.log(`[flash-guard-render] GPU vs spec: ${JSON.stringify(result.specParity)}, Burning Cloud pixel by pixel ${JSON.stringify(result.contentParity)}`);
  console.log(`[flash-guard-render] cost: ${JSON.stringify(result.cost)}`);
  console.log(`[flash-guard-render] full results: ${join(outRoot, 'result.json')}`);
  if (result.failures?.length) {
    throw new Error(`${result.failures.length} check(s) failed:\n  ${result.failures.join('\n  ')}`);
  }
  console.log('[flash-guard-render] PASS');
  clearTimeout(hardTimeout);
  app.exit(0);
}

function fail(err) {
  console.error('[flash-guard-render] FAIL', err?.stack || err);
  clearTimeout(hardTimeout);
  app.exit(1);
}
