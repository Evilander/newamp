// 0-100 decimal rating with one decimal of precision (e.g. 88.3).
//
// Interactions:
//   - Type an exact score in the number field
//   - Click on the bar = set score to that position
//   - Drag = scrub
//   - Mouse wheel = +/-0.1 a notch; a trackpad swipe moves by distance
//   - Shift+wheel = +/-1.0
//   - Arrow keys = +/-0.1 / +/-1.0 with Shift / +/-10 with Alt
//   - Right-click = clear (also Clear button)
//
// The integer star rating stays in sync (round(score / 20)) so existing
// 5-star UI, keyboard shortcuts (0-5), and smart-rule filters keep working.

import { useEffect, useRef, useState } from 'react';
import { GESTURE_BUDGET_NOTCHES, GESTURE_BUDGET_PER_S, GESTURE_GAP_MS } from '../lib/wheel-seek';

export const SCORE_MAX = 100;
export const SCORE_STEP_FINE = 0.1;
export const SCORE_STEP_COARSE = 1;
export const SCORE_STEP_LEAP = 10;

function clampScore(value: number): number {
  return Math.max(0, Math.min(SCORE_MAX, Math.round(value * 10) / 10));
}

/** One click of a notched mouse wheel, as Chromium reports it. */
const WHEEL_NOTCH_PX = 100;
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;
/** The smallest single event read as a notch of its own. */
const WHEEL_MIN_NOTCH_PX = 30;

export interface WheelScoreEvent {
  deltaX?: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode?: number;
  shiftKey?: boolean;
  /** Set on the wheel events a trackpad pinch generates. */
  ctrlKey?: boolean;
}

export interface WheelScoreResult {
  /** The event belongs to the bar, so the page behind it should not scroll. */
  consumed: boolean;
  /** Score change for this event; 0 while a trackpad's travel is still adding up to a notch. */
  delta: number;
}

const IGNORED: WheelScoreResult = { consumed: false, delta: 0 };

/**
 * Turns the wheel events over the bar into score changes. A notched mouse
 * reports about 100 px per click and a trackpad reports a swipe, momentum
 * included, as dozens of small events, so distance is what counts: a click is
 * one step (a tenth, or a point with Shift) and a swipe adds up to the same
 * steps, with a cap per gesture so momentum cannot carry the score far.
 * A pinch arrives as ctrl+wheel and is left to the page. macOS turns
 * Shift+wheel into a sideways scroll, so with Shift held the vertical intent
 * is read from whichever axis moved most. A plain sideways swipe moves
 * nothing and still scrolls the page.
 */
export class WheelScoreInput {
  private lastAt = -Infinity;
  private gestureStart = 0;
  private spent = 0;
  private carried = 0;

  /** `now` is the event's own timestamp in ms. */
  next(event: WheelScoreEvent, now: number): WheelScoreResult {
    if (event.ctrlKey) return IGNORED;
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    const dy = event.deltaY * scale;
    const dx = (event.deltaX ?? 0) * scale;
    if (!Number.isFinite(dy) || !Number.isFinite(dx)) return IGNORED;
    const shift = !!event.shiftKey;
    const travel = shift ? (Math.abs(dx) > Math.abs(dy) ? dx : dy) : Math.abs(dx) > Math.abs(dy) ? 0 : dy;
    if (travel === 0) return IGNORED;

    const fresh = now - this.lastAt > GESTURE_GAP_MS;
    if (fresh) {
      this.gestureStart = now;
      this.spent = 0;
      this.carried = 0;
    }
    this.lastAt = now;
    if (this.carried !== 0 && Math.sign(this.carried) !== Math.sign(travel)) this.carried = 0;
    this.carried += travel;

    let notches = Math.trunc(this.carried / WHEEL_NOTCH_PX);
    if (notches === 0 && (fresh || Math.abs(travel) >= WHEEL_MIN_NOTCH_PX)) {
      // A slow click can report a few pixels, so the first event of a gesture
      // still moves one step. So does any event as big as a mouse notch
      // anywhere: Chromium reports about 53 px a click on Linux and 33 px on
      // Windows set to scroll one line, where a trackpad sends a few pixels.
      notches = Math.sign(travel);
      this.carried = 0;
    } else {
      this.carried -= notches * WHEEL_NOTCH_PX;
    }
    if (notches === 0) return { consumed: true, delta: 0 };

    const allowed = GESTURE_BUDGET_NOTCHES + (GESTURE_BUDGET_PER_S * (now - this.gestureStart)) / 1000;
    const room = Math.max(0, Math.floor(allowed - this.spent));
    if (Math.abs(notches) > room) notches = Math.sign(notches) * room;
    if (notches === 0) return { consumed: true, delta: 0 };
    this.spent += Math.abs(notches);

    // Scrolling up (negative travel) raises the score.
    return { consumed: true, delta: -notches * (shift ? SCORE_STEP_COARSE : SCORE_STEP_FINE) };
  }
}

function formatScore(value: number | null): string {
  if (value == null) return '\u2014';
  return value.toFixed(1);
}

/** `color` paints the bar; `text` is the same tone for the number and the label, which sit on a panel. */
export function scoreTier(value: number | null): { label: string; color: string; text: string } {
  if (value == null) return { label: 'unrated', color: 'var(--muted)', text: 'var(--muted)' };
  if (value >= 95) return { label: 'desert island', color: 'var(--accent)', text: 'var(--accent-text)' };
  if (value >= 85) return { label: 'top tier', color: 'var(--accent)', text: 'var(--accent-text)' };
  if (value >= 70) return { label: 'great', color: 'var(--accent-dim)', text: 'color-mix(in srgb, var(--accent-text) 75%, var(--ink))' };
  if (value >= 50) return { label: 'solid', color: 'var(--ink-2)', text: 'var(--ink-2)' };
  if (value >= 30) return { label: 'okay', color: 'var(--warn)', text: 'var(--warn-text)' };
  return { label: 'skip', color: 'var(--error)', text: 'var(--error-text)' };
}

/** What a screen reader says for the score: the number out of 100 and the tier. */
export function scoreValueText(value: number | null): string {
  if (value == null) return 'Unrated';
  return `${formatScore(value)} out of 100, ${scoreTier(value).label}`;
}

interface ScoreRatingProps {
  value: number | null;
  /** Legacy integer star rating (0..5), shown beneath for context. */
  stars?: number;
  onChange: (score: number | null) => void;
}

export function ScoreRating({ value, stars = 0, onChange }: ScoreRatingProps): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string>('');
  const [editingInput, setEditingInput] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const tier = scoreTier(value);
  const display = value ?? 0;
  const fillPct = (display / SCORE_MAX) * 100;

  // Keep the visible number field from fighting the user while they type.
  useEffect(() => {
    if (!editingInput) setDraft(value != null ? value.toFixed(1) : '');
  }, [value, editingInput]);

  // Wheel over the bar nudges the score. Bound by hand because React's onWheel
  // is passive: its preventDefault did nothing, so the list behind the bar
  // scrolled along with every nudge.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const wheel = new WheelScoreInput();
    const onWheel = (event: WheelEvent): void => {
      const { consumed, delta } = wheel.next(event, event.timeStamp);
      if (!consumed) return;
      event.preventDefault();
      if (delta === 0) return;
      const { value: current, onChange: commit } = latest.current;
      commit(clampScore((current ?? 0) + delta));
    };
    bar.addEventListener('wheel', onWheel, { passive: false });
    return () => bar.removeEventListener('wheel', onWheel);
  }, []);

  function commitFromPointer(clientX: number): void {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onChange(clampScore(ratio * SCORE_MAX));
  }

  function nudge(delta: number): void {
    const next = clampScore((value ?? 0) + delta);
    onChange(next);
  }

  function commitDraft(): void {
    const nextDraft = draft.trim();
    if (!nextDraft) {
      onChange(null);
      return;
    }
    const parsed = Number(nextDraft);
    if (Number.isFinite(parsed)) {
      const next = clampScore(parsed);
      onChange(next);
      setDraft(next.toFixed(1));
    } else {
      setDraft(value != null ? value.toFixed(1) : '');
    }
  }

  return (
    <div
      data-newamp-score-rating
      data-newamp-score={value ?? ''}
      className="score-rating"
      onContextMenu={(event) => {
        event.preventDefault();
        if (value != null) onChange(null);
      }}
    >
      <div
        className="score-rating-display"
        title="Type an exact score, or use the bar/wheel/arrow keys. Right-click to clear."
      >
        <input
          type="number"
          aria-label="Score out of 100"
          min={0}
          max={SCORE_MAX}
          step={SCORE_STEP_FINE}
          inputMode="decimal"
          value={draft}
          placeholder={formatScore(value)}
          onFocus={(event) => {
            setEditingInput(true);
            event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitDraft();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              setDraft(value != null ? value.toFixed(1) : '');
              event.currentTarget.blur();
            }
          }}
          onBlur={() => {
            commitDraft();
            setEditingInput(false);
          }}
          className="score-rating-input"
          data-newamp-score-rating-input
          style={{ color: tier.text }}
        />
        <span className="score-rating-divider">/ 100</span>
      </div>

      <div
        ref={barRef}
        className="score-rating-bar"
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={SCORE_MAX}
        aria-valuenow={value ?? 0}
        aria-valuetext={scoreValueText(value)}
        aria-label="Rating"
        onPointerDown={(event) => {
          // A Control-click on a Mac is a right-click: the context menu that
          // follows clears the score, so it must not set one first.
          if (event.button !== 0 || (event.ctrlKey && /mac/i.test(navigator.platform))) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setPointerActive(true);
          commitFromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (pointerActive) commitFromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setPointerActive(false);
        }}
        onPointerCancel={() => setPointerActive(false)}
        onKeyDown={(event) => {
          const step = event.altKey
            ? SCORE_STEP_LEAP
            : event.shiftKey
              ? SCORE_STEP_COARSE
              : SCORE_STEP_FINE;
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            nudge(step);
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            nudge(-step);
          } else if (event.key === 'Home') {
            event.preventDefault();
            onChange(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            onChange(SCORE_MAX);
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            onChange(null);
          }
        }}
      >
        <div
          className="score-rating-fill"
          style={{
            width: `${fillPct}%`,
            background: `linear-gradient(to right, var(--accent-dim), ${tier.color})`,
            boxShadow: value != null && value >= 85 ? '0 0 8px var(--accent-glow)' : undefined,
          }}
        />
        {[25, 50, 75].map((tick) => (
          <span key={tick} className="score-rating-tick" style={{ left: `${tick}%` }} />
        ))}
        <span
          className="score-rating-cursor"
          style={{ left: `${fillPct}%`, background: tier.color }}
          aria-hidden="true"
        />
      </div>

      <div className="score-rating-meta">
        <span className="score-rating-tier" style={{ color: tier.text }}>
          {tier.label}
        </span>
        <span className="score-rating-stars" role="img" aria-label={`${stars} of 5 stars`}>
          {'\u2605'.repeat(stars).padEnd(5, '\u2606')}
        </span>
        <button
          type="button"
          className="score-rating-clear"
          onClick={() => onChange(null)}
          disabled={value == null}
          title="Clear score"
        >
          CLR
        </button>
      </div>
    </div>
  );
}
