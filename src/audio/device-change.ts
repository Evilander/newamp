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
