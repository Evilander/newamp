export const AI_ASSIST_OPTIONS = [
  {
    id: 'liner-notes',
    label: 'Liner notes',
    detail: 'Drafts contextual notes from artist, album, lyrics, and local metadata.',
  },
] as const;

export function aiAssistSummary(): string {
  return AI_ASSIST_OPTIONS.map((option) => option.label.toLowerCase()).join(' / ');
}
