import type { CSSProperties } from 'react';
import type { DeckProps } from './types';
import hotdogShellUrl from '../../assets/decks/hotdog-shell.png';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { DeckSkinPicker } from './DeckSkinPicker';

export function HotdogDeck(props: DeckProps): JSX.Element {
  const {
    track,
    isPlaying,
    currentTime,
    duration,
    volume,
    alwaysOnTop,
    artUrl,
    vizExpanded,
    onTogglePlay,
    onNext,
    onPrev,
    onStop,
    onSeek,
    onSetVolume,
    onSetAlwaysOnTop,
    onExitDeck,
    onMinimize,
    onClose,
    onToggleVizExpanded,
    onOpenFullscreenViz,
  } = props;

  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const titleLine = track ? track.title : 'No track loaded';
  const subLine = track
    ? [track.artist, track.album].filter(Boolean).join(' - ')
    : 'Drop a song to serve it hot';
  const seekStyle = { '--p': `${progress * 100}%` } as CSSProperties;

  return (
    <div className={`deck-hotdog ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <img
        className="deck-hd-art"
        src={hotdogShellUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
      />

      <header className="deck-hd-titlebar">
        <button className="deck-hd-brand titlebar-nodrag" onClick={onExitDeck} title="Back to full NewAmp">
          CONEY
        </button>
        <span className="deck-hd-marquee" title={track ? `${track.artist ?? ''} - ${track.title}` : ''}>
          <strong>{titleLine}</strong>
          <em> {subLine}</em>
        </span>
        <div className="deck-hd-wintools titlebar-nodrag">
          <DeckSkinPicker current="hotdog" onPick={props.onPickSkin} compact />
          <button
            className={`deck-hd-win is-pin ${alwaysOnTop ? 'is-active' : ''}`}
            onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}
            title={alwaysOnTop ? 'Unpin window' : 'Pin window on top'}
            aria-label="Pin window"
          />
          <button className="deck-hd-win" onClick={onExitDeck} title="Back to full library" aria-label="Full library">
            LIB
          </button>
          <button className="deck-hd-win" onClick={onMinimize} title="Minimize" aria-label="Minimize">
            _
          </button>
          <button className="deck-hd-win is-x" onClick={onClose} title="Close" aria-label="Close">
            X
          </button>
        </div>
      </header>

      <button
        type="button"
        className="deck-hd-screen titlebar-nodrag"
        onClick={onToggleVizExpanded}
        onDoubleClick={onOpenFullscreenViz}
        data-newamp-open-visualizer
        title="Click for deck visualizer, double-click for fullscreen"
        aria-label="Toggle visualizer"
      >
        {vizExpanded ? (
          <Visualizer mode="mini" />
        ) : artUrl ? (
          <img src={artUrl} alt={track?.album ?? ''} draggable={false} />
        ) : (
          <span className="deck-hd-screen-text">NP</span>
        )}
      </button>

      <div className="deck-hd-time titlebar-nodrag">
        <span className="deck-hd-time-now">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="deck-hd-seek"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={(e) => onSeek(parseFloat(e.currentTarget.value))}
          style={seekStyle}
          aria-label="Seek"
        />
        <span className="deck-hd-time-total">{formatTime(duration)}</span>
      </div>

      <footer className="deck-hd-transport titlebar-nodrag">
        <button className="deck-hd-t" onClick={onPrev} title="Previous" aria-label="Previous">PREV</button>
        <button
          className="deck-hd-t is-play"
          onClick={onTogglePlay}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? 'PAUSE' : 'PLAY'}
        </button>
        <button className="deck-hd-t" onClick={onStop} title="Stop" aria-label="Stop">STOP</button>
        <button className="deck-hd-t" onClick={onNext} title="Next" aria-label="Next">NEXT</button>
        <VolumeSlider value={volume} onChange={onSetVolume} width={120} showLabel={false} compact />
      </footer>
    </div>
  );
}
