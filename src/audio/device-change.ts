// Pure decision logic for how the audio engine should react to a
// `navigator.mediaDevices` "devicechange" event. Kept browser-API-free so it
// is unit-testable in Node (the engine itself touches AudioContext/MediaDevices
// and can't run headless).

export type DeviceChangePlan = 'noop' | 'reapply' | 'fallback';

/**
 * @param selectedId  the engine's pinned output device id, or null when it is
 *                     following the system default.
 * @param availableOutputIds  deviceId values of currently-available
 *                            `audiooutput` devices.
 * - null pinned id            → 'noop'    (already on system default)
 * - pinned id still present   → 'reapply' (re-assert the sink so audio follows)
 * - pinned id gone            → 'fallback'(reset to default + surface a notice)
 */
export function planDeviceChange(
  selectedId: string | null,
  availableOutputIds: readonly string[],
): DeviceChangePlan {
  if (!selectedId) return 'noop';
  return availableOutputIds.includes(selectedId) ? 'reapply' : 'fallback';
}

export interface DeviceChangeRunner {
  /** Ask for a run. Calls that arrive within the delay of each other share one. */
  trigger(): void;
  cancel(): void;
}

/**
 * Runs `run` once per burst of devicechange events, never two at a time. A
 * burst that lands while a run is in flight earns one more run afterwards, so
 * the last state is the one that is acted on.
 */
export function coalesceDeviceChanges(run: () => Promise<void>, delayMs: number): DeviceChangeRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const schedule = (): void => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(fire, delayMs);
  };
  function fire(): void {
    timer = null;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void run()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          schedule();
        }
      });
  }
  return {
    trigger: schedule,
    cancel(): void {
      if (timer != null) clearTimeout(timer);
      timer = null;
      again = false;
    },
  };
}
