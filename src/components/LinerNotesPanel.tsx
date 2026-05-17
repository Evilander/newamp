import { useMemo } from 'react';
import type { LrcLine } from '../api/lrclib';
import type { Track } from '@shared/types';
import { formatTime } from '../lib/format';

const FIELD_NOTE_BLURBS: string[] = [
  'This track has the rare three-part signal: vibe, hook, and replay value.',
  'A clean library pick with enough personality to earn its slot.',
  'Strong metadata, strong rotation potential, no streaming account required.',
  'The kind of local-file find that makes a personal library feel alive.',
  'A high-signal track for late-night queue building.',
  'Good candidate for a smart station seed.',
  'The scan says this one deserves attention.',
  'A useful anchor for the next mix.',
];

function fieldNoteBlurb(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % FIELD_NOTE_BLURBS.length;
  return FIELD_NOTE_BLURBS[idx]!;
}

function pickLyricHotLines(lines: LrcLine[] | null, plain: string | null | undefined): string[] {
  const candidates: string[] = [];
  if (lines?.length) {
    for (const line of lines) {
      const text = (line.text || '').trim();
      if (!text || text === '\u266a') continue;
      candidates.push(text);
    }
  } else if (plain) {
    for (const raw of plain.split(/\n+/)) {
      const text = raw.trim();
      if (!text) continue;
      candidates.push(text);
    }
  }
  if (!candidates.length) return [];
  const scored = candidates
    .map((text) => ({
      text,
      score:
        new Set(text.toLowerCase().split(/\W+/).filter(Boolean)).size *
        (text.split(/\s+/).length >= 4 && text.split(/\s+/).length <= 14 ? 1.5 : 0.6),
    }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const item of scored) {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(item.text);
    if (picks.length >= 3) break;
  }
  return picks;
}

interface LinerNotesPanelProps {
  track: Track;
  lyrics: { lines: LrcLine[] | null; plain?: string | null };
}

export function LinerNotesPanel({ track, lyrics }: LinerNotesPanelProps): JSX.Element {
  const blurb = useMemo(() => fieldNoteBlurb(`${track.id}:${track.artist}`), [track.id, track.artist]);
  const hotLines = useMemo(() => pickLyricHotLines(lyrics.lines, lyrics.plain), [lyrics.lines, lyrics.plain]);
  const score = Math.round(Math.max(0, Math.min(100, track.ratingScore ?? track.rating * 20)));
  const scoreLabel = `${score}/100`;

  return (
    <div
      data-newamp-liner-notes
      className="liner-notes-panel"
    >
      <header className="liner-notes-header">
        <span className="liner-notes-eyebrow">On Air / Field Notes</span>
        <span className="liner-notes-score" data-newamp-liner-score>{scoreLabel}</span>
      </header>

      <section className="liner-notes-blurb">
        <span className="liner-notes-quote-mark">&ldquo;</span>
        <p>{blurb}</p>
        <span className="liner-notes-attribution">NewAmp Notes</span>
      </section>

      <section className="liner-notes-vitals">
        <span className="liner-notes-vitals-title">Sonic Vitals</span>
        <div className="liner-notes-vital-grid">
          <Vital label="BPM" value={track.bpm ? track.bpm.toFixed(1) : '-'} />
          <Vital label="Key" value={track.key || '-'} />
          <Vital
            label="Loud"
            value={
              track.replayGainTrackDb != null
                ? `${track.replayGainTrackDb > 0 ? '+' : ''}${track.replayGainTrackDb.toFixed(1)} dB`
                : '-'
            }
          />
          <Vital label="Year" value={track.year ? String(track.year) : '-'} />
          <Vital label="Plays" value={track.playCount.toLocaleString()} />
          <Vital
            label="Length"
            value={track.duration ? formatTime(track.duration) : '-'}
          />
        </div>
      </section>

      {hotLines.length ? (
        <section className="liner-notes-hotlines">
          <span className="liner-notes-section-title">Hot Lines</span>
          <ol>
            {hotLines.map((line, idx) => (
              <li key={`${idx}-${line.slice(0, 12)}`}>{line}</li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="liner-notes-credits">
        <span className="liner-notes-section-title">File Credits</span>
        <dl>
          <CreditRow label="Artist" value={track.artist} />
          <CreditRow label="Album" value={track.album || '-'} />
          {track.albumArtist && track.albumArtist !== track.artist ? (
            <CreditRow label="Album Artist" value={track.albumArtist} />
          ) : null}
          <CreditRow label="Genre" value={track.genre || '-'} />
          <CreditRow
            label="Catalog"
            value={track.trackNo != null ? `Track ${track.trackNo}${track.discNo ? ` / Disc ${track.discNo}` : ''}` : '-'}
          />
        </dl>
      </section>

      <footer className="liner-notes-footer">
        NewAmp / Field Notes / NAMP-1
      </footer>
    </div>
  );
}

function Vital({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="liner-notes-vital">
      <span className="liner-notes-vital-label">{label}</span>
      <span className="liner-notes-vital-value">{value}</span>
    </div>
  );
}

function CreditRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
