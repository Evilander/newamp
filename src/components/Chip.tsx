// Chip — the one small-label voice for statuses, counts, and toggles. Visually
// a sibling of .format-badge / .signal-path-badge (mono, uppercase, tone tint
// over skin tokens) but sized on the type ramp and optionally interactive.
// Styling lives in styles/components/primitives.css (.chip).

import type { MouseEventHandler, ReactNode } from 'react';

export type ChipTone = 'accent' | 'muted' | 'ok' | 'warn' | 'error' | 'gold';
export type ChipSize = 'sm' | 'md';

export interface ChipProps {
  tone?: ChipTone;
  size?: ChipSize;
  /** Renders a real <button> with hover/focus states instead of a <span>. */
  interactive?: boolean;
  icon?: ReactNode;
  title?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  children: ReactNode;
  className?: string;
}

export function Chip({
  tone,
  size = 'md',
  interactive = false,
  icon,
  title,
  onClick,
  children,
  className,
}: ChipProps): JSX.Element {
  const cls = [
    'chip',
    `chip-${size}`,
    tone ? `chip-${tone}` : '',
    interactive ? 'chip-interactive' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      {icon != null ? (
        <span className="chip-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="chip-label">{children}</span>
    </>
  );

  if (interactive) {
    return (
      <button type="button" className={cls} title={title} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <span className={cls} title={title} onClick={onClick}>
      {content}
    </span>
  );
}
