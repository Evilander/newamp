import { useState } from 'react';

export interface ViewOnboardingProps {
  viewId: string;
  title: string;
  lede: string;
  bullets: string[];
  cta?: string;
  /**
   * Controlled re-open: when true the card renders even after dismissal (the
   * HelpDot "?" path), and "Got it" calls onClose instead of only persisting.
   */
  forceVisible?: boolean;
  onClose?: () => void;
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
 * Discover / Mixes / Living Tags are, the card stays hidden — but it is
 * never gone for good: any view can mount a HelpDot next to its title that
 * re-opens this card on demand (forceVisible).
 *
 * Renders nothing once dismissed, so it's safe to mount at the top of any
 * view without affecting the steady-state layout.
 */
export function ViewOnboarding({
  viewId,
  title,
  lede,
  bullets,
  cta,
  forceVisible,
  onClose,
}: ViewOnboardingProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => readDismissed(viewId));
  if (dismissed && !forceVisible) return null;
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
            onClose?.();
          }}
        >
          Got it
        </button>
      </footer>
    </section>
  );
}

/**
 * The "?" affordance for view titles. Drops next to any header and toggles
 * the view's ViewOnboarding card, so "what is this view?" always has a
 * one-click answer — not just on first run. Render the card wherever the
 * view wants it:
 *
 *   const help = useViewHelp();
 *   <HelpDot help={help} label="About Discover" />
 *   <ViewOnboarding {...content} forceVisible={help.open} onClose={help.close} />
 */
export function useViewHelp(): { open: boolean; close: () => void; toggle: () => void } {
  const [open, setOpen] = useState(false);
  return {
    open,
    close: () => setOpen(false),
    toggle: () => setOpen((v) => !v),
  };
}

export function HelpDot({
  help,
  label,
}: {
  help: { open: boolean; toggle: () => void };
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="view-help-dot"
      data-newamp-view-help
      aria-label={label}
      aria-expanded={help.open}
      title={label}
      onClick={help.toggle}
    >
      ?
    </button>
  );
}
