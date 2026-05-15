export interface SmartShuffleInput {
  queueLength: number;
  currentIndex: number | undefined;
  history: number[];
}

export interface SmartShuffleResult {
  index: number;
  history: number[];
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
): SmartShuffleResult {
  const length = normalizedLength(input.queueLength);
  if (!length) return { index: -1, history: [] };
  if (length === 1) return { index: 0, history: [0] };

  const currentIndex = clampIndex(input.currentIndex, length);
  let history = sanitizeHistory(input.history, length, currentIndex);
  let candidates = indexes(length).filter((index) => !history.includes(index));

  if (!candidates.length) {
    history = [currentIndex];
    candidates = indexes(length).filter((index) => index !== currentIndex);
  }

  const chosen = candidates[pickIndex(candidates.length, random)] ?? currentIndex;
  return { index: chosen, history: [...history, chosen] };
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

function sanitizeHistory(history: number[], queueLength: number, currentIndex: number): number[] {
  const clean: number[] = [];
  for (const raw of Array.isArray(history) ? history : []) {
    const index = Math.trunc(Number(raw));
    if (!Number.isFinite(index) || index < 0 || index >= queueLength) continue;
    if (!clean.includes(index)) clean.push(index);
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
