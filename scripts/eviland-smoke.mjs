import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Deterministic, end-to-end GPU proof of the Eviland flagship visualizer.
// esbuild-bundles the REAL reactor (eviland-audio.ts) and renderer (eviland.ts),
// runs them in a hardware WebGL2 context, feeds synthetic FFT bytes (silence,
// then a loud beat-driven signal), reads back pixels, and asserts:
//   1. the renderer creates (WebGL2 + EXT_color_buffer_float present),
//   2. high-energy frames are non-blank (the feedback field + emitters draw),
//   3. it reacts — more lit pixels under load than at rest,
//   4. the audio reactor actually fires onset events from the synthetic signal
//      (the causal-reactivity core, not just "something glows").
// Needs a display + WebGL2, so it runs locally / in the release per-OS legs.

const repoRoot = resolve('.');

async function bundle(entry, globalName) {
  const result = await build({
    entryPoints: [resolve(repoRoot, entry)],
    bundle: true,
    format: 'iife',
    globalName,
    write: false,
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

let rendererBundle;
let audioBundle;
try {
  rendererBundle = await bundle('src/visualizer/eviland.ts', 'Eviland');
  audioBundle = await bundle('src/visualizer/eviland-audio.ts', 'EvilandAudio');
} catch (err) {
  console.error('[eviland-smoke] esbuild bundling failed:', err);
  process.exit(1);
}

function fail(message, extra) {
  console.error(`[eviland-smoke] FAIL: ${message}`, extra ?? '');
  if (app.isReady()) app.exit(1);
  else process.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 360,
    height: 240,
    show: false,
    webPreferences: { offscreen: false },
  });

  const html = `<!doctype html><html><body style="margin:0;background:#000">
    <canvas id="c" width="320" height="200"></canvas>
    <script>${audioBundle}</script>
    <script>${rendererBundle}</script>
  </body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const probe = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.getElementById('c');
    const RR = window.Eviland;
    const AA = window.EvilandAudio;
    const createRenderer = RR.createEvilandRenderer || (RR.default && RR.default.createEvilandRenderer);
    const createReactor = AA.createEvilandReactor || (AA.default && AA.default.createEvilandReactor);
    if (typeof createRenderer !== 'function') return { ok: false, reason: 'no renderer factory' };
    if (typeof createReactor !== 'function') return { ok: false, reason: 'no reactor factory' };

    const renderer = createRenderer(canvas, { quality: 'high', smoke: true });
    if (!renderer) return { ok: false, reason: 'null renderer (no webgl2 / float)' };
    // Build the float FBOs before rendering — render() no-ops until resize runs.
    renderer.resize(canvas.width, canvas.height, 1);

    const sampleRate = 48000;
    const fftSize = 2048;
    const binCount = fftSize / 2;
    const reactor = createReactor({ sampleRate, fftSize, binCount });

    const freq = new Uint8Array(binCount);
    const onsetFreq = new Uint8Array(binCount);
    const leftFreq = new Uint8Array(binCount);
    const rightFreq = new Uint8Array(binCount);
    const palette = { accent: [0.2,1,0.3], dark: [0.8,0.2,0.2], light: [1,1,1], bg: [0.02,0.02,0.04] };

    // Map a Hz to its FFT bin.
    const binAt = (hz) => Math.min(binCount - 1, Math.max(0, Math.round(hz * fftSize / sampleRate)));

    // Synthesize an FFT byte spectrum with energy at given (hz, level) peaks.
    const synth = (buf, peaks) => {
      buf.fill(2);
      for (const [hz, level] of peaks) {
        const c = binAt(hz);
        for (let k = -3; k <= 3; k++) {
          const i = c + k;
          if (i >= 0 && i < binCount) buf[i] = Math.max(buf[i], Math.round(level * 255 * Math.exp(-k*k*0.3)));
        }
      }
    };

    // Read the COMPOSITED canvas (not the GL back buffer directly) — drawImage
    // captures whatever is on screen regardless of preserveDrawingBuffer / swap
    // timing. This is the proven readback path from particle-flow-smoke.
    const litCount = () => {
      const t = document.createElement('canvas');
      t.width = canvas.width;
      t.height = canvas.height;
      const x = t.getContext('2d');
      x.drawImage(canvas, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 24) n++;
      return n;
    };

    let now = 0;
    const dt = 16.7;
    // Silence: 30 frames at near-zero.
    for (let i = 0; i < 30; i++) {
      synth(freq, []); synth(onsetFreq, []); synth(leftFreq, []); synth(rightFreq, []);
      const f = reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dt, now);
      renderer.render(f, palette, dt);
      now += dt;
    }
    const lowLit = litCount();

    // Loud, beat-driven, multi-instrument: kick (60Hz) every 8 frames, a hat
    // (10kHz) every 2 frames, a steady bass (110Hz) + a mid 'vocal' (900Hz).
    // Stereo: pan the hats right. This must produce onsets across groups.
    let totalOnsets = 0;
    const groups = new Set();
    for (let i = 0; i < 90; i++) {
      const kick = i % 8 === 0;
      const hat = i % 2 === 0;
      const peaks = [[110, 0.6], [900, 0.45]];
      if (kick) peaks.push([60, 1.0]);
      if (hat) peaks.push([10000, 0.7]);
      synth(freq, peaks);
      // Onset analyser sees sharp transients only on the hit frames.
      synth(onsetFreq, kick || hat ? peaks : [[110,0.6],[900,0.45]]);
      synth(leftFreq, peaks.filter(([h]) => h < 5000));
      synth(rightFreq, peaks); // hats louder on the right → pan
      const f = reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dt, now);
      totalOnsets += f.onsets.length;
      for (const o of f.onsets) groups.add(o.group);
      renderer.render(f, palette, dt);
      now += dt;
    }
    const hiLit = litCount();

    renderer.dispose();
    return { ok: true, lowLit, hiLit, total: canvas.width*canvas.height, totalOnsets, groups: [...groups] };
  })()`);

  if (!probe.ok) fail(probe.reason, probe);
  if (probe.hiLit < 50) fail('high-energy frame is essentially blank', probe);
  if (probe.hiLit <= probe.lowLit) fail('renderer not reacting to audio energy', probe);
  if (probe.totalOnsets < 5) fail('reactor produced too few onsets from the synthetic signal', probe);
  if (probe.groups.length < 2) fail('reactor did not distinguish instrument groups (causal reactivity broken)', probe);

  console.log('[eviland-smoke] PASS', JSON.stringify(probe));
  app.exit(0);
});

setTimeout(() => fail('timed out'), 30000);
