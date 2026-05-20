import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * Mirror a React value into a ref so a long-lived effect can read the current
 * value without listing it in its dependency array. This avoids "RAF restart
 * storms" — useEffects that depend on a frequently-changing value tear down
 * and re-create their loop / re-allocate their buffers on every change.
 *
 * Usage:
 * ```ts
 * const volumeRef = useLatestRef(volume);
 * useEffect(() => {
 *   const tick = () => {
 *     useVolume(volumeRef.current); // reads current value, no rebind
 *     raf = requestAnimationFrame(tick);
 *   };
 *   raf = requestAnimationFrame(tick);
 *   return () => cancelAnimationFrame(raf);
 * }, []); // effect runs once, never restarts
 * ```
 */
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
