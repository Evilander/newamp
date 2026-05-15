import { usePlayerStore } from '../store/usePlayerStore';
import { EQ_BAND_FREQS } from '../audio/engine';
import { EQ_PRESETS, findEqPresetName } from '@shared/eq-presets';

export function EqPanel(): JSX.Element {
  const settings = usePlayerStore((s) => s.settings);
  const setEqBand = usePlayerStore((s) => s.setEqBand);
  const setEqPreset = usePlayerStore((s) => s.setEqPreset);
  const setEqEnabled = usePlayerStore((s) => s.setEqEnabled);

  if (!settings) return <div />;
  const values = settings.equalizer;
  const enabled = settings.eqEnabled;
  const presetName = findEqPresetName(values);

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
          {EQ_PRESETS.map((p) => (
            <button
              key={p.name}
              className={`pxbtn ${presetName === p.name ? 'is-active' : ''}`}
              onClick={() => void setEqPreset(p.values)}
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
