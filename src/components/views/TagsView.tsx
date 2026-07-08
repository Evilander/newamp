import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TagRule, TagRulePreviewResult, TagSummary, Track } from '@shared/types';
import { api } from '../../lib/api';
import { usePlayerStore } from '../../store/usePlayerStore';
import { ViewOnboarding, HelpDot, useViewHelp } from '../ViewOnboarding';
import { ArtistLink, TrackLink } from '../EntityLink';
import { ViewHeader } from '../ViewHeader';
import { Chip } from '../Chip';
import { ConfirmAction } from '../ConfirmAction';

const DEFAULT_BODY = `tag(midnight_drive) when
  bpm > 110
  and dna.energy > 0.4
  and (genre matches "synth|wave|electronic|techno")
  and skipcount < 3
boost 1.5`;

const SAMPLE_SNIPPETS: Array<{ label: string; body: string }> = [
  {
    label: 'Crowd Pleaser',
    body: `tag(crowd_pleaser) when playcount >= 5 and rating >= 4 boost 1.3`,
  },
  {
    label: 'Deep Cuts',
    body: `tag(deep_cuts) when playcount = 0 and rating >= 3 and not loved`,
  },
  {
    label: 'Hi-Res Shelf',
    body: `tag(hi_res) when samplerate >= 88200 and format matches "flac|wav|aiff|alac|dsf|dff"`,
  },
  {
    label: 'Rainy Sunday Boost',
    body: `tag(rainy_sunday) when weekday() = "sun" and hour() < 12 boost 2.5`,
  },
  {
    label: 'Sonic Detonation',
    body: `tag(detonation) when dna.dynamicrange > 0.5 and dna.onsetdensity > 0.4 and dna.high > 0.18`,
  },
];

interface DraftState {
  id: number | null;
  name: string;
  body: string;
  boost: number;
  enabled: boolean;
}

const FRESH_DRAFT: DraftState = {
  id: null,
  name: 'new_tag',
  body: DEFAULT_BODY,
  boost: 1,
  enabled: true,
};

export function TagsView(): JSX.Element {
  const help = useViewHelp();
  const [rules, setRules] = useState<TagRule[]>([]);
  const [summaries, setSummaries] = useState<TagSummary[]>([]);
  const [draft, setDraft] = useState<DraftState>(FRESH_DRAFT);
  const [preview, setPreview] = useState<TagRulePreviewResult | null>(null);
  const [previewTracks, setPreviewTracks] = useState<Track[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const playQueue = usePlayerStore((s) => s.playQueue);

  const refresh = useCallback(async () => {
    const [r, s] = await Promise.all([api.listTagRules(), api.getTagSummaries()]);
    setRules(r);
    setSummaries(s);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const previewTimer = useRef<number | null>(null);
  const previewSeq = useRef(0);
  useEffect(() => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    const seq = ++previewSeq.current;
    previewTimer.current = window.setTimeout(async () => {
      try {
        const result = await api.previewTagRule({ body: draft.body, limit: 2000 });
        if (seq !== previewSeq.current) return;
        setPreview(result);
        if (result.ok && result.sampleTrackIds.length) {
          const tracks = await Promise.all(result.sampleTrackIds.slice(0, 12).map((id) => api.getTrack(id)));
          if (seq !== previewSeq.current) return;
          setPreviewTracks(tracks.filter((t): t is Track => !!t));
        } else {
          setPreviewTracks([]);
        }
      } catch (err) {
        if (seq !== previewSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 350);
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    };
  }, [draft.body]);

  function pickRule(rule: TagRule): void {
    setDraft({ id: rule.id, name: rule.name, body: rule.body, boost: rule.boost, enabled: rule.enabled });
    setError(null);
    setStatus(null);
  }

  function newRule(): void {
    setDraft(FRESH_DRAFT);
    setError(null);
    setStatus('New rule draft — edit the body and Save.');
  }

  function loadSample(body: string): void {
    setDraft((d) => ({ ...d, body }));
    setError(null);
    setStatus('Loaded sample snippet.');
  }

  async function save(): Promise<void> {
    if (!preview?.ruleName) {
      setError('Cannot save — fix the parse errors first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveTagRule({
        id: draft.id ?? undefined,
        name: preview.ruleName,
        body: draft.body,
        boost: draft.boost,
        enabled: draft.enabled,
      });
      setDraft({ id: saved.id, name: saved.name, body: saved.body, boost: saved.boost, enabled: saved.enabled });
      setStatus(`Saved "${saved.name}" — recomputing tags across the library.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(): Promise<void> {
    if (!draft.id) return;
    setBusy(true);
    try {
      await api.deleteTagRule(draft.id);
      setStatus(`Deleted "${draft.name}".`);
      newRule();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(): Promise<void> {
    if (!draft.id) return;
    setBusy(true);
    try {
      const updated = await api.setTagRuleEnabled(draft.id, !draft.enabled);
      if (updated) {
        setDraft({ id: updated.id, name: updated.name, body: updated.body, boost: updated.boost, enabled: updated.enabled });
      }
      await refresh();
      setStatus(updated && !updated.enabled ? `Disabled "${draft.name}" — its tracks are no longer tagged.` : `Enabled "${draft.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function recomputeAll(): Promise<void> {
    setBusy(true);
    try {
      const result = await api.recomputeTags();
      setStatus(
        `Recomputed ${result.rulesEvaluated} rule${result.rulesEvaluated === 1 ? '' : 's'} over ${result.tracksEvaluated.toLocaleString()} tracks — ${result.tagsAssigned.toLocaleString()} tag assignments.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function playTaggedSample(): Promise<void> {
    if (!preview?.sampleTrackIds.length) return;
    const ids = preview.sampleTrackIds.slice(0, 60);
    const tracks = (await Promise.all(ids.map((id) => api.getTrack(id)))).filter((t): t is Track => !!t);
    if (tracks.length) await playQueue(tracks, 0);
  }

  const parseErrors = preview && !preview.ok ? preview.errors : [];

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        eyebrow="Discovery"
        title="Living Tags"
        count={`${rules.length.toLocaleString()} ${rules.length === 1 ? 'rule' : 'rules'}`}
        status={
          <>
            <HelpDot help={help} label="What are Living Tags?" />
            <span className="hidden xl:inline" style={{ color: 'var(--muted)' }}>
              A reactive tagging DSL — write rules, the library re-tags itself.
            </span>
          </>
        }
        actions={
          <>
            <button className="pxbtn" disabled={busy} onClick={() => void recomputeAll()}>
              Recompute all
            </button>
            <button className="pxbtn is-active" onClick={newRule} disabled={busy}>
              + New rule
            </button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <ViewOnboarding
          viewId="tags"
          title="Living Tags"
          lede="Write tag rules in a small expression language. NewAmp keeps applying them as you listen — new tracks get tagged automatically, old tracks re-tag when their stats change."
          bullets={[
            'Tags are derived, not stored on disk: change a rule and the whole library re-tags instantly.',
            'Rules see audio DNA (bpm, energy, brightness), playback history, ratings, and existing tags.',
            'Example: tag(late_night) when dna.energy < 0.35 and listenedAt.hour > 22.',
            'Tagged tracks show up in their own filters in Library and feed Mixes/Discover.',
          ]}
          cta="Pick a starter template below to see the syntax. Save the rule to make it permanent."
          forceVisible={help.open}
          onClose={help.close}
        />

        <div className="grid min-h-0 flex-1 gap-3" style={{ gridTemplateColumns: 'minmax(220px,260px) minmax(0,1.4fr) minmax(280px,1fr)' }}>
          <RulesList rules={rules} selectedId={draft.id} onPick={pickRule} />
          <Editor
            draft={draft}
            setDraft={setDraft}
            onSave={save}
            onDelete={deleteRule}
            onToggleEnabled={toggleEnabled}
            onLoadSample={loadSample}
            busy={busy}
            parseErrors={parseErrors}
            previewName={preview?.ruleName ?? null}
            previewReferences={preview?.references ?? []}
          />
          <PreviewPane
            preview={preview}
            tracks={previewTracks}
            onPlay={playTaggedSample}
            busy={busy}
          />
        </div>

        <Footer status={status} error={error} summaries={summaries} />
      </div>
    </div>
  );
}

function RulesList({
  rules,
  selectedId,
  onPick,
}: {
  rules: TagRule[];
  selectedId: number | null;
  onPick: (rule: TagRule) => void;
}): JSX.Element {
  return (
    <aside className="flex min-h-0 flex-col bevel-out p-2" style={{ background: 'var(--panel)' }}>
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>
        Saved rules ({rules.length})
      </div>
      {!rules.length && (
        <div className="px-1 text-[11px]" style={{ color: 'var(--muted)' }}>
          No rules yet. Click "+ New rule" to start.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {rules.map((rule) => (
          <button
            key={rule.id}
            onClick={() => onPick(rule)}
            className={`mb-1 block w-full text-left rounded px-2 py-1.5 ${selectedId === rule.id ? 'is-active' : ''}`}
            style={{
              background: selectedId === rule.id ? 'var(--accent-soft)' : 'transparent',
              border: `1px solid ${selectedId === rule.id ? 'var(--accent)' : 'var(--line)'}`,
            }}
          >
            <div className="flex items-center gap-1">
              <span className="truncate text-[12px] font-bold" style={{ color: rule.enabled ? 'var(--ink)' : 'var(--muted)' }}>
                {rule.name}
              </span>
              {rule.boost !== 1 && (
                <Chip tone="accent" size="sm" className="ml-auto">
                  ×{rule.boost.toFixed(2)}
                </Chip>
              )}
              {!rule.enabled && (
                <Chip tone="muted" size="sm" className="ml-auto">off</Chip>
              )}
            </div>
            {rule.lastError && (
              <div className="mt-0.5 truncate text-[9px]" style={{ color: 'var(--error)' }}>
                ! {rule.lastError}
              </div>
            )}
          </button>
        ))}
      </div>
    </aside>
  );
}

function Editor({
  draft,
  setDraft,
  onSave,
  onDelete,
  onToggleEnabled,
  onLoadSample,
  busy,
  parseErrors,
  previewName,
  previewReferences,
}: {
  draft: DraftState;
  setDraft: (next: DraftState | ((d: DraftState) => DraftState)) => void;
  onSave: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onLoadSample: (body: string) => void;
  busy: boolean;
  parseErrors: { message: string; line: number; column: number }[];
  previewName: string | null;
  previewReferences: string[];
}): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col bevel-out p-3" style={{ background: 'var(--panel)' }}>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>
          {draft.id ? `Editing "${draft.name}"` : 'New rule'}
        </div>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>Boost</span>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.05}
            value={draft.boost}
            onChange={(e) => setDraft((d) => ({ ...d, boost: Number(e.target.value) }))}
            className="nslider"
            style={{ width: 110 }}
          />
          <span className="font-mono text-[10px]" style={{ color: 'var(--accent)', minWidth: 36 }}>
            ×{draft.boost.toFixed(2)}
          </span>
        </span>
      </div>
      <textarea
        value={draft.body}
        onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
        spellCheck={false}
        className="flex-1 min-h-[180px] resize-none rounded p-3 font-mono text-[12px]"
        style={{
          background: 'var(--panel-2)',
          color: 'var(--ink)',
          border: '1px solid var(--line)',
          lineHeight: 1.5,
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="pxbtn is-active" onClick={onSave} disabled={busy || parseErrors.length > 0}>
          {draft.id ? 'Save changes' : 'Save rule'}
        </button>
        {draft.id && (
          <button className="pxbtn" onClick={onToggleEnabled} disabled={busy}>
            {draft.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        {draft.id && (
          <ConfirmAction
            label="Delete"
            confirmLabel="Sure?"
            tone="error"
            disabled={busy}
            title={`Delete rule "${draft.name}" — its tag assignments recompute away`}
            onConfirm={onDelete}
          />
        )}
        {previewName && (
          <span className="ml-auto text-[10px]" style={{ color: 'var(--ink-2)' }}>
            Parsed: <code style={{ color: 'var(--accent)' }}>{previewName}</code>
            {previewReferences.length > 0 && (
              <span> · refs: {previewReferences.map((r) => `tag(${r})`).join(', ')}</span>
            )}
          </span>
        )}
      </div>
      {parseErrors.length > 0 && (
        <div className="mt-2 rounded p-2 text-[11px]" style={{ background: 'var(--panel-3, var(--panel-2))', color: 'var(--error)' }}>
          {parseErrors.map((err, idx) => (
            <div key={idx}>
              line {err.line}:{err.column} — {err.message}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 grid gap-1">
        <div className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>
          Try a snippet
        </div>
        <div className="flex flex-wrap gap-1">
          {SAMPLE_SNIPPETS.map((s) => (
            <button key={s.label} className="pxbtn text-[10px]" onClick={() => onLoadSample(s.body)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <CheatSheet />
    </section>
  );
}

function CheatSheet(): JSX.Element {
  return (
    <details className="mt-2 text-[10px]" style={{ color: 'var(--muted)' }}>
      <summary className="cursor-pointer select-none font-bold uppercase tracking-[0.12em]">DSL cheat sheet</summary>
      <div className="mt-1 grid gap-1 pl-1" style={{ lineHeight: 1.5 }}>
        <code>tag(name) when &lt;expr&gt; [boost N]</code>
        <code>bpm &gt; 110 and (loved or rating &gt;= 4)</code>
        <code>dna.energy &gt; 0.5 and dna.brightness &lt; 0.3</code>
        <code>genre matches "synth|wave"  · title contains "remix"</code>
        <code>year in 1995..2005  · format = "flac"</code>
        <code>hour() &lt; 6  · weekday() = "sun"  · season() = "winter"</code>
        <code>tag(other) and not tag(loud)  · composes other rules</code>
        <div>Fields: track.* (bpm, year, rating, ...) + dna.* (energy, brightness, low, mid, high, ...). Null-safe: missing data fails the comparison.</div>
      </div>
    </details>
  );
}

function PreviewPane({
  preview,
  tracks,
  onPlay,
  busy,
}: {
  preview: TagRulePreviewResult | null;
  tracks: Track[];
  onPlay: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <aside className="flex min-h-0 flex-col bevel-out p-2" style={{ background: 'var(--panel)' }}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>
          Live preview
        </span>
        {preview?.ok && (
          <span className="ml-auto text-[10px]" style={{ color: 'var(--accent)' }}>
            {preview.matchCount.toLocaleString()} matches in sample
          </span>
        )}
      </div>
      {preview?.ok && tracks.length > 0 ? (
        <>
          <button
            className="pxbtn is-active mb-2 self-start"
            onClick={onPlay}
            disabled={busy}
          >
            Play sample
          </button>
          <ol className="min-h-0 flex-1 overflow-y-auto pr-1 text-[11px]">
            {tracks.map((track, idx) => (
              <li key={track.id} className="mb-1 truncate" style={{ color: 'var(--ink-2)' }}>
                <span className="mr-1 font-mono" style={{ color: 'var(--muted)' }}>
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <TrackLink track={track} className="font-bold" color="var(--ink)" />
                <span className="ml-1" style={{ color: 'var(--muted)' }}>· <ArtistLink artist={track.artist} color="inherit" /></span>
              </li>
            ))}
          </ol>
        </>
      ) : preview?.ok ? (
        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
          No matches in the sampled tracks. Loosen the rule or check your DNA / play history.
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
          Type a rule. Live preview will run automatically against a 2,000-track sample as you write.
        </div>
      )}
    </aside>
  );
}

function Footer({
  status,
  error,
  summaries,
}: {
  status: string | null;
  error: string | null;
  summaries: TagSummary[];
}): JSX.Element {
  const top = useMemo(() => summaries.slice(0, 8), [summaries]);
  return (
    <footer className="bevel-out p-2" style={{ background: 'var(--panel)' }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>
          Library tags
        </span>
        {!summaries.length && (
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
            No tags applied yet. Save a rule above and run Recompute.
          </span>
        )}
        {top.map((s) => (
          <Chip
            key={s.name}
            tone={s.enabled ? 'accent' : 'muted'}
            size="sm"
            title={`${s.trackCount} tracks · boost ×${s.boost.toFixed(2)}${s.enabled ? '' : ' · disabled'}`}
          >
            {s.name} · {s.trackCount.toLocaleString()}
          </Chip>
        ))}
      </div>
      {(status || error) && (
        <div className="mt-1 text-[10px]" style={{ color: error ? 'var(--error)' : 'var(--muted)' }}>
          {error ?? status}
        </div>
      )}
    </footer>
  );
}
