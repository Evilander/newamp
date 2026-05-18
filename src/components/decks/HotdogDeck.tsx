import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { DeckSkinPicker } from './DeckSkinPicker';

// Mustard zigzag x-range inside the SVG viewBox. Filling from 170 to 1020
// turns the squeeze-bottle line into the playback progress indicator.
const MUSTARD_X_START = 170;
const MUSTARD_X_END = 1020;

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
  const mustardFillX = MUSTARD_X_START + progress * (MUSTARD_X_END - MUSTARD_X_START);

  const titleLine = track ? track.title : 'No track loaded';
  const subLine = track
    ? [track.artist, track.album].filter(Boolean).join(' · ')
    : 'Drop a song to serve it hot';

  return (
    <div className={`deck-hotdog ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <svg
        className="deck-hd-art"
        viewBox="0 0 1200 360"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="hd-bun-top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbd594" />
            <stop offset="35%" stopColor="#e8a558" />
            <stop offset="78%" stopColor="#c0762e" />
            <stop offset="100%" stopColor="#7d420f" />
          </linearGradient>
          <linearGradient id="hd-bun-bottom" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7a3d11" />
            <stop offset="35%" stopColor="#b56823" />
            <stop offset="75%" stopColor="#e3a052" />
            <stop offset="100%" stopColor="#f6c982" />
          </linearGradient>
          <linearGradient id="hd-sausage" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff8a55" />
            <stop offset="12%" stopColor="#d63c14" />
            <stop offset="55%" stopColor="#a51e08" />
            <stop offset="100%" stopColor="#4a0b02" />
          </linearGradient>
          <radialGradient id="hd-sausage-gloss" cx="0.5" cy="0.18" r="0.5">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="60%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="hd-mustard" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff09a" />
            <stop offset="50%" stopColor="#f6c41a" />
            <stop offset="100%" stopColor="#a17b00" />
          </linearGradient>
          <radialGradient id="hd-seed" cx="0.4" cy="0.3" r="0.7">
            <stop offset="0%" stopColor="#fff6c8" />
            <stop offset="55%" stopColor="#e8c266" />
            <stop offset="100%" stopColor="#8c5008" />
          </radialGradient>
          <filter id="hd-crumb" x="-2%" y="-2%" width="104%" height="104%">
            <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="7" result="n" />
            <feColorMatrix in="n" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.17 0" />
            <feComposite in2="SourceGraphic" operator="in" />
            <feBlend in2="SourceGraphic" mode="multiply" />
          </filter>
          <filter id="hd-mshad" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="1.4" in="SourceAlpha" />
            <feOffset dx="0" dy="2" />
            <feFlood floodColor="#4a2a00" floodOpacity="0.5" />
            <feComposite in2="SourceAlpha" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id="hd-mustard-fill">
            <rect x="0" y="0" width={mustardFillX} height="360" />
          </clipPath>
        </defs>

        {/* Floor shadow */}
        <ellipse cx="600" cy="332" rx="500" ry="14" fill="#000" opacity="0.5" />

        {/* Bottom bun */}
        <g>
          <path
            d="M 100 220 C 100 290, 200 320, 600 320 C 1000 320, 1100 290, 1100 220 C 1100 215, 1095 212, 1080 212 L 120 212 C 105 212, 100 215, 100 220 Z"
            fill="url(#hd-bun-bottom)"
          />
          <path
            d="M 100 220 C 100 290, 200 320, 600 320 C 1000 320, 1100 290, 1100 220 C 1100 215, 1095 212, 1080 212 L 120 212 C 105 212, 100 215, 100 220 Z"
            fill="url(#hd-bun-bottom)"
            filter="url(#hd-crumb)"
            opacity="0.7"
          />
          <path
            d="M 160 295 Q 600 332, 1040 295"
            stroke="#5e2a08"
            strokeWidth="4"
            fill="none"
            opacity="0.6"
            strokeLinecap="round"
          />
        </g>

        {/* Sausage */}
        <g>
          <ellipse cx="600" cy="200" rx="490" ry="48" fill="url(#hd-sausage)" />
          <ellipse cx="600" cy="175" rx="440" ry="14" fill="url(#hd-sausage-gloss)" />
          <ellipse cx="140" cy="198" rx="20" ry="38" fill="#3a0902" opacity="0.55" />
          <ellipse cx="1060" cy="198" rx="20" ry="38" fill="#3a0902" opacity="0.55" />
          <ellipse cx="600" cy="232" rx="470" ry="6" fill="#000" opacity="0.32" />
        </g>

        {/* Relish chunks scattered along the top of the sausage */}
        <g opacity="0.9">
          <ellipse cx="240" cy="186" rx="6" ry="3" fill="#3fbf66" transform="rotate(18 240 186)" />
          <ellipse cx="262" cy="190" rx="5" ry="3" fill="#2a8444" transform="rotate(-12 262 190)" />
          <ellipse cx="320" cy="184" rx="7" ry="3" fill="#4dd17a" transform="rotate(34 320 184)" />
          <ellipse cx="358" cy="190" rx="6" ry="3" fill="#2a8444" transform="rotate(-22 358 190)" />
          <ellipse cx="410" cy="184" rx="5" ry="3" fill="#3fbf66" transform="rotate(8 410 184)" />
          <ellipse cx="470" cy="190" rx="7" ry="3" fill="#4dd17a" transform="rotate(-18 470 190)" />
          <ellipse cx="540" cy="184" rx="6" ry="3" fill="#2a8444" transform="rotate(22 540 184)" />
          <ellipse cx="600" cy="188" rx="5" ry="3" fill="#3fbf66" transform="rotate(-8 600 188)" />
          <ellipse cx="666" cy="184" rx="7" ry="3" fill="#4dd17a" transform="rotate(28 666 184)" />
          <ellipse cx="730" cy="190" rx="6" ry="3" fill="#2a8444" transform="rotate(-14 730 190)" />
          <ellipse cx="790" cy="184" rx="5" ry="3" fill="#3fbf66" transform="rotate(16 790 184)" />
          <ellipse cx="852" cy="190" rx="7" ry="3" fill="#4dd17a" transform="rotate(-26 852 190)" />
          <ellipse cx="912" cy="184" rx="6" ry="3" fill="#2a8444" transform="rotate(18 912 184)" />
          <ellipse cx="960" cy="190" rx="5" ry="3" fill="#3fbf66" transform="rotate(-8 960 190)" />
        </g>

        {/* Faded mustard line (full path, low opacity) — the "remaining" portion */}
        <g opacity="0.18">
          <path
            d="M 170 178 C 200 158, 230 200, 268 178 C 300 158, 332 200, 370 178 C 405 158, 440 200, 478 178 C 510 158, 545 200, 585 178 C 618 158, 654 200, 692 178 C 728 158, 762 200, 800 178 C 836 158, 870 200, 908 178 C 942 158, 980 200, 1020 178"
            stroke="#a17b00"
            strokeWidth="10"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* Squeezed mustard — clipped to the progress fraction */}
        <g filter="url(#hd-mshad)" clipPath="url(#hd-mustard-fill)">
          <path
            d="M 170 178 C 200 158, 230 200, 268 178 C 300 158, 332 200, 370 178 C 405 158, 440 200, 478 178 C 510 158, 545 200, 585 178 C 618 158, 654 200, 692 178 C 728 158, 762 200, 800 178 C 836 158, 870 200, 908 178 C 942 158, 980 200, 1020 178"
            stroke="url(#hd-mustard)"
            strokeWidth="14"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M 174 174 C 204 156, 232 196, 270 174 C 302 156, 334 196, 372 174 C 407 156, 442 196, 480 174 C 512 156, 547 196, 587 174 C 620 156, 656 196, 694 174 C 730 156, 764 196, 802 174 C 838 156, 872 196, 910 174 C 944 156, 982 196, 1022 174"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
          />
        </g>

        {/* Top bun */}
        <g>
          <path
            d="M 100 220 C 100 130, 200 50, 600 50 C 1000 50, 1100 130, 1100 220 C 1100 230, 1080 232, 1060 220 C 980 158, 800 138, 600 138 C 400 138, 220 158, 140 220 C 120 232, 100 230, 100 220 Z"
            fill="url(#hd-bun-top)"
          />
          <path
            d="M 100 220 C 100 130, 200 50, 600 50 C 1000 50, 1100 130, 1100 220 C 1100 230, 1080 232, 1060 220 C 980 158, 800 138, 600 138 C 400 138, 220 158, 140 220 C 120 232, 100 230, 100 220 Z"
            fill="url(#hd-bun-top)"
            filter="url(#hd-crumb)"
            opacity="0.65"
          />
          <path
            d="M 180 110 C 320 60, 880 60, 1020 110"
            stroke="rgba(255,235,180,0.55)"
            strokeWidth="6"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M 140 220 C 220 158, 400 138, 600 138 C 800 138, 980 158, 1060 220"
            stroke="#5e2a08"
            strokeWidth="2"
            fill="none"
            opacity="0.45"
          />
        </g>

        {/* Sesame seeds on top bun */}
        <g>
          {SESAME_SEEDS.map(([cx, cy, rx, ry, rot], i) => (
            <ellipse
              key={i}
              cx={cx}
              cy={cy}
              rx={rx}
              ry={ry}
              fill="url(#hd-seed)"
              transform={`rotate(${rot} ${cx} ${cy})`}
            />
          ))}
        </g>
      </svg>

      <header className="deck-hd-titlebar">
        <button className="deck-hd-brand titlebar-nodrag" onClick={onExitDeck} title="Back to full NewAmp">
          <span aria-hidden="true">●</span> CONEY
        </button>
        <span className="deck-hd-marquee" title={track ? `${track.artist ?? ''} – ${track.title}` : ''}>
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
            ↗
          </button>
          <button className="deck-hd-win" onClick={onMinimize} title="Minimize" aria-label="Minimize">
            _
          </button>
          <button className="deck-hd-win is-x" onClick={onClose} title="Close" aria-label="Close">
            ×
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
          style={{ '--p': `${progress * 100}%` } as React.CSSProperties}
          aria-label="Seek"
        />
        <span className="deck-hd-time-total">{formatTime(duration)}</span>
      </div>

      <footer className="deck-hd-transport titlebar-nodrag">
        <button className="deck-hd-t" onClick={onPrev} title="Previous" aria-label="Previous">⏮</button>
        <button
          className="deck-hd-t is-play"
          onClick={onTogglePlay}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button className="deck-hd-t" onClick={onStop} title="Stop" aria-label="Stop">■</button>
        <button className="deck-hd-t" onClick={onNext} title="Next" aria-label="Next">⏭</button>
        <VolumeSlider value={volume} onChange={onSetVolume} width={120} showLabel={false} compact />
      </footer>
    </div>
  );
}

// Scattered sesame seed positions on the top bun. Hand-placed so they trace the
// curve of the bun rather than fall in a grid.
const SESAME_SEEDS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [210, 118, 5.5, 2.8, -22],
  [244, 108, 5.0, 2.6, -14],
  [285, 98,  5.5, 2.8, -8],
  [332, 88,  5.0, 2.6, -4],
  [220, 142, 5.0, 2.6, -18],
  [268, 130, 5.5, 2.8, -10],
  [318, 118, 5.0, 2.6, -6],
  [372, 106, 5.5, 2.8, -2],
  [390, 76,  5.0, 2.6, 0],
  [442, 68,  5.5, 2.8, 4],
  [500, 62,  5.0, 2.6, 2],
  [558, 60,  5.5, 2.8, -2],
  [612, 62,  5.0, 2.6, 2],
  [668, 66,  5.5, 2.8, -4],
  [728, 72,  5.0, 2.6, 0],
  [430, 100, 5.0, 2.6, -2],
  [490, 94,  5.5, 2.8, 0],
  [560, 92,  5.0, 2.6, 2],
  [624, 92,  5.5, 2.8, -2],
  [688, 96,  5.0, 2.6, 4],
  [752, 100, 5.5, 2.8, -4],
  [788, 84,  5.0, 2.6, 8],
  [836, 92,  5.5, 2.8, 10],
  [884, 104, 5.0, 2.6, 12],
  [928, 116, 5.5, 2.8, 16],
  [970, 130, 5.0, 2.6, 20],
  [816, 118, 5.5, 2.8, 6],
  [864, 128, 5.0, 2.6, 8],
  [906, 140, 5.5, 2.8, 14],
];
