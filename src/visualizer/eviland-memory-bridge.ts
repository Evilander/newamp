// Eviland visual-memory bridge — the renderer-only writer/loader that sits
// between the Director and the persistence layer.
//
// Responsibilities (and the reasons they live here, not in the Director):
//   - Load on track change. We hit window.newamp.getTrackVisualMemory; if the
//     track has no plan we try the DNA-neighbor borrow path (score ≥ 0.92 →
//     mint a derived rootSeed). NULL trackId is ALWAYS null — non-library
//     plays collide on songId 'eviland' and we never persist for them.
//   - Buffer fingerprints from director.onSectionLearn into a dirty counter.
//     The bridge does NOT write per frame — only on track-end/change, dirty ≥ 4,
//     or document.visibilitychange→hidden (debounced 2s).
//   - Lineage evolution. Counters live here (plays/loves/skips/sectionReturns)
//     and the 8/32/96/256 ladder ticks the generation. The Director stays pure
//     and free of Date.now / window access; ALL clock/IPC concerns live here.
//   - Subscribe surface for the badge. The on-screen badge needs to react to
//     plan-loaded / counters-updated events without polling per frame — so the
//     bridge exposes a tiny getState + subscribe pair driven by the same
//     internal mutations the persistence path uses.
//
// Design: dependencies (api + hash + now + cap-feature) are INJECTABLE so the
// pure unit test can mock window.newamp without spinning up Electron.

import {
  type VisualMemoryPlan,
  type VisualMemorySection,
  type VisualMemoryEvolutionEntry,
  createEmptyPlan,
  nextGenerationAt,
  prunePlan,
  validatePlan,
  VISUAL_MEMORY_ALGO_VERSION,
} from './eviland-memory-types';
import { hashSeed as defaultHashSeed } from './eviland-rng';
import type { Director } from './eviland-director';

// ---------------------------------------------------------------------------
// Constants. Tuned to match blueprint §1.6.
// ---------------------------------------------------------------------------

/**
 * Scene-overlay rotation seed for a track, lineage-aware when a plan exists.
 * Both windows must agree byte-for-byte (the on-screen Visualizer computes it
 * locally; the headless producer ships it to the projector in the frame
 * payload), so the derivation lives here next to the plan machinery rather
 * than being duplicated at each call site. Generation + rootSeed both feed
 * the key: every lineage evolution re-shuffles the scene walk, so a track's
 * visuals keep the "grows with your listening" promise at the scene layer too.
 */
export function sceneSeedForTrack(
  trackId: number | null,
  plan?: Pick<VisualMemoryPlan, 'lineage'> | null,
): string | null {
  if (trackId == null) return null;
  if (!plan) return `track-${trackId}`;
  return `track-${trackId}::g${plan.lineage.generation}-r${plan.lineage.rootSeed}`;
}

/** Threshold above which DNA-neighbor borrow mints a derived plan. */
export const NEIGHBOR_BORROW_THRESHOLD = 0.92;

/** Number of buffered sections that triggers an auto-flush. */
export const LEARN_FLUSH_THRESHOLD = 4;

/** Debounce window on visibilitychange→hidden flushes. */
export const VISIBILITY_FLUSH_DEBOUNCE_MS = 2000;

// ---------------------------------------------------------------------------
// Injectable shape — the bridge's deps. Keeps the pure logic testable.
// ---------------------------------------------------------------------------

/** Subset of NewAmpAPI the bridge actually touches. */
export interface MemoryBridgeApi {
  getTrackVisualMemory(id: number): Promise<VisualMemoryPlan | null>;
  setTrackVisualMemory(id: number, plan: VisualMemoryPlan): Promise<boolean>;
  clearTrackVisualMemory(id: number): Promise<boolean>;
  /** May return [] if DNA isn't analyzed yet — we treat that as "no neighbor". */
  findSimilarTracks(trackId: number, limit?: number): Promise<Array<{ track: { id: number }; score: number }>>;
}

export interface MemoryBridgeDeps {
  api: MemoryBridgeApi;
  /** FNV-1a string→uint32 — same hash the Director's seedFor uses. */
  hashSeed?: (key: string) => number;
  /** Wall-clock source; injectable so tests pin time. Defaults to Date.now. */
  now?: () => number;
}

export interface MemoryBridgeOptions extends MemoryBridgeDeps {
  /** Library trackId; null = non-library play (bridge is a no-op). */
  trackId: number | null;
}

// ---------------------------------------------------------------------------
// Subscribe surface — for the badge. Pushed on plan load + counter mutations.
// ---------------------------------------------------------------------------

export interface MemoryBridgeState {
  /** True when a plan has been loaded for this track (own OR neighbor-borrowed). */
  hasPlan: boolean;
  /** True when the loaded plan came from a DNA neighbor borrow. */
  borrowed: boolean;
  /** Source track id when borrowed; null otherwise. */
  borrowedFromTrackId: number | null;
  /** Lineage generation (0 = first play / plain plan). */
  generation: number;
  /** Plays counter visible to the badge. */
  plays: number;
  /** How many unique sections this track has learned. */
  sectionsKnown: number;
  /** The bridge's bound trackId; null for non-library plays. */
  trackId: number | null;
}

export type FlushReason =
  | 'dirty-threshold'
  | 'visibility-hidden'
  | 'track-end'
  | 'track-change'
  | 'unmount'
  | 'manual';

export interface MemoryBridge {
  /**
   * Resolve the plan to load on track start.
   *
   *   - Non-library (trackId null): always returns null. The Director keeps its
   *     existing pre-memory behavior and we never write back.
   *   - Existing plan: returns it verbatim.
   *   - No plan but DNA-neighbor score ≥ 0.92: mints a derived plan whose
   *     rootSeed is hashSeed(`${neighbor.rootSeed}::borrow::${trackId}`). The
   *     derived seed MUST never equal the neighbor's rootSeed.
   *   - Otherwise: null (Director uses its fresh-song path).
   */
  loadOrSeed(): Promise<VisualMemoryPlan | null>;

  /** Bind a Director so flush() can pull the canonical sections map. */
  attachDirector(director: Director): void;

  /** Observe a director onSectionLearn event. Increments dirty + may auto-flush. */
  observeSection(section: VisualMemorySection): void;

  /** Increment the plays counter and tick lineage at ladder boundaries. */
  recordCompletedPlay(): void;

  /** Increment the loves counter; force a generation tick when < 3. */
  recordLove(): void;

  /** Increment the skips counter. No lineage effect. */
  recordSkip(): void;

  /** Increment the section-returns counter. No lineage effect on its own. */
  recordSectionReturn(): void;

  /**
   * Persist the current plan. Pulls sections from the attached Director
   * (authoritative source), folds in bridge-owned lineage + counters + neighbor
   * info, prunes, validates, and writes. NEVER call from a frame loop.
   */
  flush(reason: FlushReason): Promise<boolean>;

  /** Flush + tear down event listeners. Idempotent. */
  flushAndDispose(reason: FlushReason): Promise<boolean>;

  /**
   * Tear down WITHOUT flushing. Drops the in-memory plan + counters + buffered
   * sections + dirty flag, and short-circuits every subsequent flush() /
   * flushAndDispose() / observeSection() / record* call for the lifetime of
   * this bridge. Use this when the caller has just deleted the row out from
   * under us (badge "Reset visual memory for this track") so a trailing flush
   * doesn't immediately resurrect the row from still-resident in-memory state.
   * Idempotent.
   */
  discard(): void;

  /**
   * Snapshot of the bridge's current in-memory plan, or null if no plan is
   * loaded. Used by the Visualizer's same-track remount path (finding #6) to
   * re-prime a freshly-constructed Director with the cached bridge's plan
   * WITHOUT a fresh IPC round-trip. Read-only — callers must not mutate.
   */
  getCurrentPlan(): VisualMemoryPlan | null;

  /** Live state snapshot for the badge. */
  getState(): MemoryBridgeState;

  /** Subscribe to state changes. Returns an unsubscribe fn. */
  subscribe(listener: (state: MemoryBridgeState) => void): () => void;
}

// ---------------------------------------------------------------------------
// Implementation.
// ---------------------------------------------------------------------------

/**
 * Build a memory bridge bound to a single trackId. The caller (Visualizer or
 * producer) is responsible for lifecycle — create per track, flushAndDispose
 * before swapping.
 */
export function createMemoryBridge(opts: MemoryBridgeOptions): MemoryBridge {
  const { api, trackId } = opts;
  const hashSeed = opts.hashSeed ?? defaultHashSeed;
  const now = opts.now ?? (() => Date.now());

  // Bridge-owned state. Counters live here, not in the Director. Lineage is
  // mutated only by recordCompletedPlay/recordLove. The Director's exportPlan
  // gives us its lineage at flush time, but the bridge's own lineage is the
  // source of truth for evolution events that happen mid-track.
  let plan: VisualMemoryPlan | null = null;
  let director: Director | null = null;
  let disposed = false;
  // discarded: hard kill-switch set by discard(). Distinct from disposed
  // because flushAndDispose() sets disposed=true BEFORE calling flush() to
  // make the dispose path idempotent — if `flush()` checked `disposed` it
  // would early-return and the dispose path could never persist its
  // buffered work. discarded means "drop everything, future writes are
  // forbidden for this bridge's lifetime" and IS checked by flush().
  let discarded = false;
  let dirty = 0;
  // Bumped on every section observation and every counter/lineage mutation.
  // A flush snapshots this at write-start; if it's moved on by the time the
  // write resolves, something landed mid-flight that the snapshot didn't
  // capture, and performFlush loops for a trailing round rather than letting
  // the stale snapshot clobber the live plan (the lost-update bug this guards).
  let mutationVersion = 0;
  /** Sections buffered since the last flush. We dedupe by sectionId so a chorus return doesn't double-flush. */
  const bufferedSections = new Map<number, VisualMemorySection>();
  let visibilityTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityHandler: (() => void) | null = null;

  const listeners = new Set<(state: MemoryBridgeState) => void>();

  const state: MemoryBridgeState = {
    hasPlan: false,
    borrowed: false,
    borrowedFromTrackId: null,
    generation: 0,
    plays: 0,
    sectionsKnown: 0,
    trackId,
  };

  function notify(): void {
    for (const fn of listeners) {
      try { fn({ ...state }); } catch { /* listener error must not break bridge */ }
    }
  }

  function refreshStateFromPlan(): void {
    if (!plan) {
      state.hasPlan = false;
      state.borrowed = false;
      state.borrowedFromTrackId = null;
      state.generation = 0;
      state.plays = 0;
      state.sectionsKnown = 0;
      return;
    }
    state.hasPlan = true;
    state.borrowed = plan.neighborSeed != null;
    state.borrowedFromTrackId = plan.neighborSeed?.fromTrackId ?? null;
    state.generation = plan.lineage.generation;
    state.plays = plan.counters.plays;
    // sectionsKnown is the merged view: known-from-plan ∪ buffered-this-session.
    const ids = new Set<number>();
    for (const s of plan.sections) ids.add(s.sectionId);
    for (const id of bufferedSections.keys()) ids.add(id);
    state.sectionsKnown = ids.size;
  }

  async function loadOrSeed(): Promise<VisualMemoryPlan | null> {
    if (trackId == null) return null;
    try {
      const existing = await api.getTrackVisualMemory(trackId);
      if (existing && validatePlan(existing)) {
        plan = existing;
        refreshStateFromPlan();
        notify();
        return existing;
      }
    } catch {
      // IPC failure — fall through to neighbor path; never throw upward.
    }

    // No existing plan — try the DNA-neighbor borrow path.
    try {
      const similar = await api.findSimilarTracks(trackId, 1);
      const top = similar?.[0];
      const neighborId = top?.track?.id;
      const score = top?.score ?? 0;
      if (top && typeof neighborId === 'number' && score >= NEIGHBOR_BORROW_THRESHOLD && neighborId !== trackId) {
        const neighbor = await api.getTrackVisualMemory(neighborId);
        if (neighbor && validatePlan(neighbor)) {
          const songId = `track-${trackId}`;
          const neighborRoot = neighbor.lineage.rootSeed >>> 0;
          // Derive a NEW rootSeed deterministically from the neighbor's root +
          // our trackId. Assert below that it never equals the neighbor's
          // root (FNV-1a over a non-empty distinguishing suffix is collision-
          // resistant for the 32-bit space, but we guard explicitly).
          let derived = hashSeed(`${neighborRoot}::borrow::${trackId}`) >>> 0;
          if (derived === neighborRoot) {
            // Vanishingly unlikely, but guarantee non-equality with a salt.
            derived = hashSeed(`${neighborRoot}::borrow::${trackId}::salt`) >>> 0;
          }
          const minted = createEmptyPlan(trackId, songId, derived);
          minted.neighborSeed = { fromTrackId: neighborId, score, at: now() };
          plan = minted;
          refreshStateFromPlan();
          notify();
          return minted;
        }
      }
    } catch {
      /* neighbor lookup is best-effort; null is a fine outcome */
    }

    plan = null;
    refreshStateFromPlan();
    notify();
    return null;
  }

  function attachDirector(d: Director): void {
    director = d;
  }

  function observeSection(section: VisualMemorySection): void {
    if (disposed) return;
    if (trackId == null) return; // non-library: never persist
    bufferedSections.set(section.sectionId, section);
    dirty++;
    mutationVersion++;
    refreshStateFromPlan();
    notify();
    if (dirty >= LEARN_FLUSH_THRESHOLD) {
      // Fire-and-forget — flush() handles its own concurrency.
      void flush('dirty-threshold');
    }
  }

  /**
   * Build (or fetch from Director) the canonical sections list to merge. The
   * Director's exportPlan is authoritative because it owns the sections map;
   * the bridge's bufferedSections is a hint that informs lastSeenAt timestamps
   * but never invents sections the Director didn't actually pick.
   */
  function composePlanForWrite(): VisualMemoryPlan {
    // Start with the Director's own exportPlan (sections + lineage at construction
    // time); then overwrite lineage + counters with the bridge's mutated values.
    const t = now();
    const exported = director
      ? director.exportPlan(t)
      : plan
        ? { ...plan, updatedAt: t }
        : createEmptyPlan(trackId ?? 0, `track-${trackId ?? 0}`, hashSeed(`track-${trackId ?? 0}`));

    // Stamp firstSeenAt/lastSeenAt on each section. The Director emits zeros
    // (it's clock-free by contract); the bridge supplies the wall clock here.
    const knownFirstSeen = new Map<number, number>();
    if (plan) {
      for (const s of plan.sections) knownFirstSeen.set(s.sectionId, s.firstSeenAt || t);
    }
    for (const s of exported.sections) {
      s.firstSeenAt = knownFirstSeen.get(s.sectionId) ?? t;
      s.lastSeenAt = t;
    }

    // Fold the bridge's lineage + counters in. The Director's lineage was loaded
    // from the SAME bridge-owned plan at construction; we trust the bridge for
    // mutations that happened mid-track (play counter, generation tick, love).
    if (plan) {
      exported.lineage = {
        rootSeed: plan.lineage.rootSeed >>> 0,
        ancestors: plan.lineage.ancestors.slice(),
        generation: plan.lineage.generation | 0,
        evolutionLog: plan.lineage.evolutionLog.slice(),
      };
      exported.counters = { ...plan.counters };
      if (plan.neighborSeed) exported.neighborSeed = { ...plan.neighborSeed };
    }
    exported.trackId = trackId ?? 0;
    exported.songId = `track-${trackId ?? 0}`;
    exported.algoVersion = VISUAL_MEMORY_ALGO_VERSION;
    exported.updatedAt = t;

    return prunePlan(exported);
  }

  let flushInFlight: Promise<boolean> | null = null;

  /**
   * The single owner of the async persistence cycle. Loops: snapshot
   * mutationVersion + the buffered-section identities this round covers,
   * compose + write, then — if anything mutated the live plan while the
   * write was in flight — loop again with a fresh snapshot. This is what
   * makes overlapping flush()/flushAndDispose() callers all eventually
   * observe a fully up-to-date persisted state instead of racing a stale one.
   */
  async function performFlush(): Promise<boolean> {
    let ok = false;
    for (;;) {
      if (discarded) return ok;

      const snapshotVersion = mutationVersion;
      const snapshotSections = new Map(bufferedSections);

      const composed = composePlanForWrite();
      if (!validatePlan(composed)) {
        // Director output failed our own validator — bail rather than write garbage.
        return ok;
      }

      let writeOk: boolean;
      try {
        writeOk = await api.setTrackVisualMemory(trackId as number, composed);
      } catch {
        writeOk = false;
      }

      if (discarded) {
        // discard() fired while this write was in flight. The caller asked us
        // to drop everything — don't resurrect `plan`, don't clear buffered
        // state, don't loop for a trailing round on its behalf.
        return ok;
      }

      if (writeOk) {
        ok = true;
        // Clear only the buffered entries THIS write actually covered — a
        // fresh observeSection() for the same sectionId during the await
        // replaced the map entry, so it's newer than what we just wrote and
        // must stay pending.
        for (const [sectionId, snapshotted] of snapshotSections) {
          if (bufferedSections.get(sectionId) === snapshotted) bufferedSections.delete(sectionId);
        }
        dirty = bufferedSections.size;
        // Only adopt the composed snapshot wholesale when nothing mutated the
        // live plan while we were writing. If it did (a love/skip/lineage
        // tick landed mid-flight), the live plan is already ahead of what we
        // just persisted — keep it, and loop below to persist the newer state.
        if (mutationVersion === snapshotVersion) {
          plan = composed;
        }
        refreshStateFromPlan();
        notify();
      }

      if (mutationVersion === snapshotVersion) return ok;
      // Something mutated during the write (new section, love, skip, lineage
      // tick, or just a failed write worth retrying against fresher state) —
      // loop immediately for a trailing round.
    }
  }

  async function flush(reason: FlushReason): Promise<boolean> {
    void reason; // informational only — the loop coalesces regardless of why it was called.
    if (discarded) return false;
    if (trackId == null) return false;
    if (!director && !plan) return false;
    if (dirty === 0 && bufferedSections.size === 0 && !plan) return false;

    if (!flushInFlight) {
      flushInFlight = performFlush().finally(() => {
        flushInFlight = null;
      });
    }
    return flushInFlight;
  }

  function appendEvolution(entry: VisualMemoryEvolutionEntry): void {
    if (!plan) return;
    plan.lineage.evolutionLog.push(entry);
    // Old rootSeed goes into ancestors (elitism — mu+lambda). prunePlan trims
    // the cap; we just push.
    plan.lineage.ancestors.push(entry.fromSeed >>> 0);
    plan.lineage.rootSeed = entry.toSeed >>> 0;
    plan.lineage.generation++;
  }

  function tickGeneration(trigger: 'play-count' | 'love'): void {
    if (!plan) return;
    const fromSeed = plan.lineage.rootSeed >>> 0;
    // Derive the next-generation seed deterministically from the current root
    // + the generation we're moving INTO. Two-stage so two consecutive ticks
    // never collide on the same hash key.
    const nextGen = plan.lineage.generation + 1;
    const toSeed = hashSeed(`${fromSeed}::g${nextGen}`) >>> 0;
    appendEvolution({ at: now(), trigger, fromSeed, toSeed });
  }

  function recordCompletedPlay(): void {
    if (disposed) return;
    if (!plan || trackId == null) return;
    plan.counters.plays++;
    mutationVersion++;
    // The ladder is [8, 32, 96, 256]. nextGenerationAt returns the threshold
    // we're about to cross (or null). We tick when `plays` HITS a threshold
    // (so plays=8 triggers gen 1, plays=32 triggers gen 2, etc).
    const nextThreshold = nextGenerationAt(plan.counters.plays - 1);
    if (nextThreshold != null && plan.counters.plays === nextThreshold) {
      tickGeneration('play-count');
    }
    refreshStateFromPlan();
    notify();
  }

  function recordLove(): void {
    if (disposed) return;
    if (!plan || trackId == null) return;
    plan.counters.loves++;
    mutationVersion++;
    // Love forces an immediate generation tick when generation < 3 — the
    // blueprint §1.6.4 rule. Stabilised tracks (generation ≥ 3) don't snap.
    if (plan.lineage.generation < 3) {
      tickGeneration('love');
    }
    refreshStateFromPlan();
    notify();
  }

  function recordSkip(): void {
    if (disposed) return;
    if (!plan || trackId == null) return;
    plan.counters.skips++;
    mutationVersion++;
    refreshStateFromPlan();
    notify();
  }

  function recordSectionReturn(): void {
    if (disposed) return;
    if (!plan || trackId == null) return;
    plan.counters.sectionReturns++;
    mutationVersion++;
    refreshStateFromPlan();
    notify();
  }

  // Visibility-hidden flush. Wired only when in a browser context.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    visibilityHandler = (): void => {
      if (disposed) return;
      if (document.visibilityState !== 'hidden') return;
      if (visibilityTimer) clearTimeout(visibilityTimer);
      visibilityTimer = setTimeout(() => {
        visibilityTimer = null;
        if (dirty > 0) void flush('visibility-hidden');
      }, VISIBILITY_FLUSH_DEBOUNCE_MS);
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  async function flushAndDispose(reason: FlushReason): Promise<boolean> {
    if (disposed) return false;
    disposed = true;
    if (visibilityTimer) {
      clearTimeout(visibilityTimer);
      visibilityTimer = null;
    }
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
    listeners.clear();
    if (trackId == null) return false;
    // Delegate to flush()'s own "anything to do" guard rather than duplicating
    // it here — that guard also covers a plan-only mutation (e.g. a love
    // recorded with no buffered sections) which this dispose-time check used
    // to miss, silently dropping it. flush() also transparently waits out any
    // trailing round if something mutated during an already-in-flight write.
    return flush(reason);
  }

  /**
   * Drop everything in memory and short-circuit future writes. Used by the
   * badge's Reset path so a trailing flush can't resurrect the row we just
   * asked the DB to delete.
   *
   * Implementation: we mark the bridge `disposed` (which makes flush(),
   * observeSection(), and the record* methods all early-return), null the
   * plan, drop counters + buffered sections + dirty, drop the in-flight flush
   * promise (further writes are blocked by the disposed gate anyway), tear
   * down listeners + visibility timer + handler, and refresh state → notify
   * subscribers once with hasPlan=false so the badge re-renders as "no plan".
   */
  function discard(): void {
    if (disposed) return;
    disposed = true;
    discarded = true;
    plan = null;
    dirty = 0;
    bufferedSections.clear();
    flushInFlight = null;
    if (visibilityTimer) {
      clearTimeout(visibilityTimer);
      visibilityTimer = null;
    }
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
    refreshStateFromPlan();
    notify();
    listeners.clear();
  }

  return {
    loadOrSeed,
    attachDirector,
    observeSection,
    recordCompletedPlay,
    recordLove,
    recordSkip,
    recordSectionReturn,
    flush,
    flushAndDispose,
    discard,
    getCurrentPlan() {
      return plan;
    },
    getState() {
      return { ...state };
    },
    subscribe(listener) {
      listeners.add(listener);
      // Push current state immediately so the badge can render on subscribe.
      try { listener({ ...state }); } catch { /* swallow */ }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
