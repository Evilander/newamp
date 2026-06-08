---
status: complete
priority: p3
issue_id: "009"
tags: [code-review, typescript, detached-visualizer, performance]
dependencies: []
---

# Detached-window TypeScript/perf polish — FIXED during review

## Problem Statement
Polish items in `src/detached/main.tsx` (added this session) flagged by TS + performance
+ simplicity reviewers. Fixed inline since it's freshly-authored code.

## Findings & Resolution
- `detached/main.tsx` — removed the `(payload.frame as { energy?: number }).energy` cast that *weakened* the already-non-optional `EvilandFrame.energy`; now `lastEnergy = payload.frame.energy`. ✅
- `detached/main.tsx` — removed the weak `satisfies Partial<CSSStyleDeclaration>` (Object.assign already type-checks the target; the constraint validated little). ✅
- `detached/main.tsx` — `setStatus` now dedups (`if (text === lastStatusText) return`), eliminating the 1.67 Hz `textContent` write at steady state; removed the dead `isConnected` re-append guard (statusEl is appended once at module load). ✅

## Deferred (low value, left as-is)
- `as MessageEvent` on the `eviland:frame-port` handler + inline `window.detachedViz` structural type — could move to a `WindowEventMap` / the existing `vite-env.d.ts` global; left to avoid churn (casts work, typecheck clean).
- `lastRenderError` could debounce 2 ticks before showing (transient GL blips). Minor.

## Acceptance Criteria
- [x] `npm run typecheck` clean.
- [x] No type-weakening casts on `frame.energy`.

## Work Log
- 2026-06-07: Fixed inline during /review.
