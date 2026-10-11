// The menu behind a right-click on the fullscreen visualizer: a compact
// role="menu" that opens at the pointer, flips and clamps to stay on screen,
// and works from the keyboard (arrows, Home/End, Right into a submenu, Left
// back out). Esc is handled by FullscreenVisualizer, which closes the menu
// before it closes the visualizer.
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import {
  pickFocusRestoreTarget,
  placeMenu,
  placeSubmenu,
  stepMenuIndex,
  type Point,
} from './visualizer-input';
import { focusedByKeyboard, useScrollKeepsWheel } from './usePopoverFocus';

export interface VisualizerMenuItem {
  type: 'item';
  id: string;
  label: string;
  /** Shortcut or note, right-aligned. */
  hint?: string;
  /** Set to make it a checkbox (or a radio with `radio`); unset for a plain command. */
  checked?: boolean;
  radio?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type VisualizerMenuEntry =
  | VisualizerMenuItem
  | { type: 'submenu'; id: string; label: string; entries: VisualizerMenuEntry[] }
  | { type: 'heading'; label: string }
  | { type: 'separator' };

type Placement = { kind: 'point'; at: Point } | { kind: 'beside'; anchor: HTMLElement };

function menuItems(list: HTMLElement): HTMLButtonElement[] {
  return Array.from(list.querySelectorAll<HTMLButtonElement>('[data-viz-menu-item]')).filter(
    (item) => item.closest('[role="menu"]') === list,
  );
}

export function VisualizerMenu({
  at,
  entries,
  onClose,
  fallbackFocus,
}: {
  /** Viewport point the menu opens at (the right-click). */
  at: Point;
  entries: VisualizerMenuEntry[];
  onClose: () => void;
  /** Where focus lands on close if what had it before is gone. */
  fallbackFocus: RefObject<HTMLElement>;
}): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null);
  const placement = useRef<Placement>({ kind: 'point', at }).current;

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const opener = focusedByKeyboard();
    return () => {
      pickFocusRestoreTarget({
        opener,
        active: document.activeElement,
        body: document.body,
        panel: layer,
        fallback: fallbackFocus.current,
      })?.focus({ preventScroll: true });
    };
  }, [fallbackFocus]);

  return (
    <div ref={layerRef} className="viz-menu-layer" data-newamp-viz-menu-layer>
      <div className="viz-menu-backdrop" data-newamp-viz-menu-backdrop onClick={onClose} aria-hidden="true" />
      <MenuList
        entries={entries}
        label="Visualizer menu"
        placement={placement}
        focus="list"
        onSelect={(item) => {
          item.onSelect();
          onClose();
        }}
        onTab={onClose}
        root
      />
    </div>
  );
}

function MenuList({
  entries,
  label,
  placement,
  focus,
  onSelect,
  onTab,
  onBack,
  root,
}: {
  entries: VisualizerMenuEntry[];
  label: string;
  placement: Placement;
  /**
   * What takes focus once it is placed: the list itself (a right-click, so
   * no item looks picked until the pointer or an arrow key gets to it), the
   * first item (a submenu opened from the keyboard), or nothing (opened by
   * hovering).
   */
  focus: 'list' | 'first' | null;
  onSelect: (item: VisualizerMenuItem) => void;
  onTab: () => void;
  /** Present on a submenu: Left closes it and puts focus back on its item. */
  onBack?: () => void;
  root?: boolean;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [openSub, setOpenSub] = useState<{ id: string; focusInto: boolean } | null>(null);
  useScrollKeepsWheel(listRef);

  // Measured once it is in the DOM (hidden until then, so there is no flash at
  // the unclamped spot). Neither the list nor its anchor changes while it is
  // mounted: a new right-click remounts the whole menu.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPos(
      placement.kind === 'point'
        ? placeMenu(placement.at, size, viewport)
        : placeSubmenu(placement.anchor.getBoundingClientRect(), size, viewport),
    );
  }, []);

  const placed = pos !== null;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!placed || !focus || !list) return;
    if (focus === 'list') list.focus({ preventScroll: true });
    else menuItems(list).find((item) => !item.disabled)?.focus({ preventScroll: true });
  }, [placed, focus]);

  const start =
    placement.kind === 'point'
      ? { left: placement.at.x, top: placement.at.y }
      : { left: placement.anchor.getBoundingClientRect().right, top: placement.anchor.getBoundingClientRect().top };

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const list = listRef.current;
    if (!list) return;
    const items = menuItems(list);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End':
        items[stepMenuIndex(items.map((item) => !item.disabled), index, event.key)]?.focus();
        break;
      case 'ArrowRight': {
        const id = items[index]?.dataset.vizMenuSub;
        if (!id) return;
        setOpenSub({ id, focusInto: true });
        break;
      }
      case 'ArrowLeft':
        if (!onBack) return;
        onBack();
        break;
      case 'Tab':
        onTab();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function closeSub(): void {
    listRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]')?.focus({ preventScroll: true });
    setOpenSub(null);
  }

  return (
    <div
      ref={listRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={root ? 'viz-menu' : 'viz-menu is-sub'}
      style={{ left: pos?.left ?? start.left, top: pos?.top ?? start.top, visibility: placed ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown}
      data-newamp-viz-menu={root ? '' : undefined}
      data-newamp-viz-submenu={root ? undefined : ''}
    >
      {entries.map((entry, entryIndex) => {
        if (entry.type === 'separator') return <div key={`sep-${entryIndex}`} role="separator" className="viz-menu-sep" />;
        if (entry.type === 'heading') {
          return (
            <div key={`head-${entryIndex}`} role="presentation" className="viz-menu-heading">
              {entry.label}
            </div>
          );
        }
        if (entry.type === 'submenu') {
          const open = openSub?.id === entry.id;
          return (
            <SubmenuItem
              key={entry.id}
              entry={entry}
              open={open}
              focusInto={open && openSub.focusInto}
              onOpen={(focusInto) => setOpenSub({ id: entry.id, focusInto })}
              onBack={closeSub}
              onSelect={onSelect}
              onTab={onTab}
            />
          );
        }
        const role = entry.checked === undefined ? 'menuitem' : entry.radio ? 'menuitemradio' : 'menuitemcheckbox';
        return (
          <button
            key={entry.id}
            type="button"
            role={role}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            tabIndex={-1}
            className="viz-menu-item"
            data-viz-menu-item=""
            data-newamp-viz-menu-item={entry.id}
            onClick={() => onSelect(entry)}
            onMouseEnter={(event) => {
              setOpenSub(null);
              if (!entry.disabled) event.currentTarget.focus({ preventScroll: true });
            }}
          >
            <span className="viz-menu-check" aria-hidden="true">
              {entry.checked ? (entry.radio ? '●' : '✓') : ''}
            </span>
            <span className="viz-menu-label">{entry.label}</span>
            {entry.hint ? <span className="viz-menu-hint">{entry.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function SubmenuItem({
  entry,
  open,
  focusInto,
  onOpen,
  onBack,
  onSelect,
  onTab,
}: {
  entry: Extract<VisualizerMenuEntry, { type: 'submenu' }>;
  open: boolean;
  focusInto: boolean;
  onOpen: (focusInto: boolean) => void;
  onBack: () => void;
  onSelect: (item: VisualizerMenuItem) => void;
  onTab: () => void;
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={-1}
        className="viz-menu-item"
        data-viz-menu-item=""
        data-viz-menu-sub={entry.id}
        data-newamp-viz-menu-item={entry.id}
        onClick={() => onOpen(true)}
        onMouseEnter={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          if (!open) onOpen(false);
        }}
      >
        <span className="viz-menu-check" aria-hidden="true" />
        <span className="viz-menu-label">{entry.label}</span>
        <span className="viz-menu-chevron" aria-hidden="true">›</span>
      </button>
      {open && buttonRef.current ? (
        <MenuList
          entries={entry.entries}
          label={entry.label}
          placement={{ kind: 'beside', anchor: buttonRef.current }}
          focus={focusInto ? 'first' : null}
          onSelect={onSelect}
          onTab={onTab}
          onBack={onBack}
        />
      ) : null}
    </>
  );
}
