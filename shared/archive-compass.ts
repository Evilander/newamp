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
    { label: 'Lossless shelf', value: quality.lossless, tone: 'good' },
    { label: 'Hi-res masters', value: quality.hiRes, tone: 'good' },
    { label: 'DSD shelf', value: quality.dsd, tone: quality.dsd ? 'good' : 'neutral' },
    { label: 'ReplayGain ready', value: quality.replayGainReady, tone: 'good' },
  ]);
  const risks = topSignals([
    { label: 'ReplayGain missing', value: quality.replayGainMissing, tone: quality.replayGainMissing ? 'warn' : 'good' },
    { label: 'Low bitrate fossils', value: quality.lowBitrate, tone: quality.lowBitrate ? 'bad' : 'good' },
    { label: 'Unknown codecs', value: quality.unknown, tone: quality.unknown ? 'bad' : 'good' },
    { label: 'Exact duplicate signal', value: duplicateExact, tone: duplicateExact ? 'warn' : 'good' },
    { label: 'Metadata holes', value: missingTotal, tone: missingTotal ? 'warn' : 'good' },
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
      label: 'Level the archive',
      detail: `${formatCount(health.quality.replayGainMissing)} tracks need ReplayGain before shuffle feels album-safe.`,
      query: 'rg:missing',
    });
  }
  if (health.quality.lowBitrate) {
    moves.push({
      label: 'Audit the fossils',
      detail: `${formatCount(health.quality.lowBitrate)} low-bitrate files are worth replacing or quarantining.`,
      query: 'quality:low-bitrate',
    });
  }
  if (health.quality.dsd) {
    moves.push({
      label: 'Mark the DSD shelf',
      detail: `${formatCount(health.quality.dsd)} DSD files are playable through FFmpeg PCM fallback; native DSD output is a future audiophile lane.`,
      query: 'quality:dsd',
    });
  }
  if (health.quality.unknown) {
    moves.push({
      label: 'Decode the unknowns',
      detail: `${formatCount(health.quality.unknown)} tracks have codec signals NewAmp cannot classify yet.`,
      query: 'quality:unknown',
    });
  }
  if (counts.duplicateExact) {
    moves.push({
      label: 'Collapse mirror copies',
      detail: `${formatCount(counts.duplicateExact)} exact-looking duplicate signals are ready for review.`,
      query: null,
    });
  }
  if (counts.missingTotal) {
    moves.push({
      label: 'Patch the sleeve notes',
      detail: `${formatCount(counts.missingTotal)} metadata/art gaps are holding back discovery and presentation.`,
      query: 'missing:art',
    });
  }
  if (!moves.length) {
    moves.push({
      label: 'Curate the crown shelf',
      detail: 'The obvious archive debts are clean. Build a high-score listening set or a hi-res showcase next.',
      query: 'quality:hires',
    });
  }
  return moves.slice(0, 4);
}

function profileFor(health: LibraryHealth, score: number): string {
  if (!health.totals.tracks) return 'Empty Shelf';
  const q = health.quality;
  if (score >= 92 && q.hiRes >= 12) return 'Reference Vault';
  if (q.dsd >= 1 && q.lossless >= q.lossy) return 'DSD Cabinet';
  if (q.lossless >= q.lossy * 2 && q.replayGainReady >= q.replayGainMissing) return 'Lossless Library';
  if (q.lowBitrate + q.unknown + missingMetadataTotal(health) > health.totals.tracks * 0.35) return 'Rescue Crate';
  if (q.replayGainMissing > q.replayGainReady) return 'Normalization Debt';
  if (score >= 82) return 'Clean Collector Shelf';
  return 'Crate-Digger Workbench';
}

function headlineFor(health: LibraryHealth, score: number): string {
  const q = health.quality;
  if (!health.totals.tracks) return 'Load a library and NewAmp will read the archive shape.';
  if (score >= 92) return 'This library is close to reference-grade.';
  if (q.dsd) return 'There is a DSD shelf here; NewAmp can see it and play it through PCM fallback.';
  if (q.replayGainMissing > q.replayGainReady) return 'The archive is playable, but loudness normalization is the main drag.';
  if (q.lowBitrate) return 'The weak signal is not taste; it is old encodes hiding in the shelf.';
  if (missingMetadataTotal(health)) return 'The collection has enough music; the next win is presentation metadata.';
  return 'The archive is coherent. Now it is ready for deeper discovery.';
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
    `${formatCount(counts.duplicateExact)} exact duplicate signals`,
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
