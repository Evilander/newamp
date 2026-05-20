import { useEffect, useMemo, useState } from 'react';
import type { DiscoverMission, DiscoverMixCard, DiscoverSurface, Track, VisualizerPreset } from '@shared/types';
import { api } from '../../lib/api';
import { formatDuration } from '../../lib/format';
import { usePlayerStore } from '../../store/usePlayerStore';
import { TrackTable } from './LibraryView';
import { ViewOnboarding } from '../ViewOnboarding';

export function DiscoverView(): JSX.Element {
  const [surface, setSurface] = useState<DiscoverSurface | null>(null);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lowEndMode, setLowEndMode] = useState(() => readBool('newamp:discover:lowEndMode', false));
  const [status, setStatus] = useState<string | null>(null);
  const current = usePlayerStore((s) => s.current);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueTrackNext = usePlayerStore((s) => s.queueTrackNext);
  const addTrackToQueue = usePlayerStore((s) => s.addTrackToQueue);
  const queueTracksNext = usePlayerStore((s) => s.queueTracksNext);
  const addTracksToQueue = usePlayerStore((s) => s.addTracksToQueue);
  const setFullscreenViz = usePlayerStore((s) => s.setFullscreenViz);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const setVizPreset = usePlayerStore((s) => s.setVizPreset);

  useEffect(() => {
    void refreshDiscover();
  }, [current?.id, lowEndMode]);

  const selectedMission = useMemo(
    () => surface?.missions.find((mission) => mission.id === selectedMissionId) ?? surface?.missions[0] ?? null,
    [surface, selectedMissionId],
  );
  const selectedCard = useMemo(
    () => surface?.cards.find((card) => card.id === selectedCardId) ?? surface?.cards[0] ?? null,
    [surface, selectedCardId],
  );
  const tableTracks = selectedMission?.tracks.length ? selectedMission.tracks : selectedCard?.tracks ?? [];

  async function refreshDiscover(seed = dailySeed()): Promise<void> {
    setLoading(true);
    setStatus(null);
    try {
      const next = await api.getDiscoverSurface({
        seed,
        limit: 12,
        lowEndMode,
        seedTrackId: current?.id ?? null,
      });
      setSurface(next);
      setSelectedMissionId((id) => (id && next.missions.some((mission) => mission.id === id) ? id : next.missions[0]?.id ?? null));
      setSelectedCardId((id) => (id && next.cards.some((card) => card.id === id) ? id : next.cards[0]?.id ?? null));
      setStatus(next.missions.length ? `Built ${next.missions.length} Living Library mission${next.missions.length === 1 ? '' : 's'}.` : 'Scan music or rate tracks to unlock Discover.');
    } catch (err) {
      console.error('discover refresh failed', err);
      setStatus('Discover could not build from the current library.');
    } finally {
      setLoading(false);
    }
  }

  async function saveMission(mission: DiscoverMission): Promise<void> {
    const saved = await api.savePlaylist({
      name: `${mission.title} ${new Date().toISOString().slice(0, 10)}`,
      trackIds: mission.tracks.map((track) => track.id),
    });
    setStatus(`Saved ${saved.name} with ${saved.trackCount.toLocaleString()} tracks.`);
  }

  async function saveCard(card: DiscoverMixCard): Promise<void> {
    const saved = await api.savePlaylist({
      name: `${card.title} ${new Date().toISOString().slice(0, 10)}`,
      trackIds: card.tracks.map((track) => track.id),
    });
    setStatus(`Saved ${saved.name} with ${saved.trackCount.toLocaleString()} tracks.`);
  }

  function launchDeck(plan = selectedMission?.visualPlan ?? selectedCard?.visualPlan ?? null): void {
    if (plan && typeof window !== 'undefined') {
      window.localStorage.setItem('newamp:deck:skinSchema', '2');
      window.localStorage.setItem('newamp:deck:skin', plan.deckSkin);
    }
    setCompactMode(true);
  }

  function launchVisualizer(preset?: VisualizerPreset): void {
    if (preset) setVizPreset(preset);
    setFullscreenViz(true);
  }

  function toggleLowEnd(): void {
    setLowEndMode((value) => {
      const next = !value;
      writeBool('newamp:discover:lowEndMode', next);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col" data-newamp-discover>
      <ViewOnboarding
        viewId="discover"
        title="Discover · Living Library"
        lede="A native mode that builds playable missions from your own listening history — no streaming required."
        bullets={[
          'New Download Radar surfaces tracks added to your library since the last session.',
          'Forgotten Favorites resurfaces loved tracks that haven\'t played in a while.',
          'Deep Album Run picks an album you should listen to end-to-end again.',
          'Each card opens as a saveable playlist or jumps straight into Auto VJ.',
        ]}
        cta="Click PLAY MISSION on any card below to start. Save as Playlist to keep one."
      />
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--muted)' }}>
          Living Library
        </div>
        <button className="pxbtn is-active" onClick={() => selectedMission && void playQueue(selectedMission.tracks, 0)} disabled={!selectedMission}>
          Start Session
        </button>
        <button className="pxbtn" onClick={() => void refreshDiscover(`${dailySeed()}:${Date.now()}`)} disabled={loading}>
          {loading ? 'Building...' : 'Reshuffle'}
        </button>
        <button
          className={`pxbtn ${lowEndMode ? 'is-active' : ''}`}
          onClick={toggleLowEnd}
          title="Use lighter visualizers and skip heavy effects (helps on older GPUs)"
        >
          Light Viz
        </button>
        {status && <span className="truncate text-[11px]" style={{ color: 'var(--ink-2)' }}>{status}</span>}
        {surface && (
          <span className="ml-auto text-[11px] tabular-nums" style={{ color: 'var(--muted)' }}>
            {surface.summary.trackCount.toLocaleString()} tracks / {surface.summary.albumCount.toLocaleString()} albums
          </span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_300px]">
        <section className="min-h-0 overflow-auto border-r p-3" style={{ borderColor: 'var(--line)' }}>
          <PanelLabel>Missions</PanelLabel>
          <div className="flex flex-col gap-2">
            {surface?.missions.map((mission) => (
              <button
                key={mission.id}
                data-newamp-discover-mission={mission.id}
                className="bevel-out p-3 text-left"
                style={{
                  background: selectedMission?.id === mission.id ? 'var(--panel-2)' : 'var(--panel)',
                  borderColor: selectedMission?.id === mission.id ? 'var(--accent)' : 'var(--line)',
                }}
                onClick={() => setSelectedMissionId(mission.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-bold">{mission.title}</div>
                    <div className="line-clamp-2 text-[11px]" style={{ color: 'var(--ink-2)' }}>{mission.subtitle}</div>
                  </div>
                  <ToneBadge tone={mission.tone}>{mission.tracks.length}</ToneBadge>
                </div>
                <div className="mt-2 text-[10px]" style={{ color: 'var(--muted)' }}>
                  {formatDuration(totalDuration(mission.tracks))}
                </div>
              </button>
            ))}
            {!surface?.missions.length && (
              <div className="bevel-in p-3 text-[12px]" style={{ color: 'var(--muted)' }}>
                {loading ? 'Building Discover...' : 'No missions yet.'}
              </div>
            )}
          </div>

          <PanelLabel className="mt-4">Mix Cards</PanelLabel>
          <div className="flex flex-col gap-2">
            {surface?.cards.map((card) => (
              <button
                key={card.id}
                className="bevel-out p-3 text-left"
                style={{
                  background: selectedCard?.id === card.id ? 'var(--panel-2)' : 'var(--panel)',
                  borderColor: selectedCard?.id === card.id ? 'var(--accent)' : 'var(--line)',
                }}
                onClick={() => setSelectedCardId(card.id)}
              >
                <div className="truncate text-[12px] font-bold">{card.title}</div>
                <div className="line-clamp-2 text-[11px]" style={{ color: 'var(--ink-2)' }}>{card.subtitle}</div>
                <div className="mt-2 text-[10px]" style={{ color: 'var(--muted)' }}>{card.scoreLabel}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <div className="border-b p-3" style={{ borderColor: 'var(--line)' }}>
            {selectedMission ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="lcd-text text-[34px] leading-none" style={{ color: selectedMission.tone === 'warn' ? 'var(--warn)' : 'var(--accent)' }}>
                    {String(selectedMission.steps.length).padStart(2, '0')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-[22px] font-bold">{selectedMission.title}</h1>
                    <p className="text-[12px]" style={{ color: 'var(--ink-2)' }}>{selectedMission.reason}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    <button className="pxbtn is-active" onClick={() => void playQueue(selectedMission.tracks, 0)} data-newamp-discover-play>Play</button>
                    <button className="pxbtn" onClick={() => queueTracksNext(selectedMission.tracks)}>Play Next</button>
                    <button className="pxbtn" onClick={() => addTracksToQueue(selectedMission.tracks)}>Queue</button>
                    <button className="pxbtn" onClick={() => void saveMission(selectedMission)} data-newamp-discover-save>Save as Playlist</button>
                  </div>
                </div>

                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                  {selectedMission.steps.map((step, index) => (
                    <div key={step.id} className="bevel-in p-3">
                      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--muted)' }}>
                        Step {index + 1}
                      </div>
                      <div className="mt-1 truncate text-[13px] font-bold">{step.title}</div>
                      <div className="line-clamp-2 min-h-[32px] text-[11px]" style={{ color: 'var(--ink-2)' }}>{step.instruction}</div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] tabular-nums" style={{ color: 'var(--muted)' }}>{step.tracks.length} tracks</span>
                        <button className="pxbtn" onClick={() => void playQueue(step.tracks, 0)} data-newamp-discover-step-action>{step.actionLabel}</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>Discover missions will appear here.</div>
            )}
          </div>

          <div className="min-h-0 overflow-auto">
            <TrackTable
              tracks={tableTracks}
              currentId={current?.id ?? null}
              onPlay={(index) => void playQueue(tableTracks, index)}
              onPlayTracks={(tracks) => void playQueue(tracks, 0)}
              onPlayNext={queueTrackNext}
              onAddToQueue={addTrackToQueue}
              onPlayNextTracks={queueTracksNext}
              onAddTracksToQueue={addTracksToQueue}
            />
          </div>
        </section>

        <aside className="min-h-0 overflow-auto border-l p-3" style={{ borderColor: 'var(--line)' }}>
          <PanelLabel>Why These Picks</PanelLabel>
          <div className="bevel-in p-3 text-[12px]" style={{ color: 'var(--ink-2)' }}>
            {selectedMission?.reason ?? selectedCard?.reason ?? 'Discover uses only local listening signals.'}
          </div>

          {surface && (
            <>
              <PanelLabel className="mt-4">Library Signals</PanelLabel>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Loved" value={surface.summary.lovedCount} />
                <Metric label="Rated 4+" value={surface.summary.highRatedCount} />
                <Metric label="Unplayed" value={surface.summary.unplayedCount} />
                <Metric label="Recovered" value={surface.summary.forgottenFavoriteCount} />
              </div>
            </>
          )}

          {(selectedMission?.visualPlan || selectedCard?.visualPlan) && (
            <>
              <PanelLabel className="mt-4">Visual Set</PanelLabel>
              <VisualPlanCard
                plan={(selectedMission?.visualPlan ?? selectedCard?.visualPlan)!}
                onDeck={() => launchDeck(selectedMission?.visualPlan ?? selectedCard?.visualPlan ?? null)}
                onVisual={launchVisualizer}
              />
            </>
          )}

          {selectedCard && (
            <>
              <PanelLabel className="mt-4">Selected Card</PanelLabel>
              <div className="bevel-out p-3">
                <div className="text-[13px] font-bold">{selectedCard.title}</div>
                <div className="mt-1 text-[11px]" style={{ color: 'var(--ink-2)' }}>{selectedCard.reason}</div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <button className="pxbtn is-active" onClick={() => void playQueue(selectedCard.tracks, 0)}>Play</button>
                  <button className="pxbtn" onClick={() => queueTracksNext(selectedCard.tracks)}>Next</button>
                  <button className="pxbtn" onClick={() => addTracksToQueue(selectedCard.tracks)}>Queue</button>
                  <button className="pxbtn" onClick={() => void saveCard(selectedCard)}>Save</button>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function PanelLabel({ children, className = '' }: { children: string; className?: string }): JSX.Element {
  return (
    <div className={`mb-2 text-[10px] uppercase tracking-[0.16em] ${className}`} style={{ color: 'var(--muted)' }}>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="bevel-in p-2">
      <div className="lcd-text text-[20px] leading-none">{value.toLocaleString()}</div>
      <div className="mt-1 text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--muted)' }}>{label}</div>
    </div>
  );
}

function ToneBadge({ tone, children }: { tone: string; children: number }): JSX.Element {
  return (
    <span
      className="lcd-text shrink-0 text-[16px]"
      style={{ color: tone === 'warn' ? 'var(--warn)' : tone === 'accent' ? 'var(--accent)' : 'var(--ink)' }}
    >
      {children}
    </span>
  );
}

function VisualPlanCard({
  plan,
  onDeck,
  onVisual,
}: {
  plan: NonNullable<DiscoverMission['visualPlan']>;
  onDeck: () => void;
  onVisual: (preset?: VisualizerPreset) => void;
}): JSX.Element {
  return (
    <div className="bevel-out p-3">
      <div className="text-[13px] font-bold">{plan.title}</div>
      <div className="text-[11px]" style={{ color: 'var(--ink-2)' }}>{plan.subtitle}</div>
      <div className="mt-3 flex flex-wrap gap-1">
        {plan.presets.map((preset, index) => (
          <button
            key={preset}
            className={`pxbtn ${index === 0 ? 'is-active' : ''}`}
            onClick={() => onVisual(preset)}
            title={`Open ${preset} visualizer`}
          >
            {preset.replace(/-/g, ' ')}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-1">
        <button className="pxbtn" onClick={onDeck} data-newamp-discover-deck>Deck</button>
        <button className="pxbtn is-active" onClick={() => onVisual(plan.presets[0])} data-newamp-discover-full-vis>Full Vis</button>
      </div>
    </div>
  );
}

function totalDuration(tracks: Track[]): number {
  return tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
}

function dailySeed(): string {
  return new Date().toISOString().slice(0, 10);
}

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const value = window.localStorage.getItem(key);
  if (value === '1') return true;
  if (value === '0') return false;
  return fallback;
}

function writeBool(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, value ? '1' : '0');
}
