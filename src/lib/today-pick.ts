import type { Track } from '@shared/types';

export interface TodayPick {
  track: Track;
  reason: string;
}

/** How many tracks Play queues for itself when nothing was loaded. */
export const STARTER_QUEUE_SIZE = 50;

export function trackScorePercent(track: Track): number {
  if (track.ratingScore != null) return Math.max(0, Math.min(100, track.ratingScore));
  return Math.max(0, Math.min(100, (track.rating || 0) * 20));
}

export function pickToday(
  rated: Track[],
  recent: Track[],
  currentId: number | null,
  now = Date.now(),
): TodayPick | null {
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const recentIds = new Set(recent.map((track) => track.id));
  const scored = rated.filter((track) => (track.ratingScore ?? track.rating * 20) >= 80);
  const qualified = scored.find((track) =>
    track.id !== currentId &&
    (track.lastPlayed == null || now - track.lastPlayed > thirtyDays),
  );
  const fallback = rated[0] ?? null;
  const track = qualified ?? fallback;
  if (!track) return null;
  const scoreLabel = 'Top-rated';
  if (track.lastPlayed == null) return { track, reason: `${scoreLabel} · never played` };
  const weeks = Math.max(1, Math.round((now - track.lastPlayed) / (7 * 24 * 60 * 60 * 1000)));
  if (qualified) return { track, reason: `${scoreLabel} · hasn't played in ${weeks} ${weeks === 1 ? 'week' : 'weeks'}` };
  if (track.id === currentId) return { track, reason: `${scoreLabel} · currently loaded` };
  if (recentIds.has(track.id)) return { track, reason: `${scoreLabel} · recent favorite` };
  return { track, reason: `${scoreLabel} · highest score available` };
}

/**
 * Play with nothing queued starts something only when there is a library to
 * draw from. An empty library stays silent, and a request already fetching
 * its tracks is not asked twice.
 */
export function starterQueueNeeded(input: {
  startIndex: number;
  libraryRootCount: number;
  pending: boolean;
}): boolean {
  return input.startIndex < 0 && input.libraryRootCount > 0 && !input.pending;
}

/**
 * The pick that opens a starter queue: a rated track that is neither missing
 * nor opted out of auto-play. An unrated fallback from pickToday is not one,
 * so it takes its place in the shuffle like any other candidate.
 */
export function starterQueueLead(pick: Track | null): Track | null {
  if (!pick || pick.avoidAutoPlay || pick.missingSince != null) return null;
  return trackScorePercent(pick) > 0 ? pick : null;
}

/**
 * Today's pick opens the queue when it is a rated track, followed by the
 * remaining candidates in random order. Tracks that are missing or opted out
 * of auto-play never start a queue nobody asked for.
 */
export function buildStarterQueue(
  candidates: Track[],
  pick: Track | null,
  random: () => number = Math.random,
  limit = STARTER_QUEUE_SIZE,
): Track[] {
  const playable = (track: Track): boolean => !track.avoidAutoPlay && track.missingSince == null;
  const lead = starterQueueLead(pick);
  const seen = new Set<number>(lead ? [lead.id] : []);
  const rest: Track[] = [];
  for (const track of candidates) {
    if (seen.has(track.id) || !playable(track)) continue;
    seen.add(track.id);
    rest.push(track);
  }
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return (lead ? [lead, ...rest] : rest).slice(0, Math.max(1, limit));
}
