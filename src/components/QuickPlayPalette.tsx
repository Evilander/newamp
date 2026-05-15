import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AlbumSummary, ArtistSummary, SavedPlaylist, SmartPlaylistRule, Track } from '@shared/types';
import type { ViewMode } from '../store/usePlayerStore';
import { api } from '../lib/api';
import { formatDuration, formatTime } from '../lib/format';
import { usePlayerStore } from '../store/usePlayerStore';

const RESULT_LIMIT = 48;
const TRACK_LIMIT = 24;

type PaletteCommand = 'scan-library' | 'toggle-eq' | 'fullscreen-viz' | 'compact-deck';

type PaletteItem =
  | { kind: 'track'; id: string; title: string; subtitle: string; detail: string; track: Track }
  | { kind: 'playlist'; id: string; title: string; subtitle: string; detail: string; playlist: SavedPlaylist }
  | { kind: 'smart-rule'; id: string; title: string; subtitle: string; detail: string; rule: SmartPlaylistRule }
  | { kind: 'album'; id: string; title: string; subtitle: string; detail: string; album: AlbumSummary }
  | { kind: 'artist'; id: string; title: string; subtitle: string; detail: string; artist: ArtistSummary }
  | { kind: 'view'; id: string; title: string; subtitle: string; detail: string; view: ViewMode }
  | { kind: 'command'; id: string; title: string; subtitle: string; detail: string; command: PaletteCommand };

const VIEW_ITEMS: Array<{ view: ViewMode; title: string; subtitle: string }> = [
  { view: 'home', title: 'Home', subtitle: 'Continue, mixes, history, health, playlists' },
  { view: 'library', title: 'Library', subtitle: 'Full catalog and power search' },
  { view: 'mixes', title: 'Mixes', subtitle: 'Generated sets from the local library' },
  { view: 'folders', title: 'Folders', subtitle: 'Browse by filesystem path' },
  { view: 'albums', title: 'Albums', subtitle: 'Album grid and album playback' },
  { view: 'artists', title: 'Artists', subtitle: 'Artist drill-in and facts' },
  { view: 'loved', title: 'Loved', subtitle: 'Loved tracks' },
  { view: 'history', title: 'History', subtitle: 'Listening history' },
  { view: 'playlist', title: 'Playlists', subtitle: 'Saved playlists, queue, smart sets, Auto DJ' },
  { view: 'now-playing', title: 'Now Playing', subtitle: 'Visualizer, lyrics, tabs, practice tools' },
  { view: 'podcasts', title: 'Podcasts', subtitle: 'Subscriptions, resume, downloads' },
  { view: 'radio', title: 'Radio', subtitle: 'Internet radio browser' },
  { view: 'settings', title: 'Settings', subtitle: 'Library roots, skins, audio, support' },
];

const COMMAND_ITEMS: Array<{ command: PaletteCommand; title: string; subtitle: string }> = [
  { command: 'scan-library', title: 'Scan Library', subtitle: 'Run a scan on configured music roots' },
  { command: 'toggle-eq', title: 'Toggle Equalizer', subtitle: 'Show or hide the 10-band EQ' },
  { command: 'fullscreen-viz', title: 'Fullscreen Visualizer', subtitle: 'Open the visualizer stage' },
  { command: 'compact-deck', title: 'Compact Deck', subtitle: 'Switch to windowshade deck mode' },
];

export function QuickPlayPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PaletteItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const setAutoDjEnabled = usePlayerStore((s) => s.setAutoDjEnabled);
  const setAutoDjSmartRuleId = usePlayerStore((s) => s.setAutoDjSmartRuleId);
  const setView = usePlayerStore((s) => s.setView);
  const toggleEq = usePlayerStore((s) => s.toggleEq);
  const setFullscreenViz = usePlayerStore((s) => s.setFullscreenViz);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const current = usePlayerStore((s) => s.current);
  const trimmedQuery = query.trim();
  const selected = results[selectedIndex] ?? null;

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === 'k' || key === 'j')) {
        event.preventDefault();
        setOpen((next) => !next);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('newamp-smoke') !== '1') return undefined;
    const target = window as unknown as {
      __newampSmoke?: {
        seek?: (seconds: number) => void;
        openQuickPlay?: () => void;
        setFullscreenVisualizer?: (on: boolean) => void;
      };
    };
    const previous = target.__newampSmoke;
    target.__newampSmoke = {
      ...previous,
      openQuickPlay: () => setOpen(true),
    };
    return () => {
      if (previous) target.__newampSmoke = previous;
      else delete target.__newampSmoke;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = window.setTimeout(async () => {
      setStatus(trimmedQuery ? 'Searching...' : 'Loading command palette...');
      try {
        const [tracks, playlists, smartRules, albums, artists] = await Promise.all([
          loadTrackResults(trimmedQuery),
          api.getPlaylists(),
          api.getSmartPlaylistRules(),
          trimmedQuery ? api.getAlbums() : Promise.resolve([]),
          trimmedQuery ? api.getArtists() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const next = buildPaletteItems(trimmedQuery, tracks, playlists, smartRules, albums, artists);
        setResults(next);
        setSelectedIndex(0);
        setStatus(next.length ? null : 'No matching commands or catalog items.');
      } catch {
        if (!cancelled) setStatus('Quick Play search failed.');
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [open, trimmedQuery]);

  const trackQueueContext = useMemo(
    () => results.filter((item): item is Extract<PaletteItem, { kind: 'track' }> => item.kind === 'track').map((item) => item.track),
    [results],
  );

  if (!open) return null;

  async function executeSelected(item = selected): Promise<void> {
    if (!item) return;
    if (item.kind === 'view') {
      setView(item.view);
      setOpen(false);
      return;
    }
    if (item.kind === 'command') {
      await runCommand(item.command);
      return;
    }
    if (item.kind === 'track') {
      const queueContext = trackQueueContext.length ? trackQueueContext : [item.track];
      const index = Math.max(0, queueContext.findIndex((candidate) => candidate.id === item.track.id));
      await playQueue(queueContext, index);
      setView('now-playing');
      setOpen(false);
      return;
    }
    const tracks = await playableTracksFor(item);
    if (!tracks.length) {
      setStatus(`No playable tracks for ${item.title}.`);
      return;
    }
    await playQueue(tracks, 0);
    setView('now-playing');
    setOpen(false);
  }

  async function playNext(item = selected): Promise<void> {
    if (!item) return;
    if (item.kind === 'track') {
      queueTrackNext(item.track);
      setStatus(`Will play next: ${item.track.title}`);
      return;
    }
    const tracks = await playableTracksFor(item);
    if (!tracks.length) return;
    queueTracksNext(tracks);
    setStatus(`Will play next: ${item.title}`);
  }

  async function queue(item = selected): Promise<void> {
    if (!item) return;
    if (item.kind === 'track') {
      addTrackToQueue(item.track);
      setStatus(`Queued: ${item.track.title}`);
      return;
    }
    const tracks = await playableTracksFor(item);
    if (!tracks.length) return;
    addTracksToQueue(tracks);
    setStatus(`Queued: ${item.title}`);
  }

  async function startSmartRuleRadio(item = selected): Promise<void> {
    if (!item || item.kind !== 'smart-rule') return;
    const tracks = await api.runSmartPlaylistRule(item.rule.id);
    if (!tracks.length) {
      setStatus(`No playable tracks for ${item.title}.`);
      return;
    }
    await playQueue(tracks, 0);
    await setAutoDjSmartRuleId(item.rule.id);
    await setAutoDjEnabled(true);
    setView('now-playing');
    setOpen(false);
  }

  async function toggleLove(item = selected): Promise<void> {
    if (!item || item.kind !== 'track') return;
    const loved = await api.toggleLove(item.track.id);
    setResults((next) => next.map((candidate) => (
      candidate.kind === 'track' && candidate.track.id === item.track.id
        ? {
            ...candidate,
            track: { ...candidate.track, loved: loved ? 1 : 0 },
          }
        : candidate
    )));
    setStatus(`${loved ? 'Loved' : 'Unloved'}: ${item.track.title}`);
  }

  async function runCommand(command: PaletteCommand): Promise<void> {
    if (command === 'scan-library') {
      setStatus('Scanning configured library roots...');
      await api.scanLibrary();
      setStatus('Library scan started.');
    } else if (command === 'toggle-eq') {
      toggleEq();
      setStatus('Toggled equalizer.');
    } else if (command === 'fullscreen-viz') {
      setFullscreenViz(true);
      setOpen(false);
    } else if (command === 'compact-deck') {
      setCompactMode(true);
      setOpen(false);
    }
  }

  function onPaletteKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void executeSelected();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/55 px-4 pt-[10vh]"
      data-newamp-quick-play
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="bevel-out w-full max-w-[900px] overflow-hidden"
        style={{ background: 'var(--panel)', borderColor: 'var(--line)', boxShadow: '0 22px 70px rgba(0,0,0,0.55)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Quick Play"
        onKeyDown={onPaletteKeyDown}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
          <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--muted)' }}>
            Quick Play
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search tracks, albums, artists, playlists, views, or commands..."
            className="bevel-in lcd-text min-w-0 flex-1 px-3 py-2 text-[16px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          />
          <button className="pxbtn" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>

        <div className="flex items-center gap-2 border-b px-3 py-2 text-[11px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}>
          <span>Ctrl+K / Ctrl+J opens</span>
          <span>Enter runs</span>
          <span>Arrow keys move</span>
          {status && <span className="ml-auto" style={{ color: 'var(--accent)' }}>{status}</span>}
        </div>

        <div className="max-h-[56vh] overflow-auto">
          {results.map((item, index) => {
            const active = index === selectedIndex;
            const playing = item.kind === 'track' && current?.id === item.track.id;
            return (
              <div
                key={item.id}
                className="grid cursor-pointer grid-cols-[82px_minmax(0,1.5fr)_minmax(120px,0.8fr)_224px] items-center gap-2 border-b px-3 py-2 text-[12px]"
                data-newamp-quick-play-row
                data-newamp-palette-kind={item.kind}
                data-track-id={item.kind === 'track' ? item.track.id : undefined}
                style={{
                  borderColor: 'var(--line)',
                  background: active ? 'var(--panel-2)' : playing ? 'rgba(52,211,153,0.06)' : 'transparent',
                  color: playing ? 'var(--accent)' : 'var(--ink)',
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                onDoubleClick={() => void executeSelected(item)}
              >
                <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--muted)' }}>
                  {item.kind}
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold" title={item.title}>{item.title}</div>
                  <div className="truncate text-[10px]" style={{ color: 'var(--muted)' }} title={item.subtitle}>
                    {item.subtitle}
                  </div>
                </div>
                <div className="min-w-0 truncate text-right tabular-nums" style={{ color: 'var(--ink-2)' }} title={item.detail}>
                  {item.detail}
                </div>
                <div className="flex justify-end gap-1">
                  <button className="pxbtn px-1.5 py-[2px] text-[10px]" onClick={() => void executeSelected(item)} title="Run or play">
                    {item.kind === 'view' || item.kind === 'command' ? 'RUN' : 'PLAY'}
                  </button>
                  {isPlayableItem(item) && (
                    <>
                      <button className="pxbtn px-1.5 py-[2px] text-[10px]" onClick={() => void playNext(item)} title="Play next">
                        NEXT
                      </button>
                      <button className="pxbtn px-1.5 py-[2px] text-[10px]" onClick={() => void queue(item)} title="Add to queue">
                        +
                      </button>
                    </>
                  )}
                  {item.kind === 'smart-rule' && (
                    <button className="pxbtn is-active px-1.5 py-[2px] text-[10px]" onClick={() => void startSmartRuleRadio(item)} title="Start Smart Rule Radio">
                      RADIO
                    </button>
                  )}
                  {item.kind === 'track' && (
                    <button
                      className={`pxbtn px-1.5 py-[2px] text-[10px] ${item.track.loved ? 'is-active' : ''}`}
                      onClick={() => void toggleLove(item)}
                      title="Love"
                    >
                      {item.track.loved ? 'ON' : 'LOVE'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!results.length && (
            <div className="px-4 py-10 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
              Type to search the catalog or run an app command.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

async function loadTrackResults(query: string): Promise<Track[]> {
  const first = await api.getTracks({
    search: query || undefined,
    sort: query ? 'artist' : 'recent',
    limit: TRACK_LIMIT,
    offset: 0,
  });
  if (first.length || query) return first;
  return api.getTracks({ sort: 'artist', limit: TRACK_LIMIT, offset: 0 });
}

function buildPaletteItems(
  query: string,
  tracks: Track[],
  playlists: SavedPlaylist[],
  smartRules: SmartPlaylistRule[],
  albums: AlbumSummary[],
  artists: ArtistSummary[],
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const item of viewItems(query)) items.push(item);
  for (const item of commandItems(query)) items.push(item);
  for (const playlist of filteredPlaylists(playlists, query)) items.push(playlistItem(playlist));
  for (const rule of filteredSmartRules(smartRules, query)) items.push(smartRuleItem(rule));
  for (const album of filteredAlbums(albums, query)) items.push(albumItem(album));
  for (const artist of filteredArtists(artists, query)) items.push(artistItem(artist));
  for (const track of tracks) items.push(trackItem(track));
  return items.slice(0, RESULT_LIMIT);
}

function viewItems(query: string): PaletteItem[] {
  return VIEW_ITEMS
    .filter((item) => matches(query, item.title, item.subtitle, item.view))
    .map((item) => ({
      kind: 'view',
      id: `view:${item.view}`,
      title: item.title,
      subtitle: item.subtitle,
      detail: 'open view',
      view: item.view,
    }));
}

function commandItems(query: string): PaletteItem[] {
  return COMMAND_ITEMS
    .filter((item) => matches(query, item.title, item.subtitle, item.command))
    .map((item) => ({
      kind: 'command',
      id: `command:${item.command}`,
      title: item.title,
      subtitle: item.subtitle,
      detail: 'app command',
      command: item.command,
    }));
}

function filteredPlaylists(playlists: SavedPlaylist[], query: string): SavedPlaylist[] {
  return playlists
    .filter((playlist) => matches(query, playlist.name, 'playlist'))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    .slice(0, query ? 8 : 6);
}

function filteredSmartRules(rules: SmartPlaylistRule[], query: string): SmartPlaylistRule[] {
  return rules
    .filter((rule) => matches(
      query,
      rule.name,
      'smart playlist',
      'smart rule',
      rule.mood,
      rule.genreQuery ?? '',
      rule.searchQuery ?? '',
      rule.lovedOnly ? 'loved' : '',
      rule.unplayedOnly ? 'fresh unplayed' : '',
      rule.minRating ? `${rule.minRating} stars` : '',
    ))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    .slice(0, query ? 8 : 6);
}

function filteredAlbums(albums: AlbumSummary[], query: string): AlbumSummary[] {
  return albums
    .filter((album) => matches(query, album.album, album.albumArtist, String(album.year ?? ''), 'album'))
    .slice(0, 8);
}

function filteredArtists(artists: ArtistSummary[], query: string): ArtistSummary[] {
  return artists
    .filter((artist) => matches(query, artist.artist, 'artist'))
    .slice(0, 8);
}

function trackItem(track: Track): PaletteItem {
  return {
    kind: 'track',
    id: `track:${track.id}`,
    title: track.title,
    subtitle: `${track.artist || 'Unknown Artist'} / ${track.album || 'Unknown Album'}`,
    detail: formatTime(track.duration ?? 0),
    track,
  };
}

function playlistItem(playlist: SavedPlaylist): PaletteItem {
  return {
    kind: 'playlist',
    id: `playlist:${playlist.id}`,
    title: playlist.name,
    subtitle: `${playlist.trackCount.toLocaleString()} tracks`,
    detail: formatDuration(playlist.duration),
    playlist,
  };
}

function smartRuleItem(rule: SmartPlaylistRule): PaletteItem {
  return {
    kind: 'smart-rule',
    id: `smart-rule:${rule.id}`,
    title: rule.name,
    subtitle: smartRuleSubtitle(rule),
    detail: `${rule.count.toLocaleString()} dynamic`,
    rule,
  };
}

function albumItem(album: AlbumSummary): PaletteItem {
  return {
    kind: 'album',
    id: `album:${album.albumArtist}:${album.album}`,
    title: album.album,
    subtitle: album.albumArtist,
    detail: `${album.trackCount.toLocaleString()} tracks`,
    album,
  };
}

function artistItem(artist: ArtistSummary): PaletteItem {
  return {
    kind: 'artist',
    id: `artist:${artist.artist}`,
    title: artist.artist,
    subtitle: `${artist.albumCount.toLocaleString()} albums`,
    detail: `${artist.trackCount.toLocaleString()} tracks`,
    artist,
  };
}

function isPlayableItem(item: PaletteItem): boolean {
  return item.kind === 'track' || item.kind === 'playlist' || item.kind === 'smart-rule' || item.kind === 'album' || item.kind === 'artist';
}

async function playableTracksFor(item: PaletteItem): Promise<Track[]> {
  if (item.kind === 'track') return [item.track];
  if (item.kind === 'playlist') return api.getPlaylistTracks(item.playlist.id);
  if (item.kind === 'smart-rule') return api.runSmartPlaylistRule(item.rule.id);
  if (item.kind === 'album') return api.getAlbumTracks(item.album.album, item.album.albumArtist);
  if (item.kind === 'artist') return api.getArtistTracks(item.artist.artist);
  return [];
}

function smartRuleSubtitle(rule: SmartPlaylistRule): string {
  const parts = [smartMoodLabel(rule.mood)];
  if (rule.genreQuery) parts.push(rule.genreQuery);
  if (rule.searchQuery) parts.push(rule.searchQuery);
  if (rule.minYear || rule.maxYear) parts.push(`${rule.minYear ?? 'any'}-${rule.maxYear ?? 'any'}`);
  if (rule.minBpm || rule.maxBpm) parts.push(`${rule.minBpm ?? 'any'}-${rule.maxBpm ?? 'any'} BPM`);
  if (rule.minRating) parts.push(`${rule.minRating}+ stars`);
  if (rule.lovedOnly) parts.push('loved');
  if (rule.unplayedOnly) parts.push('fresh');
  return parts.join(' / ');
}

function smartMoodLabel(mood: SmartPlaylistRule['mood']): string {
  if (mood === 'deep-cuts') return 'deep cuts';
  return mood;
}

function matches(query: string, ...values: string[]): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(needle));
}
