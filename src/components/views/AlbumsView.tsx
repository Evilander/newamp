import { useEffect, useState } from 'react';
import type { AlbumArtLookupResult, AlbumSummary, Track } from '@shared/types';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../lib/format';
import { PlaylistAppendPicker, TrackTable } from './LibraryView';
import { api } from '../../lib/api';

export function AlbumsView(): JSX.Element {
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [selected, setSelected] = useState<AlbumSummary | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const current = usePlayerStore((s) => s.current);
  const [filter, setFilter] = useState('');
  const [showMissingArtOnly, setShowMissingArtOnly] = useState(false);
  const [artCandidate, setArtCandidate] = useState<AlbumArtLookupResult | null>(null);
  const [artStatus, setArtStatus] = useState<string | null>(null);

  useEffect(() => {
    api.getAlbums().then(setAlbums).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setArtCandidate(null);
    setArtStatus(null);
    api
      .getAlbumTracks(selected.album, selected.albumArtist)
      .then(setTracks)
      .catch(() => undefined);
  }, [selected?.album, selected?.albumArtist]);

  async function findAlbumCover(): Promise<void> {
    if (!selected) return;
    setArtCandidate(null);
    setArtStatus('Searching MusicBrainz...');
    try {
      const candidates = await api.lookupAlbumArt({
        album: selected.album,
        albumArtist: selected.albumArtist,
      });
      const next = candidates[0] ?? null;
      setArtCandidate(next);
      setArtStatus(next ? `Found ${next.releaseGroupTitle}${next.artist ? ` by ${next.artist}` : ''}.` : 'No cover found.');
    } catch (err) {
      setArtStatus(err instanceof Error ? err.message : 'Cover lookup failed.');
    }
  }

  async function applyAlbumCover(): Promise<void> {
    if (!selected || !artCandidate) return;
    setArtStatus('Applying cover...');
    try {
      const result = await api.applyAlbumArt({
        album: selected.album,
        albumArtist: selected.albumArtist,
      }, artCandidate);
      if (!result) {
        setArtStatus('Cover could not be applied.');
        return;
      }
      const nextAlbums = await api.getAlbums();
      setAlbums(nextAlbums);
      const updated = nextAlbums.find((album) => albumKey(album) === albumKey(selected)) ?? selected;
      setSelected(updated);
      setTracks(await api.getAlbumTracks(updated.album, updated.albumArtist));
      setArtCandidate(null);
      setArtStatus(`Applied cover to ${result.appliedTrackCount.toLocaleString()} track(s).`);
    } catch (err) {
      setArtStatus(err instanceof Error ? err.message : 'Cover apply failed.');
    }
  }

  const missingArtAlbums = albums.filter((album) => !album.artFromTrackId);

  function openNextMissingCover(): void {
    const next =
      missingArtAlbums.find((album) => !selected || albumKey(album) !== albumKey(selected)) ??
      missingArtAlbums[0] ??
      null;
    if (next) setSelected(next);
  }

  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div
          className="flex items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--line)' }}
        >
          <button className="pxbtn" onClick={() => setSelected(null)}>
            ← All albums
          </button>
          <AlbumArt album={selected} />
          <div className="flex-1">
            <div className="text-lg font-semibold">{selected.album}</div>
            <div className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
              {selected.albumArtist}
              {selected.year ? `  ·  ${selected.year}` : ''}
              {`  ·  ${selected.trackCount} tracks  ·  ${formatDuration(selected.duration)}`}
            </div>
          </div>
          <button className="pxbtn is-active" onClick={() => void playQueue(tracks, 0)}>
            ▶ Play album
          </button>
          <button className="pxbtn" onClick={() => queueTracksNext(tracks)} disabled={!tracks.length} title="Play album next">
            PLAY NEXT
          </button>
          <button className="pxbtn" onClick={() => addTracksToQueue(tracks)} disabled={!tracks.length} title="Queue album">
            QUEUE ALBUM
          </button>
          <button className="pxbtn" onClick={() => void findAlbumCover()} disabled={!selected.album}>
            FIND COVER
          </button>
          <button
            className="pxbtn"
            onClick={openNextMissingCover}
            disabled={!missingArtAlbums.length}
            title="Open the next album that still needs cover art"
          >
            REVIEW COVER
          </button>
          <PlaylistAppendPicker
            tracks={tracks}
            label="ADD ALBUM TO PLAYLIST"
            disabled={!tracks.length}
          />
        </div>
        {(artCandidate || artStatus) && (
          <div className="flex items-center gap-3 border-b px-4 py-2" style={{ borderColor: 'var(--line)' }}>
            {artCandidate?.thumbnailUrl && (
              <img
                src={artCandidate.thumbnailUrl}
                alt={artCandidate.releaseGroupTitle}
                width={52}
                height={52}
                className="object-cover"
                style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
              />
            )}
            <div className="min-w-0 flex-1 text-[12px]" style={{ color: 'var(--ink-2)' }}>
              <div className="truncate">{artStatus}</div>
              {artCandidate && (
                <div className="truncate" style={{ color: 'var(--muted)' }}>
                  Cover Art Archive / score {artCandidate.score}
                  {artCandidate.firstReleaseDate ? ` / ${artCandidate.firstReleaseDate}` : ''}
                </div>
              )}
            </div>
            {artCandidate && (
              <button className="pxbtn is-active" onClick={() => void applyAlbumCover()}>
                APPLY COVER
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-auto">
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
        </div>
      </div>
    );
  }

  const visibleAlbums = showMissingArtOnly ? missingArtAlbums : albums;
  const filtered = filter
    ? visibleAlbums.filter(
        (a) =>
          a.album.toLowerCase().includes(filter.toLowerCase()) ||
          a.albumArtist.toLowerCase().includes(filter.toLowerCase()),
      )
    : visibleAlbums;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <button
          className={`pxbtn ${showMissingArtOnly ? 'is-active' : ''}`}
          onClick={() => setShowMissingArtOnly((value) => !value)}
          title="Show albums that still need cover art"
        >
          MISSING ART
        </button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter albums…"
          className="bevel-in lcd-text flex-1 px-3 py-1.5 text-[14px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <button
          className="pxbtn"
          onClick={openNextMissingCover}
          disabled={!missingArtAlbums.length}
          title="Open the next album that still needs cover art"
        >
          REVIEW COVER
        </button>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {filtered.length.toLocaleString()} albums / {missingArtAlbums.length.toLocaleString()} missing art
        </span>
      </div>
      {showMissingArtOnly && (
        <div className="border-b px-4 py-2 text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}>
          Missing Art Review uses the same reviewed Cover Art Archive apply flow as album detail: open an album, find a cover, approve it, then jump to the next missing cover.
        </div>
      )}
      <div className="flex-1 overflow-auto p-4">
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}
        >
          {filtered.map((a) => (
            <button
              key={`${a.album}::${a.albumArtist}`}
              onClick={() => setSelected(a)}
              className="group flex flex-col gap-1 text-left"
            >
              <AlbumArt album={a} size={168} />
              <div className="truncate pt-1 text-[13px] font-semibold">{a.album}</div>
              <div className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }}>
                {a.albumArtist}
                {a.year ? `  ·  ${a.year}` : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function albumKey(album: AlbumSummary): string {
  return `${album.album}::${album.albumArtist}`;
}

function AlbumArt({ album, size = 64 }: { album: AlbumSummary; size?: number }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (album.artFromTrackId && !failed) {
    return (
      <div
        className="album-art-tile relative overflow-hidden"
        style={{ width: size, height: size, borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
      >
        <div className="album-art-placeholder flex h-full w-full items-center justify-center">
          <span>{album.album.slice(0, 2).toUpperCase() || 'LP'}</span>
        </div>
        <img
          src={api.getArtUrl(album.artFromTrackId)}
          alt={album.album}
          width={size}
          height={size}
          className="relative h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
          style={{ zIndex: 1 }}
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  return (
    <div
      className="album-art-tile album-art-placeholder flex items-center justify-center text-[22px]"
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      ♫
    </div>
  );
}
