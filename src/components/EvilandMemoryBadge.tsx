import { useEffect, useRef, useState } from 'react';
import type { MemoryBridgeState } from '../visualizer/eviland-memory-bridge';
import {
  subscribeActiveBridgeState,
  getActiveBridge,
  dropBridgeForTrack,
} from '../visualizer/eviland-memory-bridge-registry';
import { api } from '../lib/api';

// "REMEMBERS THIS SONG" badge for the fullscreen eviland visualizer.
//
// Rules (blueprint §1.8):
//   - Only shown when activePreset === 'eviland' AND a plan was loaded for the
//     current track. Parent guards on activePreset; this component subscribes
//     to the bridge registry and renders nothing when state.hasPlan is false.
//   - Fades in over ~4s after a plan loads; auto-hides ~5s later.
//   - Pinnable on click → popover with reset + borrow info.
//   - Allocation-free per-frame: NEVER reads state in rAF; we drive UI from
//     bridge subscribe events. The bridge only emits on plan-load / counter
//     mutations, so this is effectively idle during steady playback.

interface BadgeProps {
  /** Parent owns the preset gate; passing it lets us hide cleanly on preset change. */
  enabled: boolean;
}

type Phase = 'hidden' | 'fade-in' | 'visible' | 'fade-out' | 'pinned';

export function EvilandMemoryBadge({ enabled }: BadgeProps): JSX.Element | null {
  const [state, setState] = useState<MemoryBridgeState | null>(null);
  const [phase, setPhase] = useState<Phase>('hidden');
  const [showPopover, setShowPopover] = useState(false);
  const [borrowedTitle, setBorrowedTitle] = useState<string | null>(null);
  const fadeInTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The unpin fade-out's trailing hide, kept so a track change during that
  // 800ms window can cancel it instead of letting it hide the next track's
  // badge mid-entrance.
  const unpinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track which (trackId, hasPlan) signature has already armed an entrance so
  // we don't restart the fade on every counter tick.
  const armedFor = useRef<string | null>(null);

  // Subscribe to the active bridge. Cleans up on preset change via `enabled`.
  useEffect(() => {
    if (!enabled) {
      setState(null);
      setPhase('hidden');
      armedFor.current = null;
      return;
    }
    return subscribeActiveBridgeState((next) => {
      setState(next);
    });
  }, [enabled]);

  // Drive the entrance + auto-hide animation when a plan becomes available.
  // Pinned state (user clicked) bypasses the auto-hide.
  useEffect(() => {
    if (!enabled || !state || !state.hasPlan) {
      // Tear down any in-flight timers + reset.
      if (fadeInTimer.current) clearTimeout(fadeInTimer.current);
      if (visibleTimer.current) clearTimeout(visibleTimer.current);
      if (unpinTimer.current) clearTimeout(unpinTimer.current);
      fadeInTimer.current = null;
      visibleTimer.current = null;
      unpinTimer.current = null;
      if (phase !== 'pinned') setPhase('hidden');
      return;
    }
    // Sign on (trackId, hasPlan) so a counter tick doesn't restart the cycle.
    const sig = `${state.trackId ?? 'null'}:${state.hasPlan}`;
    if (armedFor.current === sig) return;
    armedFor.current = sig;

    if (phase === 'pinned') return; // user has it open; leave it
    // A new track's entrance supersedes any unpin fade-out still winding down.
    if (unpinTimer.current) {
      clearTimeout(unpinTimer.current);
      unpinTimer.current = null;
    }
    setPhase('fade-in');
    // Match the 4s fade-in window from the blueprint.
    fadeInTimer.current = setTimeout(() => {
      // Pin-aware (finding #7): if the user clicked the badge during the
      // 4s fade-in window, togglePin set phase to 'pinned'. Without this
      // guard, this in-flight timer would stomp the pinned phase back to
      // 'visible' and the chain below would fade the popover out from
      // under the user's click. The inner timers had this guard already;
      // the outer fadeInTimer was the missing link.
      setPhase((p) => (p === 'pinned' ? p : 'visible'));
      // Then ~5s visible before fading out.
      visibleTimer.current = setTimeout(() => {
        setPhase((p) => (p === 'pinned' ? p : 'fade-out'));
        // Allow the fade-out CSS transition to finish before unmounting.
        setTimeout(() => {
          setPhase((p) => (p === 'pinned' ? p : 'hidden'));
        }, 800);
      }, 5000);
    }, 4000);

    return () => {
      if (fadeInTimer.current) clearTimeout(fadeInTimer.current);
      if (visibleTimer.current) clearTimeout(visibleTimer.current);
      if (unpinTimer.current) clearTimeout(unpinTimer.current);
    };
    // We intentionally key on the (trackId, hasPlan) signature only — counters
    // changing shouldn't re-run the fade. armedFor.current guards that.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state?.trackId, state?.hasPlan]);

  // Resolve neighbor title for the "Borrowed visual DNA from {title}" line.
  useEffect(() => {
    let cancelled = false;
    if (!state?.borrowed || state.borrowedFromTrackId == null) {
      setBorrowedTitle(null);
      return;
    }
    const id = state.borrowedFromTrackId;
    void api.getTrack(id).then((t) => {
      if (cancelled) return;
      if (t) {
        const artist = (t as { artist?: string }).artist ?? '';
        const title = (t as { title?: string }).title ?? `Track ${id}`;
        setBorrowedTitle(artist ? `${title} — ${artist}` : title);
      } else {
        setBorrowedTitle(`Track ${id}`);
      }
    }).catch(() => {
      if (!cancelled) setBorrowedTitle(`Track ${id}`);
    });
    return () => {
      cancelled = true;
    };
  }, [state?.borrowed, state?.borrowedFromTrackId]);

  if (!enabled || !state || !state.hasPlan) return null;
  if (phase === 'hidden') return null;

  const pinned = phase === 'pinned';
  const cls = `eviland-memory-badge eviland-memory-badge--${phase}`;
  const summary = `REMEMBERS THIS SONG · gen ${state.generation} — ${state.plays} ${state.plays === 1 ? 'play' : 'plays'} · ${state.sectionsKnown} sections known`;

  function togglePin(): void {
    setShowPopover((open) => !open);
    setPhase((current) => {
      if (current !== 'pinned') return 'pinned';
      // Unpinning after the natural fade-in/visible/fade-out/hidden cycle
      // has already run its course (it's keyed on the (trackId, hasPlan)
      // signature via armedFor, so it won't reschedule once fired — routine
      // by the time a user pins then unpins, which is normally >10s after
      // the plan loaded) would otherwise leave 'fade-out' as a dead end:
      // nothing else advances it, so the badge stays mounted (and
      // clickable) forever. Mirror the original chain's own final step.
      if (unpinTimer.current) clearTimeout(unpinTimer.current);
      unpinTimer.current = setTimeout(() => {
        unpinTimer.current = null;
        setPhase((p) => (p === 'pinned' ? p : 'hidden'));
      }, 800);
      return 'fade-out';
    });
  }

  async function resetMemory(): Promise<void> {
    const bridge = getActiveBridge();
    const tid = bridge?.getState().trackId ?? state?.trackId ?? null;
    if (tid == null) return;
    // Order matters (finding #1 / #2 from the pre-release review):
    //   1. bridge.discard() FIRST — drop the in-memory plan + counters +
    //      buffered sections + dirty flag and short-circuit every future
    //      flush() / observeSection() / record* call for this bridge's
    //      lifetime. Without this, any subsequent flush from the rAF loop
    //      (or a visibilitychange) would compose a fresh plan from the
    //      still-live in-memory state and write it BACK to the DB, instantly
    //      resurrecting the row the user just asked to purge.
    //   2. dropBridgeForTrack() drops the bridge from the registry's keyed
    //      cache so the NEXT Visualizer mount for this track gets a fresh,
    //      empty bridge (not the discarded one).
    //   3. api.clearTrackVisualMemory() actually DELETEs the row.
    // The badge state listener will fire from discard()'s notify() with
    // hasPlan=false, and the badge will re-render as "no plan" naturally.
    bridge?.discard();
    dropBridgeForTrack(tid);
    try {
      await api.clearTrackVisualMemory(tid);
    } catch {
      /* purge is best-effort; the discard already neutralised the bridge */
    }
    setShowPopover(false);
    setPhase('hidden');
  }

  return (
    <>
      <button
        type="button"
        className={cls}
        data-newamp-eviland-memory-badge={pinned ? 'pinned' : phase}
        onClick={togglePin}
        title={pinned ? 'Close memory popover' : 'Open memory details'}
      >
        {summary}
      </button>
      {pinned && showPopover && (
        <div className="eviland-memory-badge-popover" role="dialog" aria-label="Eviland memory">
          <div className="eviland-memory-badge-popover__row">
            <div className="eviland-memory-badge-popover__line">
              Generation {state.generation} · {state.plays} {state.plays === 1 ? 'play' : 'plays'} · {state.sectionsKnown} sections known
            </div>
            {state.borrowed && (
              <div className="eviland-memory-badge-popover__line">
                Borrowed visual DNA from {borrowedTitle ?? `Track ${state.borrowedFromTrackId}`}
              </div>
            )}
          </div>
          <button
            type="button"
            className="pxbtn"
            onClick={() => { void resetMemory(); }}
            data-newamp-eviland-memory-reset
          >
            Reset visual memory for this track
          </button>
        </div>
      )}
    </>
  );
}
