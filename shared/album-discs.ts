import type { Track } from './types.js';

export interface DiscSection {
  disc: number;
  /** The disc's own name, from the first track that has a DISCSUBTITLE. */
  subtitle: string | null;
  /** Index of the section's first track in the whole album. */
  start: number;
  duration: number;
  tracks: Track[];
}

/**
 * The album's tracks cut into discs, for an album that has more than one. The
 * disc is the one the grouping settled on (read from the album title or folder
 * where the files cannot tell their discs apart, or have no disc), else the
 * file's, else 1. Null when everything is one disc and a plain table is enough.
 *
 * The rows arrive in disc order already (see LibraryStore.getAlbumTracksByKey),
 * so a section's tracks are contiguous and `start` plus the row index in the
 * section is the track's place in the whole album.
 */
export function splitIntoDiscs(tracks: Track[]): DiscSection[] | null {
  const sections: DiscSection[] = [];
  tracks.forEach((track, index) => {
    const disc = track.discInferred ?? track.discNo ?? 1;
    let section = sections.find((s) => s.disc === disc);
    if (!section) {
      section = { disc, subtitle: null, start: index, duration: 0, tracks: [] };
      sections.push(section);
    }
    section.tracks.push(track);
    section.duration += track.duration ?? 0;
    if (!section.subtitle && track.discSubtitle) section.subtitle = track.discSubtitle;
  });
  return sections.length < 2 ? null : sections;
}
