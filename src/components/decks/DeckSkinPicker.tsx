// Tiny "SKIN" chip that pops a menu of deck variants. Used inside each deck so
// the user can switch shapes from anywhere without leaving the compact view.

import { useState } from 'react';
import type { DeckSkin } from './types';
import { DECK_SKINS } from './types';

export function DeckSkinPicker({
  current,
  onPick,
  compact = false,
}: {
  current: DeckSkin;
  onPick: (skin: DeckSkin) => void;
  compact?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`deck-skin-picker ${compact ? 'is-compact' : ''}`} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={`pxbtn ${open ? 'is-active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title="Switch deck skin"
      >
        SKIN
      </button>
      {open ? (
        <div className="deck-skin-menu">
          {DECK_SKINS.map((skin) => (
            <button
              key={skin.id}
              type="button"
              className={`deck-skin-menu-item ${skin.id === current ? 'is-current' : ''}`}
              onClick={() => {
                onPick(skin.id);
                setOpen(false);
              }}
            >
              <span className="deck-skin-menu-label">{skin.label}</span>
              <span className="deck-skin-menu-tagline">{skin.tagline}</span>
              <span className="deck-skin-menu-size">
                {skin.size.width}×{skin.size.height}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
