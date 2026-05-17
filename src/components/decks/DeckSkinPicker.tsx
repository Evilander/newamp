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
  return (
    <div className={`deck-skin-picker ${compact ? 'is-compact' : ''}`} data-newamp-deck-skin-picker>
      <span className="deck-skin-picker-label" aria-hidden="true">
        SKIN
      </span>
      {DECK_SKINS.map((skin) => (
        <button
          key={skin.id}
          type="button"
          className={`deck-skin-chip ${skin.id === current ? 'is-current' : ''}`}
          onClick={() => onPick(skin.id)}
          title={`${skin.label}: ${skin.tagline} (${skin.size.width}x${skin.size.height})`}
          aria-pressed={skin.id === current}
          data-newamp-deck-skin-button={skin.id}
        >
          {compact ? skin.shortLabel : skin.label}
        </button>
      ))}
    </div>
  );
}
