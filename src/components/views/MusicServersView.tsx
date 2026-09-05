import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MusicServerProvider } from '@shared/music-servers';
import type { SavedMusicServer, Track } from '@shared/types';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { usePlayerStore } from '../../store/usePlayerStore';
import { ViewHeader } from '../ViewHeader';
import { ConfirmAction } from '../ConfirmAction';

export function MusicServersView(): JSX.Element {
  const [servers, setServers] = useState<SavedMusicServer[]>([]);
  const [selected, setSelected] = useState('');
  const [provider, setProvider] = useState<MusicServerProvider>('jellyfin');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);

  useEffect(() => {
    let cancelled = false;
    void api.getMusicServers().then((saved) => {
      if (cancelled) return;
      setServers(saved);
      setSelected(saved[0]?.id ?? '');
    }).catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const request = ++generation.current;
    setTracks([]);
    setNextOffset(null);
    setTotal(null);
    if (!selected) { setLoading(false); return; }
    setLoading(true);
    setError('');
    void api.getMusicServerTracks(selected, { query: search, offset, limit: 100 }).then((page) => {
      if (generation.current !== request) return;
      setTracks(page.tracks);
      setTotal(page.total);
      setNextOffset(page.nextOffset);
    }).catch((err: Error) => { if (generation.current === request) setError(err.message); })
      .finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current += 1; };
  }, [selected, search, offset, revision]);

  async function connect(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (connecting) return;
    setConnecting(true);
    setError('');
    try {
      const server = await api.connectMusicServer({ provider, baseUrl, username, password, remember });
      setServers((current) => [...current.filter((entry) => entry.id !== server.id), server]);
      setSelected(server.id);
      setOffset(0);
      setSearch('');
      setQuery('');
      setPassword('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not connect.'); }
    finally { setConnecting(false); }
  }

  async function disconnect(): Promise<void> {
    try {
      await api.disconnectMusicServer(selected);
      const remaining = servers.filter((entry) => entry.id !== selected);
      setServers(remaining);
      setSelected(remaining[0]?.id ?? '');
      setOffset(0);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not disconnect.'); }
  }

  return (
    <div className="flex h-full flex-col overflow-auto" style={{ fontFamily: 'var(--font-mono)' }}>
      <ViewHeader eyebrow="Streaming" title="Music Servers" count={servers.length ? `${servers.length} connected` : undefined} />
      <div className="space-y-4 p-4 text-[12px]">
        <p style={{ color: 'var(--muted)' }}>Browse and play music from your Jellyfin or Navidrome / Subsonic server. Tracks play through the queue and visualizers without a full library download.</p>
        <details open={!servers.length} className="border p-3" style={{ borderColor: 'var(--line)' }}>
          <summary className="cursor-pointer">Add a music server</summary>
          <form onSubmit={(event) => void connect(event)} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-1">Server type
              <select aria-label="Server type" className="bevel-in px-2 py-1" value={provider} onChange={(e) => setProvider(e.target.value as MusicServerProvider)} disabled={connecting}>
                <option value="jellyfin">Jellyfin</option><option value="subsonic">Navidrome / Subsonic</option>
              </select>
            </label>
            <label className="grid min-w-[230px] flex-1 gap-1">Server URL
              <input className="bevel-in px-2 py-1" type="url" placeholder="https://music.example.com" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={connecting} />
            </label>
            <label className="grid gap-1">Username
              <input className="bevel-in px-2 py-1" required value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} disabled={connecting} />
            </label>
            <label className="grid gap-1">Password
              <input className="bevel-in px-2 py-1" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} disabled={connecting} />
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={connecting} />Remember connection</label>
            <button className="pxbtn is-active" type="submit" disabled={connecting || !baseUrl || !username}>{connecting ? 'Connecting…' : 'Connect'}</button>
          </form>
          <p className="mt-2" style={{ color: 'var(--muted)' }}>Include any server subpath in the URL. Saved credentials use your system keyring. Uncheck Remember connection to use this session only.</p>
          {baseUrl.trim().startsWith('http:') && <p className="mt-2" style={{ color: 'var(--warn)' }}>HTTP sends login and music traffic without encryption. Use HTTPS outside a trusted local network.</p>}
        </details>
        {error && <p role="alert" style={{ color: 'var(--error)' }}>{error}</p>}
        {servers.length > 0 && <>
          <div className="flex flex-wrap items-center gap-3">
            <label>Connection <select className="bevel-in px-2 py-1" value={selected} onChange={(e) => { setSelected(e.target.value); setOffset(0); }}>
              {servers.map((server) => <option key={server.id} value={server.id}>{server.name}{server.remembered ? '' : ' (session only)'}</option>)}
            </select></label>
            <ConfirmAction label="DISCONNECT" confirmLabel="CONFIRM" title="Remove this connection from NewAmp" onConfirm={() => void disconnect()} />
            <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); setOffset(0); setRevision((current) => current + 1); }}>
              <input className="bevel-in px-2 py-1 min-w-0 flex-1" aria-label="Search server music" placeholder="Search tracks, artists, albums" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="pxbtn" disabled={loading}>Search</button>
            </form>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="pxbtn" disabled={!tracks.length || loading} onClick={() => void playQueue(tracks, 0)}>Play page</button>
            <button className="pxbtn" disabled={!tracks.length || loading} onClick={() => queueTracksNext(tracks)}>Page next</button>
            <button className="pxbtn" disabled={!tracks.length || loading} onClick={() => addTracksToQueue(tracks)}>Queue page</button>
          </div>
          {loading ? <p role="status">Loading music…</p> : tracks.length ? <table className="w-full table-fixed text-left">
            <thead style={{ color: 'var(--muted)' }}><tr><th className="py-2">Track</th><th>Artist / Album</th><th className="w-16">Time</th><th className="w-[200px]">Actions</th></tr></thead>
            <tbody>{tracks.map((track, index) => <tr key={track.path} className="border-t" style={{ borderColor: 'var(--line)' }}>
              <td className="truncate py-2 pr-3" title={track.title}>{track.title}</td>
              <td className="truncate pr-3" title={`${track.artist} — ${track.album}`}>{track.artist}<span className="block truncate text-[10px]" style={{ color: 'var(--muted)' }}>{track.album}</span></td>
              <td>{formatTime(track.duration ?? 0)}</td>
              <td><div className="flex gap-1"><button className="pxbtn" onClick={() => void playQueue(tracks, index)} aria-label={`Play ${track.title}`}>Play</button><button className="pxbtn" onClick={() => queueTracksNext([track])} aria-label={`Play ${track.title} next`}>Next</button><button className="pxbtn" onClick={() => addTracksToQueue([track])} aria-label={`Queue ${track.title}`}>Queue</button></div></td>
            </tr>)}</tbody>
          </table> : <p>No tracks found.</p>}
          <div className="flex items-center gap-3">
            <button className="pxbtn" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous page</button>
            <span>{tracks.length ? `${offset + 1}–${offset + tracks.length}` : '0'}{total !== null ? ` of ${total.toLocaleString()}` : ''}</span>
            <button className="pxbtn" disabled={loading || nextOffset === null} onClick={() => { if (nextOffset !== null) setOffset(nextOffset); }}>Next page</button>
          </div>
        </>}
      </div>
    </div>
  );
}
