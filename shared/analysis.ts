// What the background analysis still owes each track.
//
// A track's tempo, key, loudness and Audio DNA live in ordinary columns (bpm,
// key, replaygain_track_db, dna_json). A value read from the file's own tags is
// never touched. A value the analysis wrote is remembered in tracks.analysis_json
// with the analyzer version that wrote it, so a better analyzer later redoes
// only those and leaves tags alone. A value the analyzer tried and could not
// produce (an undecodable file, a beat grid it does not trust) is remembered the
// same way, so it is not tried again until the analyzer changes.
//
// Pure module: the same rules are written once as TypeScript (what to run for a
// row) and once as SQL (which rows to load), and a test holds them together.

import { AUDIO_DNA_VERSION } from './audio-dna.js';

/** Bumped when an analyzer's output changes; tracks it wrote earlier are redone. */
export const ANALYSIS_VERSIONS = {
  loud: 1,
  tempo: 1,
  dna: AUDIO_DNA_VERSION,
} as const;

export type AnalysisField = 'loud' | 'bpm' | 'key' | 'dna';
export type AnalysisRecord = Partial<Record<AnalysisField, number>>;

/** The analyzer version each field is compared against. */
const FIELD_VERSION: Record<AnalysisField, number> = {
  loud: ANALYSIS_VERSIONS.loud,
  bpm: ANALYSIS_VERSIONS.tempo,
  key: ANALYSIS_VERSIONS.tempo,
  dna: ANALYSIS_VERSIONS.dna,
};

export interface AnalysisRowState {
  bpm: number | null;
  key: string | null;
  replayGainTrackDb: number | null;
  /** The v inside dna_json; null when the track has no DNA. */
  dnaVersion: number | null;
  analysisJson: string | null;
}

export interface AnalysisWork {
  loud: boolean;
  bpm: boolean;
  key: boolean;
  dna: boolean;
}

export function hasKnownBpm(bpm: number | null | undefined): bpm is number {
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0;
}

export function hasKnownKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.trim() !== '';
}

export function parseAnalysisRecord(json: string | null | undefined): AnalysisRecord {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: AnalysisRecord = {};
    for (const field of Object.keys(FIELD_VERSION) as AnalysisField[]) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[field] = Math.trunc(value);
    }
    return out;
  } catch {
    return {};
  }
}

// Missing and never tried, or written by the analysis at an older version.
function owed(missing: boolean, recorded: number | undefined, current: number): boolean {
  return (recorded ?? 0) < current && (missing || recorded !== undefined);
}

export function analysisWork(row: AnalysisRowState): AnalysisWork {
  const record = parseAnalysisRecord(row.analysisJson);
  return {
    loud: owed(row.replayGainTrackDb == null, record.loud, FIELD_VERSION.loud),
    bpm: owed(!hasKnownBpm(row.bpm), record.bpm, FIELD_VERSION.bpm),
    key: owed(!hasKnownKey(row.key), record.key, FIELD_VERSION.key),
    // DNA carries its own version, so an old one is redone whoever wrote it.
    dna:
      row.dnaVersion == null
        ? (record.dna ?? 0) < FIELD_VERSION.dna
        : row.dnaVersion < FIELD_VERSION.dna,
  };
}

export function anyWork(work: AnalysisWork): boolean {
  return work.loud || work.bpm || work.key || work.dna;
}

/**
 * Fields the analysis wrote or tried, merged over what the track already
 * records. The integrated loudness rides along, so an album's gain can be worked
 * out later without decoding the tracks again.
 */
export function mergeAnalysisRecord(
  json: string | null | undefined,
  touched: AnalysisField[],
  lufs?: number | null,
): string {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = json ? JSON.parse(json) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    /* a damaged record starts over */
  }
  for (const field of touched) raw[field] = FIELD_VERSION[field];
  if (typeof lufs === 'number' && Number.isFinite(lufs)) raw.lufs = Math.round(lufs * 10) / 10;
  return JSON.stringify(raw);
}

// The row filter for "this track still owes something". The expressions mirror
// analysisWork(); analysis-queue-test.mjs runs both over the same rows.
function recordedSql(field: AnalysisField): string {
  return `(CASE WHEN json_valid(analysis_json) THEN json_extract(analysis_json, '$.${field}') END)`;
}

function owedSql(field: AnalysisField, missing: string): string {
  const recorded = recordedSql(field);
  return `(COALESCE(${recorded}, 0) < ${FIELD_VERSION[field]} AND (${missing} OR ${recorded} IS NOT NULL))`;
}

export const ANALYSIS_OWED_SQL = `(
  ${owedSql('loud', 'replaygain_track_db IS NULL')}
  OR ${owedSql('bpm', '(bpm IS NULL OR bpm <= 0)')}
  OR ${owedSql('key', `(key IS NULL OR trim(key) = '')`)}
  OR (dna_json IS NULL AND COALESCE(${recordedSql('dna')}, 0) < ${FIELD_VERSION.dna})
  OR (dna_json IS NOT NULL AND COALESCE(CASE WHEN json_valid(dna_json) THEN json_extract(dna_json, '$.v') END, 0) < ${FIELD_VERSION.dna})
)`;

/** Tracks the analysis can read: not gone, and a file on disk rather than a server's stream. */
export const ANALYSIS_ELIGIBLE_SQL = `(missing_since IS NULL AND path IS NOT NULL AND path NOT LIKE '%://%')`;

/** Camelot-free, harmonic-mix readable key names, sharps only. */
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function keyName(tonic: number, minor: boolean): string | null {
  if (!Number.isInteger(tonic) || tonic < 0 || tonic > 11) return null;
  return `${KEY_NAMES[tonic]}${minor ? 'm' : ''}`;
}

// A beat grid below this is a guess (eviland-score.ts says the same); a stored
// wrong tempo is worse than none, because "slow" and "fast" filters trust it.
export const MIN_TRUSTED_BEAT_CONFIDENCE = 0.35;
// Likewise for the key: the score's own key shifts need 0.6.
export const MIN_TRUSTED_KEY_CONFIDENCE = 0.6;

export interface AnalysisProgress {
  /** Switched on in Settings. */
  enabled: boolean;
  /** What the queue is doing right now. */
  state: 'off' | 'starting' | 'running' | 'waiting' | 'done';
  /** Why it is not running, when it is waiting. */
  waitingFor: 'playback' | 'scan' | 'busy' | 'battery' | null;
  /** Tracks the analysis can read. */
  total: number;
  /** Tracks with nothing left to do. */
  done: number;
  remaining: number;
  /** Tracks per hour over the last few minutes; null until there is a sample. */
  tracksPerHour: number | null;
  /** Seconds left at that rate; null when unknown. */
  etaSeconds: number | null;
  /** Tracks that have a value, tags included. */
  coverage: { tempo: number; key: number; loudness: number; dna: number };
}

/** The decode was stopped from outside (playback needed the drive, or the queue was switched off). */
export class AnalysisAbortedError extends Error {
  constructor() {
    super('analysis stopped');
    this.name = 'AnalysisAbortedError';
  }
}

/** The file could not be opened: gone, or its drive is. Nothing is learned about the audio. */
export class AnalysisUnavailableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'AnalysisUnavailableError';
  }
}

/** ffmpeg did not finish in time. A busy drive does this to good files, so it is retried before it is held against the track. */
export class AnalysisTimedOutError extends Error {
  constructor(path: string) {
    super(`ffmpeg timed out analysing ${path}`);
    this.name = 'AnalysisTimedOutError';
  }
}

/** What the progress line shows before the queue has said anything, or where there is no queue. */
export function emptyAnalysisProgress(enabled = false): AnalysisProgress {
  return {
    enabled,
    state: enabled ? 'starting' : 'off',
    waitingFor: null,
    total: 0,
    done: 0,
    remaining: 0,
    tracksPerHour: null,
    etaSeconds: null,
    coverage: { tempo: 0, key: 0, loudness: 0, dna: 0 },
  };
}

function count(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** "about 31 hours", "about 40 minutes", "under a minute". */
export function formatAnalysisEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'under a minute';
  const minutes = seconds / 60;
  if (minutes < 90) return `about ${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

const WAITING_TEXT: Record<NonNullable<AnalysisProgress['waitingFor']>, string> = {
  playback: 'Paused so the music keeps playing smoothly.',
  scan: 'Paused while the library scans.',
  battery: 'Paused on battery power.',
  busy: 'Paused while the computer is busy.',
};

/** The plain-language lines for the progress readout in Settings. */
export function describeAnalysis(progress: AnalysisProgress): {
  status: string;
  counts: string;
  eta: string | null;
  coverage: string;
  fraction: number;
} {
  const { state, total, done, remaining } = progress;
  let status: string;
  if (state === 'off') status = 'Off.';
  else if (state === 'starting') status = 'Starts a little after launch.';
  else if (state === 'waiting') status = (progress.waitingFor && WAITING_TEXT[progress.waitingFor]) || 'Paused.';
  else if (state === 'done') {
    status = remaining > 0 ? `Done, apart from ${count(remaining)} tracks it could not read.` : 'Every track is analysed.';
  }
  else status = 'Working in the background.';
  const counts = total > 0 ? `${count(done)} of ${count(total)} tracks analysed` : 'No tracks yet';
  const eta = state === 'running' || state === 'waiting' ? formatAnalysisEta(progress.etaSeconds) : null;
  const { tempo, key, loudness, dna } = progress.coverage;
  const coverage = `Tempo ${count(tempo)} · key ${count(key)} · loudness ${count(loudness)} · sound ${count(dna)}`;
  return { status, counts, eta: eta && remaining > 0 ? `${eta} left` : null, coverage, fraction: total > 0 ? done / total : 0 };
}
