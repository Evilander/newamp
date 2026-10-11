// Selecting several files in Explorer and pressing Enter starts one NewAmp
// process per file (or one open-file event per file on macOS). Each lands in
// the running app as its own event, and each used to replace the queue. This
// gathers events that arrive close together into a single batch, in arrival
// order, so the renderer gets the whole selection once.

export interface OpenFileBatcherOptions {
  /** A batch is delivered once no new event has arrived for this long. */
  quietMs: number;
  /** Upper bound on how long a batch can keep growing before it is delivered. */
  maxWaitMs: number;
  deliver: (paths: string[]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export interface OpenFileBatcher {
  push(paths: readonly string[]): void;
  /** Resolves once nothing is waiting to be delivered. */
  settled(): Promise<void>;
  dispose(): void;
}

export interface HandedOffFiles {
  paths: string[];
  /** When the renderer took them, in the same clock as `now` below. */
  at: number;
}

// A cold start gives the renderer the file from argv before the rest of an
// Explorer multi-select has arrived. The renderer is already playing that
// file, and the batch that follows replaces its queue, which would drop it. A
// batch that lands soon after the hand-off therefore carries those files with
// it, and stays merged for as long as the window lasts so a selection that
// arrives in two batches still ends up whole. `at` keeps its original time,
// so the window always counts from the hand-off.
export function mergeHandedOff(
  batch: readonly string[],
  handedOff: HandedOffFiles | null,
  now: number,
  windowMs: number,
): { files: string[]; handedOff: HandedOffFiles | null } {
  if (!handedOff || now - handedOff.at > windowMs) return { files: [...batch], handedOff: null };
  const files: string[] = [];
  const seen = new Set<string>();
  for (const path of [...handedOff.paths, ...batch]) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(path);
  }
  return { files, handedOff: { paths: files, at: handedOff.at } };
}

export function createOpenFileBatcher(options: OpenFileBatcherOptions): OpenFileBatcher {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;

  let batch: string[] = [];
  let seen = new Set<string>();
  let firstAt = 0;
  let timer: unknown = null;
  let waiters: Array<() => void> = [];

  const flush = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const ready = batch;
    batch = [];
    seen = new Set();
    try {
      if (ready.length) options.deliver(ready);
    } finally {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    }
  };

  return {
    push(paths) {
      let added = false;
      for (const path of paths) {
        const key = path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        batch.push(path);
        added = true;
      }
      if (!added) return;
      const current = now();
      if (timer === null) firstAt = current;
      else clearTimer(timer);
      const untilCap = Math.max(0, firstAt + options.maxWaitMs - current);
      timer = setTimer(flush, Math.min(options.quietMs, untilCap));
    },
    settled() {
      if (timer === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      batch = [];
      seen = new Set();
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    },
  };
}
