import { useEffect, useRef, type RefObject } from 'react';
import { createWheelSeek } from '../lib/wheel-seek';

export interface SeekPosition {
  /** Where playback is now, in seconds. */
  position: number;
  /** Length of the track, in seconds. */
  duration: number;
}

/**
 * Wheel over `target` seeks by SEEK_SECONDS_PER_NOTCH per notch. The listener
 * is bound by hand because React's onWheel is passive and couldn't stop the
 * view behind the bar from scrolling; it reads the position when the event
 * fires, so nothing here goes stale.
 */
export function useWheelSeek(
  target: RefObject<HTMLElement>,
  read: () => SeekPosition,
  onSeek: (seconds: number) => void,
  enabled = true,
): void {
  const latest = useRef({ read, onSeek });
  latest.current = { read, onSeek };
  useEffect(() => {
    const node = target.current;
    if (!enabled || !node || typeof node.addEventListener !== 'function') return undefined;
    const wheel = createWheelSeek();
    const onWheel = (event: WheelEvent): void => {
      const { position, duration } = latest.current.read();
      const result = wheel.handle(event, performance.now(), position, duration);
      if (!result.consumed) return;
      event.preventDefault();
      // The fullscreen visualizer also reads the wheel as volume; over the bar it is a seek.
      event.stopPropagation();
      if (result.target != null) latest.current.onSeek(result.target);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [enabled]);
}
