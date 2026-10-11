// Behaviour of the deck controls that is more than a click handler, kept out
// of the components so it can be exercised without a DOM.

import { isLetterKey } from '@shared/keyboard-shortcuts';
import { clampVolume } from '../../lib/wheel-volume';

/** The Jukebox selector is one row of twelve keys. */
export const JUKEBOX_KEY_COUNT = 12;

export interface JukeboxKey {
  /** What is printed on the cap, 1..12. */
  number: number;
  /** The queue entry this key plays. */
  queueIndex: number;
  enabled: boolean;
  lit: boolean;
}

export interface JukeboxSelection {
  keys: JukeboxKey[];
  /** Printed selection, e.g. "A–07". The letter is the page of twelve queue
   *  entries the keys currently cover (past Z it wraps), the number is the key. */
  label: string;
  /** False while nothing in the queue is playing; the readout is then a demo. */
  hasSelection: boolean;
}

/**
 * The keys cover the queue a page of twelve at a time, the page holding the
 * entry that is playing, so a short queue lights its own position and a long
 * one pages along as playback moves through it.
 */
export function jukeboxSelection(queueLength: number, queueIndex: number): JukeboxSelection {
  const length = Number.isFinite(queueLength) ? Math.max(0, Math.trunc(queueLength)) : 0;
  const hasSelection = Number.isInteger(queueIndex) && queueIndex >= 0 && queueIndex < length;
  const page = hasSelection ? Math.floor(queueIndex / JUKEBOX_KEY_COUNT) : 0;
  const litKey = hasSelection ? queueIndex % JUKEBOX_KEY_COUNT : -1;
  const keys = Array.from({ length: JUKEBOX_KEY_COUNT }, (_, i): JukeboxKey => {
    const index = page * JUKEBOX_KEY_COUNT + i;
    return { number: i + 1, queueIndex: index, enabled: index < length, lit: i === litKey };
  });
  const letter = String.fromCharCode(65 + (page % 26));
  return { keys, label: `${letter}–${String(Math.max(litKey, 0) + 1).padStart(2, '0')}`, hasSelection };
}

/** Which way a key turns the Retro TV channel knob: 1 is next, -1 previous. */
export function channelKeyStep(key: string): -1 | 0 | 1 {
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
    case 'PageUp':
    case 'Enter':
    case ' ':
      return 1;
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'PageDown':
      return -1;
    default:
      return 0;
  }
}

/** Pointer travel for one detent. */
export const CHANNEL_DRAG_STEP_PX = 36;
/** A press that stays inside this radius is a click, not a drag. Wide enough
 *  for the wobble of a trackpad tap. */
export const CHANNEL_CLICK_SLOP_PX = 8;

/**
 * One press-drag-release on the channel knob. Up and right turn it forward,
 * as on the volume knob, a detent per CHANNEL_DRAG_STEP_PX of travel. A
 * release without a drag is a click, which also turns it forward.
 */
export class ChannelGesture {
  private moved = false;
  private detents = 0;

  constructor(private readonly startX: number, private readonly startY: number) {}

  /**
   * The next detent to turn, -1, 0 or 1. Each one starts a track, so a fast
   * drag that crosses several between two pointer events turns one now and
   * the rest on the moves that follow instead of skipping tracks in a burst.
   */
  move(x: number, y: number): -1 | 0 | 1 {
    if (!this.moved && Math.hypot(x - this.startX, y - this.startY) <= CHANNEL_CLICK_SLOP_PX) return 0;
    this.moved = true;
    const total = Math.trunc((x - this.startX + (this.startY - y)) / CHANNEL_DRAG_STEP_PX);
    const step = Math.sign(total - this.detents) as -1 | 0 | 1;
    this.detents += step;
    return step;
  }

  get isClick(): boolean {
    return !this.moved;
  }
}

/** Pointer travel that is the whole 0..100% of volume. */
export const VOLUME_DRAG_RANGE_PX = 100;

/**
 * One press-drag-release on the volume knob. A vertical drag of
 * VOLUME_DRAG_RANGE_PX is 100%, so the whole 0..200% sweep is a long turn.
 * Horizontal travel counts the same way (right is louder), which makes a
 * rotary flick feel right. The gesture holds no listeners: the knob feeds it
 * pointer events from its own handlers, so nothing outlives the knob.
 */
export class VolumeKnobGesture {
  constructor(
    private readonly startX: number,
    private readonly startY: number,
    private readonly startVolume: number,
  ) {}

  /** The volume the pointer at (x, y) has turned the knob to. */
  volumeAt(x: number, y: number): number {
    return clampVolume(this.startVolume + (this.startY - y + (x - this.startX)) / VOLUME_DRAG_RANGE_PX);
  }
}

/** One notch of a mouse wheel, as Chromium reports it. */
const WHEEL_NOTCH_PX = 100;
/** A pause this long between two events ends a wheel gesture. */
const WHEEL_IDLE_MS = 300;

interface WheelLike {
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
}

/**
 * Turns wheel travel into channel steps: one per notch, scrolling up is next.
 * A trackpad or Magic Mouse flick is dozens of events with momentum behind
 * it, and every step starts a track, so a gesture steps once and the knob
 * waits for it to end. Events keep the gesture alive however small they are.
 */
export class ChannelWheel {
  private travel = 0;
  private lastEventAt = -Infinity;
  private stepped = false;

  next(event: WheelLike, now = performance.now()): -1 | 0 | 1 {
    let px = event.deltaY;
    if (!Number.isFinite(px) || px === 0) return 0;
    if (event.deltaMode === 1) px *= 16;
    else if (event.deltaMode === 2) px *= 800;
    if (now - this.lastEventAt > WHEEL_IDLE_MS) {
      this.travel = 0;
      this.stepped = false;
    }
    this.lastEventAt = now;
    if (this.stepped) return 0;
    if (Math.sign(px) !== Math.sign(this.travel)) this.travel = 0;
    this.travel += px;
    if (Math.abs(this.travel) < WHEEL_NOTCH_PX) return 0;
    const step = this.travel < 0 ? 1 : -1;
    this.travel = 0;
    this.stepped = true;
    return step;
  }
}

/**
 * Accessible name of the Retro TV screen button: what is on the tube. The
 * elapsed time is left out because a name that changes every second is read
 * again each time; the button's title carries what clicking it does.
 */
export function tvScreenLabel(track: { title: string; artist: string } | null): string {
  return track ? `${track.title}, ${track.artist}` : 'No signal';
}

interface ChordEventLike {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

/**
 * The snapshot chord: Ctrl+Shift+S, and on a Mac Cmd+Shift+S, which is what the
 * button's label shows there. Ctrl+Shift+S stays accepted on a Mac for anyone
 * who learned it first; Ctrl and Cmd together are neither.
 */
export function isSnapshotChord(event: ChordEventLike, platform?: string): boolean {
  if (event.repeat || !event.shiftKey || event.altKey) return false;
  if (!isLetterKey(event, 's')) return false;
  return platform === 'darwin' ? !!event.metaKey !== !!event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}
