import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Track } from '@shared/types';
import { api } from '../../lib/api';
import { formatDuration } from '../../lib/format';
import { usePlayerStore } from '../../store/usePlayerStore';
import { TrackTable } from './LibraryView';
import { ViewOnboarding, HelpDot, useViewHelp } from '../ViewOnboarding';
import { ArtistLink } from '../EntityLink';

interface GeneratedMix {
  id: string;
  title: string;
  subtitle: ReactNode;
  tracks: Track[];
  tone: 'accent' | 'warn' | 'plain';
}

const MIX_SIZE = 30;

export function MixesView(): JSX.Element {
  const help = useViewHelp();
  const [mixes, setMixes] = useState<GeneratedMix[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const current = usePlayerStore((s) => s.current);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);

  useEffect(() => {
    void refreshMixes();
  }, [current?.id]);

  const selected = useMemo(
    () => mixes.find((mix) => mix.id === selectedId) ?? mixes[0] ?? null,
    [mixes, selectedId],
  );

  async function refreshMixes(): Promise<void> {
    setLoading(true);
    setStatus(null);
    try {
      const [harmonic, taste, freshImports, loved, recent, mostPlayed, deepCuts, night] = await Promise.all([
        api.buildHarmonicMix({ seedTrackId: current?.id ?? null, count: MIX_SIZE }),
        api.buildTasteMix({ seedTrackId: current?.id ?? null, count: MIX_SIZE }),
        api.getTracks({ sort: 'added', limit: MIX_SIZE, offset: 0 }),
        api.getTracks({ sort: 'loved', limit: MIX_SIZE, offset: 0 }),
        api.getTracks({ sort: 'recent', limit: MIX_SIZE, offset: 0 }),
        api.getTracks({ sort: 'plays', limit: MIX_SIZE, offset: 0 }),
        api.runSmartPlaylistRule({
          name: 'Mixes Deep Cuts',
          mood: 'deep-cuts',
          count: MIX_SIZE,
          unplayedOnly: true,
        }),
        api.runSmartPlaylistRule({
          name: 'Mixes Night Drive',
          mood: 'night',
          count: MIX_SIZE,
          minRating: 3,
        }),
      ]);

      const next = uniqueMixes([
        {
          id: 'harmonic',
          title: current ? 'Harmonic From Now' : 'Harmonic Library Mix',
          subtitle: current ? (
            <>
              Transition-aware sequence from <ArtistLink artist={current.artist} color="inherit" /> - {current.title}
            </>
          ) : (
            'Transition-aware sequence using BPM/key metadata where available'
          ),
          tracks: harmonic,
          tone: 'accent',
        },
        {
          id: 'taste-match',
          title: 'Taste Match',
          subtitle: current ? (
            <>
              Learns from plays, loves, ratings, and skips around <ArtistLink artist={current.artist} color="inherit" /> - {current.title}
            </>
          ) : (
            'Learns from plays, loves, ratings, and skips across the library'
          ),
          tracks: taste,
          tone: 'warn',
        },
        {
          id: 'fresh-imports',
          title: 'Fresh Imports',
          subtitle: 'Newest files NewAmp has seen on disk',
          tracks: freshImports,
          tone: 'plain',
        },
        {
          id: 'loved',
          title: 'Loved Signal',
          subtitle: 'Your loved tracks, ready as a set',
          tracks: loved,
          tone: 'warn',
        },
        {
          id: 'recent',
          title: 'Recently Played',
          subtitle: 'A fast path back into the last listening thread',
          tracks: recent,
          tone: 'plain',
        },
        {
          id: 'most-played',
          title: 'Heavy Rotation',
          subtitle: 'The tracks NewAmp sees you return to most',
          tracks: mostPlayed,
          tone: 'plain',
        },
        {
          id: 'deep-cuts',
          title: 'Deep Cuts',
          subtitle: 'Less-played library tracks scored for discovery',
          tracks: deepCuts,
          tone: 'accent',
        },
        {
          id: 'night-drive',
          title: 'Night Drive',
          subtitle: 'Higher-rated late-session mix from the smart-rule engine',
          tracks: night,
          tone: 'warn',
        },
      ]).filter((mix) => mix.tracks.length > 0);

      setMixes(next);
      setSelectedId((currentId) => (
        currentId && next.some((mix) => mix.id === currentId) ? currentId : next[0]?.id ?? null
      ));
      setStatus(next.length ? `Generated ${next.length} playable mix${next.length === 1 ? '' : 'es'}.` : 'No mixes available yet.');
    } finally {
      setLoading(false);
    }
  }

  async function saveMix(mix: GeneratedMix): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const saved = await api.savePlaylist({
      name: `${mix.title} ${date}`,
      trackIds: mix.tracks.map((track) => track.id),
    });
    setStatus(`Saved ${saved.name} with ${saved.trackCount.toLocaleString()} tracks.`);
  }

  return (
    <div className="flex h-full flex-col">
      <ViewOnboarding
        viewId="mixes"
        title="Mixes"
        lede="Eight live mixes regenerated from your library every time you open this view or play a new seed track."
        bullets={[
          'Harmonic chains tracks by BPM + key + seed-vibe similarity for smooth DJ-style transitions.',
          'Taste Match weighs plays, loves, ratings, and skips around whatever you\'re listening to.',
          'Loved Signal / Heavy Rotation / Recently Played are fast paths back into your favorites.',
          'Click SAVE on any mix card to keep it as a normal playlist.',
        ]}
        forceVisible={help.open}
        onClose={help.close}
      />
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--muted)' }}>
          NewAmp Mixes
          <HelpDot help={help} label="What are Mixes?" />
        </div>
        <button className="pxbtn" onClick={() => void refreshMixes()} disabled={loading}>
          {loading ? 'Building...' : 'Refresh mixes'}
        </button>
        {status && <span className="text-[11px]" style={{ color: 'var(--ink-2)' }}>{status}</span>}
        <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
          {current ? (
            <>
              Seed: <ArtistLink artist={current.artist} color="inherit" /> - {current.title}
            </>
          ) : (
            'Play a track to seed harmonic mixes'
          )}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
        <div className="grid gap-3 border-b p-3" style={{ borderColor: 'var(--line)', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {mixes.map((mix) => (
            <div
              key={mix.id}
              className="bevel-out flex min-h-[132px] cursor-pointer flex-col items-start gap-2 p-3 text-left"
              role="button"
              tabIndex={0}
              style={{
                background: selected?.id === mix.id ? 'var(--panel-2)' : 'var(--panel)',
                borderColor: selected?.id === mix.id ? 'var(--accent)' : 'var(--line)',
              }}
              onClick={() => setSelectedId(mix.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedId(mix.id);
                }
              }}
            >
              <div className="flex w-full items-start gap-2">
                <div
                  className="lcd-text text-[26px] leading-none"
                  style={{ color: mix.tone === 'accent' ? 'var(--accent)' : mix.tone === 'warn' ? 'var(--warn)' : 'var(--ink)' }}
                >
                  {String(mix.tracks.length).padStart(2, '0')}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-bold">{mix.title}</div>
                  <div className="line-clamp-2 text-[11px]" style={{ color: 'var(--ink-2)' }}>
                    {mix.subtitle}
                  </div>
                </div>
              </div>
              <div className="text-[10px] tabular-nums" style={{ color: 'var(--muted)' }}>
                {formatDuration(mix.tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0))}
              </div>
              <div className="mt-auto flex flex-wrap gap-1">
                <button className="pxbtn is-active" onClick={(event) => {
                  event.stopPropagation();
                  void playQueue(mix.tracks, 0);
                }}>
                  PLAY
                </button>
                <button className="pxbtn" onClick={(event) => {
                  event.stopPropagation();
                  queueTracksNext(mix.tracks);
                }}>
                  NEXT
                </button>
                <button className="pxbtn" onClick={(event) => {
                  event.stopPropagation();
                  addTracksToQueue(mix.tracks);
                }}>
                  QUEUE
                </button>
                <button className="pxbtn" onClick={(event) => {
                  event.stopPropagation();
                  void saveMix(mix);
                }}>
                  SAVE
                </button>
              </div>
            </div>
          ))}
          {!mixes.length && (
            <div className="bevel-in p-4 text-[12px]" style={{ color: 'var(--muted)' }}>
              {loading ? 'Building mixes...' : 'No playable mixes yet. Scan music or play a track first.'}
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-auto">
          {selected ? (
            <TrackTable
              tracks={selected.tracks}
              currentId={current?.id ?? null}
              onPlay={(index) => void playQueue(selected.tracks, index)}
              onPlayTracks={(tracks) => void playQueue(tracks, 0)}
              onPlayNext={queueTrackNext}
              onAddToQueue={addTrackToQueue}
              onPlayNextTracks={queueTracksNext}
              onAddTracksToQueue={addTracksToQueue}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
              Mix tracks will appear here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function uniqueMixes(mixes: GeneratedMix[]): GeneratedMix[] {
  return mixes.map((mix) => {
    const seen = new Set<number>();
    return {
      ...mix,
      tracks: mix.tracks.filter((track) => {
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
      }),
    };
  });
}
