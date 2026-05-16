// Hero "first run" state for the library view. Replaces the previous faint
// "Library is empty" line with a dense launchpad that matches the trader-
// Dashboard-style empty state: stats grid, radar pulse, numbered
// steps, big call-to-action.

import { useEffect, useRef, useState } from 'react';
import type { MusicFolderSuggestion } from '@shared/types';
import { api, inElectron } from '../../lib/api';
import { usePlayerStore } from '../../store/usePlayerStore';

export function EmptyLibrary(): JSX.Element {
  const setView = usePlayerStore((s) => s.setView);
  const [folders, setFolders] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<MusicFolderSuggestion[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getSettings(), api.getSuggestedMusicFolders()])
      .then(([settings, detected]) => {
        if (cancelled) return;
        setFolders(settings.libraryRoots);
        setSuggestions(detected);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const availableSuggestions = suggestions.filter((suggestion) =>
    !folders.some((folder) => samePath(folder, suggestion.path)),
  );

  async function chooseFolder(): Promise<void> {
    if (!inElectron) {
      // eslint-disable-next-line no-alert
      alert('Open Newamp in Electron (not the browser preview) to pick a folder.');
      return;
    }
    const dir = await api.pickFolder();
    if (!dir) return;
    await addFolderAndScan(dir);
  }

  async function addFolderAndScan(dir: string): Promise<void> {
    const next = mergeRoots(folders, dir);
    setFolders(next);
    const updated = await api.setSettings({ libraryRoots: next });
    setFolders(updated.libraryRoots);
    await scanFolders([dir]);
  }

  async function scanFolders(roots: string[]): Promise<void> {
    if (!roots.length) return;
    setScanning(true);
    try {
      await api.scanLibrary(roots);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      <RadarBackdrop active={!folders.length || scanning} />

      <div className="relative z-10 mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-8 py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HexBadge label="0/3" tone="warn" />
            <div>
              <div
                className="text-[10px] uppercase tracking-[0.32em]"
                style={{ color: 'var(--muted)' }}
              >
                System status
              </div>
              <div className="text-[18px] font-semibold" style={{ color: 'var(--ink)' }}>
                Newamp is ready to ingest your collection
              </div>
            </div>
          </div>
          <div
            className="text-[10px] uppercase tracking-[0.32em]"
            style={{ color: 'var(--muted)' }}
          >
            {inElectron ? '● local · offline · yours' : '● browser preview'}
          </div>
        </header>

        <section className="grid grid-cols-4 gap-3">
          <StatTile label="Tracks indexed" value="0" hint="audio files" />
          <StatTile label="Albums" value="0" hint="album clusters" />
          <StatTile label="Artists" value="0" hint="distinct artists" />
          <StatTile label="Runtime" value="0:00:00" hint="total duration" />
        </section>

        <section className="grid grid-cols-3 gap-3">
          <Step
            n={1}
            title="Choose a music folder"
            description="Point Newamp at any folder. K:/music appears below as a one-click scan target when it exists. Subfolders are scanned recursively."
            done={folders.length > 0}
          />
          <Step
            n={2}
            title="Let it scan"
            description="Tag-read, album art extract, library indexing. Runs in the background — you can listen while it works."
            done={false}
          />
          <Step
            n={3}
            title="Listen"
            description="Native MP3/FLAC/M4A/OGG/OPUS/WAV plus ffmpeg fallback for WMA, ALAC, AIFF, DSF, APE, WV, MPC, TTA, AC3, DTS. Lyrics from LRCLIB."
            done={false}
          />
        </section>

        {availableSuggestions.length > 0 && (
          <section
            className="flex flex-wrap items-center gap-2 px-4 py-3 text-[11px]"
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-card)',
              color: 'var(--ink-2)',
            }}
          >
            <span
              className="uppercase tracking-[0.28em]"
              style={{ color: 'var(--muted)' }}
            >
              Detected folders
            </span>
            {availableSuggestions.slice(0, 4).map((suggestion) => (
              <button
                key={suggestion.path}
                data-music-folder-suggestion
                className="pxbtn is-active max-w-[320px] truncate"
                disabled={scanning}
                title={`${suggestion.reason}: ${suggestion.path}`}
                onClick={() => void addFolderAndScan(suggestion.path)}
              >
                {suggestion.label}: {suggestion.path}
              </button>
            ))}
          </section>
        )}

        <section className="flex items-stretch gap-3">
          <button
            onClick={() => void chooseFolder()}
            disabled={scanning}
            className="group relative flex flex-1 items-center justify-between overflow-hidden px-6 py-4 transition-all"
            style={{
              background:
                'linear-gradient(135deg, var(--panel-2) 0%, var(--panel) 100%)',
              border: '1px solid var(--accent)',
              boxShadow: '0 0 18px var(--accent-glow), inset 0 0 0 1px rgba(255,255,255,0.04)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            <span
              className="absolute inset-y-0 left-0 w-1"
              style={{ background: 'var(--accent)', boxShadow: '0 0 12px var(--accent-glow)' }}
            />
            <div className="flex flex-col items-start gap-1 text-left">
              <span
                className="text-[10px] uppercase tracking-[0.32em]"
                style={{ color: 'var(--accent)', textShadow: '0 0 6px var(--accent-glow)' }}
              >
                action · {inElectron ? 'opens system dialog' : 'requires electron'}
              </span>
              <span className="text-[20px] font-semibold" style={{ color: 'var(--ink)' }}>
                Choose folder &amp; begin scan
              </span>
            </div>
            <ArrowIcon />
          </button>

          <button
            onClick={() => setView('settings')}
            className="flex items-center justify-center gap-2 px-5 transition-colors"
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--line)',
              color: 'var(--ink-2)',
              borderRadius: 'var(--radius-card)',
              fontSize: 12,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
            }}
          >
            Open Settings
          </button>
        </section>

        {folders.length > 0 && (
          <section
            className="bevel-out flex items-center gap-3 px-4 py-3 text-[11px]"
            style={{ color: 'var(--ink-2)' }}
          >
            <span style={{ color: 'var(--accent)' }}>● configured</span>
            <span className="font-mono">{folders.join('  ·  ')}</span>
            <button
              className="pxbtn ml-auto is-active"
              disabled={scanning}
              onClick={() => void scanFolders(folders)}
            >
              ▶ Scan now
            </button>
          </section>
        )}

        <section className="grid grid-cols-3 gap-3 text-[11px]">
          <FeatureCard label="Lyrics" detail="LRCLIB · synced LRC, no auth" />
          <FeatureCard label="Radio" detail="50,000+ stations · radio-browser.info" />
          <FeatureCard label="Visualizers" detail="Milkdrop · Spectrum · Galaxy · Aurora" />
        </section>
      </div>
    </div>
  );
}

function mergeRoots(roots: string[], nextRoot: string): string[] {
  const out: string[] = [];
  for (const root of [...roots, nextRoot]) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    if (out.some((existing) => samePath(existing, trimmed))) continue;
    out.push(trimmed);
  }
  return out;
}

function samePath(a: string, b: string): boolean {
  return normalizePathKey(a) === normalizePathKey(b);
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function HexBadge({ label, tone = 'accent' }: { label: string; tone?: 'accent' | 'warn' | 'error' }): JSX.Element {
  const color =
    tone === 'warn' ? 'var(--warn)' : tone === 'error' ? 'var(--error)' : 'var(--accent)';
  return (
    <div
      className="relative flex items-center justify-center"
      style={{
        width: 56,
        height: 64,
        clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
        background: 'var(--panel-2)',
        boxShadow: `inset 0 0 0 1px ${color}33, 0 0 14px ${color}55`,
      }}
    >
      <div
        className="absolute inset-[3px] flex items-center justify-center"
        style={{
          clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
          background: 'var(--panel)',
        }}
      >
        <span
          className="text-[13px] font-bold tracking-wide"
          style={{ color, textShadow: `0 0 8px ${color}` }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}): JSX.Element {
  return (
    <div
      className="relative flex flex-col gap-1 px-4 py-3"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <div
        className="text-[9px] uppercase tracking-[0.28em]"
        style={{ color: 'var(--muted)' }}
      >
        {label}
      </div>
      <div
        className="lcd-text text-[28px] leading-none"
        style={{ fontFamily: 'var(--font-lcd)', letterSpacing: '0.02em' }}
      >
        {value}
      </div>
      <div className="text-[10px]" style={{ color: 'var(--ink-2)' }}>
        {hint}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  description,
  done,
}: {
  n: number;
  title: string;
  description: string;
  done: boolean;
}): JSX.Element {
  return (
    <div
      className="relative flex flex-col gap-2 p-4"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex h-7 w-7 items-center justify-center text-[12px] font-bold"
          style={{
            background: done ? 'var(--accent)' : 'var(--panel-3)',
            color: done ? 'var(--bg)' : 'var(--ink-2)',
            borderRadius: 'var(--radius)',
            boxShadow: done ? '0 0 10px var(--accent-glow)' : undefined,
          }}
        >
          {done ? '✓' : n}
        </div>
        <div className="text-[13px] font-semibold">{title}</div>
      </div>
      <div className="text-[11px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
        {description}
      </div>
    </div>
  );
}

function FeatureCard({ label, detail }: { label: string; detail: string }): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1 px-4 py-3"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <div
        className="text-[10px] uppercase tracking-[0.28em]"
        style={{ color: 'var(--muted)' }}
      >
        {label}
      </div>
      <div className="text-[12px]" style={{ color: 'var(--ink)' }}>
        {detail}
      </div>
    </div>
  );
}

function ArrowIcon(): JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <path
        d="M8 16h16M18 10l6 6-6 6"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
        style={{ filter: 'drop-shadow(0 0 4px var(--accent-glow))' }}
      />
    </svg>
  );
}

function RadarBackdrop({ active }: { active: boolean }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active) return;
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let t = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function fit() {
      if (!c) return;
      c.width = Math.floor(c.clientWidth * dpr);
      c.height = Math.floor(c.clientHeight * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);

    function frame() {
      if (!c || !ctx) return;
      const w = c.clientWidth;
      const h = c.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) * 0.45;
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim() || '#39ff14';

      // concentric rings
      ctx.strokeStyle = accent + '14';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (maxR / 4) * i, 0, Math.PI * 2);
        ctx.stroke();
      }
      // crosshair
      ctx.beginPath();
      ctx.moveTo(cx - maxR, cy);
      ctx.lineTo(cx + maxR, cy);
      ctx.moveTo(cx, cy - maxR);
      ctx.lineTo(cx, cy + maxR);
      ctx.stroke();
      // sweeping arm
      t += 0.012;
      const angle = t;
      const sweepW = 0.6;
      for (let i = 0; i < 24; i++) {
        const a = angle - (i / 24) * sweepW;
        const alpha = (1 - i / 24) * 0.35;
        ctx.strokeStyle = hexA(accent, alpha);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
        ctx.stroke();
      }
      // dots representing potential tracks (random distribution but deterministic)
      ctx.fillStyle = accent + '40';
      for (let i = 0; i < 60; i++) {
        const r = (Math.sin(i * 999) * 0.5 + 0.5) * maxR;
        const a = i * 0.6;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        // make dots near the sweep brighter
        const diff = Math.abs(((a - angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2));
        const lit = diff < 0.5 || diff > Math.PI * 2 - 0.5;
        ctx.fillStyle = lit ? accent : accent + '20';
        ctx.beginPath();
        ctx.arc(x, y, lit ? 2 : 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active]);

  return (
    <canvas
      ref={ref}
      className="absolute inset-0 h-full w-full"
      style={{ opacity: 0.5, pointerEvents: 'none' }}
    />
  );
}

function hexA(hex: string, a: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
