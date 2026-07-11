// Cassette Deck — "NEWAMP MX·90", a Type IV metal compact cassette at true
// 100:63.5 shell proportions with a hand-labeled mixtape card. The shell is a
// layered SVG object (smoked plastic, screws, tape window); the handwritten
// album/artist lines are HTML so they ellipsize, set in the marker font. Tape
// mass migrates from the supply hub to the take-up hub with playback progress.
// Clicking the shell swaps the face for a visualizer; the strip below is the
// deck transport with an LCD counter.

import type { DeckProps } from './types';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';

export function CassetteDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, alwaysOnTop, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;

  // Tape transfer: the supply pack empties into the take-up pack. Radii are in
  // SVG shell units (hub ring is r=20, packs breathe between 24 and 42).
  const playedFrac = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const supplyR = 24 + (1 - playedFrac) * 18;
  const takeupR = 24 + playedFrac * 18;

  return (
    <div className={`deck-cassette ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <header className="deck-cs-chrome titlebar-drag">
        <BrandLogo size={15} withGlow={false} />
        <span className="deck-cs-chrome-label">MX·90 · TYPE IV</span>
        <div className="deck-cs-window titlebar-nodrag">
          <DeckSkinPicker current="cassette" onPick={props.onPickSkin} compact />
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

      <button
        type="button"
        className="deck-cs-shell titlebar-nodrag"
        data-newamp-open-visualizer
        onClick={onToggleVizExpanded}
        onDoubleClick={onOpenFullscreenViz}
        title="Click to swap the label for a visualizer · double-click for fullscreen viz"
      >
        <CassetteShellArt supplyR={supplyR} takeupR={takeupR} />
        {vizExpanded ? (
          <div className="deck-cs-viz">
            <Visualizer mode="mini" width={560} height={230} />
          </div>
        ) : (
          <div className="deck-cs-handwriting" aria-hidden="true">
            <div className="deck-cs-hand deck-cs-hand-album">
              {track ? track.album || track.title : 'mixtape, vol. 1'}
            </div>
            <div className="deck-cs-hand deck-cs-hand-artist">
              {track ? track.artist : 'for whoever finds this'}
            </div>
            <div className="deck-cs-hand deck-cs-hand-note">
              {track?.year ? `dubbed ’${String(track.year).slice(-2)}` : 'dubbed with love'}
            </div>
            <div className="deck-cs-hand deck-cs-hand-side">A</div>
          </div>
        )}
      </button>

      <div className="deck-cs-seek titlebar-nodrag">
        <ScrubBar className="nslider" value={currentTime} max={duration || 1} onSeek={onSeek} />
      </div>

      <footer className="deck-cs-transport titlebar-nodrag">
        <div className="deck-cs-lcd">
          <span className="deck-cs-lcd-title">{track ? track.title : 'NO TAPE'}</span>
          <span className="deck-cs-lcd-time">
            {isPlaying ? '▶' : '‖'} {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
        <div className="deck-cs-keys">
          <button className="deck-cs-key" onClick={onPrev} title="Previous">◀◀</button>
          <button className="deck-cs-key is-primary" onClick={onTogglePlay} title="Play / Pause">
            {isPlaying ? '▮▮' : '▶'}
          </button>
          <button className="deck-cs-key" onClick={onStop} title="Stop">◼</button>
          <button className="deck-cs-key" onClick={onNext} title="Next">▶▶</button>
        </div>
        <VolumeSlider value={volume} onChange={onSetVolume} width={110} showLabel={false} compact />
      </footer>
    </div>
  );
}

/**
 * The cassette as an object. Fixed materials on purpose: a real shell doesn't
 * recolor with the app theme — the theme accent only survives on the deck's
 * LCD below. All strings in here are printed shell/label copy (static), so
 * SVG <text> is safe; anything dynamic lives in the HTML overlay above.
 */
function CassetteShellArt({ supplyR, takeupR }: { supplyR: number; takeupR: number }): JSX.Element {
  return (
    <svg
      className="deck-cs-art"
      viewBox="0 0 672 426"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="cs-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2e3037" />
          <stop offset="0.16" stopColor="#1f2126" />
          <stop offset="0.55" stopColor="#15161a" />
          <stop offset="1" stopColor="#0c0d10" />
        </linearGradient>
        <linearGradient id="cs-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3ecda" />
          <stop offset="0.8" stopColor="#ece3cc" />
          <stop offset="1" stopColor="#e3d8bc" />
        </linearGradient>
        <radialGradient id="cs-pack" cx="0.42" cy="0.38" r="0.75">
          <stop offset="0" stopColor="#54402a" />
          <stop offset="0.55" stopColor="#3a2917" />
          <stop offset="1" stopColor="#28180c" />
        </radialGradient>
        <radialGradient id="cs-screw" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#84888f" />
          <stop offset="0.55" stopColor="#4a4d53" />
          <stop offset="1" stopColor="#1a1b1e" />
        </radialGradient>
        <linearGradient id="cs-hub" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eae5d8" />
          <stop offset="1" stopColor="#b5afa0" />
        </linearGradient>
        <linearGradient id="cs-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.14" />
          <stop offset="0.28" stopColor="#ffffff" stopOpacity="0.03" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <filter id="cs-paper-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" values="0 0 0 0 0.3  0 0 0 0 0.27  0 0 0 0 0.2  0 0 0 0.5 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>

      {/* shell body */}
      <rect x="1.5" y="1.5" width="669" height="423" rx="14" fill="url(#cs-shell)" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
      <rect x="4" y="4" width="664" height="418" rx="12" fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="1.5" />

      {/* molded grip ridges, top corners */}
      <g stroke="rgba(255,255,255,0.055)" strokeWidth="1.4">
        <path d="M14 40h30M14 47h30M14 54h30M14 61h30" />
        <path d="M628 40h30M628 47h30M628 54h30M628 61h30" />
      </g>

      {/* embossed shell copy along the top strip */}
      <text x="336" y="23" textAnchor="middle" className="deck-cs-emboss-hi">POSITION METAL · TYPE IV · 70µs EQ</text>
      <text x="336" y="22" textAnchor="middle" className="deck-cs-emboss">POSITION METAL · TYPE IV · 70µs EQ</text>

      {/* the label card, fractionally rotated like it was stuck on by hand */}
      <g transform="rotate(-0.55 336 141)">
        <rect x="38" y="37" width="600" height="214" rx="5" fill="rgba(0,0,0,0.4)" />
        <rect x="36" y="34" width="600" height="214" rx="5" fill="url(#cs-paper)" stroke="#c6bb9e" strokeWidth="0.8" />
        <rect x="36" y="34" width="600" height="214" rx="5" filter="url(#cs-paper-grain)" opacity="0.35" fill="#fff" />

        {/* printed header: brand block, stripes, the 90 */}
        <path d="M52 50h132l-10 30H52z" fill="#b8432f" />
        <path d="M188 50h20l-10 30h-20z" fill="#2f4f6f" />
        <path d="M212 50h9l-10 30h-9z" fill="#b8432f" />
        <text x="60" y="71" className="deck-cs-print-brand">NEWAMP</text>
        <text x="238" y="72" className="deck-cs-print-model">MX·90</text>
        <text x="612" y="76" textAnchor="end" className="deck-cs-print-90">90</text>
        <text x="52" y="94" className="deck-cs-print-tiny">HIGH BIAS · METAL POSITION · IEC IV — SOUND YOU CAN LEAN ON</text>

        {/* ruled writing lines */}
        <g stroke="#b4a887" strokeWidth="1">
          <path d="M56 138h560" />
          <path d="M56 182h560" />
          <path d="M56 224h300" />
        </g>
        <text x="56" y="243" className="deck-cs-print-tiny">NR □ ON □ OFF</text>

        {/* SIDE A print ring — the letter itself is handwritten (HTML overlay) */}
        <circle cx="588" cy="204" r="24" fill="none" stroke="#b8432f" strokeWidth="2" />
        <text x="588" y="240" textAnchor="middle" className="deck-cs-print-tiny">SIDE</text>
      </g>

      {/* tape window */}
      <rect x="174" y="262" width="324" height="92" rx="11" fill="rgba(0,0,0,0.65)" />
      <rect x="176" y="264" width="320" height="88" rx="10" fill="#07080b" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
      {/* tape packs (radii driven by playback progress) */}
      <circle cx="256" cy="308" r={supplyR} fill="url(#cs-pack)" />
      <path d={`M ${256 - supplyR * 0.72} ${308 - supplyR * 0.6} A ${supplyR * 0.94} ${supplyR * 0.94} 0 0 1 ${256 + supplyR * 0.55} ${308 - supplyR * 0.76}`} fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth="2.6" />
      <circle cx="416" cy="308" r={takeupR} fill="url(#cs-pack)" />
      <path d={`M ${416 - takeupR * 0.72} ${308 - takeupR * 0.6} A ${takeupR * 0.94} ${takeupR * 0.94} 0 0 1 ${416 + takeupR * 0.55} ${308 - takeupR * 0.76}`} fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth="2.6" />
      {/* tape ribbon running the bottom of the window */}
      <rect x="180" y="341" width="312" height="5" fill="#1c1009" />
      {/* hubs: white toothed rings; CSS spins the inner group while playing.
          The translate must stay on the OUTER g — a CSS transform animation
          on the same element would replace the attribute transform. */}
      <g transform="translate(256 308)">
        <Hub />
      </g>
      <g transform="translate(416 308)">
        <Hub takeup />
      </g>
      {/* window glass streaks */}
      <path d="M206 264l34 0-52 88h-12z" fill="#ffffff" opacity="0.05" />
      <path d="M258 264l14 0-52 88h-14z" fill="#ffffff" opacity="0.035" />

      {/* molded tape-direction arrows */}
      <g fill="rgba(255,255,255,0.07)">
        <path d="M136 302l14 7-14 7z" />
        <path d="M152 302l14 7-14 7z" />
        <path d="M522 302l14 7-14 7z" />
        <path d="M538 302l14 7-14 7z" />
      </g>

      {/* bottom head trapezoid: capstan holes, pressure pad, head opening */}
      <path d="M226 426l26-50h168l26 50z" fill="#0b0c0f" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
      <circle cx="270" cy="401" r="6" fill="#040507" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
      <circle cx="402" cy="401" r="6" fill="#040507" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
      <rect x="296" y="386" width="12" height="20" rx="2" fill="#040507" />
      <rect x="364" y="386" width="12" height="20" rx="2" fill="#040507" />
      <rect x="316" y="386" width="40" height="20" rx="3" fill="#040507" />
      <rect x="322" y="392" width="28" height="9" rx="2" fill="#5f5142" />

      {/* screws — each cross clocked differently, like they've been in and out */}
      <Screw x={24} y={24} a={20} />
      <Screw x={648} y={24} a={-32} />
      <Screw x={24} y={402} a={64} />
      <Screw x={648} y={402} a={-8} />
      <Screw x={336} y={366} a={42} />

      {/* one soft light pass over the whole shell */}
      <rect x="1.5" y="1.5" width="669" height="423" rx="14" fill="url(#cs-sheen)" pointerEvents="none" />
    </svg>
  );
}

function Hub({ takeup = false }: { takeup?: boolean }): JSX.Element {
  return (
    <g className={`deck-cs-hub ${takeup ? 'is-takeup' : ''}`}>
      <circle r="20" fill="url(#cs-hub)" stroke="#8e887a" strokeWidth="1" />
      <circle r="12.5" fill="#0b0c0f" />
      <g fill="#0b0c0f">
        <rect x="-2.6" y="-19.5" width="5.2" height="8" rx="1.2" />
        <rect x="-2.6" y="-19.5" width="5.2" height="8" rx="1.2" transform="rotate(60)" />
        <rect x="-2.6" y="-19.5" width="5.2" height="8" rx="1.2" transform="rotate(120)" />
        <rect x="-2.6" y="-19.5" width="5.2" height="8" rx="1.2" transform="rotate(180)" />
        <rect x="-2.6" y="-19.5" width="5.2" height="8" rx="1.2" transform="rotate(240)" />
        <rect x="-2.6" y="-19.5" width="5.2" height="8" rx="1.2" transform="rotate(300)" />
      </g>
    </g>
  );
}

function Screw({ x, y, a }: { x: number; y: number; a: number }): JSX.Element {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="7" fill="url(#cs-screw)" stroke="#08090b" strokeWidth="1" />
      <g transform={`rotate(${a})`} fill="rgba(0,0,0,0.6)">
        <rect x="-5" y="-0.9" width="10" height="1.8" rx="0.9" />
        <rect x="-0.9" y="-5" width="1.8" height="10" rx="0.9" />
      </g>
    </g>
  );
}
