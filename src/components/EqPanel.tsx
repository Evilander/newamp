import { useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { EQ_BAND_FREQS } from '../audio/engine';

interface Preset {
  name: string;
  values: number[];
}

const PRESETS: Preset[] = [
  { name: 'Flat', values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Rock', values: [4, 3, -1, -2, -1, 1, 3, 4, 5, 5] },
  { name: 'Jazz', values: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { name: 'Classical', values: [4, 3, 2, 1, 0, 0, -1, -1, -2, -2] },
  { name: 'Electronic', values: [4, 3, 0, -2, -2, 0, 1, 2, 4, 5] },
  { name: 'Hip-Hop', values: [5, 4, 2, 1, -1, -1, 1, 2, 3, 3] },
  { name: 'Vocal', values: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: 'Bass+', values: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
  { name: 'Treble+', values: [0, 0, 0, 0, 0, 1, 3, 5, 6, 6] },
];

export function EqPanel(): JSX.Element {
  const settings = usePlayerStore((s) => s.settings);
  const setEqBand = usePlayerStore((s) => s.setEqBand);
  const setEqEnabled = usePlayerStore((s) => s.setEqEnabled);
  const [presetName, setPresetName] = useState<string>('Flat');

  if (!settings) return <div />;
  const values = settings.equalizer;
  const enabled = settings.eqEnabled;

  function applyPreset(p: Preset) {
    setPresetName(p.name);
    p.values.forEach((v, i) => void setEqBand(i, v));
  }

  return (
    <div
      className="bevel-out scanlines relative mx-2 flex flex-col gap-2 px-3 py-2"
      style={{ borderTop: '1px solid var(--line)' }}
    >
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
        <div className="flex items-center gap-2">
          <span>Graphic Equalizer</span>
          <button
            className={`pxbtn ${enabled ? 'is-active' : ''}`}
            onClick={() => void setEqEnabled(!enabled)}
          >
            {enabled ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className={`pxbtn ${presetName === p.name ? 'is-active' : ''}`}
              onClick={() => applyPreset(p)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="display flex items-end justify-between gap-2 px-3 py-2" style={{ height: 130 }}>
        {EQ_BAND_FREQS.map((freq, i) => (
          <div key={freq} className="flex flex-col items-center gap-1 text-[9px]" style={{ color: 'var(--ink-2)' }}>
            <div className="lcd-text text-[10px]">
              {values[i] > 0 ? `+${values[i]}` : values[i]}
            </div>
            <input
              type="range"
              min={-12}
              max={12}
              step={1}
              value={values[i]}
              onChange={(e) => void setEqBand(i, parseFloat(e.target.value))}
              className="nslider"
              style={{
                writingMode: 'vertical-lr' as React.CSSProperties['writingMode'],
                WebkitAppearance: 'slider-vertical',
                width: 16,
                height: 80,
              } as React.CSSProperties}
              {...({ orient: 'vertical' } as Record<string, string>)}
            />
            <div className="lcd-text">{freq < 1000 ? `${freq}` : `${freq / 1000}k`}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
