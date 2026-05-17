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
import { FirstRunHints } from './components/FirstRunHints';
import { StartupSplash } from './components/StartupSplash';
import { usePlayerStore } from './store/usePlayerStore';
import { api, winctl } from './lib/api';
import { syncMediaSession } from './lib/mediaSession';
import { resolvePlayerShortcut, type PlayerShortcutCommand } from '@shared/keyboard-shortcuts';
import { applyShell, loadInitialShell } from './components/ShellPicker';

export default function App(): JSX.Element {
  const init = usePlayerStore((s) => s.init);
  const view = usePlayerStore((s) => s.view);
  const showEq = usePlayerStore((s) => s.showEq);
  const fullscreen = usePlayerStore((s) => s.fullscreenViz);
  const compact = usePlayerStore((s) => s.compactMode);
  const alwaysOnTop = usePlayerStore((s) => s.alwaysOnTop);
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const [dropActive, setDropActive] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [showSplash, setShowSplash] = useState(true);

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
    // Apply the persisted shell on mount so CSS data-shell attribute is set
    // before the first paint. Subsequent changes happen via ShellPicker.
    applyShell(loadInitialShell());
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setShowSplash(false), 1450);
    return () => window.clearTimeout(handle);
  }, []);

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

    function onKey(e: KeyboardEvent): void {
      const store = usePlayerStore.getState();
      const command = resolvePlayerShortcut({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        targetEditable: isEditableShortcutTarget(e.target),
        fullscreenVisualizer: store.fullscreenViz,
      });
      if (!command) return;
      e.preventDefault();
      runPlayerShortcut(command, store);
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

  useEffect(() => {
    void winctl.setAlwaysOnTop(compact || alwaysOnTop);
  }, [compact, alwaysOnTop]);

  useEffect(() => {
    syncMediaSession({
      current,
      isPlaying,
      currentTime,
      duration,
      playbackRate,
      actions: {
        play: () => usePlayerStore.getState().togglePlay(),
        pause: () => usePlayerStore.getState().engine.pause(),
        previous: () => void usePlayerStore.getState().prev(),
        next: () => void usePlayerStore.getState().next(),
        stop: () => usePlayerStore.getState().engine.stop(),
        seek: (position) => usePlayerStore.getState().seek(position),
      },
    });
  }, [current, isPlaying, currentTime, duration, playbackRate]);

  if (compact) {
    return (
      <>
        <CompactPlayer />
        <QuickPlayPalette />
        {showSplash && <StartupSplash />}
      </>
    );
  }

  return (
    <>
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
        {(dropActive || dropMessage) && <AppDropOverlay message={dropMessage} active={dropActive} />}
        <QuickPlayPalette />
        <FirstRunHints />
      </div>
      {fullscreen && <FullscreenVisualizer />}
      {showSplash && <StartupSplash />}
    </>
  );
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

function isDroppedSkinFile(path: string): boolean {
  return /\.(newampskin\.json|wsz|zip)$/i.test(path);
}

type PlayerStoreSnapshot = ReturnType<typeof usePlayerStore.getState>;

function runPlayerShortcut(command: PlayerShortcutCommand, store: PlayerStoreSnapshot): void {
  if (command === 'toggle-play') {
    store.togglePlay();
  } else if (command === 'play') {
    if (!store.isPlaying) store.togglePlay();
  } else if (command === 'pause') {
    store.engine.pause();
  } else if (command === 'stop') {
    store.engine.stop();
  } else if (command === 'previous') {
    void store.prev();
  } else if (command === 'next') {
    void store.next();
  } else if (command === 'seek-backward') {
    store.seek(clampShortcutNumber(store.currentTime - 5, 0, store.duration || 0));
  } else if (command === 'seek-forward') {
    store.seek(clampShortcutNumber(store.currentTime + 5, 0, store.duration || store.currentTime + 5));
  } else if (command === 'volume-up') {
    void store.setVolume(clampShortcutNumber(store.volume + 0.05, 0, 2));
  } else if (command === 'volume-down') {
    void store.setVolume(clampShortcutNumber(store.volume - 0.05, 0, 2));
  } else if (command === 'toggle-love') {
    if (store.current?.id && store.current.id > 0) void store.toggleLove(store.current.id);
  } else if (command.startsWith('rate-')) {
    if (store.current?.id && store.current.id > 0) {
      void store.setTrackRating(store.current.id, Number(command.slice('rate-'.length)));
    }
  } else if (command === 'toggle-fullscreen-visualizer') {
    store.setFullscreenViz(!store.fullscreenViz);
  } else if (command === 'exit-fullscreen-visualizer') {
    store.setFullscreenViz(false);
  }
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
}

function clampShortcutNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
