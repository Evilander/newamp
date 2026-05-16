import { useEffect, useState } from 'react';
import type {
  AppSettings,
  BuiltInTheme,
  CustomSkin,
  LastfmOutboxStatus,
  SupportBackupResult,
  SupportDiagnostics,
  SupportRestoreResult,
} from '@shared/types';
import { engine, usePlayerStore } from '../../store/usePlayerStore';
import { api, inElectron, DEFAULT_SETTINGS } from '../../lib/api';
import { SKIN_VARIABLES, readCurrentSkinVariables } from '../../lib/skins';
import { normalizeAudioOutputDeviceId, uniqueAudioOutputDevices } from '@shared/audio-output';
import type { AudioOutputDeviceOption } from '@shared/audio-output';
import { MAX_PREAMP_DB, MIN_PREAMP_DB, PREAMP_STEP_DB, normalizePreampDb } from '@shared/audio-limiter';
import { ShellPicker } from '../ShellPicker';

const THEMES: Array<{ id: BuiltInTheme; label: string; tag: string; palette: string[] }> = [
  { id: 'classic', label: 'Classic', tag: 'Vintage Winamp 2.x — cast-metal chrome, green LCD', palette: ['#2c3438', '#00ff66', '#c8d4d8'] },
  { id: 'ops', label: 'Ops', tag: 'Trader-dashboard density — emerald cyan, hex grid', palette: ['#0b1014', '#34d399', '#e2e8ee'] },
  { id: 'midnight', label: 'Midnight', tag: 'Clean modern dark with violet accents', palette: ['#11141b', '#7c5cff', '#e8ecf3'] },
  { id: 'neon', label: 'Neon', tag: 'Cyberpunk magenta with scanlines', palette: ['#160a26', '#ff36e0', '#ffe9fe'] },
  { id: 'amber', label: 'Amber', tag: '70s terminal phosphor orange', palette: ['#1b1408', '#ffb000', '#ffe2a1'] },
];

const EXTRA_THEMES: Array<{ id: BuiltInTheme; label: string; tag: string; palette: string[] }> = [
  { id: 'oxide', label: 'Oxide', tag: 'Industrial steel with cyan meters and rust warning lights', palette: ['#101419', '#51e6d8', '#f38d3c'] },
  { id: 'steel', label: 'Steel', tag: 'Late-90s brushed metal deck with blue LCD', palette: ['#c5cad0', '#2357d8', '#101826'] },
  { id: 'walnut', label: 'Record Deck', tag: 'Turntable plinth, round album platter, amber meters', palette: ['#21160f', '#f0a629', '#d7c0a0'] },
  { id: 'jukebox', label: 'Jukebox', tag: 'Chrome arch, bubble controls, glowing title glass', palette: ['#2a1018', '#ffcf4a', '#52f0d0'] },
  { id: 'terminal', label: 'Vintage Computer', tag: 'CRT shell, phosphor display, square hardware keys', palette: ['#101612', '#59ff85', '#cbd8c8'] },
  { id: 'ice', label: 'Ice', tag: 'Frosted silver skin with cyan glass display', palette: ['#e8eef2', '#00a6d6', '#14212a'] },
  { id: 'miami', label: 'Miami', tag: 'Bright daylight deck with coral controls and teal LCD', palette: ['#f3f4ef', '#ff4f79', '#10282e'] },
  { id: 'mono', label: 'Mono', tag: 'High-contrast black, white, and red for long sessions', palette: ['#080808', '#f5f5f0', '#ff3d3d'] },
];

export function SettingsView(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState<{ tracks: number; albums: number; artists: number; duration: number } | null>(null);
  const [lastfmStatus, setLastfmStatus] = useState<string | null>(null);
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

  if (!settings) return <div />;
  const outputEngine = getOutputEngineReadout();

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
      setLastfmStatus('Browser opened. Approve Newamp, then complete the connection.');
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
        artist: 'Newamp QA',
        title: 'Settings Now Playing Test',
        album: 'Newamp Release Proof',
        albumArtist: 'Newamp QA',
        duration: 181,
        trackNumber: 1,
      });
      setLastfmStatus('Last.fm now-playing test sent.');
    } catch (err) {
      setLastfmStatus(err instanceof Error ? err.message : 'Last.fm now-playing test failed.');
    }
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
    setSupportBackupStatus('Choose a Newamp backup folder to restore...');
    try {
      const result = await api.restoreSupportBackup();
      if (!result) {
        setSupportBackupStatus('Restore canceled.');
        return;
      }
      setSupportRestore(result);
      setSupportBackupStatus(
        `Restored ${result.restored.length.toLocaleString()} item(s). Restart Newamp to refresh every view.`,
      );
      await refreshSupportDiagnostics();
    } catch (err) {
      setSupportBackupStatus(err instanceof Error ? err.message : 'Restore failed.');
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="mx-auto w-full max-w-[820px] space-y-8 px-8 py-8">
        <header>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Tune the look, your library, and your network integrations.
          </p>
        </header>

        <section className="bevel-out flex flex-col gap-4 p-6">
          <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
            Library
          </h2>
          <div className="flex flex-col gap-2">
            {settings.libraryRoots.length === 0 && (
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
                No folders yet. Add one to begin.
              </div>
            )}
            {settings.libraryRoots.map((r) => (
              <div
                key={r}
                className="bevel-in flex items-center justify-between px-3 py-2 text-[12px]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                <span className="truncate">{r}</span>
                <button className="pxbtn" onClick={() => void removeRoot(r)}>
                  Remove
                </button>
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
              <span className="ml-auto text-[12px]" style={{ color: 'var(--muted)' }}>
                {stats.tracks.toLocaleString()} tracks · {stats.albums.toLocaleString()} albums ·{' '}
                {stats.artists.toLocaleString()} artists · {formatHours(stats.duration)}
              </span>
            )}
          </div>
          <Row label="Auto-watch library">
            <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--ink-2)' }}>
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
        </section>

        <section className="bevel-out flex flex-col gap-3 p-6">
          <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
            Shell · Layout
          </h2>
          <p className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
            The shell changes the chrome — sidebar, transport, glass effects. The skin (below) changes the
            colors. Mix and match: Liquid Glass + Amber, Modern + Midnight, Concourse + Ops.
          </p>
          <ShellPicker />
        </section>

        <section className="bevel-out flex flex-col gap-4 p-6">
          <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
            Skin
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[...THEMES, ...EXTRA_THEMES].map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  void setTheme(t.id);
                  setSettings({ ...settings, theme: t.id });
                }}
                className="flex flex-col gap-2 p-3 text-left transition-all"
                style={{
                  background: t.palette[0],
                  borderRadius: 'var(--radius-card)',
                  outline:
                    settings.theme === t.id ? `2px solid ${t.palette[1]}` : '1px solid var(--line)',
                  boxShadow: settings.theme === t.id ? `0 0 18px ${t.palette[1]}55` : undefined,
                }}
              >
                <div className="flex gap-1">
                  {t.palette.map((c, i) => (
                    <span
                      key={i}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        background: c,
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
                      }}
                    />
                  ))}
                </div>
                <div className="text-[13px] font-semibold" style={{ color: t.palette[2] }}>
                  {t.label}
                </div>
                <div className="text-[10px]" style={{ color: t.palette[2], opacity: 0.7 }}>
                  {t.tag}
                </div>
              </button>
            ))}
            {settings.customSkin && (
              <button
                onClick={() => {
                  void setTheme('custom');
                  setSettings({ ...settings, theme: 'custom' });
                }}
                className="flex flex-col gap-2 p-3 text-left transition-all"
                style={{
                  background: settings.customSkin.variables['--panel'] || 'var(--panel)',
                  borderRadius: 'var(--radius-card)',
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
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        background: settings.customSkin?.variables[key] || 'var(--panel)',
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
                      }}
                    />
                  ))}
                </div>
                <div className="text-[13px] font-semibold">
                  {settings.customSkin.name}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--ink-2)' }}>
                  Custom skin
                </div>
              </button>
            )}
          </div>
        </section>

        <SkinWorkshop settings={settings} onSaved={setSettings} />

        <section className="bevel-out flex flex-col gap-4 p-6">
          <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
            Playback
          </h2>
          <Row label="Crossfade">
            <select
              value={settings.crossfadeMs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setCrossfadeMs(v).then(() => {
                  setSettings({ ...settings, crossfadeMs: v });
                });
              }}
              className="bevel-in px-2 py-1 text-[13px]"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
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
              onChange={(e) => {
                const replayGain = e.target.value as AppSettings['replayGain'];
                setReplayGainMode(replayGain).then(() => {
                  setSettings({ ...settings, replayGain });
                });
              }}
              className="bevel-in px-2 py-1 text-[13px]"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
            >
              <option value="off">Off</option>
              <option value="track">Track gain</option>
              <option value="album">Album gain</option>
            </select>
          </Row>
          <Row label="Clipping protection">
            <label className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--ink)' }}>
              <input
                type="checkbox"
                checked={settings.limiterEnabled}
                onChange={(e) => {
                  const limiterEnabled = e.target.checked;
                  setLimiterEnabled(limiterEnabled).then(() => {
                    setSettings({ ...settings, limiterEnabled });
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
                onChange={(e) => {
                  const preampDb = normalizePreampDb(e.target.valueAsNumber);
                  setPreampDb(preampDb).then(() => {
                    setSettings({ ...settings, preampDb });
                  });
                }}
                className="w-[220px]"
              />
              <span className="min-w-[58px] text-right text-[12px]" style={{ color: 'var(--ink-2)' }}>
                {settings.preampDb.toFixed(1)} dB
              </span>
            </div>
          </Row>
          <Row label="Output engine">
            <div className="audio-engine-readout">
              <span>{outputEngine.sampleRate}</span>
              <span>32-bit float / Web Audio</span>
            </div>
          </Row>
          <Row label="Audio Output">
            <div className="flex max-w-[560px] flex-wrap items-center justify-end gap-2">
              <select
                value={settings.audioOutputDeviceId ?? ''}
                onChange={(e) => void changeAudioOutput(e.target.value)}
                className="bevel-in min-w-[220px] px-2 py-1 text-[13px]"
                style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
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
                <span className="basis-full text-right text-[11px]" style={{ color: 'var(--ink-2)' }}>
                  {audioOutputStatus}
                </span>
              )}
            </div>
          </Row>
        </section>

        <section className="bevel-out flex flex-col gap-4 p-6">
          <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
            Last.fm
          </h2>
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            Last.fm is optional. Newamp needs your own Last.fm API account because scrobbling is tied
            to your Last.fm identity, not to a shared Newamp account. Create one at{' '}
            <a
              href="https://www.last.fm/api/account/create"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              last.fm/api/account/create
            </a>
            , use <span style={{ color: 'var(--ink)' }}>Newamp</span> as the application name,
            and leave callback URL blank for desktop auth.
          </div>
          <Row label="API key">
            <input
              value={settings.lastfmApiKey ?? ''}
              onChange={(e) => setSettings({ ...settings, lastfmApiKey: e.target.value || null })}
              className="bevel-in w-[320px] px-2 py-1 text-[13px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
            />
          </Row>
          <Row label="Shared secret">
            <input
              type="password"
              value={settings.lastfmSharedSecret ?? ''}
              onChange={(e) => setSettings({ ...settings, lastfmSharedSecret: e.target.value || null })}
              className="bevel-in w-[320px] px-2 py-1 text-[13px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
            />
          </Row>
          <Row label="Account">
            <span className="text-[12px]" style={{ color: settings.lastfmUsername ? 'var(--accent)' : 'var(--muted)' }}>
              {settings.lastfmUsername ? `Connected as ${settings.lastfmUsername}` : 'Not connected'}
            </span>
          </Row>
          <Row label="Scrobbling">
            <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--ink-2)' }}>
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
            <span className="text-[12px]" style={{ color: lastfmOutbox?.pending ? 'var(--warn)' : 'var(--muted)' }}>
              {lastfmOutbox
                ? `${lastfmOutbox.pending} pending${lastfmOutbox.lastError ? ` - ${lastfmOutbox.lastError}` : ''}`
                : 'Checking...'}
            </span>
          </Row>
          <div className="flex flex-wrap items-center gap-2">
            <button className="pxbtn" onClick={() => void saveLastfmCredentials()}>
              Save credentials
            </button>
            <button className="pxbtn" onClick={() => void lastfmStartAuth()}>
              Open Last.fm auth
            </button>
            <button className="pxbtn is-active" onClick={() => void completeLastfmAuth()}>
              Complete auth
            </button>
            <button className="pxbtn" onClick={() => void disconnectLastfm()} disabled={!settings.lastfmSessionKey}>
              Disconnect
            </button>
            <button className="pxbtn" onClick={() => void flushLastfmOutbox()} disabled={!settings.lastfmSessionKey || !lastfmOutbox?.pending}>
              Flush cache
            </button>
            <button className="pxbtn" onClick={() => void testLastfmNowPlaying()} disabled={!settings.lastfmSessionKey}>
              Test now playing
            </button>
            {lastfmStatus && (
              <span className="text-[11px]" style={{ color: 'var(--ink-2)' }}>
                {lastfmStatus}
              </span>
            )}
          </div>
        </section>

        <section className="bevel-out flex flex-col gap-2 p-6 text-[12px]" style={{ color: 'var(--muted)' }}>
          <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
            About
          </h2>
          <div>
            Newamp v{api.appVersion} · Built for {api.platform}
            {!inElectron && (
              <span style={{ color: 'var(--warn)' }}> · browser preview (no library access)</span>
            )}
          </div>
          <div>
            Lyrics by{' '}
            <a href="https://lrclib.net" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
              LRCLIB
            </a>
            . Radio by{' '}
            <a href="https://www.radio-browser.info" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
              radio-browser.info
            </a>
            . No telemetry. Accounts are optional. Your library never leaves your machine.
          </div>
        </section>

        <section className="bevel-out flex flex-col gap-3 p-6 text-[12px]" style={{ color: 'var(--muted)' }}>
          <div className="flex items-center gap-2">
            <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
              Support Diagnostics
            </h2>
            <button className="pxbtn ml-auto" onClick={() => void refreshSupportDiagnostics()}>
              Refresh
            </button>
          </div>
          {supportDiagnostics ? (
            <>
              <DiagnosticRow label="App">
                Newamp v{supportDiagnostics.appVersion} / Electron {supportDiagnostics.electronVersion}
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
                <button className="pxbtn" onClick={() => void restoreBackup()}>
                  Restore backup
                </button>
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
                <div className="text-[11px]" style={{ color: supportBackup ? 'var(--accent)' : 'var(--ink-2)' }}>
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
  const [name, setName] = useState(settings.customSkin?.name ?? 'Newamp Custom');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [skinFileStatus, setSkinFileStatus] = useState<string | null>(null);

  useEffect(() => {
    setName(settings.customSkin?.name ?? 'Newamp Custom');
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
      name: name.trim() || 'Newamp Custom',
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
  }

  return (
    <section className="bevel-out flex flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <h2 className="text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
          Skin Workshop
        </h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bevel-in ml-auto px-2 py-1 text-[12px]"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <button className="pxbtn" onClick={reset}>Reset</button>
        <button className="pxbtn" onClick={() => void importSkin()}>Import skin</button>
        <button className="pxbtn" onClick={() => void exportSkin()}>Export skin</button>
        <button className="pxbtn is-active" onClick={() => void save()}>Save skin</button>
      </div>
      {skinFileStatus && (
        <div className="text-[11px]" style={{ color: 'var(--ink-2)' }}>
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
              className="grid items-center gap-2 text-[11px]"
              style={{ gridTemplateColumns: '120px 26px minmax(0, 1fr)', color: 'var(--ink-2)' }}
            >
              <span>{key.replace('--', '')}</span>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 'var(--radius)',
                  background: value || 'transparent',
                  boxShadow: 'inset 0 0 0 1px var(--line)',
                }}
              />
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
                  style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
                />
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function DiagnosticRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
      <span className="truncate" style={{ fontFamily: 'var(--font-mono)' }}>
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
