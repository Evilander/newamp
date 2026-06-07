import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';

export function RetroTvDeck(props: DeckProps): JSX.Element {
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

  return (
    <div className={`deck-retro-tv ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <div className="deck-tv-antenna" aria-hidden="true">
        <span />
        <span />
      </div>
      <header className="deck-tv-titlebar titlebar-drag">
        <button className="deck-tv-brand titlebar-nodrag" onClick={onExitDeck} title="Back to full NewAmp">
          <BrandLogo size={22} withGlow={false} />
          <span>NEWAMP UHF</span>
        </button>
        <DeckSkinPicker current="retro-tv" onPick={props.onPickSkin} compact />
        <div className="deck-tv-window titlebar-nodrag">
          <button className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`} onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}>
            PIN
          </button>
          <button className="pxbtn" onClick={onExitDeck}>FULL</button>
          <button className="pxbtn" onClick={onMinimize}>_</button>
          <button className="pxbtn" onClick={onClose}>X</button>
        </div>
      </header>

      <main className="deck-tv-body titlebar-nodrag">
        <button
          type="button"
          className="deck-tv-screen"
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          data-newamp-open-visualizer
          title="Click for screen visualizer, double-click for fullscreen"
          data-newamp-tv-state={track ? 'tuned' : 'static'}
        >
          <span className="deck-tv-scanlines" aria-hidden="true" />
          {/* TV static overlay — animated noise/snow that fades in when no
              track is loaded or while the channel is "tuning". Subtle on
              playback so the cover still reads. */}
          <span className="deck-tv-static" aria-hidden="true" />
          {vizExpanded ? (
            <Visualizer mode="mini" width={300} height={220} />
          ) : artUrl ? (
            <img src={artUrl} alt={track?.album ?? ''} draggable={false} className="deck-tv-art-pan" />
          ) : (
            <Visualizer mode="mini" width={300} height={220} />
          )}
        </button>

        <aside className="deck-tv-console">
          <div className="deck-tv-knob is-large" />
          <div className="deck-tv-knob" />
          <div className="deck-tv-meter">
            <span style={{ width: `${Math.round(volume * 100)}%` }} />
          </div>
          <VolumeSlider value={volume} onChange={onSetVolume} width={90} showLabel={false} compact />
        </aside>
      </main>

      <section className="deck-tv-info titlebar-nodrag">
        <div>
          <div className="deck-tv-title" title={track?.title}>{track?.title ?? 'No signal'}</div>
          <div className="deck-tv-artist" title={track?.artist}>{track?.artist ?? 'Tune NewAmp to a track'}</div>
        </div>
        <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
      </section>

      <footer className="deck-tv-transport titlebar-nodrag">
        <button className="pxbtn" onClick={onPrev}>PREV</button>
        <button className="pxbtn is-active" onClick={onTogglePlay}>{isPlaying ? 'PAUSE' : 'PLAY'}</button>
        <button className="pxbtn" onClick={onStop}>STOP</button>
        <button className="pxbtn" onClick={onNext}>NEXT</button>
        <ScrubBar className="nslider deck-tv-seek" value={currentTime} max={duration || 1} onSeek={onSeek} />
      </footer>
    </div>
  );
}
