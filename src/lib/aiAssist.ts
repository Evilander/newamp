export const AI_ASSIST_OPTIONS = [
  {
    id: 'liner-notes',
    label: 'Liner notes',
    detail: 'Drafts contextual notes from artist, album, lyrics, and local metadata.',
  },
  {
    id: 'missing-art',
    label: 'Missing art scout',
    detail: 'Suggests album-art search queries and metadata fixes for library items without covers.',
  },
  {
    id: 'review-seed',
    label: 'Review seed',
    detail: 'Turns a play session into a short review prompt for diary and social features.',
  },
  {
    id: 'artist-dossier',
    label: 'Artist dossier',
    detail: 'Builds a compact artist context card when Last.fm or local tags are sparse.',
  },
] as const;
