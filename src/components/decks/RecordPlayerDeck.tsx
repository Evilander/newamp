import { useMemo } from 'react';
import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';

export function RecordPlayerDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, alwaysOnTop, artUrl, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;

  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const tonearmAngle = useMemo(() => 10 + progress * 24, [progress]);

  return (
    <div className={`deck-record-player ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <svg
        className="deck-rp-plinth-art"
        viewBox="0 0 540 540"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="rpPlinthFace" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#484b4d" />
            <stop offset="0.19" stopColor="#303335" />
            <stop offset="0.62" stopColor="#202325" />
            <stop offset="1" stopColor="#151719" />
          </linearGradient>
          <linearGradient id="rpBaseEdge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#34271d" />
            <stop offset="0.42" stopColor="#171513" />
            <stop offset="1" stopColor="#070809" />
          </linearGradient>
          <radialGradient id="rpCornerLight" cx="0" cy="0" r="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.17" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <filter id="rpBrushedMetal" x="-4%" y="-4%" width="108%" height="108%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.006 0.72"
              numOctaves="1"
              seed="17"
              result="metalNoise"
            />
            <feColorMatrix
              in="metalNoise"
              type="matrix"
              values="0 0 0 0 0.72  0 0 0 0 0.76  0 0 0 0 0.79  0 0 0 0.08 0"
              result="metalGrain"
            />
            <feBlend in="SourceGraphic" in2="metalGrain" mode="screen" />
          </filter>
        </defs>

        <rect x="2.5" y="3.5" width="535" height="533" rx="6" fill="url(#rpBaseEdge)" stroke="#080807" />
        <rect
          x="5.5"
          y="2.5"
          width="529"
          height="529"
          rx="4"
          fill="url(#rpPlinthFace)"
          stroke="#66696a"
          strokeOpacity="0.5"
          filter="url(#rpBrushedMetal)"
        />
        <path d="M9 529.5H531" stroke="#080909" strokeWidth="3" />
        <path d="M8 5.5H532" stroke="#bfc3c4" strokeOpacity="0.16" />
        <path d="M7.5 7V530" stroke="#d5d8d8" strokeOpacity="0.1" />
        <path d="M532.5 8V529" stroke="#000000" strokeOpacity="0.66" />

        <path d="M7 7H132L86 57H7Z" fill="url(#rpCornerLight)" opacity="0.55" />
        <path d="M533 7H455L488 43H533Z" fill="url(#rpCornerLight)" opacity="0.18" />
        <path d="M7 531H104L66 491H7Z" fill="url(#rpCornerLight)" opacity="0.12" />
        <path d="M533 531H446L484 494H533Z" fill="#000000" opacity="0.18" />

        <g className="deck-rp-chassis-screws">
          <g transform="translate(17 52)">
            <circle r="4.5" fill="#111315" stroke="#6b6e70" />
            <path d="M-2.3 0H2.3" stroke="#050607" strokeWidth="1" />
            <path d="M-1.7 -1.7L1.7 1.7" stroke="#a7aaab" strokeOpacity="0.32" />
          </g>
          <g transform="translate(522 78)">
            <circle r="4.5" fill="#111315" stroke="#5e6163" />
            <path d="M-2.3 0H2.3" stroke="#050607" strokeWidth="1" />
            <path d="M-1.7 -1.7L1.7 1.7" stroke="#a7aaab" strokeOpacity="0.28" />
          </g>
          <g transform="translate(17 519)">
            <circle r="4.5" fill="#0d0f10" stroke="#515456" />
            <path d="M-2.3 0H2.3" stroke="#050607" strokeWidth="1" />
          </g>
          <g transform="translate(522 519)">
            <circle r="4.5" fill="#0d0f10" stroke="#515456" />
            <path d="M-2.3 0H2.3" stroke="#050607" strokeWidth="1" />
          </g>
        </g>
      </svg>

      <header className="deck-rp-titlebar titlebar-drag">
        <BrandLogo size={22} withGlow={false} />
        <span className="deck-rp-brand">NEWAMP <span>RP-1200 · REFERENCE</span></span>
        <div className="deck-rp-window titlebar-nodrag">
          <DeckSkinPicker current="record-player" onPick={props.onPickSkin} compact />
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

      <main className="deck-rp-stage titlebar-nodrag">
        <div className="deck-rp-power" aria-hidden="true">
          <span className="deck-rp-power-led" />
          <span>POWER</span>
        </div>

        <span className="deck-rp-strobe-lamp" aria-hidden="true">
          <span />
        </span>

        <button
          type="button"
          className="deck-rp-platter"
          data-newamp-open-visualizer
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          title={vizExpanded ? 'Show album label' : 'Show visualizer'}
          aria-label={vizExpanded ? 'Show album label' : 'Show visualizer'}
        >
          <span className="deck-rp-platter-shadow" />
          <span className="deck-rp-rotor">
            <span className="deck-rp-platter-rim" />
            <svg className="deck-rp-strobe-rings" viewBox="0 0 330 330" aria-hidden="true" focusable="false">
              <circle cx="165" cy="165" r="158.2" />
              <circle cx="165" cy="165" r="154.6" />
              <circle cx="165" cy="165" r="151" />
              <circle cx="165" cy="165" r="147.5" />
            </svg>
            <span className="deck-rp-mat" />
            <span className="deck-rp-vinyl">
              <span className="deck-rp-grooves" />
              {!vizExpanded && (
                <span className="deck-rp-label">
                  {artUrl ? (
                    <img src={artUrl} alt={track?.album ?? ''} draggable={false} />
                  ) : (
                    <span className="deck-rp-label-blank">{track ? '♪' : '—'}</span>
                  )}
                </span>
              )}
            </span>
          </span>

          {vizExpanded && (
            <span className="deck-rp-viz">
              <Visualizer mode="mini" width={320} height={320} />
            </span>
          )}
          <span className="deck-rp-spindle" />
        </button>

        <span className="deck-rp-target-light" aria-hidden="true">
          <span />
        </span>

        <svg
          className="deck-rp-tonearm"
          viewBox="0 0 190 252"
          style={{ transform: `rotate(${tonearmAngle.toFixed(2)}deg)` }}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id="rpArmChrome" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#3f4548" />
              <stop offset="0.22" stopColor="#d7dbdc" />
              <stop offset="0.47" stopColor="#737a7d" />
              <stop offset="0.72" stopColor="#eef0ef" />
              <stop offset="1" stopColor="#353a3d" />
            </linearGradient>
            <radialGradient id="rpBearingCap" cx="0.32" cy="0.24" r="0.8">
              <stop offset="0" stopColor="#f0f2f1" />
              <stop offset="0.28" stopColor="#858b8e" />
              <stop offset="0.68" stopColor="#373c3f" />
              <stop offset="1" stopColor="#111416" />
            </radialGradient>
            <linearGradient id="rpHeadshell" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5d6366" />
              <stop offset="0.2" stopColor="#222629" />
              <stop offset="1" stopColor="#080a0b" />
            </linearGradient>
          </defs>

          <g className="deck-rp-arm-lift">
            <ellipse className="deck-rp-bearing-shadow" cx="141" cy="64" rx="32" ry="14" />
            <path
              className="deck-rp-arm-shadow"
              d="M140 58 C140 82 128 95 108 106 C88 117 89 136 79 151 C69 166 67 181 68 194"
            />

            <g className="deck-rp-counterweight">
              <path d="M140 58L158 27" stroke="#252a2d" strokeWidth="8" strokeLinecap="round" />
              <rect x="149" y="12" width="22" height="34" rx="7" fill="url(#rpArmChrome)" stroke="#252a2c" />
              <path d="M153 16V42M158 15V43M163 15V43" stroke="#1d2224" strokeOpacity="0.58" />
              <ellipse cx="160" cy="14" rx="8" ry="3" fill="#bcc1c2" opacity="0.56" />
            </g>

            <ellipse cx="140" cy="65" rx="28" ry="12" fill="#15191b" stroke="#717678" />
            <rect x="124" y="45" width="32" height="21" rx="6" fill="url(#rpArmChrome)" stroke="#222729" />
            <circle cx="140" cy="55" r="13" fill="url(#rpBearingCap)" stroke="#94999a" />
            <circle cx="140" cy="55" r="4.2" fill="#171b1d" stroke="#b8bcbd" />
            <path d="M132 42H148" stroke="#f5f6f6" strokeOpacity="0.34" />

            <g className="deck-rp-antiskate">
              <circle cx="108" cy="60" r="10" fill="#171a1c" stroke="#8a8f91" />
              <circle cx="108" cy="60" r="5.5" fill="#3e4346" />
              <path d="M108 51V54M100 55L103 57M116 55L113 57M99 63L103 62M117 63L113 62" stroke="#c1c4c5" strokeWidth="0.8" />
              <path d="M108 60L112 56" stroke="#e1e3e3" strokeWidth="1" />
            </g>

            <path
              d="M140 58 C140 82 128 95 108 106 C88 117 89 136 79 151 C69 166 67 181 68 194"
              fill="none"
              stroke="#181c1e"
              strokeWidth="9.5"
              strokeLinecap="round"
            />
            <path
              d="M140 58 C140 82 128 95 108 106 C88 117 89 136 79 151 C69 166 67 181 68 194"
              fill="none"
              stroke="url(#rpArmChrome)"
              strokeWidth="6.4"
              strokeLinecap="round"
            />
            <path
              d="M137.8 59 C138 81 126 92 106 103 C87 114 87 134 77 148"
              fill="none"
              stroke="#ffffff"
              strokeOpacity="0.33"
              strokeWidth="1.15"
              strokeLinecap="round"
            />

            <g className="deck-rp-headshell">
              <path d="M68 190L65 202" stroke="#2b3032" strokeWidth="8" strokeLinecap="round" />
              <path d="M68 190L65 202" stroke="url(#rpArmChrome)" strokeWidth="5" strokeLinecap="round" />
              <path d="M65 198L49 207L53 218L68 211Z" fill="url(#rpHeadshell)" stroke="#747a7c" />
              <path d="M53 207L64 202" stroke="#d9dddd" strokeOpacity="0.36" />
              <circle cx="55" cy="211" r="1.4" fill="#c5c9ca" />
              <circle cx="62" cy="207" r="1.4" fill="#c5c9ca" />
              <path d="M53 216L54 221L64 223L67 215Z" fill="#111416" stroke="#3f4446" />
              <path d="M59 221L60 222.5" stroke="#aeb2b3" strokeWidth="1.2" />
              <circle cx="60" cy="223" r="1.4" fill="#16191a" />
            </g>
          </g>
        </svg>

        <div className="deck-rp-speed-bank" aria-hidden="true">
          <span className="deck-rp-speed-label">SPEED</span>
          <span className="is-selected">33</span>
          <span>45</span>
          <i />
        </div>

        <div className="deck-rp-pitch" aria-hidden="true">
          <span className="deck-rp-pitch-label">PITCH ADJ.</span>
          <span className="deck-rp-pitch-plus">+8</span>
          <span className="deck-rp-pitch-minus">−8</span>
          <span className="deck-rp-pitch-zero">0</span>
          <span className="deck-rp-pitch-slit">
            <i />
          </span>
        </div>

        <div className="deck-rp-nameplate" aria-hidden="true">
          <span>NEWAMP</span>
          <strong>RP-1200</strong>
          <small>QUARTZ DIRECT DRIVE · REFERENCE</small>
        </div>
      </main>

      <section className="deck-rp-info titlebar-nodrag" aria-label="Now playing">
        <div className="deck-rp-copy">
          <div className="deck-rp-title">{track ? track.title : 'No record loaded'}</div>
          <div className="deck-rp-artist">{track ? track.artist : 'Drop a track to spin it up.'}</div>
        </div>
        <div className="deck-rp-timeline">
          <ScrubBar className="nslider deck-rp-seek" value={currentTime} max={duration || 1} onSeek={onSeek} />
          <div className="deck-rp-times">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </section>

      <footer className="deck-rp-transport titlebar-nodrag">
        <div className="deck-rp-transport-buttons">
          <button className="pxbtn deck-rp-skip" onClick={onPrev} title="Previous">&lt;&lt;</button>
          <button className="pxbtn deck-rp-start-stop is-active" onClick={onTogglePlay} title="Play / Pause">
            {isPlaying ? 'Ⅱ' : '▶'}
          </button>
          <button className="pxbtn deck-rp-stop" onClick={onStop} title="Stop">■</button>
          <button className="pxbtn deck-rp-skip" onClick={onNext} title="Next">&gt;&gt;</button>
        </div>
        <span className="deck-rp-transport-legend" aria-hidden="true">START / STOP</span>
        <div className="deck-rp-volume">
          <span>OUTPUT LEVEL</span>
          <VolumeSlider value={volume} onChange={onSetVolume} width={120} showLabel={false} />
        </div>
      </footer>
    </div>
  );
}
