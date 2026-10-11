// Retro TV Deck — "NEWAMP Telestar", a late-60s walnut table television.
// The cabinet is a layered SVG object (wood grain, plastic bezel, brushed
// console plate, chrome badge, feet); the CRT is an HTML button carrying the
// album art / visualizer under phosphor, scanline, vignette and grain layers.
// Changing tracks "retunes" the set: a one-shot channel-flip animation with a
// rolling bar plus a green OSD channel number, and the CH knob physically
// advances. Both knobs are real: the CH knob changes track when it is clicked,
// dragged, scrolled or given the arrow keys, and the VOL knob is the volume.

import {
  useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import type { DeckProps } from './types';
import { clampVolume } from '../../lib/wheel-volume';
import { handlePlayerWheel } from '../../lib/player-wheel';
import { Visualizer } from '../Visualizer';
import { formatTime } from '../../lib/format';
import { VolumeSlider, volumeLabel } from '../VolumeSlider';
import { BrandLogo } from '../BrandLogo';
import { DeckSkinPicker } from './DeckSkinPicker';
import { ScrubBar } from '../ScrubBar';
import { DeckWindowButtons } from './DeckWindowButtons';
import { ChannelGesture, ChannelWheel, VolumeKnobGesture, channelKeyStep, tvScreenLabel } from './deck-controls';

export function RetroTvDeck(props: DeckProps): JSX.Element {
  const {
    track, isPlaying, currentTime, duration, volume, alwaysOnTop, artUrl, vizExpanded,
    onTogglePlay, onNext, onPrev, onStop, onSeek, onSetVolume, onSetAlwaysOnTop,
    onExitDeck, onMinimize, onClose, onToggleVizExpanded, onOpenFullscreenViz,
  } = props;

  // Channel retune: every distinct track remounts the tuning overlay (keyed
  // element restarts its one-shot CSS animation) and clicks the CH knob
  // forward by one detent.
  const [tuneKey, setTuneKey] = useState(0);
  const [chSpin, setChSpin] = useState(0);
  const lastTrackId = useRef<number | null>(null);
  useEffect(() => {
    if (track?.id != null && track.id !== lastTrackId.current) {
      lastTrackId.current = track.id;
      setTuneKey((k) => k + 1);
      setChSpin((deg) => deg + 30);
    }
  }, [track?.id]);

  const channel = track?.trackNo ?? null;

  // Channel knob: a click or a drag turns it a detent at a time, up and right
  // forward. The retune effect above spins it on any track change, so a turn
  // by hand and an automatic advance look the same.
  const channelGesture = useRef<ChannelGesture | null>(null);
  const channelWheel = useRef<ChannelWheel | null>(null);
  channelWheel.current ??= new ChannelWheel();
  const turnChannel = (step: number): void => {
    if (step > 0) onNext();
    else if (step < 0) onPrev();
  };
  const endChannelGesture = (knob: HTMLDivElement): void => {
    channelGesture.current = null;
    // Arrow keys and Space belong to the knob only for someone who tabbed to
    // it. After a mouse press they go back to the global shortcuts (seek,
    // volume, play/pause) instead of skipping tracks.
    knob.blur();
  };
  const onChannelPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    channelGesture.current = new ChannelGesture(event.clientX, event.clientY);
  };
  const onChannelPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    turnChannel(channelGesture.current?.move(event.clientX, event.clientY) ?? 0);
  };
  const onChannelPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = channelGesture.current;
    endChannelGesture(event.currentTarget);
    if (gesture?.isClick) turnChannel(event.shiftKey ? -1 : 1);
  };
  // Assistive technology activates a button with a synthesized click that has
  // no pointer or key events behind it. A real mouse click has detail >= 1 and
  // was already handled on release.
  const onChannelClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.detail === 0) turnChannel(event.shiftKey ? -1 : 1);
  };
  const onChannelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Chords such as Cmd+Up (volume) and Ctrl+Left (previous) stay global.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = channelKeyStep(event.key);
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    // A held key repeats at the OS rate, and every step is a track change.
    if (!event.repeat) turnChannel(step);
  };

  // Volume knob: the element holds the pointer while it is dragged, so its own
  // handlers see the whole gesture and nothing is left on window if the deck
  // goes away mid-drag.
  const knobRef = useRef<HTMLDivElement>(null);
  const knobGesture = useRef<VolumeKnobGesture | null>(null);
  // Bound by hand: React's onWheel is passive and can't claim the wheel.
  useEffect(() => {
    const node = knobRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => handlePlayerWheel(event, 'knob');
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);
  const onKnobPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    knobGesture.current = new VolumeKnobGesture(event.clientX, event.clientY, volume);
  };
  const onKnobPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = knobGesture.current;
    if (gesture) onSetVolume(gesture.volumeAt(event.clientX, event.clientY));
  };
  const endKnobGesture = (): void => {
    knobGesture.current = null;
  };
  const onKnobKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const steps: Record<string, number> = {
      ArrowUp: 0.02,
      ArrowRight: 0.02,
      ArrowDown: -0.02,
      ArrowLeft: -0.02,
      PageUp: 0.1,
      PageDown: -0.1,
    };
    let next: number | null = null;
    if (event.key in steps) next = clampVolume(volume + steps[event.key]!);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 2;
    if (next == null) return;
    event.preventDefault();
    event.stopPropagation();
    onSetVolume(next);
  };

  return (
    <div className={`deck-retro-tv ${isPlaying ? 'is-playing' : ''} titlebar-drag`}>
      <header className="deck-tv-chrome titlebar-drag">
        <button className="deck-tv-brand titlebar-nodrag" onClick={onExitDeck} title="Back to full NewAmp">
          <BrandLogo size={15} withGlow={false} />
          <span>TELESTAR</span>
        </button>
        <div className="deck-tv-window titlebar-nodrag">
          <DeckSkinPicker current="retro-tv" onPick={props.onPickSkin} compact />
          <button className={`pxbtn ${alwaysOnTop ? 'is-active' : ''}`} onClick={() => onSetAlwaysOnTop(!alwaysOnTop)} title="Pin on top">PIN</button>
          <button className="pxbtn" onClick={onExitDeck}>FULL</button>
          <DeckWindowButtons onMinimize={onMinimize} onClose={onClose} className="pxbtn" danger />
        </div>
      </header>

      <div className="deck-tv-stage titlebar-nodrag">
        <TvCabinetArt />

        <button
          type="button"
          className="deck-tv-screen"
          onClick={onToggleVizExpanded}
          onDoubleClick={onOpenFullscreenViz}
          data-newamp-open-visualizer
          data-newamp-tv-state={track ? 'tuned' : 'static'}
          title="Click for screen visualizer, double-click for fullscreen"
          aria-label={tvScreenLabel(track)}
        >
          {vizExpanded ? (
            <Visualizer mode="mini" width={292} height={240} />
          ) : artUrl ? (
            <img src={artUrl} alt={track?.album ?? ''} draggable={false} className="deck-tv-art-pan" />
          ) : (
            <Visualizer mode="mini" width={292} height={240} />
          )}

          {/* CRT physics stack: phosphor triads, scanlines, vignette, glass */}
          <span className="deck-tv-phosphor" aria-hidden="true" />
          <span className="deck-tv-scanlines" aria-hidden="true" />
          <span className="deck-tv-static" aria-hidden="true" />
          <span className="deck-tv-vignette" aria-hidden="true" />
          <span className="deck-tv-glass" aria-hidden="true" />

          {/* one-shot channel flip + OSD, remounted per track */}
          {tuneKey > 0 && (
            <span className="deck-tv-tuning" key={tuneKey} aria-hidden="true">
              <span className="deck-tv-rollbar" />
              <span className="deck-tv-osd">CH {channel != null ? String(channel).padStart(2, '0') : '--'}</span>
            </span>
          )}

          {/* on-screen readout: what a TV would burn into the phosphor */}
          <span className="deck-tv-readout" aria-hidden="true">
            <span className="deck-tv-readout-title">{track?.title ?? 'NO SIGNAL'}</span>
            <span className="deck-tv-readout-sub">
              {track ? track.artist : 'tune NewAmp to a track'} · {formatTime(currentTime)}/{formatTime(duration)}
            </span>
          </span>
        </button>

        {/* console column */}
        <div
          className="deck-tv-knob deck-tv-knob-ch"
          role="button"
          tabIndex={0}
          aria-label="Channel knob"
          title="Channel: click, drag or scroll to change track (Shift+click for previous)"
          data-newamp-deck-channel-knob
          onPointerDown={onChannelPointerDown}
          onPointerMove={onChannelPointerMove}
          onPointerUp={onChannelPointerUp}
          onPointerCancel={(event) => endChannelGesture(event.currentTarget)}
          onLostPointerCapture={() => { channelGesture.current = null; }}
          onClick={onChannelClick}
          onKeyDown={onChannelKeyDown}
          onWheel={(event) => turnChannel(channelWheel.current!.next(event, event.timeStamp))}
        >
          <span className="deck-tv-knob-face" style={{ transform: `rotate(${chSpin}deg)` }} />
          <span className="deck-tv-knob-tag">CHANNEL</span>
        </div>
        <div
          ref={knobRef}
          className="deck-tv-knob deck-tv-knob-vol"
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={200}
          aria-valuenow={Math.round(volume * 100)}
          aria-valuetext={volumeLabel(volume)}
          title={`Volume ${volumeLabel(volume)} — drag or scroll, double-click for 100%`}
          data-newamp-deck-volume-knob
          onPointerDown={onKnobPointerDown}
          onPointerMove={onKnobPointerMove}
          onPointerUp={endKnobGesture}
          onPointerCancel={endKnobGesture}
          onLostPointerCapture={endKnobGesture}
          onKeyDown={onKnobKeyDown}
          onDoubleClick={() => onSetVolume(1)}
        >
          <span className="deck-tv-knob-face" style={{ transform: `rotate(${-135 + (volume / 2) * 270}deg)` }} />
          <span className="deck-tv-knob-tag">VOLUME</span>
        </div>

        <div className="deck-tv-transport">
          <button className="deck-tv-key" onClick={onPrev} title="Previous" aria-label="Previous track">◀◀</button>
          <button className="deck-tv-key is-primary" onClick={onTogglePlay} title="Play / Pause" aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? '▮▮' : '▶'}</button>
          <button className="deck-tv-key" onClick={onStop} title="Stop" aria-label="Stop">◼</button>
          <button className="deck-tv-key" onClick={onNext} title="Next" aria-label="Next track">▶▶</button>
        </div>

        <div className="deck-tv-volume">
          <VolumeSlider value={volume} onChange={onSetVolume} width={96} showLabel={false} compact />
        </div>

        <div className="deck-tv-seek">
          <ScrubBar className="nslider" value={currentTime} max={duration || 1} onSeek={onSeek} />
        </div>
      </div>
    </div>
  );
}

/** The Telestar cabinet. All strings here are printed hardware copy. */
function TvCabinetArt(): JSX.Element {
  return (
    <svg
      className="deck-tv-cabinet"
      viewBox="0 0 520 402"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="tv-walnut" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b4a2b" />
          <stop offset="0.4" stopColor="#4d3319" />
          <stop offset="1" stopColor="#2e1d0d" />
        </linearGradient>
        <linearGradient id="tv-alu" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a3a8b0" />
          <stop offset="0.5" stopColor="#71757c" />
          <stop offset="1" stopColor="#4c4f54" />
        </linearGradient>
        <linearGradient id="tv-chrome-text" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4f6f8" />
          <stop offset="0.45" stopColor="#9aa0a8" />
          <stop offset="0.55" stopColor="#5e646c" />
          <stop offset="1" stopColor="#cdd2d8" />
        </linearGradient>
        <linearGradient id="tv-antenna" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e6e3da" />
          <stop offset="1" stopColor="#77716a" />
        </linearGradient>
        <filter id="tv-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.14" numOctaves="3" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" values="0 0 0 0 0.16  0 0 0 0 0.09  0 0 0 0 0.03  0 0 0 0.55 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
        <filter id="tv-brush" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9 0.06" numOctaves="2" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.05 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>

      {/* rabbit ears behind the cabinet */}
      <g stroke="url(#tv-antenna)" strokeWidth="3" strokeLinecap="round">
        <path d="M260 34L182 5" />
        <path d="M260 34L344 7" />
      </g>
      <circle cx="182" cy="5" r="3" fill="#d9d5cb" />
      <circle cx="344" cy="7" r="3" fill="#d9d5cb" />
      <ellipse cx="260" cy="34" rx="17" ry="8" fill="#1d1a16" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />

      {/* floor shadow + feet */}
      <ellipse cx="260" cy="390" rx="234" ry="9" fill="rgba(0,0,0,0.4)" />
      <path d="M70 370l8 20h36l6-20z" fill="#241608" />
      <path d="M400 370l6 20h36l8-20z" fill="#241608" />

      {/* cabinet: walnut with grain */}
      <rect x="16" y="30" width="488" height="340" rx="16" fill="url(#tv-walnut)" />
      <rect x="16" y="30" width="488" height="340" rx="16" filter="url(#tv-grain)" fill="#fff" />
      <rect x="17" y="31" width="486" height="338" rx="15" fill="none" stroke="rgba(255,220,170,0.16)" strokeWidth="1.4" />
      <rect x="19" y="33" width="482" height="334" rx="14" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="1.4" />

      {/* front laminate */}
      <rect x="30" y="44" width="460" height="312" rx="9" fill="#2b2622" />
      <rect x="30" y="44" width="460" height="312" rx="9" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="1" />

      {/* CRT bezel: molded plastic with bevels */}
      <rect x="42" y="54" width="312" height="264" rx="14" fill="#1a1512" />
      <rect x="42.7" y="54.7" width="310.6" height="262.6" rx="13.4" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1.4" />
      <rect x="49" y="61" width="298" height="250" rx="24" fill="#070605" stroke="rgba(0,0,0,0.8)" strokeWidth="2" />

      {/* chrome divider */}
      <rect x="364" y="54" width="2.5" height="302" fill="url(#tv-alu)" opacity="0.6" />

      {/* console plate: brushed aluminum */}
      <rect x="374" y="54" width="116" height="302" rx="8" fill="url(#tv-alu)" />
      <rect x="374" y="54" width="116" height="302" rx="8" filter="url(#tv-brush)" fill="#fff" />
      <rect x="374.7" y="54.7" width="114.6" height="300.6" rx="7.4" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
      <rect x="376" y="56" width="112" height="298" rx="7" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1" />

      {/* knob recesses */}
      <circle cx="432" cy="98" r="30" fill="#2a2c30" />
      <circle cx="432" cy="98" r="30" fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="2" />
      <circle cx="432" cy="98" r="29" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
      <circle cx="432" cy="172" r="30" fill="#2a2c30" />
      <circle cx="432" cy="172" r="30" fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="2" />
      <circle cx="432" cy="172" r="29" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />

      {/* speaker slats */}
      <g>
        <rect x="384" y="316" width="96" height="3.4" rx="1.7" fill="#17120e" />
        <rect x="384" y="324" width="96" height="3.4" rx="1.7" fill="#17120e" />
        <rect x="384" y="332" width="96" height="3.4" rx="1.7" fill="#17120e" />
        <rect x="384" y="340" width="96" height="3.4" rx="1.7" fill="#17120e" />
        <rect x="384" y="348" width="96" height="3.4" rx="1.7" fill="#17120e" />
        <rect x="384" y="319.2" width="96" height="1" fill="rgba(255,255,255,0.14)" />
        <rect x="384" y="327.2" width="96" height="1" fill="rgba(255,255,255,0.14)" />
        <rect x="384" y="335.2" width="96" height="1" fill="rgba(255,255,255,0.14)" />
        <rect x="384" y="343.2" width="96" height="1" fill="rgba(255,255,255,0.14)" />
        <rect x="384" y="351.2" width="96" height="1" fill="rgba(255,255,255,0.14)" />
      </g>

      {/* chrome badge + model print on the bottom strip */}
      <text x="52" y="343" className="deck-tv-badge">NEWAMP</text>
      <text x="132" y="343" className="deck-tv-badge-sub">TELESTAR · SOLID STATE</text>
    </svg>
  );
}
