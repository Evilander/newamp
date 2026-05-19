import type { ReactNode } from 'react';
export { playbackCodecLabel } from '@shared/audio-quality';

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function highlight(text: string, query: string): ReactNode {
  if (!query || !text) return text;
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <>
      {before}
      <span style={{ color: 'var(--accent)' }}>{match}</span>
      {after}
    </>
  );
}
