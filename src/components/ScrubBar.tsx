import { useEffect, useRef } from 'react';

// One correct scrub bar for the whole app. Previously every deck + the
// transport hand-rolled an <input type="range">; the decks used a *controlled*
// value={currentTime}, which fights the drag — each ~100ms engine tick yanks
// the thumb back to the playhead, so the song "won't scroll" when you drag.
//
// The fix is an uncontrolled input that only re-syncs from the audio clock
// while the user is NOT actively scrubbing (not dragging, not focused). During
// a drag we let the browser own the thumb and forward every movement to
// onSeek; once the pointer/focus leaves we resume mirroring the playhead.
export interface ScrubBarProps {
  /** Current playhead position in seconds (cue-relative). */
  value: number;
  /** Track duration in seconds. */
  max: number;
  /** Called with the new position in seconds on every drag movement. */
  onSeek: (seconds: number) => void;
  className?: string;
  step?: number;
  ariaLabel?: string;
  /** Tags this as the canonical scrubber for smoke tests. */
  'data-newamp-scrub'?: boolean;
}

export function ScrubBar({
  value,
  max,
  onSeek,
  className,
  step = 0.1,
  ariaLabel = 'Seek',
  'data-newamp-scrub': dataScrub,
}: ScrubBarProps): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (el && !draggingRef.current && document.activeElement !== el) {
      el.value = String(value);
    }
  }, [value]);

  const commit = (raw: string): void => {
    const next = parseFloat(raw);
    if (Number.isFinite(next)) onSeek(next);
  };

  return (
    <input
      ref={ref}
      type="range"
      className={className}
      min={0}
      max={max > 0 ? max : 1}
      step={step}
      defaultValue={value}
      aria-label={ariaLabel}
      {...(dataScrub ? { 'data-newamp-scrub': true } : {})}
      onPointerDown={() => {
        draggingRef.current = true;
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onInput={(e) => commit(e.currentTarget.value)}
      onChange={(e) => commit(e.currentTarget.value)}
      onBlur={(e) => {
        draggingRef.current = false;
        e.currentTarget.value = String(value);
      }}
    />
  );
}
