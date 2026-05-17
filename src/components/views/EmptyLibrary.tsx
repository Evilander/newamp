import { useEffect, useState } from 'react';
import { api, inElectron } from '../../lib/api';
import { BrandLogo } from '../BrandLogo';
import type { MusicFolderSuggestion } from '@shared/types';

export function EmptyLibrary(): JSX.Element {
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<MusicFolderSuggestion[]>([]);

  // Detected music folders are loaded once on mount. They give the user a one-
  // click way to scan a likely-correct folder (e.g. K:/music, OneDrive/Music)
  // without having to find it themselves.
  useEffect(() => {
    let cancelled = false;
    api
      .getSuggestedMusicFolders()
      .then((rows) => {
        if (!cancelled) setSuggestions(rows);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function scanSuggestedFolder(path: string): Promise<void> {
    setScanning(true);
    setStatus(`Scanning ${path}...`);
    try {
      const settings = await api.getSettings();
      const roots = mergeRoots(settings.libraryRoots, path);
      await api.setSettings({ libraryRoots: roots });
      await api.scanLibrary([path]);
      setStatus('Scan started. NewAmp will fill in as files are indexed.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Folder scan failed.');
    } finally {
      setScanning(false);
    }
  }

  async function scanDefault(): Promise<void> {
    setScanning(true);
    setStatus('Scanning default music folder...');
    try {
      await api.scanLibrary();
      setStatus('Scan started. NewAmp will fill in as files are indexed.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Default scan failed.');
    } finally {
      setScanning(false);
    }
  }

  async function pickFolder(): Promise<void> {
    if (!inElectron) {
      // eslint-disable-next-line no-alert
      alert('Open NewAmp in Electron to pick a local folder.');
      return;
    }
    const dir = await api.pickFolder();
    if (!dir) return;
    setScanning(true);
    setStatus(`Scanning ${dir}...`);
    try {
      const settings = await api.getSettings();
      const roots = mergeRoots(settings.libraryRoots, dir);
      await api.setSettings({ libraryRoots: roots });
      await api.scanLibrary([dir]);
      setStatus('Scan started. You can keep using NewAmp while it indexes.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Folder scan failed.');
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="empty-library-hero">
      <div className="empty-library-glow" aria-hidden="true" />
      <div className="empty-library-panel">
        <BrandLogo size={80} withGlow />
        <div className="empty-library-copy">
          <h2>Your music. Your machine.</h2>
          <p>NewAmp scans local folders, builds a private library, and keeps playback off-cloud by default.</p>
        </div>
        <div className="empty-library-actions">
          <button className="pxbtn is-active empty-library-primary" onClick={() => void scanDefault()} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan Default Music Folder'}
          </button>
          <button className="empty-library-link" onClick={() => void pickFolder()} disabled={scanning}>
            or pick a folder...
          </button>
        </div>
        {status ? <div className="empty-library-status">{status}</div> : null}
        {suggestions.length ? (
          <div className="empty-library-suggestions">
            <span className="empty-library-suggestions-label">We also found:</span>
            <div className="empty-library-suggestions-list">
              {suggestions.slice(0, 3).map((suggestion) => (
                <button
                  key={suggestion.path}
                  type="button"
                  data-music-folder-suggestion={suggestion.path}
                  className="empty-library-suggestion"
                  onClick={() => void scanSuggestedFolder(suggestion.path)}
                  disabled={scanning}
                  title={suggestion.reason}
                >
                  <span className="empty-library-suggestion-label">{suggestion.label}</span>
                  <span className="empty-library-suggestion-path">{suggestion.path}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
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
