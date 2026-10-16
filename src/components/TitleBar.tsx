import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { api, winctl } from '../lib/api';
import { ArtistLink } from './EntityLink';
import { BrandLogo } from './BrandLogo';

// "Load your library" is only true when there are no folders and no tracks.
// Anything not known yet reads as the neutral line rather than a wrong one.
function idleTitle(libraryRoots: number | null, trackCount: number | null): string {
  return libraryRoots === 0 && trackCount === 0 ? 'Ready. Load your library.' : 'Nothing playing';
}

export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const [trackCount, setTrackCount] = useState<number | null>(null);
  const libraryRoots = usePlayerStore((s) => s.settings?.libraryRoots?.length ?? null);
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const alwaysOnTop = usePlayerStore((s) => s.alwaysOnTop);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const setAlwaysOnTop = usePlayerStore((s) => s.setAlwaysOnTop);

  useEffect(() => winctl.onState((s) => setMaximized(s.maximized)), []);

  // Saved folders settle it. Without any, tracks can still be there (the empty
  // library screen scans a folder without touching the store's settings), so
  // ask the library, and again when a scan finishes.
  const noFolders = libraryRoots === 0;
  useEffect(() => {
    if (!noFolders) return undefined;
    let cancelled = false;
    const refresh = () => {
      api
        .getStats()
        .then((stats) => {
          if (!cancelled) setTrackCount(stats.tracks);
        })
        .catch(() => undefined);
    };
    refresh();
    const off = api.onScanProgress((p) => {
      if (p.done) refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [noFolders]);

  const isMac = api.platform === 'darwin';

  return (
    <header
      className="titlebar-drag relative flex h-10 items-center justify-between px-2 text-xs"
      style={{ background: 'var(--titlebar)' }}
      data-newamp-hint-anchor="titlebar"
    >
      <div
        className="titlebar-nodrag flex items-center gap-2"
        style={isMac ? { paddingLeft: 72 } : undefined}
      >
        <BrandLogo size={28} title="NewAmp" />
        <span
          className="lcd-text titlebar-text font-bold tracking-[0.3em]"
          style={{ fontFamily: 'var(--font-display)', fontSize: 11 }}
        >
          NEWAMP
        </span>
        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
          v{api.appVersion}
        </span>
      </div>

      <div className="pointer-events-none absolute left-1/2 top-0 flex h-full -translate-x-1/2 items-center gap-2">
        {isPlaying && (
          <span className="eq-bars" data-amp>
            <span />
            <span />
            <span />
            <span />
          </span>
        )}
        <span
          className="lcd-text titlebar-text max-w-[460px] truncate text-center text-[14px]"
          title={current ? `${current.artist} - ${current.title}` : ''}
        >
          {current ? (
            <>
              {/* pointer-events restored just for the link — the rest of the
                  marquee stays click-through so window dragging keeps its
                  full hit area. */}
              <span className="titlebar-nodrag pointer-events-auto">
                <ArtistLink artist={current.artist} color="inherit" />
              </span>
              {` - ${current.title}`}
            </>
          ) : (
            idleTitle(libraryRoots, trackCount)
          )}
        </span>
      </div>

      <div className="titlebar-nodrag flex items-center gap-1">
        <button
          className={`pxbtn !min-w-[36px] ${alwaysOnTop ? 'is-active' : ''}`}
          onClick={() => setAlwaysOnTop(!alwaysOnTop)}
          aria-label="Pin window on top"
          aria-pressed={alwaysOnTop}
          title={alwaysOnTop ? 'Unpin window' : 'Pin window on top'}
        >
          PIN
        </button>
        <button
          className="pxbtn !min-w-[48px]"
          onClick={() => setCompactMode(true)}
          aria-label="Compact deck"
          title="Compact deck"
          data-newamp-hint-anchor="deck"
        >
          DECK
        </button>
        {!isMac && (
          <>
            <button
              className="pxbtn !min-w-[32px]"
              onClick={() => void winctl.minimize()}
              aria-label="Minimize"
              title="Minimize"
            >
              _
            </button>
            <button
              className="pxbtn !min-w-[32px]"
              onClick={() => void winctl.toggleMax()}
              aria-label="Toggle maximize"
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? 'RST' : 'MAX'}
            </button>
            <button
              className="pxbtn !min-w-[32px]"
              onClick={() => void winctl.close()}
              aria-label="Close"
              title="Close"
              style={{ color: 'var(--error-text)' }}
            >
              X
            </button>
          </>
        )}
      </div>
    </header>
  );
}
