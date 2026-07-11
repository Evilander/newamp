import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { Transport } from './components/Transport';
import { ScanBanner } from './components/ScanBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { QuickPlayPalette } from './components/QuickPlayPalette';
import { FirstRunHints } from './components/FirstRunHints';
import { ToastHost } from './components/StatusToast';
import { StartupSplash } from './components/StartupSplash';
import { usePlayerStore } from './store/usePlayerStore';
import { api, inElectron, winctl } from './lib/api';
import { syncMediaSession } from './lib/mediaSession';
import { resolvePlayerShortcut, type PlayerShortcutCommand } from '@shared/keyboard-shortcuts';
import { applyShell, loadInitialShell } from './components/ShellPicker';
import { useAdaptiveQuality } from './lib/adaptiveQuality';
import { useReducedMotion } from './hooks/useReducedMotion';
import { startResonance, stopResonance, pokeResonance, type ResonanceOpts } from './lib/resonance';
import { startEvilandProducer } from './visualizer/eviland-producer';
import { projectorQualityTier } from './lib/vizPrefs';

const EqPanel = lazy(() => import('./components/EqPanel').then((module) => ({ default: module.EqPanel })));
const CompactPlayer = lazy(() => import('./components/CompactPlayer').then((module) => ({ default: module.CompactPlayer })));
const FullscreenVisualizer = lazy(() =>
  import('./components/FullscreenVisualizer').then((module) => ({ default: module.FullscreenVisualizer })),
);
const FirstLaunchTutorial = lazy(() =>
  import('./components/FirstLaunchTutorial').then((module) => ({ default: module.FirstLaunchTutorial })),
);
const HomeView = lazy(() => import('./components/views/HomeView').then((module) => ({ default: module.HomeView })));
const LibraryView = lazy(() => import('./components/views/LibraryView').then((module) => ({ default: module.LibraryView })));
const FoldersView = lazy(() => import('./components/views/FoldersView').then((module) => ({ default: module.FoldersView })));
const DiscoverView = lazy(() => import('./components/views/DiscoverView').then((module) => ({ default: module.DiscoverView })));
const MixesView = lazy(() => import('./components/views/MixesView').then((module) => ({ default: module.MixesView })));
const TagsView = lazy(() => import('./components/views/TagsView').then((module) => ({ default: module.TagsView })));
const AlbumsView = lazy(() => import('./components/views/AlbumsView').then((module) => ({ default: module.AlbumsView })));
const ArtistsView = lazy(() => import('./components/views/ArtistsView').then((module) => ({ default: module.ArtistsView })));
const NowPlayingView = lazy(() =>
  import('./components/views/NowPlayingView').then((module) => ({ default: module.NowPlayingView })),
);
const LovedView = lazy(() => import('./components/views/LovedView').then((module) => ({ default: module.LovedView })));
const HistoryView = lazy(() => import('./components/views/HistoryView').then((module) => ({ default: module.HistoryView })));
const WrappedView = lazy(() => import('./components/views/WrappedView').then((module) => ({ default: module.WrappedView })));
const ProfileView = lazy(() => import('./components/views/ProfileView').then((module) => ({ default: module.ProfileView })));
const PlaylistView = lazy(() =>
  import('./components/views/PlaylistView').then((module) => ({ default: module.PlaylistView })),
);
const RadioView = lazy(() => import('./components/views/RadioView').then((module) => ({ default: module.RadioView })));
const PodcastView = lazy(() => import('./components/views/PodcastView').then((module) => ({ default: module.PodcastView })));
const SettingsView = lazy(() =>
  import('./components/views/SettingsView').then((module) => ({ default: module.SettingsView })),
);
const AboutView = lazy(() => import('./components/views/AboutView').then((module) => ({ default: module.AboutView })));
const RENDERER_STARTUP_SPLASH_MS = 5600;

export default function App(): JSX.Element {
  const init = usePlayerStore((s) => s.init);
  const view = usePlayerStore((s) => s.view);
  const showEq = usePlayerStore((s) => s.showEq);
  const fullscreen = usePlayerStore((s) => s.fullscreenViz);
  const compact = usePlayerStore((s) => s.compactMode);
  const alwaysOnTop = usePlayerStore((s) => s.alwaysOnTop);
  const settings = usePlayerStore((s) => s.settings);
  const setView = usePlayerStore((s) => s.setView);
  const [dropActive, setDropActive] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [showSplash, setShowSplash] = useState(() => !inElectron);
  const [tutorialDismissed, setTutorialDismissed] = useState(false);

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
    if (!showSplash) return undefined;
    const handle = window.setTimeout(() => setShowSplash(false), RENDERER_STARTUP_SPLASH_MS);
    return () => window.clearTimeout(handle);
  }, [showSplash]);

  useEffect(() => {
    const scale = Math.min(1.35, Math.max(0.85, settings?.textScale ?? 1));
    document.documentElement.style.setProperty('--newamp-text-scale', scale.toFixed(2));
    document.documentElement.dataset.textScale = scale === 1 ? 'normal' : 'custom';
  }, [settings?.textScale]);

  // Resonance: feed the adaptive tier + ambient setting + reduced-motion into
  // the live audio→CSS-var loop. `data-amp-reactive` is the CSS opt-in gate.
  const ambientReactivity = settings?.ambientReactivity ?? 'auto';
  const performanceSetting = settings?.performanceTier ?? 'auto';
  const adaptiveTier = useAdaptiveQuality(performanceSetting);
  const reducedMotion = useReducedMotion();
  const resonanceOptsRef = useRef<ResonanceOpts>({ tier: 'medium', reactive: true, reducedMotion: false });
  useEffect(() => {
    const reactive =
      ambientReactivity === 'on' ? true : ambientReactivity === 'off' ? false : adaptiveTier !== 'low';
    const live = reactive && !reducedMotion && adaptiveTier !== 'low';
    resonanceOptsRef.current = { tier: adaptiveTier, reactive, reducedMotion };
    document.documentElement.dataset.ampReactive = live ? 'on' : 'off';
    pokeResonance();
  }, [adaptiveTier, ambientReactivity, reducedMotion]);
  useEffect(() => {
    startResonance(() => resonanceOptsRef.current);
    return () => stopResonance();
  }, []);

  // Headless Eviland producer: feeds the detached/projector window with frames
  // whenever it is open, independent of the on-screen visualizer. Lets the user
  // pop Eviland onto a 2nd monitor and keep navigating NewAmp. Idle cost is zero
  // until a projector window attaches.
  useEffect(() => {
    return startEvilandProducer(usePlayerStore.getState().engine, () => {
      const s = usePlayerStore.getState();
      // Transport snapshot is piggy-backed onto the 30Hz frame publish so the
      // detached projector can render a live control bar (track title, scrub,
      // play/pause) without round-tripping the main process for state.
      const transport = s.current
        ? {
            title: s.current.title ?? null,
            artist: s.current.artist ?? null,
            album: s.current.album ?? null,
            currentTime: s.currentTime,
            duration: s.duration,
            isPlaying: s.isPlaying,
            volume: s.volume,
          }
        : null;
      return {
        director: s.evilandDirector,
        seed: s.evilandSeed,
        nonce: s.evilandConfigNonce,
        waveMode: s.evilandWaveMode,
        trackId: s.current?.id ?? null,
        projectorQuality: projectorQualityTier(),
        transport,
      };
    });
  }, []);

  async function finishFirstLaunchTutorial(patch: { openaiApiKey?: string | null; openaiModel?: string } = {}): Promise<void> {
    const updated = await api.setSettings({
      firstLaunchTutorialSeen: true,
      ...patch,
    });
    usePlayerStore.setState({ settings: updated });
    setTutorialDismissed(true);
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

    function onKey(e: KeyboardEvent): void {
      const store = usePlayerStore.getState();
      const command = resolvePlayerShortcut({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
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
    // Detached projector → main renderer. The projector window has no engine
    // of its own; its floating control bar invokes transport commands here.
    const detachedBridge = typeof window !== 'undefined' ? window.detachedViz : undefined;
    const offTransportCommand = detachedBridge?.onTransportCommand
      ? detachedBridge.onTransportCommand((cmd, arg) => {
          const store = usePlayerStore.getState();
          if (cmd === 'togglePlay') store.togglePlay();
          else if (cmd === 'next') void store.next();
          else if (cmd === 'prev') void store.prev();
          else if (cmd === 'seek' && Number.isFinite(arg)) store.seek(Math.max(0, arg ?? 0));
          else if (cmd === 'setVolume' && Number.isFinite(arg)) void store.setVolume(Math.max(0, Math.min(2, arg ?? 0)));
        })
      : () => undefined;
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
      offTransportCommand();
    };
  }, [init]);

  useEffect(() => {
    void winctl.setCompact(compact);
  }, [compact]);

  useEffect(() => {
    void winctl.setAlwaysOnTop(compact || alwaysOnTop);
  }, [compact, alwaysOnTop]);

  if (compact) {
    return (
      <>
        <MediaSessionSync />
        <Suspense fallback={<DeckFallback />}>
          <CompactPlayer />
        </Suspense>
        <QuickPlayPalette />
        <ToastHost />
        {showSplash && <StartupSplash />}
      </>
    );
  }

  return (
    <>
      <MediaSessionSync />
      <div
        data-newamp-drop-zone
        aria-hidden={fullscreen || undefined}
        className="app-chrome relative flex h-full w-full flex-col"
        style={{ visibility: fullscreen ? 'hidden' : 'visible' }}
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
              <Suspense fallback={<ViewFallback />}>
                {view === 'home' && <HomeView />}
                {view === 'library' && <LibraryView />}
                {view === 'folders' && <FoldersView />}
                {view === 'discover' && <DiscoverView />}
                {view === 'tags' && <TagsView />}
                {view === 'mixes' && <MixesView />}
                {view === 'albums' && <AlbumsView />}
                {view === 'artists' && <ArtistsView />}
                {view === 'loved' && <LovedView />}
                {view === 'history' && <HistoryView />}
                {view === 'wrapped' && <WrappedView />}
                {view === 'profile' && <ProfileView />}
                {view === 'playlist' && <PlaylistView />}
                {view === 'now-playing' && <NowPlayingView />}
                {view === 'podcasts' && <PodcastView />}
                {view === 'radio' && <RadioView />}
                {view === 'about' && <AboutView />}
                {view === 'settings' && <SettingsView />}
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        {showEq && (
          <Suspense fallback={null}>
            <EqPanel />
          </Suspense>
        )}
        <Transport />
        {(dropActive || dropMessage) && <AppDropOverlay message={dropMessage} active={dropActive} />}
        <QuickPlayPalette />
        <FirstRunHints />
      </div>
      {fullscreen && (
        <Suspense fallback={null}>
          <FullscreenVisualizer />
        </Suspense>
      )}
      {/* Toasts sit outside .app-chrome so they overlay the fullscreen
          visualizer too; the host is position:fixed either way. */}
      <ToastHost />
      {showSplash && <StartupSplash />}
      {settings && !settings.firstLaunchTutorialSeen && !tutorialDismissed && (
        <Suspense fallback={null}>
          <FirstLaunchTutorial
            settings={settings}
            onFinish={finishFirstLaunchTutorial}
            onOpenSettings={() => {
              setView('settings');
              void finishFirstLaunchTutorial();
            }}
          />
        </Suspense>
      )}
    </>
  );
}

function MediaSessionSync(): null {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const playbackRate = usePlayerStore((s) => s.playbackRate);

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

  return null;
}

function ViewFallback(): JSX.Element {
  return (
    <div
      data-newamp-view-loading
      className="flex h-full items-center justify-center text-[11px] uppercase tracking-[0.18em]"
      style={{ color: 'var(--ink-2)', background: 'var(--bg)' }}
    >
      Loading
    </div>
  );
}

function DeckFallback(): JSX.Element {
  return (
    <div
      data-newamp-deck-loading
      className="compact-root text-[11px] uppercase tracking-[0.18em]"
      style={{ color: 'var(--ink-2)' }}
    >
      Loading
    </div>
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
  } else if (command === 'cycle-skin') {
    // Shift+S skin surf — cycleTheme toasts the landed skin's name itself.
    void store.cycleTheme();
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
