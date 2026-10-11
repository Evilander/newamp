// The popover behind the track table's "Columns" button, its header glyph and
// the header's right-click: tick a column to show it, untick to hide it, and
// nudge it left or right. One layout for every track table.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../hooks/useModalFocus';
import {
  TRACK_COLUMN_LABELS,
  TRACK_COLUMNS_FIXED,
  useTrackColumns,
  type TrackColumnKey,
} from '../store/useTrackColumns';

const MENU_WIDTH = 236;
// Used for the first frame only; the real height is measured before paint.
const MENU_HEIGHT_GUESS = 420;
const VIEWPORT_MARGIN = 8;

/** Every control that opens this menu carries the attribute, so a press on one reads as a toggle. */
export const COLUMNS_OPENER_SELECTOR = '[data-newamp-track-columns-open]';

export type ColumnsMenuCloseReason = 'outside' | 'dismiss';

export function isColumnsOpener(target: EventTarget | null): boolean {
  return !!target && typeof (target as Element).closest === 'function' && !!(target as Element).closest(COLUMNS_OPENER_SELECTOR);
}

/** Top-left corner that keeps a menu of this size inside the viewport, as close to `at` as it fits. */
export function placeColumnsMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(at.x, viewport.width - size.width - VIEWPORT_MARGIN)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(at.y, viewport.height - size.height - VIEWPORT_MARGIN)),
  };
}

export function TrackColumnsMenu({
  at,
  available,
  onClose,
}: {
  /** Viewport point to open at (the click, or under the button). */
  at: { x: number; y: number };
  /** Columns this table can show at all. */
  available: readonly TrackColumnKey[];
  /** 'outside' is a press anywhere off the menu; the opener uses it to tell that press from its own click. */
  onClose: (reason: ColumnsMenuCloseReason) => void;
}): JSX.Element {
  const order = useTrackColumns((s) => s.order);
  const hidden = useTrackColumns((s) => s.hidden);
  const setHidden = useTrackColumns((s) => s.setHidden);
  const moveTo = useTrackColumns((s) => s.moveTo);
  const reset = useTrackColumns((s) => s.reset);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstToggleRef = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState(MENU_HEIGHT_GUESS);
  useModalFocus(rootRef, firstToggleRef, true);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      // The dialog makes the rest of the page inert, which sends a press on an
      // opener to the page behind it: that press closes the menu here and the
      // click never reaches the button. If a press does land on an opener, it
      // is the first half of the click that toggles the menu closed; closing
      // here as well made that click reopen it.
      if (isColumnsOpener(event.target)) return;
      onClose('outside');
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose('dismiss');
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const rows = order.filter((key) => !TRACK_COLUMNS_FIXED.includes(key) && available.includes(key));

  // At a large Text size or with every column offered the list outgrows the
  // fixed height the popover used to assume; measure what it really is.
  useLayoutEffect(() => {
    if (rootRef.current) setHeight(rootRef.current.offsetHeight);
  }, [rows.length]);

  // Reordering moves the row's DOM node, which drops focus; put it back on the
  // same arrow, or the other one when this row has just reached an end.
  function move(key: TrackColumnKey, toIndex: number, direction: 'left' | 'right'): void {
    moveTo(key, toIndex);
    window.setTimeout(() => {
      const row = rootRef.current?.querySelector(`[data-newamp-track-columns-row="${key}"]`);
      const same = row?.querySelector<HTMLButtonElement>(`[data-newamp-track-columns-${direction}]`);
      const other = row?.querySelector<HTMLButtonElement>(`[data-newamp-track-columns-${direction === 'left' ? 'right' : 'left'}]`);
      (same && !same.disabled ? same : other)?.focus();
    }, 0);
  }

  const { left, top } = placeColumnsMenu(
    at,
    { width: MENU_WIDTH, height },
    { width: window.innerWidth, height: window.innerHeight },
  );

  return createPortal(
    <div
      ref={rootRef}
      className="track-columns-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Table columns"
      data-newamp-track-columns-menu
      style={{ left, top, width: MENU_WIDTH }}
    >
      <div className="track-columns-menu-head">Columns</div>
      <ul className="track-columns-menu-list">
        {rows.map((key, index) => {
          const label = TRACK_COLUMN_LABELS[key];
          const shown = !hidden.includes(key);
          const before = rows[index - 1];
          const after = rows[index + 1];
          return (
            <li key={key} data-newamp-track-columns-row={key}>
              <label className="track-columns-menu-toggle">
                <input
                  ref={index === 0 ? firstToggleRef : undefined}
                  type="checkbox"
                  checked={shown}
                  onChange={(event) => setHidden(key, !event.currentTarget.checked)}
                />
                <span>{label}</span>
              </label>
              <button
                type="button"
                className="track-columns-menu-move"
                disabled={!before}
                aria-label={`Move ${label} left`}
                title="Move left"
                data-newamp-track-columns-left
                onClick={() => before && move(key, order.indexOf(before), 'left')}
              >
                ◀
              </button>
              <button
                type="button"
                className="track-columns-menu-move"
                disabled={!after}
                aria-label={`Move ${label} right`}
                title="Move right"
                data-newamp-track-columns-right
                onClick={() => after && move(key, order.indexOf(after), 'right')}
              >
                ▶
              </button>
            </li>
          );
        })}
      </ul>
      <div className="track-columns-menu-foot">
        <button type="button" className="pxbtn" onClick={reset} data-newamp-track-columns-reset>
          Reset
        </button>
        <button type="button" className="pxbtn is-active" onClick={() => onClose('dismiss')}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
