// Record Player deck. A square, lacquered wood plinth with a spinning vinyl
// that uses the album art as its 7" label, a chrome tonearm that swings with
// playback progress, and minimal transport along the bottom edge. Clicking the
// vinyl swaps it for an expanded visualizer.

import { useMemo } from 'react';
import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';

export function RecordPlayerDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, alwaysOnTop, artUrl, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;

  const progress = duration > 0 ? currentTime / duration : 0;
  // Tonearm swings from -22° (rest) to +18° (end of side).
  const tonearmAngle = useMemo(() => -22 + progress * 40, [progress]);
  // Vinyl rotation is purely CSS, driven by isPlaying.

  return (
    <div className={`deck-record-player ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <header className="deck-rp-titlebar titlebar-drag">
        <BrandLogo size={22} withGlow={false} />
        <span className="deck-rp-brand">NEWAMP · Vinyl Bench</span>
        <div className="deck-rp-window titlebar-nodrag">
          <DeckSkinPicker current="record-player" onPick={props.onPickSkin} compact />
          <button
            className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`}
            onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}
            title={alwaysOnTop ? 'Unpin window' : 'Pin window on top'}
          >
            PIN
          </button>
          <button className="pxbtn" onClick={onExitDeck} title="Back to full library">FULL</button>
          <button className="pxbtn" onClick={onMinimize} title="Minimize">_</button>
          <button className="pxbtn" onClick={onClose} title="Close" style={{ color: 'var(--error)' }}>×</button>
        </div>
      </header>

      <div className="deck-rp-stage titlebar-nodrag">
        {/* Spinning vinyl — center stage */}
        <button
          type="button"
          className="deck-rp-platter"
          data-newamp-open-visualizer
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          title={vizExpanded ? 'Show album label' : 'Show visualizer'}
        >
          <div className="deck-rp-grooves" />
          {vizExpanded ? (
            <div className="deck-rp-viz">
              <Visualizer mode="mini" width={320} height={320} />
            </div>
          ) : (
            <div className="deck-rp-label">
              {artUrl ? (
                <img src={artUrl} alt={track?.album ?? ''} draggable={false} />
              ) : (
                <span className="deck-rp-label-blank">{track ? '♪' : '—'}</span>
              )}
              <span className="deck-rp-spindle" />
            </div>
          )}
        </button>

        {/* Tonearm */}
        <div
          className="deck-rp-tonearm"
          style={{ transform: `rotate(${tonearmAngle.toFixed(2)}deg)` }}
          aria-hidden="true"
        >
          <div className="deck-rp-tonearm-pivot" />
          <div className="deck-rp-tonearm-arm" />
          <div className="deck-rp-tonearm-head" />
        </div>
      </div>

      <div className="deck-rp-info titlebar-nodrag">
        <div className="deck-rp-title">{track ? track.title : 'No record loaded'}</div>
        <div className="deck-rp-artist">{track ? track.artist : 'Drop a track to spin it up.'}</div>
        <input
          type="range"
          className="nslider deck-rp-seek"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={(e) => onSeek(parseFloat(e.currentTarget.value))}
          title="Seek"
        />
        <div className="deck-rp-times">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <footer className="deck-rp-transport titlebar-nodrag">
        <button className="pxbtn" onClick={onPrev} title="Previous">&lt;&lt;</button>
        <button className="pxbtn is-active" onClick={onTogglePlay} title="Play / Pause">
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button className="pxbtn" onClick={onStop} title="Stop">◼</button>
        <button className="pxbtn" onClick={onNext} title="Next">&gt;&gt;</button>
        <VolumeSlider value={volume} onChange={onSetVolume} width={120} showLabel={false} />
      </footer>
    </div>
  );
}
