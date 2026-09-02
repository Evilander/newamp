import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type {
  AppSettings,
  BuiltInTheme,
  CustomSkin,
  ExclusiveDeviceInfo,
  LastfmOutboxStatus,
  RadioBrainStatus,
  SupportBackupResult,
  SupportDiagnostics,
  SupportRestoreResult,
} from '@shared/types';
import { engine, usePlayerStore } from '../../store/usePlayerStore';
import { api, inElectron, DEFAULT_SETTINGS, exclusiveBackendLabel } from '../../lib/api';
import { AI_ASSIST_OPTIONS } from '../../lib/aiAssist';
import { SKIN_VARIABLES, THEME_REGISTRY, readCurrentSkinVariables } from '../../lib/skins';
import { normalizeAudioOutputDeviceId, uniqueAudioOutputDevices } from '@shared/audio-output';
import type { AudioOutputDeviceOption } from '@shared/audio-output';
import { MAX_PREAMP_DB, MIN_PREAMP_DB, PREAMP_STEP_DB, normalizePreampDb } from '@shared/audio-limiter';
import { pushToast } from '../../lib/toast';
import { ViewHeader } from '../ViewHeader';
import { Chip } from '../Chip';
import { ConfirmAction } from '../ConfirmAction';
import { ViewSkeleton } from '../ViewSkeleton';
import { ShellPicker } from '../ShellPicker';

// Skin cards (labels / taglines / swatches / order) come from the single
// THEME_REGISTRY in @shared/custom-skin — do not redeclare them here.

// Sticky chip-row TOC — one entry per <section id> below, in DOM order.
const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'settings-library', label: 'Library' },
  { id: 'settings-shell', label: 'Shell' },
  { id: 'settings-performance', label: 'Performance' },
  { id: 'settings-skin', label: 'Skin' },
  { id: 'settings-workshop', label: 'Workshop' },
  { id: 'settings-playback', label: 'Playback' },
  { id: 'settings-lastfm', label: 'Last.fm' },
  { id: 'settings-assist', label: 'Assist' },
  { id: 'settings-about', label: 'About' },
  { id: 'settings-support', label: 'Support' },
];

function scrollToSection(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const reduceMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

export function SettingsView(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState<{ tracks: number; albums: number; artists: number; duration: number } | null>(null);
  const [lastfmStatus, setLastfmStatus] = useState<string | null>(null);
  const [libraryExportStatus, setLibraryExportStatus] = useState<string | null>(null);
  const [openAiStatus, setOpenAiStatus] = useState<string | null>(null);
  const [lastfmOutbox, setLastfmOutbox] = useState<LastfmOutboxStatus | null>(null);
  const [supportDiagnostics, setSupportDiagnostics] = useState<SupportDiagnostics | null>(null);
  const [supportBackup, setSupportBackup] = useState<SupportBackupResult | null>(null);
  const [supportRestore, setSupportRestore] = useState<SupportRestoreResult | null>(null);
  const [supportBackupStatus, setSupportBackupStatus] = useState<string | null>(null);
  const [audioOutputs, setAudioOutputs] = useState<AudioOutputDeviceOption[]>([]);
  const [audioOutputStatus, setAudioOutputStatus] = useState<string | null>(null);
  const setTheme = usePlayerStore((s) => s.setTheme);
  const setCrossfadeMs = usePlayerStore((s) => s.setCrossfadeMs);
  const setReplayGainMode = usePlayerStore((s) => s.setReplayGainMode);
  const setLimiterEnabled = usePlayerStore((s) => s.setLimiterEnabled);
  const setPreampDb = usePlayerStore((s) => s.setPreampDb);
  const setAudioOutputDevice = usePlayerStore((s) => s.setAudioOutputDevice);
  const playOutputTestTone = usePlayerStore((s) => s.playOutputTestTone);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => setSettings(DEFAULT_SETTINGS));
    api.getStats().then(setStats).catch(() => undefined);
    api.lastfmGetOutboxStatus().then(setLastfmOutbox).catch(() => undefined);
    void refreshAudioOutputs();
    void refreshSupportDiagnostics();

    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    const onDeviceChange = () => void refreshAudioOutputs();
    mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  }, []);

  if (!settings) {
    // Honest loading: settings arrive over IPC — show the row skeleton under
    // the real header instead of a blank pane.
    return (
      <div className="settings-view flex h-full flex-col">
        <ViewHeader eyebrow="App" title="Settings" />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[820px] px-8 py-8">
            <ViewSkeleton variant="rows" count={10} />
          </div>
        </div>
      </div>
    );
  }
  const outputEngine = getOutputEngineReadout();
  // While Bit-Perfect Exclusive owns the output, every Web Audio DSP stage is
  // out of the signal path — gray the controls instead of letting them lie.
  const dspBypassed = settings.bitPerfectExclusive;
  const exclusiveLive = engine.getExclusiveInfo();

  async function pickAndAddFolder(): Promise<void> {
    const dir = await api.pickFolder();
    if (!dir) return;
    const next = Array.from(new Set([...settings!.libraryRoots, dir]));
    const updated = await api.setSettings({ libraryRoots: next });
    setSettings(updated);
  }

  async function removeRoot(p: string): Promise<void> {
    const next = settings!.libraryRoots.filter((r) => r !== p);
    const updated = await api.setSettings({ libraryRoots: next });
    setSettings(updated);
    pushToast({ tone: 'ok', title: 'Folder removed', detail: p });
  }

  async function saveLastfmCredentials(): Promise<AppSettings> {
    const updated = await api.setSettings({
      lastfmApiKey: settings!.lastfmApiKey?.trim() || null,
      lastfmSharedSecret: settings!.lastfmSharedSecret?.trim() || null,
    });
    setSettings(updated);
    setLastfmStatus('Last.fm credentials saved.');
    return updated;
  }

  async function lastfmStartAuth(): Promise<void> {
    setLastfmStatus(null);
    try {
      await saveLastfmCredentials();
      await api.lastfmStartAuth();
      const updated = await api.getSettings();
      setSettings(updated);
      setLastfmStatus('Browser opened. Approve NewAmp, then complete the connection.');
    } catch (err) {
      setLastfmStatus(err instanceof Error ? err.message : 'Last.fm authorization failed.');
    }
  }

  async function completeLastfmAuth(): Promise<void> {
    setLastfmStatus(null);
    try {
      const session = await api.lastfmCompleteAuth();
      const updated = await api.getSettings();
      setSettings(updated);
      setLastfmOutbox(await api.lastfmFlushOutbox().catch(() => lastfmOutbox));
      setLastfmStatus(`Connected as ${session.username}.`);
    } catch (err) {
      setLastfmStatus(err instanceof Error ? err.message : 'Last.fm connection failed.');
    }
  }

  async function disconnectLastfm(): Promise<void> {
    const updated = await api.lastfmDisconnect();
    setSettings(updated);
    setLastfmOutbox(await api.lastfmGetOutboxStatus().catch(() => lastfmOutbox));
    setLastfmStatus('Last.fm disconnected.');
    pushToast({ tone: 'ok', title: 'Last.fm disconnected' });
  }

  async function flushLastfmOutbox(): Promise<void> {
    setLastfmStatus(null);
    try {
      const status = await api.lastfmFlushOutbox();
      setLastfmOutbox(status);
      setLastfmStatus(status.pending ? `${status.pending} scrobbles still cached.` : 'Cached scrobbles sent.');
    } catch (err) {
      setLastfmStatus(err instanceof Error ? err.message : 'Last.fm outbox flush failed.');
    }
  }

  async function testLastfmNowPlaying(): Promise<void> {
    setLastfmStatus(null);
    try {
      await saveLastfmCredentials();
      await api.lastfmUpdateNowPlaying({
        artist: 'NewAmp QA',
        title: 'Settings Now Playing Test',
        album: 'NewAmp Release Proof',
        albumArtist: 'NewAmp QA',
        duration: 181,
        trackNumber: 1,
      });
      setLastfmStatus('Last.fm now-playing test sent.');
    } catch (err) {
      setLastfmStatus(err instanceof Error ? err.message : 'Last.fm now-playing test failed.');
    }
  }

  async function saveOpenAiSettings(): Promise<void> {
    if (!settings) return;
    const updated = await api.setSettings({
      openaiApiKey: settings.openaiApiKey?.trim() || null,
      openaiModel: settings.openaiModel?.trim() || DEFAULT_SETTINGS.openaiModel,
    });
    setSettings(updated);
    setOpenAiStatus(updated.openaiApiKey ? 'ChatGPT assist key saved locally.' : 'ChatGPT assist disabled.');
  }

  async function showTutorialOnNextLaunch(): Promise<void> {
    if (!settings) return;
    const updated = await api.setSettings({ firstLaunchTutorialSeen: false });
    setSettings(updated);
    setOpenAiStatus('First-launch tutorial will show the next time NewAmp opens.');
  }

  async function refreshAudioOutputs(): Promise<void> {
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!mediaDevices?.enumerateDevices) {
      setAudioOutputs([]);
      setAudioOutputStatus('Audio output selection is unavailable here.');
      return;
    }

    try {
      const devices = await mediaDevices.enumerateDevices();
      setAudioOutputs(uniqueAudioOutputDevices(devices));
      setAudioOutputStatus(null);
    } catch (err) {
      setAudioOutputs([]);
      setAudioOutputStatus(err instanceof Error ? err.message : 'Audio devices could not be listed.');
    }
  }

  async function pickAudioOutput(): Promise<void> {
    type SelectAudioOutputMediaDevices = MediaDevices & {
      selectAudioOutput?: () => Promise<MediaDeviceInfo>;
    };
    const mediaDevices = typeof navigator !== 'undefined'
      ? navigator.mediaDevices as SelectAudioOutputMediaDevices
      : null;

    if (!mediaDevices?.selectAudioOutput) {
      await refreshAudioOutputs();
      setAudioOutputStatus('Use the device list; native picker is unavailable here.');
      return;
    }

    try {
      const device = await mediaDevices.selectAudioOutput();
      const audioOutputDeviceId = normalizeAudioOutputDeviceId(device.deviceId);
      if (!audioOutputDeviceId) return;
      await changeAudioOutput(audioOutputDeviceId);
      await refreshAudioOutputs();
    } catch (err) {
      setAudioOutputStatus(err instanceof Error ? err.message : 'Audio output selection was cancelled.');
    }
  }

  async function changeAudioOutput(deviceId: string): Promise<void> {
    const audioOutputDeviceId = normalizeAudioOutputDeviceId(deviceId);
    setAudioOutputStatus(audioOutputDeviceId ? 'Switching output...' : 'Using system default...');
    try {
      await setAudioOutputDevice(audioOutputDeviceId);
      const updated = await api
        .getSettings()
        .catch(() => ({ ...settings!, audioOutputDeviceId }));
      setSettings(updated);
      setAudioOutputStatus(audioOutputDeviceId ? 'Audio output switched.' : 'Using system default output.');
    } catch (err) {
      setAudioOutputStatus(err instanceof Error ? err.message : 'Audio output switch failed.');
    }
  }

  async function testAudioOutput(): Promise<void> {
    setAudioOutputStatus('Testing center, left, right...');
    try {
      await playOutputTestTone();
      setAudioOutputStatus('Output test finished.');
    } catch (err) {
      setAudioOutputStatus(err instanceof Error ? err.message : 'Output test failed.');
    }
  }

  async function refreshSupportDiagnostics(): Promise<void> {
    const diagnostics = await api.getSupportDiagnostics().catch(() => null);
    setSupportDiagnostics(diagnostics);
  }

  async function createBackup(): Promise<void> {
    setSupportBackupStatus('Creating backup...');
    try {
      const result = await api.createSupportBackup();
      setSupportBackup(result);
      setSupportRestore(null);
      setSupportBackupStatus(`Backup created with ${result.filesCopied.toLocaleString()} files.`);
      await refreshSupportDiagnostics();
    } catch (err) {
      setSupportBackupStatus(err instanceof Error ? err.message : 'Backup failed.');
    }
  }

  async function restoreBackup(): Promise<void> {
    setSupportBackupStatus('Choose a NewAmp backup folder to restore...');
    try {
      const result = await api.restoreSupportBackup();
      if (!result) {
        setSupportBackupStatus('Restore canceled.');
        return;
      }
      setSupportRestore(result);
      setSupportBackupStatus(
        `Restored ${result.restored.length.toLocaleString()} item(s). Restart NewAmp to refresh every view.`,
      );
      pushToast({
        tone: 'ok',
        title: 'Backup restored',
        detail: 'Restart NewAmp to refresh every view.',
      });
      await refreshSupportDiagnostics();
    } catch (err) {
      setSupportBackupStatus(err instanceof Error ? err.message : 'Restore failed.');
    }
  }

  return (
    <div className="settings-view flex h-full flex-col">
      <ViewHeader eyebrow="App" title="Settings" />
      <nav className="settings-toc" aria-label="Settings sections" data-newamp-settings-toc>
        <div className="settings-toc-inner">
          {SETTINGS_SECTIONS.map((s) => (
            <Chip
              key={s.id}
              size="sm"
              interactive
              title={`Jump to ${s.label}`}
              onClick={() => scrollToSection(s.id)}
            >
              {s.label}
            </Chip>
          ))}
        </div>
      </nav>
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[820px] space-y-8 px-8 py-8">
          <p className="text-base text-muted">
            Tune the look, your library, and your network integrations.
          </p>

          <section id="settings-library" className="bevel-out flex flex-col gap-4 p-6">
            <h2 className="eyebrow">Library</h2>
            <div className="flex flex-col gap-2">
              {settings.libraryRoots.length === 0 && (
                <div className="text-sm text-muted">
                  No folders yet. Add one to begin.
                </div>
              )}
              {settings.libraryRoots.map((r) => (
                <div
                  key={r}
                  className="bevel-in flex items-center justify-between px-3 py-2 font-mono text-sm"
                >
                  <span className="truncate">{r}</span>
                  <ConfirmAction label="Remove" confirmLabel="Remove?" onConfirm={() => void removeRoot(r)} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="pxbtn" onClick={() => void pickAndAddFolder()}>
                + Add folder…
              </button>
              <button
                className="pxbtn is-active"
                onClick={() => void api.scanLibrary()}
                disabled={!settings.libraryRoots.length}
              >
                ▶ Scan now
              </button>
              <button className="pxbtn" onClick={() => void api.cancelScan()}>
                Cancel scan
              </button>
              {stats && (
                <span className="ml-auto text-sm text-muted">
                  {stats.tracks.toLocaleString()} tracks · {stats.albums.toLocaleString()} albums ·{' '}
                  {stats.artists.toLocaleString()} artists · {formatHours(stats.duration)}
                </span>
              )}
            </div>
            <Row label="Auto-watch library">
              <label className="flex items-center gap-2 text-sm text-ink2">
                <input
                  type="checkbox"
                  checked={settings.libraryAutoWatch}
                  onChange={(e) => {
                    api.setSettings({ libraryAutoWatch: e.target.checked }).then(setSettings).catch(() => undefined);
                  }}
                />
                Refresh when music files or cover art change
              </label>
            </Row>
            <Row label="Export metadata">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="pxbtn"
                  data-newamp-export-library-json
                  onClick={() => {
                    setLibraryExportStatus('Exporting…');
                    void api
                      .exportLibraryMetadata('json')
                      .then((result) =>
                        setLibraryExportStatus(
                          result ? `Saved ${result.tracks.toLocaleString()} tracks → ${result.path}` : null,
                        ),
                      )
                      .catch((err) => setLibraryExportStatus(`Export failed: ${err instanceof Error ? err.message : err}`));
                  }}
                  title="Every tag + your listening data (plays, ratings, loves) as JSON"
                >
                  JSON
                </button>
                <button
                  className="pxbtn"
                  data-newamp-export-library-csv
                  onClick={() => {
                    setLibraryExportStatus('Exporting…');
                    void api
                      .exportLibraryMetadata('csv')
                      .then((result) =>
                        setLibraryExportStatus(
                          result ? `Saved ${result.tracks.toLocaleString()} tracks → ${result.path}` : null,
                        ),
                      )
                      .catch((err) => setLibraryExportStatus(`Export failed: ${err instanceof Error ? err.message : err}`));
                  }}
                  title="Spreadsheet-ready CSV of every tag + your listening data"
                >
                  CSV
                </button>
                <span className="text-xs text-muted">
                  {libraryExportStatus ?? 'Tags, plays, ratings, loves — audit or migrate anywhere'}
                </span>
              </div>
            </Row>
            <RadioBrainRow
              settings={settings}
              onChange={(patch) => api.setSettings(patch).then(setSettings).catch(() => undefined)}
            />
          </section>

          <section id="settings-shell" className="bevel-out flex flex-col gap-3 p-6">
            <h2 className="eyebrow">Shell / Layout</h2>
            <p className="text-sm text-ink2">
              The shell changes the chrome: sidebar, transport, glass effects. The skin (below) changes the
              colors. Mix and match: Liquid Glass + Amber, Modern + Midnight, Concourse + Ops.
            </p>
            <ShellPicker />
            <Row label="Text size">
              <div className="flex min-w-[260px] items-center gap-3">
                <input
                  type="range"
                  min={0.85}
                  max={1.35}
                  step={0.05}
                  value={settings.textScale}
                  onChange={(e) => {
                    const textScale = Number(e.target.value);
                    api.setSettings({ textScale }).then(setSettings).catch(() => undefined);
                  }}
                  className="nslider flex-1"
                />
                <span className="w-[52px] text-right text-sm tabular-nums text-ink2">
                  {Math.round(settings.textScale * 100)}%
                </span>
                <button
                  className="pxbtn"
                  onClick={() => {
                    api.setSettings({ textScale: 1 }).then(setSettings).catch(() => undefined);
                  }}
                >
                  Reset
                </button>
              </div>
            </Row>
            <Row label="Close button (X)">
              <label className="flex items-center gap-3 text-sm text-ink2">
                <select
                  value={settings.closeButtonBehavior}
                  onChange={(event) => {
                    const closeButtonBehavior = event.target.value === 'close-app' ? 'close-app' : 'minimize-to-tray';
                    api.setSettings({ closeButtonBehavior }).then(setSettings).catch(() => undefined);
                  }}
                  className="bevel-in px-2 py-1"
                  data-newamp-close-button-behavior
                >
                  <option value="minimize-to-tray">Minimize to tray</option>
                  <option value="close-app">Close the app</option>
                </select>
                <span className="text-xs text-muted">
                  Choose what happens when you click the X button in the title bar.
                </span>
              </label>
            </Row>
          </section>

          <section id="settings-performance" className="bevel-out flex flex-col gap-4 p-6">
            <h2 className="eyebrow">Performance &amp; Resonance</h2>
            <Row label="Performance">
              <label className="flex flex-col gap-1 text-sm text-ink2">
                <select
                  value={settings.performanceTier}
                  onChange={(event) => {
                    const performanceTier =
                      event.target.value === 'high' || event.target.value === 'lite'
                        ? (event.target.value as 'high' | 'lite')
                        : 'auto';
                    api.setSettings({ performanceTier }).then(setSettings).catch(() => undefined);
                  }}
                  className="bevel-in px-2 py-1"
                  data-newamp-performance-tier
                >
                  <option value="auto">Auto (detect this machine)</option>
                  <option value="high">High (full richness)</option>
                  <option value="lite">Lite (lightest, for weak hardware)</option>
                </select>
                <span className="text-xs text-muted">
                  Auto measures your frame rate and scales the visualizer and motion to keep playback smooth.
                </span>
              </label>
            </Row>
            <Row label="Resonance">
              <label className="flex flex-col gap-1 text-sm text-ink2">
                <select
                  value={settings.ambientReactivity}
                  onChange={(event) => {
                    const ambientReactivity =
                      event.target.value === 'on' || event.target.value === 'off'
                        ? (event.target.value as 'on' | 'off')
                        : 'auto';
                    api.setSettings({ ambientReactivity }).then(setSettings).catch(() => undefined);
                  }}
                  className="bevel-in px-2 py-1"
                  data-newamp-ambient-reactivity
                >
                  <option value="auto">Auto (on, unless the machine is slow)</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
                <span className="text-xs text-muted">
                  The whole interface breathes with the music — a colored glow from the album art and a beat pulse on the controls.
                </span>
              </label>
            </Row>
            <Row label="Eviland memory">
              <EvilandMemoryRow />
            </Row>
          </section>

          <section id="settings-skin" className="bevel-out flex flex-col gap-4 p-6">
            <h2 className="eyebrow">Skin</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {THEME_REGISTRY.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    void setTheme(t.id);
                    setSettings((prev) => (prev ? { ...prev, theme: t.id } : prev));
                  }}
                  className="flex flex-col gap-2 rounded-card p-3 text-left transition-all"
                  style={{
                    background: t.swatches[0],
                    outline:
                      settings.theme === t.id ? `2px solid ${t.swatches[1]}` : '1px solid var(--line)',
                    boxShadow: settings.theme === t.id ? `0 0 18px ${t.swatches[1]}55` : undefined,
                  }}
                >
                  <div className="flex gap-1">
                    {t.swatches.map((c, i) => (
                      <span key={i} className="skin-swatch-dot" style={{ background: c }} />
                    ))}
                  </div>
                  <div className="text-base font-semibold" style={{ color: t.swatches[2] }}>
                    {t.label}
                  </div>
                  <div className="text-2xs" style={{ color: t.swatches[2], opacity: 0.7 }}>
                    {t.tagline}
                  </div>
                </button>
              ))}
              {settings.customSkin && (
                <button
                  onClick={() => {
                    void setTheme('custom');
                    setSettings((prev) => (prev ? { ...prev, theme: 'custom' } : prev));
                  }}
                  className="flex flex-col gap-2 rounded-card p-3 text-left transition-all"
                  style={{
                    background: settings.customSkin.variables['--panel'] || 'var(--panel)',
                    outline:
                      settings.theme === 'custom'
                        ? `2px solid ${settings.customSkin.variables['--accent'] || 'var(--accent)'}`
                        : '1px solid var(--line)',
                    boxShadow: settings.theme === 'custom' ? '0 0 18px var(--accent-glow)' : undefined,
                  }}
                >
                  <div className="flex gap-1">
                    {['--bg', '--accent', '--ink'].map((key) => (
                      <span
                        key={key}
                        className="skin-swatch-dot"
                        style={{ background: settings.customSkin?.variables[key] || 'var(--panel)' }}
                      />
                    ))}
                  </div>
                  <div className="text-base font-semibold">
                    {settings.customSkin.name}
                  </div>
                  <div className="text-2xs text-ink2">
                    Custom skin
                  </div>
                </button>
              )}
            </div>
          </section>

          <SkinWorkshop settings={settings} onSaved={setSettings} />

          <section id="settings-playback" className="bevel-out flex flex-col gap-4 p-6">
            <h2 className="eyebrow">Playback</h2>
            {dspBypassed && (
              <div className="text-xs text-warn" data-newamp-dsp-bypassed>
                Bit-Perfect Exclusive is on — crossfade, ReplayGain, limiter, preamp, EQ and software
                volume are bypassed so the DAC receives untouched samples. Use your device's own volume.
              </div>
            )}
            <Row label="Crossfade">
              <select
                value={settings.crossfadeMs}
                disabled={dspBypassed}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setCrossfadeMs(v).then(() => {
                    setSettings((prev) => (prev ? { ...prev, crossfadeMs: v } : prev));
                  });
                }}
                className={`bevel-in px-2 py-1 text-base${dspBypassed ? ' opacity-50' : ''}`}
              >
                <option value={0}>Off</option>
                <option value={2000}>2 s</option>
                <option value={4000}>4 s</option>
                <option value={8000}>8 s</option>
              </select>
            </Row>
            <Row label="ReplayGain">
              <select
                value={settings.replayGain}
                disabled={dspBypassed}
                onChange={(e) => {
                  const replayGain = e.target.value as AppSettings['replayGain'];
                  setReplayGainMode(replayGain).then(() => {
                    setSettings((prev) => (prev ? { ...prev, replayGain } : prev));
                  });
                }}
                className={`bevel-in px-2 py-1 text-base${dspBypassed ? ' opacity-50' : ''}`}
              >
                <option value="off">Off</option>
                <option value="track">Track gain</option>
                <option value="album">Album gain</option>
              </select>
            </Row>
            <Row label="Clipping protection">
              <label className={`flex items-center gap-2 text-base text-ink${dspBypassed ? ' opacity-50' : ''}`}>
                <input
                  type="checkbox"
                  checked={settings.limiterEnabled}
                  disabled={dspBypassed}
                  onChange={(e) => {
                    const limiterEnabled = e.target.checked;
                    setLimiterEnabled(limiterEnabled).then(() => {
                      setSettings((prev) => (prev ? { ...prev, limiterEnabled } : prev));
                    });
                  }}
                />
                Limiter
              </label>
            </Row>
            <Row label="Preamp">
              <div className="flex max-w-[360px] flex-1 items-center justify-end gap-3">
                <input
                  type="range"
                  min={MIN_PREAMP_DB}
                  max={MAX_PREAMP_DB}
                  step={PREAMP_STEP_DB}
                  value={settings.preampDb}
                  disabled={dspBypassed}
                  onChange={(e) => {
                    const preampDb = normalizePreampDb(e.target.valueAsNumber);
                    setPreampDb(preampDb).then(() => {
                      setSettings((prev) => (prev ? { ...prev, preampDb } : prev));
                    });
                  }}
                  className={`w-[220px]${dspBypassed ? ' opacity-50' : ''}`}
                />
                <span className="min-w-[58px] text-right text-sm text-ink2">
                  {settings.preampDb.toFixed(1)} dB
                </span>
              </div>
            </Row>
            <Row label="Output engine">
              <div className="audio-engine-readout">
                {exclusiveLive.active && exclusiveLive.negotiated ? (
                  <>
                    <span>{(exclusiveLive.negotiated.sampleRate / 1000).toFixed(1)} kHz</span>
                    <span>
                      {exclusiveLive.negotiated.format} / {exclusiveBackendLabel()} (native)
                    </span>
                  </>
                ) : (
                  <>
                    <span>{outputEngine.sampleRate}</span>
                    <span>32-bit float / Web Audio</span>
                  </>
                )}
              </div>
            </Row>
            <BitPerfectRow settings={settings} onChange={(patch) => api.setSettings(patch).then(setSettings)} />
            <ExclusiveModeRow settings={settings} onSettings={setSettings} />

            <Row label="Audio Output">
              <div className="flex max-w-[560px] flex-wrap items-center justify-end gap-2">
                <select
                  value={settings.audioOutputDeviceId ?? ''}
                  onChange={(e) => void changeAudioOutput(e.target.value)}
                  className="bevel-in min-w-[220px] px-2 py-1 text-base"
                >
                  <option value="">System default</option>
                  {audioOutputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                  {settings.audioOutputDeviceId &&
                    !audioOutputs.some((device) => device.deviceId === settings.audioOutputDeviceId) && (
                      <option value={settings.audioOutputDeviceId}>Saved device</option>
                    )}
                </select>
                <button className="pxbtn" onClick={() => void refreshAudioOutputs()}>
                  Refresh
                </button>
                <button className="pxbtn" onClick={() => void pickAudioOutput()}>
                  Pick
                </button>
                <button className="pxbtn" onClick={() => void testAudioOutput()}>
                  Test L/R
                </button>
                {audioOutputStatus && (
                  <span className="basis-full text-right text-xs text-ink2">
                    {audioOutputStatus}
                  </span>
                )}
              </div>
            </Row>
          </section>

          <section id="settings-lastfm" className="bevel-out flex flex-col gap-4 p-6">
            <h2 className="eyebrow">Last.fm</h2>
            <div
              className="text-sm leading-relaxed text-ink2"
              data-newamp-lastfm-setup-guide
            >
              Last.fm is optional. NewAmp needs your own Last.fm API account because scrobbling is tied
              to your Last.fm identity, not to a shared NewAmp account. Create one at{' '}
              <a
                href="https://www.last.fm/api/account/create"
                target="_blank"
                rel="noreferrer"
                className="text-accent"
              >
                last.fm/api/account/create
              </a>
              , use <span className="text-ink">NewAmp</span> as the application name,
              and leave callback URL blank for desktop auth.
            </div>
            <div className="grid gap-2 text-xs text-ink2 md:grid-cols-2">
              <div className="bevel-in px-3 py-2">
                <strong className="text-ink">Last.fm app form</strong>
                <div>Application name: NewAmp</div>
                <div>Application description: Local Windows music player with optional Last.fm scrobbling.</div>
                <div>Homepage: https://github.com/evilander/newamp</div>
                <div>Callback URL: leave blank.</div>
              </div>
              <div className="bevel-in px-3 py-2">
                <strong className="text-ink">Connection order</strong>
                <div>1. Save API key and shared secret.</div>
                <div>2. Open Last.fm auth and approve NewAmp in the browser.</div>
                <div>3. Return here and press Complete auth.</div>
                <div>4. Enable scrobbling or send a now-playing test.</div>
              </div>
            </div>
            <Row label="API key">
              <input
                value={settings.lastfmApiKey ?? ''}
                onChange={(e) => setSettings({ ...settings, lastfmApiKey: e.target.value || null })}
                className="bevel-in w-[320px] px-2 py-1 text-base outline-none"
              />
            </Row>
            <Row label="Shared secret">
              <input
                type="password"
                value={settings.lastfmSharedSecret ?? ''}
                onChange={(e) => setSettings({ ...settings, lastfmSharedSecret: e.target.value || null })}
                className="bevel-in w-[320px] px-2 py-1 text-base outline-none"
              />
            </Row>
            <Row label="Account">
              <span className={`text-sm ${settings.lastfmUsername ? 'text-accent' : 'text-muted'}`}>
                {settings.lastfmUsername ? `Connected as ${settings.lastfmUsername}` : 'Not connected'}
              </span>
            </Row>
            <Row label="Scrobbling">
              <label className="flex items-center gap-2 text-sm text-ink2">
                <input
                  type="checkbox"
                  checked={settings.lastfmEnabled}
                  disabled={!settings.lastfmSessionKey}
                  onChange={(e) => {
                    api.setSettings({ lastfmEnabled: e.target.checked }).then(setSettings).catch(() => undefined);
                  }}
                />
                Enabled
              </label>
            </Row>
            <Row label="Retry cache">
              <span className={`text-sm ${lastfmOutbox?.pending ? 'text-warn' : 'text-muted'}`}>
                {lastfmOutbox
                  ? `${lastfmOutbox.pending} pending${lastfmOutbox.lastError ? ` - ${lastfmOutbox.lastError}` : ''}`
                  : 'Checking...'}
              </span>
            </Row>
            {lastfmOutbox?.needsReconnect && (
              <div className="text-xs text-warn">
                Last.fm session expired - reconnect with Open Last.fm auth to resume scrobbling.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button className="pxbtn" onClick={() => void saveLastfmCredentials()}>
                Save credentials
              </button>
              <button
                className={`pxbtn${lastfmOutbox?.needsReconnect ? ' is-active' : ''}`}
                onClick={() => void lastfmStartAuth()}
              >
                Open Last.fm auth
              </button>
              <button className="pxbtn is-active" onClick={() => void completeLastfmAuth()}>
                Complete auth
              </button>
              <ConfirmAction
                label="Disconnect"
                confirmLabel="Disconnect?"
                onConfirm={() => void disconnectLastfm()}
                disabled={!settings.lastfmSessionKey}
              />
              <button className="pxbtn" onClick={() => void flushLastfmOutbox()} disabled={!settings.lastfmSessionKey || !lastfmOutbox?.pending}>
                Flush cache
              </button>
              <button className="pxbtn" onClick={() => void testLastfmNowPlaying()} disabled={!settings.lastfmSessionKey}>
                Test now playing
              </button>
              {lastfmStatus && (
                <span className="text-xs text-ink2">
                  {lastfmStatus}
                </span>
              )}
            </div>
          </section>

          <section id="settings-assist" className="bevel-out flex flex-col gap-4 p-6">
            <h2 className="eyebrow">ChatGPT Assist</h2>
            <div className="text-sm leading-relaxed text-ink2">
              Optional local enrichments for real On Air liner notes, artist context, review prompts, and discussion seeds.
              The key is stored in NewAmp settings on this machine and is never needed for basic playback.
            </div>
            <div className="ai-assist-option-grid">
              {AI_ASSIST_OPTIONS.map((option) => (
                <div key={option.id} className="ai-assist-option">
                  <strong>{option.label}</strong>
                  <span>{option.detail}</span>
                </div>
              ))}
            </div>
            <Row label="API key">
              <input
                type="password"
                value={settings.openaiApiKey ?? ''}
                onChange={(e) => setSettings({ ...settings, openaiApiKey: e.target.value || null })}
                placeholder="sk-..."
                className="bevel-in w-[320px] px-2 py-1 text-base outline-none"
              />
            </Row>
            <Row label="Model">
              <input
                value={settings.openaiModel ?? DEFAULT_SETTINGS.openaiModel}
                onChange={(e) => setSettings({ ...settings, openaiModel: e.target.value || DEFAULT_SETTINGS.openaiModel })}
                className="bevel-in w-[220px] px-2 py-1 text-base outline-none"
              />
            </Row>
            <div className="flex flex-wrap items-center gap-2">
              <button className="pxbtn" onClick={() => void saveOpenAiSettings()}>
                Save ChatGPT key
              </button>
              <button className="pxbtn" onClick={() => void showTutorialOnNextLaunch()}>
                Show first-launch tutorial
              </button>
              <span className={`text-xs ${settings.openaiApiKey ? 'text-accent' : 'text-muted'}`}>
                {settings.openaiApiKey ? `Ready: ${settings.openaiModel || DEFAULT_SETTINGS.openaiModel}` : 'Local metadata mode only'}
              </span>
              {openAiStatus && (
                <span className="text-xs text-ink2">
                  {openAiStatus}
                </span>
              )}
            </div>
          </section>

          <section id="settings-about" className="bevel-out flex flex-col gap-2 p-6 text-sm text-muted">
            <h2 className="eyebrow">About</h2>
            <div>
              NewAmp v{api.appVersion} / Built for {api.platform}
              {!inElectron && (
                <span className="text-warn"> · browser preview (no library access)</span>
              )}
            </div>
            <div>
              Made by Tyler “Evilander” Eveland. Lyrics by{' '}
              <a href="https://lrclib.net" target="_blank" rel="noreferrer" className="text-accent">
                LRCLIB
              </a>
              . Radio by{' '}
              <a href="https://www.radio-browser.info" target="_blank" rel="noreferrer" className="text-accent">
                radio-browser.info
              </a>
              . No telemetry. Accounts are optional. Your library never leaves your machine.
            </div>
            <div className="flex flex-wrap items-center gap-2" data-newamp-community-links>
              <a
                href="https://github.com/evilander/newamp"
                target="_blank"
                rel="noreferrer"
                className="text-accent"
              >
                GitHub
              </a>
              <span aria-hidden="true">·</span>
              <a
                href="https://github.com/evilander/newamp/issues"
                target="_blank"
                rel="noreferrer"
                className="text-accent"
              >
                Issues
              </a>
              <span aria-hidden="true">·</span>
              <a
                href="https://github.com/evilander/newamp/discussions"
                target="_blank"
                rel="noreferrer"
                className="text-accent"
              >
                Discussions
              </a>
              <span>— bugs, ideas, and skins welcome.</span>
            </div>
          </section>

          <section id="settings-support" className="bevel-out flex flex-col gap-3 p-6 text-sm text-muted">
            <div className="flex items-center gap-2">
              <h2 className="eyebrow">Support Diagnostics</h2>
              <button className="pxbtn ml-auto" onClick={() => void refreshSupportDiagnostics()}>
                Refresh
              </button>
            </div>
            {supportDiagnostics ? (
              <>
                <DiagnosticRow label="App">
                  NewAmp v{supportDiagnostics.appVersion} / Electron {supportDiagnostics.electronVersion}
                </DiagnosticRow>
                <DiagnosticRow label="Library">
                  {supportDiagnostics.libraryStats.tracks.toLocaleString()} tracks /{' '}
                  {supportDiagnostics.libraryStats.albums.toLocaleString()} albums
                </DiagnosticRow>
                <DiagnosticRow label="Settings file">{supportDiagnostics.settingsPath || 'n/a'}</DiagnosticRow>
                <DiagnosticRow label="Library DB">{supportDiagnostics.libraryPath || 'n/a'}</DiagnosticRow>
                <DiagnosticRow label="Crash log">{supportDiagnostics.diagnosticEventsPath || 'n/a'}</DiagnosticRow>
                <DiagnosticRow label="Crash dumps">{supportDiagnostics.crashDumpsPath || 'n/a'}</DiagnosticRow>
                <DiagnosticRow label="Recovery">
                  {supportDiagnostics.recoveryEvents.length
                    ? `${supportDiagnostics.recoveryEvents.length} quarantined file(s)`
                    : 'No recoveries recorded this launch'}
                </DiagnosticRow>
                {supportDiagnostics.recoveryEvents.length > 0 && (
                  <div className="bevel-in space-y-1 px-3 py-2">
                    {supportDiagnostics.recoveryEvents.map((event) => (
                      <div key={`${event.store}:${event.backupPath}`} className="truncate">
                        {event.store}: {event.backupPath}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    className="pxbtn"
                    onClick={() => void api.showInFolder(supportDiagnostics.settingsPath)}
                    disabled={!supportDiagnostics.settingsPath}
                  >
                    Show settings
                  </button>
                  <button
                    className="pxbtn"
                    onClick={() => void api.showInFolder(supportDiagnostics.libraryPath)}
                    disabled={!supportDiagnostics.libraryPath}
                  >
                    Show library DB
                  </button>
                  <button
                    className="pxbtn"
                    onClick={() => void api.showInFolder(supportDiagnostics.diagnosticEventsPath)}
                    disabled={!supportDiagnostics.diagnosticEventsPath}
                  >
                    Show crash log
                  </button>
                  <button
                    className="pxbtn"
                    onClick={() => void api.showInFolder(supportDiagnostics.crashDumpsPath)}
                    disabled={!supportDiagnostics.crashDumpsPath}
                  >
                    Show crash dumps
                  </button>
                  <button className="pxbtn" onClick={() => void createBackup()}>
                    Create backup
                  </button>
                  <ConfirmAction
                    label="Restore backup"
                    confirmLabel="Overwrite current data?"
                    tone="warn"
                    onConfirm={() => void restoreBackup()}
                    title="Replaces current settings and library with a backup (a safety backup is made first)"
                  />
                  <button
                    className="pxbtn"
                    onClick={() => supportBackup && void api.showInFolder(supportBackup.backupPath)}
                    disabled={!supportBackup?.backupPath}
                  >
                    Show backup
                  </button>
                  <button
                    className="pxbtn"
                    onClick={() => supportRestore?.safetyBackupPath && void api.showInFolder(supportRestore.safetyBackupPath)}
                    disabled={!supportRestore?.safetyBackupPath}
                  >
                    Show safety backup
                  </button>
                </div>
                {supportBackupStatus && (
                  <div className={`text-xs ${supportBackup ? 'text-accent' : 'text-ink2'}`}>
                    {supportBackupStatus}
                  </div>
                )}
              </>
            ) : (
              <div>Diagnostics unavailable in this mode.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SkinWorkshop({
  settings,
  onSaved,
}: {
  settings: AppSettings;
  onSaved: (settings: AppSettings) => void;
}): JSX.Element {
  const saveCustomSkin = usePlayerStore((s) => s.saveCustomSkin);
  const [name, setName] = useState(settings.customSkin?.name ?? 'NewAmp Custom');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [skinFileStatus, setSkinFileStatus] = useState<string | null>(null);

  useEffect(() => {
    setName(settings.customSkin?.name ?? 'NewAmp Custom');
    setDraft(settings.theme === 'custom' && settings.customSkin
      ? settings.customSkin.variables
      : readCurrentSkinVariables());
  }, [settings.customSkin, settings.theme]);

  function setVar(key: string, value: string): void {
    setDraft((cur) => ({ ...cur, [key]: value }));
    document.documentElement.style.setProperty(key, value);
  }

  function buildSkin(): CustomSkin {
    const baseTheme: BuiltInTheme =
      settings.theme === 'custom'
        ? settings.customSkin?.baseTheme ?? 'classic'
        : settings.theme;
    const variables = Object.fromEntries(
      SKIN_VARIABLES.map((key) => [key, draft[key] || readCurrentSkinVariables()[key] || '']),
    );
    return {
      name: name.trim() || 'NewAmp Custom',
      baseTheme,
      variables,
      updatedAt: Date.now(),
    };
  }

  async function save(): Promise<void> {
    const skin = buildSkin();
    await saveCustomSkin(skin);
    setSkinFileStatus(`Saved ${skin.name}.`);
    onSaved({ ...settings, theme: 'custom', customSkin: skin });
  }

  async function exportSkin(): Promise<void> {
    setSkinFileStatus(null);
    try {
      const skin = buildSkin();
      const filePath = await api.exportCustomSkin(skin);
      setSkinFileStatus(filePath ? `Exported ${skin.name}.` : 'Export canceled.');
    } catch (err) {
      setSkinFileStatus(err instanceof Error ? err.message : 'Skin export failed.');
    }
  }

  async function importSkin(): Promise<void> {
    setSkinFileStatus(null);
    try {
      const skin = await api.importCustomSkin();
      if (!skin) {
        setSkinFileStatus('Import canceled.');
        return;
      }
      await saveCustomSkin(skin);
      setName(skin.name);
      setDraft(skin.variables);
      setSkinFileStatus(`Imported ${skin.name}.`);
      onSaved({ ...settings, theme: 'custom', customSkin: skin });
    } catch (err) {
      setSkinFileStatus(err instanceof Error ? err.message : 'Skin import failed.');
    }
  }

  function reset(): void {
    const vars = readCurrentSkinVariables();
    setDraft(vars);
    for (const [key, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(key, value);
    }
    pushToast({ tone: 'ok', title: 'Workshop reset', detail: 'Draft matches the current skin again.' });
  }

  return (
    <section id="settings-workshop" className="bevel-out flex flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <h2 className="eyebrow">Skin Workshop</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bevel-in ml-auto px-2 py-1 text-sm"
        />
        <ConfirmAction label="Reset" confirmLabel="Discard edits?" tone="warn" onConfirm={reset} />
        <button className="pxbtn" onClick={() => void importSkin()}>Import skin</button>
        <button className="pxbtn" onClick={() => void exportSkin()}>Export skin</button>
        <button className="pxbtn is-active" onClick={() => void save()}>Save skin</button>
      </div>
      {skinFileStatus && (
        <div className="text-xs text-ink2">
          {skinFileStatus}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {SKIN_VARIABLES.map((key) => {
          const value = draft[key] ?? '';
          const canColorPick = /^#[0-9a-f]{6}$/i.test(value);
          return (
            <label
              key={key}
              className="grid grid-cols-[120px_26px_minmax(0,1fr)] items-center gap-2 text-xs text-ink2"
            >
              <span>{key.replace('--', '')}</span>
              <span className="workshop-swatch" style={{ background: value || 'transparent' }} />
              <span className="flex items-center gap-2">
                {canColorPick && (
                  <input
                    type="color"
                    value={value}
                    onChange={(e) => setVar(key, e.target.value)}
                    className="h-6 w-8"
                  />
                )}
                <input
                  value={value}
                  onChange={(e) => setVar(key, e.target.value)}
                  className="bevel-in min-w-0 flex-1 px-2 py-1"
                />
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

const PREFERRED_SAMPLE_RATES: Array<{ value: number | null; label: string; rationale: string }> = [
  { value: null, label: 'System default', rationale: 'Use whatever rate Windows / Linux is currently driving the DAC at.' },
  { value: 44100, label: '44.1 kHz', rationale: 'Native rate for CD-quality FLAC / MP3.' },
  { value: 48000, label: '48 kHz', rationale: 'Native rate for most video soundtracks and modern downloads.' },
  { value: 88200, label: '88.2 kHz', rationale: 'CD-multiple hi-res.' },
  { value: 96000, label: '96 kHz', rationale: 'Common DAC hi-res rate; bit-perfect for 96 kHz FLAC / WAV.' },
  { value: 176400, label: '176.4 kHz', rationale: 'High-end CD-multiple.' },
  { value: 192000, label: '192 kHz', rationale: 'Top of mainstream DAC hi-res.' },
  { value: 352800, label: '352.8 kHz', rationale: 'DSD64 PCM-equivalent.' },
  { value: 384000, label: '384 kHz', rationale: 'DSD128 / R2R DAC territory.' },
];

function BitPerfectRow({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}): JSX.Element {
  const currentTrack = usePlayerStore((s) => s.current);
  const actualRate = engine.getActualSampleRate();
  const actualLabel = actualRate != null ? `${(actualRate / 1000).toFixed(1)} kHz` : '—';
  const sourceRate = currentTrack?.sampleRate ?? null;
  const sourceLabel = sourceRate != null ? `${(sourceRate / 1000).toFixed(1)} kHz` : '—';
  // Honest indicator: does Chromium resample the file → AudioContext? (The OS
  // mixer may also resample AudioContext → device; that we can't observe here.)
  const sourceResampled = sourceRate != null && actualRate != null && Math.abs(sourceRate - actualRate) >= 1;
  // If the device rejected the preferred rate, the engine fell back — surface it
  // rather than silently showing a rate the user didn't ask for.
  const rateFallback = engine.getSampleRateFallback?.() ?? null;
  const preferred = settings.audioPreferredSampleRate;
  const matched = settings.audioBitPerfectPath && preferred != null && actualRate != null && Math.abs(actualRate - preferred) < 1;
  const willRestart = settings.audioBitPerfectPath && preferred != null && actualRate != null && Math.abs(actualRate - preferred) >= 1;
  return (
    <div className="mt-1 flex flex-col gap-2 rounded border border-line bg-panel2 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-base text-ink">
          <input
            type="checkbox"
            checked={settings.audioBitPerfectPath}
            onChange={(e) => onChange({ audioBitPerfectPath: e.target.checked })}
          />
          <span className="font-bold text-accent">Bit-Perfect Path</span>
          <span className="text-muted">· pin the AudioContext to a fixed sample rate</span>
        </label>
        <span className="ml-auto flex items-center gap-2 text-sm text-ink2">
          <span>Preferred</span>
          <select
            value={preferred == null ? '' : String(preferred)}
            disabled={!settings.audioBitPerfectPath}
            onChange={(e) => {
              const raw = e.target.value;
              const nextRate = raw === '' ? null : Number(raw);
              onChange({ audioPreferredSampleRate: nextRate });
            }}
            className="bevel-in px-2 py-1 text-sm"
          >
            {PREFERRED_SAMPLE_RATES.map((opt) => (
              <option key={String(opt.value ?? 'auto')} value={opt.value == null ? '' : String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className="text-xs text-ink2">
        Live AudioContext rate: <span className={matched ? 'text-accent' : 'text-ink'}>{actualLabel}</span>
        {matched && <span className="text-accent"> · matched</span>}
        {willRestart && <span className="text-warn"> · restart NewAmp to apply the new rate</span>}
      </div>
      {rateFallback && (
        <div className="text-xs text-warn" data-newamp-rate-fallback>
          {(rateFallback.requested / 1000).toFixed(1)} kHz not supported by your output device — running at{' '}
          {(rateFallback.actual / 1000).toFixed(1)} kHz instead.
        </div>
      )}
      {currentTrack && (
        <div className="text-xs text-ink2" data-newamp-now-playing-rate>
          Now playing:{' '}
          <span className={sourceResampled ? 'text-warn' : 'text-accent'}>{sourceLabel}</span> source →{' '}
          <span className={sourceResampled ? 'text-ink' : 'text-accent'}>{actualLabel}</span> engine
          {sourceRate != null && actualRate != null && (
            sourceResampled ? (
              <span className="text-warn"> · Chromium resamples this track (pin the engine + your DAC to {sourceLabel} for a clean path)</span>
            ) : (
              <span className="text-accent"> · no engine-side resample</span>
            )
          )}
        </div>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none font-bold uppercase tracking-[0.1em]">Real bit-perfect setup (Windows / Linux)</summary>
        <div className="mt-1 grid gap-1 pl-1 leading-normal">
          <span><strong>Windows · WASAPI Exclusive:</strong> Right-click the speaker icon → Sound settings → choose your DAC → Driver properties → Advanced → check "Allow applications to take exclusive control" + set Default Format to match the rate above. Some DACs also need their own ASIO driver; NewAmp does not yet support ASIO directly.</span>
          <span><strong>Linux · ALSA hw:</strong> Configure PipeWire / PulseAudio to expose the DAC at the target rate (`pw-cli set-param ... rate 96000` or `default-sample-rate=96000` in pulse / pipewire config). NewAmp routes through the system mixer either way, so PipeWire's bit-perfect mode applies.</span>
          <span><strong>What "Bit-Perfect Path" actually does:</strong> creates the Web Audio AudioContext at the preferred rate so Chromium does not resample on the way out. Combined with the OS-side settings above, no DSP touches the bitstream between your decoder and the DAC. Without the OS-side step, Chromium's bitstream still goes through the Windows / PipeWire mixer.</span>
          <span><strong>True kernel streaming (WASAPI Exclusive):</strong> shipped — the "Bit-Perfect Exclusive" toggle below opens the DAC directly through NewAmp's native engine (vendored miniaudio), locking every other app out while playing. This row's AudioContext pin still matters for the shared/fallback path (podcasts, non-library files).</span>
        </div>
      </details>
    </div>
  );
}

function ExclusiveModeRow({
  settings,
  onSettings,
}: {
  settings: AppSettings;
  onSettings: (s: AppSettings) => void;
}): JSX.Element {
  const setBitPerfectExclusive = usePlayerStore((s) => s.setBitPerfectExclusive);
  const setBitPerfectExclusiveDevice = usePlayerStore((s) => s.setBitPerfectExclusiveDevice);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<ExclusiveDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(() => engine.getExclusiveInfo());

  useEffect(() => {
    let cancelled = false;
    api
      .exclusiveSupported()
      .then((ok) => {
        if (!cancelled) setSupported(ok);
      })
      .catch(() => {
        if (!cancelled) setSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    api
      .exclusiveListDevices()
      .then((list) => {
        if (!cancelled) setDevices(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [supported, settings.bitPerfectExclusive]);

  // Re-render only when the exclusive status actually changes — the engine
  // notifies at ~10Hz during playback (same dedup idea as SignalPathBadge).
  useEffect(() => {
    let sig = '';
    return engine.subscribe(() => {
      const info = engine.getExclusiveInfo();
      const next = `${info.active}|${
        info.negotiated
          ? `${info.negotiated.format}@${info.negotiated.sampleRate}:${info.negotiated.bitPerfect}:${info.negotiated.resampled}`
          : ''
      }|${info.fallbackReason ?? ''}`;
      if (next !== sig) {
        sig = next;
        setLive(info);
      }
    });
  }, []);

  const enabled = settings.bitPerfectExclusive;
  const negotiated = live.active ? live.negotiated : null;

  async function toggle(next: boolean): Promise<void> {
    setBusy(true);
    try {
      const updated = await setBitPerfectExclusive(next);
      onSettings(updated);
    } finally {
      setBusy(false);
    }
  }

  async function changeDevice(raw: string): Promise<void> {
    setBusy(true);
    try {
      const updated = await setBitPerfectExclusiveDevice(raw === '' ? null : raw);
      onSettings(updated);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mt-1 flex flex-col gap-2 rounded border border-line bg-panel2 p-3"
      data-newamp-exclusive-row
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-base text-ink">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || supported === false}
            onChange={(e) => void toggle(e.target.checked)}
            data-newamp-exclusive-toggle
          />
          <span className="font-bold" style={{ color: '#d4a935' }}>Bit-Perfect Exclusive</span>
          <span className="text-muted">
            · native {exclusiveBackendLabel()}, untouched samples to the DAC
          </span>
        </label>
        <span className="ml-auto flex items-center gap-2 text-sm text-ink2">
          <span>Device</span>
          <select
            value={settings.bitPerfectExclusiveDeviceId ?? ''}
            disabled={!enabled || busy}
            onChange={(e) => void changeDevice(e.target.value)}
            className="bevel-in min-w-[200px] px-2 py-1 text-sm"
          >
            <option value="">System default</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </span>
      </div>
      {supported === false && (
        <div className="text-xs text-muted">
          The native exclusive engine isn't available in this build. Windows (WASAPI Exclusive)
          is fully verified; Linux (ALSA direct) and macOS (CoreAudio hog mode) ship
          experimentally — real-hardware verification pending.
        </div>
      )}
      {supported === true && enabled && api.platform !== 'win32' && (
        <div className="text-xs text-warn">
          {exclusiveBackendLabel()} is experimental on this platform — the engine is
          CI-compile-verified but hasn't had a real-hardware listening pass yet. Please report
          results.
        </div>
      )}
      {negotiated && (
        <div className="text-xs" data-newamp-exclusive-status>
          <span style={{ color: negotiated.bitPerfect ? '#d4a935' : 'var(--ink)' }}>
            {negotiated.deviceName} · {negotiated.format} @ {(negotiated.sampleRate / 1000).toFixed(1)} kHz
            {negotiated.bitPerfect ? ' · bit-perfect' : ''}
          </span>
          {!negotiated.bitPerfect && (
            <span className="text-warn">
              {negotiated.resampled &&
                (negotiated.sourceSampleRate
                  ? ` · resampled ${(negotiated.sourceSampleRate / 1000).toFixed(1)} → ${(negotiated.sampleRate / 1000).toFixed(1)} kHz by NewAmp (SoX)${negotiated.dsd ? ' (DSD → PCM)' : ' — set the device clock to the source rate for bit-perfect'}`
                  : ` · source rate unknown — conservatively resampled to ${(negotiated.sampleRate / 1000).toFixed(1)} kHz (SoX)`)}
              {!negotiated.resampled && negotiated.upmixed && ' · channel layout adapted'}
              {!negotiated.resampled && !negotiated.upmixed && negotiated.channelsUnknown && ' · channel layout unverified (metadata probe failed) — treated conservatively'}
              {!negotiated.resampled && !negotiated.upmixed && !negotiated.channelsUnknown && !negotiated.lossless && ' · lossy source (decoder output delivered untouched)'}
              {!negotiated.resampled && !negotiated.upmixed && !negotiated.channelsUnknown && negotiated.lossless && !negotiated.depthPreserved && ' · bit depth reduced'}
            </span>
          )}
        </div>
      )}
      {live.fallbackReason && (
        <div className="text-xs text-warn" data-newamp-exclusive-fallback>
          {live.fallbackReason}
        </div>
      )}
      {enabled && (
        <div className="text-xs text-muted">
          Exclusive mode locks the device while playing (other apps go silent), releases it ~15s
          after pause, and bypasses all DSP including software volume — use your DAC or device
          volume. Rate changes between tracks re-open the device (brief gap, same as foobar2000).
          Podcasts and non-library files automatically fall back to the shared path.
        </div>
      )}
    </div>
  );
}

function RadioBrainRow({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}): JSX.Element {
  const [status, setStatus] = useState<RadioBrainStatus | null>(null);
  const enabled = settings.radioBrainEnabled;
  const port = settings.radioBrainPort;

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const next = await api.getRadioBrainStatus();
        if (!cancelled) setStatus(next);
      } catch {
        /* ignore */
      }
    }
    void refresh();
    const handle = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [enabled, port]);

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border border-line bg-panel2 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-ink2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange({ radioBrainEnabled: e.target.checked })}
          />
          <span className="font-bold text-accent">Library Radio Brain</span>
          <span className="text-muted">· broadcast the library as a local HTTP station</span>
        </label>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted">Port</span>
          <input
            type="number"
            min={1024}
            max={65535}
            step={1}
            value={port}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next)) onChange({ radioBrainPort: Math.max(1024, Math.min(65535, Math.trunc(next))) });
            }}
            className="w-[90px] rounded border border-line bg-panel px-2 py-1 text-sm text-ink"
          />
        </span>
      </div>
      {status?.enabled && status.baseUrl && (
        <div className="text-xs text-ink2">
          Streaming at <a href={status.baseUrl} target="_blank" rel="noreferrer" className="text-accent">{status.baseUrl}</a>
          {' '}— try{' '}
          <code className="text-accent">/library.m3u</code>,{' '}
          <code className="text-accent">/random.m3u</code>, or{' '}
          <code className="text-accent">/tag/{'<name>'}.m3u</code> in VLC.
          Every route needs this install's token (playlist links include it).
        </div>
      )}
      {status?.enabled && status.remoteUrl && (
        <div className="flex items-start gap-3" data-newamp-remote-pairing>
          <RemoteQr url={status.remoteUrl} />
          <div className="flex max-w-[340px] flex-col gap-1 text-xs text-ink2">
            <span className="font-bold text-accent">NewAmp Remote</span>
            <span>
              Scan with your phone (same Wi-Fi) for a full remote: art, scrub, volume,
              prev/play/next. The link carries this install's secret — share it like a password.
            </span>
            <code className="break-all text-muted">{status.remoteUrl}</code>
            <ConfirmAction
              className="self-start"
              label="Regenerate link"
              confirmLabel="Invalidate old link?"
              tone="warn"
              onConfirm={() => {
                onChange({ radioBrainToken: null });
                // Server regenerates on next sync; old links stop working.
                pushToast({ tone: 'ok', title: 'Remote link regenerated', detail: 'Old links stop working on the next sync.' });
              }}
              title="Invalidate the current link and mint a new secret"
            />
          </div>
        </div>
      )}
      {!status?.enabled && enabled && (
        <div className="text-xs text-muted">
          {status?.error ? `Server error: ${status.error}` : 'Starting server…'}
        </div>
      )}
      {!enabled && (
        <div className="text-xs text-muted">
          When enabled, NewAmp serves M3U playlists and audio streams on the local network so VLC,
          Sonos, OBS, or any HTTP-aware client can tune your library.
        </div>
      )}
    </div>
  );
}

function RemoteQr({ url }: { url: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, url, {
      width: 148,
      margin: 1,
      color: { dark: '#0a0c0a', light: '#e8f5e9' },
    }).catch((err: unknown) => console.warn('[newamp] remote QR render failed', err));
  }, [url]);
  return (
    <canvas
      ref={canvasRef}
      width={148}
      height={148}
      className="rounded-lg border border-line"
      data-newamp-remote-qr
      aria-label="NewAmp Remote pairing QR code"
    />
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-ink2">
        {label}
      </span>
      {children}
    </div>
  );
}

function EvilandMemoryRow(): JSX.Element {
  const [stats, setStats] = useState<{ tracksWithMemory: number; totalSections: number; oldestAt: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  function refresh(): void {
    api.getVisualMemoryStats().then(setStats).catch(() => undefined);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function purge(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const removed = await api.clearAllVisualMemory();
      setStatus(removed > 0 ? `Cleared ${removed} remembered tracks.` : 'Nothing to clear.');
      if (removed > 0) {
        pushToast({
          tone: 'ok',
          title: 'Eviland memory purged',
          detail: `${removed} track${removed === 1 ? '' : 's'} reset to first-play defaults.`,
        });
      }
      refresh();
    } catch {
      setStatus('Purge failed.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const tracks = stats?.tracksWithMemory ?? 0;
  const sections = stats?.totalSections ?? 0;
  return (
    <div className="flex flex-col items-end gap-2 text-sm text-ink2">
      <span data-newamp-eviland-memory-stats>
        Eviland remembers {tracks} track{tracks === 1 ? '' : 's'} ({sections} section{sections === 1 ? '' : 's'})
      </span>
      {!confirming && (
        <button
          type="button"
          className="pxbtn"
          onClick={() => setConfirming(true)}
          disabled={busy || tracks === 0}
          data-newamp-eviland-memory-purge
        >
          Purge all
        </button>
      )}
      {confirming && (
        <div className="flex flex-col items-end gap-2">
          <span className="text-xs text-muted">
            This resets the visual look of every remembered song to its first-play default.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="pxbtn"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pxbtn"
              onClick={() => { void purge(); }}
              disabled={busy}
              data-newamp-eviland-memory-purge-confirm
            >
              {busy ? 'Purging…' : 'Purge all visual memory'}
            </button>
          </div>
        </div>
      )}
      {status && (
        <span className="text-xs text-muted">{status}</span>
      )}
    </div>
  );
}

function DiagnosticRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3">
      <span className="text-ink2">{label}</span>
      <span className="truncate font-mono">
        {children}
      </span>
    </div>
  );
}

function getOutputEngineReadout(): { sampleRate: string } {
  try {
    return { sampleRate: `${(engine.context.sampleRate / 1000).toFixed(1)} kHz` };
  } catch {
    return { sampleRate: 'AudioContext unavailable' };
  }
}

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.round(seconds / 60)} min`;
  if (hours < 100) return `${hours.toFixed(1)} hours`;
  return `${Math.round(hours)} hours`;
}
