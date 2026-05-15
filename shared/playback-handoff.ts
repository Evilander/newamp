import type { PlaybackMode } from './types.js';

export interface HandoffIndexInput {
  queueLength: number;
  index: number;
  mode: PlaybackMode;
}

export interface HandoffDecisionInput extends HandoffIndexInput {
  playing: boolean;
  duration: number;
  currentTime: number;
  crossfadeMs: number;
  currentTrackId: number | null;
  lastHandoffKey: string | null;
}

export function nextHandoffIndex(input: HandoffIndexInput): number | null {
  const queueLength = Math.trunc(Number(input.queueLength) || 0);
  const index = Math.trunc(Number(input.index) || 0);
  if (queueLength <= 1 || index < 0 || input.mode === 'repeat-one' || input.mode === 'shuffle') return null;
  if (input.mode === 'repeat-all' && index >= queueLength - 1) return 0;
  if (index >= queueLength - 1) return null;
  return index + 1;
}

export function shouldStartTrackHandoff(input: HandoffDecisionInput): boolean {
  if (!input.playing || input.currentTrackId == null) return false;
  if (!Number.isFinite(input.duration) || input.duration <= 0) return false;
  if (!Number.isFinite(input.currentTime) || input.currentTime <= 0) return false;
  const crossfadeMs = Math.max(0, Math.round(input.crossfadeMs));
  if (crossfadeMs <= 0) return false;
  if (nextHandoffIndex(input) == null) return false;
  const key = handoffKey(input.currentTrackId, input.index);
  if (input.lastHandoffKey === key) return false;
  const windowSeconds = Math.max(0.25, Math.min(12, crossfadeMs / 1000));
  const remaining = input.duration - input.currentTime;
  return remaining > 0 && remaining <= windowSeconds;
}

export function shouldPrepareTrackHandoff(input: HandoffDecisionInput): boolean {
  if (!input.playing || input.currentTrackId == null) return false;
  if (!Number.isFinite(input.duration) || input.duration <= 0) return false;
  if (!Number.isFinite(input.currentTime) || input.currentTime <= 0) return false;
  if (Math.max(0, Math.round(input.crossfadeMs)) > 0) return false;
  if (nextHandoffIndex(input) == null) return false;
  const key = handoffKey(input.currentTrackId, input.index);
  if (input.lastHandoffKey === key) return false;
  const remaining = input.duration - input.currentTime;
  return remaining > 0 && remaining <= 10;
}

export function handoffKey(trackId: number, index: number): string {
  return `${trackId}:${index}`;
}
