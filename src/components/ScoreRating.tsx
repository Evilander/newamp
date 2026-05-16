// 0-100 decimal rating with one decimal of precision (e.g. 88.3).
//
// Interactions:
//   - Click on the bar = set score to that position
//   - Drag = scrub
//   - Mouse wheel = ±0.1
//   - Shift+wheel = ±1.0
//   - Arrow keys = ±0.1 / ±1.0 with Shift / ±10 with Alt
//   - Double-click = enter typed score
//   - Right-click = clear (also Clear button)
//
// The integer star rating stays in sync (round(score / 20)) so existing
// 5-star UI, keyboard shortcuts (0-5), and smart-rule filters keep working.

import { useEffect, useRef, useState } from 'react';

export const SCORE_MAX = 100;
export const SCORE_STEP_FINE = 0.1;
export const SCORE_STEP_COARSE = 1;
export const SCORE_STEP_LEAP = 10;

function clampScore(value: number): number {
  return Math.max(0, Math.min(SCORE_MAX, Math.round(value * 10) / 10));
}

function formatScore(value: number | null): string {
  if (value == null) return '—';
  return value.toFixed(1);
}

function scoreTier(value: number | null): { label: string; color: string } {
  if (value == null) return { label: 'unrated', color: 'var(--muted)' };
  if (value >= 95) return { label: 'desert island', color: 'var(--accent)' };
  if (value >= 85) return { label: 'top tier', color: 'var(--accent)' };
  if (value >= 70) return { label: 'great', color: 'var(--accent-dim)' };
  if (value >= 50) return { label: 'solid', color: 'var(--ink-2)' };
  if (value >= 30) return { label: 'okay', color: 'var(--warn)' };
  return { label: 'skip', color: 'var(--error)' };
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
  const [editing, setEditing] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const tier = scoreTier(value);
  const display = value ?? 0;
  const fillPct = (display / SCORE_MAX) * 100;

  // Sync the typed draft with the bound value when leaving edit mode.
  useEffect(() => {
    if (!editing) setDraft(value != null ? value.toFixed(1) : '');
  }, [value, editing]);

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
        onDoubleClick={() => {
          setEditing(true);
          setDraft(value != null ? value.toFixed(1) : '');
        }}
        title="Double-click to type a score · right-click to clear"
      >
        {editing ? (
          <input
            autoFocus
            inputMode="decimal"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const parsed = Number.parseFloat(draft);
                if (Number.isFinite(parsed)) onChange(clampScore(parsed));
                setEditing(false);
              } else if (event.key === 'Escape') {
                setEditing(false);
              }
            }}
            onBlur={() => {
              const parsed = Number.parseFloat(draft);
              if (Number.isFinite(parsed)) onChange(clampScore(parsed));
              setEditing(false);
            }}
            className="score-rating-input"
            style={{ color: tier.color }}
          />
        ) : (
          <span className="score-rating-value" style={{ color: tier.color }}>
            {formatScore(value)}
          </span>
        )}
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
        aria-label={`Rating ${formatScore(value)} of 100`}
        onPointerDown={(event) => {
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
        onWheel={(event) => {
          event.preventDefault();
          const delta = event.shiftKey ? SCORE_STEP_COARSE : SCORE_STEP_FINE;
          nudge(event.deltaY < 0 ? delta : -delta);
        }}
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
        <span className="score-rating-tier" style={{ color: tier.color }}>
          {tier.label}
        </span>
        <span className="score-rating-stars" aria-label={`${stars} of 5 stars`}>
          {'★★★★★'.slice(0, stars).padEnd(5, '☆')}
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
