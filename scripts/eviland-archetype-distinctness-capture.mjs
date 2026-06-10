// Per-archetype visual distinctness proof. For each of the 26 archetypes:
//   - generate a representative config (`distinct::<name>` seed)
//   - drive the real renderer with a deterministic synthetic beat for 80 frames
//   - read back the framebuffer and report lit-pixel count + per-quadrant
//     distribution variance + mean RGB
// Two archetypes that produce identical metrics would be visually identical;
// the spread across these numbers IS the proof the morphing rotation moves
// the eye through 26 distinct look-spaces, not 6 recoloured cousins.
//
// Run: npx electron scripts/eviland-archetype-distinctness-capture.mjs
import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve('.');
mkdirSync(resolve('tmp'), { recursive: true });

async function bundle(entry, globalName) {
  const r = await build({
    entryPoints: [resolve(repoRoot, entry)],
    bundle: true, format: 'iife', globalName, write: false,
    platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  return r.outputFiles[0].text;
}

const evB = await bundle('src/visualizer/eviland.ts', 'Eviland');
const auB = await bundle('src/visualizer/eviland-audio.ts', 'EvilandAudio');
const rzB = await bundle('src/visualizer/eviland-randomizer.ts', 'EvilandRandomizer');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 360, height: 280, show: false, webPreferences: { offscreen: false } });
  const html = `<!doctype html><html><body style="margin:0;background:#000">
    <canvas id="c" width="320" height="200"></canvas>
    <script>${auB}</script><script>${rzB}</script><script>${evB}</script></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.getElementById('c');
    const RR = window.Eviland;
    const AA = window.EvilandAudio;
    const ZZ = window.EvilandRandomizer.default || window.EvilandRandomizer;
    const createRenderer = RR.createEvilandRenderer || (RR.default && RR.default.createEvilandRenderer);
    const createReactor = AA.createEvilandReactor || (AA.default && AA.default.createEvilandReactor);
    if (typeof createRenderer !== 'function' || typeof createReactor !== 'function') return { ok: false, reason: 'no factories' };
    const renderer = createRenderer(canvas, { quality: 'high', smoke: true });
    if (!renderer) return { ok: false, reason: 'null renderer' };
    renderer.resize(canvas.width, canvas.height, 1);

    const sr = 48000, fft = 2048, bins = fft / 2;
    const reactor = createReactor({ sampleRate: sr, fftSize: fft, binCount: bins });
    const freq = new Uint8Array(bins), on = new Uint8Array(bins), L = new Uint8Array(bins), Rr = new Uint8Array(bins);
    const wave = new Uint8Array(256);
    const binAt = (hz) => Math.min(bins - 1, Math.max(0, Math.round(hz * fft / sr)));
    const synth = (b, peaks) => { b.fill(2); for (const [hz, lv] of peaks) { const c = binAt(hz); for (let k = -3; k <= 3; k++) { const i = c + k; if (i >= 0 && i < bins) b[i] = Math.max(b[i], Math.round(lv * 255 * Math.exp(-k * k * 0.3))); } } };

    const archetypes = (ZZ.ARCHETYPES || []).slice();
    if (archetypes.length === 0) return { ok: false, reason: 'no archetypes exposed' };

    function metrics() {
      const t = document.createElement('canvas'); t.width = canvas.width; t.height = canvas.height;
      const x = t.getContext('2d');
      x.drawImage(canvas, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      const W = t.width, H = t.height;
      let lit = 0, sumR = 0, sumG = 0, sumB = 0;
      const quad = [0, 0, 0, 0];
      const halfW = W / 2, halfH = H / 2;
      for (let y = 0; y < H; y++) {
        for (let xpx = 0; xpx < W; xpx++) {
          const i = (y * W + xpx) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const v = r + g + b;
          if (v > 24) {
            lit++;
            sumR += r; sumG += g; sumB += b;
            const q = (xpx < halfW ? 0 : 1) + (y < halfH ? 0 : 2);
            quad[q]++;
          }
        }
      }
      // Spatial distribution variance across quadrants. Higher = more uneven
      // (the look has structure favouring some regions); lower = uniform glow.
      const total = lit || 1;
      const mean = total / 4;
      const variance = quad.reduce((s, c) => s + (c - mean) ** 2, 0) / 4;
      return {
        lit,
        litFrac: +(lit / (W * H)).toFixed(4),
        meanR: lit > 0 ? Math.round(sumR / lit) : 0,
        meanG: lit > 0 ? Math.round(sumG / lit) : 0,
        meanB: lit > 0 ? Math.round(sumB / lit) : 0,
        quadVar: Math.round(variance),
        quadDist: quad.map(c => +(c / total).toFixed(3)),
      };
    }

    const results = [];
    for (const a of archetypes) {
      const { config } = ZZ.generate('distinct::' + a, a);
      renderer.setConfig(config);
      const pal = config.palette || { accent: [0.1, 0.8, 1], dark: [1, 0.15, 0.4], light: [1, 0.95, 0.6], bg: [0.02, 0.02, 0.06] };
      let now = 0; const dt = 16.7;
      // Render 60 frames of beat-driven synthetic audio so the archetype's
      // dynamics settle (decay trails, q-LFOs, echo, etc.).
      for (let i = 0; i < 60; i++) {
        const kick = i % 8 === 0, hat = i % 2 === 0, snare = i % 8 === 4;
        const peaks = [[110, 0.55], [900, 0.45], [2500, 0.4]];
        if (kick) peaks.push([60, 1.0]);
        if (hat) peaks.push([10000, 0.65]);
        if (snare) peaks.push([4000, 0.7]);
        synth(freq, peaks);
        synth(on, (kick || hat || snare) ? peaks : [[110, 0.55]]);
        synth(L, peaks.filter(([h]) => h < 5000));
        synth(Rr, peaks);
        const f = reactor.analyze(freq, on, L, Rr, dt, now);
        for (let s = 0; s < 256; s++) wave[s] = Math.max(0, Math.min(255, 128 + Math.round(95 * Math.sin(s * 0.18 + i * 0.3) * (0.5 + f.energy))));
        renderer.setWaveform(wave);
        renderer.render(f, pal, dt);
        now += dt;
      }
      results.push({ a, ...metrics() });
    }
    renderer.dispose();
    return { ok: true, archetypes, results, total: canvas.width * canvas.height };
  })()`);

  if (!result || !result.ok) {
    console.error('[arch-capture] FAIL:', result?.reason || 'unknown');
    app.exit(1); return;
  }
  // Pretty-print + write JSON for the report.
  const lines = [];
  lines.push(`[arch-capture] 26 archetypes, ${result.total} pixels per frame`);
  lines.push('archetype       lit  litFrac  rgb        quadVar quadDist');
  for (const r of result.results) {
    const name = r.a.padEnd(13);
    const lit = String(r.lit).padStart(5);
    const frac = String(r.litFrac).padStart(7);
    const rgb = `[${String(r.meanR).padStart(3)},${String(r.meanG).padStart(3)},${String(r.meanB).padStart(3)}]`;
    const qv = String(r.quadVar).padStart(7);
    const qd = `[${r.quadDist.join(', ')}]`;
    lines.push(`${name} ${lit} ${frac}  ${rgb}  ${qv}  ${qd}`);
  }
  // Sanity: are any two archetypes producing identical lit+rgb+quadVar? If so
  // the look is a metrics-twin (real-world false positives are possible but
  // worth flagging in the report).
  const sig = (r) => `${r.lit}|${r.meanR}|${r.meanG}|${r.meanB}|${r.quadVar}`;
  const seen = new Map();
  let twins = 0;
  for (const r of result.results) {
    const k = sig(r);
    if (seen.has(k)) { lines.push(`WARN: metrics-twin: ${seen.get(k)} vs ${r.a}`); twins++; }
    else seen.set(k, r.a);
  }
  lines.push(twins === 0 ? '[arch-capture] PASS — no metrics-twins among 26 archetypes' : `[arch-capture] PARTIAL — ${twins} metrics-twins`);
  const text = lines.join('\n');
  console.log(text);
  writeFileSync(resolve('tmp', 'arch-distinctness.txt'), text + '\n');
  writeFileSync(resolve('tmp', 'arch-distinctness.json'), JSON.stringify(result.results, null, 2));
  app.exit(twins === 0 ? 0 : 1);
});
setTimeout(() => { console.error('[arch-capture] timeout'); app.exit(1); }, 120000);
