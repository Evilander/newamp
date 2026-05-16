// Liner Notes — the "On Air" side panel that replaces the musician-tools
// stack in the guitar-tab slot. It is what you read while listening: a track
// stat block, a sonic vitals grid, lyric hot lines pulled from the synced
// lyrics, optional producer credits when present, and a rotating Heidecker
// blurb (an On Cinema reference because the brand mascot is New Heidecker).

import { useMemo } from 'react';
import type { LrcLine } from '../api/lrclib';
import type { Track } from '@shared/types';
import { formatTime } from '../lib/format';

const HEIDECKER_BLURBS: string[] = [
  "Five bagels. That's how many bagels I'd give this one.",
  'New Heidecker says: a song is just a movie with no pictures, folks.',
  'I would compare this to *Mr. Brooks*, but better.',
  'This track has the rare three-headed quality: vibe, hook, and gravitas.',
  'A subtle homage to *Decker: Mind of an Architect* — if you listen closely.',
  "On Cinema at the Cinema rates this song 'In My Top 200'.",
  'Recorded somewhere between *Decker vs. Dracula* and *Hung Sky II*.',
  "I'd put this on a playlist between Beatles tracks and you'd think it was the Beatles.",
  'Bagel reference: warm, with cream cheese, not toasted.',
  'A no-nonsense banger from the world of NEWAMP. Five bags of popcorn.',
];

function heideckerBlurb(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % HEIDECKER_BLURBS.length;
  return HEIDECKER_BLURBS[idx]!;
}

function pickLyricHotLines(lines: LrcLine[] | null, plain: string | null | undefined): string[] {
  const candidates: string[] = [];
  if (lines?.length) {
    for (const line of lines) {
      const text = (line.text || '').trim();
      if (!text || text === '♪') continue;
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
  // Score: distinct words preferred, between 4 and 14 words, no common chorus words alone.
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
  const blurb = useMemo(() => heideckerBlurb(`${track.id}:${track.artist}`), [track.id, track.artist]);
  const hotLines = useMemo(() => pickLyricHotLines(lyrics.lines, lyrics.plain), [lyrics.lines, lyrics.plain]);
  const scoreLabel = track.ratingScore != null ? track.ratingScore.toFixed(1) : '—';

  return (
    <div
      data-newamp-liner-notes
      className="liner-notes-panel"
    >
      <header className="liner-notes-header">
        <span className="liner-notes-eyebrow">On Air · New Heidecker reviews</span>
        <span className="liner-notes-score" data-newamp-liner-score>{scoreLabel}</span>
      </header>

      <section className="liner-notes-blurb">
        <span className="liner-notes-quote-mark">&ldquo;</span>
        <p>{blurb}</p>
        <span className="liner-notes-attribution">— New Heidecker, NewAmp Notes</span>
      </section>

      <section className="liner-notes-vitals">
        <span className="liner-notes-vitals-title">Sonic Vitals</span>
        <div className="liner-notes-vital-grid">
          <Vital label="BPM" value={track.bpm ? track.bpm.toFixed(1) : '—'} />
          <Vital label="Key" value={track.key || '—'} />
          <Vital
            label="Loud"
            value={
              track.replayGainTrackDb != null
                ? `${track.replayGainTrackDb > 0 ? '+' : ''}${track.replayGainTrackDb.toFixed(1)} dB`
                : '—'
            }
          />
          <Vital label="Year" value={track.year ? String(track.year) : '—'} />
          <Vital label="Plays" value={track.playCount.toLocaleString()} />
          <Vital
            label="Length"
            value={track.duration ? formatTime(track.duration) : '—'}
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
          <CreditRow label="Album" value={track.album || '—'} />
          {track.albumArtist && track.albumArtist !== track.artist ? (
            <CreditRow label="Album Artist" value={track.albumArtist} />
          ) : null}
          <CreditRow label="Genre" value={track.genre || '—'} />
          <CreditRow
            label="Catalog"
            value={track.trackNo != null ? `Track ${track.trackNo}${track.discNo ? ` · Disc ${track.discNo}` : ''}` : '—'}
          />
        </dl>
      </section>

      <footer className="liner-notes-footer">
        NewAmp · NewHeidecker.exe · Field Notes · NHRP-1
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
