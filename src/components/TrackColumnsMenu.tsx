// The popover behind the track table's "⋯" header button and the header's
// right-click: tick a column to show it, untick to hide it, and nudge it left
// or right. One layout for every track table.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  TRACK_COLUMN_LABELS,
  TRACK_COLUMNS_FIXED,
  useTrackColumns,
  type TrackColumnKey,
} from '../store/useTrackColumns';

const MENU_WIDTH = 236;
const MENU_HEIGHT = 420;

export function TrackColumnsMenu({
  at,
  available,
  onClose,
}: {
  /** Viewport point to open at (the click, or under the button). */
  at: { x: number; y: number };
  /** Columns this table can show at all. */
  available: readonly TrackColumnKey[];
  onClose: () => void;
}): JSX.Element {
  const order = useTrackColumns((s) => s.order);
  const hidden = useTrackColumns((s) => s.hidden);
  const setHidden = useTrackColumns((s) => s.setHidden);
  const moveTo = useTrackColumns((s) => s.moveTo);
  const reset = useTrackColumns((s) => s.reset);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
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
  const left = Math.max(8, Math.min(at.x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - MENU_HEIGHT - 8));

  return createPortal(
    <div
      ref={rootRef}
      className="track-columns-menu"
      role="dialog"
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
                onClick={() => before && moveTo(key, order.indexOf(before))}
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
                onClick={() => after && moveTo(key, order.indexOf(after))}
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
        <button type="button" className="pxbtn is-active" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
