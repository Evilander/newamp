export const MIN_PREAMP_DB = -12;
export const MAX_PREAMP_DB = 6;
export const PREAMP_STEP_DB = 0.5;

export function normalizeLimiterEnabled(value: unknown): boolean {
  return value !== false;
}

export function normalizePreampDb(value: unknown): number {
  const db = Number(value);
  if (!Number.isFinite(db)) return 0;
  const stepped = Math.round(db / PREAMP_STEP_DB) * PREAMP_STEP_DB;
  return Math.max(MIN_PREAMP_DB, Math.min(MAX_PREAMP_DB, stepped));
}

export function preampDbToLinear(value: unknown): number {
  return Math.pow(10, normalizePreampDb(value) / 20);
}
