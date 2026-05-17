// Cassette Deck. A landscape deck with twin tape spools (the reels rotate while
// playing), a center LCD strip with track info, and chrome transport along
// the bottom. Clicking the cassette door expands a visualizer over the spools.

import { useMemo } from 'react';
import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';

export function CassetteDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, alwaysOnTop, artUrl, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;

  // The supply spool shrinks as duration progresses; take-up grows. Tape fill
  // is purely cosmetic: 0..1 used to drive the spool diameter.
  const playedFrac = duration > 0 ? currentTime / duration : 0;
  const supplyR = useMemo(() => 26 + (1 - playedFrac) * 30, [playedFrac]);
  const takeupR = useMemo(() => 26 + playedFrac * 30, [playedFrac]);

  return (
    <div className={`deck-cassette ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <header className="deck-cs-titlebar titlebar-drag">
        <BrandLogo size={20} withGlow={false} />
        <span className="deck-cs-brand">NEWAMP · TYPE-IV METAL</span>
        <div className="deck-cs-window titlebar-nodrag">
          <DeckSkinPicker current="cassette" onPick={props.onPickSkin} compact />
          <button
            className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`}
            onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}
          >PIN</button>
          <button className="pxbtn" onClick={onExitDeck}>FULL</button>
          <button className="pxbtn" onClick={onMinimize}>_</button>
          <button className="pxbtn" onClick={onClose} style={{ color: 'var(--error)' }}>×</button>
        </div>
      </header>

      <button
        type="button"
        className="deck-cs-shell titlebar-nodrag"
        data-newamp-open-visualizer
        onClick={onToggleVizExpanded}
        onDoubleClick={onOpenFullscreenViz}
        title="Click to swap reels for visualizer · double-click for fullscreen viz"
      >
        <span className="deck-cs-metal-strip" aria-hidden="true">TYPE-IV METAL</span>
        {vizExpanded ? (
          <div className="deck-cs-viz">
            <Visualizer mode="mini" width={680} height={140} />
          </div>
        ) : (
          <>
            <Reel size={supplyR} spinning={isPlaying} side="left" />
            <div className="deck-cs-window-strip">
              <div className="deck-cs-art">
                {artUrl ? <img src={artUrl} alt={track?.album ?? ''} draggable={false} /> : <span>♪</span>}
              </div>
              <div className="deck-cs-lcd">
                <div className="deck-cs-title">{track ? track.title : 'No tape loaded'}</div>
                <div className="deck-cs-artist">{track ? track.artist : 'Insert a track…'}</div>
                <div className="deck-cs-times">
                  <span>{formatTime(currentTime)}</span>
                  <span className="deck-cs-tape">▷▷▷▷▷▷▷▷▷▷</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>
            </div>
            <Reel size={takeupR} spinning={isPlaying} side="right" />
          </>
        )}
      </button>

      <div className="deck-cs-seek titlebar-nodrag">
        <input
          type="range"
          className="nslider"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={(e) => onSeek(parseFloat(e.currentTarget.value))}
          title="Seek"
        />
      </div>

      <footer className="deck-cs-transport titlebar-nodrag">
        <button className="pxbtn" onClick={onPrev}>◀◀</button>
        <button className="pxbtn is-active" onClick={onTogglePlay}>{isPlaying ? '▮▮' : '▶'}</button>
        <button className="pxbtn" onClick={onStop}>◼</button>
        <button className="pxbtn" onClick={onNext}>▶▶</button>
        <VolumeSlider value={volume} onChange={onSetVolume} width={130} showLabel={false} />
      </footer>
    </div>
  );
}

function Reel({ size, spinning, side }: { size: number; spinning: boolean; side: 'left' | 'right' }): JSX.Element {
  // Reels are SVG with three spokes; CSS handles rotation.
  return (
    <div
      className={`deck-cs-reel ${spinning ? 'is-spinning' : ''} ${side === 'left' ? 'is-left' : 'is-right'}`}
      style={{ width: size * 2, height: size * 2 }}
      aria-hidden="true"
    >
      <svg viewBox="-60 -60 120 120">
        <circle r="58" fill="var(--panel-2)" stroke="var(--bevel-light)" strokeWidth="1" />
        <circle r={size} fill="var(--display-bg)" />
        <g className="deck-cs-reel-spokes" stroke="var(--ink-2)" strokeWidth="3" strokeLinecap="round">
          <line x1="0" y1="-20" x2="0" y2="-54" />
          <line x1="-47" y1="27" x2="-18" y2="10" />
          <line x1="47" y1="27" x2="18" y2="10" />
        </g>
        <circle r="6" fill="var(--accent)" opacity="0.85" />
      </svg>
    </div>
  );
}
