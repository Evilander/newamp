// FirstLaunchTutorial — the "win the first hour" card. Music comes first: this
// overlay's only job is to point at the one-click scan hero waiting behind it
// and teach the three keys that matter. AI setup is a single optional line
// that links to Settings — no key is ever typed here.

import { useState } from 'react';
import type { AppSettings } from '@shared/types';
import { BrandLogo } from './BrandLogo';

const TOUR_STEPS: Array<{ keys: string; title: string; detail: string }> = [
  {
    keys: 'Ctrl+K',
    title: 'Anything',
    detail: 'One box for tracks, albums, playlists, views, and commands — or just ask in plain words.',
  },
  {
    keys: 'F',
    title: 'Fullscreen visualizer',
    detail: 'Take the stage full screen. Esc brings the library back.',
  },
  {
    keys: 'Ctrl+M',
    title: 'Deck mode',
    detail: 'Shrink into the slim windowshade deck; the skin menu holds the larger shapes.',
  },
];

const KBD_STYLE = {
  display: 'inline-block',
  padding: '1px 6px',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  background: 'var(--display-bg)',
  color: 'var(--display-fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-2xs)',
  letterSpacing: '0.08em',
} as const;

export function FirstLaunchTutorial({
  onFinish,
  onOpenSettings,
}: {
  settings: AppSettings;
  onFinish: (patch?: { openaiApiKey?: string | null; openaiModel?: string }) => Promise<void>;
  onOpenSettings: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function finish(): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      await onFinish();
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
            <h1>Scan your Music folder</h1>
            <p>
              NewAmp plays the files already on this machine — no cloud, no account, no telemetry.
              The scan button is waiting right behind this card: one click and your library builds
              itself while you listen.
            </p>
          </div>
        </header>

        <div className="first-launch-steps">
          {TOUR_STEPS.map((step) => (
            <div key={step.keys}>
              <strong>
                <kbd style={KBD_STYLE}>{step.keys}</kbd> {step.title}
              </strong>
              <span>{step.detail}</span>
            </div>
          ))}
        </div>

        <p
          data-newamp-openai-key-prompt
          style={{ margin: '18px 0 0', color: 'var(--muted)', fontSize: 'var(--text-xs)', lineHeight: 1.5 }}
        >
          Optional: AI liner notes — add an OpenAI key any time in{' '}
          <button
            type="button"
            onClick={onOpenSettings}
            disabled={busy}
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              color: 'var(--accent)',
              textDecoration: 'underline',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Settings
          </button>
          .{' '}
          <span data-newamp-live-services-onboarding>
            Last.fm scrobbling lives there too. Private recordings still play normally when web
            facts, lyrics, or scrobbles do not exist.
          </span>
        </p>

        <footer className="first-launch-actions">
          <button className="pxbtn is-active" onClick={() => void finish()} disabled={busy}>
            Start listening
          </button>
          {status && <span>{status}</span>}
        </footer>
      </section>
    </div>
  );
}
