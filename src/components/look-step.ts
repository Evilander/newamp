// What "next look" and "previous look" do in the fullscreen visualizer. No React
// and no store import, so scripts/look-step-test.mjs can run it directly.
import type { VisualizerPreset } from '@shared/types';

export interface LookStepHandlers {
  /** Step to the neighbouring mode. */
  cyclePreset(direction: -1 | 1): void;
  /** Ask for a fresh Eviland look. */
  skipEvilandLook(): void;
  /** Go back one Eviland look. */
  previousEvilandLook(): void;
}

export function isEvilandPreset(preset: VisualizerPreset | string): boolean {
  return preset === 'eviland' || preset === 'eviland-live';
}

/**
 * On the Eviland modes the next look is the Director's to pick, and stepping
 * would leave Eviland for another mode; everywhere else it is the next mode.
 */
export function stepLook(preset: VisualizerPreset | string, direction: -1 | 1, handlers: LookStepHandlers): void {
  if (!isEvilandPreset(preset)) handlers.cyclePreset(direction);
  else if (direction === 1) handlers.skipEvilandLook();
  else handlers.previousEvilandLook();
}
