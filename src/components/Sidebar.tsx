import { usePlayerStore, type ViewMode } from '../store/usePlayerStore';

interface NavItem {
  id: ViewMode;
  label: string;
  icon: string;
}

const ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'M3 10l7-6 7 6v7H5v-5h10v5' },
  { id: 'library', label: 'Library', icon: 'M2 3h16v2H2zM2 7h16v2H2zM2 11h16v2H2zM2 15h16v2H2z' },
  { id: 'folders', label: 'Folders', icon: 'M2 5h6l2 2h8v9H2zM4 9h12' },
  { id: 'mixes', label: 'Mixes', icon: 'M3 5h4l3 10h2l3-10h4M4 15h4M12 15h4' },
  { id: 'albums', label: 'Albums', icon: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z' },
  { id: 'artists', label: 'Artists', icon: 'M10 10a3 3 0 100-6 3 3 0 000 6zM4 17a6 6 0 0112 0H4z' },
  { id: 'loved', label: 'Loved', icon: 'M10 17l-6.5-6.5a4 4 0 015.66-5.66L10 6l.84-1.16a4 4 0 015.66 5.66L10 17z' },
  { id: 'history', label: 'History', icon: 'M10 3a7 7 0 107 7M10 6v5l4 2M10 3v4M7 3h6' },
  { id: 'playlist', label: 'Playlists', icon: 'M3 4h14M3 9h14M3 14h9M14 14l3 3M17 14l-3 3' },
  { id: 'now-playing', label: 'Now Playing', icon: 'M10 14a4 4 0 100-8 4 4 0 000 8zm0-2a2 2 0 100-4 2 2 0 000 4z' },
  { id: 'podcasts', label: 'Podcasts', icon: 'M5 15v-3a5 5 0 0110 0v3M8 15v-3a2 2 0 114 0v3M10 4v3M6 5l2 2M14 5l-2 2' },
  { id: 'radio', label: 'Radio', icon: 'M2 8h16v9H2zM2 8L14 4v4M5 13h2M9 13h2' },
  { id: 'settings', label: 'Settings', icon: 'M10 3v3M10 14v3M3 10h3M14 10h3M5 5l2 2M13 13l2 2M5 15l2-2M13 7l2-2M10 7a3 3 0 100 6 3 3 0 000-6z' },
];

export function Sidebar(): JSX.Element {
  const view = usePlayerStore((s) => s.view);
  const setView = usePlayerStore((s) => s.setView);
  const setFs = usePlayerStore((s) => s.setFullscreenViz);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const toggleEq = usePlayerStore((s) => s.toggleEq);
  const showEq = usePlayerStore((s) => s.showEq);

  return (
    <aside
      className="flex w-[200px] flex-col gap-1 border-r p-3"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
    >
      <div className="mb-2 px-2 text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--muted)' }}>
        Navigation
      </div>
      {ITEMS.map((item) => (
        <button
          key={item.id}
          className={`nav-item ${view === item.id ? 'active' : ''}`}
          onClick={() => setView(item.id)}
        >
          <svg width="14" height="14" viewBox="0 0 20 20">
            <path d={item.icon} stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="square" />
          </svg>
          <span>{item.label}</span>
        </button>
      ))}

      <div className="mt-auto flex flex-col gap-2 px-2 pt-3 text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--muted)' }}>
        <div>Tools</div>
        <div className="flex gap-1">
          <button className={`pxbtn ${showEq ? 'is-active' : ''}`} onClick={toggleEq} title="Toggle equalizer">
            EQ
          </button>
          <button className="pxbtn" onClick={() => setFs(true)} title="Fullscreen visualizer (F)">
            VIZ
          </button>
          <button className="pxbtn" onClick={() => setCompactMode(true)} title="Compact deck">
            DECK
          </button>
        </div>
        <div className="pt-1 text-[9px]" style={{ color: 'var(--muted)' }}>
          Space play / pause
          <br />
          F · fullscreen viz
          <br />
          Esc · exit viz
        </div>
      </div>
    </aside>
  );
}
