import { useEffect, useMemo, useState } from 'react';
import type {
  SavedPlaylist,
  SmartPlaylistMood,
  SmartPlaylistRule,
  SmartPlaylistRuleInput,
  Track,
} from '@shared/types';
import { moveQueueItem, removeQueueItem } from '@shared/queue-edit';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatTime } from '../../lib/format';
import { api } from '../../lib/api';

type SetMood = SmartPlaylistMood;

export function PlaylistView(): JSX.Element {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const loadQueue = usePlayerStore((s) => s.loadQueue);
  const moveQueuedTrack = usePlayerStore((s) => s.moveQueuedTrack);
  const removeQueuedTrack = usePlayerStore((s) => s.removeQueuedTrack);
  const clearQueue = usePlayerStore((s) => s.clearQueue);
  const autoDjEnabled = usePlayerStore((s) => s.autoDjEnabled);
  const autoDjTarget = usePlayerStore((s) => s.autoDjTarget);
  const autoDjSmartRuleId = usePlayerStore((s) => s.autoDjSmartRuleId);
  const setAutoDjEnabled = usePlayerStore((s) => s.setAutoDjEnabled);
  const setAutoDjTarget = usePlayerStore((s) => s.setAutoDjTarget);
  const setAutoDjSmartRuleId = usePlayerStore((s) => s.setAutoDjSmartRuleId);
  const refillAutoDjQueue = usePlayerStore((s) => s.refillAutoDjQueue);
  const stopAfterCurrent = usePlayerStore((s) => s.stopAfterCurrent);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const setStopAfterCurrent = usePlayerStore((s) => s.setStopAfterCurrent);
  const setSleepTimerMinutes = usePlayerStore((s) => s.setSleepTimerMinutes);
  const clearSleepTimer = usePlayerStore((s) => s.clearSleepTimer);
  const current = usePlayerStore((s) => s.current);
  const [mood, setMood] = useState<SetMood>('focus');
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SavedPlaylist | null>(null);
  const [selectedPlaylistTracks, setSelectedPlaylistTracks] = useState<Track[]>([]);
  const [playlistListFilter, setPlaylistListFilter] = useState('');
  const [playlistTrackFilter, setPlaylistTrackFilter] = useState('');
  const [smartRules, setSmartRules] = useState<SmartPlaylistRule[]>([]);
  const [selectedSmartRule, setSelectedSmartRule] = useState<SmartPlaylistRule | null>(null);
  const [playlistName, setPlaylistName] = useState('Newamp Set');
  const [playlistCoverPath, setPlaylistCoverPath] = useState<string | null>(null);
  const [clearPlaylistCover, setClearPlaylistCover] = useState(false);
  const [smartCount, setSmartCount] = useState(30);
  const [genreQuery, setGenreQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [minYear, setMinYear] = useState('');
  const [maxYear, setMaxYear] = useState('');
  const [minBpm, setMinBpm] = useState('');
  const [maxBpm, setMaxBpm] = useState('');
  const [minRating, setMinRating] = useState('');
  const [lovedOnly, setLovedOnly] = useState(false);
  const [unplayedOnly, setUnplayedOnly] = useState(false);
  const [timerNow, setTimerNow] = useState(Date.now());
  const [draggedQueueIndex, setDraggedQueueIndex] = useState<number | null>(null);
  const [draggedPlaylistTrackIndex, setDraggedPlaylistTrackIndex] = useState<number | null>(null);
  const autoDjSourceMissing =
    autoDjSmartRuleId !== null && !smartRules.some((rule) => rule.id === autoDjSmartRuleId);
  const filteredPlaylists = useMemo(
    () =>
      playlists.filter((playlist) =>
        playlistTextMatches(playlistListFilter, [playlist.name, String(playlist.trackCount)]),
      ),
    [playlistListFilter, playlists],
  );
  const visibleSelectedPlaylistTracks = useMemo(
    () =>
      selectedPlaylistTracks
        .map((track, index) => ({ track, index }))
        .filter(({ track, index }) =>
          playlistTextMatches(playlistTrackFilter, [
            String(index + 1),
            track.title,
            track.artist,
            track.album,
            track.albumArtist,
            track.genre ?? '',
            track.year == null ? '' : String(track.year),
          ]),
        ),
    [playlistTrackFilter, selectedPlaylistTracks],
  );

  useEffect(() => {
    void refreshPlaylists();
  }, []);

  useEffect(() => {
    if (!sleepTimerEndsAt) return;
    const timer = window.setInterval(() => setTimerNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sleepTimerEndsAt]);

  async function refreshPlaylists(): Promise<void> {
    const [next, nextRules] = await Promise.all([
      api.getPlaylists().catch(() => []),
      api.getSmartPlaylistRules().catch(() => []),
    ]);
    setPlaylists(next);
    setSmartRules(nextRules);
    setSelectedPlaylist((selected) =>
      selected ? next.find((playlist) => playlist.id === selected.id) ?? null : null,
    );
    setSelectedSmartRule((selected) =>
      selected ? nextRules.find((rule) => rule.id === selected.id) ?? null : null,
    );
  }

  async function buildSet(): Promise<void> {
    setBuilding(true);
    setStatus(null);
    try {
      const picked = await api.runSmartPlaylistRule(readSmartDraft());
      if (!picked.length) {
        setStatus('No tracks available yet.');
        return;
      }
      setStatus(`Built ${picked.length} track ${moodLabel(mood)} set.`);
      loadQueue(picked);
    } finally {
      setBuilding(false);
    }
  }

  async function buildHarmonicMix(): Promise<void> {
    setBuilding(true);
    setStatus(null);
    try {
      const picked = await api.buildHarmonicMix({
        seedTrackId: current?.id ?? null,
        count: smartCount,
        genreQuery: genreQuery.trim() || null,
      });
      if (!picked.length) {
        setStatus('No harmonic mix candidates available yet.');
        return;
      }
      loadQueue(picked);
      setStatus(
        `Built ${picked.length} track harmonic mix${current ? ` from ${current.title}` : ''}.`,
      );
    } finally {
      setBuilding(false);
    }
  }

  async function fillAutoDjNow(): Promise<void> {
    setBuilding(true);
    setStatus(null);
    try {
      const wasEmpty = queue.length === 0;
      const added = await refillAutoDjQueue(true);
      if (wasEmpty && added.length) await playQueue(added, 0);
      setStatus(added.length ? `Auto DJ added ${added.length} tracks.` : 'Auto DJ found no new candidates.');
    } finally {
      setBuilding(false);
    }
  }

  async function saveSmartRule(): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const saved = await api.saveSmartPlaylistRule({
        ...readSmartDraft(),
        id: selectedSmartRule?.id,
      });
      setSelectedSmartRule(saved);
      applySmartRuleToDraft(saved);
      setStatus(`Saved smart rule ${saved.name}.`);
      await refreshPlaylists();
    } finally {
      setBusy(false);
    }
  }

  async function loadSmartRule(rule: SmartPlaylistRule, play = false): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const tracks = await api.runSmartPlaylistRule(rule.id);
      setSelectedSmartRule(rule);
      applySmartRuleToDraft(rule);
      if (play && tracks.length) await playQueue(tracks, 0);
      else loadQueue(tracks);
      setStatus(`Generated ${tracks.length} tracks from ${rule.name}.`);
    } finally {
      setBusy(false);
    }
  }

  async function startSmartRuleRadio(rule = selectedSmartRule): Promise<void> {
    if (!rule) return;
    setBusy(true);
    setStatus(null);
    try {
      const tracks = await api.runSmartPlaylistRule(rule.id);
      setSelectedSmartRule(rule);
      applySmartRuleToDraft(rule);
      if (!tracks.length) {
        setStatus(`${rule.name} generated no playable tracks.`);
        return;
      }
      await playQueue(tracks, 0);
      await setAutoDjSmartRuleId(rule.id);
      await setAutoDjEnabled(true);
      setStatus(`Smart Rule Radio started from ${rule.name}.`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSmartRule(): Promise<void> {
    if (!selectedSmartRule) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.deleteSmartPlaylistRule(selectedSmartRule.id);
      if (selectedSmartRule.id === autoDjSmartRuleId) await setAutoDjSmartRuleId(null);
      setStatus(`Deleted smart rule ${selectedSmartRule.name}.`);
      setSelectedSmartRule(null);
      await refreshPlaylists();
    } finally {
      setBusy(false);
    }
  }

  function readSmartDraft(): SmartPlaylistRuleInput {
    return {
      name: playlistName,
      mood,
      count: smartCount,
      genreQuery: genreQuery.trim() || null,
      searchQuery: searchQuery.trim() || null,
      minYear: parseOptionalNumber(minYear),
      maxYear: parseOptionalNumber(maxYear),
      minBpm: parseOptionalNumber(minBpm),
      maxBpm: parseOptionalNumber(maxBpm),
      minRating: parseOptionalNumber(minRating),
      lovedOnly,
      unplayedOnly,
    };
  }

  function applySmartRuleToDraft(rule: SmartPlaylistRule): void {
    setPlaylistName(rule.name);
    setMood(rule.mood);
    setSmartCount(rule.count);
    setGenreQuery(rule.genreQuery ?? '');
    setSearchQuery(rule.searchQuery ?? '');
    setMinYear(rule.minYear == null ? '' : String(rule.minYear));
    setMaxYear(rule.maxYear == null ? '' : String(rule.maxYear));
    setMinBpm(rule.minBpm == null ? '' : String(rule.minBpm));
    setMaxBpm(rule.maxBpm == null ? '' : String(rule.maxBpm));
    setMinRating(rule.minRating == null ? '' : String(rule.minRating));
    setLovedOnly(rule.lovedOnly);
    setUnplayedOnly(rule.unplayedOnly);
  }

  async function saveQueue(): Promise<void> {
    if (!playlistName.trim()) {
      setStatus('Name the playlist first.');
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const wasNew = !selectedPlaylist;
      const trackIds = selectedPlaylist
        ? selectedPlaylistTracks.map((track) => track.id)
        : queue.map((track) => track.id);
      const saved = await api.savePlaylist({
        id: selectedPlaylist?.id,
        name: playlistName,
        trackIds,
        coverImagePath: playlistCoverPath,
        clearCoverImage: clearPlaylistCover,
      });
      setSelectedPlaylist(saved);
      if (wasNew) setSelectedPlaylistTracks(queue);
      setPlaylistName(saved.name);
      setPlaylistCoverPath(null);
      setClearPlaylistCover(false);
      setStatus(`${wasNew ? 'Created' : 'Updated'} ${saved.name} with ${saved.trackCount} tracks.`);
      await refreshPlaylists();
    } finally {
      setBusy(false);
    }
  }

  async function loadPlaylist(playlist: SavedPlaylist, play = false): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const tracks = await api.getPlaylistTracks(playlist.id);
      setSelectedPlaylist(playlist);
      setSelectedPlaylistTracks(tracks);
      setPlaylistTrackFilter('');
      setPlaylistName(playlist.name);
      setPlaylistCoverPath(null);
      setClearPlaylistCover(false);
      if (play && tracks.length) {
        await playQueue(tracks, 0);
      } else {
        setStatus(`Selected ${playlist.name} with ${tracks.length} tracks. Queue unchanged.`);
        return;
      }
      setStatus(`Playing ${tracks.length} tracks from ${playlist.name}.`);
    } finally {
      setBusy(false);
    }
  }

  async function playSelectedPlaylist(): Promise<void> {
    if (!selectedPlaylist || !selectedPlaylistTracks.length) return;
    await playQueue(selectedPlaylistTracks, 0);
    setStatus(`Playing ${selectedPlaylist.name}.`);
  }

  function loadSelectedPlaylistToQueue(): void {
    if (!selectedPlaylist || !selectedPlaylistTracks.length) return;
    loadQueue(selectedPlaylistTracks);
    setStatus(`Loaded ${selectedPlaylist.name} into the active queue.`);
  }

  function moveSelectedPlaylistTrack(fromIndex: number, toIndex: number): void {
    const result = moveQueueItem(selectedPlaylistTracks, -1, fromIndex, toIndex);
    setSelectedPlaylistTracks(result.queue);
  }

  function removeSelectedPlaylistTrack(index: number): void {
    const result = removeQueueItem(selectedPlaylistTracks, -1, index);
    setSelectedPlaylistTracks(result.queue);
  }

  async function deleteSelected(): Promise<void> {
    if (!selectedPlaylist) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.deletePlaylist(selectedPlaylist.id);
      setStatus(`Deleted ${selectedPlaylist.name}.`);
      setSelectedPlaylist(null);
      setSelectedPlaylistTracks([]);
      setPlaylistTrackFilter('');
      setPlaylistCoverPath(null);
      setClearPlaylistCover(false);
      await refreshPlaylists();
    } finally {
      setBusy(false);
    }
  }

  async function exportSelected(): Promise<void> {
    if (!selectedPlaylist) return;
    setBusy(true);
    setStatus(null);
    try {
      const filePath = await api.exportPlaylistM3u(selectedPlaylist.id);
      setStatus(filePath ? `Exported ${selectedPlaylist.name} as M3U.` : 'Export canceled.');
    } finally {
      setBusy(false);
    }
  }

  async function exportSelectedPls(): Promise<void> {
    if (!selectedPlaylist) return;
    setBusy(true);
    setStatus(null);
    try {
      const filePath = await api.exportPlaylistPls(selectedPlaylist.id);
      setStatus(filePath ? `Exported ${selectedPlaylist.name} as PLS.` : 'Export canceled.');
    } finally {
      setBusy(false);
    }
  }

  async function importM3u(): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.importPlaylistM3u();
      if (!result) {
        setStatus('Import canceled.');
        return;
      }
      const tracks = await api.getPlaylistTracks(result.playlist.id).catch(() => []);
      setSelectedPlaylist(result.playlist);
      setSelectedPlaylistTracks(tracks);
      setPlaylistTrackFilter('');
      setPlaylistName(result.playlist.name);
      setPlaylistCoverPath(null);
      setClearPlaylistCover(false);
      setStatus(
        `Imported ${result.playlist.name}: ${result.matched} matched, ${result.skipped} skipped.`,
      );
      await refreshPlaylists();
    } finally {
      setBusy(false);
    }
  }

  async function pickPlaylistIcon(): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const path = await api.pickPlaylistCoverImage();
      if (!path) {
        setStatus('Playlist icon selection canceled.');
        return;
      }
      setPlaylistCoverPath(path);
      setClearPlaylistCover(false);
      setStatus('Playlist icon selected. Create or update the playlist to apply it.');
    } finally {
      setBusy(false);
    }
  }

  function clearPlaylistIcon(): void {
    setPlaylistCoverPath(null);
    setClearPlaylistCover(true);
    setStatus('Playlist icon will be cleared on save.');
  }

  function startNewPlaylist(): void {
    setSelectedPlaylist(null);
    setSelectedPlaylistTracks([]);
    setPlaylistTrackFilter('');
    setPlaylistName('Newamp Set');
    setPlaylistCoverPath(null);
    setClearPlaylistCover(false);
    setStatus('Ready to create a new playlist.');
  }

  const playlistIconSrc = playlistCoverPath
    ? filePathToImageUrl(playlistCoverPath)
    : selectedPlaylist?.hasCoverArt
      ? api.getPlaylistCoverUrl(selectedPlaylist.id, selectedPlaylist.coverArtUpdatedAt)
      : null;
  const sleepRemaining = sleepTimerEndsAt ? formatSleepRemaining(sleepTimerEndsAt, timerNow) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <span style={{ color: 'var(--accent)' }}>PL</span>
        <span className="text-[12px] font-semibold">Playlists</span>
        <span className="text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--muted)' }}>
          Queue + saved sets
        </span>
        <select
          value={mood}
          onChange={(e) => setMood(e.target.value as SetMood)}
          className="bevel-in ml-3 px-2 py-1 text-[11px]"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        >
          <option value="focus">Focus</option>
          <option value="drive">Drive</option>
          <option value="night">Night</option>
          <option value="deep-cuts">Deep cuts</option>
        </select>
        <button className="pxbtn is-active" onClick={() => void buildSet()} disabled={building || busy}>
          {building ? 'BUILDING' : 'SMART SET'}
        </button>
        <button className="pxbtn" onClick={() => void buildHarmonicMix()} disabled={building || busy}>
          HARMONIC MIX
        </button>
        <button
          className={`pxbtn ${autoDjEnabled ? 'is-active' : ''}`}
          onClick={() => void setAutoDjEnabled(!autoDjEnabled)}
          disabled={busy}
        >
          AUTO DJ
        </button>
        <input
          value={autoDjTarget}
          onChange={(e) => void setAutoDjTarget(parseInt(e.target.value, 10) || autoDjTarget)}
          type="number"
          min={6}
          max={80}
          className="bevel-in w-[58px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          aria-label="Auto DJ target queue length"
          title="Auto DJ target queue length"
        />
        <select
          value={autoDjSmartRuleId ?? ''}
          onChange={(e) => void setAutoDjSmartRuleId(e.target.value ? Number(e.target.value) : null)}
          className="bevel-in max-w-[180px] px-2 py-1 text-[11px]"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          aria-label="Auto DJ source"
          title="Auto DJ source"
        >
          <option value="">Harmonic Mix</option>
          {autoDjSourceMissing ? (
            <option value={autoDjSmartRuleId}>Missing Smart Rule #{autoDjSmartRuleId}</option>
          ) : null}
          {smartRules.map((rule) => (
            <option key={rule.id} value={rule.id}>
              {rule.name}
            </option>
          ))}
        </select>
        <button
          className="pxbtn"
          onClick={() => void fillAutoDjNow()}
          disabled={building || busy || !autoDjEnabled || (!queue.length && !autoDjSmartRuleId)}
        >
          FILL
        </button>
        <button
          className={`pxbtn ${stopAfterCurrent ? 'is-active' : ''}`}
          onClick={() => setStopAfterCurrent(!stopAfterCurrent)}
          disabled={!current}
        >
          STOP AFTER CURRENT
        </button>
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--ink-2)' }}>
            SLEEP
          </span>
          {[15, 30, 60].map((minutes) => (
            <button
              key={minutes}
              className="pxbtn px-1.5 py-[1px] text-[10px]"
              onClick={() => setSleepTimerMinutes(minutes)}
            >
              {minutes}
            </button>
          ))}
          <button className="pxbtn px-1.5 py-[1px] text-[10px]" onClick={clearSleepTimer} disabled={!sleepTimerEndsAt}>
            CLEAR
          </button>
          {sleepRemaining && (
            <span className="min-w-[38px] text-[10px] tabular-nums" style={{ color: 'var(--accent)' }}>
              {sleepRemaining}
            </span>
          )}
        </div>
        <input
          value={smartCount}
          onChange={(e) => setSmartCount(Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 1)))}
          type="number"
          min={1}
          max={200}
          className="bevel-in w-[58px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          aria-label="Smart set track count"
        />
        <input
          value={genreQuery}
          onChange={(e) => setGenreQuery(e.target.value)}
          placeholder="Genre filter"
          className="bevel-in w-[118px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder='Power search'
          className="bevel-in w-[142px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          title='Examples: artist:radiohead path:"Live" missing:art format:wma'
        />
        <input
          value={minYear}
          onChange={(e) => setMinYear(e.target.value)}
          placeholder="Min year"
          type="number"
          min={0}
          className="bevel-in w-[78px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <input
          value={maxYear}
          onChange={(e) => setMaxYear(e.target.value)}
          placeholder="Max year"
          type="number"
          min={0}
          className="bevel-in w-[78px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <input
          value={minBpm}
          onChange={(e) => setMinBpm(e.target.value)}
          placeholder="Min BPM"
          className="bevel-in w-[74px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <input
          value={maxBpm}
          onChange={(e) => setMaxBpm(e.target.value)}
          placeholder="Max BPM"
          className="bevel-in w-[74px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <input
          value={minRating}
          onChange={(e) => setMinRating(e.target.value)}
          placeholder="Min rating"
          type="number"
          min={0}
          max={5}
          className="bevel-in w-[86px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
        />
        <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--ink-2)' }}>
          <input type="checkbox" checked={lovedOnly} onChange={(e) => setLovedOnly(e.target.checked)} />
          Loved
        </label>
        <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--ink-2)' }}>
          <input type="checkbox" checked={unplayedOnly} onChange={(e) => setUnplayedOnly(e.target.checked)} />
          Fresh
        </label>
        <input
          value={playlistName}
          onChange={(e) => setPlaylistName(e.target.value)}
          className="bevel-in min-w-[180px] px-2 py-1 text-[11px] outline-none"
          style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          aria-label="Playlist name"
        />
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--ink-2)' }}>
            Playlist icon
          </span>
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden border text-[10px] font-bold"
            style={{ borderColor: 'var(--line)', background: 'var(--panel-2)', color: 'var(--muted)' }}
          >
            {playlistIconSrc && !clearPlaylistCover ? (
              <img src={playlistIconSrc} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              'PL'
            )}
          </div>
          <button className="pxbtn" onClick={() => void pickPlaylistIcon()} disabled={busy} title="Insert image">
            Insert image
          </button>
          <button className="pxbtn" onClick={clearPlaylistIcon} disabled={busy || (!playlistIconSrc && !selectedPlaylist?.hasCoverArt)}>
            CLEAR ICON
          </button>
        </div>
        <button className="pxbtn" onClick={() => void saveQueue()} disabled={busy || !playlistName.trim()}>
          {selectedPlaylist ? 'UPDATE PLAYLIST' : queue.length ? 'SAVE QUEUE AS PLAYLIST' : 'CREATE EMPTY PLAYLIST'}
        </button>
        <button className="pxbtn" onClick={startNewPlaylist} disabled={busy}>
          NEW PLAYLIST
        </button>
        <button className="pxbtn" onClick={clearQueue} disabled={busy || queue.length === 0}>
          CLEAR
        </button>
        <button className="pxbtn" onClick={() => void saveSmartRule()} disabled={busy}>
          SAVE SMART
        </button>
        <button className="pxbtn" onClick={() => void importM3u()} disabled={busy}>
          IMPORT M3U
        </button>
        {status && <span className="text-[11px]" style={{ color: 'var(--ink-2)' }}>{status}</span>}
        <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
          {selectedPlaylist
            ? `${selectedPlaylistTracks.length} playlist tracks - queue ${queue.length}`
            : `${queue.length} tracks${queue.length > 0 && index >= 0 ? ` - playing ${index + 1}` : ''}`}
        </span>
      </div>
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '286px 1fr' }}>
        <aside
          className="flex min-h-0 flex-col border-r"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          <div
            className="flex items-center justify-between border-b px-3 py-2 text-[10px] uppercase tracking-[0.1em]"
            style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
          >
            <span>Saved Playlists</span>
            <span>{filteredPlaylists.length}/{playlists.length}</span>
          </div>
          <div className="border-b p-2" style={{ borderColor: 'var(--line)' }}>
            <input
              value={playlistListFilter}
              onChange={(event) => setPlaylistListFilter(event.currentTarget.value)}
              placeholder="Filter playlists"
              className="bevel-in w-full px-2 py-1 text-[11px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
              aria-label="Filter playlists"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {playlists.length === 0 ? (
              <div className="px-3 py-4 text-[11px] leading-5" style={{ color: 'var(--muted)' }}>
                Create a named playlist, attach an icon, save the queue, or import an M3U/PLS file.
              </div>
            ) : filteredPlaylists.length === 0 ? (
              <div className="px-3 py-4 text-[11px] leading-5" style={{ color: 'var(--muted)' }}>
                No saved playlists match this filter.
              </div>
            ) : (
              filteredPlaylists.map((playlist) => (
                <button
                  key={playlist.id}
                  type="button"
                  onClick={() => void loadPlaylist(playlist)}
                  onDoubleClick={() => void loadPlaylist(playlist, true)}
                  className="grid w-full gap-2 border-b px-3 py-2 text-left transition-colors hover:bg-[var(--panel-2)]"
                  style={{
                    borderColor: 'var(--line)',
                    background: selectedPlaylist?.id === playlist.id ? 'var(--panel-2)' : 'transparent',
                    gridTemplateColumns: '34px minmax(0, 1fr)',
                  }}
                >
                  <span
                    className="flex h-[34px] w-[34px] items-center justify-center overflow-hidden border text-[10px] font-bold"
                    style={{ borderColor: 'var(--line)', background: 'var(--panel-2)', color: 'var(--muted)' }}
                  >
                    {playlist.hasCoverArt ? (
                      <img
                        src={api.getPlaylistCoverUrl(playlist.id, playlist.coverArtUpdatedAt)}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      'PL'
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px]" style={{ color: selectedPlaylist?.id === playlist.id ? 'var(--accent)' : 'var(--ink)' }}>
                      {playlist.name}
                    </span>
                    <span className="block text-[10px]" style={{ color: 'var(--muted)' }}>
                      {playlist.trackCount} tracks - {formatTime(playlist.duration)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div
            className="flex items-center justify-between border-y px-3 py-2 text-[10px] uppercase tracking-[0.1em]"
            style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
          >
            <span>Saved Smart Rules</span>
            <span>{smartRules.length}</span>
          </div>
          <div className="max-h-[220px] overflow-auto">
            {smartRules.length === 0 ? (
              <div className="px-3 py-4 text-[11px] leading-5" style={{ color: 'var(--muted)' }}>
                Save a Smart Set rule to regenerate dynamic queues from your library.
              </div>
            ) : (
              smartRules.map((rule) => (
                <button
                  key={rule.id}
                  type="button"
                  onClick={() => void loadSmartRule(rule)}
                  onDoubleClick={() => void loadSmartRule(rule, true)}
                  className="grid w-full gap-1 border-b px-3 py-2 text-left transition-colors hover:bg-[var(--panel-2)]"
                  style={{
                    borderColor: 'var(--line)',
                    background: selectedSmartRule?.id === rule.id ? 'var(--panel-2)' : 'transparent',
                  }}
                >
                  <span className="truncate text-[12px]" style={{ color: selectedSmartRule?.id === rule.id ? 'var(--accent)' : 'var(--ink)' }}>
                    {rule.name}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    {moodLabel(rule.mood)} - {rule.count} tracks{rule.genreQuery ? ` - ${rule.genreQuery}` : ''}
                    {rule.searchQuery ? ` - ${rule.searchQuery}` : ''}
                    {rule.minYear || rule.maxYear ? ` - ${rule.minYear ?? 'any'}-${rule.maxYear ?? 'any'}` : ''}
                    {rule.minRating ? ` - ${rule.minRating}+ stars` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 border-t p-2" style={{ borderColor: 'var(--line)' }}>
            <button
              className="pxbtn is-active"
              onClick={() => void playSelectedPlaylist()}
              disabled={busy || !selectedPlaylist || !selectedPlaylistTracks.length}
            >
              PLAY SELECTED
            </button>
            <button
              className="pxbtn"
              onClick={loadSelectedPlaylistToQueue}
              disabled={busy || !selectedPlaylist || !selectedPlaylistTracks.length}
            >
              LOAD TO QUEUE
            </button>
            <button className="pxbtn" onClick={() => void exportSelected()} disabled={busy || !selectedPlaylist}>
              EXPORT M3U
            </button>
            <button className="pxbtn" onClick={() => void exportSelectedPls()} disabled={busy || !selectedPlaylist}>
              EXPORT PLS
            </button>
            <button className="pxbtn" onClick={() => void deleteSelected()} disabled={busy || !selectedPlaylist}>
              DELETE
            </button>
            <button className="pxbtn col-span-2" onClick={() => void deleteSmartRule()} disabled={busy || !selectedSmartRule}>
              DELETE SMART
            </button>
            <button className="pxbtn is-active col-span-2" onClick={() => void startSmartRuleRadio()} disabled={busy || !selectedSmartRule}>
              START SMART RULE RADIO
            </button>
          </div>
        </aside>
        <div className="min-h-0 overflow-auto">
          {selectedPlaylist ? (
            selectedPlaylistTracks.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
                {selectedPlaylist.name} is empty. Add tracks from Library, Albums, Artists, or Loved.
              </div>
            ) : (
              <>
                <div
                  className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-[11px]"
                  style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink-2)' }}
                >
                  <input
                    value={playlistTrackFilter}
                    onChange={(event) => setPlaylistTrackFilter(event.currentTarget.value)}
                    placeholder="Filter playlist tracks"
                    className="bevel-in min-w-[220px] flex-1 px-2 py-1 text-[11px] outline-none"
                    style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
                    aria-label="Filter playlist tracks"
                  />
                  <span className="tabular-nums">
                    {visibleSelectedPlaylistTracks.length.toLocaleString()} of {selectedPlaylistTracks.length.toLocaleString()}
                  </span>
                </div>
                {visibleSelectedPlaylistTracks.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
                    No tracks in {selectedPlaylist.name} match this filter.
                  </div>
                ) : (
                  <ol className="m-0 list-none p-0" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {visibleSelectedPlaylistTracks.map(({ track: t, index: i }) => (
                      <li
                        key={`${selectedPlaylist.id}-${t.id}-${i}`}
                        className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5"
                        style={{
                          borderColor: 'var(--line)',
                          color: current?.id === t.id ? 'var(--accent)' : 'var(--ink)',
                          opacity: draggedPlaylistTrackIndex === i ? 0.55 : 1,
                        }}
                        draggable={true}
                        aria-grabbed={draggedPlaylistTrackIndex === i}
                        onDragStart={(event) => {
                          setDraggedPlaylistTrackIndex(i);
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', String(i));
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const transferIndex = Number(event.dataTransfer.getData('text/plain'));
                          const fromIndex = draggedPlaylistTrackIndex
                            ?? (Number.isInteger(transferIndex) ? transferIndex : null);
                          if (fromIndex !== null && fromIndex !== i) moveSelectedPlaylistTrack(fromIndex, i);
                          setDraggedPlaylistTrackIndex(null);
                        }}
                        onDragEnd={() => setDraggedPlaylistTrackIndex(null)}
                        onDoubleClick={() => void playQueue(selectedPlaylistTracks, i)}
                      >
                        <span className="w-[28px] shrink-0" style={{ color: 'var(--muted)' }}>
                          {(i + 1).toString().padStart(2, '0')}
                        </span>
                        <span className="flex-1 truncate">
                          {t.artist} - {t.title}
                        </span>
                        <span style={{ color: 'var(--muted)' }}>{formatTime(t.duration ?? 0)}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            className="pxbtn"
                            title="Move up"
                            onClick={(event) => {
                              event.stopPropagation();
                              moveSelectedPlaylistTrack(i, i - 1);
                            }}
                            disabled={i === 0}
                          >
                            UP
                          </button>
                          <button
                            className="pxbtn"
                            title="Move down"
                            onClick={(event) => {
                              event.stopPropagation();
                              moveSelectedPlaylistTrack(i, i + 1);
                            }}
                            disabled={i === selectedPlaylistTracks.length - 1}
                          >
                            DOWN
                          </button>
                          <button
                            className="pxbtn"
                            title="Remove from playlist"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeSelectedPlaylistTrack(i);
                            }}
                          >
                            X
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )
          ) : queue.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
              Queue is empty. Play something from Library, Albums, Artists, load a saved playlist, or build a Smart Set.
            </div>
          ) : (
            <ol className="m-0 list-none p-0" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {queue.map((t, i) => (
                <li
                  key={`${t.id}-${i}`}
                  className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5"
                  style={{
                    borderColor: 'var(--line)',
                    background: current?.id === t.id ? 'var(--panel-2)' : 'transparent',
                    color: current?.id === t.id ? 'var(--accent)' : 'var(--ink)',
                    opacity: draggedQueueIndex === i ? 0.55 : 1,
                  }}
                  draggable={true}
                  aria-grabbed={draggedQueueIndex === i}
                  onDragStart={(event) => {
                    setDraggedQueueIndex(i);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', String(i));
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const transferIndex = Number(event.dataTransfer.getData('text/plain'));
                    const fromIndex = draggedQueueIndex ?? (Number.isInteger(transferIndex) ? transferIndex : null);
                    if (fromIndex !== null && fromIndex !== i) moveQueuedTrack(fromIndex, i);
                    setDraggedQueueIndex(null);
                  }}
                  onDragEnd={() => setDraggedQueueIndex(null)}
                  onDoubleClick={() => void playQueue(queue, i)}
                >
                  <span className="w-[28px] shrink-0" style={{ color: 'var(--muted)' }}>
                    {(i + 1).toString().padStart(2, '0')}
                  </span>
                  <span className="flex-1 truncate">
                    {t.artist} - {t.title}
                  </span>
                  <span style={{ color: 'var(--muted)' }}>{formatTime(t.duration ?? 0)}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      className="pxbtn"
                      title="Move up"
                      onClick={(event) => {
                        event.stopPropagation();
                        moveQueuedTrack(i, i - 1);
                      }}
                      disabled={i === 0}
                    >
                      UP
                    </button>
                    <button
                      className="pxbtn"
                      title="Move down"
                      onClick={(event) => {
                        event.stopPropagation();
                        moveQueuedTrack(i, i + 1);
                      }}
                      disabled={i === queue.length - 1}
                    >
                      DOWN
                    </button>
                    <button
                      className="pxbtn"
                      title="Remove from queue"
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeQueuedTrack(i);
                      }}
                    >
                      X
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function moodLabel(mood: SetMood): string {
  if (mood === 'deep-cuts') return 'deep cuts';
  return mood;
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function playlistTextMatches(query: string, values: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => (value ?? '').toLowerCase().includes(needle));
}

function formatSleepRemaining(endsAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function filePathToImageUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const prefix = /^[A-Za-z]:/.test(normalized) ? '/' : '';
  return `file://${prefix}${encodeURI(normalized).replace(/#/g, '%23')}`;
}
