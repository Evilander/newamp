import type { AlbumSummary } from '@shared/types';

/**
 * The next page of the album grid, appended without repeats. Pages are read
 * by offset, so albums a scan adds while the grid is open (a download landing
 * in the music folder, under "Recently added") push everything down, and the
 * next page starts with albums already shown. Those are dropped here. The
 * caller advances its offset by the rows it read, not by what was kept, so
 * paging always moves on and an addition never makes it skip an album.
 *
 * An album is its key. Two albums can share a title and album artist (the
 * pieces of a folder split apart, several folders under a generic title), so
 * the text pair would drop all but the first.
 */
export function appendAlbumPage(current: readonly AlbumSummary[], page: readonly AlbumSummary[]): AlbumSummary[] {
  const seen = new Set(current.map(albumPageKey));
  const fresh = page.filter((album) => {
    const key = albumPageKey(album);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return fresh.length ? [...current, ...fresh] : [...current];
}

function albumPageKey(album: Pick<AlbumSummary, 'albumKey'>): string {
  return album.albumKey;
}
