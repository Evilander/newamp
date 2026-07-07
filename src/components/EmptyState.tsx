// EmptyState — generalizes the EmptyLibrary hero language (centered copy over
// a soft accent wash, actions row) into a reusable empty surface. size='view'
// fills a whole view; size='panel' is the compact variant for side panels and
// cards. Styling: styles/components/primitives.css (.empty-state).

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  size?: 'view' | 'panel';
}

export function EmptyState({ icon, title, body, actions, size = 'view' }: EmptyStateProps): JSX.Element {
  return (
    <div className={`empty-state empty-state-${size}`} data-newamp-empty-state={size}>
      {size === 'view' ? <div className="empty-state-glow" aria-hidden="true" /> : null}
      <div className="empty-state-inner">
        {icon != null ? (
          <div className="empty-state-icon" aria-hidden="true">
            {icon}
          </div>
        ) : null}
        <div className="empty-state-title">{title}</div>
        {body != null ? <div className="empty-state-body">{body}</div> : null}
        {actions != null ? <div className="empty-state-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
