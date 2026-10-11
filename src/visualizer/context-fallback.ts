// When a renderer's GPU context is taken away, the renderer asks the browser
// for it back and rebuilds on it (eviland.ts, options.onContextEvent). Most of
// the time that takes a moment. A host that would rather paint something else
// than leave a frozen frame up gives it a few seconds, then switches.

/** How long a lost context may take to come back before the host paints without it. */
export const CONTEXT_RESTORE_GRACE_MS = 3000;

export type ContextEvent = 'lost' | 'restored' | 'failed';

export interface ContextFallbackWatch {
  /** Hand this to the renderer as onContextEvent. */
  onEvent(event: ContextEvent): void;
  /** True once the fallback has been asked for. */
  readonly fellBack: boolean;
  dispose(): void;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Calls `onFallback` once: when the renderer reports it could not rebuild, or
 * when a lost context has not been restored within `graceMs`. A restore in
 * time cancels the wait, and a later loss starts a new one.
 */
export function watchContextFallback(
  onFallback: () => void,
  graceMs = CONTEXT_RESTORE_GRACE_MS,
  timers: Timers = realTimers,
): ContextFallbackWatch {
  let waiting: unknown = null;
  let armed = false;
  let fellBack = false;
  let disposed = false;

  const stopWaiting = (): void => {
    if (armed) timers.clear(waiting);
    waiting = null;
    armed = false;
  };
  const fallBack = (): void => {
    stopWaiting();
    if (fellBack || disposed) return;
    fellBack = true;
    onFallback();
  };

  return {
    onEvent(event) {
      if (fellBack || disposed) return;
      if (event === 'lost') {
        if (!armed) {
          armed = true;
          waiting = timers.set(fallBack, graceMs);
        }
      } else if (event === 'restored') {
        stopWaiting();
      } else {
        fallBack();
      }
    },
    get fellBack() {
      return fellBack;
    },
    dispose() {
      disposed = true;
      stopWaiting();
    },
  };
}
