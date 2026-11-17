import { useEffect, useState } from 'react';
import { ConfirmAction } from './ConfirmAction';
import { flashGuardEnabled, setFlashGuardEnabled, watchFlashGuard } from '../lib/vizPrefs';

/**
 * Visualizer flash protection (visualizer/flash-guard.ts). On by default;
 * turning it off takes the two-step confirm and states why it's there.
 */
export function FlashProtectionControl(): JSX.Element {
  const [enabled, setEnabled] = useState(flashGuardEnabled);
  useEffect(() => watchFlashGuard(setEnabled), []);
  return (
    <div className="flex flex-col items-end gap-2 text-sm text-ink2" data-newamp-flash-protection={enabled ? 'on' : 'off'}>
      <span>
        {enabled
          ? 'On — bright flashes in visualizers and their recordings are held to three a second; motion uses the usual frame-rate target.'
          : 'Off — visualizers can flash as fast as the music drives them.'}
      </span>
      {enabled ? (
        <>
          <span className="text-xs text-muted">Turning this off can expose viewers with photosensitive epilepsy to seizure-triggering flashes.</span>
          <ConfirmAction
            label="Turn off"
            confirmLabel="Turn off anyway?"
            tone="warn"
            size="sm"
            onConfirm={() => setFlashGuardEnabled(false)}
          />
        </>
      ) : (
        <button type="button" className="pxbtn is-active" onClick={() => setFlashGuardEnabled(true)}>
          Turn on
        </button>
      )}
    </div>
  );
}

