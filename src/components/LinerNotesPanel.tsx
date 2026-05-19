import { useEffect, useMemo, useState } from 'react';
import type { LrcLine } from '../api/lrclib';
import type { AiLinerNotesResult, Track } from '@shared/types';
import { api } from '../lib/api';
import { formatTime } from '../lib/format';
import { musicEntitySearchText, wikipediaSearchUrl } from '../lib/wiki';

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
  aiAssistReady: boolean;
  aiModel: string | null;
}

export function LinerNotesPanel({
  track,
  lyrics,
  aiAssistReady,
  aiModel,
}: LinerNotesPanelProps): JSX.Element {
  const [aiNotes, setAiNotes] = useState<AiLinerNotesResult | null>(null);
  const [aiStatus, setAiStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [aiError, setAiError] = useState<string | null>(null);
  const blurb = useMemo(() => fieldNoteBlurb(`${track.id}:${track.artist}`), [track.id, track.artist]);
  const hotLines = useMemo(() => pickLyricHotLines(lyrics.lines, lyrics.plain), [lyrics.lines, lyrics.plain]);
  const score = Math.round(Math.max(0, Math.min(100, track.ratingScore ?? track.rating * 20)));
  const scoreLabel = `${score}/100`;

  useEffect(() => {
    setAiNotes(null);
    setAiStatus('idle');
    setAiError(null);
  }, [track.id]);

  async function draftAiNotes(): Promise<void> {
    setAiStatus('loading');
    setAiError(null);
    try {
      const result = await api.generateLinerNotes({
        track: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          albumArtist: track.albumArtist,
          genre: track.genre,
          year: track.year,
          duration: track.duration,
          rating: track.rating,
          ratingScore: track.ratingScore,
          bpm: track.bpm,
          key: track.key,
          playCount: track.playCount,
          skipCount: track.skipCount,
        },
        lyricHighlights: hotLines,
        lyricsPreview: lyricsPreview(lyrics.lines, lyrics.plain),
        localContext: localTrackContext(track, scoreLabel),
      });
      setAiNotes(result);
      setAiStatus('ok');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'ChatGPT assist failed.');
      setAiStatus('error');
    }
  }

  return (
    <div
      data-newamp-liner-notes
      className="liner-notes-panel"
    >
      <header className="liner-notes-header">
        <span className="liner-notes-eyebrow">On Air / Field Notes</span>
        <button
          type="button"
          className={`pxbtn liner-notes-ai-button ${aiStatus === 'ok' ? 'is-active' : ''}`}
          onClick={() => void draftAiNotes()}
          disabled={!aiAssistReady || aiStatus === 'loading'}
          title={aiAssistReady ? `Draft with ${aiModel || 'ChatGPT'}` : 'Add a ChatGPT API key in Settings'}
        >
          {aiStatus === 'loading' ? 'Drafting' : 'AI Notes'}
        </button>
        <span className="liner-notes-score" data-newamp-liner-score>{scoreLabel}</span>
      </header>

      {aiNotes ? (
        <section className="liner-notes-ai" data-newamp-ai-liner-notes>
          <div className="liner-notes-ai-top">
            <span>ChatGPT Assist</span>
            <em>{aiNotes.model}</em>
          </div>
          <strong>{aiNotes.headline}</strong>
          <p>{aiNotes.summary}</p>
          {aiNotes.listeningNotes.length ? (
            <ul>
              {aiNotes.listeningNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          {aiNotes.contextCards.length ? (
            <div className="liner-notes-ai-cards">
              {aiNotes.contextCards.map((card) => (
                <span key={`${card.label}:${card.value}`}>
                  <em>{card.label}</em>
                  <b>{card.value}</b>
                </span>
              ))}
            </div>
          ) : null}
          {aiNotes.caution ? <small>{aiNotes.caution}</small> : null}
        </section>
      ) : null}

      {aiError ? (
        <div className="liner-notes-ai-error" data-newamp-ai-liner-notes-error>
          {aiError}
        </div>
      ) : null}

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
          <CreditRow
            label="Artist"
            value={track.artist}
            href={wikipediaSearchUrl(musicEntitySearchText(track.artist, 'musician'))}
            linkDataAttr="data-newamp-liner-artist-link"
          />
          <CreditRow
            label="Album"
            value={track.album || '-'}
            href={track.album ? wikipediaSearchUrl(musicEntitySearchText(track.artist, track.album, 'album')) : null}
            linkDataAttr="data-newamp-liner-album-link"
          />
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

function lyricsPreview(lines: LrcLine[] | null, plain: string | null | undefined): string | null {
  if (lines?.length) {
    return lines
      .map((line) => line.text.trim())
      .filter(Boolean)
      .slice(0, 18)
      .join('\n') || null;
  }
  return plain?.trim().slice(0, 1200) || null;
}

function localTrackContext(track: Track, scoreLabel: string): string[] {
  return [
    `${track.artist || 'Unknown Artist'} - ${track.title || 'Unknown Title'}`,
    track.album ? `Album: ${track.album}` : '',
    track.albumArtist && track.albumArtist !== track.artist ? `Album artist: ${track.albumArtist}` : '',
    track.genre ? `Genre tag: ${track.genre}` : '',
    track.year ? `Year tag: ${track.year}` : '',
    track.duration ? `Length: ${formatTime(track.duration)}` : '',
    `NewAmp rating: ${scoreLabel}`,
    track.bpm ? `BPM: ${track.bpm.toFixed(1)}` : '',
    track.key ? `Key: ${track.key}` : '',
    `${track.playCount} plays / ${track.skipCount} skips`,
  ].filter(Boolean);
}

function Vital({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="liner-notes-vital">
      <span className="liner-notes-vital-label">{label}</span>
      <span className="liner-notes-vital-value">{value}</span>
    </div>
  );
}

function CreditRow({
  label,
  value,
  href,
  linkDataAttr,
}: {
  label: string;
  value: string;
  href?: string | null;
  linkDataAttr?: 'data-newamp-liner-artist-link' | 'data-newamp-liner-album-link';
}): JSX.Element {
  const linkProps =
    linkDataAttr === 'data-newamp-liner-artist-link'
      ? { 'data-newamp-liner-artist-link': true }
      : linkDataAttr === 'data-newamp-liner-album-link'
        ? { 'data-newamp-liner-album-link': true }
        : {};
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" {...linkProps}>
            {value}
          </a>
        ) : value}
      </dd>
    </>
  );
}
