import type { CSSProperties } from 'react';
import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';

const MODE_LABELS: Record<DeckProps['mode'], string> = {
  normal: 'NORMAL',
  shuffle: 'SHUFFLE',
  'repeat-all': 'REPEAT ALL',
  'repeat-one': 'REPEAT 1',
};

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
  const style = { '--dm-progress': `${Math.round(progress * 1000) / 10}%` } as CSSProperties;
  const trackNumber = track ? String(track.trackNo ?? 1).padStart(2, '0') : '--';

  return (
    <div className={`deck-discman ${isPlaying ? 'is-playing' : ''} titlebar-drag`} style={style}>
      <svg
        className="deck-dm-hardware"
        viewBox="0 0 620 460"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="dm-side" x1="0" y1="0" x2="0.82" y2="1">
            <stop offset="0" stopColor="#4b5256" />
            <stop offset="0.42" stopColor="#242a2e" />
            <stop offset="1" stopColor="#0d1114" />
          </linearGradient>
          <linearGradient id="dm-body" x1="0.08" y1="0" x2="0.88" y2="1">
            <stop offset="0" stopColor="#f2f4f3" />
            <stop offset="0.18" stopColor="#c9ced0" />
            <stop offset="0.58" stopColor="#9ca3a7" />
            <stop offset="1" stopColor="#6c7378" />
          </linearGradient>
          <linearGradient id="dm-lid" x1="0.06" y1="0" x2="0.92" y2="1">
            <stop offset="0" stopColor="#f8f9f7" />
            <stop offset="0.22" stopColor="#d8dbda" />
            <stop offset="0.54" stopColor="#b0b5b7" />
            <stop offset="1" stopColor="#858c90" />
          </linearGradient>
          <linearGradient id="dm-lid-brush" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.46" />
            <stop offset="0.31" stopColor="#ffffff" stopOpacity="0.04" />
            <stop offset="0.7" stopColor="#30383c" stopOpacity="0.1" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="dm-front" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#848b8e" />
            <stop offset="0.18" stopColor="#4e5559" />
            <stop offset="1" stopColor="#161b1e" />
          </linearGradient>
          <radialGradient id="dm-screw" cx="0.34" cy="0.28" r="0.72">
            <stop offset="0" stopColor="#f7f8f5" />
            <stop offset="0.3" stopColor="#aeb4b5" />
            <stop offset="0.72" stopColor="#4d5558" />
            <stop offset="1" stopColor="#161a1c" />
          </radialGradient>
        </defs>

        <path
          fill="url(#dm-side)"
          d="M74 2h472c43 0 72 30 73 73l1 304c0 49-31 79-80 80H79C30 459 0 429 0 381L2 76C3 33 32 3 74 2Z"
        />
        <path
          className="deck-dm-svg-body"
          fill="url(#dm-body)"
          d="M75 5h470c40 0 68 29 69 69l1 294c0 42-29 69-72 70H77c-43 0-71-28-71-70L7 75C8 34 36 6 75 5Z"
        />
        <path
          fill="url(#dm-front)"
          d="M15 370c21 39 43 53 82 55h427c39-1 64-17 81-55l9-1c2 43-28 69-71 70H77c-43 0-71-28-71-70l9 1Z"
        />
        <path
          className="deck-dm-svg-lid"
          fill="url(#dm-lid)"
          d="M101 43c-39 3-59 25-60 65l5 191c1 39 23 59 65 62h397c42-2 65-23 67-62l5-190c0-40-22-63-62-66H101Z"
        />
        <path
          fill="url(#dm-lid-brush)"
          opacity="0.72"
          d="M101 47c-36 3-55 24-56 62l5 188c1 36 22 56 62 59h394c40-2 62-22 64-59l5-187c0-38-21-60-58-63H101Z"
        />
        <path
          className="deck-dm-svg-seam-shadow"
          d="M101 42c-40 3-61 26-62 66l5 192c1 41 24 62 67 64h398c44-2 67-24 69-64l5-191c0-42-23-65-64-68H101Z"
        />
        <path
          className="deck-dm-svg-seam-light"
          d="M101 45c-37 3-57 24-58 63l5 190c1 38 22 58 63 60h397c41-2 63-22 65-60l5-189c0-39-22-61-60-64H101Z"
        />
        <path
          className="deck-dm-svg-specular"
          d="M92 50c-29 5-43 20-46 50M58 330c10 17 28 24 53 26h199"
        />

        <g className="deck-dm-svg-hinge">
          <rect x="196" y="39" width="228" height="11" rx="5.5" />
          <rect x="213" y="40" width="72" height="8" rx="4" />
          <rect x="335" y="40" width="72" height="8" rx="4" />
          <path d="M291 41h38v7h-38z" />
        </g>

        <g className="deck-dm-svg-screws">
          <g transform="translate(66 94)">
            <circle r="6" fill="#555d60" />
            <circle r="4.5" fill="url(#dm-screw)" />
            <path d="M-2.6-2.6 2.6 2.6M2.6-2.6-2.6 2.6" />
          </g>
          <g transform="translate(553 95)">
            <circle r="6" fill="#555d60" />
            <circle r="4.5" fill="url(#dm-screw)" />
            <path d="M-2.6-2.6 2.6 2.6M2.6-2.6-2.6 2.6" />
          </g>
          <g transform="translate(64 326)">
            <circle r="6" fill="#555d60" />
            <circle r="4.5" fill="url(#dm-screw)" />
            <path d="M-2.6-2.6 2.6 2.6M2.6-2.6-2.6 2.6" />
          </g>
          <g transform="translate(555 326)">
            <circle r="6" fill="#555d60" />
            <circle r="4.5" fill="url(#dm-screw)" />
            <path d="M-2.6-2.6 2.6 2.6M2.6-2.6-2.6 2.6" />
          </g>
        </g>
      </svg>

      <div className="deck-dm-hardware-labels" aria-hidden="true">
        <div className="deck-dm-model-mark">
          <strong>NEWAMP</strong>
          <span>DX-7</span>
          <em>ESP</em>
        </div>
        <div className="deck-dm-disc-mark">
          <span className="deck-dm-disc-mark-symbol">disc</span>
          <span>COMPACT DISC</span>
          <small>DIGITAL AUDIO</small>
        </div>
        <div className="deck-dm-edge-jack is-dc">
          <i />
          <span>DC IN 4.5V</span>
        </div>
        <div className="deck-dm-edge-jack is-phones">
          <span>PHONES</span>
          <i />
        </div>
        <div className="deck-dm-hold-switch">
          <span>HOLD</span>
          <i><b /></i>
        </div>
        <div className="deck-dm-esp-badge">
          <i className="deck-dm-esp-led" />
          <strong>ESP</strong>
          <span>10 SEC</span>
        </div>
        <div className="deck-dm-open-slider">
          <span>OPEN</span>
          <i><b /></i>
          <em>›</em>
        </div>
      </div>

      <header className="deck-dm-titlebar titlebar-drag">
        <button
          type="button"
          className="deck-dm-brand titlebar-nodrag"
          onClick={onExitDeck}
          title="Back to full NewAmp"
        >
          <BrandLogo size={18} withGlow={false} />
          <span>NEWAMP</span>
        </button>
        <DeckSkinPicker current="discman" onPick={props.onPickSkin} compact />
        <div className="deck-dm-window titlebar-nodrag">
          <button
            type="button"
            className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`}
            onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}
          >
            PIN
          </button>
          <button type="button" className="pxbtn" onClick={onExitDeck}>FULL</button>
          <button type="button" className="pxbtn" onClick={onMinimize}>_</button>
          <button type="button" className="pxbtn" onClick={onClose}>×</button>
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
          <span className="deck-dm-window-well">
            <span className="deck-dm-disc-spin">
              <span className="deck-dm-disc-metal" aria-hidden="true" />
              {!vizExpanded ? (
                <span className="deck-dm-disc-print">
                  {artUrl ? (
                    <img src={artUrl} alt={track?.album ?? ''} draggable={false} />
                  ) : (
                    <span className="deck-dm-disc-fallback">
                      <small>NEWAMP</small>
                      <strong>CD</strong>
                    </span>
                  )}
                </span>
              ) : null}
              <span className="deck-dm-data-rings" aria-hidden="true" />
              <span className="deck-dm-rainbow-arc" aria-hidden="true" />
            </span>
            {vizExpanded ? (
              <span className="deck-dm-viz">
                <Visualizer mode="mini" width={210} height={210} />
              </span>
            ) : null}
            <span className="deck-dm-lens" aria-hidden="true" />
            <span className="deck-dm-hub" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </span>
        </button>

        <section className="deck-dm-display" aria-label="CD player display">
          <div className="deck-dm-lcd-topline">
            <span className="deck-dm-kicker">{MODE_LABELS[mode]}</span>
            <span className="deck-dm-lcd-disc" aria-hidden="true"><i /></span>
            <span className="deck-dm-track-number">
              <small>TR</small>
              <strong>{trackNumber}</strong>
            </span>
          </div>
          <div className="deck-dm-title" title={track?.title}>
            {track?.title ?? 'NO DISC'}
          </div>
          <div className="deck-dm-artist" title={track?.artist}>
            {track?.artist ?? 'LOAD AUDIO'}
          </div>
          <div className="deck-dm-time">
            <span><small>ELAPSED</small>{formatTime(currentTime)}</span>
            <i aria-hidden="true">/</i>
            <span><small>TOTAL</small>{formatTime(duration)}</span>
          </div>
          <div className="deck-dm-progress-slot">
            <ScrubBar
              className="nslider deck-dm-seek"
              value={currentTime}
              max={duration || 1}
              onSeek={onSeek}
              ariaLabel="Seek through track"
            />
            <span className="deck-dm-progress-glass" aria-hidden="true" />
          </div>
        </section>
      </main>

      <footer className="deck-dm-controls titlebar-nodrag">
        <div className="deck-dm-transport">
          <button type="button" className="pxbtn" onClick={onPrev} title="Previous">
            <span className="deck-dm-control-icon" aria-hidden="true">◀◀</span>
            <span className="deck-dm-control-label">PREV</span>
          </button>
          <button
            type="button"
            className={`pxbtn deck-dm-play ${isPlaying ? 'is-active' : ''}`}
            onClick={onTogglePlay}
            title="Play / Pause"
          >
            <span className="deck-dm-control-icon" aria-hidden="true">{isPlaying ? '❚❚' : '▶'}</span>
            <span className="deck-dm-control-label">{isPlaying ? 'PAUSE' : 'PLAY'}</span>
          </button>
          <button type="button" className="pxbtn" onClick={onStop} title="Stop">
            <span className="deck-dm-control-icon is-stop" aria-hidden="true" />
            <span className="deck-dm-control-label">STOP</span>
          </button>
          <button type="button" className="pxbtn" onClick={onNext} title="Next">
            <span className="deck-dm-control-icon" aria-hidden="true">▶▶</span>
            <span className="deck-dm-control-label">NEXT</span>
          </button>
          <button
            type="button"
            className={`pxbtn ${mode === 'shuffle' ? 'is-active' : ''}`}
            onClick={() => onSetMode(mode === 'shuffle' ? 'normal' : 'shuffle')}
            title="Shuffle"
          >
            <span className="deck-dm-control-icon is-shuffle" aria-hidden="true">RND</span>
            <span className="deck-dm-control-label">SHUF</span>
          </button>
        </div>

        <div className="deck-dm-volume-bank">
          <div className="deck-dm-volume-heading">
            <span>VOLUME</span>
            <small>MIN · MAX</small>
          </div>
          <div className="deck-dm-volume-row">
            <span className="deck-dm-thumbwheel" aria-hidden="true"><i /></span>
            <VolumeSlider
              className="deck-dm-volume-slider"
              value={volume}
              onChange={onSetVolume}
              width={112}
              showLabel={false}
              compact
            />
          </div>
        </div>
      </footer>
    </div>
  );
}
