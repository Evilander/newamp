import { useEffect, useRef } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import type { AudioEngine } from '../audio/engine';

export type VizMode =
  | 'mini'
  | 'spectrum'
  | 'oscilloscope'
  | 'galaxy'
  | 'aurora'
  | 'radial'
  | 'tunnel'
  | 'pulse'
  | 'orbital-rings'
  | 'neon-waves'
  | 'neon-ribbons'
  | 'plasma-grid'
  | 'prism-bars'
  | 'confetti'
  | 'burning-cloud'
  | 'butterchurn';

export type VizQuality = 'auto' | '4k';
export type VizPerformance = 'balanced' | 'low';
export type VizPalette = 'theme' | 'phosphor' | 'ice' | 'sunset' | 'rainbow';

interface Props {
  mode: VizMode;
  width?: number;
  height?: number;
  className?: string;
  artUrl?: string | null;
  quality?: VizQuality;
  performance?: VizPerformance;
  palette?: VizPalette;
}

function createFrameGate(canvasRef: RefObject<HTMLCanvasElement>, frameIntervalMs: number): (now: number) => boolean {
  let lastPaintAt = 0;
  return (now: number) => {
    const node = canvasRef.current;
    if (!node || !node.isConnected || document.hidden) return false;
    if (node.clientWidth <= 0 || node.clientHeight <= 0) return false;
    if (now - lastPaintAt < frameIntervalMs) return false;
    lastPaintAt = now;
    return true;
  };
}

export function Visualizer({ mode, width, height, className, artUrl, quality = 'auto', performance = 'balanced', palette = 'theme' }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = usePlayerStore((s) => s.engine);
  const isFullscreen = width == null && height == null && mode !== 'mini';
  const frameIntervalMs = isFullscreen
    ? performance === 'low'
      ? 1000 / 30
      : quality === '4k' ? 1000 / 30 : 1000 / 45
    : 1000 / 30;
  const dprCap = isFullscreen
    ? performance === 'low'
      ? 0.75
      : quality === '4k' ? 1.25 : 1
    : 2;
  const maxPixels = isFullscreen
    ? performance === 'low'
      ? 1_050_000
      : quality === '4k' ? 4_200_000 : 2_100_000
    : 2_000_000;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (mode === 'butterchurn') {
      const butterCanvas = canvas;
      let raf = 0;
      let presetTimer: number | null = null;
      let cancelled = false;
      let visualizer: ButterchurnVisualizer | null = null;
      let lastW = 0;
      let lastH = 0;

      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      const canPaint = createFrameGate(canvasRef, frameIntervalMs);

      function ensureSize() {
        const node = canvasRef.current;
        if (!node) return;
        const cssW = node.clientWidth || node.width || 100;
        const cssH = node.clientHeight || node.height || 100;
        const scaledW = Math.max(8, Math.floor(cssW * dpr));
        const scaledH = Math.max(8, Math.floor(cssH * dpr));
        const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, scaledW * scaledH)));
        const targetW = Math.max(8, Math.floor(scaledW * scale));
        const targetH = Math.max(8, Math.floor(scaledH * scale));
        if (targetW === lastW && targetH === lastH) return;
        lastW = targetW;
        lastH = targetH;
        node.width = targetW;
        node.height = targetH;
        visualizer?.setRendererSize(targetW, targetH);
      }

      async function startButterchurn() {
        try {
          const [butterchurnModule, presetModule] = await Promise.all([
            import('butterchurn'),
            import('butterchurn-presets'),
          ]);
          if (cancelled) return;
          const butterchurn = unwrapDefault<ButterchurnFactory>(butterchurnModule);
          const presetApi = unwrapDefault<ButterchurnPresetApi>(presetModule);

          ensureSize();
          visualizer = butterchurn.createVisualizer(engine.ctx, butterCanvas, {
            width: lastW,
            height: lastH,
            meshWidth: 48,
            meshHeight: 36,
          });
          visualizer.connectAudio(engine.visualizerNode);

          const presets = Object.entries(presetApi.getPresets()).filter(
            (entry): entry is [string, Record<string, unknown>] =>
              !!entry[1] && typeof entry[1] === 'object',
          );
          if (!presets.length) throw new Error('No Butterchurn presets loaded');

          const loadRandomPreset = (blendSeconds: number) => {
            const [, preset] = presets[Math.floor(Math.random() * presets.length)]!;
            visualizer?.loadPreset(preset, blendSeconds);
          };

          loadRandomPreset(0);
          presetTimer = window.setInterval(() => loadRandomPreset(3.6), 16000);

          const frame = (now: number) => {
            if (canPaint(now)) {
              ensureSize();
              visualizer?.render();
            }
            raf = requestAnimationFrame(frame);
          };
          raf = requestAnimationFrame(frame);
        } catch (err) {
          if (!cancelled) {
            const frameFallback = (now: number) => {
              if (canPaint(now)) paintMilkdropFallback(butterCanvas, engine);
              raf = requestAnimationFrame(frameFallback);
            };
            raf = requestAnimationFrame(frameFallback);
          }
        }
      }

      void startButterchurn();

      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        if (presetTimer != null) window.clearInterval(presetTimer);
        try {
          visualizer?.disconnectAudio(engine.visualizerNode);
        } catch {
          /* ignore */
        }
      };
    }

    if (isShaderVisualizerMode(mode)) {
      const cleanup = startShaderVisualizer({
        canvas,
        canvasRef,
        engine,
        mode,
        palette,
        frameIntervalMs,
        dprCap,
        maxPixels,
      });
      if (cleanup) return cleanup;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    let raf = 0;
    let ctx: CanvasRenderingContext2D | null = null;
    const freq = new Uint8Array(new ArrayBuffer(engine.frequencyBinCount));
    const wave = new Uint8Array(new ArrayBuffer(engine.fftSize));
    const canPaint = createFrameGate(canvasRef, frameIntervalMs);

    function ensureSize() {
      const node = canvasRef.current;
      if (!node) return;
      const w = node.clientWidth || node.width || 100;
      const h = node.clientHeight || node.height || 40;
      const scaledW = Math.max(2, Math.floor(w * dpr));
      const scaledH = Math.max(2, Math.floor(h * dpr));
      const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, scaledW * scaledH)));
      const targetW = Math.max(2, Math.floor(scaledW * scale));
      const targetH = Math.max(2, Math.floor(scaledH * scale));
      if (node.width !== targetW || node.height !== targetH) {
        node.width = targetW;
        node.height = targetH;
      }
      ctx = node.getContext('2d', { alpha: false });
      if (ctx) ctx.setTransform(targetW / Math.max(1, w), 0, 0, targetH / Math.max(1, h), 0, 0);
    }

    function getCssVar(name: string): string {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#39ff14';
    }

    // Galaxy state
    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      hue: number;
      life: number;
    }
    const particles: Particle[] = [];

    function frame(now: number) {
      if (!canPaint(now)) {
        raf = requestAnimationFrame(frame);
        return;
      }
      ensureSize();
      const c = canvasRef.current;
      if (!c) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const w = c.clientWidth || c.width;
      const h = c.clientHeight || c.height;
      if (!ctx) {
        raf = requestAnimationFrame(frame);
        return;
      }

      engine.getFreqData(freq);
      engine.getTimeData(wave);
      boostFrequencyData(freq);

      const accent = getCssVar('--accent') || '#39ff14';
      const accentDim = getCssVar('--accent-dim') || '#1aa30a';
      const ink2 = getCssVar('--ink-2') || '#8fb78f';

      if (mode === 'mini' || mode === 'spectrum') {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, w, h);

        // Band reduce — 32 bars from 64 lower bins
        const bars = mode === 'mini' ? 18 : 56;
        const step = Math.floor(freq.length / 2 / bars);
        const gap = mode === 'mini' ? 1 : 2;
        const bw = (w - gap * (bars - 1)) / bars;
        for (let i = 0; i < bars; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += freq[i * step + j]!;
          const v = sum / step / 255;
          const bh = Math.max(1, v * h);
          const x = i * (bw + gap);
          const g = ctx.createLinearGradient(0, h - bh, 0, h);
          g.addColorStop(0, accent);
          g.addColorStop(1, accentDim);
          ctx.fillStyle = g;
          ctx.fillRect(x, h - bh, bw, bh);
        }
      } else if (mode === 'oscilloscope') {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, w, h);
        const osc = oscilloscopePalette(palette, accent, now);
        ctx.strokeStyle = osc.stroke;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const slice = w / wave.length;
        for (let i = 0; i < wave.length; i++) {
          const v = wave[i]! / 128 - 1;
          const y = h / 2 + (v * h) / 2;
          if (i === 0) ctx.moveTo(0, y);
          else ctx.lineTo(i * slice, y);
        }
        ctx.shadowColor = osc.glow;
        ctx.shadowBlur = osc.blur;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (mode === 'galaxy') {
        // Trail fade
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, 0, w, h);

        // Compute energy bands
        const bass = avg(freq, 0, 12) / 255;
        const mid = avg(freq, 12, 60) / 255;
        const treble = avg(freq, 60, 180) / 255;

        // Spawn particles based on bass kicks
        const spawn = Math.floor(bass * 6 + mid * 2);
        for (let i = 0; i < spawn; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = 1 + bass * 8 + Math.random() * 3;
          particles.push({
            x: w / 2,
            y: h / 2,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            r: 1 + mid * 3 + Math.random() * 1.5,
            hue: (Date.now() / 25 + Math.random() * 40) % 360,
            life: 60 + Math.random() * 60,
          });
        }
        if (particles.length > 600) particles.splice(0, particles.length - 600);

        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i]!;
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.985;
          p.vy *= 0.985;
          p.life -= 1;
          if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) {
            particles.splice(i, 1);
            continue;
          }
          const alpha = Math.min(1, p.life / 60);
          ctx.fillStyle = `hsla(${p.hue}, 88%, 62%, ${alpha})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }

        // Bass ring
        if (bass > 0.15) {
          ctx.strokeStyle = `rgba(${parseRgb(accent)}, ${0.6 * bass})`;
          ctx.lineWidth = 2 + bass * 3;
          ctx.beginPath();
          ctx.arc(w / 2, h / 2, 60 + bass * 140, 0, Math.PI * 2);
          ctx.stroke();
        }

        void treble; // reserved for sparkle layer later
      } else if (mode === 'aurora') {
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 22) / 255;
        const mid = avg(freq, 22, 110) / 255;
        const treble = avg(freq, 110, 240) / 255;
        const bands = 9;
        const t = Date.now() / 900;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let b = 0; b < bands; b++) {
          const energy = avg(freq, b * 10, b * 10 + 18) / 255;
          const yc = h * (0.16 + 0.082 * b) + Math.sin(t + b * 0.78) * (18 + bass * 80);
          const hue = (b * 36 + Date.now() / 34 + bass * 110) % 360;
          ctx.beginPath();
          for (let x = -12; x <= w + 12; x += 10) {
            const phase = x / (80 + b * 8) + t + b * 0.62;
            const y =
              yc +
              Math.sin(phase) * (30 + energy * 120 + bass * 90) +
              Math.sin(phase * 0.43 + mid * 5) * (18 + treble * 48);
            if (x <= -12) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsla(${hue}, 96%, ${58 + energy * 18}%, ${0.28 + energy * 0.58})`;
          ctx.lineWidth = 2 + energy * 7 + bass * 5;
          ctx.shadowColor = `hsl(${hue}, 96%, 62%)`;
          ctx.shadowBlur = 18 + energy * 34 + bass * 26;
          ctx.stroke();
        }
        const glow = ctx.createRadialGradient(w / 2, h * 0.52, 0, w / 2, h * 0.52, Math.max(w, h) * 0.74);
        glow.addColorStop(0, `rgba(${parseRgb(accent)}, ${0.1 + bass * 0.42 + mid * 0.18})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      } else if (mode === 'radial') {
        ctx.fillStyle = 'rgba(0,0,0,0.24)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 18) / 255;
        const mid = avg(freq, 18, 86) / 255;
        const cx = w / 2;
        const cy = h / 2;
        const spokes = 96;
        const maxR = Math.min(w, h) * (0.28 + bass * 0.18);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Date.now() / 2800);
        for (let i = 0; i < spokes; i++) {
          const bin = freq[(i * 3) % Math.max(1, freq.length)]! / 255;
          const angle = (Math.PI * 2 * i) / spokes;
          const inner = maxR * (0.28 + mid * 0.08);
          const outer = inner + maxR * (0.38 + bin * 0.74);
          ctx.strokeStyle = `hsla(${(i * 3.8 + Date.now() / 44) % 360}, 92%, 62%, ${0.18 + bin * 0.7})`;
          ctx.lineWidth = 1 + bin * 3;
          ctx.beginPath();
          ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
          ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
          ctx.stroke();
        }
        ctx.restore();
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.7);
        glow.addColorStop(0, `rgba(${parseRgb(accent)}, ${0.28 + bass * 0.48})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
      } else if (mode === 'tunnel') {
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 24) / 255;
        const cx = w / 2;
        const cy = h / 2;
        const rings = 26;
        const twist = Date.now() / 900;
        for (let r = rings; r > 0; r--) {
          const phase = r / rings;
          const radius = phase * Math.max(w, h) * (0.62 + bass * 0.14);
          const sides = 7;
          ctx.beginPath();
          for (let i = 0; i <= sides; i++) {
            const angle = (Math.PI * 2 * i) / sides + twist * (1 - phase);
            const wobble = Math.sin(Date.now() / 220 + i + r) * (6 + bass * 18);
            const x = cx + Math.cos(angle) * (radius + wobble);
            const y = cy + Math.sin(angle) * (radius + wobble);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsla(${(phase * 240 + Date.now() / 80) % 360}, 88%, 60%, ${0.08 + (1 - phase) * 0.58})`;
          ctx.lineWidth = 1 + bass * 3;
          ctx.stroke();
        }
      } else if (mode === 'pulse') {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 14) / 255;
        const mid = avg(freq, 14, 72) / 255;
        const treble = avg(freq, 72, 180) / 255;
        const cells = 14;
        const cellW = w / cells;
        const cellH = h / Math.max(7, Math.floor(cells * h / Math.max(w, 1)));
        for (let y = -1; y < h / cellH + 1; y++) {
          for (let x = -1; x < cells + 1; x++) {
            const dist = Math.hypot(x - cells / 2, y - h / cellH / 2);
            const wavePhase = Math.sin(dist * 0.9 - Date.now() / 180);
            const level = Math.max(0, wavePhase * 0.5 + 0.5) * (0.25 + bass * 0.55 + mid * 0.25);
            ctx.fillStyle = `rgba(${parseRgb(accent)}, ${0.05 + level * 0.42})`;
            ctx.fillRect(x * cellW + 1, y * cellH + 1, cellW - 2, cellH - 2);
          }
        }
        ctx.strokeStyle = `rgba(255,255,255,${0.12 + treble * 0.32})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h * (0.52 - bass * 0.18));
        for (let x = 0; x <= w; x += 8) {
          const y = h / 2 + Math.sin(x / 28 + Date.now() / 140) * (18 + mid * 70);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else if (mode === 'orbital-rings') {
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 22) / 255;
        const lowMid = avg(freq, 22, 86) / 255;
        const highMid = avg(freq, 86, 168) / 255;
        const treble = avg(freq, 168, 280) / 255;
        const cx = w / 2;
        const cy = h / 2;
        const minSide = Math.min(w, h);
        const time = Date.now();

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(time / 3600);
        ctx.globalCompositeOperation = 'lighter';

        for (let ring = 0; ring < 5; ring += 1) {
          const radius = minSide * (0.11 + ring * 0.072) + bass * minSide * 0.035;
          const bars = 96 + ring * 18;
          const spin = (ring % 2 === 0 ? 1 : -1) * time / (2800 + ring * 620);
          ctx.save();
          ctx.rotate(spin);
          for (let i = 0; i < bars; i += 1) {
            const binIndex = Math.floor((i / bars) * Math.min(freq.length - 1, 260));
            const energy = Math.max(0.035, freq[binIndex]! / 255);
            const angle = (Math.PI * 2 * i) / bars;
            const pulse = 1 + Math.sin(time / 240 + i * 0.17 + ring) * 0.08;
            const inner = radius * (0.96 + lowMid * 0.04);
            const outer =
              radius +
              (8 + ring * 2 + energy * minSide * 0.09 + bass * minSide * 0.04) * pulse;
            const hue = (155 + ring * 26 + i * 0.9 + time / 70 + treble * 120) % 360;
            ctx.strokeStyle = `hsla(${hue}, 96%, ${54 + energy * 22}%, ${0.18 + energy * 0.74})`;
            ctx.lineWidth = 0.75 + energy * 2.8 + bass * 1.5;
            ctx.beginPath();
            ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
            ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
            ctx.stroke();
          }
          ctx.restore();
        }

        for (let ring = 0; ring < 4; ring += 1) {
          const radius = minSide * (0.18 + ring * 0.105) + bass * minSide * 0.09;
          ctx.strokeStyle = `hsla(${190 + ring * 34 + time / 52}, 92%, 62%, ${0.08 + bass * 0.34 + highMid * 0.18})`;
          ctx.lineWidth = 1 + bass * 4 + ring * 0.28;
          ctx.shadowColor = `hsl(${190 + ring * 34}, 92%, 62%)`;
          ctx.shadowBlur = 12 + bass * 38;
          ctx.beginPath();
          ctx.arc(0, 0, radius + Math.sin(time / 300 + ring) * (4 + bass * 22), 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.shadowBlur = 0;
        ctx.rotate(-time / 2200);
        ctx.beginPath();
        for (let i = 0; i < 240; i += 1) {
          const waveIndex = Math.floor((i / 240) * wave.length);
          const sample = (wave[waveIndex]! - 128) / 128;
          const angle = (Math.PI * 2 * i) / 240;
          const radius =
            minSide * (0.055 + bass * 0.03) + sample * minSide * (0.05 + highMid * 0.04);
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(${parseRgb(accent)}, ${0.5 + treble * 0.35})`;
        ctx.lineWidth = 1.2 + lowMid * 2;
        ctx.stroke();
        ctx.restore();

        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, minSide * (0.18 + bass * 0.22));
        glow.addColorStop(0, `rgba(${parseRgb(accent)}, ${0.18 + bass * 0.48})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
      } else if (mode === 'neon-waves') {
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 18) / 255;
        const mid = avg(freq, 18, 90) / 255;
        const treble = avg(freq, 90, 180) / 255;
        const time = Date.now() / 420;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let band = 0; band < 18; band += 1) {
          const energy = avg(freq, band * 6, band * 6 + 10) / 255;
          const yBase = h * (0.18 + band * 0.038);
          const amp = 10 + energy * 54 + bass * 52 + treble * 18;
          const hue = (band * 13 + Date.now() / 55) % 360;
          ctx.strokeStyle = `hsla(${hue}, 96%, ${58 + energy * 18}%, ${0.2 + energy * 0.64})`;
          ctx.lineWidth = 0.9 + energy * 3.2 + bass * 1.2;
          ctx.shadowColor = `hsl(${hue}, 96%, 62%)`;
          ctx.shadowBlur = 10 + energy * 22 + bass * 18;
          ctx.beginPath();
          for (let x = -8; x <= w + 8; x += 8) {
            const phase = x / (42 + band * 3) + time + band * 0.42;
            const y =
              yBase +
              Math.sin(phase) * amp +
              Math.sin(phase * 0.37 + mid * 4) * amp * 0.45;
            if (x <= -8) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();
      } else if (mode === 'neon-ribbons') {
        ctx.fillStyle = 'rgba(0,0,0,0.11)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 20) / 255;
        const mid = avg(freq, 20, 90) / 255;
        const treble = avg(freq, 90, 190) / 255;
        const cx = w / 2;
        const cy = h / 2;
        const time = Date.now() / 1000;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let ribbon = 0; ribbon < 7; ribbon += 1) {
          const hue = (ribbon * 42 + Date.now() / 28 + bass * 90) % 360;
          const orbitX = w * (0.2 + ribbon * 0.033) + bass * w * 0.09;
          const orbitY = h * (0.18 + ribbon * 0.026) + mid * h * 0.12;
          ctx.beginPath();
          for (let i = 0; i <= 240; i += 1) {
            const bin = freq[(i * 2 + ribbon * 11) % Math.max(1, freq.length)]! / 255;
            const theta = (i / 240) * Math.PI * 2;
            const wobble = 1 + bin * 0.38 + bass * 0.18;
            const x =
              cx +
              Math.cos(theta * (2 + ribbon * 0.18) + time * (0.8 + ribbon * 0.08)) *
                orbitX *
                wobble +
              Math.sin(theta * 7 + time * 2.1) * treble * 30;
            const y =
              cy +
              Math.sin(theta * (3 + ribbon * 0.12) - time * (0.65 + ribbon * 0.07)) *
                orbitY *
                wobble +
              Math.cos(theta * 5 - time * 1.6) * mid * 22;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsla(${hue}, 96%, ${58 + treble * 20}%, ${0.22 + mid * 0.36 + bass * 0.24})`;
          ctx.lineWidth = 1.4 + bass * 5 + ribbon * 0.12;
          ctx.shadowColor = `hsl(${hue}, 96%, 64%)`;
          ctx.shadowBlur = 14 + bass * 32;
          ctx.stroke();
        }
        for (let ring = 0; ring < 5; ring += 1) {
          const radius = 42 + ring * 38 + bass * 160;
          ctx.strokeStyle = `hsla(${(Date.now() / 36 + ring * 54) % 360}, 96%, 66%, ${0.12 + bass * 0.28})`;
          ctx.lineWidth = 1 + bass * 4;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      } else if (mode === 'plasma-grid') {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 22) / 255;
        const mid = avg(freq, 22, 100) / 255;
        const treble = avg(freq, 100, 210) / 255;
        const step = Math.max(18, Math.min(44, Math.floor(Math.min(w, h) / 14)));
        const time = Date.now() / 520;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let y = -step; y <= h + step; y += step) {
          ctx.beginPath();
          for (let x = -step; x <= w + step; x += step) {
            const bin = freq[Math.abs(Math.floor((x + y) / step * 3)) % Math.max(1, freq.length)]! / 255;
            const warp =
              Math.sin(x / 42 + time) * (8 + bass * 30) +
              Math.cos(y / 36 - time * 1.24) * (5 + mid * 26) +
              bin * treble * 34;
            const px = x + Math.sin(y / 70 + time) * bass * 26;
            const py = y + warp;
            if (x <= -step) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          const hue = (y * 0.23 + Date.now() / 46 + bass * 110) % 360;
          ctx.strokeStyle = `hsla(${hue}, 96%, 62%, ${0.12 + mid * 0.35})`;
          ctx.lineWidth = 0.8 + bass * 2.8;
          ctx.shadowColor = `hsl(${hue}, 96%, 62%)`;
          ctx.shadowBlur = 8 + bass * 20;
          ctx.stroke();
        }
        for (let x = -step; x <= w + step; x += step) {
          ctx.beginPath();
          for (let y = -step; y <= h + step; y += step) {
            const bin = freq[Math.abs(Math.floor((x * 2 + y) / step * 2)) % Math.max(1, freq.length)]! / 255;
            const warp =
              Math.cos(y / 38 + time * 1.1) * (8 + mid * 24) +
              Math.sin(x / 50 - time) * (5 + bass * 32) +
              bin * 28;
            const px = x + warp;
            const py = y + Math.cos(x / 76 - time) * treble * 24;
            if (y <= -step) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          const hue = (x * 0.32 + Date.now() / 52 + treble * 120) % 360;
          ctx.strokeStyle = `hsla(${hue}, 96%, 58%, ${0.08 + treble * 0.34 + bass * 0.18})`;
          ctx.lineWidth = 0.8 + treble * 2.4;
          ctx.stroke();
        }
        const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.64);
        glow.addColorStop(0, `rgba(${parseRgb(accent)}, ${0.18 + bass * 0.34})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      } else if (mode === 'prism-bars') {
        ctx.fillStyle = 'rgba(0,0,0,0.34)';
        ctx.fillRect(0, 0, w, h);
        const bars = 72;
        const gap = Math.max(1, Math.floor(w / 320));
        const bw = (w - gap * (bars - 1)) / bars;
        for (let i = 0; i < bars; i += 1) {
          const bin = avg(freq, i * 2, i * 2 + 4) / 255;
          const lift = Math.pow(bin, 0.82);
          const bh = Math.max(2, lift * h * 0.92);
          const x = i * (bw + gap);
          const hue = (i * 5.4 + Date.now() / 80) % 360;
          const g = ctx.createLinearGradient(0, h - bh, 0, h);
          g.addColorStop(0, `hsla(${hue}, 96%, 66%, 0.95)`);
          g.addColorStop(0.58, `hsla(${(hue + 28) % 360}, 96%, 52%, 0.82)`);
          g.addColorStop(1, 'rgba(0,0,0,0.28)');
          ctx.fillStyle = g;
          ctx.fillRect(x, h - bh, bw, bh);
          if (i % 3 === 0 && lift > 0.18) {
            ctx.fillStyle = `hsla(${hue}, 100%, 78%, ${0.16 + lift * 0.4})`;
            ctx.fillRect(x, 0, bw, h);
          }
        }
      } else if (mode === 'confetti') {
        ctx.fillStyle = 'rgba(0,0,0,0.24)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 18) / 255;
        const mid = avg(freq, 18, 92) / 255;
        const pieces = 96;
        const time = Date.now() / 1000;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < pieces; i += 1) {
          const bin = freq[(i * 5) % Math.max(1, freq.length)]! / 255;
          const lane = i / pieces;
          const orbit = 18 + lane * Math.max(w, h) * 0.58 + bass * 40;
          const angle = time * (0.35 + lane) + i * 2.399;
          const x = w / 2 + Math.cos(angle) * orbit * (0.72 + mid * 0.18);
          const y = h / 2 + Math.sin(angle * 1.18) * orbit * 0.48;
          const size = 2 + bin * 13;
          ctx.fillStyle = `hsla(${(i * 11 + Date.now() / 34) % 360}, 92%, 62%, ${0.18 + bin * 0.72})`;
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      } else if (mode === 'burning-cloud') {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, 0, w, h);
        const bass = avg(freq, 0, 20) / 255;
        const mid = avg(freq, 20, 96) / 255;
        const cell = Math.max(18, Math.floor(Math.min(w, h) / 22));
        const time = Date.now() / 580;
        for (let y = -cell; y < h + cell; y += cell) {
          for (let x = -cell; x < w + cell; x += cell) {
            const nx = x / Math.max(1, w);
            const ny = y / Math.max(1, h);
            const heat =
              Math.sin(nx * 10 + time) * 0.22 +
              Math.sin(ny * 12 - time * 1.2) * 0.2 +
              Math.sin((nx + ny) * 16 + time * 0.7) * 0.2 +
              0.42 +
              bass * 0.42 +
              mid * 0.18;
            const alpha = Math.max(0.05, Math.min(0.78, heat));
            const hue = 18 + heat * 54 + Date.now() / 110;
            const g = ctx.createRadialGradient(x + cell / 2, y + cell / 2, 0, x + cell / 2, y + cell / 2, cell * 1.7);
            g.addColorStop(0, `hsla(${hue}, 98%, 62%, ${alpha})`);
            g.addColorStop(0.5, `hsla(${(hue + 24) % 360}, 90%, 44%, ${alpha * 0.46})`);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - cell, y - cell, cell * 3, cell * 3);
          }
        }
      }

      void ink2;
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [dprCap, engine, frameIntervalMs, isFullscreen, maxPixels, mode, palette]);

  const style: CSSProperties = {};
  if (width != null) style.width = `${width}px`;
  if (height != null) style.height = `${height}px`;

  return (
    <canvas
      key={`${mode}-${palette}-${quality}-${performance}`}
      ref={canvasRef}
      data-newamp-visualizer-canvas
      data-newamp-visualizer-mode={mode}
      className={className ?? 'h-full w-full'}
      style={{ display: 'block', borderRadius: 'var(--radius)', ...style }}
    />
  );
}

interface ButterchurnVisualizer {
  connectAudio(audioNode: AudioNode): void;
  disconnectAudio(audioNode: AudioNode): void;
  loadPreset(preset: Record<string, unknown>, blendSeconds?: number): void;
  render(): void;
  setRendererSize(width: number, height: number): void;
}

interface ButterchurnFactory {
  createVisualizer(
    context: AudioContext,
    canvas: HTMLCanvasElement,
    opts: Record<string, unknown>,
  ): ButterchurnVisualizer;
}

interface ButterchurnPresetApi {
  getPresets(): Record<string, Record<string, unknown>>;
}

function unwrapDefault<T>(module: unknown): T {
  const first = (module as { default?: unknown }).default ?? module;
  return ((first as { default?: unknown }).default ?? first) as T;
}

interface ShaderVisualizerOptions {
  canvas: HTMLCanvasElement;
  canvasRef: RefObject<HTMLCanvasElement>;
  engine: AudioEngine;
  mode: VizMode;
  palette: VizPalette;
  frameIntervalMs: number;
  dprCap: number;
  maxPixels: number;
}

interface AudioFeatures {
  bass: number;
  lowMid: number;
  mid: number;
  treble: number;
  rms: number;
  beat: number;
  bands: number[];
}

function isShaderVisualizerMode(mode: VizMode): boolean {
  return mode === 'neon-waves' ||
    mode === 'neon-ribbons' ||
    mode === 'plasma-grid' ||
    mode === 'burning-cloud';
}

function startShaderVisualizer(options: ShaderVisualizerOptions): (() => void) | null {
  const smokeReadback = Boolean((window as Window & { __newampSmoke?: unknown }).__newampSmoke);
  const gl = options.canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: smokeReadback,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  const program = createShaderProgram(gl, SHADER_VERTEX_SOURCE, SHADER_FRAGMENT_SOURCE);
  if (!program) return null;

  const positionBuffer = gl.createBuffer();
  if (!positionBuffer) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const position = gl.getAttribLocation(program, 'a_position');
  const uniforms = {
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    time: gl.getUniformLocation(program, 'u_time'),
    mode: gl.getUniformLocation(program, 'u_mode'),
    palette: gl.getUniformLocation(program, 'u_palette'),
    accent: gl.getUniformLocation(program, 'u_accent'),
    bass: gl.getUniformLocation(program, 'u_bass'),
    lowMid: gl.getUniformLocation(program, 'u_lowMid'),
    mid: gl.getUniformLocation(program, 'u_mid'),
    treble: gl.getUniformLocation(program, 'u_treble'),
    rms: gl.getUniformLocation(program, 'u_rms'),
    beat: gl.getUniformLocation(program, 'u_beat'),
    bands0: gl.getUniformLocation(program, 'u_bands0'),
    bands1: gl.getUniformLocation(program, 'u_bands1'),
    bands2: gl.getUniformLocation(program, 'u_bands2'),
    bands3: gl.getUniformLocation(program, 'u_bands3'),
  };

  const freq = new Uint8Array(new ArrayBuffer(options.engine.frequencyBinCount));
  const wave = new Uint8Array(new ArrayBuffer(options.engine.fftSize));
  const bands = new Float32Array(16);
  const canPaint = createFrameGate(options.canvasRef, options.frameIntervalMs);
  const analyze = createAudioFeatureAnalyzer();
  const dpr = Math.min(window.devicePixelRatio || 1, options.dprCap);
  let raf = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  function ensureSize(): void {
    const node = options.canvasRef.current;
    if (!node) return;
    const cssW = node.clientWidth || node.width || 100;
    const cssH = node.clientHeight || node.height || 100;
    const scaledW = Math.max(2, Math.floor(cssW * dpr));
    const scaledH = Math.max(2, Math.floor(cssH * dpr));
    const scale = Math.min(1, Math.sqrt(options.maxPixels / Math.max(1, scaledW * scaledH)));
    const targetW = Math.max(2, Math.floor(scaledW * scale));
    const targetH = Math.max(2, Math.floor(scaledH * scale));
    if (targetW === lastWidth && targetH === lastHeight) return;
    lastWidth = targetW;
    lastHeight = targetH;
    node.width = targetW;
    node.height = targetH;
    gl.viewport(0, 0, targetW, targetH);
  }

  function frame(now: number): void {
    if (canPaint(now)) {
      ensureSize();
      options.engine.getFreqData(freq);
      options.engine.getTimeData(wave);
      boostFrequencyData(freq);
      const features = analyze(freq, wave);
      bands.set(features.bands);
      const accent = parseRgbVec(getCssVar('--accent'));

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(uniforms.resolution, Math.max(1, lastWidth), Math.max(1, lastHeight));
      gl.uniform1f(uniforms.time, now / 1000);
      gl.uniform1i(uniforms.mode, shaderModeIndex(options.mode));
      gl.uniform1i(uniforms.palette, paletteIndex(options.palette));
      gl.uniform3f(uniforms.accent, accent[0], accent[1], accent[2]);
      gl.uniform1f(uniforms.bass, features.bass);
      gl.uniform1f(uniforms.lowMid, features.lowMid);
      gl.uniform1f(uniforms.mid, features.mid);
      gl.uniform1f(uniforms.treble, features.treble);
      gl.uniform1f(uniforms.rms, features.rms);
      gl.uniform1f(uniforms.beat, features.beat);
      gl.uniform4f(uniforms.bands0, bands[0]!, bands[1]!, bands[2]!, bands[3]!);
      gl.uniform4f(uniforms.bands1, bands[4]!, bands[5]!, bands[6]!, bands[7]!);
      gl.uniform4f(uniforms.bands2, bands[8]!, bands[9]!, bands[10]!, bands[11]!);
      gl.uniform4f(uniforms.bands3, bands[12]!, bands[13]!, bands[14]!, bands[15]!);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
  };
}

function paintMilkdropFallback(canvas: HTMLCanvasElement, engine: AudioEngine): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const freq = new Uint8Array(new ArrayBuffer(engine.frequencyBinCount));
  engine.getFreqData(freq);
  boostFrequencyData(freq);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 360;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const time = Date.now();
  const gradient = ctx.createRadialGradient(cssW / 2, cssH / 2, 0, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.7);
  gradient.addColorStop(0, '#07130f');
  gradient.addColorStop(0.55, '#050608');
  gradient.addColorStop(1, '#000');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, cssW, cssH);
  const energy = avg(freq, 0, Math.min(96, freq.length)) / 255;
  for (let i = 0; i < 24; i++) {
    const y = (cssH / 24) * i;
    const hue = (i * 12 + time / 42) % 360;
    ctx.strokeStyle = `hsla(${hue}, 96%, 58%, ${0.18 + energy * 0.58})`;
    ctx.lineWidth = 1.2 + energy * 2.8;
    ctx.beginPath();
    const bend = 28 + energy * 90;
    ctx.moveTo(0, y + Math.sin(time / 500 + i) * 5);
    ctx.bezierCurveTo(cssW * 0.25, y + bend, cssW * 0.65, y - bend, cssW, y + 18);
    ctx.stroke();
  }
  const cx = cssW / 2;
  const cy = cssH / 2;
  for (let ring = 0; ring < 10; ring++) {
    const radius = 30 + ring * Math.min(cssW, cssH) * 0.045 + energy * 120;
    ctx.strokeStyle = `hsla(${(ring * 32 + time / 36) % 360}, 88%, 62%, ${0.12 + (10 - ring) * 0.045})`;
    ctx.lineWidth = 1 + energy * 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + Math.sin(time / 300 + ring) * 16, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function avg(arr: Uint8Array, from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to && i < arr.length; i++) {
    sum += arr[i]!;
    count++;
  }
  return count ? sum / count : 0;
}

function boostFrequencyData(arr: Uint8Array): void {
  for (let i = 0; i < arr.length; i += 1) {
    const normalized = arr[i]! / 255;
    const lowBandLift = i < 36 ? 1.18 : i < 120 ? 1.08 : 1;
    const shaped = Math.pow(normalized, 0.68) * 1.34 * lowBandLift;
    arr[i] = Math.max(0, Math.min(255, Math.round(shaped * 255)));
  }
}

function createAudioFeatureAnalyzer(): (freq: Uint8Array, wave: Uint8Array) => AudioFeatures {
  let bassFloor = 0.08;
  let rmsFloor = 0.04;
  let beat = 0;

  return (freq, wave) => {
    const bass = bandValue(freq, 0, 28);
    const lowMid = bandValue(freq, 28, 90);
    const mid = bandValue(freq, 90, 220);
    const treble = bandValue(freq, 220, 520);
    const rms = waveRms(wave);

    const bassOnset = Math.max(0, bass - bassFloor * 1.12);
    const rmsOnset = Math.max(0, rms - rmsFloor * 1.08);
    beat = Math.max(beat * 0.76, Math.min(1, bassOnset * 5.2 + rmsOnset * 3.4));
    bassFloor = bass > bassFloor
      ? bassFloor * 0.94 + bass * 0.06
      : bassFloor * 0.985 + bass * 0.015;
    rmsFloor = rms > rmsFloor
      ? rmsFloor * 0.94 + rms * 0.06
      : rmsFloor * 0.985 + rms * 0.015;

    return {
      bass,
      lowMid,
      mid,
      treble,
      rms,
      beat,
      bands: logBands(freq, 16),
    };
  };
}

function bandValue(arr: Uint8Array, from: number, to: number): number {
  return Math.min(1, Math.pow(avg(arr, from, to) / 255, 0.72) * 1.22);
}

function waveRms(arr: Uint8Array): number {
  if (!arr.length) return 0;
  let sum = 0;
  const stride = Math.max(1, Math.floor(arr.length / 768));
  let count = 0;
  for (let i = 0; i < arr.length; i += stride) {
    const centered = (arr[i]! - 128) / 128;
    sum += centered * centered;
    count += 1;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, count)) * 1.85);
}

function logBands(arr: Uint8Array, count: number): number[] {
  const out: number[] = [];
  const usable = Math.max(2, Math.min(arr.length, 760));
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor(Math.pow(i / count, 1.72) * usable);
    const end = Math.max(start + 2, Math.floor(Math.pow((i + 1) / count, 1.72) * usable));
    out.push(bandValue(arr, start, end));
  }
  return out;
}

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#39ff14';
}

function parseRgbVec(color: string): [number, number, number] {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;
    if ([r, g, b].every(Number.isFinite)) return [r, g, b];
  }
  return [0.22, 1, 0.08];
}

function shaderModeIndex(mode: VizMode): number {
  if (mode === 'neon-ribbons') return 1;
  if (mode === 'plasma-grid') return 2;
  if (mode === 'burning-cloud') return 3;
  return 0;
}

function paletteIndex(palette: VizPalette): number {
  if (palette === 'phosphor') return 1;
  if (palette === 'ice') return 2;
  if (palette === 'sunset') return 3;
  if (palette === 'rainbow') return 4;
  return 0;
}

function oscilloscopePalette(palette: VizPalette, accent: string, now: number): { stroke: string; glow: string; blur: number } {
  const hue = (now / 32) % 360;
  if (palette === 'rainbow') return { stroke: `hsl(${hue}, 98%, 64%)`, glow: `hsl(${(hue + 36) % 360}, 100%, 62%)`, blur: 14 };
  if (palette === 'phosphor') return { stroke: '#66ff7d', glow: '#29ff55', blur: 10 };
  if (palette === 'ice') return { stroke: '#b6f4ff', glow: '#31c7ff', blur: 12 };
  if (palette === 'sunset') return { stroke: '#ffcb5a', glow: '#ff335f', blur: 13 };
  return { stroke: accent, glow: accent, blur: 8 };
}

function createShaderProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[newamp] visualizer shader link failed', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[newamp] visualizer shader compile failed', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function parseRgb(color: string): string {
  // accept #rrggbb or hsl/hsla — fallback to green
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
  }
  return '57, 255, 20';
}

const SHADER_VERTEX_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const SHADER_FRAGMENT_SOURCE = `
precision highp float;

varying vec2 v_uv;
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_mode;
uniform int u_palette;
uniform vec3 u_accent;
uniform float u_bass;
uniform float u_lowMid;
uniform float u_mid;
uniform float u_treble;
uniform float u_rms;
uniform float u_beat;
uniform vec4 u_bands0;
uniform vec4 u_bands1;
uniform vec4 u_bands2;
uniform vec4 u_bands3;

float sat(float v) { return clamp(v, 0.0, 1.0); }

vec3 hsb2rgb(vec3 c) {
  vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  rgb = rgb * rgb * (3.0 - 2.0 * rgb);
  return c.z * mix(vec3(1.0), rgb, c.y);
}

float bandAt(float x) {
  float idx = floor(clamp(x, 0.0, 0.999) * 16.0);
  if (idx < 0.5) return u_bands0.x;
  if (idx < 1.5) return u_bands0.y;
  if (idx < 2.5) return u_bands0.z;
  if (idx < 3.5) return u_bands0.w;
  if (idx < 4.5) return u_bands1.x;
  if (idx < 5.5) return u_bands1.y;
  if (idx < 6.5) return u_bands1.z;
  if (idx < 7.5) return u_bands1.w;
  if (idx < 8.5) return u_bands2.x;
  if (idx < 9.5) return u_bands2.y;
  if (idx < 10.5) return u_bands2.z;
  if (idx < 11.5) return u_bands2.w;
  if (idx < 12.5) return u_bands3.x;
  if (idx < 13.5) return u_bands3.y;
  if (idx < 14.5) return u_bands3.z;
  return u_bands3.w;
}

vec3 palette(float t) {
  t = fract(t);
  if (u_palette == 1) return mix(vec3(0.03, 0.18, 0.06), vec3(0.46, 1.0, 0.48), t);
  if (u_palette == 2) return mix(vec3(0.08, 0.34, 0.56), vec3(0.78, 0.98, 1.0), t);
  if (u_palette == 3) return mix(vec3(0.85, 0.08, 0.22), vec3(1.0, 0.74, 0.24), t);
  if (u_palette == 4) return hsb2rgb(vec3(t + u_time * 0.045, 0.86, 1.0));
  return mix(u_accent * 0.26, normalize(u_accent + vec3(0.12, 0.18, 0.22)), 0.18 + t * 0.82);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i += 1) {
    v += noise(p) * a;
    p = p * 2.02 + vec2(17.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = v_uv;
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float energy = sat(u_rms * 0.55 + u_bass * 0.28 + u_mid * 0.18);
  vec3 color = vec3(0.0);

  if (u_mode == 0) {
    vec3 bg = mix(vec3(0.006, 0.006, 0.015), palette(0.08) * 0.12, energy);
    color += bg;
    for (int i = 0; i < 9; i += 1) {
      float fi = float(i);
      float b = bandAt(fi / 8.0);
      float y = 0.15 + fi * 0.083 + sin(u_time * (0.65 + fi * 0.035) + fi + u_bass * 4.0) * (0.018 + b * 0.075);
      float xphase = uv.x * (5.0 + fi * 0.34) + u_time * (0.74 + b * 0.95) + fi * 0.83;
      float wave = y + sin(xphase) * (0.035 + b * 0.12 + u_bass * 0.04) + sin(xphase * 0.47 + u_mid * 5.0) * (0.025 + u_treble * 0.05);
      float line = exp(-abs(uv.y - wave) * (92.0 - b * 34.0));
      color += palette(fi * 0.095 + b * 0.32 + u_time * 0.02) * line * (0.26 + b * 1.45 + u_beat * 0.9);
    }
    float scan = 0.88 + 0.12 * sin(uv.y * u_resolution.y * 1.7);
    color *= scan;
  } else if (u_mode == 1) {
    color += vec3(0.002, 0.001, 0.008);
    for (int i = 0; i < 6; i += 1) {
      float fi = float(i);
      float b = bandAt(fi / 5.0);
      float theta = atan(p.y, p.x);
      float radius = length(p);
      float curve = abs(sin(theta * (2.0 + fi * 0.55) + u_time * (0.9 + fi * 0.15) + radius * (6.0 + b * 9.0)));
      float target = 0.48 + sin(theta * 3.0 - u_time + fi) * 0.12 + b * 0.22 + u_bass * 0.16;
      float line = exp(-abs(radius - target * curve) * (12.0 + b * 22.0));
      color += palette(fi * 0.12 + theta * 0.08 + u_time * 0.03) * line * (0.24 + b * 1.35 + u_beat * 0.75);
    }
    float core = exp(-length(p) * (6.0 - u_bass * 2.0));
    color += palette(0.62 + u_time * 0.02) * core * (0.16 + energy * 0.54);
  } else if (u_mode == 2) {
    vec2 q = uv;
    float b0 = bandAt(q.x);
    float b1 = bandAt(q.y);
    q.x += sin(q.y * 13.0 + u_time * 1.25) * (0.018 + u_bass * 0.05) + b1 * 0.045;
    q.y += cos(q.x * 11.0 - u_time * 1.08) * (0.018 + u_mid * 0.045) + b0 * 0.04;
    float gridX = 1.0 - smoothstep(0.006, 0.028 + u_bass * 0.018, abs(fract(q.x * (10.0 + u_treble * 10.0)) - 0.5));
    float gridY = 1.0 - smoothstep(0.006, 0.028 + u_mid * 0.018, abs(fract(q.y * (8.0 + u_bass * 8.0)) - 0.5));
    float plasma = fbm(q * (4.0 + u_mid * 5.0) + vec2(u_time * 0.22, -u_time * 0.16));
    float lines = max(gridX, gridY) * (0.25 + plasma + u_beat * 0.65);
    color += palette(plasma + u_time * 0.04) * lines;
    color += palette(0.7 + plasma) * exp(-length(p) * (2.7 - u_bass)) * (0.08 + u_bass * 0.36);
  } else {
    vec2 q = p * (2.1 - u_bass * 0.35);
    float heat = fbm(q * (2.0 + u_mid * 3.0) + vec2(0.0, -u_time * (0.38 + u_bass)));
    heat += fbm(q * 4.2 + vec2(u_time * 0.15, u_time * 0.22)) * 0.5;
    heat += u_bass * 0.85 + u_beat * 0.7;
    float plume = smoothstep(0.18, 1.58, heat - length(p) * (0.48 - u_rms * 0.16));
    vec3 ember = mix(vec3(0.09, 0.01, 0.0), vec3(0.96, 0.19, 0.03), plume);
    vec3 flame = mix(ember, vec3(1.0, 0.82, 0.26), smoothstep(0.78, 1.56, heat));
    vec3 accentBurn = mix(flame, palette(heat * 0.33 + u_time * 0.03), 0.16 + u_treble * 0.24);
    color += accentBurn * plume * (0.55 + energy * 0.75);
    color += vec3(0.018, 0.004, 0.0);
  }

  color += palette(0.55 + u_time * 0.08) * u_beat * 0.22;
  color = pow(color, vec3(0.82));
  gl_FragColor = vec4(color, 1.0);
}
`;
