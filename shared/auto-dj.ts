import type { Track } from './types.js';

export const AUTO_DJ_REFILL_THRESHOLD = 1;
export const DEFAULT_AUTO_DJ_TARGET = 24;
export const MIN_AUTO_DJ_TARGET = 6;
export const MAX_AUTO_DJ_TARGET = 80;
export const AUTO_DJ_SMART_RULE_LOOKAHEAD = 80;
export const MAX_AUTO_DJ_SMART_RULE_CANDIDATES = 200;

export interface AutoDjRefillState {
  enabled: boolean;
  queueLength: number;
  index: number;
}

export function normalizeAutoDjTarget(value: number | null | undefined): number {
  const parsed = Math.trunc(Number(value) || DEFAULT_AUTO_DJ_TARGET);
  return Math.max(MIN_AUTO_DJ_TARGET, Math.min(MAX_AUTO_DJ_TARGET, parsed));
}

export function autoDjSmartRuleCandidateCount(
  ruleCount: number,
  targetQueueLength: number,
  queueLength: number,
): number {
  const savedRuleCount = Math.trunc(Number(ruleCount) || 0);
  const refillDepth =
    Math.trunc(Number(targetQueueLength) || DEFAULT_AUTO_DJ_TARGET) +
    Math.max(0, Math.trunc(Number(queueLength) || 0)) +
    AUTO_DJ_SMART_RULE_LOOKAHEAD;
  return Math.max(1, Math.min(MAX_AUTO_DJ_SMART_RULE_CANDIDATES, Math.max(savedRuleCount, refillDepth)));
}

export function shouldAutoDjRefill(state: AutoDjRefillState): boolean {
  if (!state.enabled || state.queueLength <= 0 || state.index < 0) return false;
  return state.queueLength - state.index - 1 <= AUTO_DJ_REFILL_THRESHOLD;
}

export function selectAutoDjAdditions(
  queue: Track[],
  candidates: Track[],
  targetQueueLength: number,
  remainingAhead: number,
): Track[] {
  // `queue` holds played history AND upcoming tracks — sizing against
  // queue.length (as this used to) means a long-played session whose total
  // length reaches the target permanently reads as "full" even though only
  // one or two tracks remain ahead. Size against what's actually left to
  // play instead.
  const target = Math.max(0, Math.trunc(Number(targetQueueLength) || 0));
  const ahead = Math.max(0, Math.trunc(Number(remainingAhead) || 0));
  const needed = Math.max(0, target - ahead);
  if (!needed) return [];

  const seen = new Set(queue.map((track) => track.id));
  const additions: Track[] = [];
  for (const candidate of candidates) {
    if (candidate.avoidAutoPlay) continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    additions.push(candidate);
    if (additions.length >= needed) break;
  }
  return additions;
}
