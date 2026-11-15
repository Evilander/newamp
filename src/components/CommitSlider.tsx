import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

// A slider that follows the thumb locally and hands its value on at most every
// COMMIT_SLIDER_INTERVAL_MS, plus once when the drag ends. Saving on every
// input event would write the settings file tens of times during one drag.
const COMMIT_SLIDER_INTERVAL_MS = 250;

export function CommitSlider({
  value,
  min,
  max,
  step,
  disabled,
  className,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  className?: string;
  label: string;
  onCommit: (next: number) => Promise<unknown> | void;
}): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null);
  const latest = useRef<number | null>(null);
  const timer = useRef(0);
  // Commits handed on and not yet settled.
  const saving = useRef(0);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  function flush(): void {
    window.clearTimeout(timer.current);
    timer.current = 0;
    const next = latest.current;
    latest.current = null;
    if (next === null) return;
    // The thumb keeps the committed value until the saved one arrives. Another
    // commit may be on its way by then, so the draft goes when the last one
    // settles, not the first.
    saving.current += 1;
    void Promise.resolve(commitRef.current(next)).finally(() => {
      saving.current -= 1;
      if (saving.current === 0 && latest.current === null) setDraft(null);
    });
  }

  // Leaving the view mid-drag still commits where the thumb stopped.
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    const next = latest.current;
    latest.current = null;
    if (next !== null) void commitRef.current(next);
  }, []);

  return (
    <input
      aria-label={label}
      type="range"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.valueAsNumber;
        latest.current = next;
        setDraft(next);
        if (!timer.current) timer.current = window.setTimeout(flush, COMMIT_SLIDER_INTERVAL_MS);
      }}
      onPointerUp={(_event: ReactPointerEvent<HTMLInputElement>) => flush()}
      onKeyUp={flush}
      onBlur={flush}
      className={className}
    />
  );
}
