// The colour editor: one row per skin variable (swatch, picker, value, alpha),
// whole-skin hue / saturation / brightness, and live contrast readouts. The
// Skin Workshop page lays the rows out in a grid and the floating panel in a
// column; both edit the one draft in useSkinDraft, and every edit is on the
// page at once.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { COLOR_SKIN_VARIABLES, normalizeSkinVariableValue } from '@shared/custom-skin';
import {
  formatContrastRatio,
  isNeutralTint,
  parseSkinColor,
  pickedSkinColor,
  skinContrastReadings,
  skinVariableTakesAlpha,
} from '@shared/skin-color';
import { closeColourEditor } from '../lib/colour-editor-open';
import { editorFooterStatus, runSkinSave } from '../lib/skin-draft';
import { SKIN_VARIABLE_HINTS, SKIN_VARIABLE_SECTIONS } from '../lib/skin-hints';
import { readCurrentSkinVariables, resolveCssColor } from '../lib/skins';
import { useSkinDraft } from '../store/useSkinDraft';
import { ConfirmAction } from './ConfirmAction';
import { FloatingPanel } from './FloatingPanel';

const COLOUR_VARIABLES: readonly string[] = COLOR_SKIN_VARIABLES;

/** The colours the page is painting right now, read again after each preview lands. */
export function useEffectiveColours(): Record<string, string> {
  const previewRev = useSkinDraft((s) => s.previewRev);
  const savedRev = useSkinDraft((s) => s.savedRev);
  const active = useSkinDraft((s) => s.active);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readCurrentSkinVariables(), [previewRev, savedRev, active]);
}

const compactText = (value: string): string => value.toLowerCase().replace(/\s+/g, '');

/**
 * The label colour is derived from the accent unless it was picked, and kept
 * readable even when picked. When the page paints a different one than the
 * field holds, say which, so the field is not mistaken for what is on screen.
 */
export function onAccentNote(variable: string, value: string, effective: Record<string, string>): string | undefined {
  const shown = effective[variable];
  if (variable !== '--on-accent' || !value || !shown || compactText(shown) === compactText(value)) return undefined;
  return `On screen: ${shown}, so it reads on the accent`;
}

export function ColourRow({
  variable,
  value,
  compact = false,
  note,
  onChange,
}: {
  variable: string;
  value: string;
  compact?: boolean;
  /** A line under the label. */
  note?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const meta = SKIN_VARIABLE_HINTS[variable];
  const label = meta?.label ?? variable.replace('--', '');
  const isColour = COLOUR_VARIABLES.includes(variable);
  const accepted = value === '' || normalizeSkinVariableValue(variable, value) !== null;
  const color = isColour && accepted ? parseSkinColor(value, resolveCssColor) : null;
  const hasAlpha = !!color && skinVariableTakesAlpha(variable, value, resolveCssColor);
  return (
    <div className={`colour-row${compact ? ' is-compact' : ''}`} data-newamp-colour-row={variable}>
      <span className="colour-row-label" title={variable}>
        <span className="colour-row-name">{label}</span>
        {!compact && meta?.hint && <span className="colour-row-hint">{meta.hint}</span>}
        {note && <span className="colour-row-hint">{note}</span>}
      </span>
      {isColour ? (
        <span className="workshop-swatch" aria-hidden="true">
          <i style={{ background: accepted ? value : 'transparent' }} />
        </span>
      ) : (
        <span />
      )}
      <span className="colour-row-controls">
        {color && (
          <input
            aria-label={`${label} colour`}
            type="color"
            value={color.hex}
            onChange={(event) => onChange(pickedSkinColor(event.target.value, color.alpha))}
            className="colour-row-picker"
          />
        )}
        <input
          aria-label={`${label} value`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={accepted ? undefined : 'true'}
          spellCheck={false}
          title={
            accepted
              ? variable
              : `${variable}: not a value the skin accepts (${isColour ? 'hex, rgb(), hsl() or a colour name' : 'a length like 4px'})`
          }
          className="workshop-value bevel-in min-w-0 flex-1 px-2 py-1"
        />
        {hasAlpha && color && (
          <input
            aria-label={`${label} opacity`}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={color.alpha}
            title={`Opacity ${Math.round(color.alpha * 100)}%`}
            aria-valuetext={`${Math.round(color.alpha * 100)}%`}
            onChange={(event) => onChange(pickedSkinColor(color.hex, Number(event.target.value)))}
            className="colour-row-alpha"
          />
        )}
      </span>
    </div>
  );
}

function TintSlider({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (value: number) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="tint-slider">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={display}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id}>{display}</output>
    </div>
  );
}

/** Hue, saturation and brightness for every colour at once, from where they were when the drag began. */
export function TintControls(): JSX.Element {
  const tint = useSkinDraft((s) => s.tint);
  const setTint = useSkinDraft((s) => s.setTint);
  const resetTint = useSkinDraft((s) => s.resetTint);
  return (
    <section className="tint-controls" aria-label="Tint the whole skin" data-newamp-skin-tint>
      <div className="colour-editor-heading">
        <h3>Tint everything</h3>
        <button type="button" className="pxbtn" onClick={resetTint} disabled={isNeutralTint(tint)}>
          Reset tint
        </button>
      </div>
      <TintSlider
        label="Hue"
        min={-180}
        max={180}
        step={1}
        value={tint.hue}
        display={`${tint.hue > 0 ? '+' : ''}${Math.round(tint.hue)}°`}
        onChange={(hue) => setTint({ hue })}
      />
      <TintSlider
        label="Saturation"
        min={0}
        max={2}
        step={0.01}
        value={tint.sat}
        display={`${Math.round(tint.sat * 100)}%`}
        onChange={(sat) => setTint({ sat })}
      />
      <TintSlider
        label="Brightness"
        min={0.5}
        max={1.5}
        step={0.01}
        value={tint.light}
        display={`${Math.round(tint.light * 100)}%`}
        onChange={(light) => setTint({ light })}
      />
      <p className="colour-editor-note">Warning and error colours keep their hue. Text on the accent follows it.</p>
    </section>
  );
}

/** Contrast of the pairs the interface draws, measured on what the page is painting. */
export function ContrastReadout({ values }: { values: Record<string, string> }): JSX.Element {
  const readings = skinContrastReadings(values, resolveCssColor);
  return (
    <section className="contrast-readout" aria-label="Contrast" data-newamp-skin-contrast>
      <div className="colour-editor-heading">
        <h3>Contrast</h3>
      </div>
      <ul role="list">
        {readings.map(({ pair, ratio, pass }) => (
          <li key={pair.id} data-state={pass === null ? 'unknown' : pass ? 'ok' : 'low'}>
            <span className="contrast-label">{pair.label}</span>
            <span className="contrast-ratio">
              {ratio === null ? 'not measured' : `${formatContrastRatio(ratio)} ${pass ? 'ok' : 'low'}`}
            </span>
            {pass === false && <span className="contrast-need">needs {pair.min}:1</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ColourSections({ effective }: { effective: Record<string, string> }): JSX.Element {
  const draft = useSkinDraft((s) => s.draft);
  const setVar = useSkinDraft((s) => s.setVar);
  return (
    <>
      {SKIN_VARIABLE_SECTIONS.map((section) => (
        <section key={section.label} className="colour-editor-section" aria-label={section.label}>
          <div className="colour-editor-heading">
            <h3>{section.label}</h3>
          </div>
          {section.keys.map((key) => (
            <ColourRow
              key={key}
              variable={key}
              value={draft[key] ?? ''}
              compact
              note={onAccentNote(key, draft[key] ?? '', effective)}
              onChange={(value) => setVar(key, value)}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function ClosePrompt({
  onSave,
  onDiscard,
  onKeep,
  onBack,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onKeep: () => void;
  onBack: () => void;
}): JSX.Element {
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => saveRef.current?.focus(), []);
  return (
    <div className="colour-editor-prompt" role="alert" data-newamp-colour-editor-prompt>
      <span>You have colour edits that are not saved.</span>
      <div className="colour-editor-prompt-actions">
        <button ref={saveRef} type="button" className="pxbtn is-active" onClick={onSave}>Save skin</button>
        <button type="button" className="pxbtn" onClick={onDiscard}>Discard</button>
        <button type="button" className="pxbtn" onClick={onKeep} title="Close the editor and leave the colours on screen, unsaved">Keep preview</button>
        <button type="button" className="pxbtn" onClick={onBack}>Keep editing</button>
      </div>
    </div>
  );
}

/** The floating editor: open it over any view, including the fullscreen visualizer. */
export function ColourEditorPanel(): JSX.Element {
  const active = useSkinDraft((s) => s.active);
  const dirty = useSkinDraft((s) => s.dirty);
  const name = useSkinDraft((s) => s.name);
  const draft = useSkinDraft((s) => s.draft);
  const begin = useSkinDraft((s) => s.begin);
  const setName = useSkinDraft((s) => s.setName);
  const save = useSkinDraft((s) => s.save);
  const discard = useSkinDraft((s) => s.discard);
  const effective = useEffectiveColours();
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A session ends when the saved skin changes underneath it; the editor
  // picks the new one up.
  useEffect(() => {
    if (!active) begin();
  }, [active, begin]);

  // "Saved" is about the last save; a new edit makes it stale.
  useEffect(() => {
    if (dirty) setStatus(null);
  }, [dirty]);

  // A save that failed stays on screen until the next edit or a save that works.
  useEffect(() => {
    setSaveError(null);
  }, [draft, name]);

  async function saveSkin(): Promise<boolean> {
    const { skin, error } = await runSkinSave(save);
    setSaveError(error);
    setStatus(skin ? `Saved ${skin.name}.` : null);
    return !!skin;
  }

  function requestClose(): void {
    if (!dirty) {
      closeColourEditor();
    } else {
      setAsking((current) => !current);
    }
  }

  const footerStatus = editorFooterStatus({ dirty, error: saveError, saved: status });
  const footer: ReactNode = asking ? (
    <ClosePrompt
      onSave={() => void saveSkin().then((saved) => { if (saved) closeColourEditor(); else setAsking(false); })}
      onDiscard={() => { discard(); closeColourEditor(); }}
      onKeep={closeColourEditor}
      onBack={() => setAsking(false)}
    />
  ) : (
    <div className="colour-editor-actions">
      <span
        className="colour-editor-state"
        role={footerStatus.tone === 'error' ? 'alert' : 'status'}
        data-tone={footerStatus.tone}
        data-newamp-colour-editor-status
      >
        {footerStatus.text}
      </span>
      <ConfirmAction label="Discard" confirmLabel="Discard edits?" tone="warn" size="sm" disabled={!dirty} onConfirm={discard} />
      <button type="button" className="pxbtn is-active" onClick={() => void saveSkin()}>Save skin</button>
    </div>
  );

  return (
    <FloatingPanel id="colour-editor" title="Colour editor" width={400} onClose={requestClose} footer={footer}>
      <div className="colour-editor" data-newamp-colour-editor>
        <label className="colour-editor-name">
          <span>Skin name</span>
          <input
            aria-label="Skin name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            className="workshop-value bevel-in min-w-0 flex-1 px-2 py-1"
          />
        </label>
        <TintControls />
        <ColourSections effective={effective} />
        <ContrastReadout values={effective} />
      </div>
    </FloatingPanel>
  );
}
