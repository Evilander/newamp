import { useEffect, useRef, useState } from 'react';
import type { RadioStation } from '@shared/types';
import {
  CURATED_RADIO_TAGS,
  clickStation,
  searchStations,
  searchStationsByText,
  topTags,
  tuneStation,
  type TuneResult,
} from '../../api/radiobrowser';
import { usePlayerStore } from '../../store/usePlayerStore';
import { volumePositionToGain } from '../../audio/engine';
import { pushToast } from '../../lib/toast';
import { ViewHeader } from '../ViewHeader';
import { Antenna } from '../Icons';

const SEARCH_DEBOUNCE_MS = 250;

// The stream belongs to the app, not to this view: the element and the live
// station live here so leaving Radio for another view leaves the station
// playing, and coming back finds it.
let radioElement: HTMLAudioElement | null = null;
let radioStation: RadioStation | null = null;
// The station being tuned, before play() has resolved. Bumped by every connect
// and every stop, so a slow connect that lost the race can't mark its station
// live afterwards.
let radioConnecting: RadioStation | null = null;
let radioAttempt = 0;
const radioListeners = new Set<() => void>();
let followingPlayer = false;
let outputDeviceId: string | null = null;

function notifyRadio(): void {
  for (const listener of radioListeners) listener();
}

// The element is outside the Web Audio graph, so the transport's volume and the
// chosen output device are carried over to it by hand. Radio has no gain past
// unity; the library's perceptual taper is applied the same way.
function applyRadioOutput(): void {
  const el = radioElement;
  if (!el) return;
  const { volume, settings } = usePlayerStore.getState();
  el.volume = Math.max(0, Math.min(1, volumePositionToGain(volume)));
  const deviceId = settings?.audioOutputDeviceId ?? null;
  const sinkable = el as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
  if (deviceId !== outputDeviceId && typeof sinkable.setSinkId === 'function') {
    outputDeviceId = deviceId;
    sinkable.setSinkId(deviceId ?? '').catch(() => undefined);
  }
}

function getRadioElement(): HTMLAudioElement {
  if (!radioElement) {
    // No crossOrigin: nothing taps this element, and an anonymous CORS request
    // would refuse every station that doesn't send CORS headers.
    radioElement = new Audio();
  }
  if (!followingPlayer) {
    followingPlayer = true;
    usePlayerStore.subscribe((state, previous) => {
      if (state.volume !== previous.volume || state.settings?.audioOutputDeviceId !== previous.settings?.audioOutputDeviceId) {
        applyRadioOutput();
      }
      // Library playback starting from anywhere ends the station, or the
      // connect still under way, whether or not the Radio view is open to
      // notice.
      if (state.isPlaying && !previous.isPlaying && (radioStation || radioConnecting)) endRadioStream();
    });
  }
  applyRadioOutput();
  return radioElement;
}

let streamWatch: { dispose: () => void } | null = null;

// How long a stream may sit without data before it counts as lost, and how long
// to wait before each of the reconnect attempts.
const STREAM_STALL_LIMIT_MS = 20000;
const STREAM_RECONNECT_DELAYS_MS = [1500, 4000];

// A connection that dies after play() resolved (an Icecast mount going away)
// raises no failure of its own, so the bar would say LIVE over silence. This
// listens for the element giving up or running dry, tries to reconnect a couple
// of times, and then ends the station and says so.
function watchStream(el: HTMLAudioElement, station: RadioStation): void {
  streamWatch?.dispose();
  let disposed = false;
  let stallTimer = 0;
  let reconnectTimer = 0;
  let reconnects = 0;
  // A connection that fails is announced twice: by the element's error event
  // and by the rejected play(). Set once the drop has been counted, so the
  // second announcement doesn't use up another reconnect. Cleared when audio
  // flows again or the next attempt starts.
  let counted = false;
  const clearStall = (): void => {
    window.clearTimeout(stallTimer);
    stallTimer = 0;
  };
  const lost = (): void => {
    if (disposed || counted) return;
    counted = true;
    clearStall();
    if (reconnects < STREAM_RECONNECT_DELAYS_MS.length) {
      const delay = STREAM_RECONNECT_DELAYS_MS[reconnects++]!;
      reconnectTimer = window.setTimeout(() => {
        if (disposed) return;
        counted = false;
        void tuneStation(el, station).then((result) => {
          if (!disposed && !result.ok) lost();
        });
      }, delay);
      return;
    }
    endRadioStream();
    pushToast({ tone: 'error', title: 'Radio stream lost', detail: `${station.name} stopped sending audio.` });
  };
  const waiting = (): void => {
    if (!stallTimer && !counted) stallTimer = window.setTimeout(lost, STREAM_STALL_LIMIT_MS);
  };
  const playing = (): void => {
    clearStall();
    reconnects = 0;
    counted = false;
  };
  el.addEventListener('error', lost);
  el.addEventListener('ended', lost);
  el.addEventListener('waiting', waiting);
  el.addEventListener('stalled', waiting);
  el.addEventListener('playing', playing);
  el.addEventListener('timeupdate', clearStall);
  streamWatch = {
    dispose: () => {
      disposed = true;
      clearStall();
      window.clearTimeout(reconnectTimer);
      el.removeEventListener('error', lost);
      el.removeEventListener('ended', lost);
      el.removeEventListener('waiting', waiting);
      el.removeEventListener('stalled', waiting);
      el.removeEventListener('playing', playing);
      el.removeEventListener('timeupdate', clearStall);
    },
  };
}

function endRadioStream(): void {
  // A connect still under way finds its attempt gone when it resolves.
  radioAttempt++;
  // The watch comes off first: emptying the source raises an error event.
  streamWatch?.dispose();
  streamWatch = null;
  radioElement?.pause();
  if (radioElement) radioElement.src = '';
  radioStation = null;
  radioConnecting = null;
  notifyRadio();
}

// The station only counts as live once play() has resolved, so a refused
// stream (dead, HLS-only, blocked) never leaves the bar claiming LIVE.
async function connectStation(el: HTMLAudioElement, station: RadioStation): Promise<TuneResult> {
  const mine = ++radioAttempt;
  // The previous station's watch must not read the source swap as a drop.
  streamWatch?.dispose();
  streamWatch = null;
  radioStation = null;
  radioConnecting = station;
  notifyRadio();
  const result = await tuneStation(el, station);
  if (mine !== radioAttempt) return { ok: false, detail: null };
  radioConnecting = null;
  if (result.ok) {
    radioStation = station;
    watchStream(el, station);
    void clickStation(station.id);
  }
  notifyRadio();
  return result;
}

export function RadioView(): JSX.Element {
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string>('');
  // Raw directory tags, offered as search suggestions rather than chips.
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState<RadioStation | null>(() => radioStation);
  const [connecting, setConnecting] = useState<RadioStation | null>(() => radioConnecting);
  const audio = useRef<HTMLAudioElement | null>(null);
  const isPlayingLibrary = usePlayerStore((s) => s.isPlaying);
  const pauseLibrary = () => usePlayerStore.getState().engine.pause();

  useEffect(() => {
    audio.current = getRadioElement();
    // The station can end while another view is open (library playback
    // starting, a stream that dropped); this view follows the shared state.
    const sync = (): void => {
      setActive(radioStation);
      setConnecting(radioConnecting);
    };
    radioListeners.add(sync);
    return () => {
      radioListeners.delete(sync);
      audio.current = null;
    };
  }, []);

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

  async function playStation(s: RadioStation): Promise<void> {
    const el = audio.current;
    if (!el) return;
    if (isPlayingLibrary) pauseLibrary();
    const result = await connectStation(el, s);
    if (!result.ok && result.detail) pushToast({ tone: 'error', title: 'Station failed to play', detail: result.detail });
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
                  onClick={() => (isOn(s) ? endRadioStream() : void playStation(s))}
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
          <button className="pxbtn ml-auto" onClick={endRadioStream}>
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
          <button className="pxbtn ml-auto" onClick={endRadioStream}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
