import { useState } from 'react';

export interface ViewOnboardingProps {
  viewId: string;
  title: string;
  lede: string;
  bullets: string[];
  cta?: string;
}

const STORAGE_PREFIX = 'newamp:onboarding:v1:';

function storageKey(viewId: string): string {
  return `${STORAGE_PREFIX}${viewId}`;
}

function readDismissed(viewId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey(viewId)) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(viewId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(viewId), '1');
  } catch {
    /* ignore quota / privacy mode */
  }
}

/**
 * Inline onboarding card that appears the first time a user opens a view.
 * Dismissed state persists per viewId so once the user understands what
 * Discover / Mixes / Living Tags / Sonic Atlas are, the card stays hidden.
 *
 * Renders nothing once dismissed, so it's safe to mount at the top of any
 * view without affecting the steady-state layout.
 */
export function ViewOnboarding({ viewId, title, lede, bullets, cta }: ViewOnboardingProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => readDismissed(viewId));
  if (dismissed) return null;
  return (
    <section
      className="view-onboarding"
      data-newamp-view-onboarding={viewId}
      role="region"
      aria-label={`Welcome to ${title}`}
    >
      <header className="view-onboarding-head">
        <span className="view-onboarding-kicker">New to NewAmp · {title}</span>
        <h2 className="view-onboarding-title">{title}</h2>
        <p className="view-onboarding-lede">{lede}</p>
      </header>
      <ul className="view-onboarding-list">
        {bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
      <footer className="view-onboarding-foot">
        {cta ? <span className="view-onboarding-cta">{cta}</span> : null}
        <button
          className="pxbtn is-active"
          type="button"
          data-newamp-view-onboarding-dismiss={viewId}
          onClick={() => {
            writeDismissed(viewId);
            setDismissed(true);
          }}
        >
          Got it
        </button>
      </footer>
    </section>
  );
}
