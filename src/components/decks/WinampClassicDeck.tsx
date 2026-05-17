import type { DeckProps, DeckSkin } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';

type WinampVariant = 'classic' | 'industrial';

export function WinampClassicDeck(props: DeckProps): JSX.Element {
  return <WinampDeck {...props} currentSkin="winamp-classic" variant="classic" />;
}

export function WinampIndustrialDeck(props: DeckProps): JSX.Element {
  return <WinampDeck {...props} currentSkin="winamp-industrial" variant="industrial" />;
}

function WinampDeck({
  currentSkin,
  variant,
  ...props
}: DeckProps & { currentSkin: DeckSkin; variant: WinampVariant }): JSX.Element {
  const {
    track,
    isPlaying,
    currentTime,
    duration,
    volume,
    mode,
    alwaysOnTop,
    artUrl,
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
    onOpenFullscreenViz,
  } = props;

  const bars = Array.from({ length: 10 }, (_, i) => i);

  return (
    <div className={`deck-winamp-classic is-${variant} ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <header className="deck-wa-titlebar titlebar-drag">
        <button className="deck-wa-brand titlebar-nodrag" onClick={onExitDeck} title="Back to full NewAmp">
          <BrandLogo size={18} withGlow={false} />
          <span>NEWAMP 2.X</span>
        </button>
        <DeckSkinPicker current={currentSkin} onPick={props.onPickSkin} compact />
        <div className="deck-wa-window titlebar-nodrag">
          <button className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`} onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}>
            PIN
          </button>
          <button className="pxbtn" onClick={onExitDeck}>FULL</button>
          <button className="pxbtn" onClick={onMinimize}>_</button>
          <button className="pxbtn" onClick={onClose}>X</button>
        </div>
      </header>

      <main className="deck-wa-main titlebar-nodrag">
        <button
          type="button"
          className="deck-wa-display"
          onClick={onOpenFullscreenViz}
          data-newamp-open-visualizer
          title="Open fullscreen visualizer"
        >
          <div className="deck-wa-time">{formatTime(currentTime)}</div>
          <div className="deck-wa-track">
            <div title={track?.title}>{track?.title ?? 'No track loaded'}</div>
            <span title={track?.artist}>{track?.artist ?? 'Drop music into NewAmp'}</span>
          </div>
          <div className="deck-wa-mini-viz">
            <Visualizer mode="mini" width={96} height={42} />
          </div>
        </button>

        <div className="deck-wa-controls">
          <button className="deck-wa-transport" onClick={onPrev} title="Previous">&lt;&lt;</button>
          <button className="deck-wa-transport is-primary" onClick={onTogglePlay} title="Play / Pause">
            {isPlaying ? '||' : '>'}
          </button>
          <button className="deck-wa-transport" onClick={onStop} title="Stop">[]</button>
          <button className="deck-wa-transport" onClick={onNext} title="Next">&gt;&gt;</button>
          <button
            className={`deck-wa-toggle ${mode === 'shuffle' ? 'is-active' : ''}`}
            onClick={() => onSetMode(mode === 'shuffle' ? 'normal' : 'shuffle')}
          >
            SHUF
          </button>
          <button
            className={`deck-wa-toggle ${mode !== 'normal' ? 'is-active' : ''}`}
            onClick={() => onSetMode(mode === 'repeat-all' ? 'normal' : 'repeat-all')}
          >
            REP
          </button>
        </div>

        <div className="deck-wa-seek-row">
          <input
            type="range"
            className="nslider"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.currentTarget.value))}
          />
          <span>{formatTime(duration)}</span>
        </div>
      </main>

      <section className="deck-wa-eq titlebar-nodrag">
        <div className="deck-wa-art">
          {artUrl ? <img src={artUrl} alt={track?.album ?? ''} draggable={false} /> : <span>NA</span>}
        </div>
        <div className="deck-wa-bandset" aria-hidden="true">
          {bars.map((bar) => (
            <span key={bar} style={{ height: `${26 + ((bar * 17) % 54)}%` }} />
          ))}
        </div>
        <VolumeSlider value={volume} onChange={onSetVolume} width={116} showLabel={false} compact />
      </section>
    </div>
  );
}
