// The popover behind "Customise" in the sidebar and a right-click on it: tick
// an item to show it, untick to hide it, and nudge it up or down inside its
// group. Settings can't be hidden. Reset puts the whole sidebar back.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../hooks/useModalFocus';
import { PANEL_MARGIN, PANEL_TOP_LIMIT, placeInViewport } from '../lib/floating-panel';
import { SIDEBAR_PINNED_ITEMS, useSidebarLayout } from '../store/useSidebarLayout';

const MENU_WIDTH = 252;
// Used for the first frame only; the real height is measured before paint.
const MENU_HEIGHT_GUESS = 520;

/** Every control that opens this menu carries the attribute, so a press on one reads as a toggle. */
export const SIDEBAR_MENU_OPENER_SELECTOR = '[data-newamp-sidebar-customise-open]';

export interface SidebarMenuGroup {
  id: string;
  label: string;
  items: Array<{ id: string; label: string; hidden: boolean }>;
}

export function SidebarCustomizeMenu({
  at,
  groups,
  onClose,
}: {
  /** Viewport point to open at (the click, or beside the button). */
  at: { x: number; y: number };
  groups: readonly SidebarMenuGroup[];
  onClose: () => void;
}): JSX.Element {
  const setHidden = useSidebarLayout((s) => s.setHidden);
  const moveItem = useSidebarLayout((s) => s.moveItem);
  const reset = useSidebarLayout((s) => s.reset);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstToggleRef = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState(MENU_HEIGHT_GUESS);
  useModalFocus(rootRef, firstToggleRef, true);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      // The dialog makes the rest of the page inert, which sends a press on the
      // opener to the page behind it: the press would close the menu and the
      // click that follows would open it again. Leave that press to the click.
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest(SIDEBAR_MENU_OPENER_SELECTOR)) return;
      onClose();
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

  // A large Text size or a short window changes the height; measure what it is.
  useLayoutEffect(() => {
    if (rootRef.current) setHeight(rootRef.current.offsetHeight);
  }, [groups.length]);

  // Reordering moves the row's DOM node, which drops focus; put it back on the
  // same arrow, or the other one when this row has just reached an end.
  function move(group: SidebarMenuGroup, itemId: string, delta: -1 | 1): void {
    moveItem(group.id, group.items.map((item) => item.id), itemId, delta);
    const direction = delta < 0 ? 'up' : 'down';
    window.setTimeout(() => {
      const row = rootRef.current?.querySelector(`[data-newamp-sidebar-menu-row="${itemId}"]`);
      const same = row?.querySelector<HTMLButtonElement>(`[data-newamp-sidebar-menu-${direction}]`);
      const other = row?.querySelector<HTMLButtonElement>(`[data-newamp-sidebar-menu-${direction === 'up' ? 'down' : 'up'}]`);
      (same && !same.disabled ? same : other)?.focus();
    }, 0);
  }

  const { left, top } = placeInViewport(
    { left: at.x, top: at.y },
    { width: MENU_WIDTH, height },
    { width: window.innerWidth, height: window.innerHeight },
    PANEL_MARGIN,
    PANEL_TOP_LIMIT,
  );

  return createPortal(
    <div
      ref={rootRef}
      className="sidebar-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Customise sidebar"
      data-newamp-sidebar-menu
      style={{ left, top, width: MENU_WIDTH }}
    >
      <div className="sidebar-menu-head">Sidebar</div>
      <div className="sidebar-menu-body">
        {groups.map((group, groupIndex) => (
          <section key={group.id} aria-label={group.label} className="sidebar-menu-group">
            <h3>{group.label}</h3>
            <ul>
              {group.items.map((item, index) => {
                const pinned = SIDEBAR_PINNED_ITEMS.includes(item.id);
                return (
                  <li key={item.id} data-newamp-sidebar-menu-row={item.id}>
                    <label className="sidebar-menu-toggle" title={pinned ? 'Settings always stays in the sidebar' : undefined}>
                      <input
                        ref={groupIndex === 0 && index === 0 ? firstToggleRef : undefined}
                        type="checkbox"
                        checked={!item.hidden}
                        disabled={pinned}
                        onChange={(event) => setHidden(item.id, !event.currentTarget.checked)}
                      />
                      <span>{item.label}</span>
                    </label>
                    <button
                      type="button"
                      className="sidebar-menu-move"
                      disabled={index === 0}
                      aria-label={`Move ${item.label} up`}
                      title="Move up"
                      data-newamp-sidebar-menu-up
                      onClick={() => move(group, item.id, -1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="sidebar-menu-move"
                      disabled={index === group.items.length - 1}
                      aria-label={`Move ${item.label} down`}
                      title="Move down"
                      data-newamp-sidebar-menu-down
                      onClick={() => move(group, item.id, 1)}
                    >
                      ▼
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <div className="sidebar-menu-foot">
        <button type="button" className="pxbtn" onClick={reset} data-newamp-sidebar-menu-reset>
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
