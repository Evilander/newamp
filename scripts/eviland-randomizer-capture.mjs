// Visual proof that the randomizer mints beautiful, varied, NON-broken looks.
// Generates four seeds, renders each into a quadrant of a 2x2 montage PNG so all
// four can be eyeballed in one image. Run: npx electron scripts/eviland-randomizer-capture.mjs
import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function bundle(entry, name) {
  const r = await build({
    entryPoints: [resolve('.', entry)], bundle: true, format: 'iife',
    globalName: name, write: false, platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  return r.outputFiles[0].text;
}

const evB = await bundle('src/visualizer/eviland.ts', 'Eviland');
const auB = await bundle('src/visualizer/eviland-audio.ts', 'EvilandAudio');
const rzB = await bundle('src/visualizer/eviland-randomizer.ts', 'EvilandRandomizer');

const seeds = (process.argv.slice(2).filter((a) => !a.startsWith('-'))[0] || 'NOVA-7,DRIFT-2,PEAK-9,GLASS-4').split(',');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 360, show: false, webPreferences: { offscreen: false } });
  const html = `<!doctype html><html><body style="margin:0;background:#000">
    <canvas id="c" width="480" height="360"></canvas>
    <script>${auB}</script><script>${rzB}</script><script>${evB}</script></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('c');
    const mont = document.createElement('canvas'); mont.width = 960; mont.height = 720;
    const mx = mont.getContext('2d');
    const R = window.Eviland.createEvilandRenderer || window.Eviland.default.createEvilandRenderer;
    const A = window.EvilandAudio.createEvilandReactor || window.EvilandAudio.default.createEvilandReactor;
    const Z = window.EvilandRandomizer.default || window.EvilandRandomizer;
    const renderer = R(canvas, { quality: 'high', smoke: true });
    if (!renderer) return 'NULL_RENDERER';
    renderer.resize(480, 360, 1);
    const sr = 48000, fft = 2048, bins = fft / 2;
    const reactor = A({ sampleRate: sr, fftSize: fft, binCount: bins });
    const freq = new Uint8Array(bins), on = new Uint8Array(bins), L = new Uint8Array(bins), Rr = new Uint8Array(bins), wave = new Uint8Array(256);
    const binAt = (hz) => Math.min(bins - 1, Math.max(0, Math.round(hz * fft / sr)));
    const synth = (b, peaks) => { b.fill(2); for (const [hz, lv] of peaks) { const c = binAt(hz); for (let k = -3; k <= 3; k++) { const i = c + k; if (i >= 0 && i < bins) b[i] = Math.max(b[i], Math.round(lv * 255 * Math.exp(-k * k * 0.3))); } } };
    const seeds = ${JSON.stringify(seeds)};
    for (let q = 0; q < 4; q++) {
      const g = Z.generate(seeds[q % seeds.length]);
      const cfg = g.config;
      renderer.setConfig(cfg);
      const pal = cfg.palette || { accent: [0.1, 0.8, 1], dark: [1, 0.15, 0.4], light: [1, 0.95, 0.6], bg: [0.02, 0.02, 0.06] };
      let now = 0; const dt = 16.7;
      for (let i = 0; i < 150; i++) {
        const kick = i % 8 === 0, hat = i % 2 === 0;
        const peaks = [[110, 0.6], [900, 0.5], [2500, 0.4]];
        if (kick) peaks.push([60, 1.0]); if (hat) peaks.push([10000, 0.7]);
        synth(freq, peaks); synth(on, (kick || hat) ? peaks : [[110, 0.6]]);
        synth(L, peaks.filter(([h]) => h < 5000)); synth(Rr, peaks);
        const f = reactor.analyze(freq, on, L, Rr, dt, now);
        for (let s = 0; s < 256; s++) wave[s] = Math.max(0, Math.min(255, 128 + Math.round(95 * Math.sin(s * 0.18 + i * 0.3) * (0.5 + f.energy))));
        renderer.setWaveform(wave);
        renderer.render(f, pal, dt); now += dt;
      }
      const ox = (q % 2) * 480, oy = Math.floor(q / 2) * 360;
      mx.drawImage(canvas, ox, oy, 480, 360);
      mx.fillStyle = 'rgba(255,255,255,0.92)'; mx.font = 'bold 15px monospace';
      mx.fillText((cfg.archetype || '?') + '  ' + (g.seed || seeds[q]), ox + 10, oy + 22);
    }
    return mont.toDataURL('image/png');
  })()`);

  if (!dataUrl || !dataUrl.startsWith('data:image/png')) {
    console.error('[randomizer-capture] FAIL: ' + (dataUrl || 'no data url').slice(0, 80));
    app.exit(1);
    return;
  }
  const out = resolve('tmp', 'rand-montage.png');
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('[randomizer-capture] wrote ' + out);
  app.exit(0);
});
setTimeout(() => { console.error('[randomizer-capture] timeout'); app.exit(1); }, 60000);
