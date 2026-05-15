export interface EqPreset {
  name: string;
  values: number[];
}

export const EQ_BAND_COUNT = 10;
export const FLAT_EQ_VALUES = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

export const EQ_PRESETS: readonly EqPreset[] = Object.freeze([
  { name: 'Flat', values: [...FLAT_EQ_VALUES] },
  { name: 'Rock', values: [4, 3, -1, -2, -1, 1, 3, 4, 5, 5] },
  { name: 'Jazz', values: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { name: 'Classical', values: [4, 3, 2, 1, 0, 0, -1, -1, -2, -2] },
  { name: 'Electronic', values: [4, 3, 0, -2, -2, 0, 1, 2, 4, 5] },
  { name: 'Hip-Hop', values: [5, 4, 2, 1, -1, -1, 1, 2, 3, 3] },
  { name: 'Vocal', values: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: 'Bass+', values: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
  { name: 'Treble+', values: [0, 0, 0, 0, 0, 1, 3, 5, 6, 6] },
  { name: 'Night', values: [-3, -2, -1, 0, 1, 2, 1, 0, -1, -2] },
  { name: 'Car', values: [3, 2, 0, -1, -1, 0, 2, 3, 2, 1] },
]);

export function normalizeEqValues(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < EQ_BAND_COUNT) return [...FLAT_EQ_VALUES];
  return value.slice(0, EQ_BAND_COUNT).map((band) => {
    const n = Math.round(Number(band));
    return Number.isFinite(n) ? Math.max(-12, Math.min(12, n)) : 0;
  });
}

export function findEqPresetName(values: unknown): string {
  const normalized = normalizeEqValues(values);
  return EQ_PRESETS.find((preset) => sameEqValues(preset.values, normalized))?.name ?? 'Custom';
}

function sameEqValues(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
