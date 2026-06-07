// Jukebox deck. A portrait Wurlitzer arch with stained-glass colors driven by
// the active skin's accent. Top arch lit up; center "now playing" backlit
// glass; chrome transport keys; selection numeral that rotates with track no.

import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';

export function JukeboxDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, alwaysOnTop, artUrl, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;
  const selectionNo = String(track?.trackNo ?? 1).padStart(2, '0');
  const selectionDemo = !track || track.trackNo == null;

  return (
    <div className={`deck-jukebox ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      {/* Arched stained-glass top */}
      <div className="deck-jb-arch" aria-hidden="true">
        <div className="deck-jb-bubble-tube is-left">
          {Array.from({ length: 6 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 340}ms` }} />)}
        </div>
        <div className="deck-jb-bubble-tube is-right">
          {Array.from({ length: 6 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 300 + 120}ms` }} />)}
        </div>
        <div className="deck-jb-arch-lights">
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i} style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
        <span className="deck-jb-arch-marquee">NEWAMP · 45 RPM SERIES</span>
      </div>

      <header className="deck-jb-titlebar titlebar-drag">
        <BrandLogo size={20} withGlow={false} />
        <div className="deck-jb-window titlebar-nodrag">
          <DeckSkinPicker current="jukebox" onPick={props.onPickSkin} compact />
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

      {/* Backlit "now playing" glass */}
      <button
        type="button"
        className="deck-jb-stage titlebar-nodrag"
        data-newamp-open-visualizer
        onClick={onToggleVizExpanded}
        onDoubleClick={onOpenFullscreenViz}
        title={vizExpanded ? 'Show 45 sleeve' : 'Show visualizer'}
      >
        {vizExpanded ? (
          <div className="deck-jb-viz">
            <Visualizer mode="mini" width={300} height={200} />
          </div>
        ) : (
          <>
            {artUrl ? (
              <img src={artUrl} alt={track?.album ?? ''} className="deck-jb-art deck-jb-art-pan" draggable={false} />
            ) : (
              <div className="deck-jb-art-fallback">{track ? '45' : '—'}</div>
            )}
            <div className="deck-jb-track-card">
              <div className="deck-jb-selection">
                A-{selectionNo}
                {selectionDemo ? <span>DEMO</span> : null}
              </div>
              <div className="deck-jb-title" title={track?.title}>{track?.title ?? 'No selection'}</div>
              <div className="deck-jb-artist" title={track?.artist}>{track?.artist ?? 'Insert coin'}</div>
            </div>
          </>
        )}
      </button>

      {/* Chrome selector grid */}
      <div className="deck-jb-keys titlebar-nodrag" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className={i === 3 ? 'is-lit' : ''}>{String(i + 1).padStart(2, '0')}</span>
        ))}
      </div>

      {/* Seek bar */}
      <div className="deck-jb-seek titlebar-nodrag">
        <ScrubBar className="nslider" value={currentTime} max={duration || 1} onSeek={onSeek} />
        <div className="deck-jb-times">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <footer className="deck-jb-transport titlebar-nodrag">
        <button className="pxbtn" onClick={onPrev}>&lt;&lt;</button>
        <button className="pxbtn is-active" onClick={onTogglePlay}>{isPlaying ? '⏸' : '▶'}</button>
        <button className="pxbtn" onClick={onStop}>◼</button>
        <button className="pxbtn" onClick={onNext}>&gt;&gt;</button>
        <VolumeSlider value={volume} onChange={onSetVolume} width={120} showLabel={false} />
      </footer>
    </div>
  );
}
