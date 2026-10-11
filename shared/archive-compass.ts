import type { LibraryHealth } from './types.js';

export type ArchiveGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface ArchiveCompassSignal {
  label: string;
  value: number;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

export interface ArchiveCompassMove {
  label: string;
  detail: string;
  query: string | null;
}

export interface ArchiveCompass {
  score: number;
  grade: ArchiveGrade;
  profile: string;
  headline: string;
  detail: string;
  ratios: {
    losslessPct: number;
    hiResPct: number;
    replayGainPct: number;
    issuePct: number;
  };
  strengths: ArchiveCompassSignal[];
  risks: ArchiveCompassSignal[];
  moves: ArchiveCompassMove[];
}

export function buildArchiveCompass(health: LibraryHealth): ArchiveCompass {
  const total = Math.max(1, health.totals.tracks);
  const missingTotal = missingMetadataTotal(health);
  const duplicateExact = duplicateExactTotal(health);
  const legacyTotal = legacyFormatTotal(health);
  const quality = health.quality;
  const issueTotal = missingTotal + duplicateExact + quality.lowBitrate + quality.unknown + quality.replayGainMissing;
  const losslessPct = pct(quality.lossless, total);
  const hiResPct = pct(quality.hiRes, total);
  const replayGainPct = pct(quality.replayGainReady, total);
  const issuePct = pct(issueTotal, total);
  const score = clampScore(
    62 +
      losslessPct * 0.16 +
      hiResPct * 0.1 +
      replayGainPct * 0.11 +
      Math.min(quality.dsd, 12) * 0.25 -
      pct(missingTotal, total) * 0.24 -
      pct(duplicateExact, total) * 0.18 -
      pct(quality.lowBitrate, total) * 0.28 -
      pct(quality.unknown, total) * 0.34 -
      pct(quality.replayGainMissing, total) * 0.14 -
      pct(legacyTotal, total) * 0.04,
  );
  const grade = gradeForScore(score);
  const strengths = topSignals([
    { label: 'Lossless files', value: quality.lossless, tone: 'good' },
    { label: 'Hi-res files', value: quality.hiRes, tone: 'good' },
    { label: 'DSD files', value: quality.dsd, tone: quality.dsd ? 'good' : 'neutral' },
    { label: 'ReplayGain ready', value: quality.replayGainReady, tone: 'good' },
  ]);
  const risks = topSignals([
    { label: 'ReplayGain missing', value: quality.replayGainMissing, tone: quality.replayGainMissing ? 'warn' : 'good' },
    { label: 'Low-bitrate files', value: quality.lowBitrate, tone: quality.lowBitrate ? 'bad' : 'good' },
    { label: 'Unknown codecs', value: quality.unknown, tone: quality.unknown ? 'bad' : 'good' },
    { label: 'Exact duplicates', value: duplicateExact, tone: duplicateExact ? 'warn' : 'good' },
    { label: 'Missing metadata', value: missingTotal, tone: missingTotal ? 'warn' : 'good' },
  ]);
  const moves = buildMoves(health, { missingTotal, duplicateExact, legacyTotal });
  const profile = profileFor(health, score);
  return {
    score,
    grade,
    profile,
    headline: headlineFor(health, score),
    detail: detailFor(health, { missingTotal, duplicateExact, legacyTotal }),
    ratios: { losslessPct, hiResPct, replayGainPct, issuePct },
    strengths,
    risks,
    moves,
  };
}

export function missingMetadataTotal(health: LibraryHealth): number {
  return (
    health.missing.artist +
    health.missing.album +
    health.missing.year +
    health.missing.art +
    health.missing.duration
  );
}

export function duplicateExactTotal(health: LibraryHealth): number {
  return health.duplicateGroups.reduce((sum, group) => sum + Math.max(0, group.exactMatchCount), 0);
}

export function legacyFormatTotal(health: LibraryHealth): number {
  return health.legacyFormats.reduce((sum, item) => sum + item.count, 0);
}

function buildMoves(
  health: LibraryHealth,
  counts: { missingTotal: number; duplicateExact: number; legacyTotal: number },
): ArchiveCompassMove[] {
  const moves: ArchiveCompassMove[] = [];
  if (health.quality.replayGainMissing) {
    moves.push({
      label: 'Add ReplayGain',
      detail: `${formatCount(health.quality.replayGainMissing)} tracks have no ReplayGain data, so loudness jumps between albums on shuffle.`,
      query: 'rg:missing',
    });
  }
  if (health.quality.lowBitrate) {
    moves.push({
      label: 'Review low-bitrate files',
      detail: `${formatCount(health.quality.lowBitrate)} low-bitrate files may be worth replacing.`,
      query: 'quality:low-bitrate',
    });
  }
  if (health.quality.dsd) {
    moves.push({
      label: 'Show DSD files',
      detail: `${formatCount(health.quality.dsd)} DSD files play as PCM through ffmpeg.`,
      query: 'quality:dsd',
    });
  }
  if (health.quality.unknown) {
    moves.push({
      label: 'Show unknown formats',
      detail: `${formatCount(health.quality.unknown)} tracks use a codec NewAmp cannot classify.`,
      query: 'quality:unknown',
    });
  }
  if (counts.duplicateExact) {
    moves.push({
      label: 'Review duplicates',
      detail: `${formatCount(counts.duplicateExact)} tracks look like exact duplicates.`,
      query: null,
    });
  }
  if (counts.missingTotal) {
    moves.push({
      label: 'Fix missing tags and art',
      detail: `${formatCount(counts.missingTotal)} tags or covers are missing across the library.`,
      query: 'missing:art',
    });
  }
  if (!moves.length) {
    moves.push({
      label: 'Browse hi-res tracks',
      detail: 'Nothing needs fixing. Browse your hi-res tracks next.',
      query: 'quality:hires',
    });
  }
  return moves.slice(0, 4);
}

function profileFor(health: LibraryHealth, score: number): string {
  if (!health.totals.tracks) return 'Empty library';
  const q = health.quality;
  if (score >= 92 && q.hiRes >= 12) return 'Hi-res library';
  if (q.dsd >= 1 && q.lossless >= q.lossy) return 'Lossless with DSD';
  if (q.lossless >= q.lossy * 2 && q.replayGainReady >= q.replayGainMissing) return 'Mostly lossless';
  if (q.lowBitrate + q.unknown + missingMetadataTotal(health) > health.totals.tracks * 0.35) return 'Needs cleanup';
  if (q.replayGainMissing > q.replayGainReady) return 'Needs ReplayGain';
  if (score >= 82) return 'Mostly clean';
  return 'Mixed library';
}

function headlineFor(health: LibraryHealth, score: number): string {
  const q = health.quality;
  if (!health.totals.tracks) return 'Add a music folder to see how healthy your library is.';
  if (score >= 92) return 'Very few problems found.';
  if (q.dsd) return 'Your library includes DSD files, which NewAmp plays as PCM.';
  if (q.replayGainMissing > q.replayGainReady) return 'More tracks lack ReplayGain data than have it, so loudness varies between albums.';
  if (q.lowBitrate) return 'Some files are low-bitrate and may be worth replacing.';
  if (missingMetadataTotal(health)) return 'Some tracks are missing tags or cover art.';
  return 'No problems found.';
}

function detailFor(
  health: LibraryHealth,
  counts: { missingTotal: number; duplicateExact: number; legacyTotal: number },
): string {
  const q = health.quality;
  return [
    `${formatCount(q.lossless)} lossless`,
    `${formatCount(q.hiRes)} hi-res`,
    `${formatCount(q.ffmpegFallback)} fallback codecs`,
    `${formatCount(counts.duplicateExact)} exact duplicates`,
    `${formatCount(counts.missingTotal)} metadata gaps`,
  ].join(' / ');
}

function topSignals(signals: ArchiveCompassSignal[]): ArchiveCompassSignal[] {
  return [...signals].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 4);
}

function pct(value: number, total: number): number {
  return Math.max(0, Math.min(100, (value / Math.max(1, total)) * 100));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function gradeForScore(score: number): ArchiveGrade {
  if (score >= 94) return 'S';
  if (score >= 86) return 'A';
  if (score >= 76) return 'B';
  if (score >= 66) return 'C';
  if (score >= 52) return 'D';
  return 'F';
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
