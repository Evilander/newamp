import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { api, winctl } from '../lib/api';
import { BrandLogo } from './BrandLogo';

export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const alwaysOnTop = usePlayerStore((s) => s.alwaysOnTop);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const setAlwaysOnTop = usePlayerStore((s) => s.setAlwaysOnTop);

  useEffect(() => winctl.onState((s) => setMaximized(s.maximized)), []);

  const isMac = api.platform === 'darwin';

  return (
    <header
      className="titlebar-drag relative flex h-10 items-center justify-between px-2 text-xs"
      style={{ background: 'var(--titlebar)' }}
    >
      <div
        className="titlebar-nodrag flex items-center gap-2"
        style={isMac ? { paddingLeft: 72 } : undefined}
      >
        <BrandLogo size={28} title="NewAmp" />
        <span
          className="lcd-text font-bold tracking-[0.3em]"
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
          <span className="eq-bars">
            <span />
            <span />
            <span />
            <span />
          </span>
        )}
        <span
          className="lcd-text max-w-[460px] truncate text-center text-[14px]"
          title={current ? `${current.artist} - ${current.title}` : ''}
        >
          {current
            ? `${current.artist} - ${current.title}`
            : 'Ready. Load your library.'}
        </span>
      </div>

      <div className="titlebar-nodrag flex items-center gap-1">
        <button
          className={`pxbtn !min-w-[36px] ${alwaysOnTop ? 'is-active' : ''}`}
          onClick={() => setAlwaysOnTop(!alwaysOnTop)}
          aria-label="Pin window on top"
          title={alwaysOnTop ? 'Unpin window' : 'Pin window on top'}
        >
          PIN
        </button>
        <button
          className="pxbtn !min-w-[48px]"
          onClick={() => setCompactMode(true)}
          aria-label="Compact deck"
          title="Compact deck"
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
              style={{ color: 'var(--error)' }}
            >
              X
            </button>
          </>
        )}
      </div>
    </header>
  );
}
