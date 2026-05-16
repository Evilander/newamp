// VLC-style volume slider that goes to 200%. The first half (0..1.0 = 0..100%)
// uses the active accent. The second half (1.0..2.0 = +0..+6 dB boost) shifts
// to warn → error so users see they are pushing past unity gain.
//
// The slider is a native <input type="range"> on top of a gradient track div
// so we keep accessibility and keyboard control while showing the danger zone.

import type { CSSProperties } from 'react';

export const VOLUME_BOOST_MAX = 2;

export function volumeBoostDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return -Infinity;
  return 20 * Math.log10(value);
}

export function volumeLabel(value: number): string {
  const pct = Math.round(value * 100);
  if (value <= 1.001) return `${pct}%`;
  const db = volumeBoostDb(value);
  return `${pct}% · +${db.toFixed(1)} dB`;
}

interface VolumeSliderProps {
  value: number;
  onChange: (v: number) => void;
  /** Track width in px. Default 110. */
  width?: number;
  /** Show the "Vol" label and dB readout. Default true. */
  showLabel?: boolean;
  /** Compact mode shrinks the readout. */
  compact?: boolean;
  title?: string;
  /** Optional extra className passed to the wrapper. */
  className?: string;
}

export function VolumeSlider({
  value,
  onChange,
  width = 110,
  showLabel = true,
  compact = false,
  title,
  className,
}: VolumeSliderProps): JSX.Element {
  const safe = Math.max(0, Math.min(VOLUME_BOOST_MAX, value));
  const boost = safe > 1;
  const fillPct = (safe / VOLUME_BOOST_MAX) * 100;
  // Unity gain (100%) sits at exactly 50% of the track.
  const unityPct = 50;
  const trackStyle: CSSProperties = {
    width,
    background: boost
      ? `linear-gradient(to right,
          var(--accent) 0%,
          var(--accent) ${(fillPct / 2) * (100 / unityPct)}%,
          var(--warn) ${unityPct}%,
          var(--error) ${fillPct}%,
          var(--panel-2) ${fillPct}%,
          var(--panel-2) 100%)`
      : `linear-gradient(to right,
          var(--accent) 0%,
          var(--accent-dim) ${fillPct}%,
          var(--panel-2) ${fillPct}%,
          var(--panel-2) ${unityPct}%,
          color-mix(in srgb, var(--error) 35%, var(--panel-2)) ${unityPct}%,
          color-mix(in srgb, var(--error) 35%, var(--panel-2)) 100%)`,
  };
  return (
    <div className={`volume-slider ${boost ? 'is-boosted' : ''} ${className ?? ''}`}>
      {showLabel ? (
        <span
          className="volume-slider-label"
          style={{
            color: boost ? 'var(--error)' : 'var(--muted)',
            textShadow: boost ? '0 0 6px var(--accent-glow)' : undefined,
          }}
        >
          Vol
        </span>
      ) : null}
      <div className="volume-slider-track" style={trackStyle}>
        <input
          type="range"
          className="nslider volume-slider-input"
          min={0}
          max={VOLUME_BOOST_MAX}
          step={0.01}
          value={safe}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          title={title ?? volumeLabel(safe)}
          aria-label={`Volume ${volumeLabel(safe)}`}
          // Mark the unity tick so we can render a hairline at 100%.
          data-newamp-volume-boost={boost ? 'true' : 'false'}
        />
        <span className="volume-unity-tick" aria-hidden="true" />
        <span className="volume-db-tick is-unity" aria-hidden="true">0 dB</span>
        <span className="volume-db-tick is-boost-max" aria-hidden="true">+6 dB</span>
      </div>
      {showLabel ? (
        <span
          className={compact ? 'volume-slider-readout-compact' : 'volume-slider-readout'}
          style={{
            color: boost ? 'var(--error)' : 'var(--ink-2)',
            fontWeight: boost ? 700 : 400,
            textShadow: boost ? '0 0 4px var(--accent-glow)' : undefined,
          }}
        >
          {volumeLabel(safe)}
        </span>
      ) : null}
    </div>
  );
}
