// The library-wide analysis, wired to the real world: the library, the
// settings, playback, the power state and the machine's load.
//
// The queue itself (electron/analysis-queue.ts) knows none of that and is
// tested against stand-ins; this is the one place that hands it the real ones.

import { stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { AnalysisQueue, type AnalysisLoad } from './analysis-queue.js';
import type { LibraryStore } from './library.js';
import { onPlaybackHunger, playbackHungry } from './playback-io.js';
import { analyzeTrack } from './track-analyzer.js';
import { hasCachedWaveform, waveformCacheHasRoom } from './waveform-peaks.js';

export interface LibraryAnalysisOptions {
  library: () => LibraryStore | null;
  /** The Background analysis setting. */
  enabled: () => boolean;
  /** The Seek bar setting: with waveforms off, none are built along the way. */
  waveformsEnabled: () => boolean;
  onBattery: () => boolean;
}

// The loop checks the load about once per track. A window shorter than this
// is too small to say anything about, so the last reading stands.
const MIN_CPU_WINDOW_MS = 1000;
// Event-loop timers are sampled at this period; the histogram includes it.
const LAG_RESOLUTION_MS = 20;

export function createLibraryAnalysis(options: LibraryAnalysisOptions): AnalysisQueue {
  return new AnalysisQueue({
    store: () => {
      const library = options.library();
      return library && !library.isClosed() ? library : null;
    },
    analyze: analyzeTrack,
    isEnabled: options.enabled,
    playbackHungry,
    onPlaybackHunger,
    load: createLoadProbe(),
    onBattery: options.onBattery,
    peaksWanted: async (path) => {
      if (!options.waveformsEnabled() || !waveformCacheHasRoom()) return false;
      const info = await stat(path);
      return !(await hasCachedWaveform({ path, size: info.size, mtimeMs: info.mtimeMs }));
    },
  });
}

interface CpuTimes {
  at: number;
  idle: number;
  total: number;
}

function sampleCpu(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const { user, nice, sys, idle: idleTime, irq } = cpu.times;
    idle += idleTime;
    total += user + nice + sys + idleTime + irq;
  }
  return { at: Date.now(), idle, total };
}

/** Whole-machine CPU use since the last call, and how late this process's timers are running. */
export function createLoadProbe(): () => AnalysisLoad {
  const lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
  lag.enable();
  let previous = sampleCpu();
  let cpu = 0;
  return () => {
    const now = sampleCpu();
    if (now.at - previous.at >= MIN_CPU_WINDOW_MS && now.total > previous.total) {
      cpu = 1 - (now.idle - previous.idle) / (now.total - previous.total);
      previous = now;
    }
    const lagMs = Math.max(0, lag.percentile(99) / 1e6 - LAG_RESOLUTION_MS);
    lag.reset();
    return { cpu: Math.min(1, Math.max(0, cpu)), lagMs: Number.isFinite(lagMs) ? lagMs : 0 };
  };
}
