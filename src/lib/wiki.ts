export function wikipediaSearchUrl(query: string): string {
  const clean = query.replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({ search: clean || 'music' });
  return `https://en.wikipedia.org/w/index.php?${params.toString()}`;
}

export function musicEntitySearchText(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
    .join(' ');
}
