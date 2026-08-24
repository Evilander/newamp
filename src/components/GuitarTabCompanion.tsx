import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CachedGuitarTab,
  GuitarTabDocument,
  GuitarTabLine,
  GuitarTabSearchResult,
  Track,
} from '@shared/types';
import { api } from '../lib/api';

const CHORD_TOKEN_RE =
  /\b([A-G](?:#|b)?)(maj|min|m|dim|aug|sus|add|M|mM|ø|o|[0-9]|[#b()+/-])*?(?:\/([A-G](?:#|b)?))?\b/g;
const CHORD_RE = /^([A-G](?:#|b)?)([^/\s]*)(?:\/([A-G](?:#|b)?))?$/;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_INDEX = new Map<string, number>([
  ['C', 0],
  ['B#', 0],
  ['C#', 1],
  ['Db', 1],
  ['D', 2],
  ['D#', 3],
  ['Eb', 3],
  ['E', 4],
  ['Fb', 4],
  ['E#', 5],
  ['F', 5],
  ['F#', 6],
  ['Gb', 6],
  ['G', 7],
  ['G#', 8],
  ['Ab', 8],
  ['A', 9],
  ['A#', 10],
  ['Bb', 10],
  ['B', 11],
  ['Cb', 11],
]);

type SearchStatus = 'idle' | 'searching' | 'ready' | 'none' | 'loading-tab' | 'blocked' | 'error';

export function GuitarTabCompanion({
  current,
  isPlaying,
}: {
  current: Track;
  isPlaying: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [results, setResults] = useState<GuitarTabSearchResult[]>([]);
  const [cachedTabs, setCachedTabs] = useState<CachedGuitarTab[]>([]);
  const [tab, setTab] = useState<GuitarTabDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [manualText, setManualText] = useState('');
  const [windowOpen, setWindowOpen] = useState(false);
  const [semitones, setSemitones] = useState(0);
  const [autoscroll, setAutoscroll] = useState(true);
  const [scrollSpeed, setScrollSpeed] = useState(1.2);
  // loadTab/openCachedTab/savePastedTab are independent async functions with
  // no guard of their own (unlike the top-level effect below, which resets
  // on current.id via its own `cancelled` flag) — a slow/blocked Ultimate
  // Guitar request that resolves after the user has skipped to another
  // track would otherwise unconditionally setTab/setWindowOpen(true),
  // reopening the OLD track's chords over the new one. Read via ref (not
  // `current.id` directly) so a stale closure still sees the live value.
  const currentIdRef = useRef(current.id);
  useEffect(() => {
    currentIdRef.current = current.id;
  }, [current.id]);

  useEffect(() => {
    let cancelled = false;
    setTab(null);
    setWindowOpen(false);
    setSemitones(0);
    setError(null);
    setResults([]);
    setCachedTabs([]);

    api
      .getCachedGuitarTabs(current.id)
      .then((rows) => {
        if (!cancelled) setCachedTabs(rows);
      })
      .catch(() => {
        if (!cancelled) setCachedTabs([]);
      });

    api
      .findLocalGuitarTab(current.id)
      .then((saved) => {
        if (!saved || cancelled) return;
        setCachedTabs((rows) =>
          [saved, ...rows.filter((row) => row.url !== saved.url)].sort((a, b) => b.updatedAt - a.updatedAt),
        );
      })
      .catch(() => undefined);

    const artist = current.artist?.trim();
    const title = current.title?.trim();
    if (!artist || !title || artist === 'Unknown Artist') {
      setStatus('idle');
      return () => {
        cancelled = true;
      };
    }

    setStatus('searching');
    api
      .searchGuitarTabs({ artist, title, limit: 5 })
      .then((next) => {
        if (cancelled) return;
        setResults(next);
        setStatus(next.length ? 'ready' : 'none');
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Ultimate Guitar search failed';
        setError(message);
        setStatus(/blocked|Cloudflare|challenge/i.test(message) ? 'blocked' : 'error');
      });

    return () => {
      cancelled = true;
    };
  }, [current.id, current.artist, current.title]);

  async function loadTab(url: string, target: 'overlay' | 'native' = 'overlay'): Promise<void> {
    if (!url.trim()) return;
    const trackId = current.id;
    setStatus('loading-tab');
    setError(null);
    try {
      const next = await api.getGuitarTab(url.trim());
      if (currentIdRef.current !== trackId) return;
      setTab(next);
      if (target === 'native') {
        await api.openGuitarTabWindow(next, isPlaying);
        if (currentIdRef.current !== trackId) return;
      } else {
        setWindowOpen(true);
      }
      setStatus('ready');
      api
        .saveCachedGuitarTab(trackId, next)
        .then((saved) => {
          if (currentIdRef.current !== trackId) return;
          setCachedTabs((rows) =>
            [saved, ...rows.filter((row) => row.url !== saved.url)].sort((a, b) => b.updatedAt - a.updatedAt),
          );
        })
        .catch(() => undefined);
    } catch (err) {
      if (currentIdRef.current !== trackId) return;
      const message = err instanceof Error ? err.message : 'Could not load this Ultimate Guitar tab';
      setError(message);
      setStatus(/blocked|Cloudflare|challenge/i.test(message) ? 'blocked' : 'error');
    }
  }

  async function openCachedTab(cached: CachedGuitarTab, target: 'overlay' | 'native' = 'overlay'): Promise<void> {
    const trackId = current.id;
    setTab(cached.document);
    if (target === 'native') {
      await api.openGuitarTabWindow(cached.document, isPlaying);
      if (currentIdRef.current !== trackId) return;
    } else {
      setWindowOpen(true);
    }
    setStatus('ready');
    setError(null);
  }

  async function savePastedTab(target: 'overlay' | 'native' = 'overlay'): Promise<void> {
    const content = manualText.trim();
    if (!content) return;
    const trackId = current.id;
    setStatus('loading-tab');
    setError(null);
    try {
      const saved = await api.saveLocalGuitarTab(trackId, {
        artist: current.artist,
        title: current.title,
        content,
        kind: 'Pasted Tab',
        key: current.key,
      });
      if (currentIdRef.current !== trackId) return;
      setTab(saved.document);
      setCachedTabs((rows) =>
        [saved, ...rows.filter((row) => row.url !== saved.url)].sort((a, b) => b.updatedAt - a.updatedAt),
      );
      setManualText('');
      if (target === 'native') {
        await api.openGuitarTabWindow(saved.document, isPlaying);
        if (currentIdRef.current !== trackId) return;
      } else {
        setWindowOpen(true);
      }
      setStatus('ready');
    } catch (err) {
      if (currentIdRef.current !== trackId) return;
      const message = err instanceof Error ? err.message : 'Could not save pasted tab';
      setError(message);
      setStatus('error');
    }
  }

  const best = results[0] ?? null;

  return (
    <>
      <section
        className="overflow-hidden px-4 py-3"
        style={{
          background: 'var(--panel)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div
          className="mb-2 flex items-center justify-between text-[9px] uppercase tracking-[0.1em]"
          style={{ color: 'var(--ink-2)' }}
        >
          <span>Play Along · Ultimate Guitar</span>
          <span style={{ color: status === 'blocked' || status === 'error' ? 'var(--warn)' : 'var(--muted)' }}>
            {statusLabel(status, results.length)}
          </span>
        </div>

        {best ? (
          <div className="grid gap-2" style={{ gridTemplateColumns: '1fr auto auto' }}>
            <button
              type="button"
              onClick={() => void loadTab(best.url)}
              className="min-w-0 text-left"
              title={`${best.artist} - ${best.title}`}
            >
              <div className="truncate text-[13px] font-bold" style={{ color: 'var(--accent)' }}>
                {best.artist} - {best.title}
              </div>
              <div className="mt-[2px] text-[10px]" style={{ color: 'var(--ink-2)' }}>
                {best.kind} · {best.rating ? `${best.rating.toFixed(1)} rating` : 'unrated'}
                {best.votes ? ` · ${best.votes.toLocaleString()} votes` : ''}
              </div>
            </button>
            <button className="pxbtn is-active" onClick={() => void loadTab(best.url)}>
              Open
            </button>
            <button className="pxbtn" onClick={() => void loadTab(best.url, 'native')}>
              Window
            </button>
          </div>
        ) : (
          <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {status === 'searching'
              ? 'Searching for a playable chord sheet...'
              : status === 'blocked'
                ? 'Auto-search is blocked from this network. Paste a UG URL, ChordPro, or sidecar tab text below.'
                : 'No current-song tab found yet. Paste a UG URL, ChordPro, or tab text.'}
          </div>
        )}

        {results.length > 1 && (
          <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
            {results.slice(1, 5).map((result) => (
              <button
                key={result.id}
                className="pxbtn shrink-0"
                onClick={() => void loadTab(result.url)}
                title={`${result.artist} - ${result.title}`}
              >
                {result.kind}
              </button>
            ))}
          </div>
        )}

        {cachedTabs.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[9px] uppercase tracking-[0.1em]" style={{ color: 'var(--ink-2)' }}>
              Cached for this track
            </div>
            <div className="flex gap-1 overflow-x-auto pb-1">
              {cachedTabs.slice(0, 4).map((cached) => (
                <button
                  key={cached.id || cached.url}
                  className="pxbtn shrink-0"
                  onClick={() => void openCachedTab(cached)}
                  title={`${cached.artist} - ${cached.title}`}
                >
                  {cached.kind}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <input
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            className="bevel-in min-w-0 flex-1 px-2 py-1 text-[11px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
            placeholder="Paste ultimate-guitar.com tab URL"
          />
          <button className="pxbtn" onClick={() => void loadTab(manualUrl)}>
            Load URL
          </button>
          <button className="pxbtn" onClick={() => void loadTab(manualUrl, 'native')}>
            Window
          </button>
        </div>

        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: '1fr auto auto' }}>
          <textarea
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            className="bevel-in min-h-[42px] min-w-0 resize-none px-2 py-1 text-[11px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
            placeholder="Paste ChordPro, chords, or tab text"
          />
          <button className="pxbtn" onClick={() => void savePastedTab()} disabled={!manualText.trim()}>
            Save Text
          </button>
          <button className="pxbtn" onClick={() => void savePastedTab('native')} disabled={!manualText.trim()}>
            Window
          </button>
        </div>

        {error && (
          <div className="mt-2 truncate text-[10px]" style={{ color: 'var(--warn)' }} title={error}>
            {error}
          </div>
        )}
      </section>

      {windowOpen && tab && (
        <GuitarTabWindow
          tab={tab}
          isPlaying={isPlaying}
          semitones={semitones}
          setSemitones={setSemitones}
          autoscroll={autoscroll}
          setAutoscroll={setAutoscroll}
          scrollSpeed={scrollSpeed}
          setScrollSpeed={setScrollSpeed}
          onClose={() => setWindowOpen(false)}
          onOpenNative={() => void api.openGuitarTabWindow(tab, isPlaying)}
        />
      )}
    </>
  );
}

function GuitarTabWindow({
  tab,
  isPlaying,
  semitones,
  setSemitones,
  autoscroll,
  setAutoscroll,
  scrollSpeed,
  setScrollSpeed,
  onClose,
  onOpenNative,
}: {
  tab: GuitarTabDocument;
  isPlaying: boolean;
  semitones: number;
  setSemitones: (value: number) => void;
  autoscroll: boolean;
  setAutoscroll: (value: boolean) => void;
  scrollSpeed: number;
  setScrollSpeed: (value: number) => void;
  onClose: () => void;
  onOpenNative: () => void;
}): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const visibleLines = useMemo(
    () =>
      tab.lines.map((line) => ({
        ...line,
        text: line.type === 'chords' ? transposeChordLine(line.text, semitones) : line.text,
      })),
    [tab.lines, semitones],
  );

  useEffect(() => {
    if (!isPlaying || !autoscroll) return;
    const id = window.setInterval(() => {
      if (!scrollerRef.current) return;
      scrollerRef.current.scrollTop += scrollSpeed;
    }, 120);
    return () => window.clearInterval(id);
  }, [autoscroll, isPlaying, scrollSpeed]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6"
      data-guitar-tab-window
    >
      <section
        className="bevel-out flex h-full max-h-[820px] w-full max-w-[980px] flex-col overflow-hidden"
        style={{ background: 'var(--bg)', boxShadow: '0 0 48px rgba(0,0,0,0.55)' }}
      >
        <header
          className="flex items-start justify-between gap-4 border-b px-4 py-3"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-[0.14em]" style={{ color: 'var(--ink-2)' }}>
              In-app Guitar Tab Window
            </div>
            <div className="truncate text-[20px] font-bold" style={{ color: 'var(--ink)' }}>
              {tab.artist} - {tab.title}
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px]" style={{ color: 'var(--ink-2)' }}>
              <span>{tab.kind}</span>
              {tab.key && <span>Key {tab.key}</span>}
              {tab.rating && <span>{tab.rating.toFixed(1)} rating</span>}
              {tab.votes && <span>{tab.votes.toLocaleString()} votes</span>}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button className="pxbtn" onClick={onOpenNative}>
              Native
            </button>
            <button className="pxbtn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div
          className="flex flex-wrap items-center gap-2 border-b px-4 py-2"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-2)' }}>
            Transpose
          </span>
          <button className="pxbtn" onClick={() => setSemitones(Math.max(-12, semitones - 1))}>
            -1
          </button>
          <span className="lcd-text min-w-[42px] text-center text-[13px]">
            {semitones > 0 ? `+${semitones}` : semitones}
          </span>
          <button className="pxbtn" onClick={() => setSemitones(Math.min(12, semitones + 1))}>
            +1
          </button>
          <button className="pxbtn" onClick={() => setSemitones(0)}>
            Reset
          </button>

          <label className="ml-3 flex items-center gap-2 text-[11px]" style={{ color: 'var(--ink-2)' }}>
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <input
            type="range"
            className="nslider w-[140px]"
            min={0.2}
            max={4}
            step={0.1}
            value={scrollSpeed}
            onChange={(e) => setScrollSpeed(parseFloat(e.target.value))}
            title="Auto-scroll speed"
          />
          {tab.source === 'ultimate-guitar' ? (
            <a
              className="ml-auto text-[10px] uppercase tracking-[0.12em]"
              href={tab.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              Source
            </a>
          ) : (
            <span className="ml-auto text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--muted)' }}>
              Local
            </span>
          )}
        </div>

        <div ref={scrollerRef} className="flex-1 overflow-auto px-6 py-5">
          <pre
            className="m-0 whitespace-pre-wrap text-[14px] leading-[1.65]"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink)' }}
          >
            {visibleLines.map((line, index) => (
              <TabLine key={`${index}-${line.type}`} line={line} />
            ))}
          </pre>
        </div>
      </section>
    </div>
  );
}

function TabLine({ line }: { line: GuitarTabLine }): JSX.Element {
  const color =
    line.type === 'chords'
      ? 'var(--accent)'
      : line.type === 'tab'
        ? 'var(--warn)'
        : line.type === 'section'
          ? 'var(--ink)'
          : line.type === 'blank'
            ? 'var(--muted)'
            : 'var(--ink-2)';
  return (
    <span style={{ color, fontWeight: line.type === 'chords' ? 700 : 400 }}>
      {line.text}
      {'\n'}
    </span>
  );
}

function statusLabel(status: SearchStatus, count: number): string {
  if (status === 'searching') return 'searching';
  if (status === 'loading-tab') return 'loading';
  if (status === 'blocked') return 'blocked';
  if (status === 'error') return 'error';
  if (status === 'none') return 'no match';
  if (status === 'ready') return `${count} match${count === 1 ? '' : 'es'}`;
  return 'idle';
}

function transposeChordLine(line: string, semitones: number): string {
  if (!Number.isFinite(semitones) || semitones === 0) return line;
  return line.replace(CHORD_TOKEN_RE, (token) => transposeChordToken(token, semitones));
}

function transposeChordToken(token: string, semitones: number): string {
  const match = token.match(CHORD_RE);
  if (!match) return token;
  const [, root, suffix = '', bass] = match;
  const nextRoot = transposeNote(root!, semitones);
  const nextBass = bass ? `/${transposeNote(bass, semitones)}` : '';
  return `${nextRoot}${suffix}${nextBass}`;
}

function transposeNote(note: string, semitones: number): string {
  const idx = NOTE_INDEX.get(note);
  if (idx == null) return note;
  const next = (idx + semitones) % 12;
  return NOTE_NAMES[(next + 12) % 12]!;
}
