import { performance } from 'node:perf_hooks';

// Work that is too big for one turn of the main thread is written as a
// generator. Each `yield` sits where the work so far is a finished step: no
// statement left open (sql.js frees them all whenever it saves the database),
// nothing half built that another call could read. The sync runner is for
// callers with nothing else to do; the sliced runner hands the thread back
// whenever a slice has used up its budget, so a click, a rating or a scan
// progress message waits for one slice instead of the whole job.
export type Sliced<T> = Generator<void, T, void>;

export function runSync<T>(steps: Sliced<T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

// Jobs take their turns one per trip round the event loop. Left to
// themselves, three jobs each waiting on setImmediate would all run in the same
// trip, and a message arriving meanwhile would wait for the three slices
// together.
const waiting: Array<() => void> = [];
let pumping = false;

function pump(): void {
  const resume = waiting.shift();
  if (waiting.length) setImmediate(pump);
  else pumping = false;
  resume?.();
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    waiting.push(resolve);
    if (!pumping) {
      pumping = true;
      setImmediate(pump);
    }
  });
}

export interface SlicedOptions {
  // Slices are only as short as the steps inside them, so this is the time a
  // slice may keep running after a step ends, not a hard limit.
  budgetMs?: number;
  // Called after every turn given away. Throwing stops the job.
  check?: () => void;
}

export async function runSliced<T>(steps: Sliced<T>, options: SlicedOptions = {}): Promise<T> {
  const budgetMs = options.budgetMs ?? 8;
  try {
    // Even the first slice waits its turn: a view that asks for seven things at
    // once would otherwise run all seven first slices back to back.
    await nextTurn();
    options.check?.();
    let sliceStart = performance.now();
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      if (performance.now() - sliceStart >= budgetMs) {
        await nextTurn();
        options.check?.();
        sliceStart = performance.now();
      }
    }
  } finally {
    // A job that was stopped or threw leaves its generator suspended.
    steps.return(undefined as never);
  }
}
