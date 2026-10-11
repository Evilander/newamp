export interface SmartShuffleInput {
  queueLength: number;
  currentIndex: number | undefined;
  history: number[];
}

export interface SmartShuffleResult {
  index: number;
  history: number[];
}

export interface SmartShuffleNextResult extends SmartShuffleResult {
  /**
   * Every queued track had already played, so this pick opens a new cycle.
   * Repeat off treats that as the end of the queue instead of playing it.
   */
  exhausted: boolean;
}

export function resetSmartShuffleHistory(queueLength: number, currentIndex: number | undefined): number[] {
  const length = normalizedLength(queueLength);
  if (!length) return [];
  const rawIndex = Number(currentIndex);
  if (!Number.isFinite(rawIndex) || rawIndex < 0) return [];
  return [clampIndex(currentIndex, length)];
}

export function nextSmartShuffle(
  input: SmartShuffleInput,
  random: () => number = Math.random,
): SmartShuffleNextResult {
  const length = normalizedLength(input.queueLength);
  if (!length) return { index: -1, history: [], exhausted: true };
  if (length === 1) return { index: 0, history: [0], exhausted: true };

  const currentIndex = clampIndex(input.currentIndex, length);
  let history = sanitizeHistory(input.history, length, currentIndex);
  // history.includes(index) inside this filter used to make picking the next
  // candidate O(queueLength x history.length) — a multi-second main-thread
  // stall on large queues once history has grown close to queueLength. A Set
  // makes the membership check O(1), so this is O(queueLength) overall.
  let historySet = new Set(history);
  let candidates = indexes(length).filter((index) => !historySet.has(index));
  let exhausted = false;

  if (!candidates.length) {
    exhausted = true;
    history = [currentIndex];
    candidates = indexes(length).filter((index) => index !== currentIndex);
  }

  const chosen = candidates[pickIndex(candidates.length, random)] ?? currentIndex;
  return { index: chosen, history: [...history, chosen], exhausted };
}

/**
 * The pick for a shuffle whose playing track left the queue. `history` holds
 * the surviving positions already played this cycle, so every other position
 * is still unplayed, including the one that slid into the removed track's
 * place. When none is left the pick opens a new cycle (`exhausted`), which
 * does not start with the track that played before the removed one.
 */
export function smartShuffleAfterRemoval(
  input: { queueLength: number; history: number[] },
  random: () => number = Math.random,
): SmartShuffleNextResult {
  const length = normalizedLength(input.queueLength);
  if (!length) return { index: -1, history: [], exhausted: true };
  const played = remapShuffleHistory(input.history, (index) => (index < length ? index : -1));
  const playedSet = new Set(played);
  let candidates = indexes(length).filter((index) => !playedSet.has(index));
  let history = played;
  let exhausted = false;
  if (!candidates.length) {
    exhausted = true;
    const last = played[played.length - 1];
    history = [];
    candidates = indexes(length).filter((index) => length === 1 || index !== last);
  }
  const chosen = candidates[pickIndex(candidates.length, random)] ?? 0;
  return { index: chosen, history: [...history, chosen], exhausted };
}

export function previousSmartShuffle(input: SmartShuffleInput): SmartShuffleResult {
  const length = normalizedLength(input.queueLength);
  if (!length) return { index: -1, history: [] };
  const currentIndex = clampIndex(input.currentIndex, length);
  const history = sanitizeHistory(input.history, length, currentIndex);
  if (history.length <= 1) return { index: currentIndex, history };

  const previousHistory = history.slice(0, -1);
  return {
    index: previousHistory[previousHistory.length - 1] ?? currentIndex,
    history: previousHistory,
  };
}

/** True once every queued position has played in the current cycle. */
export function isShuffleCycleComplete(
  history: number[],
  queueLength: number,
  currentIndex: number | undefined,
): boolean {
  const length = normalizedLength(queueLength);
  if (!length) return true;
  // Called on every engine tick; a history shorter than the queue cannot be
  // complete, so the common case never pays for the sanitize pass.
  if (!Array.isArray(history) || history.length < length) return false;
  return sanitizeHistory(history, length, clampIndex(currentIndex, length)).length >= length;
}

/** Queued positions the current cycle has not played yet. */
export function shuffleUnplayedCount(
  history: number[],
  queueLength: number,
  currentIndex: number | undefined,
): number {
  const length = normalizedLength(queueLength);
  if (!length) return 0;
  const played = sanitizeHistory(history, length, clampIndex(currentIndex, length)).length;
  return Math.max(0, length - played);
}

/**
 * Carries a shuffle history across a queue edit. `map` takes a position in
 * the old queue and returns its position in the new one, or -1 when the track
 * is gone. The result is always a new array, which is what invalidates a
 * cached handoff pick made against the old queue.
 */
export function remapShuffleHistory(history: number[], map: (index: number) => number): number[] {
  const seen = new Set<number>();
  const remapped: number[] = [];
  for (const raw of Array.isArray(history) ? history : []) {
    const index = Math.trunc(Number(raw));
    if (!Number.isFinite(index) || index < 0) continue;
    const mapped = map(index);
    if (!Number.isInteger(mapped) || mapped < 0 || seen.has(mapped)) continue;
    seen.add(mapped);
    remapped.push(mapped);
  }
  return remapped;
}

/** `count` tracks were spliced in at `insertAt`. */
export function insertionIndexMap(insertAt: number, count: number): (index: number) => number {
  const at = Math.max(0, Math.trunc(Number(insertAt) || 0));
  const added = Math.max(0, Math.trunc(Number(count) || 0));
  return (index) => (index >= at ? index + added : index);
}

/** One track moved; from/to are clamped the same way moveQueueItem clamps them. */
export function moveIndexMap(queueLength: number, fromIndex: number, toIndex: number): (index: number) => number {
  const length = normalizedLength(queueLength);
  if (!length) return () => -1;
  const from = clampEditIndex(fromIndex, length);
  const to = clampEditIndex(toIndex, length);
  return (index) => {
    if (from === to) return index;
    if (index === from) return to;
    if (from < to && index > from && index <= to) return index - 1;
    if (from > to && index >= to && index < from) return index + 1;
    return index;
  };
}

/** One track removed; the index is clamped the same way removeQueueItem clamps it. */
export function removeIndexMap(queueLength: number, removeIndex: number): (index: number) => number {
  const length = normalizedLength(queueLength);
  if (!length) return () => -1;
  return removalIndexMap(length, [clampEditIndex(removeIndex, length)]);
}

/** Tracks at the given old positions were removed. */
export function removalIndexMap(queueLength: number, removed: Iterable<number>): (index: number) => number {
  const length = normalizedLength(queueLength);
  const gone = new Set(removed);
  const shifted = new Int32Array(length);
  let kept = 0;
  for (let index = 0; index < length; index += 1) shifted[index] = gone.has(index) ? -1 : kept++;
  return (index) => (index >= 0 && index < length ? shifted[index]! : -1);
}

function sanitizeHistory(history: number[], queueLength: number, currentIndex: number): number[] {
  const seen = new Set<number>();
  const clean: number[] = [];
  for (const raw of Array.isArray(history) ? history : []) {
    const index = Math.trunc(Number(raw));
    if (!Number.isFinite(index) || index < 0 || index >= queueLength) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    clean.push(index);
  }
  if (clean[clean.length - 1] !== currentIndex) {
    const withoutCurrent = clean.filter((index) => index !== currentIndex);
    withoutCurrent.push(currentIndex);
    return withoutCurrent;
  }
  return clean;
}

function indexes(length: number): number[] {
  return Array.from({ length }, (_item, index) => index);
}

function normalizedLength(value: number): number {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function clampIndex(value: number | undefined, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.trunc(Number(value) || 0)));
}

function pickIndex(length: number, random: () => number): number {
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0;
  return Math.floor(normalized * length);
}

function clampEditIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(value)));
}
