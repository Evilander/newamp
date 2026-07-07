// ViewHeader — the one header voice for every view: a tracked-out mono eyebrow
// above the title row (title + count chip + status slot), actions right-aligned.
// Dense but breathing; all metrics come from the token ramps via
// styles/components/primitives.css (.view-header). Stage-2 view owners render
// this instead of hand-rolled header divs.

import type { ReactNode } from 'react';
import { Chip } from './Chip';

export interface ViewHeaderProps {
  /** Small tracked-out mono label above the title (usually the nav group). */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Item count (numbers are locale-formatted; strings pass through as-is). */
  count?: number | string;
  /** Inline slot next to the title — live status text, badges, spinners. */
  status?: ReactNode;
  /** Right-aligned actions row — buttons, ConfirmAction, chips. */
  actions?: ReactNode;
  className?: string;
}

export function ViewHeader({ eyebrow, title, count, status, actions, className }: ViewHeaderProps): JSX.Element {
  return (
    <header className={className ? `view-header ${className}` : 'view-header'} data-newamp-view-header>
      <div className="view-header-main">
        {eyebrow != null ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <div className="view-header-titlerow">
          <h2 className="view-header-title">{title}</h2>
          {count != null ? (
            <Chip tone="muted" size="sm" className="view-header-count">
              {typeof count === 'number' ? count.toLocaleString() : count}
            </Chip>
          ) : null}
          {status != null ? <div className="view-header-status">{status}</div> : null}
        </div>
      </div>
      {actions != null ? <div className="view-header-actions">{actions}</div> : null}
    </header>
  );
}

/** Standalone eyebrow for section sub-heads inside view bodies. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={className ? `eyebrow ${className}` : 'eyebrow'}>{children}</div>;
}
