import type { LibraryHealth } from './types.js';

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
  return {
    headline: headlineFor(health),
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

/** Artist, album, year and length gaps; cover art is counted on its own. */
export function missingTagTotal(health: LibraryHealth): number {
  return health.missing.artist + health.missing.album + health.missing.year + health.missing.duration;
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
  if (health.missing.art) {
    moves.push({
      label: 'Find cover art',
      detail: `${formatCount(health.missing.art)} tracks have no cover art.`,
      query: 'missing:art',
    });
  }
  const tagGaps = missingTagGaps(health);
  if (tagGaps.total) {
    moves.push({
      label: 'Fix missing tags',
      detail: `${formatCount(tagGaps.total)} tags are missing, mostly ${tagGaps.worst.label}.`,
      query: `missing:${tagGaps.worst.token}`,
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

// Artist, album, year and length gaps counted together, and the field with the
// most of them, so the move can name it and open the tracks it is about.
function missingTagGaps(health: LibraryHealth): { total: number; worst: { label: string; token: string } } {
  const fields = [
    { label: 'artist names', token: 'artist', count: health.missing.artist },
    { label: 'album names', token: 'album', count: health.missing.album },
    { label: 'years', token: 'year', count: health.missing.year },
    { label: 'track lengths', token: 'duration', count: health.missing.duration },
  ];
  const worst = fields.reduce((best, field) => (field.count > best.count ? field : best));
  return { total: missingTagTotal(health), worst };
}

function headlineFor(health: LibraryHealth): string {
  const q = health.quality;
  if (!health.totals.tracks) return 'Add a music folder to see how healthy your library is.';
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

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
