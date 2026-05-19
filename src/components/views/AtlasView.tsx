import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '@shared/types';
import {
  atlasPointColor,
  buildSonicAtlas,
  nearestAtlasPoint,
  type AtlasPoint,
  type SonicAtlas,
} from '@shared/sonic-atlas';
import { api } from '../../lib/api';
import { usePlayerStore } from '../../store/usePlayerStore';

interface ViewTransform {
  x: number; // pan in canvas pixels
  y: number;
  scale: number; // 1 = fit
}

const INITIAL_TRANSFORM: ViewTransform = { x: 0, y: 0, scale: 1 };

export function AtlasView(): JSX.Element {
  const [atlas, setAtlas] = useState<SonicAtlas | null>(null);
  const [trackIndex, setTrackIndex] = useState<Map<number, Track>>(new Map());
  const [status, setStatus] = useState<string | null>('Loading library DNA…');
  const [hovered, setHovered] = useState<AtlasPoint | null>(null);
  const [transform, setTransform] = useState<ViewTransform>(INITIAL_TRANSFORM);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(null);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);

  const reload = useCallback(async () => {
    setStatus('Loading library DNA…');
    setAtlas(null);
    const rows = await api.getAllTrackDna();
    if (!rows.length) {
      setStatus('No DNA available yet. Analyze tracks in Now Playing or via npm run smoke:dna fixtures.');
      return;
    }
    const t0 = performance.now();
    const next = buildSonicAtlas(rows);
    const t1 = performance.now();
    setAtlas(next);
    // Hydrate displayed tracks lazily — the canvas doesn't need full track
    // rows, only hovered/clicked ones. We fetch on demand below.
    setStatus(`${rows.length.toLocaleString()} tracks projected in ${Math.round(t1 - t0)} ms`);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Draw the atlas to canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !atlas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = Math.max(1, rect.width * dpr);
      canvas.height = Math.max(1, rect.height * dpr);
    }
    const w = rect.width;
    const h = rect.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = readVar('--display-bg', '#0e0d10');
    ctx.fillRect(0, 0, w, h);

    // Backdrop grid for orientation.
    ctx.strokeStyle = withAlpha(readVar('--line', '#2b2731'), 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 0; g <= 10; g++) {
      const x = (g / 10) * w;
      const y = (g / 10) * h;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();

    const r = Math.max(1.4, Math.min(3, 1.6 * transform.scale));
    for (const point of atlas.points) {
      const canvasX = (point.x * w - transform.x) * transform.scale + transform.x;
      const canvasY = ((1 - point.y) * h - transform.y) * transform.scale + transform.y;
      ctx.fillStyle = atlasPointColor(point);
      ctx.globalAlpha = 0.78;
      ctx.beginPath();
      ctx.arc(canvasX, canvasY, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (hovered) {
      const hx = (hovered.x * w - transform.x) * transform.scale + transform.x;
      const hy = ((1 - hovered.y) * h - transform.y) * transform.scale + transform.y;
      ctx.strokeStyle = readVar('--accent', '#98ffd1');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [atlas, transform, hovered]);

  // Re-render on resize.
  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver(() => setTransform((t) => ({ ...t })));
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  function clientToAtlas(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    // Inverse of the draw transform.
    const baseX = (sx - transform.x) / transform.scale + transform.x;
    const baseY = (sy - transform.y) / transform.scale + transform.y;
    return { x: baseX / w, y: 1 - baseY / h };
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>): void {
    if (dragRef.current) {
      const d = dragRef.current;
      setTransform((t) => ({
        ...t,
        x: d.startTx + (e.clientX - d.startX),
        y: d.startTy + (e.clientY - d.startY),
      }));
      return;
    }
    if (!atlas) return;
    const atlasCoord = clientToAtlas(e.clientX, e.clientY);
    if (!atlasCoord) return;
    const hit = nearestAtlasPoint(atlas, atlasCoord.x, atlasCoord.y, 0.02 / transform.scale);
    setHovered(hit);
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>): void {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: transform.x,
      startTy: transform.y,
    };
  }

  function handleMouseUp(): void {
    dragRef.current = null;
  }

  async function handleClick(e: React.MouseEvent<HTMLCanvasElement>): Promise<void> {
    if (!atlas) return;
    const atlasCoord = clientToAtlas(e.clientX, e.clientY);
    if (!atlasCoord) return;
    const hit = nearestAtlasPoint(atlas, atlasCoord.x, atlasCoord.y, 0.02 / transform.scale);
    if (!hit) return;
    const track = trackIndex.get(hit.id) ?? (await api.getTrack(hit.id));
    if (!track) return;
    if (!trackIndex.has(hit.id)) setTrackIndex((prev) => new Map(prev).set(hit.id, track));
    if (e.shiftKey) {
      queueTracksNext([track]);
    } else {
      await playQueue([track], 0);
    }
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    setTransform((t) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const cx = (rect ? e.clientX - rect.left : 0);
      const cy = (rect ? e.clientY - rect.top : 0);
      const nextScale = Math.max(0.5, Math.min(8, t.scale * factor));
      const ratio = nextScale / t.scale;
      return {
        x: t.x + (cx - t.x) * (1 - ratio),
        y: t.y + (cy - t.y) * (1 - ratio),
        scale: nextScale,
      };
    });
  }

  useEffect(() => {
    if (!hovered) return;
    if (trackIndex.has(hovered.id)) return;
    let cancelled = false;
    void (async () => {
      const track = await api.getTrack(hovered.id);
      if (!cancelled && track) {
        setTrackIndex((prev) => new Map(prev).set(track.id, track));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hovered, trackIndex]);

  const hoveredTrack = hovered ? trackIndex.get(hovered.id) ?? null : null;
  const xHint = atlas?.axes.x.hint ?? '';
  const yHint = atlas?.axes.y.hint ?? '';
  const summary = useMemo(() => atlas ? `${atlas.points.length.toLocaleString()} tracks` : '0 tracks', [atlas]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="flex items-baseline gap-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
          Sonic Atlas
        </h2>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          Your library projected by Audio DNA — pan, zoom, click to play, Shift-click to queue next.
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button className="pxbtn" onClick={() => setTransform(INITIAL_TRANSFORM)}>Reset view</button>
          <button className="pxbtn is-active" onClick={() => void reload()}>Recompute</button>
        </span>
      </header>
      <div ref={wrapRef} className="relative flex-1 overflow-hidden bevel-out" style={{ background: 'var(--display-bg)' }}>
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={(e) => void handleClick(e)}
          onWheel={handleWheel}
          className="block h-full w-full cursor-crosshair"
          style={{ touchAction: 'none' }}
        />
        {atlas && (
          <>
            <div className="pointer-events-none absolute bottom-2 left-2 text-[10px]" style={{ color: 'var(--muted)' }}>
              X axis: {xHint}
            </div>
            <div className="pointer-events-none absolute left-2 top-2 origin-top-left -rotate-90 text-[10px]" style={{ color: 'var(--muted)', transform: 'translateY(8em) rotate(-90deg)' }}>
              Y axis: {yHint}
            </div>
          </>
        )}
        {hovered && (
          <div
            className="pointer-events-none absolute rounded p-2 text-[11px] shadow-lg"
            style={{
              left: 12,
              bottom: 28,
              background: 'var(--panel)',
              border: '1px solid var(--accent)',
              color: 'var(--ink)',
              maxWidth: 320,
            }}
          >
            <div className="font-bold" style={{ color: 'var(--accent)' }}>
              {hoveredTrack?.title ?? `Track #${hovered.id}`}
            </div>
            <div style={{ color: 'var(--ink-2)' }}>{hoveredTrack?.artist ?? 'loading…'}</div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums" style={{ color: 'var(--muted)' }}>
              <span>brightness</span><span className="text-right">{hovered.dna.brightness.toFixed(2)}</span>
              <span>energy</span><span className="text-right">{hovered.dna.rms.toFixed(2)}</span>
              <span>dyn range</span><span className="text-right">{hovered.dna.dynamicRange.toFixed(2)}</span>
              <span>onsets</span><span className="text-right">{hovered.dna.onsetDensity.toFixed(2)}</span>
              <span>flatness</span><span className="text-right">{hovered.dna.flatness.toFixed(2)}</span>
              <span>rolloff</span><span className="text-right">{hovered.dna.rolloff.toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>
      <footer className="flex items-center gap-3 bevel-out p-2 text-[11px]" style={{ background: 'var(--panel)', color: 'var(--muted)' }}>
        <span>{summary}</span>
        <span style={{ color: status ? 'var(--ink-2)' : 'var(--muted)' }}>{status ?? '—'}</span>
        <span className="ml-auto" style={{ color: 'var(--muted)' }}>
          Zoom {transform.scale.toFixed(2)}× · Drag to pan · Wheel to zoom · Click = play, Shift-click = queue next
        </span>
      </footer>
    </div>
  );
}

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
