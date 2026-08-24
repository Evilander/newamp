// Classic Bento — the original Winamp 2-style compact bar. Wraps the existing
// CompactPlayer layout in the new DeckProps interface so the user can pick
// "Bento" as one option among the new shaped decks.

import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';
import { combinePlaybackMode, isShuffleMode, repeatModeOf } from '@shared/types';

export function ClassicBentoDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, mode, alwaysOnTop, artUrl, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetMode, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;

  return (
    <div className="compact-root">
      <section className="compact-shell titlebar-drag">
        <button
          type="button"
          className="compact-art titlebar-nodrag"
          data-newamp-open-visualizer
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          title={vizExpanded ? 'Show album art' : 'Show visualizer'}
        >
          {vizExpanded ? (
            <div className="compact-art-viz">
              <Visualizer mode="mini" width={72} height={72} />
            </div>
          ) : (
            <>
              <span className="compact-art-fallback">NP</span>
              {artUrl ? (
                <img
                  src={artUrl}
                  alt={track?.album || 'cover'}
                  draggable={false}
                  onError={(event) => {
                    event.currentTarget.style.display = 'none';
                  }}
                />
              ) : null}
            </>
          )}
        </button>

        <div className="compact-main">
          <div className="compact-topline">
            <button className="compact-brand titlebar-nodrag" onClick={onExitDeck}>
              <BrandLogo size={16} withGlow={false} />
              <span>NEWAMP</span>
            </button>
            <div className="compact-leds" aria-hidden="true">
              <span className={isPlaying ? 'on' : ''} />
              <span className={isShuffleMode(mode) ? 'on' : ''} />
              <span className={mode !== 'normal' ? 'on' : ''} />
            </div>
            <div className="compact-window titlebar-nodrag">
              <DeckSkinPicker current="bento" onPick={props.onPickSkin} compact />
              <button onClick={onMinimize} title="Minimize">_</button>
              <button
                className={alwaysOnTop ? 'active' : ''}
                onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}
                title={alwaysOnTop ? 'Unpin window' : 'Pin window on top'}
              >
                PIN
              </button>
              <button onClick={onExitDeck} title="Full library">FULL</button>
              <button onClick={onClose} title="Close">x</button>
            </div>
          </div>

          <button
            type="button"
            className="compact-display titlebar-nodrag"
            onClick={onOpenFullscreenViz}
            title="Open fullscreen visualizer"
          >
            <span className="compact-time">{formatTime(currentTime)}</span>
            <span className="compact-title">
              {track ? `${track.artist} - ${track.title}` : 'Drop in a library and press play'}
            </span>
            <span className="compact-total">{formatTime(duration)}</span>
          </button>

          <div className="compact-controls titlebar-nodrag">
            <button onClick={onPrev} title="Previous">&lt;&lt;</button>
            <button onClick={onTogglePlay} title="Play / Pause">{isPlaying ? '||' : '>'}</button>
            <button onClick={onStop} title="Stop">[]</button>
            <button onClick={onNext} title="Next">&gt;&gt;</button>
            <ScrubBar className="nslider compact-seek" value={currentTime} max={duration || 1} onSeek={onSeek} />
            <button
              className={isShuffleMode(mode) ? 'active' : ''}
              onClick={() => onSetMode(combinePlaybackMode(!isShuffleMode(mode), repeatModeOf(mode)))}
              title="Shuffle"
            >
              SHUF
            </button>
            <VolumeSlider
              value={volume}
              onChange={onSetVolume}
              width={92}
              compact
              showLabel={false}
              className="compact-volume-wrap"
              title="Volume"
            />
          </div>
        </div>

        <div className="compact-viz">
          <Visualizer mode="mini" width={96} height={96} />
        </div>
      </section>
    </div>
  );
}
