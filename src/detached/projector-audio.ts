// The existing audio analysis crosses the frame port; the Projector never opens
// an audio device or resamples MilkDrop's reduced feed for the other painters.
import type { DetachedAnalysis } from '../visualizer/frame-bus';
import type { VisualizerAudio } from '../visualizer/canvas-renderer';

export function createProjectorAudio(now: () => number = () => performance.now()): VisualizerAudio & { update(analysis: DetachedAnalysis, playing: boolean): void } {
  let latest: DetachedAnalysis | null = null;
  let playing = false;
  let updatedAt = -Infinity;
  const fresh = (): boolean => now() - updatedAt <= 500;
  return {
    get frequencyBinCount() { return latest?.frequency.length ?? 1024; },
    get fftSize() { return latest?.fftSize ?? 2048; },
    getSampleRate: () => latest?.sampleRate ?? 44100,
    getState: () => ({ playing: playing && fresh() }),
    getFreqData(out) { out.fill(0); if (latest && fresh()) out.set(latest.frequency.subarray(0, out.length)); },
    getOnsetFreqData(out) { out.fill(0); if (latest && fresh()) out.set(latest.onsetFrequency.subarray(0, out.length)); },
    getTimeData(out) { out.fill(128); if (latest && fresh()) out.set(latest.waveform.subarray(0, out.length)); },
    update(analysis, active) { latest = analysis; playing = active; updatedAt = now(); },
  };
}
