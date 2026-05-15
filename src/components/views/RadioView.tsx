import { useEffect, useRef, useState } from 'react';
import type { RadioStation } from '@shared/types';
import { clickStation, searchStations, topTags } from '../../api/radiobrowser';
import { usePlayerStore } from '../../store/usePlayerStore';

const RADIO_TAGS = ['lofi', 'jazz', 'ambient', 'metal', 'electronic', 'classical', 'reggae', 'hip-hop', 'rock', 'blues'];

export function RadioView(): JSX.Element {
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string>('');
  const [tags, setTags] = useState<Array<{ name: string; stationcount: number }>>([]);
  const [active, setActive] = useState<RadioStation | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const isPlayingLibrary = usePlayerStore((s) => s.isPlaying);
  const pauseLibrary = () => usePlayerStore.getState().engine.pause();

  useEffect(() => {
    audio.current = new Audio();
    audio.current.crossOrigin = 'anonymous';
    return () => {
      audio.current?.pause();
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    topTags(40)
      .then((t) => setTags(t))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!query && !tag) return;
    let cancelled = false;
    setLoading(true);
    searchStations({ name: query || undefined, tag: tag || undefined, limit: 80 })
      .then((rows) => !cancelled && setStations(rows))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query, tag]);

  function playStation(s: RadioStation): void {
    if (!audio.current) return;
    if (isPlayingLibrary) pauseLibrary();
    audio.current.src = s.url;
    audio.current.play().catch((err) => console.error('radio play failed', err));
    setActive(s);
    void clickStation(s.id);
  }

  function stopRadio(): void {
    audio.current?.pause();
    if (audio.current) audio.current.src = '';
    setActive(null);
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex flex-col gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--line)' }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--accent)' }}>📡</span>
          <span className="text-[12px] font-semibold">Internet Radio</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search station name…"
            className="bevel-in lcd-text ml-2 flex-1 px-3 py-1.5 text-[14px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          />
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {stations.length} stations
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
            Tags
          </span>
          {(tags.length ? tags.slice(0, 18).map((t) => t.name) : RADIO_TAGS).map((t) => (
            <button
              key={t}
              className={`pxbtn ${tag === t ? 'is-active' : ''}`}
              onClick={() => setTag(tag === t ? '' : t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading…
          </div>
        ) : stations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
            <div>Pick a tag or type a station name to explore 50,000+ stations.</div>
            <div>Curated by the community at radio-browser.info.</div>
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {stations.map((s) => (
              <li
                key={s.id}
                className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 transition-colors hover:bg-[var(--panel-2)]"
                style={{
                  borderColor: 'var(--line)',
                  background: active?.id === s.id ? 'var(--panel-2)' : 'transparent',
                  color: active?.id === s.id ? 'var(--accent)' : 'var(--ink)',
                }}
                onDoubleClick={() => playStation(s)}
              >
                <button
                  className="pxbtn !min-w-[36px]"
                  onClick={() => (active?.id === s.id ? stopRadio() : playStation(s))}
                >
                  {active?.id === s.id ? '◼' : '▶'}
                </button>
                {s.favicon ? (
                  <img
                    src={s.favicon}
                    alt=""
                    width={28}
                    height={28}
                    style={{ borderRadius: 'var(--radius)', background: 'var(--panel-2)', objectFit: 'cover' }}
                    onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                  />
                ) : (
                  <div
                    style={{ width: 28, height: 28, background: 'var(--panel-2)', borderRadius: 'var(--radius)' }}
                  />
                )}
                <div className="flex flex-1 flex-col overflow-hidden">
                  <span className="truncate text-[13px]">{s.name}</span>
                  <span className="truncate text-[10px]" style={{ color: 'var(--muted)' }}>
                    {s.country || '—'} · {s.codec || ''} {s.bitrate ? ` · ${s.bitrate} kbps` : ''} · {s.tags?.split(',').slice(0, 3).join(', ')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {active && (
        <div
          className="flex items-center gap-3 border-t px-4 py-2 text-[12px]"
          style={{ background: 'var(--panel-2)', borderColor: 'var(--line)' }}
        >
          <span className="blink" style={{ color: 'var(--accent)' }}>● LIVE</span>
          <span className="font-semibold">{active.name}</span>
          <span style={{ color: 'var(--muted)' }}>
            {active.country} {active.bitrate ? `· ${active.bitrate} kbps` : ''}
          </span>
          <button className="pxbtn ml-auto" onClick={stopRadio}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
