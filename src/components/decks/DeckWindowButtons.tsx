import type { CSSProperties } from 'react';

const DANGER: CSSProperties = { color: 'var(--error)' };

/**
 * Minimize and close for a deck's header. The compact window is frameless and
 * hides the macOS traffic lights while it is a deck, so every platform needs
 * these. A skin that does not keep the pair together can render one half at a
 * time with `show`.
 */
export function DeckWindowButtons({
  onMinimize,
  onClose,
  className,
  danger = false,
  minimizeGlyph = '_',
  closeGlyph = '×',
  show = 'both',
}: {
  onMinimize: () => void;
  onClose: () => void;
  className?: string;
  /** Tints the close button with the error colour. */
  danger?: boolean;
  minimizeGlyph?: string;
  closeGlyph?: string;
  show?: 'both' | 'minimize' | 'close';
}): JSX.Element {
  return (
    <>
      {show !== 'close' && (
        <button type="button" className={className} onClick={onMinimize} title="Minimize" aria-label="Minimize">
          {minimizeGlyph}
        </button>
      )}
      {show !== 'minimize' && (
        <button
          type="button"
          className={className}
          onClick={onClose}
          title="Close"
          aria-label="Close"
          style={danger ? DANGER : undefined}
        >
          {closeGlyph}
        </button>
      )}
    </>
  );
}
