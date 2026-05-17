import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
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

  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div className={`deck-hotdog ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <header className="deck-hd-rail titlebar-drag">
        <button className="deck-hd-brand titlebar-nodrag" onClick={onExitDeck} title="Back to full NewAmp">
          <BrandLogo size={20} withGlow={false} />
          <span>NEWAMP CONEY</span>
        </button>
        <DeckSkinPicker current="hotdog" onPick={props.onPickSkin} compact />
        <div className="deck-hd-window titlebar-nodrag">
          <button className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`} onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}>
            PIN
          </button>
          <button className="pxbtn" onClick={onExitDeck}>FULL</button>
          <button className="pxbtn" onClick={onMinimize}>_</button>
          <button className="pxbtn" onClick={onClose}>X</button>
        </div>
      </header>

      <main className="deck-hd-bun titlebar-nodrag">
        <span className="deck-hd-bun-half is-top" aria-hidden="true" />
        <span className="deck-hd-bun-half is-bottom" aria-hidden="true" />
        <span className="deck-hd-sausage" aria-hidden="true" />
        <span className="deck-hd-relish" aria-hidden="true" />
        <button
          type="button"
          className="deck-hd-screen"
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          data-newamp-open-visualizer
          title="Click for deck visualizer, double-click for fullscreen"
        >
          {vizExpanded ? (
            <Visualizer mode="mini" width={220} height={96} />
          ) : artUrl ? (
            <img src={artUrl} alt={track?.album ?? ''} draggable={false} />
          ) : (
            <span>NP</span>
          )}
        </button>
        <section className="deck-hd-label">
          <div className="deck-hd-title" title={track?.title}>{track?.title ?? 'No track loaded'}</div>
          <div className="deck-hd-artist" title={track?.artist}>{track?.artist ?? 'Drop a song to serve it hot'}</div>
          <input
            type="range"
            className="nslider deck-hd-seek"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.currentTarget.value))}
          />
          <div className="deck-hd-time">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </section>
        <div className="deck-hd-mustard" style={{ width: `${Math.max(8, progress)}%` }} aria-hidden="true" />
      </main>

      <footer className="deck-hd-transport titlebar-nodrag">
        <button className="pxbtn" onClick={onPrev}>&lt;&lt;</button>
        <button className="pxbtn is-active" onClick={onTogglePlay}>{isPlaying ? 'PAUSE' : 'PLAY'}</button>
        <button className="pxbtn" onClick={onStop}>STOP</button>
        <button className="pxbtn" onClick={onNext}>NEXT</button>
        <VolumeSlider value={volume} onChange={onSetVolume} width={150} showLabel={false} compact />
      </footer>
    </div>
  );
}
