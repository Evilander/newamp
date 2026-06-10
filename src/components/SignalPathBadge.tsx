import { useEffect, useState } from 'react';
import { engine, usePlayerStore } from '../store/usePlayerStore';

/**
 * Always-visible signal-path readout in the transport. Tells the user, in one
 * glance, whether the current track is reaching the AudioContext at its native
 * sample rate ("DIRECT") or whether Chromium is resampling it on the way out
 * ("RESAMPLED"). Clicking the badge jumps to Settings → Audio where the
 * existing Bit-Perfect Path UI explains the chain and offers a fixed-rate pin.
 *
 * No engine logic is duplicated here; we read the same APIs SettingsView's
 * BitPerfectRow uses (`getActualSampleRate`, `getSampleRateFallback`).
 */
export function SignalPathBadge(): JSX.Element | null {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setView = usePlayerStore((s) => s.setView);
  // Re-render whenever the engine emits — covers the boot transition where
  // getActualSampleRate() goes from null to a real rate after the first play.
  const [, bumpTick] = useState(0);
  useEffect(() => engine.subscribe(() => bumpTick((n) => n + 1)), []);

  const sourceRate = current?.sampleRate ?? null;
  const actualRate = engine.getActualSampleRate();
  const fallback = engine.getSampleRateFallback?.() ?? null;

  // If nothing is loaded yet OR we can't yet observe the engine, stay quiet.
  // Once a track is loaded but the engine has not booted (first play hasn't
  // happened) we still surface a muted "—" so the area doesn't visibly snap in
  // on the very first play.
  if (!current) return null;

  const sourceKhz = sourceRate != null ? formatKhz(sourceRate) : null;
  const actualKhz = actualRate != null ? formatKhz(actualRate) : null;

  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  let label: string;
  let title: string;

  if (sourceRate == null) {
    label = actualKhz ? `${actualKhz} ENGINE` : 'SIGNAL';
    title = actualKhz
      ? `AudioContext running at ${actualKhz}. This track has no sample-rate metadata, so the input path can't be classified.`
      : 'AudioContext not yet booted — start playback to see the signal path.';
    tone = 'muted';
  } else if (actualRate == null) {
    label = `${sourceKhz} READY`;
    title = `Track source is ${sourceKhz}. Start playback to see the engine sample rate.`;
    tone = 'muted';
  } else if (Math.abs(sourceRate - actualRate) < 1) {
    label = `${sourceKhz} DIRECT`;
    title = [
      `Source ${sourceKhz} → engine ${actualKhz}. No Chromium-side resample.`,
      'Your DAC still needs to match this rate for end-to-end bit-perfect; verify in Settings → Audio.',
    ].join('\n');
    tone = 'ok';
  } else {
    label = `${sourceKhz}→${actualKhz} RESAMPLED`;
    title = [
      `Chromium is resampling this track from ${sourceKhz} to ${actualKhz} before it reaches the device.`,
      fallback
        ? `(${formatKhz(fallback.requested)} rejected by the output device; engine fell back to ${formatKhz(fallback.actual)}.)`
        : 'Pin the engine to the source rate in Settings → Audio for a clean signal path.',
    ].join('\n');
    tone = 'warn';
  }

  // While paused/idle the data is still meaningful, but visually de-emphasize.
  const dim = !isPlaying;
  return (
    <button
      type="button"
      data-newamp-signal-path-badge
      data-tone={tone}
      data-dim={dim ? 'true' : 'false'}
      className={`signal-path-badge signal-path-badge-${tone}${dim ? ' is-dim' : ''}`}
      onClick={() => setView('settings')}
      title={title}
    >
      {label}
    </button>
  );
}

function formatKhz(hz: number): string {
  const khz = hz / 1000;
  return Number.isInteger(khz) ? `${khz}k` : `${khz.toFixed(1)}k`;
}
