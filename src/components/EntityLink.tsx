import type { CSSProperties, ReactNode } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';

// Shared link styling that matches the canonical artist/album nav buttons in
// NowPlayingView: a plain <button> dressed as an inline text link so artist
// and album names are clickable everywhere without pulling in a router.
const LINK_STYLE: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
};

function isUnknown(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim();
  return !trimmed || trimmed.toLowerCase() === 'unknown' || trimmed.toLowerCase().startsWith('unknown ');
}

export function ArtistLink({
  artist,
  className,
  title,
  color,
  children,
  onBeforeNavigate,
}: {
  artist: string;
  className?: string;
  title?: string;
  color?: string;
  children?: ReactNode;
  /** Escape hatch for links inside overlays: close the overlay first so the
   * navigation is actually visible (e.g. fullscreen viz, karaoke). */
  onBeforeNavigate?: () => void;
}): JSX.Element {
  if (isUnknown(artist)) {
    return <span className={className}>{children ?? artist}</span>;
  }
  return (
    <button
      type="button"
      data-newamp-artist-link
      className={`underline-offset-2 hover:underline ${className ?? ''}`}
      style={{ ...LINK_STYLE, color: color ?? 'var(--accent)' }}
      title={title ?? `Show all ${artist} albums in your library`}
      onClick={(event) => {
        event.stopPropagation();
        onBeforeNavigate?.();
        usePlayerStore.getState().navigateToArtist(artist);
      }}
    >
      {children ?? artist}
    </button>
  );
}

export function TrackLink({
  track,
  className,
  title,
  color,
  children,
}: {
  track: {
    id?: number;
    title: string;
    album?: string | null;
    albumArtist?: string | null;
    artist?: string | null;
  };
  className?: string;
  title?: string;
  color?: string;
  children?: ReactNode;
}): JSX.Element {
  // A track with neither an album to land on nor an artist to fall back to
  // has nowhere to navigate — render plain text instead of a dead link.
  if (isUnknown(track.album) && isUnknown(track.artist)) {
    return <span className={className}>{children ?? track.title}</span>;
  }
  return (
    <button
      type="button"
      data-newamp-track-link
      className={`underline-offset-2 hover:underline ${className ?? ''}`}
      style={{ ...LINK_STYLE, color: color ?? 'inherit' }}
      title={
        title ??
        (isUnknown(track.album)
          ? `Show ${track.artist} in Artists`
          : `Show "${track.title}" on ${track.album}`)
      }
      onClick={(event) => {
        event.stopPropagation();
        usePlayerStore.getState().navigateToTrack(track);
      }}
    >
      {children ?? track.title}
    </button>
  );
}

export function AlbumLink({
  album,
  albumArtist,
  className,
  title,
  color,
  children,
  onBeforeNavigate,
}: {
  album: string;
  albumArtist: string;
  className?: string;
  title?: string;
  color?: string;
  children?: ReactNode;
  /** See ArtistLink.onBeforeNavigate. */
  onBeforeNavigate?: () => void;
}): JSX.Element {
  if (isUnknown(album)) {
    return <span className={className}>{children ?? album}</span>;
  }
  return (
    <button
      type="button"
      data-newamp-album-link
      className={`underline-offset-2 hover:underline ${className ?? ''}`}
      style={{ ...LINK_STYLE, color: color ?? 'var(--ink-2)' }}
      title={title ?? `Show ${album} in Albums`}
      onClick={(event) => {
        event.stopPropagation();
        onBeforeNavigate?.();
        usePlayerStore.getState().navigateToAlbum(album, albumArtist);
      }}
    >
      {children ?? album}
    </button>
  );
}
