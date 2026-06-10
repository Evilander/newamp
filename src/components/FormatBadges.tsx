import { useMemo } from 'react';
import type { Track } from '@shared/types';
import { formatBadgesForTrack, type FormatBadge } from '@shared/format-badge';

interface Props {
  track: Track;
  /** Compact = library rows (one extra inline span, no kbps spam on every MP3).
   *  Verbose = Now Playing header / transport (every meaningful badge). */
  density?: 'compact' | 'comfortable';
  verbose?: boolean;
  className?: string;
}

/**
 * Renders small monospace chips describing a track's codec / hi-res / DSD /
 * lossy-bitrate signature. Pure presentational — all classification lives in
 * `shared/format-badge.ts` so it stays testable and consistent across views.
 *
 * The component is cheap by construction: one memoized array + a couple of
 * inline spans. Safe to drop into every virtualized track row.
 */
export function FormatBadges({ track, density = 'compact', verbose, className }: Props): JSX.Element | null {
  const badges = useMemo<FormatBadge[]>(
    () => formatBadgesForTrack(
      {
        path: track.path,
        bitrate: track.bitrate,
        sampleRate: track.sampleRate,
        duration: track.duration,
        size: track.size,
        replayGainTrackDb: track.replayGainTrackDb,
        replayGainAlbumDb: track.replayGainAlbumDb,
      },
      { density, verbose },
    ),
    [
      track.path,
      track.bitrate,
      track.sampleRate,
      track.duration,
      track.size,
      track.replayGainTrackDb,
      track.replayGainAlbumDb,
      density,
      verbose,
    ],
  );
  if (badges.length === 0) return null;
  return (
    <span className={`format-badges${className ? ' ' + className : ''}`} data-newamp-format-badges>
      {badges.map((badge) => (
        <span
          key={`${badge.kind}:${badge.label}`}
          className={`format-badge format-badge-${badge.kind} format-badge-tone-${badge.tone}`}
          data-format-badge-kind={badge.kind}
          title={badge.title}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}
