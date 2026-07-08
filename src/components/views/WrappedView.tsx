import { useEffect, useMemo, useRef, useState } from 'react';
import type { WrappedRange, WrappedStats } from '@shared/types';
import { WrappedLiveExport } from '../WrappedLiveExport';
import { api } from '../../lib/api';
import { pushToast } from '../../lib/toast';
import { ViewSkeleton } from '../ViewSkeleton';
import { ArtistLink } from '../EntityLink';

const RANGES: Array<{ id: WrappedRange; label: string }> = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All Time' },
];

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Append a hex alpha byte when the color is a plain 6-digit hex; otherwise
 *  return the color untouched so canvas never sees an invalid fillStyle. */
function hexAlpha(color: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : color;
}

function formatHours(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// Compose a portrait, shareable PNG from the stats. Drawn entirely on an
// offscreen 2D canvas so it's self-contained and on-brand. Colors are sampled
// from the live skin tokens at draw time, so a Steel or Miami user's card
// matches their app instead of a hardcoded dark theme.
function composeShareCard(stats: WrappedStats): string {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const accent = readVar('--accent', '#39ff14');
  const bg = readVar('--bg', '#0a0e07');
  const panel = readVar('--panel', '#141b14');
  const ink = readVar('--ink', '#cfead0');
  const muted = readVar('--muted', '#7a9c7a');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, panel);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Accent glow band
  const glow = ctx.createRadialGradient(W * 0.5, 180, 40, W * 0.5, 180, 620);
  glow.addColorStop(0, hexAlpha(accent, '33'));
  glow.addColorStop(1, hexAlpha(bg, '00'));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 520);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = accent;
  ctx.font = '700 34px "JetBrains Mono", monospace';
  ctx.fillText('NEWAMP WRAPPED', 72, 130);
  ctx.fillStyle = ink;
  ctx.font = '800 92px Inter, system-ui, sans-serif';
  ctx.fillText(stats.label, 72, 230);

  // Big totals
  ctx.fillStyle = muted;
  ctx.font = '600 26px Inter, system-ui, sans-serif';
  ctx.fillText('TIME LISTENED', 72, 320);
  ctx.fillText('TRACKS PLAYED', 560, 320);
  ctx.fillStyle = ink;
  ctx.font = '800 66px Inter, system-ui, sans-serif';
  ctx.fillText(formatHours(stats.totals.durationSec), 72, 392);
  ctx.fillText(String(stats.totals.plays), 560, 392);

  // Top tracks
  let y = 500;
  ctx.fillStyle = accent;
  ctx.font = '700 30px "JetBrains Mono", monospace';
  ctx.fillText('TOP TRACKS', 72, y);
  y += 26;
  ctx.font = '600 36px Inter, system-ui, sans-serif';
  stats.topTracks.slice(0, 5).forEach((t, i) => {
    y += 64;
    ctx.fillStyle = muted;
    ctx.font = '800 36px Inter, system-ui, sans-serif';
    ctx.fillText(`${i + 1}`, 72, y);
    ctx.fillStyle = ink;
    ctx.font = '600 36px Inter, system-ui, sans-serif';
    const line = `${t.title} — ${t.artist}`;
    ctx.fillText(line.length > 38 ? `${line.slice(0, 37)}…` : line, 128, y);
  });

  // Top artist + mood
  y += 96;
  ctx.fillStyle = accent;
  ctx.font = '700 30px "JetBrains Mono", monospace';
  ctx.fillText('TOP ARTIST', 72, y);
  ctx.fillText('YOUR VIBE', 560, y);
  y += 56;
  ctx.fillStyle = ink;
  ctx.font = '700 44px Inter, system-ui, sans-serif';
  ctx.fillText(stats.topArtists[0]?.artist ?? '—', 72, y);
  ctx.fillText(stats.taste?.mood ?? '—', 560, y);

  // Stat chips
  y += 120;
  const chips: Array<[string, string]> = [
    [String(stats.totals.uniqueArtists), 'artists'],
    [String(stats.totals.discoveries), 'discovered'],
    [stats.peakHour != null ? formatHour(stats.peakHour) : '—', 'peak hour'],
  ];
  chips.forEach(([value, label], i) => {
    const x = 72 + i * 320;
    ctx.fillStyle = hexAlpha(accent, '22');
    ctx.fillRect(x, y, 288, 150);
    ctx.fillStyle = accent;
    ctx.font = '800 56px Inter, system-ui, sans-serif';
    ctx.fillText(value, x + 28, y + 78);
    ctx.fillStyle = muted;
    ctx.font = '600 26px Inter, system-ui, sans-serif';
    ctx.fillText(label, x + 28, y + 120);
  });

  // Footer wordmark + repo line — the card is a share, so sign it (subtly).
  ctx.fillStyle = muted;
  ctx.font = '600 26px "JetBrains Mono", monospace';
  ctx.fillText('made with NewAmp · local-first music', 72, H - 96);
  ctx.globalAlpha = 0.75;
  ctx.font = '500 22px "JetBrains Mono", monospace';
  ctx.fillText('github.com/evilander/newamp', 72, H - 56);
  ctx.globalAlpha = 1;

  return canvas.toDataURL('image/png');
}

export function WrappedView(): JSX.Element {
  const [range, setRange] = useState<WrappedRange>('year');
  const [stats, setStats] = useState<WrappedStats | null>(null);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  useEffect(() => {
    const seq = ++reqRef.current;
    setLoading(true);
    api
      .getWrappedStats({ range })
      .then((result) => {
        if (seq === reqRef.current) setStats(result);
      })
      .catch((err) => {
        console.error('[newamp] wrapped stats failed', err);
        if (seq === reqRef.current) setStats(null);
      })
      .finally(() => {
        if (seq === reqRef.current) setLoading(false);
      });
  }, [range]);

  const clockMax = useMemo(() => Math.max(1, ...(stats?.listeningClock ?? [1])), [stats]);
  const genreMax = useMemo(() => Math.max(1, ...(stats?.genres ?? []).map((g) => g.plays)), [stats]);

  const saveCard = async (): Promise<void> => {
    if (!stats) return;
    const dataUrl = composeShareCard(stats);
    if (!dataUrl) return;
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const saved = await api.saveCaptureBytes({
      base64,
      defaultName: `NewAmp Wrapped - ${stats.label}`,
      filterName: 'PNG image',
      ext: 'png',
    });
    if (saved) pushToast({ tone: 'ok', title: 'Share card saved', detail: 'Skin-true PNG, ready to post.' });
  };

  const copyCard = async (): Promise<void> => {
    if (!stats) return;
    const dataUrl = composeShareCard(stats);
    if (!dataUrl) return;
    const ok = await api.copyPngToClipboard(dataUrl);
    if (ok) pushToast({ tone: 'ok', title: 'Share card copied to clipboard' });
    else pushToast({ tone: 'warn', title: 'Copy unavailable' });
  };

  const hasData = !!stats && stats.totals.plays > 0;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[13px] font-bold tracking-[0.2em]" style={{ color: 'var(--accent)' }}>
              NEWAMP WRAPPED
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight" style={{ color: 'var(--ink)' }}>
              {stats?.label ?? 'Your listening, wrapped'}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="bevel-out flex overflow-hidden rounded">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  className={`pxbtn ${range === r.id ? 'is-active' : ''}`}
                  data-newamp-wrapped-range={r.id}
                  onClick={() => setRange(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button className="pxbtn" onClick={() => void saveCard()} disabled={!hasData} title="Save a shareable PNG card">
              SHARE CARD
            </button>
            <button className="pxbtn" onClick={() => void copyCard()} disabled={!hasData} title="Copy a shareable PNG to the clipboard">
              COPY
            </button>
          </div>
        </header>

        {hasData && stats && <WrappedLiveExport stats={stats} />}

        {loading && <ViewSkeleton variant="cards" count={8} />}

        {!loading && !hasData && (
          <div className="rounded-lg p-8 text-center" style={{ background: 'var(--panel)', color: 'var(--muted)' }}>
            No plays in this window yet. Listen to some music and your Wrapped fills in.
          </div>
        )}

        {!loading && hasData && stats && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Big totals */}
            <section className="rounded-lg p-5 md:col-span-3" style={{ background: 'var(--panel)' }}>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Time listened" value={formatHours(stats.totals.durationSec)} />
                <Stat label="Tracks played" value={String(stats.totals.plays)} />
                <Stat label="Artists" value={String(stats.totals.uniqueArtists)} />
                <Stat label="Discovered" value={String(stats.totals.discoveries)} />
              </div>
            </section>

            {/* Top tracks */}
            <section className="rounded-lg p-5 md:col-span-2" style={{ background: 'var(--panel)' }}>
              <CardTitle>Top tracks</CardTitle>
              <ol className="mt-3 flex flex-col gap-2">
                {stats.topTracks.map((t, i) => (
                  <li key={t.id} className="flex items-baseline gap-3">
                    <span className="w-6 text-right font-bold" style={{ color: 'var(--accent)' }}>
                      {i + 1}
                    </span>
                    <span className="flex-1 truncate" style={{ color: 'var(--ink)' }}>
                      {t.title} <span style={{ color: 'var(--muted)' }}>· <ArtistLink artist={t.artist} color="inherit" /></span>
                    </span>
                    <span style={{ color: 'var(--muted)' }}>{t.plays}</span>
                  </li>
                ))}
              </ol>
            </section>

            {/* Vibe + streak */}
            <section className="flex flex-col gap-4">
              <div className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
                <CardTitle>Your vibe</CardTitle>
                <div className="mt-2 text-2xl font-bold" style={{ color: 'var(--ink)' }}>
                  {stats.taste?.mood ?? 'Add Audio DNA to unlock'}
                </div>
                {stats.taste && (
                  <div className="mt-3 flex flex-col gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                    <Meter label="Energy" value={stats.taste.energy} />
                    <Meter label="Brightness" value={stats.taste.brightness} />
                  </div>
                )}
              </div>
              <div className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
                <CardTitle>Streak</CardTitle>
                <div className="mt-2 text-2xl font-bold" style={{ color: 'var(--ink)' }}>
                  {stats.longestStreakDays} day{stats.longestStreakDays === 1 ? '' : 's'}
                </div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  Loved: {stats.totals.loved} · Peak: {stats.peakHour != null ? formatHour(stats.peakHour) : '—'}
                </div>
              </div>
            </section>

            {/* Top artists */}
            <section className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
              <CardTitle>Top artists</CardTitle>
              <ol className="mt-3 flex flex-col gap-2">
                {stats.topArtists.slice(0, 6).map((a, i) => (
                  <li key={a.artist} className="flex items-baseline gap-3">
                    <span className="w-6 text-right font-bold" style={{ color: 'var(--accent)' }}>
                      {i + 1}
                    </span>
                    <span className="flex-1 truncate" style={{ color: 'var(--ink)' }}>
                      <ArtistLink artist={a.artist} color="inherit" />
                    </span>
                    <span style={{ color: 'var(--muted)' }}>{a.plays}</span>
                  </li>
                ))}
              </ol>
            </section>

            {/* Genres */}
            <section className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
              <CardTitle>Genres</CardTitle>
              <div className="mt-3 flex flex-col gap-2">
                {stats.genres.length === 0 && <span style={{ color: 'var(--muted)' }}>No genre tags</span>}
                {stats.genres.map((g) => (
                  <div key={g.genre} className="flex items-center gap-2">
                    <span className="w-24 truncate text-xs" style={{ color: 'var(--ink)' }}>
                      {g.genre}
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded" style={{ background: 'var(--line)' }}>
                      <span
                        className="block h-full rounded"
                        style={{ width: `${(g.plays / genreMax) * 100}%`, background: 'var(--accent)' }}
                      />
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* Listening clock */}
            <section className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
              <CardTitle>Listening clock</CardTitle>
              <div className="mt-4 flex h-24 items-end gap-[2px]">
                {stats.listeningClock.map((count, hour) => (
                  <span
                    key={hour}
                    title={`${formatHour(hour)}: ${count}`}
                    className="flex-1 rounded-t"
                    style={{
                      height: `${Math.max(2, (count / clockMax) * 100)}%`,
                      background: hour === stats.peakHour ? 'var(--accent)' : 'var(--line)',
                    }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px]" style={{ color: 'var(--muted)' }}>
                <span>12a</span>
                <span>6a</span>
                <span>12p</span>
                <span>6p</span>
                <span>11p</span>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="text-[12px] font-bold tracking-[0.18em]" style={{ color: 'var(--accent)' }}>
      {String(children).toUpperCase()}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-2xl font-extrabold" style={{ color: 'var(--ink)' }}>
        {value}
      </div>
      <div className="text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded" style={{ background: 'var(--line)' }}>
        <span className="block h-full rounded" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, background: 'var(--accent)' }} />
      </span>
    </div>
  );
}
