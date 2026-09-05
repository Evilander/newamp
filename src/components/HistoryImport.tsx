import { useEffect, useState } from 'react';
import type { HistoryImportReport, LastfmHistoryProgress } from '@shared/history-import';
import { api } from '../lib/api';

export function HistoryImport({ onImported, onBusy }: { onImported: () => void; onBusy: (busy: boolean) => void }): JSX.Element {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<LastfmHistoryProgress | null>(null);
  const [report, setReport] = useState<HistoryImportReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => api.onHistoryImportProgress(setProgress), []);

  async function run(source: 'file' | 'lastfm'): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setError('');
    setProgress(null);
    setReport(null);
    try {
      const imported = source === 'file' ? await api.importHistoryFile() : await api.importLastfmHistory(username.trim());
      if (imported) { setReport(imported); onImported(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'History import failed.');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <details className="border-b px-3 py-2 text-[12px]" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
      <summary className="cursor-pointer" style={{ color: 'var(--accent)' }}>Import listening history</summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <button className="pxbtn" disabled={busy} onClick={() => void run('file')}>Import CSV or JSON</button>
        <label className="grid gap-1">Last.fm username
          <input className="bevel-in px-2 py-1" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <button className="pxbtn" disabled={busy || !username.trim()} onClick={() => void run('lastfm')}>Import from Last.fm</button>
        {busy && <button className="pxbtn" onClick={() => void api.cancelHistoryImport().catch((err: Error) => setError(err.message))}>Cancel import</button>}
      </div>
      <p className="mt-2" style={{ color: 'var(--muted)' }}>
        Scan your music first. Imports match existing tracks and update History, Mixes, and listening stats. Reimporting skips duplicate plays.
        Last.fm uses the API key in Settings → Last.fm; scrobbling can stay off.
      </p>
      <p className="mt-1" style={{ color: 'var(--muted)' }}>
        Files need one row per play: artist, title, played_at, and optionally album or path. Dates can be Unix seconds, Unix milliseconds, or ISO timestamps with a timezone. Play-count totals alone cannot reconstruct a history.
      </p>
      {busy && <p className="mt-2" role="status">{progress ? `Fetching page ${progress.page}${progress.totalPages ? ` of ${progress.totalPages}` : ''} · ${progress.entries.toLocaleString()} plays read` : 'Reading history…'}</p>}
      {error && <p className="mt-2" role="alert" style={{ color: 'var(--error)' }}>{error}</p>}
      {report && <div className="mt-2" role="status">
        <p>{report.imported.toLocaleString()} imported · {report.duplicates.toLocaleString()} duplicates · {report.unmatched.toLocaleString()} unmatched · {report.ambiguous.toLocaleString()} ambiguous · {report.invalid.toLocaleString()} invalid</p>
        {[...report.unmatchedSamples, ...report.ambiguousSamples, ...report.invalidSamples].slice(0, 8).map((sample, i) => (
          <p key={i} className="mt-1" style={{ color: 'var(--muted)' }}>Row {sample.row}: {sample.artist} {sample.title} — {sample.reason}</p>
        ))}
      </div>}
    </details>
  );
}
