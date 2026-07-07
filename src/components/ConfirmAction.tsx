// ConfirmAction — two-step arm-then-fire for destructive buttons, in place of
// blocking confirm() dialogs. First activation swaps the label to the danger
// tone; a second activation within 3s fires onConfirm. Disarms on blur,
// mouseleave, Escape, or the 3s timer. Renders a .pxbtn so every shell dresses
// it natively; the armed tone lives in styles/components/primitives.css.

import { useEffect, useRef, useState } from 'react';

export interface ConfirmActionProps {
  label: string;
  /** Armed-state label. Defaults to "Sure?". */
  confirmLabel?: string;
  onConfirm: () => void;
  tone?: 'error' | 'warn';
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  title?: string;
}

/** How long the armed state stays live before it stands down. */
const ARM_WINDOW_MS = 3000;

export function ConfirmAction({
  label,
  confirmLabel = 'Sure?',
  onConfirm,
  tone = 'error',
  size = 'md',
  disabled,
  className,
  title,
}: ConfirmActionProps): JSX.Element {
  const [armed, setArmed] = useState(false);
  const disarmHandle = useRef<number | null>(null);

  function clearDisarmTimer(): void {
    if (disarmHandle.current !== null) {
      window.clearTimeout(disarmHandle.current);
      disarmHandle.current = null;
    }
  }

  function disarm(): void {
    clearDisarmTimer();
    setArmed(false);
  }

  function activate(): void {
    if (disabled) return;
    if (armed) {
      disarm();
      onConfirm();
      return;
    }
    setArmed(true);
    clearDisarmTimer();
    disarmHandle.current = window.setTimeout(() => {
      disarmHandle.current = null;
      setArmed(false);
    }, ARM_WINDOW_MS);
  }

  useEffect(() => clearDisarmTimer, []);

  const cls = [
    'pxbtn',
    'confirm-action',
    `confirm-tone-${tone}`,
    size === 'sm' ? 'confirm-sm' : '',
    armed ? 'is-armed' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cls}
      disabled={disabled}
      aria-live="polite"
      data-newamp-confirm={armed ? 'armed' : 'idle'}
      title={armed ? 'Press again to confirm' : title}
      onClick={activate}
      onBlur={disarm}
      onMouseLeave={() => {
        if (armed) disarm();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation();
          disarm();
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
