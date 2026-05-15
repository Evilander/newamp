import { useEffect, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { Transport } from './components/Transport';
import { EqPanel } from './components/EqPanel';
import { HomeView } from './components/views/HomeView';
import { LibraryView } from './components/views/LibraryView';
import { FoldersView } from './components/views/FoldersView';
import { MixesView } from './components/views/MixesView';
import { AlbumsView } from './components/views/AlbumsView';
import { ArtistsView } from './components/views/ArtistsView';
import { NowPlayingView } from './components/views/NowPlayingView';
import { LovedView } from './components/views/LovedView';
import { HistoryView } from './components/views/HistoryView';
import { PlaylistView } from './components/views/PlaylistView';
import { RadioView } from './components/views/RadioView';
import { PodcastView } from './components/views/PodcastView';
import { SettingsView } from './components/views/SettingsView';
import { FullscreenVisualizer } from './components/FullscreenVisualizer';
import { ScanBanner } from './components/ScanBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CompactPlayer } from './components/CompactPlayer';
import { QuickPlayPalette } from './components/QuickPlayPalette';
import { usePlayerStore } from './store/usePlayerStore';
import { api, winctl } from './lib/api';

export default function App(): JSX.Element {
  const init = usePlayerStore((s) => s.init);
  const view = usePlayerStore((s) => s.view);
  const showEq = usePlayerStore((s) => s.showEq);
  const fullscreen = usePlayerStore((s) => s.fullscreenViz);
  const compact = usePlayerStore((s) => s.compactMode);
  const [dropActive, setDropActive] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);

  async function handleOpenFiles(paths: string[]) {
    if (!paths.length) return null;
    try {
      const result = await api.openFiles(paths);
      if (!result.tracks.length) return result;
      const store = usePlayerStore.getState();
      store.setView('now-playing');
      await store.playQueue(result.tracks, 0);
      return result;
    } catch (err) {
      console.error('open files failed', err);
      return null;
    }
  }

  async function handleDroppedFiles(dataTransfer: DataTransfer): Promise<void> {
    const paths = api.getDroppedFilePaths(Array.from(dataTransfer.files));
    if (!paths.length) {
      setDropMessage('Drop music files, playlists, or folders from Windows Explorer.');
      return;
    }

    const skinPaths = paths.filter(isDroppedSkinFile);
    const mediaPaths = paths.filter((path) => !isDroppedSkinFile(path));
    const appliedSkins: string[] = [];

    if (skinPaths.length) {
      setDropMessage(`Applying ${skinPaths.length.toLocaleString()} dropped skin${skinPaths.length === 1 ? '' : 's'}...`);
      const store = usePlayerStore.getState();
      for (const skinPath of skinPaths) {
        try {
          const skin = await api.importCustomSkinFile(skinPath);
          if (!skin) continue;
          await store.saveCustomSkin(skin);
          appliedSkins.push(skin.name);
        } catch (err) {
          console.error('skin import failed', err);
        }
      }
    }

    if (!mediaPaths.length) {
      setDropMessage(appliedSkins.length
        ? `Applied skin ${appliedSkins[appliedSkins.length - 1]}.`
        : 'Could not apply the dropped skin.');
      window.setTimeout(() => setDropMessage(null), 3600);
      return;
    }

    setDropMessage(`Opening ${mediaPaths.length.toLocaleString()} dropped item${mediaPaths.length === 1 ? '' : 's'}...`);
    const result = await handleOpenFiles(mediaPaths);
    const skinSuffix = appliedSkins.length ? ` Applied skin ${appliedSkins[appliedSkins.length - 1]}.` : '';
    if (!result) {
      setDropMessage('Could not open the dropped items.');
    } else if (result.tracks.length) {
      setDropMessage(`Playing ${result.tracks.length.toLocaleString()} track${result.tracks.length === 1 ? '' : 's'}.${skinSuffix}`);
    } else if (result.importedPlaylists.length) {
      usePlayerStore.getState().setView('playlist');
      setDropMessage(`Imported ${result.importedPlaylists.length.toLocaleString()} playlist${result.importedPlaylists.length === 1 ? '' : 's'}.${skinSuffix}`);
    } else {
      setDropMessage(appliedSkins.length ? `Applied skin ${appliedSkins[appliedSkins.length - 1]}.` : 'No playable audio was found in the dropped items.');
    }
    window.setTimeout(() => setDropMessage(null), 3600);
  }

  useEffect(() => {
    let cancelled = false;

    const offOpenFiles = api.onOpenFiles((paths) => {
      void handleOpenFiles(paths);
    });

    init()
      .then(async () => {
        const pending = await api.consumePendingOpenFiles();
        if (!cancelled) await handleOpenFiles(pending);
      })
      .catch((err) => console.error('init failed', err));

    // Global keyboard shortcuts
    function onKey(e: KeyboardEvent): void {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const store = usePlayerStore.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        store.togglePlay();
      } else if (e.code === 'ArrowRight' && e.ctrlKey) {
        void store.next();
      } else if (e.code === 'ArrowLeft' && e.ctrlKey) {
        void store.prev();
      } else if (e.key === 'f' || e.key === 'F') {
        if (e.target && (e.target as HTMLElement).closest('input,textarea')) return;
        store.setFullscreenViz(!store.fullscreenViz);
      } else if (e.key === 'Escape' && store.fullscreenViz) {
        store.setFullscreenViz(false);
      }
    }
    window.addEventListener('keydown', onKey);
    const offPlayerCommand = api.onPlayerCommand((command) => {
      const store = usePlayerStore.getState();
      if (command === 'toggle-play') store.togglePlay();
      else if (command === 'next') void store.next();
      else if (command === 'previous') void store.prev();
      else if (command === 'stop') store.engine.stop();
    });
    const persistOnExit = (): void => {
      void usePlayerStore.getState().persistPlaybackSession();
    };
    window.addEventListener('beforeunload', persistOnExit);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', persistOnExit);
      offOpenFiles();
      offPlayerCommand();
    };
  }, [init]);

  useEffect(() => {
    void winctl.setCompact(compact);
  }, [compact]);

  if (compact) {
    return (
      <>
        <CompactPlayer />
        {fullscreen && <FullscreenVisualizer />}
        <QuickPlayPalette />
      </>
    );
  }

  return (
    <div
      data-newamp-drop-zone
      className="app-chrome relative flex h-full w-full flex-col"
      onDragEnter={(e) => {
        if (!hasDraggedFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDropActive(true);
      }}
      onDragOver={(e) => {
        if (!hasDraggedFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={(e) => {
        if (!hasDraggedFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDropActive(false);
        void handleDroppedFiles(e.dataTransfer);
      }}
    >
      <TitleBar />
      <ScanBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="relative flex-1 overflow-hidden bg-[var(--bg)]">
          <ErrorBoundary>
            {view === 'home' && <HomeView />}
            {view === 'library' && <LibraryView />}
            {view === 'folders' && <FoldersView />}
            {view === 'mixes' && <MixesView />}
            {view === 'albums' && <AlbumsView />}
            {view === 'artists' && <ArtistsView />}
            {view === 'loved' && <LovedView />}
            {view === 'history' && <HistoryView />}
            {view === 'playlist' && <PlaylistView />}
            {view === 'now-playing' && <NowPlayingView />}
            {view === 'podcasts' && <PodcastView />}
            {view === 'radio' && <RadioView />}
            {view === 'settings' && <SettingsView />}
          </ErrorBoundary>
        </main>
      </div>
      {showEq && <EqPanel />}
      <Transport />
      {fullscreen && <FullscreenVisualizer />}
      {(dropActive || dropMessage) && <AppDropOverlay message={dropMessage} active={dropActive} />}
      <QuickPlayPalette />
    </div>
  );
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

function isDroppedSkinFile(path: string): boolean {
  return /\.(newampskin\.json|wsz|zip)$/i.test(path);
}

function AppDropOverlay({ active, message }: { active: boolean; message: string | null }): JSX.Element {
  return (
    <div
      data-newamp-app-drop-overlay
      data-newamp-app-drop-active={active ? 'true' : 'false'}
      className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center"
      style={{
        border: '1px dashed var(--accent)',
        background: active ? 'rgba(0,0,0,0.74)' : 'rgba(0,0,0,0.58)',
        boxShadow: '0 0 28px var(--accent-glow)',
      }}
    >
      <div className="lcd-text text-[18px]">
        {message ?? 'Drop music, playlists, folders, or skins'}
      </div>
    </div>
  );
}
