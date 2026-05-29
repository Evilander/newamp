import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Deterministic, audio-free check of the WebGL2 GPU particle flow-field
// visualizer. esbuild-bundles the real module, runs it in a hardware WebGL2
// context, renders ~50 frames at low energy then ~50 at high energy, and reads
// back pixels to assert it (1) creates a renderer, (2) draws non-blank frames
// (transform feedback + additive points work), and (3) reacts to audio energy.
// Needs a display + WebGL2, so it runs locally / in the release per-OS legs.

const repoRoot = resolve('.');

let bundle;
try {
  const result = await build({
    entryPoints: [resolve(repoRoot, 'src/visualizer/particle-flow.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'ParticleFlow',
    write: false,
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0].text;
} catch (err) {
  console.error('[particle-flow-smoke] esbuild bundling failed:', err);
  process.exit(1);
}

function fail(message, extra) {
  console.error(`[particle-flow-smoke] FAIL: ${message}`, extra ?? '');
  if (app.isReady()) app.exit(1);
  else process.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 360,
    height: 280,
    show: false,
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent('<!doctype html><html><body style="margin:0"><canvas id="c" width="320" height="240"></canvas></body></html>'),
  );

  // Inject the bundled module into the page realm.
  await win.webContents.executeJavaScript(bundle);

  let res;
  try {
    res = await win.webContents.executeJavaScript(`(() => {
      const c = document.getElementById('c');
      const r = window.ParticleFlow.createParticleFlowRenderer(c, { particles: 24000, smoke: true });
      if (!r) return { ok: false, reason: 'createParticleFlowRenderer returned null (no WebGL2 / transform feedback)' };
      r.resize(320, 240, 1);
      const low  = { bass: 0.02, mid: 0.02, treble: 0.02, rms: 0.02, beat: 0,   kick: 0,   beatEdge: false };
      const high = { bass: 0.92, mid: 0.70, treble: 0.60, rms: 0.70, beat: 1.0, kick: 0.9, beatEdge: true  };
      const lit = () => {
        const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
        const x = t.getContext('2d'); x.drawImage(c, 0, 0);
        const d = x.getImageData(0, 0, t.width, t.height).data;
        let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i+1] + d[i+2] > 40) n++; }
        return n;
      };
      for (let i = 0; i < 50; i++) r.render(low, [0.2, 1.0, 0.6], 1/60);
      const litLow = lit();
      for (let i = 0; i < 50; i++) r.render(high, [0.2, 1.0, 0.6], 1/60);
      const litHigh = lit();
      const particles = r.particleCount;
      r.dispose();
      return { ok: true, litLow, litHigh, particles };
    })()`);
  } catch (err) {
    return fail('in-page probe threw', err);
  }

  if (!res.ok) return fail(res.reason);
  if (res.litLow <= 0) return fail('renderer drew a blank frame at low energy', res);
  if (res.litHigh <= 0) return fail('renderer drew a blank frame at high energy', res);
  if (res.litLow === res.litHigh) return fail('renderer did not react to audio energy', res);

  console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  app.exit(0);
});

setTimeout(() => fail('overall timeout'), 30000);
