import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';

export type VizMode = 'mini' | 'spectrum' | 'oscilloscope' | 'galaxy' | 'aurora' | 'butterchurn';

interface Props {
  mode: VizMode;
  width?: number;
  height?: number;
  className?: string;
  artUrl?: string | null;
}

export function Visualizer({ mode, width, height, className, artUrl }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = usePlayerStore((s) => s.engine);

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

      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      function ensureSize() {
        const node = canvasRef.current;
        if (!node) return;
        const cssW = node.clientWidth || node.width || 100;
        const cssH = node.clientHeight || node.height || 100;
        const targetW = Math.max(8, Math.floor(cssW * dpr));
        const targetH = Math.max(8, Math.floor(cssH * dpr));
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
          visualizer.connectAudio(engine.masterGain);

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

          const frame = () => {
            ensureSize();
            visualizer?.render();
            raf = requestAnimationFrame(frame);
          };
          raf = requestAnimationFrame(frame);
        } catch (err) {
          if (!cancelled) paintButterchurnFallback(butterCanvas, err);
        }
      }

      void startButterchurn();

      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        if (presetTimer != null) window.clearInterval(presetTimer);
        try {
          visualizer?.disconnectAudio(engine.masterGain);
        } catch {
          /* ignore */
        }
      };
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let ctx: CanvasRenderingContext2D | null = null;
    const freq = new Uint8Array(new ArrayBuffer(engine.analyser.frequencyBinCount));
    const wave = new Uint8Array(new ArrayBuffer(engine.analyser.fftSize));

    function ensureSize() {
      const node = canvasRef.current;
      if (!node) return;
      const w = node.clientWidth || node.width || 100;
      const h = node.clientHeight || node.height || 40;
      const targetW = Math.max(2, Math.floor(w * dpr));
      const targetH = Math.max(2, Math.floor(h * dpr));
      if (node.width !== targetW || node.height !== targetH) {
        node.width = targetW;
        node.height = targetH;
      }
      ctx = node.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    function frame() {
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
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const slice = w / wave.length;
        for (let i = 0; i < wave.length; i++) {
          const v = wave[i]! / 128 - 1;
          const y = h / 2 + (v * h) / 2;
          if (i === 0) ctx.moveTo(0, y);
          else ctx.lineTo(i * slice, y);
        }
        ctx.shadowColor = accent;
        ctx.shadowBlur = 8;
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
        // Smooth gradient bands sliding horizontally, modulated by mid energy.
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(0, 0, w, h);
        const bands = 6;
        const t = Date.now() / 1600;
        for (let b = 0; b < bands; b++) {
          const energy = avg(freq, b * 8, b * 8 + 12) / 255;
          const yc = h * (0.2 + 0.12 * b) + Math.sin(t + b) * 18;
          const grd = ctx.createLinearGradient(0, yc - 40, 0, yc + 40);
          const hue = (b * 50 + Date.now() / 50) % 360;
          grd.addColorStop(0, `hsla(${hue}, 90%, 60%, 0)`);
          grd.addColorStop(0.5, `hsla(${hue}, 95%, 65%, ${0.18 + energy * 0.5})`);
          grd.addColorStop(1, `hsla(${hue}, 90%, 60%, 0)`);
          ctx.fillStyle = grd;
          ctx.fillRect(0, yc - 40, w, 80);
        }
      }

      void ink2;
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [engine, mode]);

  const style: React.CSSProperties = {};
  if (width != null) style.width = `${width}px`;
  if (height != null) style.height = `${height}px`;

  return (
    <canvas
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

function paintButterchurnFallback(canvas: HTMLCanvasElement, err: unknown): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 360;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 18; i++) {
    const y = (cssH / 18) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(cssW * 0.25, y + 40, cssW * 0.65, y - 40, cssW, y + 18);
    ctx.stroke();
  }
  ctx.fillStyle = '#39ff14';
  ctx.font = '600 16px Inter, system-ui, sans-serif';
  ctx.fillText('Milkdrop visualizer unavailable', 28, 42);
  ctx.fillStyle = 'rgba(231, 255, 231, 0.7)';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.fillText(err instanceof Error ? err.message : 'WebGL 2 or Butterchurn failed to initialize', 28, 66);
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
