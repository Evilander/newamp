import { useEffect, useState } from 'react';
import { readVjDwell, setVjDwell, watchVjDwell, VJ_DWELL_OPTIONS } from '../lib/vizVj';

export function VjDwellControl(): JSX.Element {
  const [seconds, setSeconds] = useState(readVjDwell);
  const [draft, setDraft] = useState(String(seconds));
  useEffect(() => watchVjDwell((value) => { setSeconds(value); setDraft(String(value)); }), []);
  return (
    <div className="flex flex-col gap-1 text-sm text-ink2">
      <label>
        <span className="sr-only">Auto-VJ duration</span>
        <select className="bevel-in px-2 py-1" aria-label="Auto-VJ duration" value={seconds}
          onChange={(event) => setVjDwell(Number(event.target.value))}>
          {VJ_DWELL_OPTIONS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
          {!VJ_DWELL_OPTIONS.some((option) => option.seconds === seconds) && <option value={seconds}>{seconds} seconds</option>}
        </select>
      </label>
      <span className="text-xs text-muted">Time between Auto-VJ changes. Eviland&apos;s song Director conducts its own looks.</span>
      <label>
        Seconds (5–3600; 0 = Auto)
        <input className="bevel-in px-2 py-1" style={{ width: 90, marginLeft: 8 }} type="number" min="0" max="3600" step="1"
          aria-label="Custom Auto-VJ duration in seconds" value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setVjDwell(Number(draft))}
          onKeyDown={(event) => { if (event.key === 'Enter') { setVjDwell(Number(draft)); event.currentTarget.blur(); } }} />
      </label>
    </div>
  );
}
