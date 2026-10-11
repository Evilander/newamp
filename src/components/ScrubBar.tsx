import { useEffect, useRef } from 'react';
import { useWheelSeek } from '../hooks/useWheelSeek';
import { WaveformSeek, type WaveformSeekSize } from './WaveformSeek';

// One correct scrub bar for the whole app. Previously every deck + the
// transport hand-rolled an <input type="range">; the decks used a *controlled*
// value={currentTime}, which fights the drag — each ~100ms engine tick yanks
// the thumb back to the playhead, so the song "won't scroll" when you drag.
//
// The fix is an uncontrolled input that only re-syncs from the audio clock
// while the user is NOT actively scrubbing: not mid-drag, and not within a
// moment of a scrubbing key. Focus alone is not scrubbing. A click leaves the
// input focused, and tying the sync to focus froze the thumb for the rest of
// the song after any click-to-seek. So the pointer hands focus back when it
// is released, and Left/Right then belong to the app's seek shortcuts again.
// Whatever the thumb skipped while it was held (a seek that changed nothing, a
// track change inside the keyboard hold) is caught up by a trailing resync.
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
  /**
   * Draw the playing track's waveform behind the slider (Settings can turn it
   * off, which gives the plain slider back). The transport bar does by default;
   * the decks keep their own track unless they ask.
   */
  waveform?: boolean;
  waveformSize?: WaveformSeekSize;
  /** Tags the waveform frame for smoke tests. */
  'data-newamp-waveform-seek'?: boolean;
  /** Wheel over the bar seeks by 5 s per notch. On unless turned off. */
  wheelSeek?: boolean;
}

/** How long after a scrubbing key the thumb stays put instead of following the playhead. */
const KEYBOARD_SCRUB_MS = 1500;
/** Gives a click-to-seek time to reach the playhead before the thumb is checked against it. */
const RELEASE_RESYNC_MS = 250;
const SCRUB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function ScrubBar({
  value,
  max,
  onSeek,
  className,
  step = 0.1,
  ariaLabel = 'Seek',
  'data-newamp-scrub': dataScrub,
  waveform = Boolean(dataScrub),
  waveformSize,
  'data-newamp-waveform-seek': dataWaveformSeek,
  wheelSeek = true,
}: ScrubBarProps): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  const keyboardScrubUntilRef = useRef(0);
  const releasingRef = useRef(false);
  const stopWatchingRef = useRef<(() => void) | null>(null);
  const valueRef = useRef(value);
  const resyncTimerRef = useRef<number | null>(null);
  valueRef.current = value;

  const scheduleResync = (delayMs: number): void => {
    if (resyncTimerRef.current != null) window.clearTimeout(resyncTimerRef.current);
    resyncTimerRef.current = window.setTimeout(resync, delayMs);
  };

  // Puts the thumb back on the playhead unless the user is mid-gesture. A hold
  // that is still running tries again once it has run out.
  const resync = (): void => {
    const el = ref.current;
    if (!el || draggingRef.current) return;
    const holdLeft = keyboardScrubUntilRef.current - performance.now();
    if (holdLeft > 0) {
      scheduleResync(holdLeft + 20);
      return;
    }
    el.value = String(valueRef.current);
  };

  useEffect(resync, [value]);

  useEffect(() => () => {
    stopWatchingRef.current?.();
    if (resyncTimerRef.current != null) window.clearTimeout(resyncTimerRef.current);
  }, []);

  const releaseFocus = (): void => {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    releasingRef.current = true;
    el.blur();
    releasingRef.current = false;
  };

  // Listens on the window so a release outside the input still ends the drag;
  // a missed release would otherwise leave the thumb parked for good.
  const beginDrag = (pointerId: number): void => {
    stopWatchingRef.current?.();
    draggingRef.current = true;
    const stopWatching = (): void => {
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      stopWatchingRef.current = null;
    };
    const end = (event: PointerEvent): void => {
      // Another finger or pen lifting is not this gesture ending.
      if (event.pointerId !== pointerId) return;
      stopWatching();
      draggingRef.current = false;
      // After the mouseup and change events of this release have run.
      window.setTimeout(releaseFocus, 0);
      scheduleResync(RELEASE_RESYNC_MS);
    };
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    stopWatchingRef.current = stopWatching;
  };

  const commit = (raw: string): void => {
    const next = parseFloat(raw);
    if (Number.isFinite(next)) onSeek(next);
  };

  useWheelSeek(ref, () => ({ position: valueRef.current, duration: max }), onSeek, wheelSeek);

  // Keyed so it stays the same element when the waveform frame comes or goes.
  const slider = (
    <input
      key="slider"
      ref={ref}
      type="range"
      className={className}
      min={0}
      max={max > 0 ? max : 1}
      step={step}
      defaultValue={value}
      aria-label={ariaLabel}
      {...(dataScrub ? { 'data-newamp-scrub': true } : {})}
      onPointerDown={(e) => beginDrag(e.pointerId)}
      onKeyDown={(e) => {
        if (SCRUB_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          keyboardScrubUntilRef.current = performance.now() + KEYBOARD_SCRUB_MS;
          scheduleResync(KEYBOARD_SCRUB_MS + 20);
        }
      }}
      onInput={(e) => commit(e.currentTarget.value)}
      onChange={(e) => commit(e.currentTarget.value)}
      onBlur={(e) => {
        draggingRef.current = false;
        // Our own release keeps the thumb where the click put it; the prop
        // is still the pre-seek position until the next engine tick.
        if (!releasingRef.current) e.currentTarget.value = String(value);
      }}
    />
  );

  if (!waveform) return slider;
  return (
    <WaveformSeek
      value={value}
      max={max}
      size={waveformSize}
      {...(dataWaveformSeek ? { 'data-newamp-waveform-seek': true } : {})}
    >
      {slider}
    </WaveformSeek>
  );
}
