// Jukebox Deck — "NEWAMP Bandstand", a Wurlitzer 1015 seen up close: the
// window frames the machine's top half so every material reads at full size.
// The cabinet is a layered SVG — burgundy wood, concentric chrome bands, a
// color-gel arch that slowly cycles hue like the rotating gel cylinders, and
// a bubble tube the CSS bubbles actually travel along (offset-path follows
// the same arc geometry as the drawn tube). Inside the glass: a spinning 45
// with the album art as its label, a tonearm riding playback progress, and a
// typed title-strip card. Below: selector keys, a chrome coin plate carrying
// the transport, and the lamp-lit speaker grille.

import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';

const BUBBLES_PER_TUBE = 6;

export function JukeboxDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, alwaysOnTop, artUrl, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;

  const selectionNo = String(track?.trackNo ?? 1).padStart(2, '0');
  const selectionDemo = !track || track.trackNo == null;
  const litKey = ((track?.trackNo ?? 1) - 1 + 12) % 12;
  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const tonearmAngle = 14 + progress * 20;

  return (
    <div className={`deck-jukebox ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <header className="deck-jb-chrome titlebar-drag">
        <BrandLogo size={15} withGlow={false} />
        <span className="deck-jb-chrome-label">BANDSTAND · 45 RPM</span>
        <div className="deck-jb-window titlebar-nodrag">
          <DeckSkinPicker current="jukebox" onPick={props.onPickSkin} compact />
          <button
            className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`}
            onClick={() => onSetAlwaysOnTop(!alwaysOnTop)}
            title={alwaysOnTop ? 'Unpin window' : 'Pin window on top'}
          >PIN</button>
          <button className="pxbtn" onClick={onExitDeck} title="Back to full library">FULL</button>
          <button className="pxbtn" onClick={onMinimize} title="Minimize">_</button>
          <button className="pxbtn" onClick={onClose} title="Close" style={{ color: 'var(--error)' }}>×</button>
        </div>
      </header>

      <div className="deck-jb-stage titlebar-nodrag">
        <JukeboxCabinetArt />

        {/* bubbles ride the same arc the tube is drawn on */}
        <div className="deck-jb-bubbles" aria-hidden="true">
          {Array.from({ length: BUBBLES_PER_TUBE }, (_, i) => (
            <span
              key={`l${i}`}
              className="deck-jb-bubble is-left"
              style={{ animationDelay: `${i * 760}ms` }}
            />
          ))}
          {Array.from({ length: BUBBLES_PER_TUBE }, (_, i) => (
            <span
              key={`r${i}`}
              className="deck-jb-bubble is-right"
              style={{ animationDelay: `${i * 820 + 380}ms` }}
            />
          ))}
        </div>

        {/* the record chamber: spinning 45 or the visualizer */}
        <button
          type="button"
          className="deck-jb-chamber"
          data-newamp-open-visualizer
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          title={vizExpanded ? 'Show the 45' : 'Show visualizer'}
        >
          {vizExpanded ? (
            <div className="deck-jb-viz">
              <Visualizer mode="mini" width={220} height={220} />
            </div>
          ) : (
            <div className="deck-jb-disc">
              <span className="deck-jb-disc-grooves" aria-hidden="true" />
              <span className="deck-jb-disc-label">
                {artUrl ? (
                  <img src={artUrl} alt={track?.album ?? ''} draggable={false} />
                ) : (
                  <span className="deck-jb-disc-blank">45</span>
                )}
              </span>
              <span className="deck-jb-disc-hole" aria-hidden="true" />
            </div>
          )}
        </button>
        {!vizExpanded && <JukeboxTonearm angle={tonearmAngle} />}
        <div className="deck-jb-glass" aria-hidden="true" />

        {/* typed title-strip card */}
        <div className="deck-jb-strips">
          <div className="deck-jb-strip-head">
            <span className="deck-jb-strip-sel">A–{selectionNo}</span>
            {selectionDemo ? <span className="deck-jb-strip-demo">DEMO</span> : null}
          </div>
          <div className="deck-jb-strip-title" title={track?.title}>{track?.title ?? 'NO SELECTION'}</div>
          <div className="deck-jb-strip-artist" title={track?.artist}>{track?.artist ?? 'insert coin'}</div>
        </div>

        {/* selector keys — the current selection stays lit */}
        <div className="deck-jb-keys" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} className={`deck-jb-keycap ${i === litKey ? 'is-lit' : ''}`}>
              {i + 1}
            </span>
          ))}
        </div>

        {/* chrome coin plate with the transport */}
        <div className="deck-jb-plate">
          <span className="deck-jb-coin" aria-hidden="true" />
          <span className="deck-jb-coin-label" aria-hidden="true">10¢</span>
          <div className="deck-jb-transport">
            <button className="deck-jb-push" onClick={onPrev} title="Previous">◀◀</button>
            <button className="deck-jb-push is-primary" onClick={onTogglePlay} title="Play / Pause">
              {isPlaying ? '▮▮' : '▶'}
            </button>
            <button className="deck-jb-push" onClick={onStop} title="Stop">◼</button>
            <button className="deck-jb-push" onClick={onNext} title="Next">▶▶</button>
          </div>
          <div className="deck-jb-volume">
            <VolumeSlider value={volume} onChange={onSetVolume} width={104} showLabel={false} compact />
          </div>
        </div>

        {/* seek strip */}
        <div className="deck-jb-seek">
          <span className="deck-jb-time">{formatTime(currentTime)}</span>
          <ScrubBar className="nslider" value={currentTime} max={duration || 1} onSeek={onSeek} />
          <span className="deck-jb-time">{formatTime(duration)}</span>
        </div>

        {/* lamp glow breathing over the grille while playing */}
        <div className="deck-jb-lamp" aria-hidden="true" />
      </div>
    </div>
  );
}

/** The Bandstand cabinet. Static printed/molded copy only. */
function JukeboxCabinetArt(): JSX.Element {
  return (
    <svg
      className="deck-jb-cabinet"
      viewBox="0 0 420 534"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="jb-wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5c2417" />
          <stop offset="0.5" stopColor="#43170e" />
          <stop offset="1" stopColor="#2a0d07" />
        </linearGradient>
        <linearGradient id="jb-chrome" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e9edf2" />
          <stop offset="0.22" stopColor="#8d939c" />
          <stop offset="0.5" stopColor="#f2f5f8" />
          <stop offset="0.78" stopColor="#7c828b" />
          <stop offset="1" stopColor="#d7dbe0" />
        </linearGradient>
        <linearGradient id="jb-gel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e0442c" />
          <stop offset="0.35" stopColor="#f2872f" />
          <stop offset="0.65" stopColor="#f2b62f" />
          <stop offset="1" stopColor="#d8332f" />
        </linearGradient>
        <linearGradient id="jb-tube" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#c96f2b" />
          <stop offset="0.5" stopColor="#f0b45c" />
          <stop offset="1" stopColor="#a3541f" />
        </linearGradient>
        <radialGradient id="jb-backlight" cx="0.5" cy="0.42" r="0.72">
          <stop offset="0" stopColor="#8a3d16" />
          <stop offset="0.55" stopColor="#431a09" />
          <stop offset="1" stopColor="#1f0a04" />
        </radialGradient>
        <linearGradient id="jb-felt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4e1210" />
          <stop offset="1" stopColor="#2a0806" />
        </linearGradient>
        <filter id="jb-wood-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.015 0.16" numOctaves="3" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" values="0 0 0 0 0.12  0 0 0 0 0.03  0 0 0 0 0.01  0 0 0 0.5 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
        <path id="jb-brand-arc" d="M 92.6 134.6 A 166 166 0 0 1 327.4 134.6" fill="none" />
      </defs>

      {/* cabinet body */}
      <path d="M18 534 L18 252 A192 192 0 0 1 402 252 L402 534 Z" fill="url(#jb-wood)" />
      <path d="M18 534 L18 252 A192 192 0 0 1 402 252 L402 534 Z" filter="url(#jb-wood-grain)" fill="#fff" />
      <path d="M19.5 534 L19.5 252 A190.5 190.5 0 0 1 400.5 252 L400.5 534" fill="none" stroke="rgba(255,190,130,0.16)" strokeWidth="1.4" />

      {/* concentric arch: chrome band → gel band → bubble tube → chrome trim */}
      <path d="M30 534 L30 252 A180 180 0 0 1 390 252 L390 534" fill="none" stroke="url(#jb-chrome)" strokeWidth="13" />
      <path d="M30 534 L30 252 A180 180 0 0 1 390 252 L390 534" fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="1" transform="translate(0 6.2)" opacity="0.5" />
      <path className="deck-jb-gel" d="M47 534 L47 252 A163 163 0 0 1 373 252 L373 534" fill="none" stroke="url(#jb-gel)" strokeWidth="20" />
      <path d="M63 534 L63 252 A147 147 0 0 1 357 252 L357 534" fill="none" stroke="url(#jb-tube)" strokeWidth="11" />
      <path d="M60.5 534 L60.5 252 A144.5 144.5 0 0 1 349 155" fill="none" stroke="rgba(255,255,255,0.34)" strokeWidth="1.6" />
      <path d="M72 534 L72 252 A138 138 0 0 1 348 252 L348 534" fill="none" stroke="url(#jb-chrome)" strokeWidth="5" />

      {/* brand marquee riding the gel band */}
      <text className="deck-jb-marquee">
        <textPath href="#jb-brand-arc" startOffset="50%" textAnchor="middle">NEWAMP · BANDSTAND</textPath>
      </text>

      {/* record chamber: warm backlit interior */}
      <path d="M77 350 L77 252 A133 133 0 0 1 343 252 L343 350 Z" fill="url(#jb-backlight)" />
      <path d="M77 350 L77 252 A133 133 0 0 1 343 252 L343 350" fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth="2" />

      {/* title-strip card holder */}
      <rect x="76" y="352" width="268" height="58" rx="7" fill="#1c1a17" stroke="url(#jb-chrome)" strokeWidth="2.5" />
      <rect x="83" y="358" width="254" height="46" rx="3" fill="#efe6cf" />
      <path d="M83 358h18v9h-18z" fill="#c23b2c" />
      <path d="M319 358h18v9h-18z" fill="#c23b2c" />

      {/* coin plate */}
      <rect x="60" y="440" width="300" height="56" rx="9" fill="url(#jb-chrome)" />
      <rect x="62.5" y="442.5" width="295" height="51" rx="7" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1" />
      <rect x="63" y="443" width="294" height="24" rx="7" fill="rgba(255,255,255,0.28)" />

      {/* grille: red felt behind chrome ribs */}
      <rect x="42" y="502" width="336" height="32" fill="url(#jb-felt)" />
      <g fill="url(#jb-chrome)">
        <rect x="56" y="502" width="7" height="32" rx="3" />
        <rect x="82" y="502" width="7" height="32" rx="3" />
        <rect x="108" y="502" width="7" height="32" rx="3" />
        <rect x="134" y="502" width="7" height="32" rx="3" />
        <rect x="160" y="502" width="7" height="32" rx="3" />
        <rect x="186" y="502" width="7" height="32" rx="3" />
        <rect x="212" y="502" width="7" height="32" rx="3" />
        <rect x="238" y="502" width="7" height="32" rx="3" />
        <rect x="264" y="502" width="7" height="32" rx="3" />
        <rect x="290" y="502" width="7" height="32" rx="3" />
        <rect x="316" y="502" width="7" height="32" rx="3" />
        <rect x="342" y="502" width="7" height="32" rx="3" />
      </g>
    </svg>
  );
}

/** The changer's short chrome play arm, reaching in from the lower right the
    way the 1015's mechanism does. Sweeps gently inward with progress. */
function JukeboxTonearm({ angle }: { angle: number }): JSX.Element {
  return (
    <svg
      className="deck-jb-tonearm"
      viewBox="0 0 110 160"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={`rotate(${(angle * 0.4).toFixed(2)} 92 138)`}>
        <line x1="92" y1="138" x2="40" y2="62" stroke="rgba(0,0,0,0.4)" strokeWidth="7" strokeLinecap="round" transform="translate(2 2)" />
        <line x1="92" y1="138" x2="40" y2="62" stroke="#5a5e64" strokeWidth="6" strokeLinecap="round" />
        <line x1="91" y1="136" x2="41" y2="63" stroke="#d4d8dd" strokeWidth="2.2" strokeLinecap="round" />
        <rect x="31" y="52" width="17" height="13" rx="3" fill="#2c2f34" stroke="#9aa0a6" strokeWidth="1" transform="rotate(34 40 58)" />
      </g>
      <circle cx="92" cy="138" r="12" fill="#3c3f45" stroke="#b9bec4" strokeWidth="2" />
      <circle cx="92" cy="138" r="4" fill="#141518" />
    </svg>
  );
}
