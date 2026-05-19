import { usePlayerStore, type ViewMode } from '../store/usePlayerStore';

interface NavItem {
  id: ViewMode;
  label: string;
  icon: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Six functional groups instead of a 17-item flat list — the eye scans
// "EXPLORE" / "DISCOVERY" / "YOURS" much faster than reading 17 unrelated
// labels in a row, and related views (Albums + Artists + Folders) sit next
// to the parent Library entry instead of being scattered across the list.
const GROUPS: NavGroup[] = [
  {
    label: 'Main',
    items: [
      { id: 'home', label: 'Home', icon: 'M3 10l7-6 7 6v7H5v-5h10v5' },
      { id: 'library', label: 'Library', icon: 'M2 3h16v2H2zM2 7h16v2H2zM2 11h16v2H2zM2 15h16v2H2z' },
      { id: 'now-playing', label: 'Now Playing', icon: 'M10 14a4 4 0 100-8 4 4 0 000 8zm0-2a2 2 0 100-4 2 2 0 000 4z' },
    ],
  },
  {
    label: 'Explore',
    items: [
      { id: 'albums', label: 'Albums', icon: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z' },
      { id: 'artists', label: 'Artists', icon: 'M10 10a3 3 0 100-6 3 3 0 000 6zM4 17a6 6 0 0112 0H4z' },
      { id: 'folders', label: 'Folders', icon: 'M2 5h6l2 2h8v9H2zM4 9h12' },
    ],
  },
  {
    label: 'Discovery',
    items: [
      { id: 'discover', label: 'Discover', icon: 'M10 2l2 5 5 2-5 2-2 5-2-5-5-2 5-2z' },
      { id: 'mixes', label: 'Mixes', icon: 'M3 5h4l3 10h2l3-10h4M4 15h4M12 15h4' },
      { id: 'tags', label: 'Living Tags', icon: 'M3 9l7-7 8 8-7 7zM14 5a1 1 0 100 2 1 1 0 000-2z' },
      { id: 'atlas', label: 'Sonic Atlas', icon: 'M3 3l5 3 4-2 5 2v12l-5-2-4 2-5-2zm5 3v11M12 4v12' },
    ],
  },
  {
    label: 'Yours',
    items: [
      { id: 'loved', label: 'Loved', icon: 'M10 17l-6.5-6.5a4 4 0 015.66-5.66L10 6l.84-1.16a4 4 0 015.66 5.66L10 17z' },
      { id: 'history', label: 'History', icon: 'M10 3a7 7 0 107 7M10 6v5l4 2M10 3v4M7 3h6' },
      { id: 'playlist', label: 'Playlists', icon: 'M3 4h14M3 9h14M3 14h9M14 14l3 3M17 14l-3 3' },
    ],
  },
  {
    label: 'Streaming',
    items: [
      { id: 'podcasts', label: 'Podcasts', icon: 'M5 15v-3a5 5 0 0110 0v3M8 15v-3a2 2 0 114 0v3M10 4v3M6 5l2 2M14 5l-2 2' },
      { id: 'radio', label: 'Radio', icon: 'M2 8h16v9H2zM2 8L14 4v4M5 13h2M9 13h2' },
    ],
  },
  {
    label: 'App',
    items: [
      { id: 'about', label: 'About', icon: 'M10 3a7 7 0 100 14 7 7 0 000-14zM10 8v6M10 6h.01' },
      { id: 'settings', label: 'Settings', icon: 'M10 3v3M10 14v3M3 10h3M14 10h3M5 5l2 2M13 13l2 2M5 15l2-2M13 7l2-2M10 7a3 3 0 100 6 3 3 0 000-6z' },
    ],
  },
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
      className="flex w-[200px] flex-col border-r"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
    >
      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {GROUPS.map((group, groupIdx) => (
          <div key={group.label} className={groupIdx === 0 ? '' : 'mt-2'}>
            <div className="mb-0.5 px-2 text-[9px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
              {group.label}
            </div>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => setView(item.id)}
                title={item.label}
              >
                <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
                  <path d={item.icon} stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="square" />
                </svg>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div
        className="shrink-0 border-t px-3 py-3"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
      >
        <div className="mb-2 px-2 text-[9px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
          Tools
        </div>
        <div className="mb-2 flex gap-1 px-2">
          <button
            className={`pxbtn flex-1 ${showEq ? 'is-active' : ''}`}
            onClick={toggleEq}
            title="Toggle equalizer"
          >
            EQ
          </button>
          <button
            className="pxbtn flex-1"
            onClick={() => setFs(true)}
            title="Fullscreen visualizer (F)"
            data-newamp-open-visualizer
          >
            VIZ
          </button>
          <button className="pxbtn flex-1" onClick={() => setCompactMode(true)} title="Compact deck window">
            DECK
          </button>
        </div>
        <div className="px-2 text-[9px]" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
          <kbd className="kbd-hint">Space</kbd>play / pause
          <span className="ml-2"><kbd className="kbd-hint">F</kbd>viz</span>
          <span className="ml-2"><kbd className="kbd-hint">Esc</kbd>exit</span>
          <br />
          <kbd className="kbd-hint">Ctrl K</kbd>quick play
        </div>
      </div>
    </aside>
  );
}
