import { useEffect, useState } from 'react';
import type { Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';

export function LovedView(): JSX.Element {
  const [tracks, setTracks] = useState<Track[]>([]);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const current = usePlayerStore((s) => s.current);

  useEffect(() => {
    api
      .getTracks({ sort: 'loved', limit: 5000 })
      .then((rows) => setTracks(rows.filter((t) => t.loved)))
      .catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--line)' }}
      >
        <span style={{ color: 'var(--accent)' }}>★</span>
        <span className="text-[12px] font-semibold">Loved Tracks</span>
        <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
          {tracks.length} tracks
        </span>
        <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)} disabled={!tracks.length}>
          ▶ Play all
        </button>
        <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play loved tracks next">
          NEXT ALL
        </button>
        <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue loved tracks">
          QUEUE ALL
        </button>
        <PlaylistAppendPicker
          tracks={tracks}
          label="ADD LOVED TO PLAYLIST"
          disabled={!tracks.length}
        />
      </div>
      <div className="flex-1 overflow-auto">
        {tracks.length ? (
          <TrackTable
            tracks={tracks}
            currentId={current?.id ?? null}
            onPlay={(i) => void playQueue(tracks, i)}
            onPlayTracks={(selectedTracks) => void playQueue(selectedTracks, 0)}
            onPlayNext={queueTrackNext}
            onAddToQueue={addTrackToQueue}
            onPlayNextTracks={queueTracksNext}
            onAddTracksToQueue={addTracksToQueue}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Mark tracks with ☆ to find them here later.
          </div>
        )}
      </div>
    </div>
  );
}
