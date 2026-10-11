// The picture behind a seek bar: the track's waveform, played part in the
// accent, with the playhead and a time readout under the pointer. It wraps the
// real slider (ScrubBar's <input type="range">), which lies over it
// transparently and keeps the pointer, keyboard and focus behaviour; this
// component only draws. Until the waveform arrives, or when the track can't
// have one, the bar is a flat line that fills with the accent as it plays.
//
// The slider is the same element whether the frame is drawn or not. Settings
// can turn the waveform off at any time, and the settings arrive after the
// first paint, so swapping the slider for a new element would drop the wheel
// listener, focus and an unfinished drag along with the old one.

import { useRef, useState, type CSSProperties } from 'react';
import { useWaveform, nextQueuedTrack } from '../hooks/useWaveform';
import { seekClock, waveformPaths, waveformScale } from '../lib/waveform-path';
import { usePlayerStore } from '../store/usePlayerStore';

export type WaveformSeekSize = 'bar' | 'overview';

export interface WaveformSeekProps {
  /** Playhead position in seconds (cue-relative). */
  value: number;
  /** Track duration in seconds. */
  max: number;
  size?: WaveformSeekSize;
  /** Tags the frame for smoke tests. */
  'data-newamp-waveform-seek'?: boolean;
  /** The slider that takes the input. Keep its key the same between renders. */
  children: JSX.Element;
}

// The drawing is a 2048 x 100 box stretched to the bar; see waveform-path.ts.
const VIEW_WIDTH = 2048;
const VIEW_HEIGHT = 100;
/** Half the readout's width, so it can sit at the pointer without leaving the bar. */
const TIP_HALF_WIDTH = 24;

let frames = 0;

export function WaveformSeek({
  value,
  max,
  size = 'bar',
  'data-newamp-waveform-seek': dataSeek,
  children,
}: WaveformSeekProps): JSX.Element {
  const enabled = usePlayerStore((s) => s.settings?.waveformSeekBar !== false);
  // Lite is for weak machines: the track on screen gets its waveform, the next one is not decoded ahead of time.
  const warmNext = usePlayerStore((s) => s.settings?.performanceTier !== 'lite');
  const current = usePlayerStore((s) => s.current);
  const next = usePlayerStore((s) => nextQueuedTrack(s.queue, s.index, s.mode));
  const { status, data } = useWaveform(current, enabled, warmNext ? next : null);
  const gradientId = useRef('');
  if (!gradientId.current) gradientId.current = `wfs-played-${++frames}`;
  const [hover, setHover] = useState<{ x: number; width: number; time: number } | null>(null);

  if (!enabled) return <div className="wfs-off">{children}</div>;

  const progress = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const paths = data ? waveformPaths(data) : null;
  const fill = `url(#${gradientId.current})`;
  // The drawing spans the decoded seconds; the bar spans the player's. The
  // gradient is in the drawing's own coordinates, so its stop takes the same scale.
  const scale = data ? waveformScale(data.duration, max) : 1;
  const played = Math.min(1, progress / scale);

  return (
    <div
      className={`wfs wfs-${size}`}
      data-state={status}
      {...(dataSeek ? { 'data-newamp-waveform-seek': true } : {})}
      style={{ '--wfs-progress': progress } as CSSProperties}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || !(max > 0)) return;
        const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
        setHover((previous) =>
          previous && Math.abs(previous.x - x) < 1 && previous.width === rect.width
            ? previous
            : { x, width: rect.width, time: (x / rect.width) * max },
        );
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="wfs-baseline" aria-hidden="true" />
      <svg
        className="wfs-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId.current} gradientUnits="userSpaceOnUse" x1="0" x2={VIEW_WIDTH} y1="0" y2="0">
            <stop className="wfs-stop-played" offset={played} />
            <stop className="wfs-stop-rest" offset={played} />
          </linearGradient>
        </defs>
        {paths ? (
          <g {...(scale !== 1 ? { transform: `scale(${scale} 1)` } : {})}>
            <path className="wfs-peak" d={paths.peak} fill={fill} />
            <path className="wfs-core" d={paths.rms} fill={fill} />
          </g>
        ) : null}
      </svg>
      {children}
      <div className="wfs-playhead" aria-hidden="true" style={{ left: `${progress * 100}%` }} />
      {hover ? (
        <>
          <div className="wfs-hoverline" aria-hidden="true" style={{ left: hover.x }} />
          <div
            className="wfs-tip"
            aria-hidden="true"
            style={{ left: Math.min(Math.max(hover.x, TIP_HALF_WIDTH), Math.max(TIP_HALF_WIDTH, hover.width - TIP_HALF_WIDTH)) }}
          >
            {seekClock(hover.time)}
          </div>
        </>
      ) : null}
    </div>
  );
}
