import { useState } from 'react';
import type { AppSettings } from '@shared/types';
import { DEFAULT_SETTINGS } from '../lib/api';
import { AI_ASSIST_OPTIONS } from '../lib/aiAssist';
import { BrandLogo } from './BrandLogo';

export function FirstLaunchTutorial({
  settings,
  onFinish,
  onOpenSettings,
}: {
  settings: AppSettings;
  onFinish: (patch?: { openaiApiKey?: string | null; openaiModel?: string }) => Promise<void>;
  onOpenSettings: () => void;
}): JSX.Element {
  const [openaiApiKey, setOpenAiApiKey] = useState(settings.openaiApiKey ?? '');
  const [openaiModel, setOpenAiModel] = useState(settings.openaiModel || DEFAULT_SETTINGS.openaiModel);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function finish(saveKey: boolean): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      await onFinish(saveKey
        ? {
            openaiApiKey: openaiApiKey.trim() || null,
            openaiModel: openaiModel.trim() || DEFAULT_SETTINGS.openaiModel,
          }
        : undefined);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not save first-launch settings.');
      setBusy(false);
    }
  }

  return (
    <div className="first-launch-overlay" data-newamp-first-launch-tutorial>
      <section className="first-launch-panel bevel-out">
        <header className="first-launch-header">
          <BrandLogo size={72} title="NewAmp" />
          <div>
            <div className="first-launch-kicker">First launch</div>
            <h1>Set up NewAmp</h1>
            <p>
              Add music, choose a deck, and optionally unlock ChatGPT-powered library features.
            </p>
          </div>
        </header>

        <div className="first-launch-steps">
          <div>
            <strong>1. Add your music folder</strong>
            <span>Use Settings to add local folders such as K:\music, then scan once.</span>
          </div>
          <div>
            <strong>2. Pick the player shape</strong>
            <span>DECK opens the restored slim windowshade first; the skin menu holds the larger shapes.</span>
          </div>
          <div>
            <strong>3. Use the library rails</strong>
            <span>Home builds mixes, recent imports, smart stations, playlists, and listening history from your files.</span>
          </div>
        </div>

        <div className="first-launch-ai" data-newamp-openai-key-prompt>
          <div>
            <div className="first-launch-kicker">Integrated features</div>
            <h2>ChatGPT API key</h2>
            <p>
              Optional. Playback works without it; adding a key enables local music context, artist notes,
              real On Air liner-note drafts, metadata repair prompts, and listening companions.
            </p>
          </div>
          <div className="ai-assist-option-grid">
            {AI_ASSIST_OPTIONS.slice(0, 4).map((option) => (
              <div key={option.id} className="ai-assist-option">
                <strong>{option.label}</strong>
                <span>{option.detail}</span>
              </div>
            ))}
          </div>
          <label className="first-launch-field">
            <span>API key</span>
            <input
              type="password"
              value={openaiApiKey}
              onChange={(event) => setOpenAiApiKey(event.target.value)}
              placeholder="sk-..."
            />
          </label>
          <label className="first-launch-field">
            <span>Model</span>
            <input
              value={openaiModel}
              onChange={(event) => setOpenAiModel(event.target.value)}
            />
          </label>
        </div>

        <footer className="first-launch-actions">
          <button className="pxbtn" onClick={onOpenSettings} disabled={busy}>
            Open Settings
          </button>
          <button className="pxbtn" onClick={() => void finish(false)} disabled={busy}>
            Skip key
          </button>
          <button className="pxbtn is-active" onClick={() => void finish(true)} disabled={busy}>
            Save and start
          </button>
          {status && <span>{status}</span>}
        </footer>
      </section>
    </div>
  );
}
