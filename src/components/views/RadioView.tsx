import { useEffect, useRef, useState } from 'react';
import type { RadioStation } from '@shared/types';
import {
  CURATED_RADIO_TAGS,
  clickStation,
  searchStations,
  searchStationsByText,
  topTags,
  tuneStation,
} from '../../api/radiobrowser';
import { usePlayerStore } from '../../store/usePlayerStore';
import { pushToast } from '../../lib/toast';
import { ViewHeader } from '../ViewHeader';
import { Antenna } from '../Icons';

const SEARCH_DEBOUNCE_MS = 250;

export function RadioView(): JSX.Element {
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string>('');
  // Raw directory tags, offered as search suggestions rather than chips.
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState<RadioStation | null>(null);
  const [connecting, setConnecting] = useState<RadioStation | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // Bumped by every play and stop so a slow connect that lost the race can't
  // mark its station live afterwards.
  const attempt = useRef(0);
  const isPlayingLibrary = usePlayerStore((s) => s.isPlaying);
  const pauseLibrary = () => usePlayerStore.getState().engine.pause();

  useEffect(() => {
    // No crossOrigin: nothing taps this element, and an anonymous CORS request
    // would refuse every station that doesn't send CORS headers.
    audio.current = new Audio();
    return () => {
      audio.current?.pause();
      audio.current = null;
    };
  }, []);

  // playStation() below pauses the library engine when a station starts, but
  // that was one-directional: nothing stopped the radio stream when library
  // playback became active from elsewhere (Transport, Space, a media key, a
  // detached remote) — the two playback pipelines could run simultaneously.
  useEffect(() => {
    if (isPlayingLibrary && audio.current && !audio.current.paused) {
      stopRadio();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlayingLibrary]);

  useEffect(() => {
    topTags(300)
      .then((t) => setTagSuggestions(t.map((entry) => entry.name)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const text = query.trim();
    if (!text && !tag) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    // Typing searches on a short delay; a chip click goes straight out.
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        // A chip narrows the name search to that exact tag. Free text alone
        // matches station names and tags, which is how the raw tags stay
        // reachable now that the chips are a fixed genre list.
        const request = tag
          ? searchStations({ name: text || undefined, tag, tagExact: true, limit: 80, signal })
          : searchStationsByText(text, { limit: 80, signal });
        request
          .then((rows) => !signal.aborted && setStations(rows))
          .catch(() => {
            // fetchWithFailover already tries every mirror with a timeout before
            // rejecting, so reaching here means the whole directory is
            // unreachable right now — worth telling the user, not just silently
            // showing an empty result list.
            if (!signal.aborted) pushToast({ tone: 'error', title: 'Station search failed', detail: 'All radio-browser mirrors are unreachable right now.' });
          })
          .finally(() => !signal.aborted && setLoading(false));
      },
      text ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, tag]);

  // The station only counts as live once play() has resolved, so a refused
  // stream (dead, HLS-only, blocked) never leaves the bar claiming LIVE.
  async function playStation(s: RadioStation): Promise<void> {
    const el = audio.current;
    if (!el) return;
    if (isPlayingLibrary) pauseLibrary();
    const mine = ++attempt.current;
    setActive(null);
    setConnecting(s);
    const result = await tuneStation(el, s);
    if (mine !== attempt.current) return;
    setConnecting(null);
    if (!result.ok) {
      if (result.detail) pushToast({ tone: 'error', title: 'Station failed to play', detail: result.detail });
      return;
    }
    setActive(s);
    void clickStation(s.id);
  }

  function stopRadio(): void {
    attempt.current++;
    audio.current?.pause();
    if (audio.current) audio.current.src = '';
    setActive(null);
    setConnecting(null);
  }

  const isOn = (s: RadioStation): boolean => active?.id === s.id || connecting?.id === s.id;

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        eyebrow="Streaming"
        title={
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex" style={{ color: 'var(--accent)' }}>
              <Antenna size={15} />
            </span>
            Internet Radio
          </span>
        }
        count={`${stations.length.toLocaleString()} stations`}
        actions={
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search stations or tags…"
              list="radio-tag-suggestions"
              className="bevel-in lcd-text w-[240px] px-3 py-1.5 text-[13px] outline-none"
              style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
              aria-label="Search stations or tags"
            />
            <datalist id="radio-tag-suggestions">
              {tagSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <span className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
          Genres
        </span>
        {CURATED_RADIO_TAGS.map((t) => (
          <button
            key={t}
            className={`pxbtn ${tag === t ? 'is-active' : ''}`}
            onClick={() => setTag(tag === t ? '' : t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading…
          </div>
        ) : stations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
            <div>Pick a genre, or search by station name or tag, to explore 50,000+ stations.</div>
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
                  background: isOn(s) ? 'var(--panel-2)' : 'transparent',
                  color: isOn(s) ? 'var(--accent)' : 'var(--ink)',
                }}
                onDoubleClick={() => void playStation(s)}
              >
                <button
                  className="pxbtn !min-w-[36px]"
                  onClick={() => (isOn(s) ? stopRadio() : void playStation(s))}
                >
                  {isOn(s) ? '◼' : '▶'}
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
      {connecting && (
        <div
          className="flex items-center gap-3 border-t px-4 py-2 text-[12px]"
          style={{ background: 'var(--panel-2)', borderColor: 'var(--line)' }}
        >
          <span style={{ color: 'var(--muted)' }}>Connecting to</span>
          <span className="font-semibold">{connecting.name}</span>
          <button className="pxbtn ml-auto" onClick={stopRadio}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
