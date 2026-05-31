// Render Eviland to a PNG so we can actually LOOK at it (the smoke only proves
// "pixels are lit", not "it has structure"). Uses in-page canvas.toDataURL
// (preserveDrawingBuffer via smoke:true) — no capturePage(), which hangs headless.
import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outPath = resolve('tmp', 'eviland-capture.png');

async function bundle(entry, name) {
  const r = await build({
    entryPoints: [resolve('.', entry)], bundle: true, format: 'iife',
    globalName: name, write: false, platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  return r.outputFiles[0].text;
}

const rendererBundle = await bundle('src/visualizer/eviland.ts', 'Eviland');
const audioBundle = await bundle('src/visualizer/eviland-audio.ts', 'EvilandAudio');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { offscreen: false } });
  const html = `<!doctype html><html><body style="margin:0;background:#000">
    <canvas id="c" width="800" height="600"></canvas>
    <script>${audioBundle}</script><script>${rendererBundle}</script></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('c');
    const R = window.Eviland.createEvilandRenderer || window.Eviland.default.createEvilandRenderer;
    const A = window.EvilandAudio.createEvilandReactor || window.EvilandAudio.default.createEvilandReactor;
    const renderer = R(canvas, { quality: 'high', smoke: true });
    if (!renderer) return 'NULL_RENDERER';
    renderer.resize(800, 600, 1);
    // Force the waveform layer ON so the capture proves it renders.
    const cfg = renderer.getConfig();
    cfg.waveform = { mode: 'radial', intensity: { base: 2.2 }, thickness: 0.02, scale: 0.34 };
    renderer.setConfig(cfg);
    const wave = new Uint8Array(256);
    const sr = 48000, fft = 2048, bins = fft/2;
    const reactor = A({ sampleRate: sr, fftSize: fft, binCount: bins });
    const freq=new Uint8Array(bins), on=new Uint8Array(bins), L=new Uint8Array(bins), Rr=new Uint8Array(bins);
    const pal = { accent:[0.1,0.8,1.0], dark:[1.0,0.15,0.4], light:[1.0,0.95,0.6], bg:[0.02,0.02,0.06] };
    const binAt = (hz)=>Math.min(bins-1,Math.max(0,Math.round(hz*fft/sr)));
    const synth=(b,peaks)=>{b.fill(2);for(const [hz,lv] of peaks){const c=binAt(hz);for(let k=-3;k<=3;k++){const i=c+k;if(i>=0&&i<bins)b[i]=Math.max(b[i],Math.round(lv*255*Math.exp(-k*k*0.3)));}}};
    let now=0; const dt=16.7;
    // 200 synchronous frames (~3.3s of music time) — no rAF, just drive render().
    for(let i=0;i<200;i++){
      const kick=i%8===0, hat=i%2===0;
      const peaks=[[110,0.6],[900,0.5],[2500,0.4]];
      if(kick)peaks.push([60,1.0]); if(hat)peaks.push([10000,0.7]);
      synth(freq,peaks); synth(on,(kick||hat)?peaks:[[110,0.6],[900,0.5]]);
      // Sweep the stereo image L<->R so emitters spawn OFF-centre — this is what
      // makes the kaleidoscope fold visible (centred content folds onto itself).
      const panSweep=Math.sin(i*0.07);
      const lG=0.45-panSweep*0.45, rG=0.45+panSweep*0.45;
      synth(L,peaks.filter(([h])=>h<5000).map(([h,lv])=>[h,lv*(0.4+lG)]));
      synth(Rr,peaks.map(([h,lv])=>[h,lv*(0.4+rG)]));
      const f=reactor.analyze(freq,on,L,Rr,dt,now);
      for(let s=0;s<256;s++){ wave[s]=Math.max(0,Math.min(255,128+Math.round(95*Math.sin(s*0.18+i*0.3)*(0.5+f.energy)))); }
      renderer.setWaveform(wave);
      renderer.render(f,pal,dt); now+=dt;
    }
    // Full-res PNG + a downscaled JPEG (small enough for the Read image viewer).
    const small = document.createElement('canvas');
    small.width = 480; small.height = 360;
    const sx = small.getContext('2d');
    sx.drawImage(canvas, 0, 0, 480, 360);
    return JSON.stringify({
      png: canvas.toDataURL('image/png'),
      small: small.toDataURL('image/png'),
    });
  })()`);

  let parsed;
  try { parsed = JSON.parse(dataUrl); } catch { parsed = null; }
  if (!parsed || !parsed.png || !parsed.png.startsWith('data:image/png')) {
    console.error('[eviland-capture] FAIL: ' + (dataUrl || 'no data url').slice(0, 60));
    app.exit(1);
    return;
  }
  writeFileSync(outPath, Buffer.from(parsed.png.split(',')[1], 'base64'));
  const smallPath = outPath.replace(/\.png$/, '-small.png');
  writeFileSync(smallPath, Buffer.from(parsed.small.split(',')[1], 'base64'));
  console.log('[eviland-capture] wrote ' + outPath + ' + ' + smallPath);
  app.exit(0);
});
setTimeout(() => { console.error('[eviland-capture] timeout'); app.exit(1); }, 40000);
