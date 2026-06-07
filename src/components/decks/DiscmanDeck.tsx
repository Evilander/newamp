import type { CSSProperties } from 'react';
import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';

export function DiscmanDeck(props: DeckProps): JSX.Element {
  const {
    track,
    isPlaying,
    currentTime,
    duration,
    volume,
    mode,
    alwaysOnTop,
    artUrl,
    vizExpanded,
    onTogglePlay,
    onNext,
    onPrev,
    onStop,
    onSeek,
    onSetVolume,
    onSetMode,
    onSetAlwaysOnTop,
    onExitDeck,
    onMinimize,
    onClose,
    onToggleVizExpanded,
    onOpenFullscreenViz,
  } = props;

  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const style = { '--disc-progress': `${Math.round(progress * 360)}deg` } as CSSProperties;

  return (
    <div className={`deck-discman ${isPlaying ? 'is-playing' : ''} titlebar-drag`} style={style}>
      <header className="deck-dm-titlebar titlebar-drag">
        <button className="deck-dm-brand titlebar-nodrag" onClick={onExitDeck} title="Back to full NewAmp">
          <BrandLogo size={20} withGlow={false} />
          <span>NEWAMP CD</span>
        </button>
        <DeckSkinPicker current="discman" onPick={props.onPickSkin} compact />
        <div className="deck-dm-window titlebar-nodrag">
          <button className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`} onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}>
            PIN
          </button>
          <button className="pxbtn" onClick={onExitDeck}>FULL</button>
          <button className="pxbtn" onClick={onMinimize}>_</button>
          <button className="pxbtn" onClick={onClose}>X</button>
        </div>
      </header>

      <main className="deck-dm-body titlebar-nodrag">
        <button
          type="button"
          className="deck-dm-disc"
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          data-newamp-open-visualizer
          title="Click for deck visualizer, double-click for fullscreen"
        >
          <span className="deck-dm-progress-ring" aria-hidden="true" />
          <span className="deck-dm-disc-sheen" aria-hidden="true" />
          {vizExpanded ? (
            <span className="deck-dm-viz">
              <Visualizer mode="mini" width={210} height={210} />
            </span>
          ) : artUrl ? (
            <img src={artUrl} alt={track?.album ?? ''} draggable={false} />
          ) : (
            <span className="deck-dm-disc-fallback">CD</span>
          )}
          <span className="deck-dm-hub" aria-hidden="true" />
        </button>

        <section className="deck-dm-display">
          <div className="deck-dm-kicker">{mode === 'shuffle' ? 'SHUFFLE' : mode === 'repeat-one' ? 'REPEAT ONE' : mode === 'repeat-all' ? 'REPEAT ALL' : 'TRACK'}</div>
          <div className="deck-dm-title" title={track?.title}>{track?.title ?? 'No disc loaded'}</div>
          <div className="deck-dm-artist" title={track?.artist}>{track?.artist ?? 'Drop music into NewAmp'}</div>
          <div className="deck-dm-time">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
          <ScrubBar className="nslider deck-dm-seek" value={currentTime} max={duration || 1} onSeek={onSeek} />
        </section>
      </main>

      <footer className="deck-dm-controls titlebar-nodrag">
        <button className="pxbtn" onClick={onPrev} title="Previous">&lt;&lt;</button>
        <button className="pxbtn is-active" onClick={onTogglePlay} title="Play / Pause">
          {isPlaying ? 'PAUSE' : 'PLAY'}
        </button>
        <button className="pxbtn" onClick={onStop} title="Stop">STOP</button>
        <button className="pxbtn" onClick={onNext} title="Next">NEXT</button>
        <button
          className={`pxbtn ${mode === 'shuffle' ? 'is-active' : ''}`}
          onClick={() => onSetMode(mode === 'shuffle' ? 'normal' : 'shuffle')}
        >
          SHUF
        </button>
        <VolumeSlider value={volume} onChange={onSetVolume} width={132} showLabel={false} compact />
      </footer>
    </div>
  );
}
