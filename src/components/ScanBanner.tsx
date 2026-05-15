import { useEffect, useState } from 'react';
import type { ScanProgress } from '@shared/types';
import { api } from '../lib/api';

export function ScanBanner(): JSX.Element | null {
  const [progress, setProgress] = useState<ScanProgress | null>(null);

  useEffect(() => {
    const off = api.onScanProgress((p) => setProgress(p));
    return off;
  }, []);

  useEffect(() => {
    if (progress?.done) {
      const t = setTimeout(() => setProgress(null), 3500);
      return () => clearTimeout(t);
    }
  }, [progress?.done]);

  // Empty-library state is now owned by the EmptyLibrary hero view; the
  // banner only surfaces active scan progress.
  if (!progress) return null;

  const pct = progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;
  const workSummary = scanWorkSummary(progress);
  return (
    <div
      className="flex items-center gap-3 px-3 py-1 text-[11px]"
      style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--line)' }}
    >
      {progress.done ? (
        <>
          <span style={{ color: 'var(--accent)' }}>● Scan complete</span>
          <span style={{ color: 'var(--ink-2)' }}>
            indexed {progress.total.toLocaleString()} files
          </span>
          {workSummary && (
            <span style={{ color: 'var(--muted)' }}>
              {workSummary}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="blink" style={{ color: 'var(--accent)' }}>● Scanning</span>
          <span style={{ color: 'var(--ink-2)' }}>
            {progress.scanned.toLocaleString()} / {progress.total.toLocaleString()} files
          </span>
          {workSummary && (
            <span style={{ color: 'var(--muted)' }}>
              {workSummary}
            </span>
          )}
          <div className="flex-1">
            <div
              style={{
                position: 'relative',
                height: 6,
                background: 'var(--panel-3)',
                borderRadius: 'var(--radius)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: 'var(--accent)',
                  boxShadow: '0 0 6px var(--accent-glow)',
                  transition: 'width 0.15s linear',
                }}
              />
            </div>
          </div>
          <span style={{ color: 'var(--muted)' }} className="truncate max-w-[420px]">
            {progress.current.replace(/\\/g, '/').split('/').slice(-2).join('/')}
          </span>
          <button className="pxbtn" onClick={() => void api.cancelScan()}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

function scanWorkSummary(progress: ScanProgress): string | null {
  const parsed = progress.parsed ?? 0;
  const skipped = progress.skipped ?? 0;
  if (!parsed && !skipped) return null;
  const parts = [];
  if (parsed) parts.push(`${parsed.toLocaleString()} parsed`);
  if (skipped) parts.push(`${skipped.toLocaleString()} skipped`);
  return parts.join(' | ');
}
